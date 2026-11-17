/**
 * Stores sandbox (STORES-VIEW module, dev only): `?sandbox=stores&scene=<name>`
 *
 *   scene=rockets   chase view: a ripple of seven rockets from station 2 (`&wp=1`: M156 smoke)
 *   scene=mk82      a Mk-82 released onto a vehicle group (`&dist=`: camera to the burst, 500)
 *   scene=wp        a white-phosphorus mark (`&dist=3000`; `__A10_FX__.warm(120)`: 2 min later)
 *   scene=maverick  a Maverick from station 3 onto a tank 2.5 km ahead (`&at=launch|impact`)
 *   scene=ballute   a Mk-82 AIR high-drag release, the camera beside the bomb
 *   scene=pylons    the loaded aircraft close up (`&fired=n` rockets gone from the pod)
 *
 * The real views draw it (AircraftView with its stations, the stores in flight, the effects, the
 * vehicles), fed by a scripted simulation on flat ground (effectsKit). The bodies fly a TOY model
 * here — gravity, a drag constant, a Mk 66 thrust, a pursuit-guided Maverick — because the look is
 * what this sandbox shows; the weapons module's own physics is tested in its unit tests.
 * `window.__A10_STORES__ = { run(scene), state() }` drives it from scripts.
 */
import { useEffect, useMemo, useState } from 'react';
import { Quaternion, Vector3, type PerspectiveCamera } from 'three';
import { getAircraftTemplates, loadAircraftModels, storeMount } from '../../assets';
import { SIM_DT } from '../../core/constants';
import type { Vehicle } from '../../core/targets/types';
import type { SimEvent } from '../../core/types';
import type { StoreBody, StoreBodyKind, StoreType } from '../../core/weapons/types';
import { A10_GEOMETRY } from '../../data/geometry';
import { useA10Store } from '../../state/store';
import AircraftView from '../../view/aircraft/AircraftView';
import { fxRandom } from '../../view/effects/noise';
import {
  KitStage,
  SandboxWorld,
  numParam,
  params,
  useSandboxQuality,
  vecParam,
  type CameraPose,
} from './effectsKit';

type SceneId = 'rockets' | 'mk82' | 'wp' | 'maverick' | 'ballute' | 'pylons';
const SCENES: SceneId[] = ['rockets', 'mk82', 'wp', 'maverick', 'ballute', 'pylons'];

const SPEED = 150; // m/s, ≈290 kn
const G = 9.81;

interface Toy {
  body: StoreBody;
  /** Drag constant, 1/m (a = −k·|v|·v). */
  k: number;
  /** Mk 66 or Maverick thrust profile. */
  thrust: (t: number) => number;
  mass: number;
  charge: number;
  detKind: Extract<SimEvent, { type: 'detonation' }>['kind'];
  target: Vehicle | null;
  /** Mk 82 AIR: ballute open from this time after release (−1 none). */
  balluteAt: number;
}

const _q = new Quaternion();
const _v = new Vector3();
const _p = new Vector3();

function v3(p: Vector3): { x: number; y: number; z: number } {
  return { x: p.x, y: p.y, z: p.z };
}

/** The scripted flight: the aircraft flies north (−Z) level; stores leave it and fly the toy model. */
class StoresScene {
  readonly world = new SandboxWorld();
  readonly toys: Toy[] = [];
  readonly tanks: Vehicle[] = [];
  /** Scripted actions: run when the scene's time reaches `at`. */
  private readonly timers: { at: number; fn: () => void }[] = [];
  /** World time the current scene started at. */
  start = 0;
  /** Detonations so far in this scene, and the scene time of the last one. */
  impacts = 0;
  lastImpact = -1;
  scene: SceneId = 'rockets';
  altitude = 600;
  targetZ = -2500;

  constructor() {
    const w = this.world;
    // a vehicle group 2.5 km ahead of the start
    this.tanks.push(w.addVehicle('mbt', 0, this.targetZ, 200));
    this.tanks.push(w.addVehicle('mbt', 22, this.targetZ + 30, 210));
    this.tanks.push(w.addVehicle('truckCargo', -30, this.targetZ - 12, 120));
    this.tanks.push(w.addVehicle('ifv', 35, this.targetZ - 40, 190));
    for (const v of this.tanks) v.engineOn = true;
    w.onStep = (_world, dt) => this.step(dt);
    this.reset('rockets');
  }

