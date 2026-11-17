/**
 * Sensors sandbox (SENSOR-VIEW MODULE): the targeting pod's and the selected Maverick's pictures
 * over the real generated world, through the real SensorsView, TerrainView, VehiclesView,
 * EffectsView and Environment. The simulation is NOT stepped (the core sensors are being
 * written in parallel): the sandbox places the aircraft, the vehicles and the sensor state by
 * hand, and advances time only for the effects (fires, smoke) and the pictures' noise.
 *
 *   /a10/?sandbox=sensors
 *   /a10/?sandbox=sensors&scene=t72&mode=WHOT&fov=NARROW&zoom=2&quality=low&ui=0
 *
 * Parameters:
 *   scene=t72|column|wreck|zoom|mav   t72: a running and a stopped T-72 at 5 km; column: five
 *                                     vehicles on a road at 8 km; wreck: a burning wreck beside a
 *                                     live tank; zoom: one tank, NARROW ×8; mav: the Maverick
 *                                     locked on a tank at 3 nmi
 *   mode=CCD|WHOT|BHOT  fov=WIDE|NARROW  zoom=1|2|4|8          the pod
 *   mav=D|H  mavfov=WIDE|NARROW  lock=0|1                       the Maverick
 *   time=<hours>  vis=<km>  range=<m>  agl=<m>  bank=<deg>      conditions and geometry
 *   engine=on|off       the target tank's engine (t72: one of each regardless)
 *   mask=1  warmup=<s>  align=<s>   validity states
 *   quality=low|medium|high   seed=<n>   warm=<s> (effects run-in)   bench=1 (GPU-timed passes)
 *   ui=0                hide the panel (the pictures and their labels stay)
 *
 * The table compares, per vehicle, the seekers' contrast (core `targetContrast`, the shared
 * model) with the contrast measured in the picture (the vehicle's grey level against the
 * ground around it): what looks hot should be what the seeker can lock.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  Frustum,
  type InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';
import { quaternionFromAttitude } from '../../core/frames';
import { targetContrast } from '../../core/sensors';
import type { MaverickSeekerState, SensorPicture } from '../../core/sensors/types';
import { createSim } from '../../core/sim';
import { createVehicle } from '../../core/targets';
import type { Vehicle, VehicleKind } from '../../core/targets/types';
import type { Sim } from '../../core/types';
import type { Terrain } from '../../core/world/types';
import { MAVERICK, TGP } from '../../data/sensors';
import { THERMAL } from '../../data/vehicles';
import { getTerrain, onTerrain, prepareWorld } from '../../state/runtime';
import { useA10Store, type QualityLevel } from '../../state/store';
import EffectsView from '../../view/effects/EffectsView';
import { setViewSimSource } from '../../view/effects/simSource';
import Environment from '../../view/environment/Environment';
import { environmentOverrides } from '../../view/environment/envState';
import { frameInfo, notifySimFrame } from '../../view/frame';
import { registerRenderPass } from '../../view/pipeline';
import RenderPipeline from '../../view/RenderPipeline';
import { getSensorPicture, type SensorName } from '../../view/sensors/pictures';
import {
  sensorViewOverrides,
  sensorViewStats,
  setSensorViewSim,
} from '../../view/sensors/SensorRenderer';
import SensorsView from '../../view/sensors/SensorsView';
import { createSensorCameraPose, tgpCameraPose } from '../../view/sensors/sensorPose';
import { terrainStreaming } from '../../view/terrain/terrainStats';
import TerrainView from '../../view/terrain/TerrainView';
import VehiclesView from '../../view/vehicles/VehiclesView';

const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const str = (k: string, d: string): string => params.get(k) ?? d;
const num = (k: string, d: number): number => {
  const v = params.get(k);
  if (v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

type Preset = 't72' | 'column' | 'wreck' | 'zoom' | 'mav';
const DEG = Math.PI / 180;

/** What the panel controls; read every frame. */
const ctl = {
  preset: str('scene', 't72') as Preset,
  mode: str('mode', 'WHOT') as SensorPicture,
  fov: str('fov', 'NARROW') as 'WIDE' | 'NARROW',
  zoom: num('zoom', 2),
  mav: str('mav', 'D') as 'D' | 'H',
  mavFov: str('mavfov', 'NARROW') as 'WIDE' | 'NARROW',
  lock: str('lock', '1') !== '0',
  time: num('time', 13),
  vis: num('vis', 30),
  engineOn: str('engine', 'on') !== 'off',
  mask: str('mask', '0') === '1',
  warmup: num('warmup', 0),
  align: num('align', 0),
  bank: num('bank', 0),
};

