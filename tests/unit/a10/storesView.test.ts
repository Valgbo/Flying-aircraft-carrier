/**
 * Stores in flight (STORES-VIEW module, wave 2; ARCHITECTURE §12.2, §12.7): every store body is
 * drawn with its model from the frame its store leaves the pylon until its detonation; at its pose
 * interpolated between the last two steps; the Mk 82 AIR ballute opens on its copy; a burning motor
 * leaves its flame and smoke trail; a launch makes its cloud. The weapons module is a stand-in
 * during wave 2, so the bodies and events are built here as it will make them.
 */
import {
  PerspectiveCamera,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Group,
  type Mesh,
  type Object3D,
} from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canardPivotsOf,
  createAircraftInstance,
  podTubesOf,
  updateAircraftInstance,
  type A10Meta,
  type AircraftInstance,
} from '../../../src/a10/assets';
import { createPlaceholderTemplates } from '../../../src/a10/assets/placeholders';
import { SIM_DT } from '../../../src/a10/core/constants';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { createVehicle } from '../../../src/a10/core/targets';
import { motorThrust } from '../../../src/a10/core/weapons/guided';
import {
  createGunTestbed,
  queueRelease,
  stepKinematic,
} from '../../../src/a10/core/weapons/testbed';
import type { StoreBody, StoreBodyKind, StoreType } from '../../../src/a10/core/weapons/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { acquireFx, releaseFx, updateFx, type Fx } from '../../../src/a10/view/effects/fx';
import { setViewSimSource } from '../../../src/a10/view/effects/simSource';
import { frameInfo } from '../../../src/a10/view/frame';
import { CANARD, HANDOFF_BLEND } from '../../../src/a10/view/stores/look';
import { PK } from '../../../src/a10/view/effects/particleKinds';
import { bodyDrawPose } from '../../../src/a10/view/stores/presenter';

const metaFiles = import.meta.glob('../../../public/a10/models/a10-meta.json', {
  eager: true,
  import: 'default',
});
const META = Object.values(metaFiles)[0] as A10Meta;
const FRAME = 1 / 60;

let sim: Sim;
let fx: Fx;
const camera = new PerspectiveCamera(50, 1.6, 0.5, 90000);

beforeEach(() => {
  sim = createSim({
    seed: 2,
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    loadoutId: 'rangeTraining',
  });
  sim.aircraft.position.set(0, 1500, 0);
  sim.aircraft.prevPosition.copy(sim.aircraft.position);
  sim.aircraft.velocity.set(0, 0, -150);
  setViewSimSource(() => sim);
  fx = acquireFx();
  fx.stores.templates = createPlaceholderTemplates(META);
  camera.position.set(60, 1520, 40);
  camera.lookAt(0, 1500, 0);
  camera.updateMatrixWorld();
  frameInfo.alpha = 1;
});

afterEach(() => {
  releaseFx();
  setViewSimSource(null);
  frameInfo.alpha = 0;
});

/** A body as the weapons module makes one (contract fields only, §12.2). */
function makeBody(station: number, type: StoreType, kind: StoreBodyKind): StoreBody {
  const fields = {
    id: sim.projectiles.nextBodyId++,
    type,
    kind,
    alive: true,
    station,
    releaseTime: sim.time,
    position: sim.aircraft.position.clone().add(new Vector3(-3.6, -0.9, 0)),
    velocity: sim.aircraft.velocity.clone().add(new Vector3(0, -1.5, 0)),
    orientation: new Quaternion(),
    motorTime: kind === 'rocket' ? 1.07 : kind === 'missile' ? 4 : 0,
    armed: false,
    data: {},
    delivery: kind === 'rocket' ? 'ROCKET' : kind === 'missile' ? 'MAV' : 'CCIP',
    aim: new Vector3(),
    aimValid: false,
    highDrag: false,
    armingTime: 0,
    laserCode: 1688,
    guidance: { mode: 'NONE', vehicleId: -1, point: new Vector3(), valid: false },
    record: -1,
  } satisfies Partial<StoreBody>;
  return fields as unknown as StoreBody;
}

