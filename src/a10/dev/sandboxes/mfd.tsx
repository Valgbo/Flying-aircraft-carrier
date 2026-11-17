/**
 * MFD sandbox — /a10/?sandbox=mfd (dev server). The two A-10C multifunction colour displays,
 * drawn by the real display renderer (view/mfd) for a sandbox flight over the generated world,
 * shown flat (at their native 512 px where the window allows) inside bezels with their twenty
 * push buttons: a click sends the real `osb` command to the avionics, so every page, option and
 * page change works as in the cockpit. The TGP and MAV pages show the real sensor pictures
 * (view/sensors) of the same flight.
 *
 * The aircraft is not flown by the flight model: it follows a fixed path (an attack run toward a
 * tank in a target area, which starts again from 10 km; an orbit around it; or a hold). The
 * avionics (commands, fire control) and the sensors step for real at 120 Hz along that path, so
 * the pod tracks, the laser fires, the seeker locks and the counters run as in flight. Should one
 * of them throw (the modules are written in parallel), the panel shows the error and the last
 * state stays.
 *
 * URL (all optional):
 *   left=TAD|TGP|MAV|DSMS|STAT|MSG  right=…    the pages (default TGP and MAV)
 *   soi=HUD|LMFD|RMFD                          the sensor of interest (default LMFD)
 *   scene=attack|warmup|cold                   attack: the pod tracks the tank (POINT) and lases
 *                                              (latched), the Maverick is locked on it, the pod
 *                                              is the SPI; warmup: both just powered (NOT TIMED
 *                                              OUT); cold: both off
 *   path=run|orbit|hold   tad=5|10|20|40|80|160   center=OWN|SPI   markers=1 (target areas)
 *   quality=low|medium|high   seed=<n>   ui=0 (no panel)
 *   world=0                                    no outside world behind the displays (the
 *                                              pictures still show it): for slow software GL
 *
 * Test hook: window.__MFD_SANDBOX__ = { sim, mfd, press(display, button), pages(left, right),
 * scene(name), ready(), errors }.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';
import {
  applyCommands,
  makeSpi,
  setMfdPage,
  SOI_PAGES,
  spiToSteerpoint,
  stepFireControl,
} from '../../core/avionics';
import type { LaserArm, MasterArm, MfdPage, Soi } from '../../core/avionics/types';
import { quaternionFromAttitude } from '../../core/frames';
import {
  maverickLock,
  setMaverickFov,
  setTgpTrack,
  slaveMaverickToSpi,
  slaveTgpToSpi,
  stepSensors,
} from '../../core/sensors';
import { createSim } from '../../core/sim';
import { createVehicle } from '../../core/targets';
import type { Vehicle, VehicleKind } from '../../core/targets/types';
import type { Sim, SimEvent } from '../../core/types';
import { KT, NM } from '../../core/units';
import type { Terrain } from '../../core/world/types';
import { getTerrain, onTerrain, prepareWorld } from '../../state/runtime';
import { useA10Store, type QualityLevel } from '../../state/store';
import { setViewSimSource } from '../../view/effects/simSource';
import Environment from '../../view/environment/Environment';
import { frameInfo, notifySimFrame } from '../../view/frame';
import { MfdRenderer } from '../../view/mfd/MfdRenderer';
import { MFD_RESOLUTION, OSB_ANCHORS } from '../../view/mfd/mfdLayout';
import { registerRenderPass } from '../../view/pipeline';
import { getA10Quality } from '../../view/quality';
import RenderPipeline from '../../view/RenderPipeline';
import { getSensorPicture } from '../../view/sensors/pictures';
import { setSensorViewSim } from '../../view/sensors/SensorRenderer';
import SensorsView from '../../view/sensors/SensorsView';
import { terrainStreaming } from '../../view/terrain/terrainStats';
import TerrainView from '../../view/terrain/TerrainView';
import VehiclesView from '../../view/vehicles/VehiclesView';

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const PAGES: readonly MfdPage[] = ['TAD', 'TGP', 'MAV', 'DSMS', 'STAT', 'MSG'];
type SceneName = 'attack' | 'warmup' | 'cold';
type PathName = 'run' | 'orbit' | 'hold';

function pick<T extends string>(key: string, options: readonly T[], fallback: T): T {
  const v = params.get(key);
  return v !== null && (options as readonly string[]).includes(v) ? (v as T) : fallback;
}

const ctl = {
  left: pick('left', PAGES, 'TGP'),
  right: pick('right', PAGES, 'MAV'),
  soi: pick<Soi>('soi', ['HUD', 'LMFD', 'RMFD'], 'LMFD'),
  scene: pick<SceneName>('scene', ['attack', 'warmup', 'cold'], 'attack'),
  path: pick<PathName>('path', ['run', 'orbit', 'hold'], 'run'),
  tad: Number(params.get('tad') ?? 20),
  center: pick<'OWN' | 'SPI'>('center', ['OWN', 'SPI'], 'OWN'),
  markers: params.get('markers') === '1',
  /** Draw the outside world behind the displays (off: only the sensor pictures render it). */
  world: params.get('world') !== '0',
};