interface Setup {
  sim: Sim;
  /** The vehicle the sensors look at, and the others in the scene. */
  target: Vehicle;
  vehicles: Vehicle[];
  /** The point the pod looks at. */
  aim: Vector3;
}

/**
 * A vehicle's heat as the targets module's heat model settles it (core/targets behaviour.ts
 * stepHeat, constants data/vehicles.ts THERMAL) at the sandbox's time of day: running (idling,
 * or driving: engine at load, warm running gear) or stopped long ago (the sun on the hull).
 */
function setRunning(v: Vehicle, on: boolean, moving = false): void {
  v.engineOn = on;
  const sun = Math.max(0, Math.sin((Math.PI * (ctl.time - 6)) / 12));
  const engine = on ? (moving ? THERMAL.engineLoad : THERMAL.engineIdle) : 0;
  v.heat = {
    engine: on ? engine : 2,
    exhaust: on ? (moving ? THERMAL.exhaustLoad : THERMAL.exhaustIdle) : 1,
    running: moving ? Math.min(THERMAL.runningMax, THERMAL.runningPerSpeed * 8) : 0,
    hull: THERMAL.hullSun * (0.3 + 0.7 * sun) + THERMAL.hullEngineShare * engine,
  };
}

/** A burnt-out wreck still burning at `fire` (0..1), as the heat model settles it. */
function setBurning(v: Vehicle, fire: number): void {
  v.condition = 'destroyed';
  v.engineOn = false;
  v.fire = fire;
  v.mobilityKill = true;
  v.firepowerKill = true;
  const hull = THERMAL.fireHull * fire;
  v.heat = { engine: hull * 0.6, exhaust: hull * 0.5, running: 0, hull };
}

/** An open spot near (x, z): not forest, water or road, and fairly flat. */
function openSpot(t: Terrain, x: number, z: number): [number, number] {
  for (let r = 0; r < 2000; r += 40) {
    for (let a = 0; a < 16; a++) {
      const px = x + Math.cos((a / 16) * Math.PI * 2) * r;
      const pz = z + Math.sin((a / 16) * Math.PI * 2) * r;
      const s = t.surfaceAt(px, pz);
      if (s === 'forest' || s === 'water' || s === 'road' || s === 'concrete') continue;
      const n = new Vector3();
      t.normalAt(px, pz, n);
      if (n.y < 0.985) continue;
      if (t.canopyAt(px, pz) > 0) continue;
      return [px, pz];
    }
  }
  return [x, z];
}

interface RoadSpot {
  x: number;
  z: number;
  /** Heading of travel along the road (0 = north, + toward east), rad. */
  heading: number;
}

/**
 * A column of `count` vehicles `spacing` m apart on the paved road nearest to (x, z): the first
 * at the point of the road closest to (x, z), the others behind it ALONG the centre line (roads
 * curve), all facing along the road.
 */
function roadColumn(t: Terrain, x: number, z: number, count: number, spacing: number): RoadSpot[] {
  let road: Float64Array | null = null;
  let seg = 0;
  let u = 0;
  let best = Infinity;
  for (const r of t.roads) {
    if (r.kind === 'track') continue;
    const p = r.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2] - p[i];
      const dz = p[i + 3] - p[i + 1];
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-6) continue;
      const f = Math.min(1, Math.max(0, ((x - p[i]) * dx + (z - p[i + 1]) * dz) / l2));
      const d = Math.hypot(p[i] + f * dx - x, p[i + 1] + f * dz - z);
      if (d < best) {
        best = d;
        road = p;
        seg = i;
        u = f;
      }
    }
  }
  const out: RoadSpot[] = [];
  if (!road) {
    for (let k = 0; k < count; k++) out.push({ x, z: z + k * spacing, heading: 0 });
    return out;
  }
  const p = road;
  // walk back along the polyline from (seg, u), one spot every `spacing` metres
  let i = seg;
  let back = u * Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]); // metres from vertex i
  for (let k = 0; k < count; k++) {
    let need = k === 0 ? 0 : spacing;
    while (need > back && i > 0) {
      need -= back;
      i -= 2;
      back = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
    }
    back = Math.max(0, back - need);
    const dx = p[i + 2] - p[i];
    const dz = p[i + 3] - p[i + 1];
    const l = Math.hypot(dx, dz) || 1;
    out.push({
      x: p[i] + (dx / l) * back,
      z: p[i + 1] + (dz / l) * back,
      heading: Math.atan2(dx, -dz),
    });
  }
  return out;
}

