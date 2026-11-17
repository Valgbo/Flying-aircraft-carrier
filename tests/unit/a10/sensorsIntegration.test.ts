/**
 * The sensors inside the whole simulation step (integration: the real flight model, avionics,
 * targets and weapons run around them). The pilot's HOTAS presses go through the avionics'
 * command handling (step 1) as sensor requests the sensors act on in the same step (step 8);
 * the SPI the avionics keeps from the pod or a Maverick lock (ARCHITECTURE §12.5, PLAN §7 "SOI
 * and SPI": "that is how a target found in the pod is handed to a Maverick") must be valid and
 * stable while the aircraft flies and the target sits or drives.
 */
import { Vector3 } from 'three';
import { afterAll, describe, expect, it } from 'vitest';
import { spiToSteerpoint } from '../../../src/a10/core/avionics';
import { createSim, pushCommand, runSim } from '../../../src/a10/core/sim';
import { createVehicle } from '../../../src/a10/core/targets';
import type { Command, Sim, SimEvent } from '../../../src/a10/core/types';
import { createFlatTerrain } from '../../../src/a10/core/world';

const report: Array<[string, string]> = [];
afterAll(() => {
  console.log('\n| sensors in the whole simulation | value |\n|---|---|');
  for (const [k, v] of report) console.log(`| ${k} | ${v} |`);
});

function press(sim: Sim, ...commands: Command[]): void {
  for (const c of commands) pushCommand(sim, c);
}

const _d = new Vector3();
/** Distance from point p to the ray o + s·d (unit d, s ≥ 0), m. */
function rayMiss(o: Vector3, d: Vector3, p: Vector3): number {
  _d.subVectors(p, o);
  const s = Math.max(0, _d.dot(d));
  return _d.addScaledVector(d, -s).length();
}

/** A tank 8 km ahead of an aircraft at 1,500 m on a flat world; the steerpoint is on the tank. */
function attackSetup(): { sim: Sim; tankId: number } {
  const sim = createSim({
    terrain: createFlatTerrain(0),
    seed: 1,
    scenario: 'empty',
    loadoutId: 'tankHunter',
    start: { x: 0, z: 0, agl: 1500, heading: 0, speed: 150 },
  });
  const tank = createVehicle(sim, 'mbt', 0, -8000, Math.PI / 2, -1);
  sim.avionics.steerpoints = [{ id: 1, name: 'TGT', position: tank.position.clone() }];
  sim.avionics.activeSteerpoint = 0;
  spiToSteerpoint(sim); // the SPI moves to the new steerpoint now, not at the first fire control
  return { sim, tankId: tank.id };
}

function lockEvents(sim: Sim, sensor: 'TGP' | 'MAV'): boolean[] {
  return sim.events
    .filter(
      (e): e is Extract<SimEvent, { type: 'lock' }> => e.type === 'lock' && e.sensor === sensor,
    )
    .map((e) => e.on);
}

