/**
 * Shared kit for the vehicles and effects sandboxes (VEHICLES-AND-EFFECTS MODULE, dev only):
 *
 * - `SandboxWorld`: a scripted simulation on FLAT ground (core `createFlatTerrain`), never stepped
 *   by the core: the sandbox moves vehicles and the aircraft itself and feeds hand-made events to
 *   `onSimFrame` listeners exactly as SimDriver does, so the real EffectsView / VehiclesView run
 *   unchanged. Rebuilding nothing in the core keeps the sandboxes working while the core modules
 *   are being rewritten.
 * - `KitStage`: a <Canvas> with sky colour, sun and sky light and haze from `a10Env`, a flat
 *   farmland ground, orbit controls and the sandbox driver.
 *
 * Opened directly (`?sandbox=effectsKit`) it shows the bare stage with a few vehicles.
 */
import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  Color,
  DataTexture,
  FogExp2,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { createSim } from '../../core/sim';
import { createVehicle } from '../../core/targets';
import type { Vehicle, VehicleKind } from '../../core/targets/types';
import type { Sim, SimEvent } from '../../core/types';
import { createFlatTerrain } from '../../core/world';
import { useA10Store } from '../../state/store';
import { a10Env } from '../../view/environment/env';
import { valueNoise } from '../../view/effects/noise';
import { setViewSimSource } from '../../view/effects/simSource';
import { frameInfo, notifySimFrame } from '../../view/frame';
import { A10_QUALITY } from '../../view/quality';
import EffectsView from '../../view/effects/EffectsView';
import VehiclesView from '../../view/vehicles/VehiclesView';

export const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

export function numParam(name: string, fallback: number): number {
  const v = params.get(name);
  if (v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function vecParam(name: string): [number, number, number] | null {
  const v = params.get(name);
  if (!v) return null;
  const p = v.split(',').map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? (p as [number, number, number]) : null;
}

type Scheduled = { at: number; event: SimEvent };

/** A scripted simulation on flat ground, stepped by the sandbox. */
export class SandboxWorld {
  readonly sim: Sim;
  readonly ground = 0;
  /** Seconds per real second (0 = frozen). */
  timeScale = 1;
  private queue: Scheduled[] = [];
  private readonly events: SimEvent[] = [];
  /** Called every step before events go out (move vehicles, fly the aircraft …). */
  onStep: ((w: SandboxWorld, dt: number) => void) | null = null;

  constructor() {
    this.sim = createSim({ terrain: createFlatTerrain(this.ground), scenario: 'empty', seed: 7 });
    this.sim.world.surfaceWind.set(numParam('windX', 3.5), 0, numParam('windZ', -1.5));
    this.sim.aircraft.position.set(0, 3000, 4000);
  }

  get time(): number {
    return this.sim.time;
  }

  addVehicle(kind: VehicleKind, x: number, z: number, headingDeg: number): Vehicle {
    return createVehicle(this.sim, kind, x, z, (headingDeg * Math.PI) / 180, 1);
  }

  /** Queue an event `delay` seconds from now (its `t` is set when it fires). */
  schedule(delay: number, event: SimEvent): void {
    this.queue.push({ at: this.sim.time + Math.max(0, delay), event });
  }

  clearQueue(): void {
    this.queue.length = 0;
  }

  /** One frame of `dt` simulated seconds: move things, release due events, notify listeners. */
  advance(dt: number): void {
    const sim = this.sim;
    const start = sim.time;
    const end = start + dt;
    this.onStep?.(this, dt);
    this.events.length = 0;
    if (this.queue.length) {
      const keep: Scheduled[] = [];
      for (const q of this.queue) {
        if (q.at <= end) {
          q.event.t = Math.max(start, q.at);
          this.events.push(q.event);
        } else keep.push(q);
      }
      this.queue = keep;
      this.events.sort((a, b) => a.t - b.t);
    }
    sim.time = end;
    frameInfo.simDt = dt;
    frameInfo.steps = dt > 0 ? Math.max(1, Math.round(dt * 120)) : 0;
    frameInfo.alpha = 0;
    notifySimFrame(this.events, sim, frameInfo);
  }
}

/** Steps the sandbox world every frame (before everything else, like SimDriver). */
function Driver({ world }: { world: SandboxWorld }) {
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1) * world.timeScale;
    frameInfo.realDt = delta;
    world.advance(dt);
  }, -100);
  return null;
}