function vehicleAt(sim: Sim, kind: VehicleKind, x: number, z: number, heading: number): Vehicle {
  return createVehicle(sim, kind, x, z, heading, 1);
}

/** Build the scene of a preset in the generated world. */
function buildSetup(terrain: Terrain, preset: Preset): Setup {
  const sim = createSim({ terrain, scenario: 'empty', seed: 7, loadoutId: 'tankHunter' });
  sim.world.timeOfDay = ctl.time;
  sim.world.visibilityKm = ctl.vis;
  const area = terrain.targetAreas.find((a) => a.kind === 'open') ?? terrain.targetAreas[0];
  const ax = area ? area.x : 0;
  const az = area ? area.z : 0;
  const vehicles: Vehicle[] = [];
  let target: Vehicle;
  let range = 5000;
  let agl = 2400;
  const aim = new Vector3();
  if (preset === 'column') {
    const kinds: VehicleKind[] = ['mbt', 'ifv', 'truckCargo', 'truckFuel', 'apc'];
    const spots = roadColumn(terrain, ax, az, kinds.length, 25);
    kinds.forEach((k, i) => {
      const v = vehicleAt(sim, k, spots[i].x, spots[i].z, spots[i].heading);
      setRunning(v, true, true);
      vehicles.push(v);
    });
    target = vehicles[2];
    range = 8000;
    agl = 3000;
    aim.copy(target.position);
  } else {
    const [tx, tz] = openSpot(terrain, ax, az);
    target = vehicleAt(sim, 'mbt', tx, tz, 40 * DEG);
    setRunning(target, preset === 't72' ? true : ctl.engineOn);
    vehicles.push(target);
    if (preset === 't72') {
      const other = vehicleAt(sim, 'mbt', tx + 26, tz + 6, 75 * DEG);
      setRunning(other, false);
      vehicles.push(other);
    } else if (preset === 'wreck') {
      const wreck = vehicleAt(sim, 'mbt', tx - 30, tz + 12, 200 * DEG);
      wreck.conditionTime = -120;
      setBurning(wreck, 0.75);
      vehicles.push(wreck);
    }
    if (preset === 'mav') {
      range = 3 * 1852;
      agl = 1500;
    }
    aim.copy(target.position);
    if (preset === 't72') aim.set(tx + 13, target.position.y, tz + 3);
    if (preset === 'wreck') aim.set(tx - 15, target.position.y, tz + 6);
  }
  range = num('range', range);
  agl = num('agl', agl);
  aim.y += 1.2;

  // the aircraft: `range` m slant range from the aim point, coming from the start point's side
  const s = terrain.start;
  let dx = s.x - aim.x;
  let dz = s.z - aim.z;
  const l = Math.hypot(dx, dz) || 1;
  dx /= l;
  dz /= l;
  const horizontal = Math.sqrt(Math.max(1, range * range - agl * agl));
  const ac = sim.aircraft;
  ac.position.set(aim.x + dx * horizontal, aim.y + agl, aim.z + dz * horizontal);
  ac.prevPosition.copy(ac.position);
  const heading = Math.atan2(-dx, dz);
  quaternionFromAttitude(heading, 0, ctl.bank * DEG, ac.orientation);
  ac.prevOrientation.copy(ac.orientation);
  ac.velocity.set(-dx * 130, 0, -dz * 130);
  sim.avionics.mfd = { left: 'TGP', right: 'MAV' };
  return { sim, target, vehicles, aim };
}

