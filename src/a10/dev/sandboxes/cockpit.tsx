/**
 * Cockpit sandbox — /a10/?sandbox=cockpit (dev server). The real cockpit (CockpitView's
 * useCockpit), camera rig (useCameraRig) and HUD pass over a fake flight whose state the panel
 * sets: attitude, air data, engines, fuel, rounds, stick and levers, switches, lamps, g, and the
 * head pose (look angles, zoom). The sky and light are the real environment's (time of day); the
 * ground is a flat field pattern. Tick "click switches" to free the cursor: the hovered control
 * is highlighted and a click queues its command, which the sandbox applies to the fake flight.
 *
 * URL (all optional, for screenshots):
 *   look=<az>,<el>  head look, degrees (+ right, + up)   fov=<deg>   time=<hours>
 *   preset=cruise|dive|turn|landing|dusk|warnings        view=cockpit|chase|flyby|orbit
 *   shadows=0|1     arm=1   g=<load>   vision=<0..1>     ui=0 (no panel)   cursor=x,y (NDC hover)
 */
import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  CanvasTexture,
  Color,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Raycaster,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { loadAircraftModels } from '../../assets';
import { applyCommands } from '../../core/avionics';
import { bodyDirFromHudAngles, quaternionFromAttitude } from '../../core/frames';
import { createSim } from '../../core/sim';
import type { Sim } from '../../core/types';
import { DEG, FT, KT, LB } from '../../core/units';
import { createFlatTerrain } from '../../core/world';
import { tasFromCas } from '../../core/world/atmosphere';
import { A10_GEOMETRY } from '../../data/geometry';
import type { AltSource, GunPacSwitch, LaserArm, MasterArm, MasterMode } from '../../core/avionics/types';
import { viewInput } from '../../input/viewInput';
import { useA10Store, type ViewMode } from '../../state/store';
import { useCameraRig, cameraRigHandle } from '../../view/cockpit/CameraRig';
import { cockpitHandle, useCockpit } from '../../view/cockpit/CockpitView';
import Environment from '../../view/environment/Environment';
import { environmentOverrides } from '../../view/environment/envState';
import { A10_PRIORITY } from '../../view/frame';
import { useHudPass } from '../../view/hud/HudView';
import RenderPipeline from '../../view/RenderPipeline';

// ---------------------------------------------------------------------------------------------
// Parameters (mutated by the panel, read every frame)
// ---------------------------------------------------------------------------------------------

interface Params {
  headAz: number;
  headEl: number;
  manualHead: boolean;
  fov: number;
  headingDeg: number;
  pitchDeg: number;
  bankDeg: number;
  alphaDeg: number;
  iasKt: number;
  altFt: number;
  vsFpm: number;
  g: number;
  lateralG: number;
  n1: number;
  n2: number;
  itt: number;
  fuelFlowPph: number;
  fuelLb: number;
  rounds: number;
  throttle: number;
  stickPitch: number;
  stickRoll: number;
  rudder: number;
  flaps: number;
  gearDown: boolean;
  masterArm: MasterArm;
  gunPac: GunPacSwitch;
  mode: MasterMode;
  laserArm: LaserArm;
  tgp: boolean;
  altSource: AltSource;
  autopilot: boolean;
  altAlertFt: number;
  caution: boolean;
  hours: number;
  shadows: boolean;
  clickMode: boolean;
  vision: number;
  view: ViewMode;
}

const DEFAULTS: Params = {
  headAz: 0,
  headEl: -9,
  manualHead: true,
  fov: 50,
  headingDeg: 35,
  pitchDeg: 2,
  bankDeg: 0,
  alphaDeg: 4,
  iasKt: 250,
  altFt: 8000,
  vsFpm: 0,
  g: 1,
  lateralG: 0,
  n1: 78,
  n2: 88,
  itt: 720,
  fuelFlowPph: 2200,
  fuelLb: 6600,
  rounds: 1150,
  throttle: 0.85,
  stickPitch: 0,
  stickRoll: 0,
  rudder: 0,
  flaps: 0,
  gearDown: false,
  masterArm: 'SAFE',
  gunPac: 'ARM',
  mode: 'NAV',
  laserArm: 'SAFE',
  tgp: true,
  altSource: 'DELTA',
  autopilot: false,
  altAlertFt: 0,
  caution: false,
  hours: 10.5,
  shadows: true,
  clickMode: false,
  vision: -1,
  view: 'cockpit',
};