/** Tileable fBm (period in cells at the base frequency). */
function tileFbm(u: number, v: number, cells: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = cells;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u * f, v * f, seed + o * 13, f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Ground texture: pasture with paler, drier patches (seamless, tiles every 160 m), about as bright
 * as the app's farmland seen from the air, so contrast judged here holds in flight.
 */
function makeGroundTexture(): DataTexture {
  const n = 256;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const v = j / n;
      const a = tileFbm(u, v, 4, 4, 3);
      const b = tileFbm(u, v, 32, 3, 9);
      const dry = Math.max(0, Math.min(1, (a - 0.5) * 1.2));
      const r = (0.4 + 0.1 * dry + 0.05 * (b - 0.5)) * 255;
      const g = (0.45 + 0.04 * dry + 0.06 * (b - 0.5)) * 255;
      const bl = (0.24 + 0.04 * dry + 0.035 * (b - 0.5)) * 255;
      const o = (j * n + i) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = bl;
      data[o + 3] = 255;
    }
  }
  const t = new DataTexture(data, n, n, RGBAFormat);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function Ground() {
  const tex = useMemo(() => {
    const t = makeGroundTexture();
    t.repeat.set(60000 / 160, 60000 / 160);
    return t;
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, 0, 0]} receiveShadow>
      <planeGeometry args={[60000, 60000, 1, 1]} />
      <meshStandardMaterial map={tex} roughness={0.95} metalness={0} />
    </mesh>
  );
}

/**
 * Sky colour, haze and lights from a10Env, applied the way the environment module does it in the
 * app (three.js lights whose colour × intensity is the irradiance; materials reflect
 * irradiance · albedo / π, and the effects shaders light the same way).
 */
function Atmosphere() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    scene.background = new Color().copy(a10Env.horizonColor).lerp(a10Env.zenithColor, 0.25);
    scene.fog = new FogExp2(new Color().copy(a10Env.horizonColor), a10Env.hazeDensity);
    return () => {
      scene.background = null;
      scene.fog = null;
    };
  }, [scene]);
  const sun = a10Env.sunDirection;
  return (
    <>
      <hemisphereLight args={[new Color().copy(a10Env.ambientColor), new Color(0.14, 0.15, 0.09), 1]} />
      <directionalLight position={[sun.x * 5000, sun.y * 5000, sun.z * 5000]} intensity={1} color={new Color().copy(a10Env.sunColor)} />
    </>
  );
}

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov?: number;
}

/** Places the camera (and the orbit target) whenever `pose` changes; `follow` overrides per frame. */
function CameraControl({
  pose,
  follow,
}: {
  pose: CameraPose;
  follow?: (cam: PerspectiveCamera) => boolean;
}) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const controls = useRef<OrbitControlsImpl>(null);
  useEffect(() => {
    camera.position.set(...pose.position);
    camera.fov = pose.fov ?? 55;
    camera.near = 0.5;
    camera.far = 90000;
    camera.updateProjectionMatrix();
    camera.lookAt(new Vector3(...pose.target));
    if (controls.current) {
      controls.current.target.set(...pose.target);
      controls.current.update();
    }
  }, [camera, pose]);
  useFrame(() => {
    if (follow && follow(camera)) {
      camera.updateProjectionMatrix();
      if (controls.current) controls.current.enabled = false;
    } else if (controls.current) controls.current.enabled = true;
  }, -20);
  return <OrbitControls ref={controls} makeDefault enableDamping={false} maxDistance={40000} />;
}

export interface KitStageProps {
  world: SandboxWorld;
  pose: CameraPose;
  follow?: (cam: PerspectiveCamera) => boolean;
  children?: ReactNode;
  overlay?: ReactNode;
}

/** The sandbox canvas: atmosphere, ground, the real VehiclesView and EffectsView, a driver. */
export function KitStage({ world, pose, follow, children, overlay }: KitStageProps) {
  useEffect(() => {
    setViewSimSource(() => world.sim);
    return () => setViewSimSource(null);
  }, [world]);
  const quality = useA10Store((s) => s.settings.quality);
  const dpr = A10_QUALITY[quality].level === 'low' ? 1 : 1.25;
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      <Canvas
        dpr={dpr}
        gl={{ antialias: true, stencil: true }}
        camera={{ fov: 55, near: 0.5, far: 90000, position: pose.position }}
      >
        <Driver world={world} />
        <Atmosphere />
        <Ground />
        <VehiclesView />
        <EffectsView />
        <CameraControl pose={pose} follow={follow} />
        {children}
      </Canvas>
      {overlay}
    </div>
  );
}

/** Apply ?quality= for the sandbox (the app's flag handling does not run here). */
export function useSandboxQuality(): void {
  useEffect(() => {
    const q = params.get('quality');
    if (q === 'low' || q === 'medium' || q === 'high') {
      useA10Store.getState().overrideSettings({ quality: q, adaptiveQuality: false });
    }
  }, []);
}

export default function EffectsKitSandbox() {
  useSandboxQuality();
  const world = useMemo(() => {
    const w = new SandboxWorld();
    w.addVehicle('mbt', 0, 0, 200);
    w.addVehicle('truckFuel', 18, 12, 120);
    w.addVehicle('apc', -16, 10, 60);
    return w;
  }, []);
  const pose = useMemo<CameraPose>(() => ({ position: [60, 30, 80], target: [0, 1, 0] }), []);
  return <KitStage world={world} pose={pose} />;
}
