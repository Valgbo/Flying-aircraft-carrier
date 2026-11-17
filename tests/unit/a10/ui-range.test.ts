import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIM_DT } from '../../../src/a10/core/constants';
import { findRangeLayout } from '../../../src/a10/core/debrief';
import { createDebriefTestbed } from '../../../src/a10/core/debrief/testbed';
import { applyRangeConditions, createSim, runSim } from '../../../src/a10/core/sim';
import type { ScenarioKind, SimOptions } from '../../../src/a10/core/types';
import { KT } from '../../../src/a10/core/units';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { MOBILITY } from '../../../src/a10/data/vehicles';
import { sensorMessage } from '../../../src/a10/ui/bridge';
import { createCallState, rangeCalls } from '../../../src/a10/ui/rangeCalls';
import { KILL_MESSAGES, RANGE_CALLS, SENSOR_MESSAGES } from '../../../src/a10/ui/realism';
import {
  DEFAULT_RANGE_OPTIONS,
  describeRangeOptions,
  LANE_SPEED_KMH,
  loadRangeOptions,
  RANGE_STORAGE_KEY,
  rangeWind,
  sanitizeRangeOptions,
  saveRangeOptions,
  toRangeConditions,
  TURBULENCE_LEVELS,
  windClockName,
  type RangeOptions,
} from '../../../src/a10/ui/rangeOptions';

/**
 * Weapons-range options (PLAN_A10.md §11.2, src/a10/ui/rangeOptions.ts): the wind given as the
 * clock direction it blows from along the event's run-in, the turbulence, the tactical lane's
 * column speed; createSim puts them (SimOptions.range) on a range flight before its first step,
 * never on free hunt.
 */

const DEG = Math.PI / 180;

function sim(scenario: ScenarioKind, range?: RangeOptions) {
  return createSim({
    terrain: createFlatTerrain(0),
    scenario,
    seed: 5,
    range: range ? toRangeConditions(range) : undefined,
  });
}