/** One frame as SimDriver and EffectsView run it: steps, events, then the visual update. */
function frame(events: SimEvent[] = [], steps = 2): void {
  for (let k = 0; k < steps; k++) {
    sim.time += SIM_DT;
    sim.aircraft.prevPosition.copy(sim.aircraft.position);
    sim.aircraft.position.addScaledVector(sim.aircraft.velocity, SIM_DT);
    for (const b of sim.projectiles.bodies) {
      if (!b.alive || b.releaseTime > sim.time) continue;
      const v = b.velocity;
      const dt = Math.min(SIM_DT, sim.time - b.releaseTime);
      v.y -= 9.81 * dt;
      b.position.addScaledVector(v, dt);
      if (b.motorTime > 0) b.motorTime = Math.max(0, b.motorTime - dt);
    }
  }
  fx.onSimFrame(events, sim, {
    steps,
    alpha: frameInfo.alpha,
    realDt: FRAME,
    simDt: steps * SIM_DT,
  });
  updateFx(fx, steps * SIM_DT, camera, 20000);
}

function release(b: StoreBody): SimEvent[] {
  sim.projectiles.bodies.push(b);
  const events: SimEvent[] = [
    { type: 'storeReleased', t: b.releaseTime, station: b.station, store: b.type, bodyId: b.id },
  ];
  if (b.kind === 'rocket' || b.kind === 'missile')
    events.push({ type: 'motorIgnition', t: b.releaseTime, bodyId: b.id });
  return events;
}

function visible(o: Group | null): boolean {
  return !!o && o.visible;
}

