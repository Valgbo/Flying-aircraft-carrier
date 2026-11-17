/**
 * Avionics switches, modes and routing (PLAN_A10.md §7, §12; docs/a10/ARCHITECTURE.md §3–§4):
 * armament switches and their cycles, master modes and weapon profiles, the sensor of interest,
 * the displays and their buttons, HOTAS routing by SOI, steerpoints and the SPI, the commands
 * that go to the flight and weapons modules, and the events every change emits.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  GUN_SIGHTS,
  OSB_TABLE,
  PAGE_CYCLE,
  PAGE_SELECT_OSB,
  PROFILE_DEFAULTS,
  applyCommands,
  buildDsmsView,
  createAvionicsState,
  initAvionics,
  previousMasterMode,
  soiTarget,
  stepFireControl,
} from '../../../src/a10/core/avionics';
import { SIM_DT } from '../../../src/a10/core/constants';
import { quaternionFromAttitude } from '../../../src/a10/core/frames';
import { createSim, pushCommand } from '../../../src/a10/core/sim';
import type { Command, ScenarioKind, Sim, SimEvent } from '../../../src/a10/core/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import type { Terrain } from '../../../src/a10/core/world/types';

const DEG = Math.PI / 180;
const KT = 0.514444;
const FT = 0.3048;

function makeSim(
  loadoutId = 'tankHunter',
  opts: { scenario?: ScenarioKind; terrain?: Terrain } = {},
): Sim {
  return createSim({
    terrain: opts.terrain ?? createFlatTerrain(0),
    scenario: opts.scenario ?? 'empty',
    loadoutId,
    seed: 5,
  });
}

type SwitchEvent = Extract<SimEvent, { type: 'switch' }>;

/** Apply commands as one step's command phase; returns the switch events they emitted. */
function apply(sim: Sim, ...commands: Command[]): SwitchEvent[] {
  sim.events.length = 0;
  for (const c of commands) pushCommand(sim, c);
  applyCommands(sim);
  return sim.events.filter((e): e is SwitchEvent => e.type === 'switch');
}

function messages(sim: Sim): string[] {
  return sim.events.flatMap((e) => (e.type === 'message' ? [e.text] : []));
}

/** Hold the aircraft in a 30° dive at 300 kn about 650 m above the flat ground. */
function dive(sim: Sim): void {
  const ac = sim.aircraft;
  ac.position.set(0, 650, 0);
  ac.velocity.set(0, -Math.sin(30 * DEG), -Math.cos(30 * DEG)).multiplyScalar(300 * KT);
  quaternionFromAttitude(0, -28 * DEG, 0, ac.orientation);
  ac.angularVelocity.set(0, 0, 0);
  ac.agl = 650;
  sim.world.surfaceWind.set(0, 0, 0);
}