const opts = (patch: Partial<RangeOptions>): RangeOptions => ({
  ...DEFAULT_RANGE_OPTIONS,
  ...patch,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('range wind: the clock direction it blows from, seen along the run-in', () => {
  it("12 o'clock is a headwind, 3 o'clock blows from the right, 6 is a tailwind", () => {
    const u = 10 * KT;
    // run-in north: the air of a headwind moves south (+z), of a wind from 3 o'clock west (−x)
    const head = rangeWind(10, 12, 0);
    expect(head.x).toBeCloseTo(0, 9);
    expect(head.z).toBeCloseTo(u, 9);
    const right = rangeWind(10, 3, 0);
    expect(right.x).toBeCloseTo(-u, 9);
    expect(right.z).toBeCloseTo(0, 9);
    const tail = rangeWind(10, 6, 0);
    expect(tail.z).toBeCloseTo(-u, 9);
    // run-in east: a headwind blows from the east (the air moves west), from 9 o'clock from
    // the north (the air moves south)
    const eastHead = rangeWind(10, 12, 90 * DEG);
    expect(eastHead.x).toBeCloseTo(-u, 9);
    expect(eastHead.z).toBeCloseTo(0, 9);
    const eastLeft = rangeWind(10, 9, 90 * DEG);
    expect(eastLeft.x).toBeCloseTo(0, 9);
    expect(eastLeft.z).toBeCloseTo(u, 9);
    // calm is calm whatever the clock
    const calm = rangeWind(0, 4, 1);
    expect(Math.hypot(calm.x, calm.z)).toBe(0);
  });

  it('names the clock directions as a range calls them', () => {
    expect(windClockName(12)).toBe('headwind');
    expect(windClockName(6)).toBe('tailwind');
    expect(windClockName(3)).toBe('from the right');
    expect(windClockName(9)).toBe('from the left');
    expect(windClockName(2)).toBe('from ahead right');
    expect(windClockName(7)).toBe('from behind left');
    expect(describeRangeOptions(opts({ windKt: 10, windClock: 3, turbulence: 'moderate' }))).toBe(
      "Wind 10 kn from 3 o'clock · moderate turbulence · column 15 km/h",
    );
    expect(describeRangeOptions(opts({ columnKmh: 0 }))).toBe(
      'Calm wind · light turbulence · column halted',
    );
  });
});

describe('range options on a flight', () => {
  it('a range event takes the wind along its run-in and the turbulence; free hunt is left alone', () => {
    for (const scenario of ['strafePit', 'bombCircle', 'tacticalLane'] as const) {
      const s = sim(scenario, opts({ windKt: 15, windClock: 4, turbulence: 'strong' }));
      const runIn = findRangeLayout(s).runIn;
      const w = rangeWind(15, 4, runIn);
      expect(s.world.surfaceWind.x).toBeCloseTo(w.x, 9);
      expect(s.world.surfaceWind.z).toBeCloseTo(w.z, 9);
      expect(s.world.surfaceWind.y).toBe(0);
      expect(s.world.turbulence).toBe(TURBULENCE_LEVELS.strong.value);
    }
    const own = sim('freeHunt');
    const free = sim('freeHunt', opts({ windKt: 25, turbulence: 'calm' }));
    expect(applyRangeConditions(free)).toBe(false);
    expect(free.world.surfaceWind.length()).toBe(0);
    expect(free.world.turbulence).toBe(own.world.turbulence);
  });

  it('the defaults are the world’s own conditions (an unchanged dialog changes nothing)', () => {
    const plain = sim('bombCircle');
    const set = sim('bombCircle', DEFAULT_RANGE_OPTIONS);
    expect(set.world.surfaceWind.length()).toBe(plain.world.surfaceWind.length());
    expect(set.world.turbulence).toBe(plain.world.turbulence);
    expect(LANE_SPEED_KMH).toBe(Math.round(MOBILITY.laneSpeed * 3.6));
  });

  it('the tactical lane column drives at the chosen speed, or stays halted', () => {
    const column = (kmh: number) => {
      const s = sim('tacticalLane', opts({ columnKmh: kmh }));
      const g = s.targets.groups.find((x) => x.template === 'laneColumn')!;
      expect(g.speed).toBeCloseTo(kmh / 3.6, 9);
      const ids = g.vehicleIds;
      const at = () =>
        ids.map((id) => {
          const v = s.targets.vehicles.find((x) => x.id === id)!;
          return { x: v.position.x, z: v.position.z, speed: v.speed };
        });
      const before = at();
      runSim(s, 6);
      const after = at();
      return before.map((b, i) => ({
        moved: Math.hypot(after[i].x - b.x, after[i].z - b.z),
        speed: after[i].speed,
      }));
    };
    for (const v of column(0)) {
      expect(v.moved).toBeLessThan(0.01);
      expect(v.speed).toBe(0);
    }
    // every vehicle of the column, the lead (first) to the tail, is up to the new speed
    for (const v of column(40)) {
      expect(v.speed).toBeGreaterThan((40 / 3.6) * 0.8);
      expect(v.speed).toBeLessThan((40 / 3.6) * 1.2);
      expect(v.moved).toBeGreaterThan((40 / 3.6) * 6 * 0.75);
    }
    // the hulks of the lane never move
    const s = sim('tacticalLane', opts({ columnKmh: 40 }));
    const hulks = s.targets.groups.find((x) => x.template === 'laneHulks')!;
    for (const id of hulks.vehicleIds)
      expect(s.targets.vehicles.find((v) => v.id === id)!.speed).toBe(0);
  });

  it('createSim applies them before the first step only; a flown flight keeps its weather', () => {
    const s = sim('bombCircle', opts({ windKt: 20, windClock: 6 }));
    expect(s.world.surfaceWind.length()).toBeCloseTo(20 * KT, 9);
    expect(s.options.range).toEqual(toRangeConditions(opts({ windKt: 20, windClock: 6 })));
    const stepped = sim('bombCircle');
    runSim(stepped, 0.1);
    (stepped.options as SimOptions).range = toRangeConditions(opts({ windKt: 20 }));
    expect(applyRangeConditions(stepped)).toBe(false);
    expect(stepped.world.surfaceWind.length()).toBe(0);
  });
});

describe('range options are remembered under their own key', () => {
  function memoryStorage(initial: Record<string, string> = {}): Storage {
    const data = new Map(Object.entries(initial));
    return {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (k: string) => data.get(k) ?? null,
      key: (i: number) => [...data.keys()][i] ?? null,
      removeItem: (k: string) => void data.delete(k),
      setItem: (k: string, v: string) => void data.set(k, String(v)),
    };
  }

  it('saves and restores valid options; anything else reads as the defaults', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    expect(loadRangeOptions()).toEqual(DEFAULT_RANGE_OPTIONS);
    const chosen = opts({ windKt: 15, windClock: 9, turbulence: 'moderate', columnKmh: 30 });
    saveRangeOptions(chosen);
    expect(JSON.parse(storage.getItem(RANGE_STORAGE_KEY)!)).toEqual(chosen);
    expect(loadRangeOptions()).toEqual(chosen);
    expect(storage.getItem('a10-ui-v1')).toBeNull();

    for (const text of ['not json', '42', 'null', '{"windKt":7,"windClock":13,"turbulence":"x"}']) {
      storage.setItem(RANGE_STORAGE_KEY, text);
      expect(loadRangeOptions()).toEqual(DEFAULT_RANGE_OPTIONS);
    }
    expect(sanitizeRangeOptions({ windKt: 10, windClock: 2.5, columnKmh: 40 })).toEqual(
      opts({ windKt: 10, columnKmh: 40 }),
    );
  });

  it('works without storage (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(loadRangeOptions()).toEqual(DEFAULT_RANGE_OPTIONS);
    expect(() => saveRangeOptions(opts({ windKt: 5 }))).not.toThrow();
  });
});