/**
 * The flight path: an attack run from 10 to 4 km (≈5.4 to 2.2 nm, inside the Maverick's lock
 * ranges for a tank) at 2,000 m above the target, 250 kt.
 */
const RUN = { from: 10000, to: 4000, agl: 2000, speed: 250 * KT };
/** The orbit: 7 km radius, clockwise (the target on the right). */
const ORBIT = { radius: 7000 };
const STEP = 1 / 120;

// ---------------------------------------------------------------------------------------------
// The sandbox flight
// ---------------------------------------------------------------------------------------------

interface Setup {
  sim: Sim;
  tank: Vehicle;
  /** Ground point of the target (the tank), and the inbound course (unit, world x/z). */
  target: Vector3;
  courseX: number;
  courseZ: number;
  /** Distance flown along the path, m. */
  along: number;
  /** Errors thrown by the stepped modules (latest first). */
  errors: string[];
}

/** An open, fairly flat spot near (x, z): not forest, water, road or concrete. */
function openSpot(t: Terrain, x: number, z: number): [number, number] {
  const n = new Vector3();
  for (let r = 0; r < 2000; r += 40) {
    for (let a = 0; a < 16; a++) {
      const px = x + Math.cos((a / 16) * Math.PI * 2) * r;
      const pz = z + Math.sin((a / 16) * Math.PI * 2) * r;
      const s = t.surfaceAt(px, pz);
      if (s === 'forest' || s === 'water' || s === 'road' || s === 'concrete') continue;
      t.normalAt(px, pz, n);
      if (n.y < 0.985 || t.canopyAt(px, pz) > 0) continue;
      return [px, pz];
    }
  }
  return [x, z];
}

function vehicle(
  sim: Sim,
  kind: VehicleKind,
  x: number,
  z: number,
  heading: number,
  running: boolean,
): Vehicle {
  const v = createVehicle(sim, kind, x, z, heading, 1);
  v.engineOn = running;
  v.heat = running
    ? { engine: 38, exhaust: 80, running: 9, hull: 7 }
    : { engine: 2, exhaust: 1, running: 0.5, hull: 5 };
  return v;
}

