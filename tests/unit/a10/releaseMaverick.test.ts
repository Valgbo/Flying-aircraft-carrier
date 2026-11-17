/**
 * Maverick launch (PLAN_A10.md §6.4, §16 Maverick row "a launch outside the gimbal limits is
 * refused"; ARCHITECTURE §12.1, §12.3): with a Maverick profile selected, in any master mode,
 * the pickle held ≈1 s launches one missile when the selected seeker is powered, aligned,
 * locked and in zone and the guided module's maverickCanLaunch agrees; otherwise a message. After
 * a launch the next missile is selected and its seeker is slaved to the SPI.
 *
 * The seekers are built by the test (the sensors module's state, set directly) and the steps run
 * only the avionics (applyCommands, stepFireControl) and the release execution of the test, so
 * the sensors and guided modules' own steps do not interfere.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { applyCommands, RELEASE, stepFireControl } from '../../../src/a10/core/avionics';
import { SIM_DT } from '../../../src/a10/core/constants';
import { createSim } from '../../../src/a10/core/sim';
import type { MaverickSeekerState } from '../../../src/a10/core/sensors/types';
import type { MasterMode, Sim, SimEvent } from '../../../src/a10/core/types';
import { updateStoresTotals } from '../../../src/a10/core/weapons';
import type { ReleaseRequest, StoreType } from '../../../src/a10/core/weapons/types';
import { createFlatTerrain } from '../../../src/a10/core/world';

/** A seeker of a missile on a station, as the sensors module would publish it. */
function seeker(station: number, type: StoreType, over: Partial<MaverickSeekerState> = {}): MaverickSeekerState {
  return {
    station,
    type,
    powered: true,
    align: 0,
    los: new Vector3(0, -0.3, -1).normalize(),
    fov: 'WIDE',
    locked: true,
    lockedVehicle: 7,
    lockPoint: new Vector3(120, 0, -6000),
    inZone: true,
    gimbalAz: 0,
    gimbalEl: -0.1,
    contrast: 0.6,
    selected: false,
    rail: 0,
    ...over,
  } as MaverickSeekerState;
}

function mavSim(): Sim {
  const sim = createSim({ terrain: createFlatTerrain(0), scenario: 'empty', loadoutId: 'tankHunter', seed: 3 });
  const av = sim.avionics;
  av.masterArm = 'ARM';
  av.selectedProfile = 'AGM65D';
  // The sensors module's published seekers: the selected one first.
  sim.sensors.mavericks = [seeker(3, 'AGM-65D'), seeker(3, 'AGM-65D', { rail: 1, locked: false })];
  sim.sensors.selectedMaverick = 0;
  // The aircraft level at 3,000 m, 280 kn, heading north.
  const ac = sim.aircraft;
  ac.position.set(0, 3000, 0);
  ac.prevPosition.copy(ac.position);
  ac.velocity.set(0, 0, -144);
  return sim;
}

interface Stepped {
  requests: ReleaseRequest[];
  events: SimEvent[];
}

/**
 * Run `seconds` of avionics steps: commands, the release requests executed by the test (the
 * missile leaves its station), fire control. `held(t)` drives the pickle.
 */
function run(sim: Sim, seconds: number, held: (t: number) => boolean, out?: Stepped): Stepped {
  const res = out ?? { requests: [], events: [] };
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    const t0 = sim.time;
    applyCommands(sim);
    for (const r of sim.avionics.sensorRequests) {
      res.events.push({ type: 'switch', t: t0, name: `request:${r.sensor}:${r.action}`, value: r.dir });
    }
    const q = sim.stores.releaseQueue;
    for (let k = 0; k < q.length; ) {
      if (q[k].time < t0 + SIM_DT) {
        const req = q.splice(k, 1)[0];
        const st = sim.stores.stations[req.station - 1];
        st.stores.splice(st.stores.indexOf(req.store), 1);
        updateStoresTotals(sim.stores);
        // The sensors module drops the launched missile's seeker and selects the next.
        sim.sensors.mavericks.shift();
        sim.sensors.selectedMaverick = sim.sensors.mavericks.length > 0 ? 0 : -1;
        res.requests.push(req);
      } else k++;
    }
    sim.input.weaponRelease = held(t0);
    sim.aircraft.position.addScaledVector(sim.aircraft.velocity, SIM_DT);
    stepFireControl(sim, SIM_DT);
    for (const e of sim.events) res.events.push(e);
    sim.events.length = 0;
    sim.time += SIM_DT;
  }
  return res;
}

function messages(s: Stepped): string[] {
  return s.events.flatMap((e) => (e.type === 'message' ? [e.text] : []));
}