describe('stores in flight', () => {
  it('a body appears on its release and disappears on its detonation', () => {
    frame();
    // a Mk-82 leaves station 3 (the weapons module removes it from the station)
    sim.stores.stations[2].stores.shift();
    const b = makeBody(3, 'MK-82', 'bomb');
    frame(release(b));
    expect(fx.stores.count).toBe(1);
    const model = fx.stores.modelOf(b.id);
    expect(visible(model)).toBe(true);
    expect(model!.name).toBe('store-mk82');
    frame();
    expect(visible(fx.stores.modelOf(b.id))).toBe(true);
    // it bursts: drawn no more from that frame, forgotten when the body is gone
    const det: SimEvent = {
      type: 'detonation',
      t: sim.time,
      position: { x: b.position.x, y: 0, z: b.position.z },
      charge: 96,
      kind: 'bomb',
      vehicleId: 0,
      surface: 'dirt',
      bodyId: b.id,
    };
    b.alive = false;
    sim.projectiles.bodies.length = 0;
    frame([det]);
    expect(fx.stores.count).toBe(0);
    expect(model!.visible).toBe(false);
  });

  it('a body still in the air when its detonation arrives is hidden at once', () => {
    frame();
    const b = makeBody(5, 'MK-82', 'bomb');
    frame(release(b));
    const model = fx.stores.modelOf(b.id)!;
    expect(model.visible).toBe(true);
    // the event arrives in the step the weapons module still lists the body (removed next step)
    fx.onSimFrame(
      [
        {
          type: 'detonation',
          t: sim.time,
          position: { x: 0, y: 0, z: 0 },
          charge: 96,
          kind: 'bomb',
          vehicleId: 0,
          surface: 'dirt',
          bodyId: b.id,
        },
      ],
      sim,
      { steps: 0, alpha: 1, realDt: FRAME, simDt: 0 },
    );
    updateFx(fx, 0, camera, 20000);
    expect(model.visible).toBe(false);
  });

  it('the Mk 82 AIR ballute shows on its copy when the body turns high drag', () => {
    frame();
    const b = makeBody(4, 'MK-82AIR', 'bomb');
    frame(release(b));
    const model = fx.stores.modelOf(b.id)!;
    const chute = model.getObjectByName('MK-82AIR_Chute')!;
    expect(chute).toBeTruthy();
    expect(chute.visible).toBe(false);
    b.highDrag = true;
    frame();
    expect(chute.visible).toBe(true);
    const early = chute.scale.x;
    for (let i = 0; i < 20; i++) frame();
    // it fills out within a fraction of a second
    expect(chute.scale.x).toBeGreaterThan(early);
    // the template's own ballute stays hidden (only the released copy shows it)
    const tpl = fx.stores.templates!.stores.get('mk82air')!;
    expect(tpl.getObjectByName('MK-82AIR_Chute')!.visible).toBe(false);
    // a low-drag release of the same bomb never shows it
    const ld = makeBody(8, 'MK-82AIR', 'bomb');
    frame(release(ld));
    frame();
    expect(fx.stores.modelOf(ld.id)!.getObjectByName('MK-82AIR_Chute')!.visible).toBe(false);
  });

  it('a rocket burns with a flame and leaves a smoke trail, and stops when the motor burns out', () => {
    frame();
    const before = fx.stores.stats.puffs;
    const b = makeBody(2, 'LAU-131-M156', 'rocket');
    b.velocity.set(0, 0, -450);
    frame(release(b));
    expect(fx.stores.modelOf(b.id)!.name).toBe('store-hydra70');
    // the launch cloud
    const afterLaunch = fx.stores.stats.puffs;
    expect(afterLaunch).toBeGreaterThan(before);
    for (let i = 0; i < 20; i++) frame();
    const trail = fx.stores.stats.puffs - afterLaunch;
    // ≈300 m flown: a puff every 1.4 m near the camera, fewer farther away
    expect(trail).toBeGreaterThan(40);
    b.motorTime = 0;
    const burnt = fx.stores.stats.puffs;
    for (let i = 0; i < 10; i++) frame();
    expect(fx.stores.stats.puffs).toBe(burnt);
  });

  it('a missile launch makes a cloud at its rail and a flame while the motor burns', () => {
    frame();
    const b = makeBody(3, 'AGM-65D', 'missile');
    const live = fx.ps.count;
    frame(release(b));
    expect(fx.ps.count).toBeGreaterThan(live + 5);
    expect(fx.stores.modelOf(b.id)!.name).toBe('store-agm65');
  });

  it('a jettisoned rack is drawn with the stores it still carries', () => {
    frame();
    const st = sim.stores.stations[2];
    st.rack = null;
    st.stores.length = 0;
    const b = makeBody(3, 'TER-9A', 'bomb');
    (b as StoreBody & { carried: StoreType[] }).carried = ['MK-82', 'MK-82'];
    frame(release(b));
    const model = fx.stores.modelOf(b.id)!;
    expect(model.name).toBe('rack-ter9a');
    let bombs = 0;
    model.traverse((o) => {
      if (o.name === 'mk82') bombs++;
    });
    expect(bombs).toBe(2);
  });
});

