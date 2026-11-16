/**
 * Vehicles sandbox (VEHICLES-AND-EFFECTS MODULE): every vehicle kind in every condition, a column
 * driving round a loop raising dust, and the thermal picture toggle — through the real
 * VehiclesView and EffectsView on flat ground.
 *
 *   /a10/?sandbox=vehicles
 *   /a10/?sandbox=vehicles&view=close&kind=mbt&cond=intact&quality=high
 *
 * Parameters:
 *   view=grid|close|column|far|top     camera preset (default grid)
 *   kind=<VehicleKind> cond=intact|damaged|destroyed|catastrophic   subject of view=close
 *   thermal=0|1|2                      visible, white-hot, black-hot
 *   fires=0                            no fires on the wrecks (clean model shots)
 *   surface=<kind>                     ground the column drives on (dust colour and amount)
 *   at=<s>                             run this many seconds first (dust trails), then keep going
 *   cam=x,y,z tgt=x,y,z fov=deg       explicit camera; ui=0 hides the panel
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Color, Vector3 } from 'three';
import type { Vehicle, VehicleCondition, VehicleKind } from '../../core/targets/types';
import type { SurfaceKind } from '../../core/world/types';
import { getFx, updateFx } from '../../view/effects/fx';
import { a10Env } from '../../view/environment/env';
import { getA10Quality } from '../../view/quality';
import { windingErrors, buildVehicleGeometry, VEHICLE_KINDS } from '../../view/vehicles/models';
import { setThermalMode, type ThermalMode } from '../../view/vehicles/thermal';
import { getVehicleRenderer } from '../../view/vehicles/VehiclesView';
import { KitStage, numParam, params, SandboxWorld, useSandboxQuality, vecParam, type CameraPose } from './effectsKit';

const CONDITIONS: VehicleCondition[] = ['intact', 'damaged', 'destroyed', 'catastrophic'];
const SPACING_X = 15;
const SPACING_Z = 13;
const COLUMN_RADIUS = 150;
const COLUMN_CENTRE = new Vector3(0, 0, -260);
const COLUMN_KINDS: VehicleKind[] = ['mbt', 'mbt', 'ifv', 'apc', 'truckCargo', 'truckFuel', 'truckAmmo'];
const COLUMN_SPEED = 9.5;

function gridPos(kindIndex: number, condIndex: number): Vector3 {
  return new Vector3((condIndex - 1.5) * SPACING_X, 0, (kindIndex - 3.5) * SPACING_Z);
}

function setCondition(v: Vehicle, cond: VehicleCondition, fires: boolean, time: number): void {
  v.condition = cond;
  v.conditionTime = time - 6;
  const powered = v.kind !== 'hulk' && v.kind !== 'panel';
  v.engineOn = powered && cond !== 'destroyed' && cond !== 'catastrophic';
  v.heat = powered
    ? { engine: 32, exhaust: 70, running: 6, hull: 7 }
    : { engine: 0, exhaust: 0, running: 1, hull: 5 };
  if (cond === 'damaged') {
    v.mobilityKill = v.kind !== 'panel';
    v.firepowerKill = true;
  }
  if (cond === 'destroyed') v.fire = fires ? 0.55 + 0.25 * ((v.id % 3) / 2) : 0;
  if (cond === 'catastrophic') {
    v.fire = fires ? 0.9 : 0;
    v.mobilityKill = true;
    if (v.kind === 'mbt' || v.kind === 'ifv' || v.kind === 'hulk' || v.kind === 'apc') {
      // the turret came down beside the hull, upside down
      const side = new Vector3(Math.cos(v.heading), 0, Math.sin(v.heading)).multiplyScalar(4.2);
      v.thrownTurret = {
        position: v.position.clone().add(side).add(new Vector3(0, 0.75, 1.5)),
        velocity: new Vector3(),
        spin: new Vector3(),
        angle: new Vector3(Math.PI - 0.25, -v.heading + 0.7, 0.15),
      };
    }
  }
}

interface Scene {
  world: SandboxWorld;
  grid: Vehicle[][];
  column: Vehicle[];
}

function buildScene(fires: boolean, surface: SurfaceKind | null): Scene {
  const world = new SandboxWorld();
  if (surface) {
    // the flat test ground: one surface kind everywhere
    (world.sim.world.terrain as { surfaceAt: (x: number, z: number) => SurfaceKind }).surfaceAt = () => surface;
  }
  const grid: Vehicle[][] = [];
  const kinds = params.get('kinds')?.split(',') ?? null;
  const conds = params.get('conds')?.split(',') ?? null;
  const heading = numParam('heading', 205);
  VEHICLE_KINDS.forEach((kind, ki) => {
    const row: Vehicle[] = [];
    CONDITIONS.forEach((cond, ci) => {
      if ((kinds && !kinds.includes(kind)) || (conds && !conds.includes(cond))) return;
      const p = gridPos(ki, ci);
      const v = world.addVehicle(kind, p.x, p.z, heading + ki * 3);
      setCondition(v, cond, fires, 0);
      row[ci] = v;
    });
    grid.push(row);
  });
  // a hit on each damaged vehicle (scorched patch) and the hit that threw its track
  for (const row of grid) {
    const v = row[1];
    if (!v || v.kind === 'panel') continue;
    const s = Math.sin(v.heading);
    const c = Math.cos(v.heading);
    const local = (x: number, y: number, z: number) => ({ x: v.position.x + x * c - z * s, y: v.position.y + y, z: v.position.z + x * s + z * c });
    world.schedule(0.05, {
      type: 'roundImpact',
      t: 0,
      round: 1,
      position: local(0.6, 1.4, -1.0),
      velocity: { x: 0, y: -400, z: -500 },
      normal: { x: 0, y: 1, z: 0 },
      target: { kind: 'vehicle', vehicleId: v.id, part: 'hull' },
      outcome: 'burst',
    });
    world.schedule(0.1, {
      type: 'roundImpact',
      t: 0,
      round: 0,
      position: local(-1.4, 0.5, 1.0),
      velocity: { x: 0, y: -400, z: -500 },
      normal: { x: -1, y: 0, z: 0 },
      target: { kind: 'vehicle', vehicleId: v.id, part: 'tracks' },
      outcome: 'penetrated',
    });
  }
  // the column on its loop
  const column: Vehicle[] = [];
  (params.get('column') === '0' ? [] : COLUMN_KINDS).forEach((kind) => {
    const v = world.addVehicle(kind, COLUMN_CENTRE.x, COLUMN_CENTRE.z, 0);
    v.engineOn = true;
    v.speed = COLUMN_SPEED;
    v.heat = { engine: 38, exhaust: 85, running: 22, hull: 8 };
    column.push(v);
  });
  const placeColumn = (t: number) => {
    column.forEach((v, i) => {
      const a = (t * COLUMN_SPEED) / COLUMN_RADIUS - (i * 26) / COLUMN_RADIUS;
      v.position.set(COLUMN_CENTRE.x + Math.cos(a) * COLUMN_RADIUS, 0, COLUMN_CENTRE.z + Math.sin(a) * COLUMN_RADIUS);
      // moving counter-clockwise seen from above: velocity direction (-sin a, 0, cos a)
      const dx = -Math.sin(a);
      const dz = Math.cos(a);
      v.heading = Math.atan2(dx, -dz);
      v.turretYaw = v.kind === 'mbt' ? Math.sin(t * 0.3 + i) * 0.8 : 0;
    });
  };
  placeColumn(0);
  world.onStep = (w, dt) => placeColumn(w.time + dt);
  return { world, grid, column };
}

function pose(view: string): CameraPose {
  const cam = vecParam('cam');
  const tgt = vecParam('tgt');
  if (cam && tgt) return { position: cam, target: tgt, fov: numParam('fov', 45) };
  if (view === 'close') {
    const ki = Math.max(0, VEHICLE_KINDS.indexOf((params.get('kind') as VehicleKind) ?? 'mbt'));
    const ci = Math.max(0, CONDITIONS.indexOf((params.get('cond') as VehicleCondition) ?? 'intact'));
    const p = gridPos(ki, ci);
    const az = numParam('az', 35) * (Math.PI / 180);
    const r = numParam('r', 13);
    return { position: [p.x + Math.sin(az) * r, numParam('h', 4.5), p.z + Math.cos(az) * r], target: [p.x, 1.3, p.z], fov: numParam('fov', 40) };
  }
  if (view === 'column') return { position: [COLUMN_CENTRE.x + 260, 120, COLUMN_CENTRE.z + 260], target: [COLUMN_CENTRE.x, 0, COLUMN_CENTRE.z], fov: numParam('fov', 45) };
  if (view === 'far') return { position: [COLUMN_CENTRE.x + 900, 1300, COLUMN_CENTRE.z + 1300], target: [COLUMN_CENTRE.x, 0, COLUMN_CENTRE.z], fov: numParam('fov', 62) };
  if (view === 'lineup') {
    // the intact column seen from the side, kinds left to right
    return { position: [-SPACING_X * 1.5 - 34, 9, 0], target: [-SPACING_X * 1.5, 1.2, 0], fov: numParam('fov', 75) };
  }
  if (view === 'top') return { position: [0.01, 150, 0], target: [0, 0, 0], fov: numParam('fov', 50) };
  return { position: [70, 48, 85], target: [0, 0, 2], fov: numParam('fov', 50) };
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  width: 250,
  background: 'rgba(10,14,18,0.78)',
  color: '#dde4ea',
  font: '12px/1.4 system-ui, sans-serif',
  padding: 8,
  borderRadius: 6,
};
const btn: CSSProperties = {
  margin: '2px 3px 2px 0',
  padding: '3px 7px',
  background: '#26313b',
  color: '#e8eef3',
  border: '1px solid #3a4a57',
  borderRadius: 4,
  cursor: 'pointer',
  font: 'inherit',
};

/** The sandbox ground and sky go thermal too (cold sky, ground a little above ambient). */
function ThermalScene({ mode }: { mode: ThermalMode }) {
  const sky = useMemo(() => new Color().copy(a10Env.horizonColor).lerp(a10Env.zenithColor, 0.25), []);
  useFrame(({ scene }) => {
    if (scene.background instanceof Color) {
      if (mode === 0) scene.background.copy(sky);
      else scene.background.setScalar(mode === 1 ? 0.04 : 0.8);
    }
    scene.traverse((o) => {
      const m = (o as { material?: { color?: Color; map?: unknown } }).material;
      if (m && m.map && m.color) m.color.setScalar(mode === 0 ? 1 : mode === 1 ? 0.035 : 0.22);
    });
  });
  useEffect(() => () => setThermalMode(0), []);
  return null;
}