function buildSetup(terrain: Terrain): Setup {
  const sim = createSim({ terrain, scenario: 'empty', seed: 7, loadoutId: 'tankHunter' });
  sim.world.timeOfDay = 11;
  sim.options.realism.mapMarkers = ctl.markers;
  const area = terrain.targetAreas.find((a) => a.kind === 'open') ?? terrain.targetAreas[0];
  const [tx, tz] = openSpot(terrain, area?.x ?? 0, area?.z ?? 0);
  const tank = vehicle(sim, 'mbt', tx, tz, 0.7, true);
  vehicle(sim, 'ifv', tx + 45, tz + 20, 1.1, true);
  vehicle(sim, 'truckCargo', tx - 60, tz + 35, 2.4, false);
  const target = new Vector3(tx, terrain.heightAt(tx, tz), tz);

  // Steerpoints: the avionics' own (one per target area), the target area's moved onto the tank.
  const av = sim.avionics;
  if (av.steerpoints.length === 0)
    av.steerpoints.push({ id: 1, name: area?.name ?? 'TGT', position: new Vector3() });
  let k = av.steerpoints.findIndex((s) => s.name === area?.name);
  if (k < 0) k = 0;
  av.steerpoints[k].position.copy(target);
  av.activeSteerpoint = k;
  spiToSteerpoint(sim);

  // Run in from the side of the start point.
  const s = terrain.start;
  const l = Math.hypot(s.x - tx, s.z - tz) || 1;
  const setup: Setup = {
    sim,
    tank,
    target,
    courseX: (tx - s.x) / l,
    courseZ: (tz - s.z) / l,
    along: 0,
    errors: [],
  };
  setMfdPage(sim, 'L', ctl.left);
  setMfdPage(sim, 'R', ctl.right);
  av.pages.tadRange = ctl.tad;
  av.pages.tadCenter = ctl.center;
  fly(setup, 0);
  applyScene(setup, ctl.scene);
  return setup;
}

