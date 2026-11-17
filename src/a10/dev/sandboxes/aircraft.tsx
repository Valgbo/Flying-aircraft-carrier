/**
 * Aircraft sandbox — /a10/?sandbox=aircraft (dev server). The converted FlightGear A-10 under an
 * orbit camera, with a slider for every animated channel, a loadout selector and the liveries.
 *
 * URL (all optional, for screenshots):
 *   cam=front|rear|left|right|below|top|nose|gear|tail|far|leftWing|rightWing|leftInboard|cockpit: orbit
 *       start (cockpit: the forCockpit instance from the eye point)
 *   elev, ail, rud (−1..1) · flaps (deg) · slats, sb, gear, n1, canopy (0..1) · gun (rad/s)
 *   loadout=<a core/weapons LOADOUTS id>|clean|bombs|racks|pods · livery=default|usaf-low-vis|acc
 *   time=<hours> (lights below dusk) · ui=0 (no panel) · ground=0
 */
import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Color, Fog, Vector3, type PerspectiveCamera } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { LOADOUTS as SIM_LOADOUTS } from '../../core/weapons';
import type { StationState, StoreType } from '../../core/weapons/types';
import {
  applyAircraftVisualState,
  createAircraftInstance,
  createCockpitModel,
  createVisualState,
  disposeAircraftInstance,
  loadAircraftModels,
  setAircraftLivery,
  setAircraftShadows,
  updateAircraftDetail,
  type AircraftInstance,
  type AircraftTemplates,
} from '../../assets';
import { A10_GEOMETRY } from '../../data/geometry';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(q.get(k));
  return q.has(k) && Number.isFinite(v) ? v : d;
};

/** Station lists, rack or launcher first, like the simulation's presets (core/weapons LOADOUTS). */
type Loadout = Record<number, StoreType[]>;
/** More store types than the simulation's presets carry. */
const EXTRA_LOADOUTS: Record<string, Loadout> = {
  clean: {},
  bombs: {
    3: ['MK-82'],
    4: ['MK-82AIR'],
    5: ['GBU-12'],
    7: ['GBU-12'],
    8: ['MK-82AIR'],
    9: ['MK-82'],
  },
  racks: {
    1: ['LAU-114', 'AIM-9M', 'AIM-9M'],
    3: ['TER-9A', 'MK-82', 'MK-82', 'MK-82'],
    4: ['CBU-97'],
    8: ['CBU-97'],
    9: ['LAU-88', 'AGM-65D', 'AGM-65H', 'AGM-65D'],
    11: ['LAU-114', 'AIM-9M', 'AIM-9M'],
  },
  pods: {
    2: ['LAU-68-M151'],
    3: ['AN/AAQ-28'],
    4: ['LAU-131-M156'],
    8: ['LAU-131-M156'],
    9: ['LAU-117', 'AGM-65K'],
    10: ['LAU-68-M151'],
    11: ['AN/ALQ-184'],
  },
};
const LOADOUTS: Record<string, Loadout> = {
  ...Object.fromEntries(Object.entries(SIM_LOADOUTS).map(([id, l]) => [id, l.stations])),
  ...EXTRA_LOADOUTS,
};
const RACKS = new Set<string>(['TER-9A', 'LAU-88', 'LAU-117', 'LAU-114']);

/** The simulation's station state for a loadout (the rack, then what it carries). */
function stationsOf(l: Loadout): StationState[] {
  const out: StationState[] = [];
  for (let s = 1; s <= 11; s++) {
    const list = l[s] ?? [];
    const rack = list.length > 0 && RACKS.has(list[0]) ? list[0] : null;
    out.push({ station: s, rack, stores: rack ? list.slice(1) : [...list] });
  }
  return out;
}

interface Params {
  elevator: number;
  aileron: number;
  rudder: number;
  flapsDeg: number;
  slats: number;
  speedBrake: number;
  gear: number;
  n1: number;
  canopy: number;
  gunRate: number;
  loadout: string;
  livery: string;
  hour: number;
}

const params: Params = {
  elevator: num('elev', 0),
  aileron: num('ail', 0),
  rudder: num('rud', 0),
  flapsDeg: num('flaps', 0),
  slats: num('slats', 0),
  speedBrake: num('sb', 0),
  gear: num('gear', 0),
  n1: num('n1', 0.6),
  canopy: num('canopy', 0),
  gunRate: num('gun', 0),
  loadout: q.get('loadout') ?? 'tankHunter',
  livery: q.get('livery') ?? 'default',
  hour: num('time', 11),
};

const CAMS: Record<
  string,
  { pos: [number, number, number]; target: [number, number, number]; fov?: number }
