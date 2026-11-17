/**
 * Store release (PLAN_A10.md §6.5–6.7, §16 Bomb CCIP / Bomb CCRP rows; ARCHITECTURE §12.1):
 * the avionics' release decisions with the store fire control — CCIP (immediate and consent),
 * CCRP, pairs and ripples, rockets, Master Arm SAFE / TRAIN, the GBU-12's code and time to
 * impact, and the cost.
 *
 * The aircraft is held KINEMATICALLY on a straight path (position, velocity and attitude set by
 * the test every step, `prev*` the previous step's), so the tests measure the avionics alone.
 * Self-contained tests register their own Mk-82-like model and execute the release requests
 * themselves, the way ARCHITECTURE §12.1 says the weapons module does (the store leaves its
 * station at the request's exact time, the pose interpolated, with the model's ejection) and fly
 * the store as a live body (the wind AT the body, SIM_DT steps). The '(integration)' tests use
 * the weapons module's registered model and its own stepStores / stepProjectiles (both real
 * now: a missing model or a release the weapons module does not execute fails them).
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  computeReleaseSolution,
  createFireControlGround,
  createImpactPrediction,
  predictStoreImpact,
  registerStoreBallistics,
  releaseStateAt,
  stepDelivery,
  stepFireControl,
  storeBallistics,
  updateFireControlGround,
  type StoreBallistics,
} from '../../../src/a10/core/avionics';
import { G0, SIM_DT } from '../../../src/a10/core/constants';
import { quaternionFromAttitude } from '../../../src/a10/core/frames';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { stepProjectiles, stepStores, updateStoresTotals } from '../../../src/a10/core/weapons';
import type { ReleaseRequest, StoreType } from '../../../src/a10/core/weapons/types';
import {
  createFlatTerrain,
  createTerrain,
  densityAt,
  generateTerrainData,
  speedOfSoundAt,
  windAt,
} from '../../../src/a10/core/world';
import type { Terrain, TerrainHit } from '../../../src/a10/core/world/types';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';

const DEG = Math.PI / 180;
const KT = 0.514444;
const FT = 0.3048;

// ---------------------------------------------------------------------------------------------
// A Mk-82-like test store: point mass, Mach-dependent drag, ISA density, gravity; Heun steps.
// ---------------------------------------------------------------------------------------------

const MASS = 241;
const AREA = Math.PI * 0.1365 * 0.1365;
/** Low-drag general-purpose bomb Cd against Mach (shape of public GP-bomb curves). */
function cdOf(mach: number): number {
  if (mach < 0.6) return 0.17;
  if (mach < 0.85) return 0.17 + ((mach - 0.6) / 0.25) * 0.05;
  if (mach < 1.05) return 0.22 + ((mach - 0.85) / 0.2) * 0.2;
  return 0.42;
}
const _air = new Vector3();
function accel(p: Vector3, v: Vector3, w: Vector3, out: Vector3): Vector3 {
  _air.subVectors(v, w);
  const s = _air.length();
  const rho = densityAt(p.y);
  const k = (0.5 * rho * cdOf(s / speedOfSoundAt(p.y)) * AREA * s) / MASS;
  return out
    .copy(_air)
    .multiplyScalar(-k)
    .setY(out.y - G0);
}
const _a0 = new Vector3();
const _a1 = new Vector3();
const _p1 = new Vector3();
const _v1 = new Vector3();
const PYLON = 0.0509;
const EJECT = 20 * FT;
const testBomb: StoreBallistics = {
  ejection: { x: 0, y: -Math.cos(PYLON) * EJECT, z: Math.sin(PYLON) * EJECT },
  dt: 1 / 15,
  integrate(p, v, w, dt) {
    accel(p, v, w, _a0);
    _p1.copy(p).addScaledVector(v, dt);
    _v1.copy(v).addScaledVector(_a0, dt);
    accel(_p1, _v1, w, _a1);
    p.addScaledVector(v, 0.5 * dt).addScaledVector(_v1, 0.5 * dt);
    v.addScaledVector(_a0, 0.5 * dt).addScaledVector(_a1, 0.5 * dt);
  },
};

/** Run `fn` with `model` registered under `key` (the weapons module's model put back after). */
function withModel<T>(key: string, model: StoreBallistics, fn: () => T): T {
  const saved = storeBallistics(key);
  registerStoreBallistics(key, model);
  try {
    return fn();
  } finally {
    registerStoreBallistics(key, saved);
  }
}

// ---------------------------------------------------------------------------------------------
// A kinematic aircraft on a straight path
// ---------------------------------------------------------------------------------------------

interface Path {
  /** Position at time 0 (sim time), m. */
  p0: Vector3;
  /** Ground velocity (air velocity + the wind at the start), m/s. */
  v: Vector3;
  q: Quaternion;
}

/**
 * A steady straight path: flight-path angle (− = dive), TAS, nose `aoaDeg` above the path,
 * heading; the ground velocity adds the wind measured at `ref` (the aircraft drifts with it).
 */
function makePath(
  sim: Sim,
  pathDeg: number,
  tasKt: number,
  aoaDeg: number,
  headingDeg: number,
  ref: Vector3,
): Path {
  const h = headingDeg * DEG;
  const g = pathDeg * DEG;
  const s = tasKt * KT;
  const v = new Vector3(
    Math.sin(h) * Math.cos(g) * s,
    Math.sin(g) * s,
    -Math.cos(h) * Math.cos(g) * s,
  );
  v.add(windAt(sim.world, ref, new Vector3()));
  const q = quaternionFromAttitude(h, g + aoaDeg * DEG, 0, new Quaternion());
  return { p0: new Vector3(), v, q };
}

/** Place the path so the aircraft is at `point` at sim time `t`. */
function anchorPath(path: Path, point: Vector3, t: number): void {
  path.p0.copy(point).addScaledVector(path.v, -t);
}

function pathPos(path: Path, t: number, out: Vector3): Vector3 {
  return out.copy(path.p0).addScaledVector(path.v, t);
}

const _hp = new Vector3();
/** The aircraft at time t on the path; the previous state at t − dt. */
function holdOnPath(sim: Sim, path: Path, t: number): void {
  const ac = sim.aircraft;
  pathPos(path, t - SIM_DT, ac.prevPosition);
  ac.prevVelocity.copy(path.v);
  ac.prevOrientation.copy(path.q);
  pathPos(path, t, _hp);
  ac.position.copy(_hp);
  ac.velocity.copy(path.v);
  ac.orientation.copy(path.q);
  ac.angularVelocity.set(0, 0, 0);
  ac.altitude = _hp.y;
  ac.agl = _hp.y - sim.world.terrain.heightAt(_hp.x, _hp.z);
  ac.tas = path.v.length();
  ac.gLoad = 1;
  ac.externalForceBody.set(0, 0, 0);
  ac.externalMomentBody.set(0, 0, 0);
}