/** Place the aircraft on its path, `dt` seconds further on (straight and level, coordinated). */
function fly(setup: Setup, dt: number): void {
  const { sim, target } = setup;
  const ac = sim.aircraft;
  ac.prevPosition.copy(ac.position);
  ac.prevOrientation.copy(ac.orientation);
  ac.prevVelocity.copy(ac.velocity);
  const v = RUN.speed;
  let heading: number;
  let bank = 0;
  if (ctl.path === 'orbit') {
    setup.along += v * dt;
    const bearing = setup.along / ORBIT.radius; // from the target, clockwise
    ac.position.set(
      target.x + Math.sin(bearing) * ORBIT.radius,
      target.y + RUN.agl,
      target.z - Math.cos(bearing) * ORBIT.radius,
    );
    heading = bearing + Math.PI / 2;
    bank = Math.atan((v * v) / (9.80665 * ORBIT.radius));
  } else {
    if (ctl.path === 'run') setup.along += v * dt;
    const span = RUN.from - RUN.to;
    const d = RUN.from - (((setup.along % span) + span) % span);
    ac.position.set(target.x - setup.courseX * d, target.y + RUN.agl, target.z - setup.courseZ * d);
    heading = Math.atan2(setup.courseX, -setup.courseZ);
  }
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  quaternionFromAttitude(heading, 0, bank, ac.orientation);
  ac.velocity.set(fx * v, 0, fz * v);
  ac.heading = ((heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  ac.pitch = 0;
  ac.bank = bank;
  ac.tas = v;
  ac.ias = v * 0.9;
  ac.groundSpeed = v;
  ac.verticalSpeed = 0;
  ac.altitude = ac.position.y;
  ac.agl = ac.position.y - sim.world.terrain.heightAt(ac.position.x, ac.position.z);
  ac.gLoad = 1 / Math.cos(bank);
}

/** One 120 Hz step of what the displays show: path, commands, sensors, fire control. */
function step(setup: Setup): void {
  const sim = setup.sim;
  fly(setup, STEP);
  guarded(setup, 'avionics commands', () => applyCommands(sim));
  guarded(setup, 'sensors', () => stepSensors(sim, STEP));
  guarded(setup, 'fire control', () => stepFireControl(sim, STEP));
  sim.time += STEP;
  sim.stepCount++;
}

function guarded(setup: Setup, what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    const text = `${what}: ${e instanceof Error ? e.message : String(e)}`;
    if (setup.errors[0] !== text) setup.errors.unshift(text);
    if (setup.errors.length > 6) setup.errors.length = 6;
  }
}

/** Run `n` steps holding the aircraft where it is (the scene settles). */
function settle(setup: Setup, n: number): void {
  const keep = ctl.path;
  ctl.path = 'hold';
  for (let i = 0; i < n; i++) step(setup);
  ctl.path = keep;
}

/** Put the sensors into a scene's state, through the avionics and sensors modules' own calls. */
function applyScene(setup: Setup, name: SceneName): void {
  const sim = setup.sim;
  const av = sim.avionics;
  const tgp = sim.sensors.tgp;
  ctl.scene = name;
  av.laserLatch = false;
  av.soi = soiFor(sim, ctl.soi);
  // The cockpit switches (the avionics' state; the sensors follow them every step).
  if (name === 'cold') {
    av.tgpPower = false;
    av.mavPower = false;
    av.laserArm = 'SAFE';
    av.masterArm = 'SAFE';
    settle(setup, 2);
    return;
  }
  av.masterArm = 'ARM';
  av.laserArm = 'ARM';
  // Power cycle: both start their warm-up / alignment now.
  av.tgpPower = false;
  av.mavPower = false;
  settle(setup, 2);
  av.tgpPower = true;
  av.mavPower = true;
  settle(setup, 2);
  if (name === 'warmup') return;

  // Attack: skip the warm-up and alignment, slave both to the SPI (the tank), point track,
  // the pod's point is the SPI, the laser latched, the Maverick locked.
  tgp.warmup = 0;
  for (const s of sim.sensors.mavericks) s.align = 0;
  settle(setup, 2);
  spiToSteerpoint(sim);
  guarded(setup, 'slave', () => {
    slaveTgpToSpi(sim);
    slaveMaverickToSpi(sim);
    setMaverickFov(sim, 'NARROW');
  });
  settle(setup, 240);
  guarded(setup, 'track', () => setTgpTrack(sim, 'POINT'));
  settle(setup, 12);
  // Make the pod's point the SPI (TMS forward long with the TGP page as the SOI).
  const left = av.mfd.left;
  av.mfd.left = 'TGP';
  av.soi = 'LMFD';
  guarded(setup, 'make SPI', () => makeSpi(sim));
  av.mfd.left = left;
  av.soi = soiFor(sim, ctl.soi);
  av.laserLatch = true;
  relock(setup);
  settle(setup, 12);
}

/** Attack scene: lock the Maverick on the tank when it is not (it may be out of range yet). */
function relock(setup: Setup): void {
  const sim = setup.sim;
  const i = sim.sensors.selectedMaverick;
  const s = i >= 0 ? sim.sensors.mavericks[i] : undefined;
  if (!s || !s.powered || s.align > 0 || s.locked) return;
  guarded(setup, 'lock', () => {
    slaveMaverickToSpi(sim);
    maverickLock(sim);
  });
}

/** The SOI asked for, if that display shows a page that can be the SOI; else the HUD. */
function soiFor(sim: Sim, soi: Soi): Soi {
  const page =
    soi === 'LMFD' ? sim.avionics.mfd.left : soi === 'RMFD' ? sim.avionics.mfd.right : null;
  return page === null || SOI_PAGES.includes(page) ? soi : 'HUD';
}

/** Show pages through the avionics (an SOI on a page that cannot hold it goes to the HUD). */
function showPages(sim: Sim, left: MfdPage, right: MfdPage): void {
  setMfdPage(sim, 'L', left);
  setMfdPage(sim, 'R', right);
}

/** Post one message of each level (the MSG page's colours). */
function sampleMessages(sim: Sim): void {
  sim.events.push(
    { type: 'message', t: sim.time, text: 'MASTER ARM SAFE', level: 'info' },
    { type: 'message', t: sim.time, text: 'MAV NOT LOCKED', level: 'warn' },
    { type: 'message', t: sim.time, text: 'CCIP INVALID', level: 'warn' },
    { type: 'message', t: sim.time, text: 'PULL UP', level: 'alert' },
  );
}

// ---------------------------------------------------------------------------------------------
// Layout (CSS pixels): two screens side by side, buttons around each
// ---------------------------------------------------------------------------------------------

const BTN = 28;
const GAP = 12;
const BEZEL = BTN + 2 * GAP;
const PANEL_W = 270;

interface ScreenRect {
  x: number;
  y: number;
  size: number;
}

function layoutScreens(width: number, height: number, ui: boolean): [ScreenRect, ScreenRect] {
  const free = width - (ui ? PANEL_W + 16 : 0) - 16;
  const size = Math.max(
    160,
    Math.min(MFD_RESOLUTION, Math.floor((free - 4 * BEZEL - 16) / 2), height - 2 * BEZEL - 40),
  );
  const top = 30 + BEZEL;
  const left = 8 + BEZEL;
  return [
    { x: left, y: top, size },
    { x: left + size + 2 * BEZEL + 16, y: top, size },
  ];
}

/** Centre of OSB `n` around a screen (CSS px). */
function buttonCentre(r: ScreenRect, n: number): { x: number; y: number } {
  const a = OSB_ANCHORS[n];
  const h = r.size / 2;
  const cx = r.x + h;
  const cy = r.y + h;
  const off = GAP + BTN / 2;
  if (n <= 5) return { x: cx + a.x * h, y: r.y - off };
  if (n <= 10) return { x: r.x + r.size + off, y: cy - a.y * h };
  if (n <= 15) return { x: cx + a.x * h, y: r.y + r.size + off };
  return { x: r.x - off, y: cy - a.y * h };
}

/** The screens' rectangles, read by the overlay pass. */
const screens: { rects: [ScreenRect, ScreenRect] } = {
  rects: [
    { x: 0, y: 0, size: 1 },
    { x: 0, y: 0, size: 1 },
  ],
};

// ---------------------------------------------------------------------------------------------
// Canvas pieces
// ---------------------------------------------------------------------------------------------

/** Steps the sandbox flight (sim priority) and hands the frame's messages to the displays. */
function Driver({ setup, mfd }: { setup: Setup; mfd: MfdRenderer }) {
  useFrame((_, delta) => {
    const sim = setup.sim;
    const dt = Math.min(delta, 0.1);
    const n = Math.max(1, Math.min(6, Math.round(dt / STEP)));
    for (let i = 0; i < n; i++) step(setup);
    if (
      ctl.scene === 'attack' &&
      Math.floor(sim.time * 2) !== Math.floor((sim.time - n * STEP) * 2)
    )
      relock(setup);
    const events: SimEvent[] = sim.events.slice();
    sim.events.length = 0;
    mfd.messages.addEvents(events);
    frameInfo.steps = n;
    frameInfo.alpha = 1;
    frameInfo.realDt = delta;
    frameInfo.simDt = n * STEP;
    notifySimFrame(events, sim, frameInfo);
  }, -100);
  return null;
}

/**
 * The world camera: from the aircraft toward the target (the terrain streams around it). With
 * `world=0` its far plane is 2 m, so the background costs nothing (headless screenshots).
 */
function WorldCamera({ setup }: { setup: Setup }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  useFrame(() => {
    const ac = setup.sim.aircraft;
    camera.position.copy(ac.position).y += 1.2;
    camera.lookAt(setup.target);
    const far = ctl.world ? 90000 : 2;
    if (camera.far !== far) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }, -20);
  return null;
}

/**
 * The displays: the composition pass (order 99, as in the cockpit) and an overlay pass that
 * shows both render targets flat on the screen (unlit, not tone-mapped: the page's colours).
 */
function Displays({ setup, mfd }: { setup: Setup; mfd: MfdRenderer }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const scene = new Scene();
    const camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);
    const quads = [mfd.left, mfd.right].map((d) => {
      const m = new Mesh(
        new PlaneGeometry(1, 1),
        new MeshBasicMaterial({ map: d.target.texture, toneMapped: false }),
      );
      scene.add(m);
      return m;
    });
    const offCompose = registerRenderPass({
      id: 'mfd',
      order: 99,
      render(ctx) {
        mfd.render(ctx.gl, setup.sim, ctx.dt, getA10Quality().sensorRate);
      },
    });
    const offOverlay = registerRenderPass({
      id: 'mfd-sandbox-overlay',
      order: 950,
      render(ctx) {
        const w = ctx.width;
        const h = ctx.height;
        camera.right = w;
        camera.top = h;
        camera.updateProjectionMatrix();
        const k = w / Math.max(1, gl.domElement.clientWidth);
        for (let i = 0; i < 2; i++) {
          const r = screens.rects[i];
          const q = quads[i];
          q.scale.set(r.size * k, r.size * k, 1);
          q.position.set((r.x + r.size / 2) * k, h - (r.y + r.size / 2) * k, 0);
        }
        ctx.gl.setRenderTarget(null);
        ctx.gl.autoClear = false;
        ctx.gl.clearDepth();
        ctx.gl.render(scene, camera);
      },
    });
    return () => {
      offCompose();
      offOverlay();
      for (const q of quads) {
        q.geometry.dispose();
        (q.material as MeshBasicMaterial).dispose();
      }
    };
  }, [gl, setup, mfd]);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Bezels and panel (HTML)