/** Point the sensors at the scene (every frame: the panel may change them). */
function applySensors(setup: Setup): void {
  const { sim, target, aim } = setup;
  const tgp = sim.sensors.tgp;
  tgp.powered = true;
  tgp.warmup = ctl.warmup;
  tgp.masked = ctl.mask;
  tgp.picture = ctl.mode;
  tgp.fovSetting = ctl.fov;
  tgp.zoom = ctl.zoom;
  tgp.fov = (ctl.fov === 'NARROW' ? TGP.fovNarrow : TGP.fovWide) / ctl.zoom;
  tgp.point.copy(aim);
  tgp.pointValid = true;
  tgp.los.subVectors(aim, sim.aircraft.position).normalize();
  sim.avionics.tgpPower = true;

  // the selected Maverick: a D on station 3 or an H on station 9
  const station = ctl.mav === 'D' ? 3 : 9;
  let s = sim.sensors.mavericks[0] as
    | (MaverickSeekerState & { type?: string; band?: string; picture?: string; fovAngle?: number })
    | undefined;
  if (!s || s.station !== station) {
    s = {
      station,
      powered: true,
      align: 0,
      los: new Vector3(),
      fov: 'NARROW',
      locked: false,
      lockedVehicle: -1,
      lockPoint: new Vector3(),
      inZone: false,
      gimbalAz: 0,
      gimbalEl: 0,
      contrast: 0,
    } as MaverickSeekerState;
    sim.sensors.mavericks = [s];
  }
  s.type = ctl.mav === 'D' ? 'AGM-65D' : 'AGM-65H';
  s.band = ctl.mav === 'D' ? 'IR' : 'TV';
  s.picture = ctl.mav === 'D' ? 'WHOT' : 'CCD';
  s.fov = ctl.mavFov;
  s.fovAngle = ctl.mavFov === 'NARROW' ? MAVERICK.fovNarrow : MAVERICK.fovWide;
  s.align = ctl.align;
  s.locked = ctl.lock;
  s.lockedVehicle = ctl.lock ? target.id : -1;
  s.lockPoint.copy(target.position).setY(target.position.y + 1.2);
  s.los.subVectors(s.lockPoint, sim.aircraft.position).normalize();
  sim.sensors.selectedMaverick = 0;
  sim.world.timeOfDay = ctl.time;
  sim.world.visibilityKm = ctl.vis;
  environmentOverrides.timeOfDay = ctl.time;
  environmentOverrides.visibilityKm = ctl.vis;
}

/** Advances time for the effects and the pictures (the core is not stepped). */
function Driver({ setup }: { setup: Setup }) {
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    applySensors(setup);
    setup.sim.time += dt;
    frameInfo.simDt = dt;
    frameInfo.realDt = delta;
    frameInfo.steps = 1;
    frameInfo.alpha = 0;
    notifySimFrame([], setup.sim, frameInfo);
  }, -100);
  return null;
}

/** The outside view: from the cockpit toward the aim point. */
function WorldCamera({ setup }: { setup: Setup }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    worldScene.current = scene;
  }, [scene]);
  useFrame(() => {
    const ac = setup.sim.aircraft;
    camera.position.copy(ac.position);
    camera.position.y += 1.2;
    camera.lookAt(setup.aim);
    camera.fov = 40;
    camera.near = 1;
    camera.far = 90000;
    camera.updateProjectionMatrix();
  }, -20);
  return null;
}

/**
 * Both pictures on the screen, as a display would show them: plain textured quads (the picture
 * is an sRGB texture holding the finished grey levels), drawn after everything else.
 */