describe('Maverick launch (PLAN §6.4)', () => {
  it('holding the pickle ≈1 s launches one missile: delivery MAV, the lock point and the locked vehicle', () => {
    const sim = mavSim();
    const start = sim.time;
    const res = run(sim, 2.5, () => true);
    expect(res.requests).toHaveLength(1);
    const r = res.requests[0];
    expect(r.delivery).toBe('MAV');
    expect(r.station).toBe(3);
    expect(r.store).toBe('AGM-65D');
    expect(r.profile).toBe('AGM65D');
    expect(r.lockVehicle).toBe(7);
    expect(r.aimValid).toBe(true);
    expect(r.aim).toEqual({ x: 120, y: 0, z: -6000 });
    // The press is seen at the first step's fire-control time; the launch follows the hold.
    const press = start + SIM_DT;
    expect(r.time - press).toBeGreaterThanOrEqual(RELEASE.mavHoldTime - 1e-9);
    expect(r.time - press).toBeLessThan(RELEASE.mavHoldTime + SIM_DT);
    console.log(
      `[release] Maverick: launch ${(r.time - press).toFixed(4)} s after the press (hold ${RELEASE.mavHoldTime} s), station ${r.station}`,
    );
    // One per press: still held, nothing more.
    expect(sim.avionics.delivery.phase).toBe('DONE');
  });

  it('letting go before the hold time launches nothing; a new press launches the next missile', () => {
    const sim = mavSim();
    const short = run(sim, 1.5, (t) => t < 0.6);
    expect(short.requests).toHaveLength(0);
    // Second missile on the same LAU-88 (rail 1 locked now): press, hold, launch; again.
    sim.sensors.mavericks[1].locked = true;
    const a = run(sim, 1.6, () => true);
    run(sim, 0.1, () => false);
    const b = run(sim, 1.6, () => true);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(sim.stores.stations[2].stores.filter((s) => s === 'AGM-65D')).toHaveLength(0);
  });

  it('launches in every master mode', () => {
    for (const mode of ['NAV', 'GUNS', 'CCIP', 'CCRP'] as MasterMode[]) {
      const sim = mavSim();
      sim.avionics.masterMode = mode;
      const res = run(sim, 1.3, () => true);
      expect(res.requests, mode).toHaveLength(1);
    }
  });

  it('refuses with a message: not powered, aligning, not locked, out of zone (gimbal), no missile', () => {
    const cases: [Partial<MaverickSeekerState>, RegExp][] = [
      [{ powered: false }, /MAV NOT READY/],
      [{ align: 42 }, /MAV NOT READY/],
      [{ locked: false }, /MAV NOT LOCKED/],
      [{ inZone: false }, /MAV (OUT OF ZONE|GIMBAL LIMIT|OUT OF RANGE)/],
    ];
    for (const [over, text] of cases) {
      const sim = mavSim();
      Object.assign(sim.sensors.mavericks[0], over);
      const res = run(sim, 1.5, () => true);
      expect(res.requests, JSON.stringify(over)).toHaveLength(0);
      expect(messages(res).join('|')).toMatch(text);
      // One message per press, not one per step.
      expect(messages(res)).toHaveLength(1);
    }
    // No seeker selected.
    const sim = mavSim();
    sim.sensors.selectedMaverick = -1;
    const res = run(sim, 1.5, () => true);
    expect(res.requests).toHaveLength(0);
    expect(messages(res)).toEqual(['NO MAV SELECTED']);
  });

  it('a lock lost during the hold refuses at the launch instant', () => {
    const sim = mavSim();
    const res = run(sim, 1.5, (t) => {
      if (t > 0.5) sim.sensors.mavericks[0].locked = false;
      return true;
    });
    expect(res.requests).toHaveLength(0);
    expect(messages(res).join('|')).toMatch(/MAV NOT LOCKED/);
  });

  it('Master Arm SAFE: nothing; TRAIN: a simulated record at the lock point', () => {
    const safe = mavSim();
    safe.avionics.masterArm = 'SAFE';
    const s = run(safe, 1.5, () => true);
    expect(s.requests).toHaveLength(0);
    expect(messages(s)).toEqual(['MASTER ARM SAFE']);
    const train = mavSim();
    train.avionics.masterArm = 'TRAIN';
    const t = run(train, 1.5, () => true);
    expect(t.requests).toHaveLength(0);
    const w = train.debrief.weapons;
    expect(w).toHaveLength(1);
    expect(w[0].simulated).toBe(true);
    expect(w[0].delivery).toBe('MAV');
    expect(w[0].store).toBe('AGM-65D');
    expect(w[0].impact).toEqual({ x: 120, y: 0, z: -6000 });
    expect(w[0].missDistance).toBe(0);
  });

  it('after a launch the next missile is selected and slaved to the SPI', () => {
    const sim = mavSim();
    const av = sim.avionics;
    av.spi.valid = true;
    av.spi.source = 'HUD';
    av.spi.position.set(100, 0, -5000);
    const res = run(sim, 1.5, () => true);
    expect(res.requests).toHaveLength(1);
    // The launch left in the step after the decision; the request for the next seeker follows.
    const slaves = res.events.filter((e) => e.type === 'switch' && e.name === 'request:MAV:slaveSpi');
    expect(slaves).toHaveLength(1);
    expect(slaves[0].t).toBeGreaterThan(res.requests[0].time);
    // The DSMS's selected station is the sensors module's selected missile (rail 1 on station 3).
    expect(av.selectedStation).toBe(3);
    // The H profile: the selected seeker is a D, so the release order picks the H's station and
    // the sensors module selects the seeker there.
    av.selectedProfile = 'AGM65H';
    run(sim, 0.1, () => false);
    expect(av.selectedStation).toBe(9);
    // Without a valid SPI nothing is slaved.
    const other = mavSim();
    other.avionics.spi.valid = false;
    other.avionics.spi.source = 'HUD';
    const r2 = run(other, 1.5, () => true);
    expect(r2.requests).toHaveLength(1);
    expect(r2.events.some((e) => e.type === 'switch' && e.name === 'request:MAV:slaveSpi')).toBe(false);
  });
});