> = {
  front: { pos: [-11, 3.2, -15], target: [0, 0, -0.5] },
  rear: { pos: [12, 4.5, 15], target: [0, 0.3, 0.5] },
  left: { pos: [-21, 1.5, 0.5], target: [0, 0, 0] },
  right: { pos: [21, 2, -1], target: [0, 0, 0] },
  below: { pos: [-7, -9, -6], target: [0, -0.8, 0] },
  top: { pos: [0.01, 24, 2], target: [0, 0, 0.5] },
  nose: { pos: [-3.2, -0.6, -11], target: [0, -0.4, -6.5], fov: 40 },
  gear: { pos: [-6.5, -1.6, -3.5], target: [-2.4, -1.6, 0.4], fov: 45 },
  tail: { pos: [-6, 3.5, 15.5], target: [0, 1.0, 7.5], fov: 45 },
  far: { pos: [-70, 25, -120], target: [0, 0, 0], fov: 35 },
  rightWing: { pos: [9.5, -1.6, -9], target: [5.2, -0.8, -0.5], fov: 45 },
  leftWing: { pos: [-9.5, -1.6, -9], target: [-5.2, -0.8, -0.5], fov: 45 },
  leftInboard: { pos: [-7.5, -3.2, 2.5], target: [-2.2, -1.1, 0.2], fov: 40 },
  cockpit: {
    pos: [A10_GEOMETRY.eye.x, A10_GEOMETRY.eye.y, A10_GEOMETRY.eye.z],
    target: [0, 0.6, -20],
    fov: 62,
  },
};
const camName = q.get('cam') ?? 'front';
const cam = CAMS[camName] ?? CAMS.front;
const showUi = q.get('ui') !== '0';
const showGround = q.get('ground') !== '0';

function dayLight(hour: number): number {
  return Math.min(1, Math.max(0, (Math.sin(((hour - 6) / 12) * Math.PI) + 0.15) / 0.5));
}

function Aircraft({ templates }: { templates: AircraftTemplates }) {
  const scene = useThree((s) => s.scene);
  const forCockpit = camName === 'cockpit';
  const inst = useMemo<AircraftInstance>(
    () => createAircraftInstance({ forCockpit, templates }),
    [forCockpit, templates],
  );
  const barrel = useRef(0);
  const time = useRef(0);
  useEffect(() => {
    scene.add(inst.root);
    setAircraftShadows(inst, true);
    // from the seat: the cockpit itself (the cockpit module draws it in its own pass in the app)
    const cockpitModel = forCockpit ? createCockpitModel() : null;
    if (cockpitModel) inst.root.add(cockpitModel);
    return () => {
      scene.remove(inst.root);
      disposeAircraftInstance(inst);
    };
  }, [inst, scene, forCockpit]);
  useEffect(() => void setAircraftLivery(params.livery), [templates]);
  const state = useMemo(() => createVisualState(), []);
  const stations = useRef<{ key: string; list: StationState[] }>({ key: '', list: [] });
  useFrame((frame, delta) => {
    const dt = Math.min(0.1, delta);
    time.current += dt;
    barrel.current += params.gunRate * dt;
    if (stations.current.key !== params.loadout)
      stations.current = { key: params.loadout, list: stationsOf(LOADOUTS[params.loadout] ?? {}) };
    state.elevator = params.elevator;
    state.aileron = params.aileron;
    state.rudder = params.rudder;
    state.flaps = (params.flapsDeg * Math.PI) / 180;
    state.slats = params.slats;
    state.speedBrake = params.speedBrake;
    state.gear = params.gear;
    state.n1[0] = state.n1[1] = params.n1;
    state.canopy = params.canopy;
    state.barrelAngle = barrel.current;
    state.stations = stations.current.list;
    state.daylight = dayLight(params.hour);
    state.time = time.current;
    applyAircraftVisualState(inst, state, dt);
    const cam = frame.camera as PerspectiveCamera;
    updateAircraftDetail(inst, cam.position, cam.fov, frame.size.height);
  });
  return null;
}

function Lights() {
  const sun = useMemo(() => new Vector3(-0.5, 0.8, -0.35).normalize(), []);
  const day = dayLight(params.hour);
  return (
    <>
      <hemisphereLight
        args={[new Color(0.62, 0.72, 0.85), new Color(0.32, 0.3, 0.22), 1.1 * day + 0.05]}
      />
      <directionalLight
        position={sun.clone().multiplyScalar(40)}
        intensity={2.6 * day}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
        shadow-camera-near={1}
        shadow-camera-far={90}
        shadow-bias={-0.0004}
      />
    </>
  );
}

function CameraSetup() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  useEffect(() => {
    camera.position.set(...cam.pos);
    camera.near = camName === 'cockpit' ? 0.03 : 0.1;
    camera.far = 2000;
    camera.fov = cam.fov ?? 35;
    camera.updateProjectionMatrix();
  }, [camera]);
  return null;
}

/** Draw calls and triangles of the last frame (whole scene), into the panel and for scripts. */
const drawStats = { calls: 0, triangles: 0 };
function DrawStats({ out }: { out: { current: HTMLSpanElement | null } }) {
  const gl = useThree((s) => s.gl);
  useFrame(() => {
    // read before this frame's render: the numbers of the previous frame
    drawStats.calls = gl.info.render.calls;
    drawStats.triangles = gl.info.render.triangles;
    if (out.current)
      out.current.textContent = `scene ${drawStats.calls} draws · ${drawStats.triangles.toLocaleString('en')} triangles`;
  });
  return null;
}