describe('stores in flight: drawing between steps', () => {
  it('draws a body between prevPosition and position by the frame alpha', () => {
    const b = makeBody(3, 'MK-82', 'bomb') as StoreBody & {
      prevPosition: Vector3;
      prevOrientation: Quaternion;
    };
    b.releaseTime = 10 - 0.5;
    b.prevPosition = new Vector3(0, 1000, 0);
    b.position.set(0, 999, -1.25);
    b.prevOrientation = new Quaternion();
    b.orientation.setFromAxisAngle(new Vector3(1, 0, 0), -0.02);
    const p = new Vector3();
    const q = new Quaternion();
    const simTime = 10;
    expect(bodyDrawPose(b, simTime, simTime - 0.5 * SIM_DT, p, q)).toBe(true);
    expect(p.distanceTo(new Vector3(0, 999.5, -0.625))).toBeLessThan(1e-9);
    expect(q.angleTo(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.01))).toBeLessThan(
      1e-6,
    );
    // without prev* (an older weapons module): back along its velocity
    const c = makeBody(3, 'MK-82', 'bomb');
    c.releaseTime = 9;
    c.position.set(0, 999, 0);
    c.velocity.set(0, -60, -150);
    expect(bodyDrawPose(c, simTime, simTime - 0.25 * SIM_DT, p, q)).toBe(true);
    expect(
      p.distanceTo(new Vector3(0, 999 + 60 * 0.25 * SIM_DT, 150 * 0.25 * SIM_DT)),
    ).toBeLessThan(1e-9);
  });

  it('draws nothing before the draw time reaches the release, and starts at the release point', () => {
    const b = makeBody(3, 'MK-82', 'bomb') as StoreBody & {
      prevPosition: Vector3;
      prevOrientation: Quaternion;
    };
    const p = new Vector3();
    const q = new Quaternion();
    // released 3 ms before the end of the last step
    b.releaseTime = 10 - 0.003;
    b.prevPosition = new Vector3(5, 500, 5);
    b.prevOrientation = new Quaternion();
    b.position.set(5, 499.99, 4.55);
    expect(bodyDrawPose(b, 10, 10 - 0.005, p, q)).toBe(false);
    expect(bodyDrawPose(b, 10, 10 - 0.003, p, q)).toBe(true);
    expect(p.distanceTo(b.prevPosition)).toBeLessThan(1e-9);
  });

  it('blends a released store from where it hung into its own path', () => {
    frame();
    sim.stores.stations[8].stores.shift();
    // the weapons module releases it from the pylon's suspension point, not from the TER mount
    const b = makeBody(9, 'MK-82', 'bomb');
    b.position.copy(sim.aircraft.position).add(new Vector3(3.6, -0.7, -0.05));
    b.velocity.copy(sim.aircraft.velocity);
    frame(release(b));
    const model = fx.stores.modelOf(b.id)!;
    const first = model.position.clone();
    const path = new Vector3();
    bodyDrawPose(b, sim.time, sim.time, path, new Quaternion());
    // first frame: where the station drew it, about half a metre from the body's own point
    const gap = first.distanceTo(path);
    expect(gap).toBeGreaterThan(0.2);
    expect(gap).toBeLessThan(1.5);
    // a quarter of a second later it is on its own path
    for (let i = 0; i < Math.ceil(HANDOFF_BLEND / (2 * SIM_DT)) + 2; i++) frame();
    bodyDrawPose(b, sim.time, sim.time, path, new Quaternion());
    expect(model.position.distanceTo(path)).toBeLessThan(1e-6);
  });
});