  /** Back to the start of a scene: the loadout on the stations, the aircraft at its start. */
  reset(scene: SceneId): void {
    this.scene = scene;
    const sim = this.world.sim;
    this.start = this.world.time;
    this.impacts = 0;
    this.lastImpact = -1;
    this.world.clearQueue();
    this.timers.length = 0;
    this.toys.length = 0;
    sim.projectiles.bodies.length = 0;
    // tank hunter, with a Mk 82 AIR on station 7 and HE or smoke rockets as asked
    const pod: StoreType = params.get('wp') === '1' || scene === 'wp' ? 'LAU-131-M156' : 'LAU-131-M151';
    const load: Record<number, { rack: StoreType | null; stores: StoreType[] }> = {
      2: { rack: null, stores: [pod] },
      3: { rack: 'LAU-88', stores: ['AGM-65D', 'AGM-65D'] },
      4: { rack: null, stores: ['GBU-12'] },
      5: { rack: null, stores: ['MK-82'] },
      7: { rack: null, stores: ['MK-82AIR'] },
      8: { rack: null, stores: ['GBU-12'] },
      9: { rack: 'LAU-88', stores: ['AGM-65H', 'AGM-65H'] },
      10: { rack: null, stores: ['AN/AAQ-28'] },
      11: { rack: 'LAU-114', stores: ['AIM-9M', 'AIM-9M'] },
      1: { rack: null, stores: ['AN/ALQ-184'] },
    };
    for (const st of sim.stores.stations) {
      const l = load[st.station];
      st.rack = l?.rack ?? null;
      st.stores = l ? [...l.stores] : [];
      st.rockets = l && l.stores[0] === pod ? 7 : undefined;
    }
    const ac = sim.aircraft;
    // rockets: a 15° dive from 1.8 km at the target; a Mk-82 level from 900 m, released so the
    // fall (≈13.5 s, ≈2 km forward) ends at the group; a Maverick from 2.5 km
    const dive = scene === 'rockets' || scene === 'wp' ? (15 * Math.PI) / 180 : 0;
    this.altitude = scene === 'mk82' ? 900 : scene === 'ballute' ? 150 : dive > 0 ? 480 : 600;
    const startZ =
      scene === 'maverick'
        ? 0
        : scene === 'mk82'
          ? this.targetZ + 1990
          : dive > 0
            ? this.targetZ + this.altitude / Math.tan(dive)
            : 500;
    ac.position.set(0, this.altitude, startZ);
    ac.prevPosition.copy(ac.position);
    ac.velocity.set(0, -Math.sin(dive) * SPEED, -Math.cos(dive) * SPEED);
    ac.orientation.setFromAxisAngle(_v.set(1, 0, 0), -dive);
    ac.prevOrientation.copy(ac.orientation);
    for (const v of this.tanks) {
      v.condition = 'intact';
      v.fire = 0;
      v.thrownTurret = null;
      v.mobilityKill = false;
    }
  }

  /** Where station `s`'s store `index` (or a rocket tube) is now, world. */
  private mountWorld(s: number, rack: StoreType | null, stores: StoreType[], index: number, out: Vector3): void {
    const t = getAircraftTemplates();
    const ac = this.world.sim.aircraft;
    if (!t || !storeMount(t, s, rack, stores, index, out, _q)) {
      const g = A10_GEOMETRY.stations[s];
      out.set(g?.x ?? 0, (g?.y ?? -0.8) - 0.3, g?.z ?? 0);
    }
    out.applyQuaternion(ac.orientation).add(ac.position);
  }