describe('pod and Maverick through the avionics (integration)', () => {
  it('pod: slave, point track, SPI from the pod; Maverick: slave to that SPI, lock, SPI from the lock', () => {
    const { sim, tankId } = attackSetup();
    const tank = sim.targets.vehicles.find((v) => v.id === tankId);
    if (!tank) throw new Error('no tank');
    const av = sim.avionics;
    const tgp = sim.sensors.tgp;

    // right MFCD to the TGP page as the SOI; China hat aft long slaves the pod to the SPI (STPT)
    press(
      sim,
      { type: 'mfdPage', display: 'R', page: 'TGP' },
      { type: 'soi', value: 'RMFD' },
      { type: 'chinaHat', dir: 'aft', long: true },
    );
    runSim(sim, 0.5);
    expect(av.soi).toBe('RMFD');
    expect(tgp.mode).toBe('INR');
    expect(rayMiss(tgp.head, tgp.los, tank.position)).toBeLessThan(0.5);

    // TMS forward short: point track on the tank; TMS forward long: the pod is the SPI
    press(sim, { type: 'tms', dir: 'up', long: false });
    runSim(sim, 0.1);
    expect(tgp.mode).toBe('POINT');
    expect(tgp.trackedVehicle).toBe(tank.id);
    press(sim, { type: 'tms', dir: 'up', long: true });
    runSim(sim, 0.1);
    expect(av.spi.source).toBe('TGP');

    // the SPI stays on the tank, valid and steady, for 5 s of flight
    let worst = 0;
    let jump = 0;
    const prev = av.spi.position.clone();
    runSim(sim, 5, (s) => {
      expect(s.avionics.spi.valid).toBe(true);
      worst = Math.max(worst, s.avionics.spi.position.distanceTo(tank.position));
      jump = Math.max(jump, s.avionics.spi.position.distanceTo(prev));
      prev.copy(s.avionics.spi.position);
    });
    expect(worst).toBeLessThan(0.01);
    expect(jump).toBeLessThan(0.01);
    report.push([
      'SPI from the pod in point track, 5 s',
      `within ${worst.toFixed(4)} m of the tank, largest step ${jump.toFixed(4)} m`,
    ]);

    // left MFCD to the MAV page; China hat forward long slaves all sensors to the SPI (the pod's
    // point: the pod keeps its track); the MAV page as SOI, DMS up = narrow, TMS forward = lock
    press(
      sim,
      { type: 'mfdPage', display: 'L', page: 'MAV' },
      { type: 'chinaHat', dir: 'fwd', long: true },
    );
    runSim(sim, 0.2);
    const mav = sim.sensors.mavericks[sim.sensors.selectedMaverick];
    expect(mav.mode).toBe('SLAVE');
    expect(tgp.mode).toBe('POINT');
    expect(rayMiss(mav.head, mav.los, tank.position)).toBeLessThan(0.5);
    press(
      sim,
      { type: 'soi', value: 'LMFD' },
      { type: 'dms', dir: 'up', long: false },
      { type: 'tms', dir: 'up', long: false },
    );
    runSim(sim, 0.2);
    expect(mav.fov).toBe('NARROW');
    expect(mav.locked).toBe(true);
    expect(mav.lockedVehicle).toBe(tank.id);
    expect(mav.inZone).toBe(true);
    press(sim, { type: 'tms', dir: 'up', long: true });
    runSim(sim, 0.1);
    expect(av.spi.source).toBe('MAV');
    expect(av.spi.position.distanceTo(tank.position)).toBeLessThan(0.01);
    // slaving all sensors to an SPI the Maverick makes leaves its lock alone
    press(sim, { type: 'chinaHat', dir: 'fwd', long: true });
    runSim(sim, 0.1);
    expect(mav.locked).toBe(true);
    expect(tgp.mode).toBe('INR'); // the pod is slaved to the Maverick's point
    expect(rayMiss(tgp.head, tgp.los, tank.position)).toBeLessThan(0.5);
    expect(lockEvents(sim, 'TGP')).toEqual([true, false]);
    expect(lockEvents(sim, 'MAV')).toEqual([true]);
    report.push([
      'Maverick lock handed over through the SPI',
      `${mav.type} on station ${mav.station}, ${(mav.range / 1852).toFixed(2)} nmi, contrast ${mav.contrast.toFixed(2)}`,
    ]);
  });

  it('the laser fires only with Laser Arm ARM and the pod tracking; the spot is on the tank', () => {
    const { sim, tankId } = attackSetup();
    const tgp = sim.sensors.tgp;
    press(
      sim,
      { type: 'mfdPage', display: 'R', page: 'TGP' },
      { type: 'soi', value: 'RMFD' },
      { type: 'chinaHat', dir: 'aft', long: true },
    );
    runSim(sim, 0.3);
    press(sim, { type: 'tms', dir: 'up', long: false });
    runSim(sim, 0.1);
    sim.input.laser = true;
    runSim(sim, 0.3);
    expect(tgp.lasing).toBe(false); // Laser Arm SAFE at the air start
    press(sim, { type: 'laserArm', value: 'ARM' });
    runSim(sim, 0.3);
    expect(tgp.lasing).toBe(true);
    expect(tgp.spotValid).toBe(true);
    expect(tgp.spotVehicle).toBe(tankId);
    expect(tgp.laserRange).toBeGreaterThan(7000);
    sim.input.laser = false;
    runSim(sim, 0.1);
    expect(tgp.lasing).toBe(false);
    const laser = sim.events.filter(
      (e): e is Extract<SimEvent, { type: 'laser' }> => e.type === 'laser',
    );
    expect(laser.map((e) => e.on)).toEqual([true, false]);
  });
});
