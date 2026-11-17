/**
 * Effects sandbox (VEHICLES-AND-EFFECTS MODULE): every effect on flat ground, seen from 50 m,
 * 500 m or 1,500 m, driven through the real EffectsView by hand-made simulation events.
 *
 *   /a10/?sandbox=effects
 *   /a10/?sandbox=effects&fx=burst&dist=1200&at=1.4&quality=medium     (repeatable screenshot)
 *
 * Parameters:
 *   fx=<id>        trigger an effect on load (ids in the panel, e.g. burst, api-stopped, det-mk82)
 *   dist=<m>       camera distance from the target point (default 500); elev=<deg> its elevation
 *   at=<s>         simulate this many seconds right away in 1/60 s steps, then freeze
 *   view=chase|cockpit|ground     camera for the gun run (fx=gun)
 *   surface=<kind> ground for single impacts and bursts (dirt, grass, field, sand, mud, rock,
 *                  concrete, road, forest, water)
 *   cam=x,y,z tgt=x,y,z fov=deg   override the camera
 *   windX, windZ   surface wind, m/s
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Quaternion, Vector3, type PerspectiveCamera } from 'three';
import { quaternionFromAttitude } from '../../core/frames';
import type { RoundOutcome, Vehicle } from '../../core/targets/types';
import type { SimEvent, Vec3Like } from '../../core/types';
import type { SurfaceKind } from '../../core/world/types';
import { A10_GEOMETRY } from '../../data/geometry';
import { GAU8 } from '../../data/gun';
import { getFx, updateFx } from '../../view/effects/fx';
import { fxRandom } from '../../view/effects/noise';
import {
  KitStage,
  numParam,
  params,
  SandboxWorld,
  useSandboxQuality,
  vecParam,
  type CameraPose,
} from './effectsKit';

const SURFACES: SurfaceKind[] = [
  'dirt',
  'grass',
  'field',
  'sand',
  'mud',
  'rock',
  'concrete',
  'road',
  'forest',
  'water',
];

/** Where things are: the tank at the origin, ground impacts beside it. */
const GROUND_POINT = new Vector3(-14, 0, 8);
const LOOK_AT = new Vector3(-5, 1.5, 4);

interface Scene {
  world: SandboxWorld;
  tank: Vehicle;
  ifv: Vehicle;
  fuel: Vehicle;
  ammo: Vehicle;
  hulk: Vehicle;
  /** Direction the rounds come from (unit, world, from the target toward the shooter). */
  from: Vector3;
}

const v3 = (v: Vector3): Vec3Like => ({ x: v.x, y: v.y, z: v.z });

/** Vehicle-local point (+X right, +Y up, -Z forward) → world. */
function local(v: Vehicle, x: number, y: number, z: number, out = new Vector3()): Vector3 {
  const s = Math.sin(v.heading);
  const c = Math.cos(v.heading);
  return out.set(v.position.x + x * c - z * s, v.position.y + y, v.position.z + x * s + z * c);
}

function localDir(v: Vehicle, x: number, y: number, z: number): Vector3 {
  const s = Math.sin(v.heading);
  const c = Math.cos(v.heading);
  return new Vector3(x * c - z * s, y, x * s + z * c).normalize();
}

function roundVelocity(from: Vector3, speed = 720, dive = 0.5): Vector3 {
  // from the shooter's side, coming down at `dive` rad
  const h = new Vector3(from.x, 0, from.z).normalize();
  return new Vector3(-h.x * Math.cos(dive), -Math.sin(dive), -h.z * Math.cos(dive)).multiplyScalar(
    speed,
  );
}

function groundImpact(
  t: number,
  p: Vector3,
  vel: Vector3,
  surface: SurfaceKind,
  round: 0 | 1 | 2,
  outcome: 'ground' | 'skip' | 'water' = 'ground',
): SimEvent {
  return {
    type: 'roundImpact',
    t,
    round,
    position: v3(p),
    velocity: v3(vel),
    normal: { x: 0, y: 1, z: 0 },
    target: { kind: 'ground', surface },
    outcome: surface === 'water' ? 'water' : outcome,
  };
}