  /** Release one store (or one rocket) from station `s`, as the weapons module would. */
  release(s: number, opts: { highDrag?: boolean; target?: Vehicle | null } = {}): StoreBody | null {
    const sim = this.world.sim;
    const st = sim.stores.stations[s - 1];
    const type = st.stores[0];
    if (!type) return null;
    const rocket = st.rockets !== undefined;
    if (rocket && !(st.rockets! > 0)) return null;
    const missile = type.startsWith('AGM-65');
    const kind: StoreBodyKind = rocket ? 'rocket' : missile ? 'missile' : 'bomb';
    const ac = sim.aircraft;
    const p = new Vector3();
    this.mountWorld(s, st.rack, st.stores, 0, p);
    if (rocket) {
      // from the pod's tube (the stores view blends from the exact tube)
      p.set(A10_GEOMETRY.stations[s]!.x, -0.95, -0.2).applyQuaternion(ac.orientation).add(ac.position);
      st.rockets = st.rockets! - 1;
    } else st.stores.shift();
    const v = ac.velocity.clone();
    if (!rocket && !missile) v.y -= 1.6; // the ejector
    const id = sim.projectiles.nextBodyId++;
    const body = {
      id,
      type,
      kind,
      alive: true,
      station: s,
      releaseTime: sim.time,
      position: p.clone(),
      velocity: v,
      orientation: ac.orientation.clone(),
      prevPosition: p.clone(),
      prevOrientation: ac.orientation.clone(),
      motorTime: rocket ? 1.07 : missile ? 4.5 : 0,
      armed: false,
      data: {},
      delivery: rocket ? 'ROCKET' : missile ? 'MAV' : 'CCIP',
      aim: new Vector3(),
      aimValid: false,
      highDrag: false,
      armingTime: 0,
      laserCode: 1688,
      guidance: { mode: 'NONE', vehicleId: -1, point: new Vector3(), valid: false },
      record: -1,
    } satisfies Partial<StoreBody>;
    const b = body as unknown as StoreBody;
    sim.projectiles.bodies.push(b);
    const wp = type.endsWith('M156');
    this.toys.push({
      body: b,
      k: rocket ? 2.4e-4 : missile ? 1.2e-4 : 4.5e-5,
      thrust: rocket
        ? (t) => (t < 1.07 ? 5900 : 0)
        : missile
          ? (t) => (t < 1.2 ? 21000 : t < 4.5 ? 4200 : 0)
          : () => 0,
      mass: rocket ? 10.6 : missile ? 218 : 241,
      charge: rocket ? (wp ? 0.25 : 1.3) : missile ? 12 : 96,
      detKind: rocket ? (wp ? 'whitePhosphorus' : 'rocket') : missile ? 'missile' : 'bomb',
      target: opts.target ?? null,
      balluteAt: opts.highDrag ? 0.3 : -1,
    });
    const events: SimEvent[] = [{ type: 'storeReleased', t: 0, station: s, store: type, bodyId: id }];
    if (rocket || missile) events.push({ type: 'motorIgnition', t: 0, bodyId: id });
    for (const e of events) this.world.schedule(0, e);
    return b;
  }

  /** Run `fn` when the scene's time has advanced `delay` seconds (frame accurate). */
  after(delay: number, fn: () => void): void {
    this.timers.push({ at: this.world.time + delay, fn });
  }