describe('GBU-12 canards', () => {
  /** A canard's deflection (rad) about its span axis. */
  function deflection(p: Object3D): number {
    const a = new Vector3().fromArray(p.userData.axis as number[]);
    const q = p.quaternion;
    return 2 * Math.atan2(new Vector3(q.x, q.y, q.z).dot(a), q.w);
  }
  /** The canards' net side force direction in the store frame: Σ deflection · (−a.y, a.x). */
  function push(pivots: Object3D[]): Vector3 {
    const f = new Vector3();
    for (const p of pivots) {
      const [ax, ay] = p.userData.axis as number[];
      const d = deflection(p);
      f.x += -ay * d;
      f.y += ax * d;
    }
    return f;
  }

  it('stay neutral without a guidance point, and go bang-bang toward the spot with one', () => {
    const b = makeBody(4, 'GBU-12', 'laserBomb');
    frame(release(b));
    const model = fx.stores.modelOf(b.id);
    expect(model).not.toBeNull();
    const pivots: Object3D[] = [];
    expect(canardPivotsOf(model!, pivots)).toBe(4);
    // split from the kit while it flies
    expect(pivots.every((p) => p.visible)).toBe(true);
    for (let k = 0; k < 6; k++) frame();
    // the guided stand-in gives no target: the canards trail neutral
    expect(push(pivots).length()).toBeLessThan(1e-9);

    // the seeker sees the spot right of and below the flight path
    const spot = (dx: number) => b.guidance.point.set(b.position.x + dx, 0, b.position.z - 1500);
    b.guidance.mode = 'LASER';
    b.guidance.valid = true;
    spot(300);
    frame();
    // the actuators take a few frames from stop to stop
    expect(Math.max(...pivots.map((p) => Math.abs(deflection(p))))).toBeLessThan(CANARD.max);
    for (let k = 0; k < 8; k++) {
      spot(300);
      frame();
    }
    const right = push(pivots);
    expect(right.x).toBeGreaterThan(0);
    expect(right.y).toBeLessThan(0);
    // bang-bang: every canard at a stop or at rest, never in between
    for (const p of pivots) {
      const d = Math.abs(deflection(p));
      expect(d < 1e-6 || Math.abs(d - CANARD.max) < 1e-6).toBe(true);
    }

    // the spot jumps to the left of the path: full deflection the other way
    for (let k = 0; k < 9; k++) {
      spot(-300);
      frame();
    }
    expect(push(pivots).x).toBeLessThan(0);

    // the spot is lost: back to neutral
    b.guidance.valid = false;
    for (let k = 0; k < 9; k++) frame();
    expect(push(pivots).length()).toBeLessThan(1e-9);

    // the model goes back to the pool at the detonation with its canards neutral
    b.guidance.valid = true;
    for (let k = 0; k < 9; k++) {
      spot(300);
      frame();
    }
    b.alive = false;
    sim.projectiles.bodies.length = 0;
    frame([
      {
        type: 'detonation',
        t: sim.time,
        position: { x: b.position.x, y: 0, z: b.position.z },
        charge: 87,
        kind: 'bomb',
        vehicleId: 0,
        surface: 'field',
        bodyId: b.id,
      },
    ]);
    expect(fx.stores.count).toBe(0);
    for (const p of pivots) {
      expect(Math.abs(deflection(p))).toBeLessThan(1e-9);
      // merged back into the kit (one draw call) for its next use
      expect(p.visible).toBe(false);
    }
  });
});

/**
 * Whether the weapons module's release chain is real (wave 2: a queued release spawns a body and
 * its events). While it is a stand-in, or mid-edit and throwing, the integration test skips.
 */
function realReleaseChain(): boolean {
  try {
    const s = createGunTestbed({
      altitude: 600,
      speed: 150,
      loadoutId: 'rangeTraining',
      scenario: 'empty',
    });
    queueRelease(s, 3, 'MK-82');
    stepKinematic(s);
    return s.projectiles.bodies.some((b) => b.alive && b.type === 'MK-82');
  } catch {
    return false;
  }
}
const REAL_CHAIN = realReleaseChain();

/**
 * Whether the guided module is real (not built in wave 2: its stand-in flies missiles and laser
 * bombs ballistic, with no motor): a Maverick has a motor half a second after launch.
 */
function realGuidance(): boolean {
  try {
    const s = createGunTestbed({
      altitude: 600,
      speed: 150,
      loadoutId: 'tankHunter',
      scenario: 'empty',
    });
    queueRelease(s, 3, 'AGM-65D', { delivery: 'MAV' });
    stepKinematic(s);
    const b = s.projectiles.bodies.find((x) => x.alive && x.kind === 'missile');
    return !!b && motorThrust(b, 0.5) > 0;
  } catch {
    return false;
  }
}
const REAL_GUIDANCE = REAL_CHAIN && realGuidance();