function vehicleImpact(
  t: number,
  v: Vehicle,
  p: Vector3,
  n: Vector3,
  vel: Vector3,
  round: 0 | 1 | 2,
  outcome: RoundOutcome,
): SimEvent {
  return {
    type: 'roundImpact',
    t,
    round,
    position: v3(p),
    velocity: v3(vel),
    normal: v3(n),
    target: { kind: 'vehicle', vehicleId: v.id, part: 'hull' },
    outcome,
  };
}

function detonation(
  t: number,
  p: Vector3,
  charge: number,
  kind: Extract<SimEvent, { type: 'detonation' }>['kind'],
  vehicleId = 0,
  surface: SurfaceKind = 'dirt',
): SimEvent {
  return { type: 'detonation', t, position: v3(p), charge, kind, vehicleId, surface };
}

/** Throw a vehicle's turret (catastrophic kill) and let the sandbox fly it. */
function throwTurret(v: Vehicle): void {
  const top = new Vector3();
  local(v, 0, 2.2, -0.6, top);
  v.thrownTurret = {
    position: top,
    velocity: new Vector3(fxRandom.signed(4), 17, fxRandom.signed(4)),
    spin: new Vector3(fxRandom.signed(2), fxRandom.signed(3), fxRandom.signed(2)),
    angle: new Vector3(0, -v.heading, 0),
  };
}

function kill(scene: Scene, v: Vehicle, catastrophic: boolean, fire: number): void {
  const w = scene.world;
  v.condition = catastrophic ? 'catastrophic' : 'destroyed';
  v.conditionTime = w.time;
  v.fire = fire;
  v.engineOn = false;
  v.speed = 0;
  if (catastrophic && (v.kind === 'mbt' || v.kind === 'ifv' || v.kind === 'hulk')) throwTurret(v);
  w.schedule(0, {
    type: 'vehicleDestroyed',
    t: 0,
    vehicleId: v.id,
    vehicleKind: v.kind,
    catastrophic,
    position: v3(v.position),
  });
}

/** 65 rounds over one second along a line through `centre`, combat mix (5 API : 1 HEI). */
function burst(scene: Scene, centre: Vector3, surface: SurfaceKind, throughTank: boolean): void {
  const w = scene.world;
  const dirH = new Vector3(-scene.from.x, 0, -scene.from.z).normalize();
  const side = new Vector3(-dirH.z, 0, dirH.x);
  const vel = roundVelocity(scene.from, 700, 0.5);
  const tank = scene.tank;
  for (let i = 0; i < 65; i++) {
    const t = (i / 65) * 1.0;
    const along = -78 + i * 2.4;
    const p = centre
      .clone()
      .addScaledVector(dirH, along + fxRandom.gauss() * 1.6)
      .addScaledVector(side, fxRandom.gauss() * 1.7);
    p.y = 0;
    const round: 0 | 1 = i % 6 === 5 ? 1 : 0;
    if (throughTank) {
      // does the round land on the tank's footprint?
      const dx = p.x - tank.position.x;
      const dz = p.z - tank.position.z;
      const s = Math.sin(tank.heading);
      const c = Math.cos(tank.heading);
      const lx = dx * c + dz * s;
      const lz = -dx * s + dz * c;
      if (Math.abs(lx) < 1.75 && Math.abs(lz) < 3.5) {
        const top = new Vector3(p.x, 1.75, p.z);
        const n = new Vector3(0, 1, 0);
        const outcome: RoundOutcome = round === 1 ? 'burst' : lz > 0.8 ? 'penetrated' : 'stopped';
        w.schedule(t, vehicleImpact(0, tank, top, n, vel, round, outcome));
        continue;
      }
    }
    w.schedule(t, groundImpact(0, p, vel, surface, round));
  }
}

interface FxDef {
  id: string;
  label: string;
  run(scene: Scene, surface: SurfaceKind): void;
}