describe('the range officer’s calls (toasts on a weapons range)', () => {
  /** The flat test world's first area hosts every range event (run-in north). */
  const AREA = { x: 0, z: -6000 };

  it('strafe pit: each pass is called once it has closed, a fouled pass with its foul', () => {
    const s = createDebriefTestbed('strafePit');
    s.step(SIM_DT);
    const panels = s.sim.debrief.internal.layout!.panels;
    const calls = createCallState();
    const onPanel = { vehicleKind: 'panel', outcome: 'passedThrough' as const, weapon: 'TP' };
    // a clean pass: 3 rounds through panel 2 out of the burst
    s.fly({ gamma: -10, agl: 250, x: -23, z: AREA.z + 1300 });
    s.step(1);
    s.trigger(1);
    s.step(0.3);
    const r = s.firstRound();
    for (let k = 0; k < 3; k++) s.hit(panels[1], r + k, onPanel);
    s.release(900);
    // nothing to call while the pass is open
    expect(rangeCalls(s.sim.debrief, calls)).toEqual([]);
    s.fly({ gamma: 6, agl: 200 });
    s.step(2);
    const rounds = s.sim.debrief.bursts[0].rounds;
    expect(rangeCalls(s.sim.debrief, calls)).toEqual([`PASS 1: 3 HITS OF ${rounds}`]);
    // called once
    expect(rangeCalls(s.sim.debrief, calls)).toEqual([]);
    // pass 2 pressed inside the foul line
    s.fly({ gamma: 0, agl: 600 });
    s.step(15);
    s.fly({ gamma: -12, agl: 300, z: AREA.z + 400 });
    s.step(1);
    s.trigger(1);
    s.step(0.3);
    s.hit(panels[0], s.firstRound(), onPanel);
    s.release(450);
    s.fly({ gamma: 8 });
    s.step(2);
    expect(rangeCalls(s.sim.debrief, calls)).toEqual(['PASS 2: FOUL, FOUL LINE — NO SCORE']);
  });

  it('bombing circle: each bomb as it lands, its miss and clock (a shack on the bull)', () => {
    const s = createDebriefTestbed('bombCircle');
    s.step(SIM_DT);
    const calls = createCallState();
    const land = (dx: number, dz: number, dud = false) => {
      s.fly({ gamma: -20, track: 0 });
      s.step(1);
      const w = s.drop();
      s.fly({ gamma: 10 });
      s.step(2);
      s.sim.events.push({
        type: 'detonation',
        t: s.sim.time,
        position: { x: AREA.x + dx, y: 0, z: AREA.z + dz },
        charge: dud ? 0 : 96,
        kind: dud ? 'dud' : 'bomb',
        vehicleId: 0,
        surface: 'grass',
        bodyId: w.bodyId,
      });
      w.impactTime = s.sim.time;
      w.dud = dud;
      s.step(SIM_DT);
    };
    land(15, 0);
    const first = rangeCalls(s.sim.debrief, calls);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/^MK-82 1: 15\sM AT 3 O'CLOCK$/);
    land(0, 0.2);
    land(0, -20, true);
    const next = rangeCalls(s.sim.debrief, calls);
    expect(next[0]).toBe('MK-82 2: SHACK');
    expect(next[1]).toMatch(/^MK-82 3: DUD, 20\sM AT 12 O'CLOCK$/);
    expect(rangeCalls(s.sim.debrief, calls)).toEqual([]);
  });

  it('tactical lane: a pass’s kills; free hunt has no range officer', () => {
    const s = createDebriefTestbed('tacticalLane');
    s.step(SIM_DT);
    const calls = createCallState();
    const v = s.sim.debrief.internal.layout!.vehicles.at(-1)!;
    s.fly({ gamma: -15 });
    s.step(1);
    s.trigger(1);
    s.step(0.4);
    s.hit(v, s.firstRound() + 1, { condition: 'destroyed' });
    s.sim.debrief.kills.push({
      time: s.sim.time,
      vehicleId: v,
      kind: 'mbt',
      weapon: 'API',
      catastrophic: false,
    });
    s.release(700);
    s.fly({ gamma: 8 });
    s.step(2);
    expect(rangeCalls(s.sim.debrief, calls)).toEqual(['PASS 1: 1 KILL']);

    const free = createDebriefTestbed('freeHunt');
    free.fly({ gamma: -15 });
    free.step(1);
    free.trigger(1);
    free.step(0.3);
    free.release(700);
    free.fly({ gamma: 8 });
    free.step(2);
    expect(free.sim.debrief.passes).toHaveLength(1);
    expect(rangeCalls(free.sim.debrief, createCallState())).toEqual([]);
  });

  it('lock and laser messages, and which realism presets show the toasts', () => {
    const t = 1;
    expect(sensorMessage({ type: 'lock', t, sensor: 'MAV', on: true })).toBe('MAV LOCKED');
    expect(sensorMessage({ type: 'lock', t, sensor: 'MAV', on: false })).toBe('MAV LOCK LOST');
    expect(sensorMessage({ type: 'lock', t, sensor: 'TGP', on: true })).toBe('TGP POINT TRACK');
    expect(sensorMessage({ type: 'laser', t, on: true })).toBe('LASING');
    expect(sensorMessage({ type: 'laser', t, on: false })).toBe('LASER OFF');
    expect(sensorMessage({ type: 'message', t, text: 'X', level: 'info' })).toBeNull();
    // Authentic: the displays say it, not a toast; the range officer's calls are on a range
    expect(SENSOR_MESSAGES).toEqual({ authentic: false, standard: true, relaxed: true });
    expect(KILL_MESSAGES).toEqual({ authentic: false, standard: false, relaxed: true });
    expect(Object.values(RANGE_CALLS).every(Boolean)).toBe(true);
  });
});