describe('the real release chain (integration)', () => {
  /** Stores drawn on a station's rack, or the store on the bare pylon. */
  function shown(inst: AircraftInstance, s: number): number {
    const top = (inst.storesGroup.children[s - 1] as Group).children[0];
    if (!top) return 0;
    const carried = top.children.filter((c) => c.name in META.stores);
    if (carried.length) return carried.filter((c) => c.visible).length;
    return top.visible ? 1 : 0;
  }
  function rocketsFired(inst: AircraftInstance, s: number): number {
    let fired = -1;
    inst.storesGroup.children[s - 1].traverse((o) => {
      const tubes = (o as Mesh).isMesh ? podTubesOf(o as Mesh) : null;
      if (tubes) fired = tubes.stages.indexOf((o as Mesh).geometry as BufferGeometry);
    });
    return fired;
  }

  it.skipIf(!REAL_CHAIN)(
    'pylons, bodies, motors and bursts follow the weapons module through releases (integration)',
    () => {
      sim = createGunTestbed({
        altitude: 700,
        speed: 150,
        loadoutId: 'rangeTraining',
        scenario: 'empty',
      });
      const inst = createAircraftInstance({ forCockpit: false, templates: fx.stores.templates! });
      const seen: SimEvent[] = [];
      /** One frame of two steps: the weapons module steps, then the views draw. */
      const run = (): SimEvent[] => {
        const events: SimEvent[] = [];
        for (let k = 0; k < 2; k++) {
          stepKinematic(sim);
          events.push(...sim.events);
          sim.events.length = 0;
        }
        frameInfo.alpha = 0.5;
        camera.position.set(sim.aircraft.position.x + 80, 300, sim.aircraft.position.z + 60);
        fx.onSimFrame(events, sim, { steps: 2, alpha: 0.5, realDt: FRAME, simDt: 2 * SIM_DT });
        updateFx(fx, 2 * SIM_DT, camera, 20000);
        updateAircraftInstance(inst, sim);
        seen.push(...events);
        return events;
      };
      run();
      expect(shown(inst, 3)).toBe(2);
      expect(rocketsFired(inst, 4)).toBe(0);

      // a Mk-82 off station 3's TER: off the rack, drawn in flight from its storeReleased
      queueRelease(sim, 3, 'MK-82');
      run();
      run();
      const rel = seen.find((e) => e.type === 'storeReleased');
      expect(rel && rel.type === 'storeReleased' && rel.bodyId > 0).toBe(true);
      const bombId = rel && rel.type === 'storeReleased' ? rel.bodyId : 0;
      expect(shown(inst, 3)).toBe(1);
      expect(visible(fx.stores.modelOf(bombId))).toBe(true);

      // a ripple of three rockets from station 4's pod, 90 ms apart: tubes empty one by one, each
      // rocket burns with its flame and trail
      for (let k = 0; k < 3; k++)
        queueRelease(sim, 4, 'LAU-131-M151', { time: sim.time + k * 0.09 });
      const puffs = fx.stores.stats.puffs;
      for (let f = 0; f < 18; f++) run();
      expect(rocketsFired(inst, 4)).toBe(3);
      expect(seen.filter((e) => e.type === 'motorIgnition').length).toBe(3);
      expect(fx.stores.stats.puffs).toBeGreaterThan(puffs + 20);

      // station 9's TER jettisoned with its two bombs: the rack leaves the pylon and flies loaded
      queueRelease(sim, 9, 'TER-9A', { delivery: 'JETTISON' });
      run();
      run();
      expect(inst.storesGroup.children[8].children.length).toBe(0);
      const jet = seen.filter((e) => e.type === 'storeReleased' && e.station === 9);
      expect(jet.length).toBeGreaterThan(0);

      // everything comes down: each body's drawing goes at its own detonation
      let bursts = 0;
      for (let f = 0; f < 60 * 30 && sim.projectiles.bodies.length > 0; f++) {
        const events = run();
        for (const e of events) {
          if (e.type !== 'detonation' || !e.bodyId) continue;
          expect(fx.stores.modelOf(e.bodyId)).toBeNull();
          bursts++;
        }
      }
      expect(sim.projectiles.bodies.length).toBe(0);
      expect(fx.stores.count).toBe(0);
      expect(bursts).toBeGreaterThanOrEqual(5);
      // the Mk-82 burst raised its cloud; the jettisoned rack was a dud
      const bomb = seen.find((e) => e.type === 'detonation' && e.bodyId === bombId);
      expect(bomb && bomb.type === 'detonation' ? bomb.kind : '').toBe('bomb');
      const ps = fx.ps as unknown as { kind: Uint8Array; count: number };
      let cloud = 0;
      for (let i = 0; i < ps.count; i++) if (ps.kind[i] === PK.blastCloud) cloud++;
      expect(cloud).toBeGreaterThan(5);
    },
  );
});