function Controls() {
  const ref = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  useEffect(() => {
    ref.current?.target.set(...cam.target);
    ref.current?.update();
    // scripted screenshots: window.__aircraftSandbox.camera('rear') / .set({ gear: 1 })
    (window as unknown as { __aircraftSandbox: unknown }).__aircraftSandbox = {
      params,
      set: (patch: Partial<Params>) => Object.assign(params, patch),
      info: () => ({ ...drawStats }),
      camera: (name: string) => {
        const c = CAMS[name];
        if (!c || !ref.current) return false;
        camera.position.set(...c.pos);
        camera.fov = c.fov ?? 35;
        camera.updateProjectionMatrix();
        ref.current.target.set(...c.target);
        ref.current.update();
        return true;
      },
    };
  }, [camera]);
  return <OrbitControls ref={ref} makeDefault enableDamping={false} />;
}

export default function AircraftSandbox() {
  const [templates, setTemplates] = useState<AircraftTemplates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);
  const statsRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    loadAircraftModels().then(setTemplates, (e: unknown) => setError(String(e)));
  }, []);
  const day = dayLight(params.hour);
  const sky = new Color(0.55, 0.66, 0.8).multiplyScalar(0.08 + 0.92 * day);
  const set = <K extends keyof Params>(k: K, v: Params[K]) => {
    params[k] = v;
    if (k === 'livery') void setAircraftLivery(v as string);
    force((n) => n + 1);
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: `#${sky.getHexString()}` }}>
      <Canvas
        shadows
        gl={{ antialias: true }}
        camera={{ fov: 35, near: 0.1, far: 2000 }}
        data-testid="aircraft-sandbox"
        onCreated={({ scene }) => {
          scene.background = sky;
          scene.fog = new Fog(sky, 400, 1800);
        }}
      >
        <CameraSetup />
        <Lights />
        {showGround && (
          <mesh rotation-x={-Math.PI / 2} position={[0, -2.71, 0]} receiveShadow>
            <circleGeometry args={[300, 48]} />
            <meshStandardMaterial color="#596452" roughness={0.95} />
          </mesh>
        )}
        {templates && <Aircraft templates={templates} />}
        <Controls />
        <DrawStats out={statsRef} />
      </Canvas>
      {error && <div style={{ ...panel, color: '#f88' }}>{error}</div>}
      {!templates && !error && (
        <div style={{ ...panel, right: 'auto', left: 12 }}>Loading the A-10…</div>
      )}
      {showUi && templates && (
        <div style={panel}>
          <b>A-10 model</b>
          {slider('Elevator (+ TE up)', params.elevator, -1, 1, 0.01, (v) => set('elevator', v))}
          {slider('Aileron (+ roll right)', params.aileron, -1, 1, 0.01, (v) => set('aileron', v))}
          {slider('Rudder (+ nose right)', params.rudder, -1, 1, 0.01, (v) => set('rudder', v))}
          {slider('Flaps (deg)', params.flapsDeg, 0, 20, 0.5, (v) => set('flapsDeg', v))}
          {slider('Slats', params.slats, 0, 1, 0.01, (v) => set('slats', v))}
          {slider('Speed brake', params.speedBrake, 0, 1, 0.01, (v) => set('speedBrake', v))}
          {slider('Gear (0 up, 1 down)', params.gear, 0, 1, 0.01, (v) => set('gear', v))}
          {slider('Fan N1', params.n1, 0, 1, 0.01, (v) => set('n1', v))}
          {slider('Canopy', params.canopy, 0, 1, 0.01, (v) => set('canopy', v))}
          {slider('Gun spin (rad/s)', params.gunRate, 0, 60, 0.5, (v) => set('gunRate', v))}
          {slider('Time of day (h)', params.hour, 0, 24, 0.25, (v) => set('hour', v))}
          <label style={row}>
            Loadout{' '}
            <select value={params.loadout} onChange={(e) => set('loadout', e.target.value)}>
              {Object.keys(LOADOUTS).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label style={row}>
            Livery{' '}
            <select value={params.livery} onChange={(e) => set('livery', e.target.value)}>
              {templates.meta.liveries.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <div style={{ opacity: 0.7, marginTop: 6 }}>
            <span ref={statsRef} />
          </div>
        </div>
      )}
    </div>
  );
}

function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  on: (v: number) => void,
) {
  return (
    <label style={row}>
      <span style={{ flex: 1 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => on(Number(e.target.value))}
      />
      <span style={{ width: 40, textAlign: 'right' }}>{value.toFixed(2)}</span>
    </label>
  );
}

const panel: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  width: 330,
  padding: 12,
  background: 'rgba(10,14,18,0.82)',
  color: '#dde',
  font: '12px/1.6 system-ui, sans-serif',
  borderRadius: 6,
};
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