function PictureOverlay({ size }: { size: number }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const scene = new Scene();
    const camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);
    const quads = (['TGP', 'MAV'] as SensorName[]).map(() => {
      const m = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ toneMapped: false }));
      m.visible = false;
      scene.add(m);
      return m;
    });
    const off = registerRenderPass({
      id: 'sensors-sandbox-overlay',
      order: 950,
      render(ctx) {
        const w = ctx.width;
        const h = ctx.height;
        camera.left = 0;
        camera.right = w;
        camera.top = h;
        camera.bottom = 0;
        camera.updateProjectionMatrix();
        const px = size * (w / Math.max(1, gl.domElement.clientWidth));
        (['TGP', 'MAV'] as SensorName[]).forEach((name, i) => {
          const pic = getSensorPicture(name);
          const q = quads[i];
          q.visible = pic !== null;
          if (!pic) return;
          const mat = q.material as MeshBasicMaterial;
          if (mat.map !== pic.texture) {
            mat.map = pic.texture;
            mat.needsUpdate = true;
          }
          q.scale.set(px, px, 1);
          q.position.set(w - px / 2 - 8, h - px / 2 - 8 - i * (px + 28), 0);
        });
        ctx.gl.setRenderTarget(null);
        ctx.gl.autoClear = false;
        ctx.gl.clearDepth();
        ctx.gl.render(scene, camera);
      },
    });
    return () => {
      off();
      for (const q of quads) {
        q.geometry.dispose();
        (q.material as MeshBasicMaterial).dispose();
      }
    };
  }, [gl, size]);
  return null;
}

/** The world scene (for the frustum breakdown). */
const worldScene: { current: Scene | null } = { current: null };

/**
 * Development: what the pod camera's frustum lets through of the world scene, by object — the
 * draw calls and triangles a picture costs (the scene as drawn in the visible band; the infrared
 * render hides a few overlays more).
 */
function frustumBreakdown(setup: Setup): { name: string; triangles: number; instances: number }[] {
  const scene = worldScene.current;
  if (!scene) return [];
  const pose = createSensorCameraPose();
  tgpCameraPose(setup.sim, pose);
  const cam = new PerspectiveCamera(pose.fov / DEG, 1, pose.near, pose.far);
  cam.position.copy(pose.position);
  cam.quaternion.copy(pose.quaternion);
  cam.updateMatrixWorld();
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
  );
  const rows: { name: string; triangles: number; instances: number }[] = [];
  scene.traverseVisible((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (m.frustumCulled && !frustum.intersectsObject(m)) return;
    const g = m.geometry;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const inst = (m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh).count : 1;
    rows.push({
      name: m.name || m.parent?.name || (m.material as { name?: string }).name || m.type,
      triangles: tris * inst,
      instances: inst,
    });
  });
  return rows.sort((a, b) => b.triangles - a.triangles);
}

/** bench=1: the world pass's time measured like the sensor passes' (GPU drained around it), ms. */
const worldBench = { ms: 0, avg: 0, frames: 0, calls: 0, triangles: 0 };

/**
 * bench=1 only: time the world pass (order 100) the way SensorRenderer times its pictures — a
 * one-pixel synchronous read before and after drains the GPU — so the sensor passes' cost can be
 * read against it (software WebGL in CI is far slower than a GPU; the ratio carries over).
 */
function WorldBench() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const px = new Uint8Array(4);
    let t0 = 0;
    const drain = () => {
      const raw = gl.getContext();
      gl.setRenderTarget(null);
      raw.readPixels(0, 0, 1, 1, raw.RGBA, raw.UNSIGNED_BYTE, px);
    };
    const offA = registerRenderPass({
      id: 'sensors-sandbox-bench-a',
      order: 99,
      render() {
        drain();
        t0 = performance.now();
      },
    });
    const offB = registerRenderPass({
      id: 'sensors-sandbox-bench-b',
      order: 101,
      render() {
        drain();
        worldBench.ms = performance.now() - t0;
        // the world pass's last render call (R3F resets the counters per call)
        worldBench.calls = gl.info.render.calls;
        worldBench.triangles = gl.info.render.triangles;
        worldBench.frames++;
        worldBench.avg =
          worldBench.frames <= 1 ? worldBench.ms : worldBench.avg * 0.9 + worldBench.ms * 0.1;
      },
    });
    return () => {
      offA();
      offB();
    };
  }, [gl]);
  return null;
}

interface Measured {
  id: number;
  kind: string;
  state: string;
  coreIr: number;
  coreTv: number;
  /** Display-grey difference vehicle − ground in the pod picture (−1..1), or null off-picture. */
  picture: number | null;
}