describe('start of the flight', () => {
  it('starts safe: Master Arm, GUN/PAC and laser SAFE, DELTA, NAV, HUD as SOI', () => {
    const av = createAvionicsState();
    expect(av.masterArm).toBe('SAFE');
    expect(av.gunPac).toBe('SAFE');
    expect(av.laserArm).toBe('SAFE');
    expect(av.tgpPower).toBe(true);
    expect(av.altSource).toBe('DELTA');
    expect(av.masterMode).toBe('NAV');
    expect(av.soi).toBe('HUD');
    expect(av.mfd).toEqual({ left: 'TAD', right: 'DSMS' });
    expect(av.sight).toBe('NONE');
    expect(av.gun.valid).toBe(false);
    expect(av.release.valid).toBe(false);
    expect(av.initialized).toBe(false);
  });

  it('builds steerpoints from the target areas, puts the SPI on the first and makes profiles', () => {
    const sim = makeSim();
    const av = sim.avionics;
    initAvionics(sim);
    const areas = sim.world.terrain.targetAreas;
    expect(av.steerpoints.map((s) => s.name)).toEqual(areas.map((a) => a.name));
    for (let i = 0; i < areas.length; i++) {
      const p = av.steerpoints[i].position;
      expect(p.x).toBe(areas[i].x);
      expect(p.z).toBe(areas[i].z);
      expect(p.y).toBe(sim.world.terrain.heightAt(p.x, p.z));
    }
    expect(av.activeSteerpoint).toBe(0);
    expect(av.spi.valid).toBe(true);
    expect(av.spi.source).toBe('STPT');
    expect(av.spi.position.equals(av.steerpoints[0].position)).toBe(true);
    // Tank hunter: one profile per weapon store type, none for pods, racks or the AIM-9.
    expect(av.profiles.map((p) => p.store).sort()).toEqual(
      ['AGM-65D', 'AGM-65H', 'GBU-12', 'LAU-131-M156', 'MK-82'].sort(),
    );
    for (const p of av.profiles) {
      const d = PROFILE_DEFAULTS[p.store];
      expect(p.name).toBe(d.name);
      expect(p.minAltitude).toBe(d.minAltitude);
      expect(p.armingTime).toBe(d.armingTime);
    }
    expect(av.profiles.find((p) => p.store === 'AGM-65D')?.mode).toBe('NONE');
    expect(av.profiles.find((p) => p.store === 'GBU-12')?.mode).toBe('CCRP');
    // The first weapon that has a CCIP delivery is selected.
    expect(av.profiles.find((p) => p.id === av.selectedProfile)?.store).toBe('LAU-131-M156');
    expect(av.initialized).toBe(true);
  });

  it('adds the airbase and starts a range scenario on its pad', () => {
    const flat = createFlatTerrain(120);
    const terrain: Terrain = {
      ...flat,
      targetAreas: [
        ...flat.targetAreas,
        { id: 3, name: 'STRAFE PIT', kind: 'range', x: 2000, z: -3000, radius: 260 },
      ],
      airbase: {
        x: -8000,
        z: 9000,
        heading: 0,
        runwayLength: 2400,
        runwayWidth: 45,
        elevation: 120,
      },
    };
    const sim = makeSim('gunOnly', { terrain, scenario: 'strafePit' });
    initAvionics(sim);
    const names = sim.avionics.steerpoints.map((s) => s.name);
    expect(names).toEqual(['ALPHA', 'BRAVO', 'CHARLIE', 'STRAFE PIT', 'AIRBASE']);
    expect(sim.avionics.steerpoints[sim.avionics.activeSteerpoint].name).toBe('STRAFE PIT');
    expect(sim.avionics.steerpoints[4].position.toArray()).toEqual([-8000, 120, 9000]);
  });

  it('keeps steerpoints and profiles set up before the first step', () => {
    const sim = makeSim();
    const av = sim.avionics;
    av.steerpoints.push({ id: 7, name: 'TGT1', position: new Vector3(10, 0, -20) });
    av.profiles.push({
      id: 'mk82-ccip',
      store: 'MK-82',
      mode: 'CCIP',
      release: 'SGL',
      rippleQty: 1,
      rippleSpacing: 0,
      fuze: 'NOSE',
      minAltitude: 300,
      armingTime: 4,
    });
    av.selectedProfile = 'mk82-ccip';
    apply(sim);
    expect(av.steerpoints.map((s) => s.name)).toEqual(['TGT1']);
    expect(av.profiles.filter((p) => p.store === 'MK-82').map((p) => p.id)).toEqual(['mk82-ccip']);
    expect(av.selectedProfile).toBe('mk82-ccip');
    expect(av.spi.position.toArray()).toEqual([10, 0, -20]);
  });
});