// ---------------------------------------------------------------------------------------------

const BUTTON: CSSProperties = {
  position: 'absolute',
  width: BTN,
  height: BTN,
  marginLeft: -BTN / 2,
  marginTop: -BTN / 2,
  padding: 0,
  border: '1px solid #4a4f53',
  borderRadius: 4,
  background: 'linear-gradient(#3a3e42, #24272a)',
  boxShadow: '0 1px 2px #000',
  cursor: 'pointer',
};

function Bezel(props: {
  rect: ScreenRect;
  display: 'L' | 'R';
  title: string;
  onPress: (display: 'L' | 'R', button: number) => void;
}) {
  const { rect, display, title, onPress } = props;
  const frame: CSSProperties = {
    position: 'absolute',
    left: rect.x - BEZEL,
    top: rect.y - BEZEL,
    width: rect.size + 2 * BEZEL,
    height: rect.size + 2 * BEZEL,
    boxSizing: 'border-box',
    border: `${BEZEL}px solid #1b1d1f`,
    borderRadius: 10,
    boxShadow: '0 0 0 1px #3b3f43, 0 4px 18px rgba(0,0,0,0.6)',
    pointerEvents: 'none',
  };
  const buttons = [];
  for (let n = 1; n <= 20; n++) {
    const c = buttonCentre(rect, n);
    buttons.push(
      <button
        key={n}
        type="button"
        title={`OSB ${n}`}
        aria-label={`${title} OSB ${n}`}
        data-osb={`${display}${n}`}
        style={{ ...BUTTON, left: c.x, top: c.y }}
        onClick={() => onPress(display, n)}
      />,
    );
  }
  return (
    <>
      <div style={frame} />
      <div
        style={{
          position: 'absolute',
          left: rect.x,
          top: rect.y - BEZEL - 22,
          width: rect.size,
          textAlign: 'center',
          color: '#9aa39a',
          font: '12px ui-monospace, monospace',
        }}
      >
        {title}
      </div>
      {buttons}
    </>
  );
}