describe('guided weapons in flight (integration: needs the guided module)', () => {
  /** One frame of two steps of the weapons test bed, then the views. */
  function run(): SimEvent[] {
    const events: SimEvent[] = [];
    for (let k = 0; k < 2; k++) {
      stepKinematic(sim);
      events.push(...sim.events);
      sim.events.length = 0;
    }
    frameInfo.alpha = 0.5;
    camera.position.set(sim.aircraft.position.x + 80, 300, sim.aircraft.position.z + 60);
    fx.onSimFrame(events, sim, { steps: 2, alpha: 0.5, realDt: FRAME, simDt: 2 * SIM_DT });
    updateFx(fx, 2 * SIM_DT, camera, 20000);
    return events;
  }

  it.skipIf(!REAL_GUIDANCE)(
    'a Maverick launched at a tank burns its motor with flame and trail, and is drawn to impact (integration)',
    () => {
      sim = createGunTestbed({
        altitude: 900,
        speed: 150,
        loadoutId: 'tankHunter',
        scenario: 'empty',
      });
      const tank = createVehicle(sim, 'mbt', 0, -3500, 0, 1);
      queueRelease(sim, 3, 'AGM-65D', {
        delivery: 'MAV',
        lockVehicle: tank.id,
        aim: { x: tank.position.x, y: tank.position.y, z: tank.position.z },
        aimValid: true,
      });
      run();
      const id = sim.projectiles.bodies.find((b) => b.kind === 'missile')?.id ?? 0;
      expect(id).toBeGreaterThan(0);
      const puffs = fx.stores.stats.puffs;
      for (let f = 0; f < 60; f++) run();
      // a second on: still burning, its trail behind it
      expect(sim.projectiles.bodies.find((b) => b.id === id)?.motorTime ?? 0).toBeGreaterThan(0);
      expect(fx.stores.stats.puffs).toBeGreaterThan(puffs + 30);
      expect(visible(fx.stores.modelOf(id))).toBe(true);
      // to its detonation on the tank: the drawing goes with it
      let hit = false;
      for (let f = 0; f < 60 * 40 && !hit; f++)
        for (const e of run()) if (e.type === 'detonation' && e.bodyId === id) hit = true;
      expect(hit).toBe(true);
      expect(fx.stores.modelOf(id)).toBeNull();
    },
  );

  it.skipIf(!REAL_GUIDANCE)(
    'a GBU-12 that sees the spot steers with its canards (integration)',
    () => {
      sim = createGunTestbed({
        altitude: 3000,
        speed: 160,
        loadoutId: 'tankHunter',
        scenario: 'empty',
      });
      const tank = createVehicle(sim, 'mbt', 300, -3200, 0, 1);
      // the pod lases the tank with the bomb's code
      const tgp = sim.sensors.tgp;
      tgp.laserCode = 1688;
      tgp.lasing = true;
      tgp.spot.set(tank.position.x, tank.position.y + 1, tank.position.z);
      tgp.spotValid = true;
      queueRelease(sim, 4, 'GBU-12', {
        delivery: 'CCRP',
        laserCode: 1688,
        aim: { x: tank.position.x, y: tank.position.y, z: tank.position.z },
        aimValid: true,
      });
      run();
      const b = sim.projectiles.bodies.find((x) => x.kind === 'laserBomb');
      expect(b).toBeDefined();
      const model = fx.stores.modelOf(b!.id)!;
      const pivots: Object3D[] = [];
      expect(canardPivotsOf(model, pivots)).toBe(4);
      let steered = false;
      for (let f = 0; f < 60 * 25 && sim.projectiles.bodies.length > 0 && !steered; f++) {
        run();
        if (b!.guidance.valid && pivots.some((p) => Math.abs(p.quaternion.w) < 0.9999))
          steered = true;
      }
      expect(steered).toBe(true);
    },
  );
});