const FX: FxDef[] = [
  {
    id: 'api-stopped',
    label: 'API on armour (stopped)',
    run: ({ world, tank, from }) => {
      const p = local(tank, 0.35, 2.05, -1.55);
      world.schedule(
        0,
        vehicleImpact(0, tank, p, localDir(tank, 0, 0.25, -1), roundVelocity(from), 0, 'stopped'),
      );
    },
  },
  {
    id: 'api-pen',
    label: 'API on the engine deck (penetrated)',
    run: ({ world, tank, from }) => {
      const p = local(tank, 0.2, 1.73, 2.3);
      world.schedule(
        0,
        vehicleImpact(
          0,
          tank,
          p,
          new Vector3(0, 1, 0),
          roundVelocity(from, 700, 0.9),
          0,
          'penetrated',
        ),
      );
    },
  },
  {
    id: 'hei-armour',
    label: 'HEI on armour',
    run: ({ world, tank, from }) => {
      const p = local(tank, -1.0, 1.95, -0.9);
      world.schedule(
        0,
        vehicleImpact(0, tank, p, localDir(tank, -0.7, 0.4, -0.6), roundVelocity(from), 1, 'burst'),
      );
    },
  },
  {
    id: 'ricochet',
    label: 'Ricochet off the glacis',
    run: ({ world, tank, from }) => {
      const p = local(tank, 0.3, 1.25, -3.0);
      world.schedule(
        0,
        vehicleImpact(
          0,
          tank,
          p,
          localDir(tank, 0, 0.93, -0.37),
          roundVelocity(from, 760, 0.3),
          0,
          'ricochet',
        ),
      );
    },
  },
  {
    id: 'ground',
    label: 'One round on the ground',
    run: ({ world, from }, surface) =>
      world.schedule(0, groundImpact(0, GROUND_POINT, roundVelocity(from), surface, 0)),
  },
  {
    id: 'hei-ground',
    label: 'HEI on the ground',
    run: ({ world, from }, surface) =>
      world.schedule(0, groundImpact(0, GROUND_POINT, roundVelocity(from), surface, 1)),
  },
  {
    id: 'skip',
    label: 'Round skipping off concrete',
    run: ({ world, from }) =>
      world.schedule(
        0,
        groundImpact(0, GROUND_POINT, roundVelocity(from, 780, 0.1), 'concrete', 0, 'skip'),
      ),
  },
  {
    id: 'burst',
    label: '65 rounds in 1 s along a line',
    run: (scene, surface) => burst(scene, GROUND_POINT, surface, false),
  },
  {
    id: 'burst-tank',
    label: '65 rounds walking through the tank',
    run: (scene, surface) => burst(scene, scene.tank.position.clone(), surface, true),
  },
  {
    id: 'det-hei',
    label: 'Detonation: 30 mm HEI',
    run: ({ world }) => world.schedule(0, detonation(0, GROUND_POINT, 0.05, 'hei')),
  },
  {
    id: 'det-rocket',
    label: 'Detonation: rocket (M151)',
    run: ({ world }, surface) =>
      world.schedule(0, detonation(0, GROUND_POINT, 2.3, 'rocket', 0, surface)),
  },
  {
    id: 'det-maverick',
    label: 'Maverick on the tank',
    run: (scene) => {
      const p = local(scene.tank, 0, 1.8, -0.6);
      scene.world.schedule(0, detonation(0, p, 40, 'missile', scene.tank.id));
      kill(scene, scene.tank, true, 1);
    },
  },
  {
    id: 'det-mk82',
    label: 'Mk-82 bomb',
    run: ({ world }, surface) =>
      world.schedule(
        0,
        detonation(0, GROUND_POINT.clone().add(new Vector3(-20, 0, 0)), 90, 'bomb', 0, surface),
      ),
  },
  {
    id: 'det-secondary',
    label: 'Tank: catastrophic kill',
    run: (scene) => kill(scene, scene.tank, true, 1),
  },
  {
    id: 'det-fuel',
    label: 'Fuel truck explodes',
    run: (scene) => kill(scene, scene.fuel, true, 1),
  },
  {
    id: 'det-ammo',
    label: 'Ammunition truck explodes',
    run: (scene) => kill(scene, scene.ammo, true, 1),
  },
  {
    id: 'det-wp',
    label: 'White phosphorus rocket',
    run: ({ world }, surface) =>
      world.schedule(0, detonation(0, GROUND_POINT, 1.0, 'whitePhosphorus', 0, surface)),
  },
  {
    id: 'det-dud',
    label: 'Dud bomb',
    run: ({ world }, surface) =>
      world.schedule(0, detonation(0, GROUND_POINT, 90, 'dud', 0, surface)),
  },
  {
    id: 'burning',
    label: 'Burning tank (destroyed)',
    run: (scene) => kill(scene, scene.tank, false, 0.9),
  },
  {
    id: 'burning-all',
    label: 'Burning: IFV + hulk + fuel truck',
    run: (scene) => {
      kill(scene, scene.ifv, false, 0.7);
      kill(scene, scene.hulk, false, 0.4);
      kill(scene, scene.fuel, false, 1);
    },
  },
  {
    id: 'gun',
    label: 'Gun run (aircraft firing)',
    run: () => {},
  },
];