const PRESETS: Record<string, Partial<Params>> = {
  cruise: {},
  dive: {
    pitchDeg: -30,
    alphaDeg: 2.5,
    iasKt: 320,
    altFt: 3500,
    vsFpm: -16000,
    mode: 'GUNS',
    masterArm: 'ARM',
    rounds: 1088,
    n1: 70,
    n2: 85,
    itt: 650,
  },
  turn: { bankDeg: 60, pitchDeg: 4, alphaDeg: 10, g: 4.5, iasKt: 280, lateralG: 0.06 },
  landing: {
    gearDown: true,
    flaps: 2,
    alphaDeg: 8,
    iasKt: 125,
    altFt: 1200,
    vsFpm: -700,
    pitchDeg: 3,
    throttle: 0.6,
    n1: 60,
    n2: 80,
    itt: 560,
  },
  dusk: { hours: 19.3, headingDeg: 270 },
  warnings: { caution: true, fuelLb: 900, masterArm: 'ARM', gunPac: 'ARM', mode: 'GUNS' },
};

function initialParams(): Params {
  const p: Params = { ...DEFAULTS };
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  Object.assign(p, PRESETS[q.get('preset') ?? 'cruise'] ?? {});
  const look = q.get('look')?.split(',').map(Number);
  if (look && look.length === 2 && look.every(Number.isFinite)) [p.headAz, p.headEl] = look;
  const num = (k: string) => {
    const v = q.get(k);
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  p.fov = num('fov') ?? p.fov;
  p.hours = num('time') ?? p.hours;
  p.g = num('g') ?? p.g;
  p.vision = num('vision') ?? p.vision;
  if (q.get('shadows') === '0') p.shadows = false;
  if (q.get('arm') === '1') {
    p.masterArm = 'ARM';
    p.mode = 'GUNS';
  }
  const v = q.get('view');
  if (v === 'cockpit' || v === 'chase' || v === 'flyby' || v === 'orbit') p.view = v;
  return p;
}

const P: Params = initialParams();
// scripted screenshots: window.__cockpitSandbox.set({ headAz: -90 })
if (typeof window !== 'undefined')
  (window as unknown as { __cockpitSandbox: unknown }).__cockpitSandbox = {
    params: P,
    set: (patch: Partial<Params>) => Object.assign(P, patch),
    preset: (name: string) => Object.assign(P, DEFAULTS, PRESETS[name] ?? {}),
    cockpit: () => cockpitHandle.current,
    sim: () => fakeSim,
    /** What the eye sees in a direction (degrees): the nearest cockpit surface. */
    probe: (azDeg: number, elDeg: number) => {
      const m = cockpitHandle.current;
      if (!m) return null;
      const e = A10_GEOMETRY.eye;
      const dir = bodyDirFromHudAngles(azDeg * DEG, elDeg * DEG, new Vector3());
      const rc = new Raycaster(new Vector3(e.x, e.y, e.z), dir, 0.05, 3);
      const hit = rc
        .intersectObjects([m.root, m.airframe.root, m.box.group], true)
        .find((h) => isShown(h.object));
      if (!hit) return null;
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
      const r = (v: number) => Math.round(v * 1000) / 1000;
      return {
        p: [r(hit.point.x), r(hit.point.y), r(hit.point.z)],
        n: n ? [r(n.x), r(n.y), r(n.z)] : null,
        o: hit.object.name,
        d: r(hit.distance),
      };
    },
  };
function isShown(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

const SHOW_UI = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('ui') !== '0';
const CURSOR = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
  .get('cursor')
  ?.split(',')
  .map(Number);

// ---------------------------------------------------------------------------------------------
// The fake flight
// ---------------------------------------------------------------------------------------------

const TERRAIN = createFlatTerrain(0);
let fakeSim: Sim | null = null;
const getFakeSim = (): Sim | null => fakeSim;
const _dir = new Vector3();

function createFakeSim(): Sim {
  const sim = createSim({
    terrain: TERRAIN,
    scenario: 'empty',
    seed: 11,
    start: { x: 0, z: 0, agl: 2400, heading: 0, speed: 130 },
  });
  sim.avionics.steerpoints.length = 0;
  sim.avionics.steerpoints.push({ id: 1, name: 'TGT1', position: new Vector3(6000, 0, -9000) });
  sim.avionics.activeSteerpoint = 0;
  return sim;
}

/** Write the panel into the fake flight (no flight model: the cockpit only reads it). */
function applyParams(sim: Sim, dt: number): void {
  const ac = sim.aircraft;
  const av = sim.avionics;
  sim.time += dt;
  const alt = P.altFt * FT;
  // fly along the velocity so the outside views have something to follow
  ac.position.addScaledVector(ac.velocity, dt);
  ac.position.y = alt;
  if (Math.abs(ac.position.x) > 20000 || Math.abs(ac.position.z) > 20000) ac.position.set(0, alt, 0);
  quaternionFromAttitude(P.headingDeg * DEG, P.pitchDeg * DEG, P.bankDeg * DEG, ac.orientation);
  ac.heading = (((P.headingDeg % 360) + 360) % 360) * DEG;
  ac.pitch = P.pitchDeg * DEG;
  ac.bank = P.bankDeg * DEG;
  const tas = tasFromCas(P.iasKt * KT, alt);
  bodyDirFromHudAngles(0, -P.alphaDeg * DEG, _dir).applyQuaternion(ac.orientation);
  ac.velocity.copy(_dir).multiplyScalar(tas);
  ac.tas = tas;
  ac.ias = P.iasKt * KT;
  ac.alpha = P.alphaDeg * DEG;
  ac.altitude = alt;
  ac.agl = alt;
  ac.verticalSpeed = (P.vsFpm * FT) / 60;
  ac.gLoad = P.g;
  ac.lateralG = P.lateralG;
  ac.fuel = P.fuelLb * LB;
  for (const e of ac.engines) {
    e.n1 = P.n1 / 100;
    e.n2 = P.n2 / 100;
    e.itt = P.itt;
    e.fuelFlow = (P.fuelFlowPph * LB) / 3600;
    e.lever = P.throttle;
  }
  sim.input.throttle[0] = sim.input.throttle[1] = P.throttle;
  sim.input.pitch = P.stickPitch;
  sim.input.roll = P.stickRoll;
  sim.input.rudder = P.rudder;
  ac.flapHandle = Math.round(P.flaps) as 0 | 1 | 2;
  ac.surfaces.flaps = [0, 7, 20][ac.flapHandle] * DEG;
  ac.gearDown = P.gearDown;
  ac.gearPosition = P.gearDown ? 1 : 0;
  ac.warnings.masterCaution = P.caution;
  ac.autopilot.engaged = P.autopilot;
  ac.altitudeAlert = P.altAlertFt * FT;
  sim.gun.rounds = P.rounds;
  sim.world.timeOfDay = P.hours;
  av.masterArm = P.masterArm;
  av.gunPac = P.gunPac;
  av.masterMode = P.mode;
  av.laserArm = P.laserArm;
  av.tgpPower = P.tgp;
  av.altSource = P.altSource;
}

/** Mirror the switches the (stand-in) avionics changed for a click into the panel. */
function readBack(sim: Sim): void {
  const av = sim.avionics;
  P.masterArm = av.masterArm;
  P.gunPac = av.gunPac;
  P.mode = av.masterMode;
  P.flaps = sim.aircraft.flapHandle;
}

/** Commands the stand-in avionics do not handle yet (laser, TGP, ALT SCE, gear, AP, alert). */
function applyExtraCommands(sim: Sim): void {
  for (const c of sim.commands) {
    switch (c.type) {
      case 'laserArm':
        P.laserArm = c.value === 'cycle' ? 'ARM' : c.value;
        break;
      case 'tgpPower':
        P.tgp = c.value === 'toggle' ? !P.tgp : c.value;
        break;
      case 'altSource':
        P.altSource = c.value === 'cycle' ? 'BARO' : c.value;
        break;
      case 'gear':
        P.gearDown = c.value === 'toggle' ? !P.gearDown : c.value;
        break;
      case 'autopilot':
        if (c.action === 'toggle') P.autopilot = !P.autopilot;
        else if (c.action === 'disengage') P.autopilot = false;
        else {
          const modes = ['PATH', 'ALT_HDG', 'ALT'] as const;
          const ap = sim.aircraft.autopilot;
          ap.mode = modes[(modes.indexOf(ap.mode) + 1) % modes.length];
        }
        break;
      case 'altitudeAlert':
        P.altAlertFt = Math.round(c.value / FT);
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Scene pieces
// ---------------------------------------------------------------------------------------------

function fieldTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const greens = ['#4f5a33', '#5d6a3a', '#6b6a3e', '#4a5530', '#73704a', '#56603a'];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = greens[(x * 7 + y * 3 + ((x * y) % 5)) % greens.length];
      ctx.fillRect(x * 64, y * 64, 64, 64);
    }
  ctx.strokeStyle = '#8a8270';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 256);
  ctx.lineTo(512, 256);
  ctx.moveTo(256, 0);
  ctx.lineTo(256, 512);
  ctx.stroke();
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(300, 300);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function Ground() {
  const mesh = useMemo(() => {
    const g = new PlaneGeometry(240000, 240000).rotateX(-Math.PI / 2);
    const m = new MeshStandardMaterial({ color: new Color(1, 1, 1), map: fieldTexture(), roughness: 1 });
    return new Mesh(g, m);
  }, []);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      const m = mesh.material as MeshStandardMaterial;
      m.map?.dispose();
      m.dispose();
    },
    [mesh],
  );
  return <primitive object={mesh} />;
}

/** Writes the fake flight before the camera rig places the cameras. */
function SandboxDriver() {
  useFrame((_s, delta) => {
    const sim = fakeSim;
    if (!sim) return;
    // clicks queued commands: the stand-in avionics apply theirs, the sandbox the rest
    if (sim.commands.length > 0) {
      applyExtraCommands(sim);
      applyCommands(sim);
      readBack(sim);
    }
    applyParams(sim, Math.min(0.05, delta));
    environmentOverrides.timeOfDay = P.hours;
    const store = useA10Store.getState();
    if (store.view !== P.view) store.setView(P.view);
    const base = Math.max(30, P.fov);
    if (store.settings.fov !== base) store.overrideSettings({ fov: base });
    const quality = P.shadows ? 'medium' : 'low';
    if (store.settings.quality !== quality) store.overrideSettings({ quality });
    const rig = cameraRigHandle.current;
    if (rig) {
      if (P.manualHead) rig.setLook(P.headAz, P.headEl);
      rig.fovOverride = P.manualHead ? P.fov : null;
    }
    viewInput.cursorFree = P.clickMode || !!CURSOR;
    if (CURSOR && CURSOR.length === 2) {
      viewInput.pointerX = CURSOR[0];
      viewInput.pointerY = CURSOR[1];
    }
  }, A10_PRIORITY.systems);
  // a forced vision level for screenshots (after the cockpit stepped it)
  useFrame(() => {
    const v = cockpitHandle.vision;
    if (v && P.vision >= 0) v.level = P.vision;
  }, 0);
  return null;
}

function CockpitLayer() {
  useCameraRig(getFakeSim);
  useCockpit(getFakeSim);
  useHudPass(getFakeSim);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

const PANEL: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  width: 300,
  maxHeight: 'calc(100vh - 16px)',
  overflowY: 'auto',
  background: 'rgba(12,16,14,0.86)',
  color: '#d6e2d8',
  font: '12px/1.35 system-ui, sans-serif',
  padding: 8,
  borderRadius: 6,
};

function Slider(props: { label: string; k: keyof Params; min: number; max: number; step?: number }) {
  const [v, setV] = useState(P[props.k] as number);
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '108px 1fr 52px', gap: 6, alignItems: 'center' }}>
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value);
          (P as unknown as Record<string, number>)[props.k] = n;
          setV(n);
        }}
      />
      <span style={{ textAlign: 'right' }}>{v}</span>
    </label>
  );
}