/** Mean grey of the picture inside radius r0 and between r1 and r2 of (cx, cy), pixels. */
function discAndRing(
  data: Uint8ClampedArray,
  size: number,
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  r2: number,
): [number, number] {
  let a = 0;
  let na = 0;
  let b = 0;
  let nb = 0;
  const R = Math.ceil(r2);
  for (let y = Math.floor(cy) - R; y <= Math.floor(cy) + R; y++) {
    for (let x = Math.floor(cx) - R; x <= Math.floor(cx) + R; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const g = data[(y * size + x) * 4] / 255;
      if (d <= r0) {
        a += g;
        na++;
      } else if (d >= r1 && d <= r2) {
        b += g;
        nb++;
      }
    }
  }
  return [na ? a / na : 0, nb ? b / nb : 0];
}

/** Measure each vehicle's contrast in the pod picture (async: decodes a PNG of it). */
async function measure(setup: Setup): Promise<Measured[]> {
  const sim = setup.sim;
  const pose = createSensorCameraPose();
  tgpCameraPose(sim, pose);
  const hook = (
    window as unknown as { __A10_SENSORS__?: { snapshot(s: SensorName): string | null } }
  ).__A10_SENSORS__;
  const url = hook?.snapshot('TGP') ?? null;
  let data: Uint8ClampedArray | null = null;
  let size = 0;
  if (url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    size = img.width;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const c2d = c.getContext('2d')!;
    c2d.drawImage(img, 0, 0);
    data = c2d.getImageData(0, 0, size, size).data;
  }
  const cam = new PerspectiveCamera(pose.fov / DEG, 1, pose.near, pose.far);
  cam.position.copy(pose.position);
  cam.quaternion.copy(pose.quaternion);
  cam.updateMatrixWorld();
  const pod = pose.position;
  return setup.vehicles.map((v) => {
    const centre = v.position.clone().setY(v.position.y + 1.2);
    let picture: number | null = null;
    if (data) {
      const p = centre.clone().project(cam);
      if (Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1) {
        const cx = ((p.x + 1) / 2) * size;
        const cy = ((1 - p.y) / 2) * size;
        const px = (3.2 / pod.distanceTo(centre) / pose.fov) * size;
        const [veh, ground] = discAndRing(
          data,
          size,
          cx,
          cy,
          Math.max(1.2, px * 0.7),
          px * 2.2,
          px * 3.5 + 3,
        );
        picture = veh - ground;
      }
    }
    return {
      id: v.id,
      kind: v.kind,
      state: v.fire > 0 ? 'burning' : v.engineOn ? 'running' : 'stopped',
      coreIr: targetContrast(sim, v.id, 'IR', pod),
      coreTv: targetContrast(sim, v.id, 'TV', pod),
      picture,
    };
  });
}

const PANEL: CSSProperties = {
  position: 'fixed',
  left: 8,
  top: 8,
  width: 330,
  maxHeight: 'calc(100vh - 16px)',
  overflow: 'auto',
  background: 'rgba(10,14,12,0.82)',
  color: '#d8e0d6',
  font: '12px/1.35 ui-monospace, monospace',
  padding: 10,
  borderRadius: 6,
};

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', margin: '2px 0' }}>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', margin: '2px 0', gap: 6 }}>
      <span>
        {label} {value}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : '–';
}