/** The scripted gun run: a 30° dive at 300 kn toward the ground point, firing 1.5 s. */
class GunRun {
  active = false;
  start = 0;
  readonly fireStart = 0.5;
  readonly fireEnd = 2.0;
  private readonly dir = new Vector3();
  private readonly startPos = new Vector3();
  private readonly q = new Quaternion();
  readonly speed = 300 * 0.514444;
  readonly dive = (30 * Math.PI) / 180;
  readonly heading = (20 * Math.PI) / 180;

  begin(world: SandboxWorld): void {
    this.active = true;
    this.start = world.time;
    quaternionFromAttitude(this.heading, -this.dive, 0, this.q);
    this.dir.set(0, 0, -1).applyQuaternion(this.q);
    // 1,900 m slant range at the start
    this.startPos.copy(GROUND_POINT).addScaledVector(this.dir, -1900);
    world.sim.aircraft.orientation.copy(this.q);
    world.sim.gun.totalFired = 0;
  }

  step(world: SandboxWorld, dt: number): void {
    if (!this.active) return;
    const sim = world.sim;
    const t = world.time + dt - this.start;
    const ac = sim.aircraft;
    ac.prevPosition.copy(ac.position);
    ac.position.copy(this.startPos).addScaledVector(this.dir, this.speed * t);
    ac.velocity.copy(this.dir).multiplyScalar(this.speed);
    ac.orientation.copy(this.q);
    const gun = sim.gun;
    const firing = t >= this.fireStart && t < this.fireEnd;
    if (firing) {
      const ft = t - this.fireStart;
      gun.spin = Math.min(1, ft / GAU8.spinUpTime);
      gun.rate = GAU8.rate * gun.spin;
      gun.firing = true;
      const before = gun.totalFired;
      gun.phase += gun.rate * dt;
      const n = Math.floor(gun.phase);
      gun.phase -= n;
      gun.totalFired += n;
      // the rounds land ≈1.3 s later along the line of fire, walking with the aircraft
      for (let i = 0; i < n; i++) {
        const k = before + i;
        const range = GROUND_POINT.distanceTo(ac.position);
        const tof = range / 820;
        const p = GROUND_POINT.clone().addScaledVector(
          new Vector3(this.dir.x, 0, this.dir.z).normalize(),
          (ft - 0.75) * 40,
        );
        p.x += fxRandom.gauss() * range * 0.0014;
        p.z += fxRandom.gauss() * range * 0.0014;
        p.y = 0;
        const vel = this.dir.clone().multiplyScalar(700);
        world.schedule(
          tof + (i / Math.max(1, n)) * dt,
          groundImpact(0, p, vel, 'dirt', k % 6 === 5 ? 1 : 0),
        );
      }
    } else {
      gun.firing = false;
      gun.rate = 0;
      gun.spin = Math.max(0, gun.spin - dt / GAU8.spinDownTime);
    }
    if (t > 9) this.active = false;
  }