function Choice<T extends string | number>(props: { label: string; k: keyof Params; options: T[] }) {
  const [v, setV] = useState(String(P[props.k]));
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '108px 1fr', gap: 6 }}>
      <span>{props.label}</span>
      <select
        value={v}
        onChange={(e) => {
          const o = props.options.find((x) => String(x) === e.target.value);
          (P as unknown as Record<string, unknown>)[props.k] = o;
          setV(e.target.value);
        }}
      >
        {props.options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Check(props: { label: string; k: keyof Params }) {
  const [v, setV] = useState(P[props.k] as boolean);
  return (
    <label style={{ display: 'inline-flex', gap: 4, marginRight: 10 }}>
      <input
        type="checkbox"
        checked={v}
        onChange={(e) => {
          (P as unknown as Record<string, boolean>)[props.k] = e.target.checked;
          setV(e.target.checked);
        }}
      />
      {props.label}
    </label>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <fieldset style={{ border: '1px solid #33403a', borderRadius: 4, margin: '6px 0', padding: 6 }}>
      <legend style={{ padding: '0 4px', color: '#9fdca8' }}>{props.title}</legend>
      <div style={{ display: 'grid', gap: 3 }}>{props.children}</div>
    </fieldset>
  );
}

function Panel() {
  const [version, setVersion] = useState(0);
  const preset = (name: string) => {
    Object.assign(P, DEFAULTS, PRESETS[name]);
    setVersion((v) => v + 1);
  };
  const m = cockpitHandle.current;
  return (
    <div style={PANEL} key={version}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
        {Object.keys(PRESETS).map((n) => (
          <button key={n} type="button" onClick={() => preset(n)}>
            {n}
          </button>
        ))}
      </div>
      <Section title="Head and view">
        <div>
          <Check label="panel sets the head" k="manualHead" />
          <Check label="click switches" k="clickMode" />
        </div>
        <Slider label="look az °" k="headAz" min={-155} max={155} />
        <Slider label="look el °" k="headEl" min={-75} max={89} />
        <Slider label="fov °" k="fov" min={20} max={90} />
        <Choice label="view" k="view" options={['cockpit', 'chase', 'flyby', 'orbit', 'weapon', 'target']} />
        <Slider label="time of day h" k="hours" min={4} max={21} step={0.1} />
        <div>
          <Check label="shadows (Medium)" k="shadows" />
        </div>
        <Slider label="vision (−1 auto)" k="vision" min={-1} max={1} step={0.05} />
      </Section>
      <Section title="Flight">
        <Slider label="heading °" k="headingDeg" min={0} max={359} />
        <Slider label="pitch °" k="pitchDeg" min={-60} max={60} />
        <Slider label="bank °" k="bankDeg" min={-180} max={180} />
        <Slider label="alpha °" k="alphaDeg" min={-4} max={25} step={0.5} />
        <Slider label="IAS kt" k="iasKt" min={0} max={550} />
        <Slider label="altitude ft" k="altFt" min={0} max={30000} step={10} />
        <Slider label="VS fpm" k="vsFpm" min={-8000} max={8000} step={50} />
        <Slider label="g" k="g" min={-5} max={10} step={0.1} />
        <Slider label="lateral g" k="lateralG" min={-0.5} max={0.5} step={0.01} />
      </Section>
      <Section title="Engines and fuel">
        <Slider label="fan N1 %" k="n1" min={0} max={100} />
        <Slider label="core N2 %" k="n2" min={0} max={105} />
        <Slider label="ITT °C" k="itt" min={0} max={1100} step={5} />
        <Slider label="fuel flow pph" k="fuelFlowPph" min={0} max={5000} step={50} />
        <Slider label="fuel lb" k="fuelLb" min={0} max={11000} step={10} />
        <Slider label="rounds" k="rounds" min={0} max={1174} />
      </Section>
      <Section title="Controls">
        <Slider label="throttles" k="throttle" min={0} max={1} step={0.01} />
        <Slider label="stick pitch" k="stickPitch" min={-1} max={1} step={0.02} />
        <Slider label="stick roll" k="stickRoll" min={-1} max={1} step={0.02} />
        <Slider label="pedals" k="rudder" min={-1} max={1} step={0.02} />
        <Choice label="flaps" k="flaps" options={[0, 1, 2]} />
        <div>
          <Check label="gear down" k="gearDown" />
          <Check label="autopilot" k="autopilot" />
          <Check label="master caution" k="caution" />
        </div>
      </Section>
      <Section title="Switches">
        <Choice label="Master Arm" k="masterArm" options={['SAFE', 'TRAIN', 'ARM']} />
        <Choice label="GUN/PAC" k="gunPac" options={['SAFE', 'GUNARM', 'ARM']} />
        <Choice label="master mode" k="mode" options={['NAV', 'GUNS', 'CCIP', 'CCRP']} />
        <Choice label="laser" k="laserArm" options={['SAFE', 'TRAIN', 'ARM']} />
        <Choice label="ALT SCE" k="altSource" options={['BARO', 'DELTA', 'RADAR']} />
        <Choice label="alt alert ft" k="altAlertFt" options={[0, 200, 500, 1000, 1500, 2000]} />
        <div>
          <Check label="TGP power" k="tgp" />
        </div>
      </Section>
      {m && (
        <div style={{ opacity: 0.7 }}>
          {m.driver.counts.pivots} pivots · {m.driver.counts.drums} drums · {m.driver.counts.toggles}{' '}
          lamps · {m.targets.length} clickable
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export default function CockpitSandbox() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fakeSim = createFakeSim();
    loadAircraftModels().then(
      () => setReady(true),
      (e: unknown) => setError(String(e)),
    );
    return () => {
      fakeSim = null;
      environmentOverrides.timeOfDay = null;
    };
  }, []);
  return (
    <div className="a10-app">
      <Canvas
        dpr={[1, 1.5]}
        gl={{ antialias: true, stencil: true }}
        camera={{ fov: 50, near: 1, far: 90000, position: [0, 3000, 0] }}
      >
        <SandboxDriver />
        <Environment />
        <Ground />
        {ready && <CockpitLayer />}
        <RenderPipeline />
      </Canvas>
      {error && <div style={{ ...PANEL, color: '#f88' }}>{error}</div>}
      {!ready && !error && <div style={{ ...PANEL, left: 8, right: 'auto' }}>Loading the cockpit…</div>}
      {SHOW_UI && ready && <Panel />}
    </div>
  );
}