function Panel({ setup, onPreset }: { setup: Setup; onPreset: (p: Preset) => void }) {
  const [, force] = useState(0);
  const [rows, setRows] = useState<Measured[]>([]);
  const set = <K extends keyof typeof ctl>(k: K, v: (typeof ctl)[K]) => {
    ctl[k] = v;
    force((n) => n + 1);
  };
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 250);
    let alive = true;
    const loop = async () => {
      while (alive) {
        try {
          const r = await measure(setup);
          if (alive) setRows(r);
        } catch {
          /* picture not ready yet */
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
    };
    void loop();
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [setup]);
  const quality = useA10Store((s) => s.settings.quality);
  const st = (n: SensorName) => sensorViewStats[n];
  const pic = (n: SensorName) => getSensorPicture(n);
  return (
    <div style={PANEL}>
      <b>Sensor pictures</b>
      <Select
        label="scene"
        value={ctl.preset}
        options={['t72', 'column', 'wreck', 'zoom', 'mav'] as const}
        onChange={(v) => onPreset(v)}
      />
      <Select
        label="quality"
        value={quality}
        options={['low', 'medium', 'high'] as const}
        onChange={(v) => useA10Store.getState().updateSettings({ quality: v as QualityLevel })}
      />
      <hr />
      <b>Targeting pod</b>
      <Select
        label="picture"
        value={ctl.mode}
        options={['CCD', 'WHOT', 'BHOT'] as const}
        onChange={(v) => set('mode', v)}
      />
      <Select
        label="field"
        value={ctl.fov}
        options={['WIDE', 'NARROW'] as const}
        onChange={(v) => set('fov', v)}
      />
      <Select
        label="zoom"
        value={String(ctl.zoom) as '1' | '2' | '4' | '8'}
        options={['1', '2', '4', '8'] as const}
        onChange={(v) => set('zoom', Number(v))}
      />
      <label>
        <input type="checkbox" checked={ctl.mask} onChange={(e) => set('mask', e.target.checked)} />{' '}
        masked
      </label>{' '}
      <label>
        <input
          type="checkbox"
          checked={ctl.warmup > 0}
          onChange={(e) => set('warmup', e.target.checked ? 60 : 0)}
        />{' '}
        warming up
      </label>
      <hr />
      <b>Maverick</b>
      <Select
        label="missile"
        value={ctl.mav}
        options={['D', 'H'] as const}
        onChange={(v) => set('mav', v)}
      />
      <Select
        label="field"
        value={ctl.mavFov}
        options={['WIDE', 'NARROW'] as const}
        onChange={(v) => set('mavFov', v)}
      />
      <label>
        <input type="checkbox" checked={ctl.lock} onChange={(e) => set('lock', e.target.checked)} />{' '}
        locked
      </label>{' '}
      <label>
        <input
          type="checkbox"
          checked={ctl.align > 0}
          onChange={(e) => set('align', e.target.checked ? 90 : 0)}
        />{' '}
        aligning
      </label>
      <hr />
      <Range
        label="time"
        value={ctl.time}
        min={4}
        max={22}
        step={0.5}
        onChange={(v) => set('time', v)}
      />
      <Range
        label="visibility km"
        value={ctl.vis}
        min={2}
        max={60}
        step={1}
        onChange={(v) => set('vis', v)}
      />
      <label>
        <input
          type="checkbox"
          checked={setup.target.engineOn}
          onChange={(e) => {
            setRunning(setup.target, e.target.checked);
            force((n) => n + 1);
          }}
        />{' '}
        target engine running
      </label>
      <hr />
      {(['TGP', 'MAV'] as SensorName[]).map((n) => (
        <div key={n}>
          <b>{n}</b> {pic(n)?.status ?? '—'} {pic(n)?.picture} valid{' '}
          {String(pic(n)?.valid ?? false)}
          <br />
          {st(n).size}px (detector {st(n).effectivePixels}) · fov{' '}
          {fmt(((pic(n)?.fov ?? 0) * 180) / Math.PI, 3)}°
          <br />
          calls {st(n).calls} ({st(n).sceneCalls} scene) · tris {st(n).triangles} ·{' '}
          {fmt(st(n).cpuMsAvg)} ms
          <br />
          AGC{' '}
          {st(n).band === 'IR'
            ? `${fmt(st(n).agcLo, 1)}…${fmt(st(n).agcHi, 1)} K`
            : `×${fmt(st(n).exposure, 1)} black ${fmt(st(n).black)}`}{' '}
          {pic(n)?.agcSettled ? 'settled' : 'settling'} · frame {pic(n)?.frame ?? 0}
        </div>
      ))}
      <hr />
      <b>Contrast: seeker model vs pod picture</b>
      <table style={{ width: '100%', fontSize: 11 }}>
        <thead>
          <tr>
            <td>vehicle</td>
            <td>IR</td>
            <td>TV</td>
            <td>picture</td>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.kind} {r.state}
              </td>
              <td>{fmt(r.coreIr)}</td>
              <td>{fmt(r.coreTv)}</td>
              <td>{r.picture === null ? 'off' : fmt(r.picture)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ opacity: 0.7 }}>
        terrain pending {terrainStreaming.pending} · tiles {terrainStreaming.tiles}
      </div>
    </div>
  );
}