  /** Every frame: the scripted actions, then fly the aircraft and the stores (1/120 s steps). */
  private step(dt: number): void {
    const sim = this.world.sim;
    for (let i = 0; i < this.timers.length; ) {
      if (this.timers[i].at <= sim.time + dt) {
        const t = this.timers.splice(i, 1)[0];
        t.fn();
      } else i++;
    }
    const n = Math.max(1, Math.round(dt / SIM_DT));
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      const ac = sim.aircraft;
      ac.prevPosition.copy(ac.position);
      ac.prevOrientation.copy(ac.orientation);
      ac.position.addScaledVector(ac.velocity, h);
      const t = sim.time + (k + 1) * h;
      for (let i = this.toys.length - 1; i >= 0; i--) this.fly(this.toys[i], i, h, t);
    }
    // thrown turrets fly until they land
    for (const v of sim.targets.vehicles) {
      const tt = v.thrownTurret;
      if (!tt || tt.velocity.lengthSq() === 0) continue;
      tt.velocity.y -= G * dt;
      tt.position.addScaledVector(tt.velocity, dt);
      tt.angle.addScaledVector(tt.spin, dt);
      if (tt.position.y < 0.6) {
        tt.position.y = 0.6;
        tt.velocity.set(0, 0, 0);
        tt.angle.x = 0.25;
      }
    }
  }

  private fly(toy: Toy, index: number, h: number, t: number): void {
    const b = toy.body;
    const age = t - b.releaseTime;
    b.prevPosition.copy(b.position);
    b.prevOrientation.copy(b.orientation);
    const v = b.velocity;
    const speed = v.length();
    let k = toy.k;
    if (toy.balluteAt >= 0 && age >= toy.balluteAt) {
      b.highDrag = true;
      k = 1.5e-3;
    }
    // thrust along the body axis, drag, gravity
    _v.set(0, 0, -1).applyQuaternion(b.orientation);
    const a = toy.thrust(age) / toy.mass;
    v.addScaledVector(_v, a * h);
    v.addScaledVector(v, -k * speed * h);
    v.y -= G * h;
    if (toy.target && b.kind === 'missile') {
      // pursuit: turn the velocity toward the target within 15 g
      _p.set(toy.target.position.x, toy.target.position.y + 1.2, toy.target.position.z).sub(b.position);
      const want = _p.normalize().multiplyScalar(v.length());
      const turn = want.sub(v);
      const max = 15 * G * h;
      if (turn.length() > max) turn.setLength(max);
      v.add(turn);
    }
    b.position.addScaledVector(v, h);
    b.motorTime = Math.max(0, b.motorTime - h);
    // the body follows the relative wind
    if (v.lengthSq() > 1) {
      _p.copy(v).normalize();
      b.orientation.setFromUnitVectors(_v.set(0, 0, -1), _p);
    }
    // impact: the ground, or within 2 m of the target
    const hitTarget =
      toy.target &&
      b.position.distanceTo(_p.set(toy.target.position.x, 1.2, toy.target.position.z)) < 2.5;
    if (b.position.y <= 0 || hitTarget) {
      b.position.y = Math.max(0, b.position.y);
      this.detonate(toy, index, hitTarget ? toy.target : null);
    }
  }

  private detonate(toy: Toy, index: number, onVehicle: Vehicle | null): void {
    const b = toy.body;
    const sim = this.world.sim;
    b.alive = false;
    this.impacts++;
    this.lastImpact = this.world.time - this.start;
    const i = sim.projectiles.bodies.indexOf(b);
    if (i >= 0) sim.projectiles.bodies.splice(i, 1);
    this.toys.splice(index, 1);
    const p = b.position.clone();
    // the nearest vehicle within a few metres takes the hit
    let hit: Vehicle | null = onVehicle;
    for (const v of this.tanks) {
      if (!hit && Math.hypot(v.position.x - p.x, v.position.z - p.z) < 3) hit = v;
    }
    this.world.schedule(0, {
      type: 'detonation',
      t: 0,
      position: v3(p),
      charge: toy.charge,
      kind: toy.detKind,
      vehicleId: hit ? hit.id : 0,
      surface: 'field',
      bodyId: b.id,
    });
    if (hit && toy.detKind === 'missile') this.kill(hit, true);
    // a bomb's blast destroys what is close
    if (toy.detKind === 'bomb') {
      for (const v of this.tanks) {
        const d = Math.hypot(v.position.x - p.x, v.position.z - p.z);
        if (d < (v.kind === 'mbt' ? 6 : 25)) this.kill(v, false);
      }
    }
  }

  /** Stage a kill as the targets module reports one (state and events). */
  kill(v: Vehicle, catastrophic: boolean): void {
    if (v.condition === 'destroyed' || v.condition === 'catastrophic') return;
    v.condition = catastrophic ? 'catastrophic' : 'destroyed';
    v.conditionTime = this.world.time;
    v.fire = catastrophic ? 1 : 0.7;
    v.engineOn = false;
    v.mobilityKill = true;
    if (catastrophic && v.kind === 'mbt') {
      v.thrownTurret = {
        position: new Vector3(v.position.x, 2.4, v.position.z),
        velocity: new Vector3(fxRandom.signed(4), 16, fxRandom.signed(4)),
        spin: new Vector3(fxRandom.signed(2), fxRandom.signed(3), fxRandom.signed(2)),
        angle: new Vector3(0, -v.heading, 0),
      };
    }
    this.world.schedule(0, {
      type: 'vehicleDestroyed',
      t: 0,
      vehicleId: v.id,
      vehicleKind: v.kind,
      catastrophic,
      position: v3(v.position),
    });
    if (catastrophic)
      this.world.schedule(0, {
        type: 'detonation',
        t: 0,
        position: { x: v.position.x, y: v.position.y + 1.2, z: v.position.z },
        charge: 28,
        kind: 'secondary',
        vehicleId: v.id,
        surface: 'field',
      });
  }

  /** The scripted action of the current scene. */
  play(): void {
    const s = this.scene;
    if (s === 'rockets' || s === 'wp') {
      // a ripple: one rocket every 90 ms
      for (let k = 0; k < 7; k++) this.after(0.4 + k * 0.09, () => this.release(2));
    } else if (s === 'mk82') {
      this.after(0.3, () => this.release(5));
    } else if (s === 'ballute') {
      this.after(0.3, () => this.release(7, { highDrag: true }));
    } else if (s === 'maverick') {
      this.after(0.5, () => this.release(3, { target: this.tanks[0] }));
    }
  }
}

const CHASE = new Vector3(14, 6, 32);