function Stats() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = setInterval(() => {
      const r = getVehicleRenderer();
      const fx = getFx();
      if (ref.current && r) {
        const s = r.stats;
        ref.current.textContent = `vehicles ${s.drawn} (${s.near} detailed) · ${s.drawCalls} draws · ${Math.round(s.triangles / 1000)}k tris · particles ${fx ? fx.ps.stats.drawn : 0}`;
      }
    }, 300);
    return () => clearInterval(id);
  }, []);
  return <div ref={ref} style={{ marginTop: 6, color: '#9fb0bd' }} />;
}

/** Runs ?at= seconds of the world (dust trails) before the first picture. */
function Warmup({ scene }: { scene: Scene }) {
  const done = useRef(false);
  useFrame((state) => {
    if (done.current) return;
    done.current = true;
    const at = numParam('at', 0);
    const fx = getFx();
    if (at <= 0 || !fx) return;
    const dt = 1 / 30;
    for (let t = 0; t < at; t += dt) {
      scene.world.advance(dt);
      getVehicleRenderer()?.update(scene.world.sim, dt, state.camera, getA10Quality(), fx.ps, fx.ctx.detail);
      updateFx(fx, dt, state.camera);
    }
    if (params.get('freeze') === '1') scene.world.timeScale = 0;
  }, -90);
  return null;
}