describe('armament switches', () => {
  it('Master Arm: explicit positions, the cycle, one switch event per change', () => {
    const sim = makeSim();
    const av = sim.avionics;
    let ev = apply(sim, { type: 'masterArm', value: 'ARM' });
    expect(av.masterArm).toBe('ARM');
    expect(ev).toEqual([{ type: 'switch', t: sim.time, name: 'masterArm', value: 'ARM' }]);
    expect(av.lastSwitch).toEqual({ name: 'masterArm', time: sim.time });
    expect(av.lastSwitchValue).toBe('ARM');
    // No change, no click.
    expect(apply(sim, { type: 'masterArm', value: 'ARM' })).toEqual([]);
    ev = apply(sim, { type: 'masterArm', value: 'SAFE' }, { type: 'masterArm', value: 'cycle' });
    expect(ev.map((e) => e.value)).toEqual(['SAFE', 'ARM']);
    apply(sim, { type: 'masterArm', value: 'cycle' });
    expect(av.masterArm).toBe('TRAIN');
    apply(sim, { type: 'masterArm', value: 'cycle' });
    expect(av.masterArm).toBe('SAFE');
  });

  it('GUN/PAC cycles SAFE → ARM (gun and PAC) → GUNARM → SAFE', () => {
    const sim = makeSim();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const ev = apply(sim, { type: 'gunPac', value: 'cycle' });
      expect(ev.length).toBe(1);
      expect(ev[0].name).toBe('gunPac');
      seen.push(sim.avionics.gunPac);
    }
    expect(seen).toEqual(['ARM', 'GUNARM', 'SAFE', 'ARM']);
    apply(sim, { type: 'gunPac', value: 'GUNARM' });
    expect(sim.avionics.gunPac).toBe('GUNARM');
  });

  it('laser arm, pod power and the altitude source', () => {
    const sim = makeSim();
    const av = sim.avionics;
    expect(apply(sim, { type: 'laserArm', value: 'ARM' })[0].value).toBe('ARM');
    apply(sim, { type: 'laserArm', value: 'cycle' });
    expect(av.laserArm).toBe('TRAIN');
    expect(apply(sim, { type: 'tgpPower', value: 'toggle' })[0]).toMatchObject({
      name: 'tgpPower',
      value: 'OFF',
    });
    expect(av.tgpPower).toBe(false);
    apply(sim, { type: 'tgpPower', value: true });
    expect(av.tgpPower).toBe(true);
    const sources: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ev = apply(sim, { type: 'altSource', value: 'cycle' });
      expect(ev[0].name).toBe('altSource');
      sources.push(av.altSource);
    }
    expect(sources).toEqual(['RADAR', 'BARO', 'DELTA']);
    apply(sim, { type: 'altSource', value: 'BARO' });
    expect(av.altSource).toBe('BARO');
  });
});