const PANEL: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  width: PANEL_W,
  maxHeight: 'calc(100% - 16px)',
  overflowY: 'auto',
  padding: '8px 10px',
  background: 'rgba(10, 14, 12, 0.86)',
  color: '#d6e2d6',
  font: '12px/1.4 system-ui, sans-serif',
  borderRadius: 6,
  boxSizing: 'border-box',
};

function Row(props: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: 6, margin: '2px 0' }}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function Panel({ setup, mfd }: { setup: Setup; mfd: MfdRenderer }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((v) => v + 1), 250);
    return () => window.clearInterval(id);
  }, []);
  const sim = setup.sim;
  const av = sim.avionics;
  const tgp = sim.sensors.tgp;
  const i = sim.sensors.selectedMaverick;
  const mav = i >= 0 ? sim.sensors.mavericks[i] : undefined;
  const pic = (name: 'TGP' | 'MAV') => {
    const p = getSensorPicture(name);
    return p ? `${p.status}${p.valid ? '' : ' (no video)'} #${p.frame}` : 'none';
  };
  const select = (value: string, options: readonly string[], set: (v: string) => void) => (
    <select value={value} onChange={(e) => set(e.target.value)} style={{ minWidth: 0 }}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
  return (
    <div style={PANEL}>
      <div style={{ color: '#9fdca8', marginBottom: 4 }}>MFD sandbox</div>
      <Row label="left page">
        {select(av.mfd.left, PAGES, (v) => setMfdPage(sim, 'L', v as MfdPage))}
      </Row>
      <Row label="right page">
        {select(av.mfd.right, PAGES, (v) => setMfdPage(sim, 'R', v as MfdPage))}
      </Row>
      <Row label="SOI">
        {select(av.soi, ['HUD', 'LMFD', 'RMFD'], (v) =>
          sim.commands.push({ type: 'soi', value: v as Soi }),
        )}
      </Row>
      <Row label="path">
        {select(ctl.path, ['run', 'orbit', 'hold'], (v) => {
          ctl.path = v as PathName;
        })}
      </Row>
      <Row label="scene">
        {select(ctl.scene, ['attack', 'warmup', 'cold'], (v) => applyScene(setup, v as SceneName))}
      </Row>
      <Row label="Master Arm">
        {select(av.masterArm, ['SAFE', 'TRAIN', 'ARM'], (v) =>
          sim.commands.push({ type: 'masterArm', value: v as MasterArm }),
        )}
      </Row>
      <Row label="laser">
        {select(av.laserArm, ['SAFE', 'TRAIN', 'ARM'], (v) =>
          sim.commands.push({ type: 'laserArm', value: v as LaserArm }),
        )}
      </Row>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0' }}>
        <button
          type="button"
          onClick={() => {
            tgp.warmup = 0;
            for (const s of sim.sensors.mavericks) s.align = 0;
          }}
        >
          skip warm-up
        </button>
        <button type="button" onClick={() => sampleMessages(sim)}>
          post messages
        </button>
        <label>
          <input
            type="checkbox"
            defaultChecked={sim.options.realism.mapMarkers}
            onChange={(e) => {
              sim.options.realism.mapMarkers = e.target.checked;
              mfd.invalidate();
            }}
          />{' '}
          map markers
        </label>
      </div>
      <div style={{ font: '11px/1.45 ui-monospace, monospace', color: '#b8c4b8' }}>
        <div>
          L {av.mfd.left} draws {mfd.left.draws} strokes {mfd.left.info.strokes}
        </div>
        <div>
          R {av.mfd.right} draws {mfd.right.draws} strokes {mfd.right.info.strokes}
        </div>
        <div>
          TGP {tgp.powered ? (tgp.warmup > 0 ? `warm ${Math.ceil(tgp.warmup)}s` : tgp.mode) : 'off'}
          {tgp.lasing ? ' LASING' : ''} {tgp.masked ? 'MASKED' : ''} · {pic('TGP')}
        </div>
        <div>
          MAV{' '}
          {mav
            ? `${mav.type} sta ${mav.station} ${mav.powered ? (mav.align > 0 ? `align ${Math.ceil(mav.align)}s` : mav.locked ? 'LOCK' : 'search') : 'off'}${mav.inZone ? ' IN ZONE' : ''}`
            : 'none'}{' '}
          · {pic('MAV')}
        </div>
        <div>
          SPI {av.spi.valid ? av.spi.source : '—'} · range{' '}
          {(sim.aircraft.position.distanceTo(setup.target) / NM).toFixed(1)} nm
        </div>
        {setup.errors.map((e) => (
          <div key={e} style={{ color: '#ff8a7a' }}>
            {e}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export default function MfdSandbox() {
  const [terrain, setTerrain] = useState<Terrain | null>(getTerrain);
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const quality = (params.get('quality') as QualityLevel | null) ?? 'low';
  const ui = params.get('ui') !== '0';

  useEffect(() => {
    useA10Store.getState().updateSettings({ quality });
    const seed = Number(params.get('seed'));
    void prepareWorld(
      Number.isFinite(seed) && seed > 0 ? seed : useA10Store.getState().settings.worldSeed,
    );
    return onTerrain(setTerrain);
  }, [quality]);

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setup = useMemo(() => (terrain ? buildSetup(terrain) : null), [terrain]);
  const mfd = useMemo(() => new MfdRenderer(), []);
  useEffect(() => () => mfd.dispose(), [mfd]);

  const rects = layoutScreens(size.w, size.h, ui);
  screens.rects = rects;

  useEffect(() => {
    if (!setup) return;
    setViewSimSource(() => setup.sim);
    setSensorViewSim(() => setup.sim);
    const sim = setup.sim;
    const w = window as unknown as { __MFD_SANDBOX__?: unknown };
    w.__MFD_SANDBOX__ = {
      sim,
      mfd,
      errors: setup.errors,
      press: (display: 'L' | 'R', button: number) =>
        sim.commands.push({ type: 'osb', display, button }),
      pages: (left: MfdPage, right: MfdPage, soi?: Soi) => {
        showPages(sim, left, right);
        if (soi) sim.avionics.soi = soiFor(sim, soi);
      },
      scene: (name: SceneName) => applyScene(setup, name),
      messages: () => sampleMessages(sim),
      /** Terrain loaded, both displays drawn, and the sensor pages' pictures settled. */
      ready: () => {
        const settled = (name: 'TGP' | 'MAV') => {
          const p = getSensorPicture(name);
          return !!p && p.frame > 3 && (p.agcSettled || p.status !== 'OK');
        };
        const pages = [sim.avionics.mfd.left, sim.avionics.mfd.right];
        return (
          terrainStreaming.pending === 0 &&
          terrainStreaming.tiles > 0 &&
          mfd.left.draws > 2 &&
          mfd.right.draws > 2 &&
          (!pages.includes('TGP') || settled('TGP')) &&
          (!pages.includes('MAV') || settled('MAV'))
        );
      },
    };
    return () => {
      setViewSimSource(null);
      setSensorViewSim(null);
      delete w.__MFD_SANDBOX__;
    };
  }, [setup, mfd]);

  const press = (display: 'L' | 'R', button: number) => {
    setup?.sim.commands.push({ type: 'osb', display, button });
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
      <Canvas
        dpr={quality === 'low' ? [1, 1] : [1, 1.5]}
        gl={{ antialias: true, stencil: true }}
        camera={{ fov: 40, near: 1, far: 90000, position: [0, 3000, 0] }}
      >
        <Environment />
        <TerrainView />
        <VehiclesView />
        <SensorsView />
        {setup && <Driver setup={setup} mfd={mfd} />}
        {setup && <WorldCamera setup={setup} />}
        {setup && <Displays setup={setup} mfd={mfd} />}
        <RenderPipeline />
      </Canvas>
      {setup ? (
        <>
          <Bezel rect={rects[0]} display="L" title="LEFT MFCD" onPress={press} />
          <Bezel rect={rects[1]} display="R" title="RIGHT MFCD" onPress={press} />
        </>
      ) : (
        <div style={{ position: 'absolute', left: 16, top: 16, color: '#9aa39a' }}>
          generating the world…
        </div>
      )}
      {setup && ui && <Panel setup={setup} mfd={mfd} />}
    </div>
  );
}