/** Labels beside the pictures (stay with ui=0, for screenshots). */
function Labels({ size }: { size: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 300);
    return () => window.clearInterval(id);
  }, []);
  const label = (n: SensorName) => {
    const p = getSensorPicture(n);
    if (!p) return `${n}: none`;
    const fov = ((p.fov * 180) / Math.PI).toFixed(2);
    const what =
      n === 'TGP'
        ? `${ctl.fov} ×${ctl.zoom}`
        : `AGM-65${ctl.mav} ${ctl.mavFov}${ctl.lock ? ' LOCKED' : ''}`;
    return `${n} ${p.picture} ${what} ${fov}° ${p.status}`;
  };
  const style = (i: number): CSSProperties => ({
    position: 'fixed',
    right: 8,
    width: size,
    top: 8 + size + i * (size + 28) + 2,
    color: '#e8efe4',
    font: '12px ui-monospace, monospace',
    textAlign: 'center',
    textShadow: '0 0 3px #000',
  });
  return (
    <>
      <div style={style(0)}>{label('TGP')}</div>
      <div style={style(1)}>{label('MAV')}</div>
    </>
  );
}

export default function SensorsSandbox() {
  const [terrain, setTerrain] = useState<Terrain | null>(getTerrain);
  const [preset, setPreset] = useState<Preset>(ctl.preset);
  const quality = (params.get('quality') as QualityLevel | null) ?? 'low';
  const ui = params.get('ui') !== '0';
  const size = Math.round(Math.min(window.innerHeight / 2 - 26, 420));

  useEffect(() => {
    useA10Store.getState().updateSettings({ quality });
    sensorViewOverrides.finish = params.get('bench') === '1';
    if (params.get('detail')) sensorViewOverrides.detailScaleMax = num('detail', 6);
    void prepareWorld(num('seed', useA10Store.getState().settings.worldSeed));
    return onTerrain(setTerrain);
  }, [quality]);

  const setup = useMemo(() => {
    if (!terrain) return null;
    ctl.preset = preset;
    if (preset === 'zoom') {
      ctl.fov = 'NARROW';
      if (!params.get('zoom')) ctl.zoom = 8;
    }
    return buildSetup(terrain, preset);
  }, [terrain, preset]);

  useEffect(() => {
    if (!setup) return;
    setViewSimSource(() => setup.sim);
    setSensorViewSim(() => setup.sim);
    const w = window as unknown as { __SENSORS_SANDBOX__?: unknown };
    w.__SENSORS_SANDBOX__ = {
      ctl,
      setup,
      ready: () => {
        const t = getSensorPicture('TGP');
        const m = getSensorPicture('MAV');
        return (
          terrainStreaming.pending === 0 &&
          terrainStreaming.tiles > 0 &&
          setup.sim.time > num('warm', 4) &&
          !!t &&
          t.frame > 3 &&
          (t.agcSettled || t.status !== 'OK') &&
          !!m &&
          m.frame > 3 &&
          (m.agcSettled || m.status !== 'OK')
        );
      },
      stats: sensorViewStats,
      world: worldBench,
      breakdown: () => frustumBreakdown(setup),
      measure: () => measure(setup),
    };
    return () => {
      setViewSimSource(null);
      setSensorViewSim(null);
      delete w.__SENSORS_SANDBOX__;
    };
  }, [setup]);

  const dpr: [number, number] = quality === 'low' ? [0.75, 1] : [1, 1.5];
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      <Canvas
        dpr={dpr}
        gl={{ antialias: true, stencil: true }}
        camera={{ fov: 40, near: 1, far: 90000, position: [0, 3000, 0] }}
      >
        <Environment />
        <TerrainView />
        <VehiclesView />
        <EffectsView />
        <SensorsView />
        {setup && <Driver setup={setup} />}
        {setup && <WorldCamera setup={setup} />}
        <PictureOverlay size={size} />
        {params.get('bench') === '1' && <WorldBench />}
        <RenderPipeline />
      </Canvas>
      {setup && ui && <Panel setup={setup} onPreset={setPreset} />}
      <Labels size={size} />
    </div>
  );
}