describe('master modes and weapon profiles', () => {
  function cycleModes(sim: Sim, n: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      apply(sim, { type: 'masterMode', value: 'next' });
      out.push(sim.avionics.masterMode);
    }
    return out;
  }

  it('gun only: NAV → GUNS → CCIP (the gun) → NAV; CCRP has no weapon', () => {
    const sim = makeSim('gunOnly');
    expect(cycleModes(sim, 4)).toEqual(['GUNS', 'CCIP', 'NAV', 'GUNS']);
    apply(sim, { type: 'masterMode', value: 'CCIP' });
    stepFireControl(sim, SIM_DT);
    expect(sim.avionics.sight).toBe('GUN');
    sim.events.length = 0;
    apply(sim, { type: 'masterMode', value: 'CCRP' });
    expect(sim.avionics.masterMode).toBe('CCIP');
    expect(messages(sim)).toEqual(['CCRP NOT AVAILABLE']);
  });

  it('tank hunter: NAV → GUNS → CCIP (rockets) → CCRP (laser bomb) → NAV', () => {
    const sim = makeSim();
    const av = sim.avionics;
    const modes: string[] = [];
    const weapons: string[] = [];
    for (let i = 0; i < 5; i++) {
      apply(sim, { type: 'masterMode', value: 'next' });
      stepFireControl(sim, SIM_DT);
      modes.push(av.masterMode);
      weapons.push(av.sight === 'GUN' || av.sight === 'NONE' ? av.sight : av.selectedProfile);
    }
    expect(modes).toEqual(['GUNS', 'CCIP', 'CCRP', 'NAV', 'GUNS']);
    expect(weapons).toEqual(['GUN', 'M156-131', 'GBU12', 'NONE', 'GUN']);
  });

  it('a selector turned back gets the previous AVAILABLE mode', () => {
    const sim = makeSim('gunOnly');
    apply(sim);
    // From NAV back: CCRP has no weapon, so CCIP.
    expect(previousMasterMode(sim)).toBe('CCIP');
    apply(sim, { type: 'masterMode', value: previousMasterMode(sim) });
    expect(sim.avionics.masterMode).toBe('CCIP');
    expect(previousMasterMode(sim)).toBe('GUNS');
  });

  it('CCRP needs a valid SPI, CCIP needs a CCIP weapon or rounds', () => {
    const flat = createFlatTerrain(0);
    const sim = makeSim('tankHunter', { terrain: { ...flat, targetAreas: [] } });
    apply(sim);
    expect(sim.avionics.spi.valid).toBe(false);
    expect(cycleModes(sim, 3)).toEqual(['GUNS', 'CCIP', 'NAV']);
    const empty = makeSim('gunOnly');
    empty.gun.rounds = 0;
    expect(cycleModes(empty, 3)).toEqual(['GUNS', 'NAV', 'GUNS']);
  });

  it('steps through the loaded profiles; in CCIP / CCRP the mode follows the delivery', () => {
    const sim = makeSim();
    const av = sim.avionics;
    apply(sim);
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      const ev = apply(sim, { type: 'profile', dir: 1 });
      expect(ev.some((e) => e.name === 'profile')).toBe(true);
      order.push(av.selectedProfile);
    }
    expect(order).toEqual(['AGM65D', 'GBU12', 'MK82LD', 'AGM65H', 'M156-131', 'AGM65D']);
    apply(sim, { type: 'profile', dir: -1 });
    expect(av.selectedProfile).toBe('M156-131');
    // In CCRP with the laser bomb, the rockets (CCIP only) bring the mode to CCIP.
    av.selectedProfile = 'GBU12';
    apply(sim, { type: 'masterMode', value: 'CCRP' });
    expect(av.masterMode).toBe('CCRP');
    const ev = apply(sim, { type: 'profile', dir: -1 }, { type: 'profile', dir: -1 });
    expect(av.selectedProfile).toBe('M156-131');
    expect(av.masterMode).toBe('CCIP');
    expect(ev.filter((e) => e.name === 'masterMode').map((e) => e.value)).toEqual(['CCIP']);
    // A Maverick has no CCIP/CCRP delivery: the mode stays and the HUD keeps the gun.
    apply(sim, { type: 'profile', dir: 1 });
    expect(av.selectedProfile).toBe('AGM65D');
    stepFireControl(sim, SIM_DT);
    expect(av.masterMode).toBe('CCIP');
    expect(av.sight).toBe('GUN');
  });

  it('skips profiles whose stores are gone; the HUD sight follows mode and profile', () => {
    const sim = makeSim();
    const av = sim.avionics;
    apply(sim);
    for (const st of sim.stores.stations) {
      st.stores = st.stores.filter((s) => s !== 'AGM-65D' && s !== 'MK-82');
    }
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      apply(sim, { type: 'profile', dir: 1 });
      order.push(av.selectedProfile);
    }
    expect(order).toEqual(['GBU12', 'AGM65H', 'M156-131', 'GBU12']);
    const sights: Record<string, string> = {};
    for (const mode of ['NAV', 'GUNS', 'CCIP', 'CCRP'] as const) {
      apply(sim, { type: 'masterMode', value: mode });
      stepFireControl(sim, SIM_DT);
      sights[mode] = av.sight;
    }
    expect(sights).toEqual({ NAV: 'NONE', GUNS: 'GUN', CCIP: 'CCIP', CCRP: 'CCRP' });
  });
});