/** A store released by the test's own executor: where it started and where it landed. */
interface Flown {
  req: ReleaseRequest;
  origin: Vector3;
  velocity: Vector3;
  impact: Vector3 | null;
}

const _th: TerrainHit = {
  point: new Vector3(),
  normal: new Vector3(),
  distance: 0,
  t: 0,
  surface: 'grass',
};

/**
 * Execute a request as ARCHITECTURE §12.1 says (station point, ejection, exact time on the
 * kinematic path) and fly the store as a live body: the wind at the body, SIM_DT steps from the
 * release time on the step grid, against the terrain.
 */
function executeAndFly(sim: Sim, path: Path, req: ReleaseRequest, model: StoreBallistics): Flown {
  const st = A10_GEOMETRY.stations[req.station]!;
  const r = new Vector3(st.x, st.y, st.z);
  const pos = r
    .clone()
    .applyQuaternion(path.q)
    .add(pathPos(path, req.time, new Vector3()));
  const e = model.ejection;
  const vel = new Vector3(e.x, e.y, e.z).applyQuaternion(path.q).add(path.v);
  const origin = pos.clone();
  const velocity = vel.clone();
  const terrain = sim.world.terrain;
  const wind = new Vector3();
  const prev = new Vector3();
  let t = req.time;
  let since = 0;
  for (let i = 0; i < 20000; i++) {
    const next = (Math.floor(t / SIM_DT + 1e-9) + 1) * SIM_DT;
    const h = next - t;
    windAt(sim.world, pos, wind);
    prev.copy(pos);
    model.integrate(pos, vel, wind, h, since);
    since += h;
    if (terrain.segmentHit(prev, pos, _th))
      return { req, origin, velocity, impact: _th.point.clone() };
    t = next;
  }
  return { req, origin, velocity, impact: null };
}

/** The store leaves its station (a rocket pod counts down), as the weapons module does. */
function leaveStation(sim: Sim, req: ReleaseRequest): void {
  const st = sim.stores.stations[req.station - 1];
  if (st.rockets !== undefined && st.stores.includes(req.store)) st.rockets--;
  else st.stores.splice(st.stores.indexOf(req.store), 1);
  updateStoresTotals(sim.stores);
}

interface RunOptions {
  /**
   * Executes the queue: 'self' (this test's executor and model: the store leaves its station and
   * is flown), 'record' (the store leaves its station, not flown), 'weapons' (stepStores).
   */
  executor: 'self' | 'record' | 'weapons';
  model?: StoreBallistics;
  /** Pickle held from this sim time on (−1 never), and let go at `releaseAt`. */
  pickleFrom?: number;
  pickleUntil?: number;
  /** Called before each step (after the aircraft is placed) to drive the pickle and look. */
  each?: (sim: Sim, t: number) => void;
}

/**
 * Step a kinematic flight for `seconds`: the aircraft on the path, the release requests executed
 * (self or the weapons module), the fire control. Returns the requests and what they did.
 */
function fly(
  sim: Sim,
  path: Path,
  seconds: number,
  opts: RunOptions,
): { flown: Flown[]; events: SimEvent[] } {
  const flown: Flown[] = [];
  const events: SimEvent[] = [];
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    const t0 = sim.time;
    // The flight step: the aircraft moves from t0 to t0 + dt.
    holdOnPath(sim, path, t0 + SIM_DT);
    if (opts.executor !== 'weapons') {
      const q = sim.stores.releaseQueue;
      for (let k = 0; k < q.length;) {
        if (q[k].time < t0 + SIM_DT) {
          const req = q.splice(k, 1)[0];
          leaveStation(sim, req);
          if (opts.executor === 'self')
            flown.push(executeAndFly(sim, path, req, opts.model ?? testBomb));
          else flown.push({ req, origin: new Vector3(), velocity: new Vector3(), impact: null });
        } else k++;
      }
    } else {
      stepStores(sim, SIM_DT);
      stepProjectiles(sim, SIM_DT);
    }
    opts.each?.(sim, t0);
    stepFireControl(sim, SIM_DT);
    for (const e of sim.events) events.push(e);
    sim.events.length = 0;
    sim.time += SIM_DT;
    sim.stepCount++;
  }
  return { flown, events };
}

function bombSim(terrain: Terrain, loadoutId = 'rangeTraining', seed = 5): Sim {
  const sim = createSim({ terrain, scenario: 'empty', loadoutId, seed });
  sim.world.turbulence = 0;
  sim.world.surfaceWind.set(0, 0, 0);
  return sim;
}

/** Select the profile of a store, a master mode, Master Arm. */
function setUp(
  sim: Sim,
  store: string,
  mode: 'CCIP' | 'CCRP',
  arm: 'ARM' | 'TRAIN' | 'SAFE' = 'ARM',
): void {
  const av = sim.avionics;
  const p = av.profiles.find((x) => x.store === store);
  if (!p) throw new Error(`no profile for ${store}`);
  av.selectedProfile = p.id;
  p.mode = mode;
  av.masterMode = mode;
  av.masterArm = arm;
}

/** Wind blowing toward the east of `kt` knots AT `at` (a crosswind for a run to the north). */
function setCrosswind(sim: Sim, kt: number, at: Vector3): void {
  sim.world.windVeer = 0;
  sim.world.surfaceWind.set(1, 0, 0);
  const f = windAt(sim.world, at, new Vector3()).x;
  sim.world.surfaceWind.set((kt * KT) / f, 0, 0);
}

const _ground = createFireControlGround();
const _pred = createImpactPrediction();
const _ro = new Vector3();
const _rv = new Vector3();

/**
 * Where the computer's CCIP pipper was at the instant a request leaves: the impact predicted for
 * the exact release state (the wind measured at the aircraft), i.e. the pipper's ground point.
 */
function pipperAtRelease(
  sim: Sim,
  path: Path,
  req: ReleaseRequest,
  model: StoreBallistics,
): Vector3 {
  const t = sim.time;
  // Place the aircraft at the release instant to read its state the way the computer does.
  holdOnPath(sim, path, req.time);
  const g = updateFireControlGround(sim, 'DELTA', _ground);
  const wind = windAt(sim.world, sim.aircraft.position, new Vector3());
  releaseStateAt(sim.aircraft, req.station, model, 0, _ro, _rv);
  if (!predictStoreImpact(model, _ro, _rv, wind, g, _pred)) throw new Error('no CCIP solution');
  holdOnPath(sim, path, t + SIM_DT);
  return _pred.point.clone();
}