export default function VehiclesSandbox() {
  useSandboxQuality();
  const fires = params.get('fires') !== '0';
  const surfaceParam = params.get('surface') as SurfaceKind | null;
  const scene = useMemo(() => buildScene(fires, surfaceParam), [fires, surfaceParam]);
  const [view, setView] = useState(params.get('view') ?? 'grid');
  const [thermal, setThermal] = useState<ThermalMode>(() => Math.min(2, Math.max(0, numParam('thermal', 0))) as ThermalMode);
  const camPose = useMemo(() => pose(view), [view]);

  useEffect(() => {
    setThermalMode(thermal);
  }, [thermal]);

  useEffect(() => {
    // developer check: model faces wind outward (culling) — reported in the console
    for (const kind of VEHICLE_KINDS) {
      for (const lod of [0, 1] as const) {
        const g = buildVehicleGeometry(kind, lod, 1);
        const bad = windingErrors(g);
        const tris = g.getAttribute('position').count / 3;
        if (bad > 0.002) console.warn(`[vehicles] ${kind} lod${lod}: ${(bad * 100).toFixed(1)}% of ${tris} triangles wound inward`);
        else console.info(`[vehicles] ${kind} lod${lod}: ${tris} triangles`);
        g.dispose();
      }
    }
  }, []);

  const overlay =
    params.get('ui') === '0' ? null : (
      <div style={panelStyle}>
        <div style={{ fontWeight: 600 }}>Vehicles sandbox</div>
        <div style={{ color: '#9fb0bd', marginBottom: 4 }}>
          rows: {VEHICLE_KINDS.join(', ')} · columns: intact, damaged, destroyed, catastrophic
        </div>
        <div>
          {['grid', 'column', 'far', 'top'].map((v) => (
            <button key={v} style={{ ...btn, background: v === view ? '#3d5a72' : btn.background }} onClick={() => setView(v)}>
              {v}
            </button>
          ))}
        </div>
        <div>
          Picture:{' '}
          {(['visible', 'white-hot', 'black-hot'] as const).map((label, i) => (
            <button key={label} style={{ ...btn, background: i === thermal ? '#3d5a72' : btn.background }} onClick={() => setThermal(i as ThermalMode)}>
              {label}
            </button>
          ))}
        </div>
        <Stats />
      </div>
    );

  return (
    <KitStage world={scene.world} pose={camPose} overlay={overlay}>
      <Warmup scene={scene} />
      <ThermalScene mode={thermal} />
    </KitStage>
  );
}