describe('sensor of interest and the displays', () => {
  it('only a sensor page can be the SOI (TAD, TGP, MAV)', () => {
    const sim = makeSim();
    const av = sim.avionics;
    expect(apply(sim, { type: 'soi', value: 'LMFD' })).toEqual([
      expect.objectContaining({ name: 'soi', value: 'LMFD' }),
    ]);
    expect(soiTarget(av)).toBe('TAD');
    sim.events.length = 0;
    expect(apply(sim, { type: 'soi', value: 'RMFD' })).toEqual([]);
    expect(av.soi).toBe('LMFD');
    expect(messages(sim)).toEqual(['RIGHT MFCD DSMS: NOT SOI CAPABLE']);
    apply(sim, { type: 'soi', value: 'HUD' });
    expect(av.soi).toBe('HUD');
  });

  it('coolie: up HUD, left/right long SOI, short steps the pages', () => {
    const sim = makeSim();
    const av = sim.avionics;
    apply(sim, { type: 'coolie', dir: 'left', long: true });
    expect(av.soi).toBe('LMFD');
    apply(sim, { type: 'coolie', dir: 'right', long: true });
    expect(av.soi).toBe('LMFD'); // DSMS is not a sensor page
    let ev = apply(sim, { type: 'coolie', dir: 'right', long: false });
    expect(av.mfd.right).toBe(PAGE_CYCLE[(PAGE_CYCLE.indexOf('DSMS') + 1) % PAGE_CYCLE.length]);
    expect(ev).toEqual([expect.objectContaining({ name: 'rightMfd', value: av.mfd.right })]);
    while (av.mfd.right !== 'TGP') apply(sim, { type: 'coolie', dir: 'right', long: false });
    apply(sim, { type: 'coolie', dir: 'right', long: true });
    expect(av.soi).toBe('RMFD');
    expect(soiTarget(av)).toBe('TGP');
    ev = apply(sim, { type: 'coolie', dir: 'up', long: false });
    expect(av.soi).toBe('HUD');
    expect(ev.map((e) => e.name)).toEqual(['soi']);
    // Down is the DSMS quick look in the A-10C II: not modelled, nothing changes.
    expect(apply(sim, { type: 'coolie', dir: 'down', long: true })).toEqual([]);
  });

  it('a display that is SOI and leaves its sensor page gives the SOI back to the HUD', () => {
    const sim = makeSim();
    const av = sim.avionics;
    apply(sim, { type: 'soi', value: 'LMFD' });
    const ev = apply(sim, { type: 'mfdPage', display: 'L', page: 'DSMS' });
    expect(av.mfd.left).toBe('DSMS');
    expect(av.soi).toBe('HUD');
    expect(ev.map((e) => `${e.name}:${e.value}`)).toEqual(['leftMfd:DSMS', 'soi:HUD']);
  });

  it('option-select buttons: page row on every page, the DSMS profile buttons, a click each', () => {
    const sim = makeSim();
    const av = sim.avionics;
    apply(sim);
    for (const [osb, page] of Object.entries(PAGE_SELECT_OSB)) {
      const ev = apply(sim, { type: 'osb', display: 'R', button: Number(osb) });
      expect(ev[0]).toMatchObject({ name: 'osb', value: `R${osb}` });
      expect(av.mfd.right).toBe(page);
    }
    apply(sim, { type: 'osb', display: 'R', button: 12 });
    expect(av.mfd.right).toBe('DSMS');
    expect(OSB_TABLE.DSMS[6]?.label).toBe('PROF+');
    const first = av.selectedProfile;
    apply(sim, { type: 'osb', display: 'R', button: 6 });
    expect(av.selectedProfile).not.toBe(first);
    apply(sim, { type: 'osb', display: 'R', button: 7 });
    expect(av.selectedProfile).toBe(first);
    // Not a button.
    expect(apply(sim, { type: 'osb', display: 'L', button: 21 })).toEqual([]);
    // A button with no function still clicks.
    expect(apply(sim, { type: 'osb', display: 'L', button: 1 }).map((e) => e.name)).toEqual([
      'osb',
    ]);
  });
});