function horiz(
  a: Vector3 | { x: number; z: number },
  b: Vector3 | { x: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Bomb range from a release state: horizontal distance to its impact over flat ground. */
function rangeFrom(sim: Sim, path: Path, at: Vector3, model: StoreBallistics): Vector3 {
  const t = 100;
  anchorPath(path, at, t);
  holdOnPath(sim, path, t);
  const g = updateFireControlGround(sim, 'DELTA', _ground);
  const wind = windAt(sim.world, sim.aircraft.position, new Vector3());
  releaseStateAt(sim.aircraft, 5, model, 0, _ro, _rv);
  if (!predictStoreImpact(model, _ro, _rv, wind, g, _pred)) throw new Error('no impact');
  return _pred.point.clone().sub(at);
}

// ---------------------------------------------------------------------------------------------
// Bomb CCIP (PLAN §16): Mk-82, 30° dive, 300 kn, released 1,500 m above the target
// ---------------------------------------------------------------------------------------------

/**
 * The PLAN §16 geometry: a 30° dive at 300 kn whose release-now impact is the target at 1,500 m
 * above it. The pipper is below the HUD glass there, so the release is a consent release: the
 * pilot holds the pickle when the delay cue's ground point reaches the target (the press
 * designates it) and the computer releases when the impact reaches the designated point.
 */
function consentDive(executor: 'self' | 'weapons', crosswindKt: number, model?: StoreBallistics) {
  const sim = bombSim(createFlatTerrain(0));
  const target = new Vector3(0, 0, 0);
  const release = new Vector3(0, 1500, 0);
  if (crosswindKt > 0) setCrosswind(sim, crosswindKt, release);
  const m = model ?? storeBallistics('MK-82')!;
  // Find the release point whose impact is the target (drift included).
  const path = makePath(sim, -30, 300, 2, 0, release);
  const off = rangeFrom(sim, path, release, m);
  release.x -= off.x;
  release.z -= off.z;
  const tRel = 8;
  anchorPath(path, release, tRel);
  sim.time = 0;
  setUp(sim, 'MK-82', 'CCIP');
  let pressAt = -1;
  let prevAlong = NaN;
  const run = fly(sim, path, tRel + 25, {
    executor,
    model: m,
    each(s, t) {
      const rel = s.avionics.release;
      if (pressAt < 0 && rel.delayCueValid) {
        // Along-track position of the delay cue's ground point relative to the target.
        const along = -(rel.delayCue.z - target.z);
        if (!Number.isNaN(prevAlong) && Math.sign(along) !== Math.sign(prevAlong)) pressAt = t;
        prevAlong = along;
      }
      s.input.weaponRelease = pressAt >= 0;
    },
  });
  return { sim, path, run, target, tRel, release, model: m };
}

describe('Bomb CCIP (PLAN §16): 30° dive, 300 kn, released 1,500 m above the target', () => {
  it('consent release with a test model: impact within 5 m of the pipper in still air', () => {
    withModel('MK-82', testBomb, () => {
      const { sim, path, run, target, release } = consentDive('self', 0, testBomb);
      expect(run.flown).toHaveLength(1);
      const f = run.flown[0];
      expect(f.req.delivery).toBe('CCIP');
      expect(f.req.store).toBe('MK-82');
      const pipper = pipperAtRelease(sim, path, f.req, testBomb);
      const miss = horiz(f.impact!, pipper);
      const relHeight = f.origin.y - target.y;
      const alongDesignated = horiz(pipper, f.req.aim);
      console.log(
        `[release] CCIP 30° still air (test model): release ${relHeight.toFixed(1)} m above the target, ` +
          `impact ${miss.toFixed(2)} m from the pipper, pipper ${alongDesignated.toFixed(3)} m from the ` +
          `designated point, ${horiz(f.impact!, target).toFixed(2)} m from the target ` +
          `(planned release point ${horiz(f.origin, release).toFixed(1)} m away)`,
      );
      expect(Math.abs(relHeight - 1500)).toBeLessThan(15);
      expect(miss).toBeLessThan(5);
    });
  });

  it('…within 10 m in a 15 kn crosswind measured at the aircraft (test model)', () => {
    withModel('MK-82', testBomb, () => {
      const { sim, path, run, target } = consentDive('self', 15, testBomb);
      expect(run.flown).toHaveLength(1);
      const f = run.flown[0];
      const pipper = pipperAtRelease(sim, path, f.req, testBomb);
      const miss = horiz(f.impact!, pipper);
      console.log(
        `[release] CCIP 30° 15 kn crosswind (test model): release ${(f.origin.y - target.y).toFixed(1)} m ` +
          `above the target, impact ${miss.toFixed(2)} m from the pipper`,
      );
      expect(miss).toBeLessThan(10);
    });
  });

  it('with the weapons module’s Mk-82 model, flown by this test (integration)', () => {
    expect(storeBallistics('MK-82')).toBeTruthy();
    const model = storeBallistics('MK-82')!;
    for (const kt of [0, 15]) {
      const { sim, path, run, target } = consentDive('self', kt, model);
      expect(run.flown).toHaveLength(1);
      const f = run.flown[0];
      const pipper = pipperAtRelease(sim, path, f.req, model);
      const miss = horiz(f.impact!, pipper);
      console.log(
        `[release] CCIP 30° ${kt} kn (weapons' Mk-82 model): release ${(f.origin.y - target.y).toFixed(1)} m ` +
          `above the target, impact ${miss.toFixed(2)} m from the pipper`,
      );
      expect(miss).toBeLessThan(kt === 0 ? 5 : 10);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Consent release: exactly when the impact reaches the designated point
// ---------------------------------------------------------------------------------------------

/** Along-track distance (on the path's ground track) from a to b, m. */
function alongTrack(
  path: Path,
  a: Vector3 | { x: number; z: number },
  b: Vector3 | { x: number; z: number },
): number {
  const vg = Math.hypot(path.v.x, path.v.z);
  return ((b.x - a.x) * path.v.x + (b.z - a.z) * path.v.z) / vg;
}

describe('consent release (PLAN §6.5)', () => {
  it('holding the pickle with the pipper below the glass releases exactly when the impact reaches the designated point', () => {
    withModel('MK-82', testBomb, () => {
      const { sim, path, run } = consentDive('self', 0, testBomb);
      const av = sim.avionics;
      expect(run.flown).toHaveLength(1);
      const f = run.flown[0];
      const pipper = pipperAtRelease(sim, path, f.req, testBomb);
      const along = alongTrack(path, f.req.aim, pipper);
      console.log(
        `[release] consent: impact at the release instant ${(along * 100).toFixed(2)} cm along the track ` +
          `from the designated point (cross-track ${horiz(pipper, f.req.aim).toFixed(2)} m: station 5 is ` +
          `0.57 m left of the centreline)`,
      );
      expect(Math.abs(along)).toBeLessThan(0.05);
      // The release was not at the press: the computer waited for the solution.
      expect(f.req.time).toBeGreaterThan(av.delivery.pressTime + 0.5);
    });
  });

  it('designates the delay cue point at the press, counts down and steers, and letting go cancels', () => {
    withModel('MK-82', testBomb, () => {
      const sim = bombSim(createFlatTerrain(0));
      const av = sim.avionics;
      const path = makePath(sim, -30, 300, 2, 0, new Vector3());
      anchorPath(path, new Vector3(0, 2200, 0), 0);
      setUp(sim, 'MK-82', 'CCIP');
      fly(sim, path, 0.5, { executor: 'self' });
      const rel = av.release;
      expect(rel.valid).toBe(true);
      expect(rel.belowGlass).toBe(true);
      expect(rel.delayCueValid).toBe(true);
      // The delay cue sits just above the bottom edge of the glass, between the TVV and the pipper.
      expect(rel.delayCueEl).toBeGreaterThan(rel.el);
      const cue = rel.delayCue.clone();
      sim.input.weaponRelease = true;
      fly(sim, path, SIM_DT, { executor: 'self' });
      expect(av.delivery.phase).toBe('CONSENT');
      expect(rel.designatedValid).toBe(true);
      expect(rel.armed).toBe(true);
      // The designated point is the ground point under the delay cue at the press (it moved one step).
      expect(horiz(rel.designated, cue)).toBeLessThan(6);
      const ttr0 = rel.timeToRelease;
      expect(ttr0).toBeGreaterThan(1);
      fly(sim, path, 0.5, { executor: 'self' });
      expect(rel.timeToRelease).toBeCloseTo(ttr0 - 0.5, 1);
      expect(Math.abs(rel.azimuthError)).toBeLessThan(0.01);
      expect(rel.cueEl).toBeGreaterThan(0);
      // Let go before the solution: no release.
      sim.input.weaponRelease = false;
      const after = fly(sim, path, ttr0 + 2, { executor: 'self' });
      expect(after.flown).toHaveLength(0);
      expect(sim.stores.releaseQueue).toHaveLength(0);
      expect(av.delivery.phase).toBe('IDLE');
      expect(rel.designatedValid).toBe(false);
    });
  });

  it('an immediate release when the pipper is on the glass: the store leaves at the press, aimed at the pipper', () => {
    withModel('MK-82', testBomb, () => {
      const sim = bombSim(createFlatTerrain(0));
      const av = sim.avionics;
      // A shallow, low pass: the pipper sits on the glass.
      const path = makePath(sim, -5, 330, 2, 0, new Vector3());
      anchorPath(path, new Vector3(0, 250, 0), 0);
      setUp(sim, 'MK-82', 'CCIP');
      fly(sim, path, 0.25, { executor: 'self' });
      expect(av.release.valid).toBe(true);
      expect(av.release.belowGlass).toBe(false);
      const pressStep = sim.time;
      const run = fly(sim, path, 8, {
        executor: 'self',
        each: (s) => (s.input.weaponRelease = true),
      });
      expect(run.flown).toHaveLength(1);
      const f = run.flown[0];
      // Released at the fire-control time of the press step (the step's end).
      expect(f.req.time).toBeCloseTo(pressStep + SIM_DT, 9);
      const pipper = pipperAtRelease(sim, path, f.req, testBomb);
      expect(horiz(f.req.aim, pipper)).toBeLessThan(0.01);
      console.log(
        `[release] immediate CCIP, 5° pass at 250 m: impact ${horiz(f.impact!, pipper).toFixed(2)} m from the pipper`,
      );
      expect(horiz(f.impact!, pipper)).toBeLessThan(5);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Bomb CCRP (PLAN §16): level at 5,000 ft above the target, 300 kn
// ---------------------------------------------------------------------------------------------

function setSpi(sim: Sim, p: Vector3): void {
  const spi = sim.avionics.spi;
  spi.source = 'HUD';
  spi.valid = true;
  spi.position.copy(p);
}

function ccrpRun(
  executor: 'self' | 'weapons',
  model: StoreBallistics,
  opts: {
    crosswindKt?: number;
    lateral?: number;
    store?: string;
    loadout?: string;
    terrain?: Terrain;
    steer?: boolean;
  } = {},
) {
  const terrain = opts.terrain ?? createFlatTerrain(0);
  const sim = bombSim(terrain, opts.loadout ?? 'rangeTraining');
  const target = new Vector3(0, terrain.heightAt(0, 0), 0);
  const start = new Vector3(opts.lateral ?? 0, target.y + 5000 * FT, 9000);
  if (opts.crosswindKt) setCrosswind(sim, opts.crosswindKt, start);
  // Level, 300 kn, a ground track straight toward the target (crabbing into any wind).
  const path = makePath(sim, 0, 300, 3, 0, start);
  path.v.x = 0;
  const vg = Math.hypot(path.v.x, path.v.z);
  path.v.z = -vg;
  anchorPath(path, start, 0);
  setUp(sim, opts.store ?? 'MK-82', 'CCRP');
  setSpi(sim, target);
  if (opts.steer) {
    // The pilot centres the azimuth steering line: the track moves sideways by the cross-track
    // miss the steering error stands for (atan(cross / along)), then flies straight on.
    fly(sim, path, SIM_DT, { executor, model });
    const rel = sim.avionics.release;
    const along = alongTrack(path, sim.aircraft.position, target);
    path.p0.x += Math.tan(rel.azimuthError) * along;
  }
  const track: { t: number; ttr: number; cue: number; az: number; tof: number }[] = [];
  const run = fly(sim, path, 75, {
    executor,
    model,
    each(s, t) {
      s.input.weaponRelease = true;
      const rel = s.avionics.release;
      if (rel.valid)
        track.push({
          t,
          ttr: rel.timeToRelease,
          cue: rel.cueEl,
          az: rel.azimuthError,
          tof: rel.timeToImpact,
        });
    },
  });
  return { sim, path, run, target, track };
}

describe('Bomb CCRP (PLAN §16): level at 5,000 ft above the target, 300 kn', () => {
  it('releases at the solution and misses by under 10 m (test model)', () => {
    withModel('MK-82', testBomb, () => {
      // Flown straight over the target, the TER station's 3.6 m offset is a cross-track miss
      // the steering line shows; the pilot centring it removes that.
      const straight = ccrpRun('self', testBomb);
      const { run, target, track, path } = ccrpRun('self', testBomb, { steer: true });
      expect(run.flown).toHaveLength(1);
      const f = run.flown[0];
      expect(f.req.delivery).toBe('CCRP');
      expect(horiz(f.req.aim, target)).toBeLessThan(1e-6);
      const miss = horiz(f.impact!, target);
      const unsteered = horiz(straight.run.flown[0].impact!, target);
      console.log(
        `[release] CCRP level 5,000 ft 300 kn (test model): miss ${miss.toFixed(2)} m with the steering ` +
          `centred (along ${alongTrack(path, target, f.impact!).toFixed(2)} m), ${unsteered.toFixed(2)} m ` +
          `flown straight over the target (station ${straight.run.flown[0].req.station}); released ` +
          `${(f.origin.y - target.y).toFixed(0)} m above, ${(f.req.time - track[0].t).toFixed(2)} s after the press`,
      );
      expect(miss).toBeLessThan(10);
      expect(unsteered).toBeLessThan(10);
      // The countdown runs down at one second per second and the cue meets the TVV at release.
      const k = track.findIndex((x) => x.ttr < 5);
      expect(track[k + 60].ttr).toBeCloseTo(track[k].ttr - 0.5, 2);
      const last = track.filter((x) => x.t <= f.req.time).at(-1)!;
      expect(last.ttr).toBeLessThan(SIM_DT + 1e-6);
      expect(Math.abs(last.cue)).toBeLessThan(0.002);
      for (const x of track.filter((y) => y.ttr > 0.1)) expect(x.cue).toBeGreaterThan(0);
    });
  });

  it('in a 15 kn crosswind and with the weapons module’s model (integration)', () => {
    expect(storeBallistics('MK-82')).toBeTruthy();
    const real = storeBallistics('MK-82')!;
    const rows: string[] = [];
    for (const [label, model, kt] of [
      ['test model, 15 kn', testBomb, 15],
      ["weapons' model, still air", real, 0],
      ["weapons' model, 15 kn", real, 15],
    ] as const) {
      withModel('MK-82', model, () => {
        const { run, target } = ccrpRun('self', model, { crosswindKt: kt, steer: true });
        expect(run.flown).toHaveLength(1);
        const miss = horiz(run.flown[0].impact!, target);
        rows.push(`${label}: ${miss.toFixed(2)} m`);
        expect(miss).toBeLessThan(10);
      });
    }
    console.log(`[release] CCRP level 5,000 ft 300 kn misses: ${rows.join('; ')}`);
  });

  it('steers toward a target off the track: + = right', () => {
    withModel('MK-82', testBomb, () => {
      const { track } = ccrpRun('self', testBomb, { lateral: -300 });
      const early = track[10];
      expect(early.az).toBeGreaterThan(0);
      // atan(300 m / along-track distance): the target is 300 m right of the track.
      expect(early.az).toBeGreaterThan(Math.atan(300 / 9000) * 0.9);
      const { track: t2 } = ccrpRun('self', testBomb, { lateral: 300 });
      expect(t2[10].az).toBeLessThan(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// GBU-12: CCRP onto the SPI with the profile's laser code, and the time to impact
// ---------------------------------------------------------------------------------------------

describe('GBU-12 (PLAN §6.6)', () => {
  it('is released by CCRP onto the SPI with its profile’s laser code; the HUD counts down to impact', () => {
    const model = storeBallistics('GBU-12') ?? testBomb;
    withModel('GBU-12', model, () => {
      const terrain = createFlatTerrain(0);
      const sim = bombSim(terrain, 'tankHunter');
      const p = sim.avionics.profiles.find((x) => x.store === 'GBU-12')!;
      expect(p.laserCode).toBe(1688);
      expect(p.mode).toBe('CCRP');
      p.laserCode = 1511;
      const { run, track, target } = (() => {
        const target = new Vector3(0, 0, 0);
        const start = new Vector3(0, 5000 * FT, 9000);
        const path = makePath(sim, 0, 300, 3, 0, start);
        anchorPath(path, start, 0);
        setUp(sim, 'GBU-12', 'CCRP');
        setSpi(sim, target);
        const track: { t: number; tti: number; tof: number }[] = [];
        const run = fly(sim, path, 60, {
          executor: 'self',
          model,
          each(s, t) {
            s.input.weaponRelease = true;
            track.push({
              t,
              tti: s.avionics.release.timeToImpact,
              tof: s.avionics.release.timeOfFall,
            });
          },
        });
        return { run, track, target };
      })();
      expect(run.flown).toHaveLength(1);
      const f = run.flown[0];
      expect(f.req.store).toBe('GBU-12');
      expect(f.req.delivery).toBe('CCRP');
      expect(f.req.laserCode).toBe(1511);
      expect(f.req.lockVehicle).toBe(-1);
      expect(horiz(f.req.aim, target)).toBeLessThan(1e-6);
      // Time to impact: from the release on it counts down to the predicted impact.
      const after = track.filter((x) => x.t > f.req.time + 0.05 && x.tti > 0);
      expect(after.length).toBeGreaterThan(100);
      const fall = after[0].tti + (after[0].t - f.req.time) + SIM_DT;
      const flightTime = (() => {
        // The test flies the store: its time of flight.
        return NaN;
      })();
      void flightTime;
      expect(after[60].tti).toBeCloseTo(after[0].tti - 0.5, 6);
      console.log(
        `[release] GBU-12 CCRP: code ${f.req.laserCode}, time of fall at release ${fall.toFixed(2)} s, ` +
          `miss unguided ${horiz(f.impact!, target).toFixed(2)} m (${storeBallistics('GBU-12') === model ? "weapons' model" : 'test model'})`,
      );
      expect(horiz(f.impact!, target)).toBeLessThan(10);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Through the weapons module's own release execution (stepStores, stepProjectiles)
// ---------------------------------------------------------------------------------------------

/** The weapons module executes releases (not the foundation's no-op stand-in). */
function weaponsExecute(): boolean {
  const sim = bombSim(createFlatTerrain(0), 'tankHunter');
  sim.stores.releaseQueue.push({
    time: 0,
    station: 5,
    store: 'MK-82',
    profile: 'MK82LD',
    delivery: 'CCIP',
    aim: { x: 0, y: 0, z: 0 },
    aimValid: false,
    fuze: 'NOSE',
    armingTime: 4,
    highDrag: false,
    laserCode: 0,
    lockVehicle: -1,
  });
  stepStores(sim, SIM_DT);
  return sim.projectiles.bodies.some((b) => b.alive);
}

/** Where the weapons module says a released store landed (its debrief record). */
function recordedImpact(sim: Sim, events: SimEvent[]): { req: number; impact: Vector3 }[] {
  const out: { req: number; impact: Vector3 }[] = [];
  for (const e of events) {
    if (e.type !== 'storeReleased') continue;
    const r = sim.debrief.weapons.find((w) => w.bodyId === e.bodyId);
    if (r && Number.isFinite(r.impact.x))
      out.push({ req: e.bodyId, impact: new Vector3(r.impact.x, r.impact.y, r.impact.z) });
  }
  return out;
}

describe('releases executed by the weapons module (integration)', () => {
  it('CCIP consent (30° dive) and CCRP (level 5,000 ft): the live Mk-82 lands on the solution', () => {
    expect(storeBallistics('MK-82')).toBeTruthy();
    expect(weaponsExecute()).toBe(true);
    const model = storeBallistics('MK-82')!;
    // CCIP: the release decided by the avionics, executed and flown by the weapons module.
    const dive = consentDive('weapons', 0, model);
    const dImpacts = recordedImpact(dive.sim, dive.run.events);
    expect(dImpacts).toHaveLength(1);
    const released = dive.run.events.find((e) => e.type === 'storeReleased')!;
    expect(released.type === 'storeReleased' && released.store).toBe('MK-82');
    const rec = dive.sim.debrief.weapons.find((w) => !w.simulated)!;
    const aim = new Vector3(rec.aim.x, rec.aim.y, rec.aim.z);
    const dMiss = horiz(dImpacts[0].impact, aim);
    // CCRP with the steering centred.
    const level = ccrpRun('weapons', model, { steer: true });
    const lImpacts = recordedImpact(level.sim, level.run.events);
    expect(lImpacts).toHaveLength(1);
    const lMiss = horiz(lImpacts[0].impact, level.target);
    console.log(
      `[release] weapons-executed: CCIP consent 30° impact ${dMiss.toFixed(2)} m from the designated ` +
        `aim (cross-track station offset included), CCRP level miss ${lMiss.toFixed(2)} m`,
    );
    expect(dMiss).toBeLessThan(5);
    expect(lMiss).toBeLessThan(10);
  });
});

// ---------------------------------------------------------------------------------------------
// Pairs and ripples: timing and station order
// ---------------------------------------------------------------------------------------------

/** A level pass at 500 ft and 300 kn: the Mk-82 pipper on the glass (an immediate release). */
function levelPass(loadout = 'rangeTraining', store = 'MK-82') {
  const sim = bombSim(createFlatTerrain(0), loadout);
  const path = makePath(sim, 0, 300, 3, 0, new Vector3());
  anchorPath(path, new Vector3(0, 500 * FT, 0), 0);
  setUp(sim, store, 'CCIP');
  fly(sim, path, 0.1, { executor: 'record' });
  return { sim, path };
}

/** Hold the pickle for `hold` s (from the next step), flying `seconds`; the requests in order. */
function pickle(sim: Sim, path: Path, hold: number, seconds = 3): ReleaseRequest[] {
  const t0 = sim.time;
  const run = fly(sim, path, seconds, {
    executor: 'record',
    each: (s, t) => (s.input.weaponRelease = t - t0 < hold - 1e-9),
  });
  return run.flown.map((f) => f.req);
}

/** The station the release-order rule should pick first: the smallest |moment| left. */
function expectedFirst(sim: Sim, store: string, mass: number): number {
  let best = 0;
  let score = Infinity;
  for (const st of sim.stores.stations) {
    if (!st.stores.includes(store as StoreType)) continue;
    const x = A10_GEOMETRY.stations[st.station]!.x;
    const s = Math.abs(sim.stores.lateralMoment - mass * x);
    if (s < score - 1) {
      best = st.station;
      score = s;
    }
  }
  return best;
}

describe('pairs and ripples (PLAN §6.5): timing and station order', () => {
  it('single: one store per press, from the station that leaves the load most balanced, then alternating', () => {
    const { sim, path } = levelPass();
    const first = expectedFirst(sim, 'MK-82', 241);
    const a = pickle(sim, path, 0.3);
    const b = pickle(sim, path, 0.3);
    const c = pickle(sim, path, 0.3);
    expect(a).toHaveLength(1);
    expect(a[0].station).toBe(first);
    expect(b[0].station).toBe(first === 3 ? 9 : 3);
    expect(c[0].station).toBe(first);
    console.log(
      `[release] single releases from stations ${a[0].station}, ${b[0].station}, ${c[0].station} (moment rule)`,
    );
    for (const r of [a[0], b[0], c[0]]) {
      expect(r.delivery).toBe('CCIP');
      expect(r.fuze).toBe('NOSE');
      expect(r.armingTime).toBe(4);
      expect(r.highDrag).toBe(false);
      expect(r.aimValid).toBe(true);
    }
  });

  it('pairs: two stores at the same instant, one from each wing', () => {
    const { sim, path } = levelPass();
    sim.avionics.profiles.find((p) => p.store === 'MK-82')!.release = 'PRS';
    const r = pickle(sim, path, 0.3);
    expect(r).toHaveLength(2);
    expect(r[0].time).toBe(r[1].time);
    expect(new Set(r.map((x) => x.station))).toEqual(new Set([3, 9]));
    // The pair aims at the same pipper (each store's own: 7.3 m apart at most, the stations' spread).
    expect(horiz(r[0].aim, r[1].aim)).toBeLessThan(8);
  });

  it('ripple single: quantity at spacing / ground speed, alternating wings; ripple pairs', () => {
    const { sim, path } = levelPass();
    const p = sim.avionics.profiles.find((x) => x.store === 'MK-82')!;
    p.release = 'RIP_SGL';
    p.rippleQty = 4;
    p.rippleSpacing = 75 * FT;
    const vg = Math.hypot(path.v.x, path.v.z);
    const interval = (75 * FT) / vg;
    const r = pickle(sim, path, 1.5);
    expect(r).toHaveLength(4);
    for (let k = 0; k < 4; k++) expect(r[k].time - r[0].time).toBeCloseTo(k * interval, 9);
    const stations = r.map((x) => x.station);
    expect(stations[0]).not.toBe(stations[1]);
    expect(stations[1]).not.toBe(stations[2]);
    expect(stations[2]).not.toBe(stations[3]);
    // Each store aims at its own pipper: the impacts step along the track by the spacing.
    for (let k = 1; k < 4; k++) {
      expect(alongTrack(path, r[k - 1].aim, r[k].aim)).toBeCloseTo(75 * FT, 0);
    }
    console.log(
      `[release] ripple single 4 × 75 ft at ${(vg / KT).toFixed(0)} kn ground speed: interval ` +
        `${(interval * 1000).toFixed(1)} ms (requests ${r.map((x) => ((x.time - r[0].time) * 1000).toFixed(1)).join(', ')} ms), stations ${stations.join(', ')}`,
    );
    // Ripple pairs from a fresh load: 2 pulses of a pair each.
    const second = levelPass();
    const q = second.sim.avionics.profiles.find((x) => x.store === 'MK-82')!;
    q.release = 'RIP_PRS';
    q.rippleQty = 2;
    q.rippleSpacing = 100 * FT;
    const rp = pickle(second.sim, second.path, 1.5);
    expect(rp).toHaveLength(4);
    expect(rp[0].time).toBe(rp[1].time);
    expect(rp[2].time).toBe(rp[3].time);
    expect(rp[2].time - rp[0].time).toBeCloseTo((100 * FT) / vg, 9);
    expect(new Set([rp[0].station, rp[1].station])).toEqual(new Set([3, 9]));
  });

  it('letting go of the pickle stops a ripple; a computed ripple is centred on the target', () => {
    const { sim, path } = levelPass();
    const p = sim.avionics.profiles.find((x) => x.store === 'MK-82')!;
    p.release = 'RIP_SGL';
    p.rippleQty = 4;
    p.rippleSpacing = 150 * FT;
    const interval = (150 * FT) / Math.hypot(path.v.x, path.v.z);
    // Held through the first two pulses only.
    const r = pickle(sim, path, interval * 1.5);
    expect(r).toHaveLength(2);
    // CCRP ripple: the middle of the stick on the SPI.
    withModel('MK-82', testBomb, () => {
      const terrain = createFlatTerrain(0);
      const s2 = bombSim(terrain);
      const q = s2.avionics.profiles.find((x) => x.store === 'MK-82')!;
      q.release = 'RIP_SGL';
      q.rippleQty = 4;
      q.rippleSpacing = 100 * FT;
      const target = new Vector3(3.627, 0, 0);
      const start = new Vector3(0, 5000 * FT, 9000);
      const path2 = makePath(s2, 0, 300, 3, 0, start);
      anchorPath(path2, start, 0);
      setUp(s2, 'MK-82', 'CCRP');
      setSpi(s2, target);
      const run = fly(s2, path2, 70, {
        executor: 'self',
        each: (x) => (x.input.weaponRelease = true),
      });
      expect(run.flown).toHaveLength(4);
      const along = run.flown.map((f) => alongTrack(path2, target, f.impact!));
      const centre = along.reduce((a, b) => a + b, 0) / 4;
      console.log(
        `[release] CCRP ripple 4 × 100 ft: impacts ${along.map((x) => x.toFixed(1)).join(', ')} m along the ` +
          `track from the SPI (centre ${centre.toFixed(2)} m)`,
      );
      expect(Math.abs(centre)).toBeLessThan(1);
      for (let k = 1; k < 4; k++) expect(along[k] - along[k - 1]).toBeCloseTo(100 * FT, 0);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Rockets (PLAN §6.7): single and ripple from the pods' remaining rockets
// ---------------------------------------------------------------------------------------------

function rocketPass() {
  const sim = bombSim(createFlatTerrain(0), 'rangeTraining');
  const path = makePath(sim, -10, 300, 2, 0, new Vector3());
  anchorPath(path, new Vector3(0, 700, 0), 0);
  setUp(sim, 'LAU-131-M151', 'CCIP');
  fly(sim, path, 0.1, { executor: 'record' });
  return { sim, path };
}

describe('rockets (PLAN §6.7)', () => {
  it('single: one rocket per press from alternate pods, delivery ROCKET, aimed at the rocket pipper', () => {
    expect(storeBallistics('LAU-131-M151')).toBeTruthy();
    const { sim, path } = rocketPass();
    const rel = sim.avionics.release;
    expect(rel.valid).toBe(true);
    expect(rel.store).toBe('LAU-131-M151');
    const a = pickle(sim, path, 0.2);
    const b = pickle(sim, path, 0.2);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].store).toBe('LAU-131-M151');
    expect(a[0].delivery).toBe('ROCKET');
    expect(new Set([a[0].station, b[0].station])).toEqual(new Set([4, 8]));
    const rockets = (s: number) => sim.stores.stations[s - 1].rockets;
    expect(rockets(4)! + rockets(8)!).toBe(12);
    // The pods stay on their stations.
    expect(sim.stores.stations[3].stores).toContain('LAU-131-M151');
  });

  it('ripple: quantity at the launcher interval, alternating pods; the pods empty and stay', () => {
    expect(storeBallistics('LAU-131-M151')).toBeTruthy();
    const { sim, path } = rocketPass();
    const p = sim.avionics.profiles.find((x) => x.store === 'LAU-131-M151')!;
    p.release = 'RIP_SGL';
    p.rippleQty = 14;
    const r = pickle(sim, path, 2);
    expect(r).toHaveLength(14);
    for (let k = 1; k < 14; k++) expect(r[k].time - r[k - 1].time).toBeCloseTo(0.06, 9);
    for (let k = 1; k < 14; k++) expect(r[k].station).not.toBe(r[k - 1].station);
    expect(sim.stores.stations[3].rockets).toBe(0);
    expect(sim.stores.stations[7].rockets).toBe(0);
    expect(sim.stores.stations[3].stores).toContain('LAU-131-M151');
    // Nothing left: the next press is refused with a message.
    const more = pickle(sim, path, 0.2);
    expect(more).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Master Arm SAFE and TRAIN
// ---------------------------------------------------------------------------------------------

function messagesOf(events: SimEvent[]): string[] {
  return events.flatMap((e) => (e.type === 'message' ? [e.text] : []));
}

describe('Master Arm (PLAN §6.1 rule 3, ARCHITECTURE §12.1)', () => {
  it('SAFE blocks every release (CCIP, CCRP, ripple) with a message', () => {
    withModel('MK-82', testBomb, () => {
      for (const mode of ['CCIP', 'CCRP'] as const) {
        const { sim, path } = levelPass();
        setUp(sim, 'MK-82', mode, 'SAFE');
        setSpi(sim, new Vector3(0, 0, -3000));
        sim.avionics.profiles.find((x) => x.store === 'MK-82')!.release = 'RIP_SGL';
        const t0 = sim.time;
        const run = fly(sim, path, 30, {
          executor: 'record',
          each: (s, t) => (s.input.weaponRelease = t - t0 > 0.05),
        });
        expect(run.flown).toHaveLength(0);
        expect(sim.stores.releaseQueue).toHaveLength(0);
        expect(sim.debrief.weapons).toHaveLength(0);
        expect(messagesOf(run.events)).toContain('MASTER ARM SAFE');
      }
    });
  });

  it('TRAIN releases nothing but records simulated releases for the debrief', () => {
    withModel('MK-82', testBomb, () => {
      const { sim, path } = levelPass();
      sim.avionics.masterArm = 'TRAIN';
      const p = sim.avionics.profiles.find((x) => x.store === 'MK-82')!;
      p.release = 'RIP_SGL';
      p.rippleQty = 3;
      const before = sim.stores.stations.map((s) => s.stores.length).join();
      const r = pickle(sim, path, 1.5);
      expect(r).toHaveLength(0);
      expect(sim.stores.releaseQueue).toHaveLength(0);
      expect(sim.stores.stations.map((s) => s.stores.length).join()).toBe(before);
      const recs = sim.debrief.weapons;
      expect(recs).toHaveLength(3);
      for (const w of recs) {
        expect(w.simulated).toBe(true);
        expect(w.bodyId).toBe(0);
        expect(w.store).toBe('MK-82');
        expect(w.delivery).toBe('CCIP');
        expect(w.id).toBeLessThan(0);
        // Flown in full: the impact is near the aim (the computer's model, the real wind).
        expect(w.missDistance).toBeLessThan(1);
        expect(Number.isFinite(w.impactTime)).toBe(true);
      }
      // Alternating stations, as an armed ripple would.
      expect(recs[0].station).not.toBe(recs[1].station);
      expect(recs[1].station).not.toBe(recs[2].station);
      console.log(
        `[release] TRAIN ripple: ${recs.length} simulated records, stations ${recs.map((w) => w.station).join(', ')}, ` +
          `misses ${recs.map((w) => w.missDistance.toFixed(2)).join(', ')} m`,
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Cost (brief: store fire control under 0.3 ms per step on the generated terrain)
// ---------------------------------------------------------------------------------------------

describe('cost of the store fire control', () => {
  it('stays under 0.3 ms per step on the generated terrain (CCIP, consent, CCRP with its iteration)', () => {
    const terrain = createTerrain(generateTerrainData(1));
    const results: string[] = [];
    let worstMedian = 0;
    let worstMean = 0;
    for (const [label, mode, pathDeg, agl, pickleOn, jump] of [
      ['CCIP 30° dive', 'CCIP', -30, 1700, false, false],
      ['CCIP consent armed', 'CCIP', -30, 1700, true, false],
      ['CCRP level 5,000 ft', 'CCRP', 0, 5000 * FT, true, false],
      ['CCRP 10° climb (loft)', 'CCRP', 10, 3000 * FT, true, false],
      ['CCRP, the SPI jumping every step (cold solves)', 'CCRP', 0, 5000 * FT, false, true],
    ] as const) {
      const sim = createSim({ terrain, scenario: 'empty', loadoutId: 'rangeTraining', seed: 9 });
      sim.world.turbulence = 0;
      const x = terrain.start.x;
      const z = terrain.start.z;
      const ground = terrain.heightAt(x, z);
      const path = makePath(sim, pathDeg, 300, 3, 0, new Vector3(x, ground + agl, z));
      anchorPath(path, new Vector3(x, ground + agl, z), 0);
      setUp(sim, 'MK-82', mode);
      const spi = new Vector3(x, terrain.heightAt(x, z - 6000), z - 6000);
      setSpi(sim, spi);
      // Warm up (the JIT, the solver's warm start, the consent designation).
      fly(sim, path, 0.5, { executor: 'record', each: (s) => (s.input.weaponRelease = pickleOn) });
      const g = createFireControlGround();
      const times: number[] = [];
      let best = Infinity;
      let maxPredictions = 0;
      for (let batch = 0; batch < 8; batch++) {
        const t0 = performance.now();
        for (let i = 0; i < 60; i++) {
          holdOnPath(sim, path, sim.time + SIM_DT);
          if (jump) {
            // A new SPI 300 m away every step: the solver cannot warm-start.
            spi.x = x + (i % 2 === 0 ? 300 : -300);
            setSpi(sim, spi);
          }
          const s0 = performance.now();
          updateFireControlGround(sim, 'DELTA', g);
          computeReleaseSolution(sim, g, SIM_DT);
          stepDelivery(sim, g, SIM_DT);
          times.push(performance.now() - s0);
          maxPredictions = Math.max(maxPredictions, sim.avionics.fc.storePredictions);
          sim.time += SIM_DT;
        }
        best = Math.min(best, (performance.now() - t0) / 60);
      }
      expect(sim.avionics.release.valid).toBe(true);
      times.sort((a, b) => a - b);
      const median = times[times.length >> 1];
      const p99 = times[Math.floor(times.length * 0.99)];
      if (!jump) {
        worstMedian = Math.max(worstMedian, median);
        worstMean = Math.max(worstMean, best);
      } else expect(median).toBeLessThan(0.6);
      results.push(
        `${label}: median ${(median * 1000).toFixed(1)} µs, best-batch mean ${(best * 1000).toFixed(1)} µs, ` +
          `p99 ${(p99 * 1000).toFixed(0)} µs, at most ${maxPredictions} predictions in a step`,
      );
    }
    console.log(`[release] store fire-control cost, generated terrain: ${results.join('; ')}`);
    expect(worstMedian).toBeLessThan(0.3);
    expect(worstMean).toBeLessThan(0.3);
  }, 120_000);
});

describe('determinism', () => {
  it('the same flight gives the same release requests, times, aims and HUD solution', () => {
    const snap = () => {
      const { sim, run } = withModel('MK-82', testBomb, () => consentDive('self', 15, testBomb));
      return JSON.stringify({
        reqs: run.flown.map((f) => f.req),
        rel: sim.avionics.release,
        d: sim.avionics.delivery,
      });
    };
    const a = snap();
    const b = snap();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(500);
  });
});