  /** Camera that follows the aircraft: chase (behind, right, above) or at the cockpit eye. */
  follow(world: SandboxWorld, cam: PerspectiveCamera, view: string): boolean {
    if (!this.active && world.time - this.start > 9) return false;
    const ac = world.sim.aircraft;
    if (view === 'cockpit') {
      const e = A10_GEOMETRY.eye;
      cam.position.set(e.x, e.y, e.z).applyQuaternion(ac.orientation).add(ac.position);
      cam.quaternion.copy(ac.orientation);
      cam.fov = 62;
      return true;
    }
    if (view === 'ground') {
      cam.position.set(GROUND_POINT.x + 140, 25, GROUND_POINT.z + 160);
      cam.lookAt(
        ac.position.x * 0.3 + GROUND_POINT.x * 0.7,
        ac.position.y * 0.3,
        ac.position.z * 0.3 + GROUND_POINT.z * 0.7,
      );
      cam.fov = 55;
      return true;
    }
    const off = new Vector3(14, 6, 34).applyQuaternion(ac.orientation);
    cam.position.copy(ac.position).add(off);
    cam.lookAt(new Vector3(0, -2, -30).applyQuaternion(ac.orientation).add(ac.position));
    cam.fov = 55;
    return true;
  }
}

function poseFor(dist: number, elevDeg: number): CameraPose {
  const cam = vecParam('cam');
  const tgt = vecParam('tgt');
  const e = (elevDeg * Math.PI) / 180;
  const az = (12 * Math.PI) / 180;
  const position: [number, number, number] = cam ?? [
    LOOK_AT.x + Math.sin(az) * Math.cos(e) * dist,
    LOOK_AT.y + Math.sin(e) * dist,
    LOOK_AT.z + Math.cos(az) * Math.cos(e) * dist,
  ];
  const fov = numParam('fov', dist > 1000 ? 40 : dist > 300 ? 45 : 55);
  return { position, target: tgt ?? [LOOK_AT.x, LOOK_AT.y, LOOK_AT.z], fov };
}

const DEFAULT_ELEV: Record<number, number> = { 50: 14, 500: 22, 1500: 30 };

const panel: CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  width: 260,
  maxHeight: 'calc(100% - 16px)',
  overflowY: 'auto',
  background: 'rgba(10,14,18,0.78)',
  color: '#dde4ea',
  font: '12px/1.35 system-ui, sans-serif',
  padding: 8,
  borderRadius: 6,
};
const btn: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  margin: '2px 0',
  padding: '3px 6px',
  background: '#26313b',
  color: '#e8eef3',
  border: '1px solid #3a4a57',
  borderRadius: 4,
  cursor: 'pointer',
  font: 'inherit',
};

function Stats() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = setInterval(() => {
      const fx = getFx();
      if (ref.current && fx) {
        const s = fx.ps.stats;
        ref.current.textContent = `particles ${s.live} live · ${s.drawn} drawn · budget ${fx.ps.budget}`;
      }
    }, 250);
    return () => clearInterval(id);
  }, []);
  return <div ref={ref} style={{ marginTop: 6, color: '#9fb0bd' }} />;
}

/** Runs the URL-requested effect once and, with ?at=, pre-simulates and freezes. */
function AutoRun({
  scene,
  gunRun,
  trigger,
  view,
}: {
  scene: Scene;
  gunRun: GunRun;
  trigger: (id: string) => void;
  view: string;
}) {
  const done = useRef(false);
  useFrame((state) => {
    if (done.current) return;
    done.current = true;
    const id = params.get('fx');
    if (!id) return;
    trigger(id);
    const at = numParam('at', -1);
    if (at < 0) return;
    const fx = getFx();
    if (!fx) return;
    const dt = 1 / 60;
    const steps = Math.round(at / dt);
    const cam = state.camera as PerspectiveCamera;
    for (let i = 0; i < steps; i++) {
      scene.world.advance(dt);
      if (id === 'gun') {
        gunRun.follow(scene.world, cam, view);
        cam.updateMatrixWorld();
      }
      updateFx(fx, dt, cam);
    }
    scene.world.timeScale = 0;
  }, -90);
  return null;
}