describe('HOTAS routing and the SPI', () => {
  it('TMS forward long makes the gun pipper the SPI; aft long returns it to the steerpoint', () => {
    const sim = makeSim('gunOnly');
    const av = sim.avionics;
    apply(sim, { type: 'masterMode', value: 'GUNS' });
    dive(sim);
    stepFireControl(sim, SIM_DT);
    expect(av.gun.valid).toBe(true);
    let ev = apply(sim, { type: 'tms', dir: 'up', long: true });
    expect(av.spi.source).toBe('HUD');
    expect(av.spi.position.equals(av.gun.impact)).toBe(true);
    expect(ev).toEqual([expect.objectContaining({ name: 'spi', value: 'HUD' })]);
    // A HUD SPI is a fixed ground point.
    const held = av.spi.position.clone();
    sim.aircraft.position.y += 50;
    stepFireControl(sim, SIM_DT);
    expect(av.spi.position.equals(held)).toBe(true);
    ev = apply(sim, { type: 'tms', dir: 'down', long: true });
    expect(av.spi.source).toBe('STPT');
    expect(av.spi.position.equals(av.steerpoints[av.activeSteerpoint].position)).toBe(true);
    expect(ev[0]).toMatchObject({ name: 'spi', value: 'STPT' });
    // In NAV there is no pipper: the steerpoint is the HUD's point.
    apply(sim, { type: 'masterMode', value: 'NAV' });
    stepFireControl(sim, SIM_DT);
    apply(sim, { type: 'tms', dir: 'up', long: true });
    expect(av.spi.source).toBe('STPT');
  });

  it('with the pod as SOI the SPI follows the pod, and presses go to the sensors module', () => {
    const sim = makeSim();
    const av = sim.avionics;
    apply(sim, { type: 'mfdPage', display: 'R', page: 'TGP' }, { type: 'soi', value: 'RMFD' });
    expect(soiTarget(av)).toBe('TGP');
    const tgp = sim.sensors.tgp;
    tgp.pointValid = true;
    tgp.point.set(1200, 0, -5400);
    apply(sim, { type: 'tms', dir: 'up', long: true });
    expect(av.spi.source).toBe('TGP');
    tgp.point.set(1210, 0, -5390);
    stepFireControl(sim, SIM_DT);
    expect(av.spi.position.toArray()).toEqual([1210, 0, -5390]);
    // Presses the avionics does not handle become requests for the pod.
    apply(
      sim,
      { type: 'tms', dir: 'up', long: false },
      { type: 'dms', dir: 'left', long: false },
      { type: 'chinaHat', dir: 'fwd', long: false },
      { type: 'sensorPicture', value: 'cycle' },
      { type: 'sensorZoom', dir: 1 },
    );
    expect(
      av.sensorRequests.map((r) => `${r.sensor}:${r.action}:${r.dir}:${r.long}:${r.value}`),
    ).toEqual([
      'TGP:tms:up:false:0',
      'TGP:dms:left:false:0',
      'TGP:chinaHat:fwd:false:0',
      'TGP:picture::false:0',
      'TGP:zoom::false:1',
    ]);
    // The requests live for one step.
    apply(sim);
    expect(av.sensorRequests).toEqual([]);
    // The Maverick page as SOI gets the presses instead.
    apply(sim, { type: 'mfdPage', display: 'R', page: 'MAV' }, { type: 'soi', value: 'RMFD' });
    apply(sim, { type: 'tms', dir: 'down', long: false }, { type: 'sensorZoom', dir: -1 });
    expect(av.sensorRequests.map((r) => `${r.sensor}:${r.action}`)).toEqual([
      'MAV:tms',
      'MAV:zoom',
    ]);
  });

  it('China hat long: slave all sensors (forward) or the pod (aft) to the SPI', () => {
    const sim = makeSim();
    const av = sim.avionics;
    sim.time = 12.5;
    let ev = apply(sim, { type: 'chinaHat', dir: 'fwd', long: true });
    expect(av.slaveRequest).toEqual({ sensors: 'ALL', time: 12.5 });
    expect(av.sensorRequests).toEqual([
      { sensor: 'ALL', action: 'slaveSpi', dir: 'fwd', long: true, value: 0, t: 12.5 },
    ]);
    expect(ev[0]).toMatchObject({ name: 'slave', value: 'ALL' });
    ev = apply(sim, { type: 'chinaHat', dir: 'aft', long: true });
    expect(av.slaveRequest.sensors).toBe('TGP');
    expect(ev[0]).toMatchObject({ name: 'slave', value: 'TGP' });
  });

  it('DMS with the HUD as SOI: profiles left/right (gun sights in GUNS), steerpoints up/down', () => {
    const sim = makeSim();
    const av = sim.avionics;
    apply(sim);
    const first = av.selectedProfile;
    apply(sim, { type: 'dms', dir: 'right', long: false });
    expect(av.selectedProfile).not.toBe(first);
    apply(sim, { type: 'dms', dir: 'left', long: false });
    expect(av.selectedProfile).toBe(first);
    apply(sim, { type: 'masterMode', value: 'GUNS' });
    const ev = apply(sim, { type: 'dms', dir: 'right', long: false });
    expect(av.selectedProfile).toBe(first);
    expect(av.gunSight).toBe(GUN_SIGHTS[1 % GUN_SIGHTS.length]);
    expect(ev.length).toBe(GUN_SIGHTS.length > 1 ? 1 : 0);
    apply(sim, { type: 'dms', dir: 'up', long: false });
    expect(av.activeSteerpoint).toBe(1);
    apply(sim, { type: 'dms', dir: 'down', long: false });
    expect(av.activeSteerpoint).toBe(0);
  });
});