export default function StoresSandbox() {
  useSandboxQuality();
  const first = (params.get('scene') as SceneId | null) ?? 'rockets';
  const [scene, setScene] = useState<SceneId>(SCENES.includes(first) ? first : 'rockets');
  const [ready, setReady] = useState(false);
  const stage = useMemo(() => new StoresScene(), []);
  const dist = numParam('dist', 500);
  const at = params.get('at') ?? 'launch';

  useEffect(() => {
    const store = useA10Store.getState();
    const before = store.view;
    store.setView('chase');
    loadAircraftModels().then(() => setReady(true), (e: unknown) => console.error(e));
    return () => useA10Store.getState().setView(before);
  }, []);

  useEffect(() => {
    if (!ready) return;
    stage.reset(scene);
    if (scene === 'pylons') {
      const st = stage.world.sim.stores.stations[1];
      st.rockets = Math.max(0, 7 - numParam('fired', 0));
    } else stage.play();
    const hook = {
      run: (s: SceneId) => {
        setScene(s);
        stage.reset(s);
        stage.play();
      },
      /** Freeze the scene (screenshots): the effects and the sim stop where they are. */
      pause: () => {
        stage.world.timeScale = 0;
      },
      resume: () => {
        stage.world.timeScale = 1;
      },
      state: () => ({
        time: stage.world.time - stage.start,
        bodies: stage.world.sim.projectiles.bodies.length,
        impacts: stage.impacts,
        lastImpact: stage.lastImpact,
        aircraft: v3(stage.world.sim.aircraft.position),
      }),
    };
    (window as unknown as { __A10_STORES__?: typeof hook }).__A10_STORES__ = hook;
  }, [ready, scene, stage]);

  const pose = useMemo<CameraPose>(() => {
    const tz = stage.targetZ;
    if (scene === 'mk82' || scene === 'wp')
      return {
        position: [dist * 0.55, Math.max(60, dist * 0.32), tz + dist * 0.78],
        target: [0, 20, tz],
        fov: 50,
      };
    if (scene === 'maverick' && at === 'impact')
      return { position: [70, 25, tz + 90], target: [0, 3, tz], fov: 50 };
    return { position: [20, 610, 540], target: [0, 600, 500], fov: 50 };
  }, [scene, dist, at, stage]);

  const follow = useMemo(() => {
    if (scene === 'rockets' || scene === 'pylons' || (scene === 'maverick' && at !== 'impact')) {
      // `&cam=` and `&look=`: the camera and its aim point in the aircraft's body frame
      const camBody = vecParam('cam');
      const lookBody = vecParam('look');
      const off = new Vector3();
      const look = new Vector3();
      return (cam: PerspectiveCamera) => {
        const ac = stage.world.sim.aircraft;
        if (camBody) off.set(...camBody);
        else if (scene === 'pylons') off.set(-9, -1.5, -7);
        else off.copy(CHASE);
        if (lookBody) look.set(...lookBody);
        else look.set(scene === 'pylons' ? -2 : 0, -1, scene === 'pylons' ? 0 : -40);
        cam.position.copy(off).applyQuaternion(ac.orientation).add(ac.position);
        cam.up.set(0, 1, 0).applyQuaternion(ac.orientation);
        cam.lookAt(look.applyQuaternion(ac.orientation).add(ac.position));
        return true;
      };
    }
    if (scene === 'ballute') {
      return (cam: PerspectiveCamera) => {
        const b = stage.world.sim.projectiles.bodies[0];
        const ac = stage.world.sim.aircraft;
        const p = b ? b.position : ac.position;
        cam.position.set(p.x + 12, p.y + 2, p.z + 6);
        cam.lookAt(p.x, p.y, p.z);
        return true;
      };
    }
    return undefined;
  }, [scene, at, stage]);

  const overlay = (
    <div
      style={{
        position: 'fixed',
        top: 8,
        left: 8,
        display: 'flex',
        gap: 6,
        font: '12px system-ui',
        color: '#eee',
      }}
    >
      {SCENES.map((s) => (
        <button
          key={s}
          onClick={() => {
            setScene(s);
            stage.reset(s);
            stage.play();
          }}
          style={{ padding: '4px 8px', background: s === scene ? '#556' : '#223', color: '#eee' }}
        >
          {s}
        </button>
      ))}
    </div>
  );

  return (
    <KitStage world={stage.world} pose={pose} follow={follow} overlay={overlay}>
      <AircraftView />
    </KitStage>
  );
}