export default function EffectsSandbox() {
  useSandboxQuality();
  const [dist, setDist] = useState(() => numParam('dist', 500));
  const [surface, setSurface] = useState<SurfaceKind>(() => {
    const s = params.get('surface') as SurfaceKind | null;
    return s && SURFACES.includes(s) ? s : 'dirt';
  });
  const view = params.get('view') ?? 'chase';
  const gunRun = useMemo(() => new GunRun(), []);
  const scene = useMemo<Scene>(() => {
    const world = new SandboxWorld();
    const tank = world.addVehicle('mbt', 0, 0, 200);
    const ifv = world.addVehicle('ifv', 16, 24, 235);
    const fuel = world.addVehicle('truckFuel', 30, -8, 100);
    const ammo = world.addVehicle('truckAmmo', -40, -18, 70);
    const hulk = world.addVehicle('hulk', -30, 30, 140);
    for (const v of [tank, ifv, fuel, ammo]) v.engineOn = true;
    const from = new Vector3(Math.sin((12 * Math.PI) / 180), 0, Math.cos((12 * Math.PI) / 180));
    world.onStep = (w, dt) => {
      gunRun.step(w, dt);
      // thrown turrets fly until they land
      for (const v of w.sim.targets.vehicles) {
        const t = v.thrownTurret;
        if (!t || t.velocity.lengthSq() === 0) continue;
        t.velocity.y -= 9.81 * dt;
        t.position.addScaledVector(t.velocity, dt);
        t.angle.addScaledVector(t.spin, dt);
        if (t.position.y < 0.6) {
          t.position.y = 0.6;
          t.velocity.set(0, 0, 0);
          t.angle.x = Math.round(t.angle.x / Math.PI) * Math.PI + 0.25;
          t.angle.z = 0.15;
        }
      }
    };
    return { world, tank, ifv, fuel, ammo, hulk, from };
  }, [gunRun]);
  const [pose, setPose] = useState<CameraPose>(() =>
    poseFor(dist, numParam('elev', DEFAULT_ELEV[dist] ?? 25)),
  );
  const [gunView, setGunView] = useState(params.get('fx') === 'gun');

  const trigger = (id: string) => {
    const def = FX.find((f) => f.id === id);
    if (!def) return;
    scene.world.timeScale = 1;
    if (id === 'gun') {
      gunRun.begin(scene.world);
      setGunView(true);
      return;
    }
    def.run(scene, surface);
  };

  const chooseDistance = (d: number) => {
    setDist(d);
    setGunView(false);
    setPose(poseFor(d, DEFAULT_ELEV[d] ?? 25));
  };

  const follow = useMemo(
    () => (gunView ? (cam: PerspectiveCamera) => gunRun.follow(scene.world, cam, view) : undefined),
    [gunView, gunRun, scene, view],
  );

  const overlay =
    params.get('ui') === '0' ? null : (
      <div style={panel}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Effects sandbox</div>
        <div>
          Distance:{' '}
          {[50, 500, 1500].map((d) => (
            <button
              key={d}
              style={{
                ...btn,
                display: 'inline-block',
                width: 'auto',
                background: d === dist ? '#3d5a72' : btn.background,
              }}
              onClick={() => chooseDistance(d)}
            >
              {d} m
            </button>
          ))}
        </div>
        <div style={{ margin: '4px 0' }}>
          Ground:{' '}
          <select value={surface} onChange={(e) => setSurface(e.target.value as SurfaceKind)}>
            {SURFACES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        {FX.map((f) => (
          <button key={f.id} style={btn} onClick={() => trigger(f.id)} title={f.id}>
            {f.label}
          </button>
        ))}
        <div style={{ marginTop: 4 }}>
          {[1, 0.25, 0].map((s) => (
            <button
              key={s}
              style={{ ...btn, display: 'inline-block', width: 'auto' }}
              onClick={() => (scene.world.timeScale = s)}
            >
              {s === 0 ? 'freeze' : `${s}×`}
            </button>
          ))}
        </div>
        <Stats />
      </div>
    );

  return (
    <KitStage world={scene.world} pose={pose} follow={follow} overlay={overlay}>
      <AutoRun scene={scene} gunRun={gunRun} trigger={trigger} view={view} />
    </KitStage>
  );
}