describe('steerpoints', () => {
  it('steps and wraps; the SPI follows only while it is the steerpoint', () => {
    const sim = makeSim();
    const av = sim.avionics;
    apply(sim);
    const n = av.steerpoints.length;
    const ev = apply(sim, { type: 'steerpoint', dir: -1 });
    expect(av.activeSteerpoint).toBe(n - 1);
    expect(ev[0]).toMatchObject({ name: 'steerpoint', value: av.steerpoints[n - 1].name });
    expect(av.spi.position.equals(av.steerpoints[n - 1].position)).toBe(true);
    apply(sim, { type: 'steerpoint', dir: 1 });
    expect(av.activeSteerpoint).toBe(0);
    av.spi.source = 'HUD';
    av.spi.position.set(1, 2, 3);
    apply(sim, { type: 'steerpoint', dir: 1 });
    stepFireControl(sim, SIM_DT);
    expect(av.activeSteerpoint).toBe(1);
    expect(av.spi.position.toArray()).toEqual([1, 2, 3]);
  });
});

describe('commands for the flight and weapons modules', () => {
  it('flaps, gear, autopilot and altitude alert go through the flight setters', () => {
    const sim = makeSim();
    const ac = sim.aircraft;
    const flaps = (value: 0 | 1 | 2 | 'up' | 'down') =>
      apply(sim, { type: 'flaps', value }).map((e) => e.value);
    expect(flaps(1)).toEqual(['MVR']);
    expect(ac.flapHandle).toBe(1);
    expect(flaps('down')).toEqual(['DN']);
    expect(flaps('down')).toEqual([]);
    expect(ac.flapHandle).toBe(2);
    expect(flaps('up')).toEqual(['MVR']);
    expect(flaps(0)).toEqual(['UP']);
    expect(ac.flapHandle).toBe(0);
    expect(apply(sim, { type: 'gear', value: 'toggle' })[0]).toMatchObject({
      name: 'gear',
      value: 'DOWN',
    });
    expect(ac.gearDown).toBe(true);
    apply(sim, { type: 'gear', value: false });
    expect(ac.gearDown).toBe(false);
    expect(apply(sim, { type: 'autopilot', action: 'toggle' })[0].value).toBe('ENGAGED');
    expect(ac.autopilot.engaged).toBe(true);
    expect(apply(sim, { type: 'autopilot', action: 'mode' })[0].value).toBe('ALT_HDG');
    expect(apply(sim, { type: 'autopilot', action: 'disengage' })[0].value).toBe('OFF');
    expect(ac.autopilot.engaged).toBe(false);
    expect(apply(sim, { type: 'altitudeAlert', value: 500 * FT })[0].value).toBe('500 FT');
    expect(ac.altitudeAlert).toBeCloseTo(500 * FT, 9);
    expect(apply(sim, { type: 'altitudeAlert', value: 0 })[0].value).toBe('OFF');
    expect(ac.altitudeAlert).toBe(0);
  });

  it('jettison and rearm go through the weapons module and refresh the profiles', () => {
    const sim = makeSim();
    const av = sim.avionics;
    apply(sim);
    const loaded = sim.stores.stations.map((s) => s.stores.length);
    const ev = apply(sim, { type: 'jettison', stations: 'all' });
    expect(ev.at(-1)).toMatchObject({ name: 'jettison', value: 'ALL' });
    const left = sim.stores.stations.flatMap((s) => s.stores);
    expect(left).not.toContain('MK-82');
    expect(left).not.toContain('GBU-12');
    // The profiles stay but nothing is selectable for CCIP except the gun.
    apply(sim, { type: 'masterMode', value: 'CCIP' });
    stepFireControl(sim, SIM_DT);
    expect(av.sight).toBe('GUN');
    sim.gun.rounds = 100;
    apply(sim, { type: 'rearm' });
    expect(sim.gun.rounds).toBe(1150);
    expect(sim.stores.stations.map((s) => s.stores.length)).toEqual(loaded);
    stepFireControl(sim, SIM_DT);
    expect(av.sight).toBe('CCIP');
    // Selective jettison of one station.
    apply(sim, { type: 'jettison', stations: [5] });
    expect(sim.stores.stations[4].stores).toEqual([]);
    expect(sim.stores.stations[6].stores).toEqual(['MK-82']);
  });

  it('handles every command variant and empties the queue', () => {
    const sim = makeSim();
    const all: Command[] = [
      { type: 'masterArm', value: 'cycle' },
      { type: 'gunPac', value: 'cycle' },
      { type: 'laserArm', value: 'cycle' },
      { type: 'tgpPower', value: 'toggle' },
      { type: 'altSource', value: 'cycle' },
      { type: 'masterMode', value: 'next' },
      { type: 'profile', dir: 1 },
      { type: 'soi', value: 'LMFD' },
      { type: 'mfdPage', display: 'L', page: 'TGP' },
      { type: 'osb', display: 'R', button: 13 },
      { type: 'tms', dir: 'left', long: false },
      { type: 'dms', dir: 'right', long: true },
      { type: 'chinaHat', dir: 'aft', long: false },
      { type: 'coolie', dir: 'left', long: false },
      { type: 'sensorPicture', value: 'cycle' },
      { type: 'sensorZoom', dir: -1 },
      { type: 'flaps', value: 'down' },
      { type: 'gear', value: 'toggle' },
      { type: 'autopilot', action: 'mode' },
      { type: 'altitudeAlert', value: 152.4 },
      { type: 'jettison', stations: [2] },
      { type: 'rearm' },
      { type: 'steerpoint', dir: 1 },
    ];
    const kinds = new Set(all.map((c) => c.type));
    expect(kinds.size).toBe(23);
    for (const c of all) pushCommand(sim, c);
    expect(() => applyCommands(sim)).not.toThrow();
    expect(sim.commands).toEqual([]);
  });
});

describe('stores page data', () => {
  it('lists the stations, the profiles with the stores left and the gun, reusing its objects', () => {
    const sim = makeSim();
    apply(sim);
    const view = buildDsmsView(sim);
    expect(view.stations.length).toBe(11);
    const st3 = view.stations[2];
    expect(st3).toMatchObject({ station: 3, rack: 'LAU-88', store: 'AGM-65D', count: 2 });
    expect(view.stations[5]).toMatchObject({ station: 6, rack: null, store: null, count: 0 });
    const mk = view.profiles.find((p) => p.store === 'MK-82');
    expect(mk).toMatchObject({ name: 'MK82LD', remaining: 2, mode: 'CCIP', selected: false });
    const sel = view.profiles.find((p) => p.selected);
    expect(sel?.id).toBe(sim.avionics.selectedProfile);
    expect(view.stations.filter((s) => s.selected).map((s) => s.station)).toEqual([2]);
    expect(view.gunRounds).toBe(1150);
    expect(view.gunLoad).toBe('combatMix');
    expect(view.selectedProfile).toBe('M156-131');
    const firstStation = view.stations[0];
    sim.stores.stations[4].stores.length = 0;
    const again = buildDsmsView(sim, view);
    expect(again).toBe(view);
    expect(again.stations[0]).toBe(firstStation);
    expect(again.profiles.find((p) => p.store === 'MK-82')?.remaining).toBe(1);
  });
});

describe('determinism', () => {
  it('the same commands give the same avionics state and events', () => {
    const run = () => {
      const sim = makeSim();
      const cmds: Command[] = [
        { type: 'masterArm', value: 'ARM' },
        { type: 'gunPac', value: 'cycle' },
        { type: 'masterMode', value: 'next' },
        { type: 'masterMode', value: 'next' },
        { type: 'profile', dir: 1 },
        { type: 'coolie', dir: 'left', long: true },
        { type: 'tms', dir: 'up', long: true },
      ];
      const events: string[] = [];
      for (const c of cmds) {
        for (const e of apply(sim, c)) events.push(`${e.name}=${e.value}`);
        dive(sim);
        stepFireControl(sim, SIM_DT);
      }
      const av = sim.avionics;
      return {
        events,
        mode: av.masterMode,
        profile: av.selectedProfile,
        spi: av.spi.position.toArray(),
      };
    };
    expect(run()).toEqual(run());
  });
});
