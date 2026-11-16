/**
 * Terrain + environment sandbox (ENVIRONMENT + TERRAIN-VIEW MODULE): the generated range with
 * the real sky, haze, clouds, terrain tiles, roads, river, forests and trees, seen from a free
 * camera — no aircraft, no simulation.
 *
 *   /a10/?sandbox=terrain
 *   /a10/?sandbox=terrain&preset=3000&time=10.5&vis=30&quality=medium   (repeatable screenshot)
 *
 * Controls: drag to look, W A S D to fly, Q / E down / up, Shift ×5 speed.
 * Parameters:
 *   preset=3000|1000|300     camera that many metres above the first target area, 4–6 km back,
 *                            looking at it (area=<index> picks another target area)
 *   cam=x,y,z  look=yawDeg,pitchDeg      explicit camera (yaw 0 = north, clockwise)
 *   time=<hours>  vis=<km>   time of day and visibility
 *   quality=low|medium|high  graphics preset (default medium)
 *   thermal=1|2              thermal picture (white-hot, black-hot) as the sensors would draw it
 *   seed=<n>                 world seed; ui=0 hides the panel
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Euler, MathUtils, Vector3 } from 'three';
import type { Terrain } from '../../core/world/types';
import { getTerrain, onTerrain, prepareWorld } from '../../state/runtime';
import { DEFAULT_SETTINGS, useA10Store, type QualityLevel } from '../../state/store';
import Environment from '../../view/environment/Environment';
import { envFrame, environmentOverrides } from '../../view/environment/envState';
import { A10_PRIORITY } from '../../view/frame';
import { useA10Quality } from '../../view/quality';
import RenderPipeline from '../../view/RenderPipeline';
import { terrainUniforms } from '../../view/terrain/terrainMaterial';
import { terrainStreaming } from '../../view/terrain/terrainStats';
import TerrainView from '../../view/terrain/TerrainView';

const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const num = (k: string): number | null => {
  const v = params.get(k);
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const vec = (k: string): number[] | null => {
  const v = params.get(k);
  if (!v) return null;
  const a = v.split(',').map(Number);
  return a.every(Number.isFinite) ? a : null;
};

const DPR: Record<QualityLevel, [number, number]> = {
  low: [0.75, 1],
  medium: [1, 1.5],
  high: [1, 2],
};

/** The free camera's pose: position and yaw (0 = north, clockwise) / pitch, radians. */
const pose = { x: 0, y: 3000, z: 0, yaw: 0, pitch: -0.3 };

/** Put the camera `agl` metres above target area `area`, back along its axis, looking at it. */
function presetPose(terrain: Terrain, agl: number, area: number): void {
  const a = terrain.targetAreas[area] ?? terrain.targetAreas[0];
  const tx = a ? a.x : terrain.start.x;
  const tz = a ? a.z : terrain.start.z;
  // come in from the start point's side
  const dx = terrain.start.x - tx;
  const dz = terrain.start.z - tz;
  const l = Math.hypot(dx, dz) || 1;
  const back = agl >= 2000 ? 6000 : agl >= 800 ? 4500 : 2500;
  const x = tx + (dx / l) * back;
  const z = tz + (dz / l) * back;
  const ground = terrain.heightAt(tx, tz);
  pose.x = x;
  pose.z = z;
  pose.y = Math.max(terrain.heightAt(x, z) + 30, ground + agl);
  pose.yaw = Math.atan2(tx - x, -(tz - z));
  pose.pitch = -Math.atan2(pose.y - ground, back);
}

if (typeof window !== 'undefined') {
  // scripted screenshots: jump between presets in one session
  (window as unknown as { __TERRAIN_SANDBOX__: unknown }).__TERRAIN_SANDBOX__ = {
    pose,
    preset(agl: number, area = 0) {
      const t = getTerrain();
      if (t) presetPose(t, agl, area);
    },
  };
}

const _euler = new Euler(0, 0, 0, 'YXZ');
const _move = new Vector3();

function FreeCamera() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const keys = useRef(new Set<string>());

  useEffect(() => {
    const down = (e: KeyboardEvent) => keys.current.add(e.code);
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    let dragging = false;
    let lx = 0;
    let ly = 0;
    const el = gl.domElement;
    const pd = (e: PointerEvent) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const pm = (e: PointerEvent) => {
      if (!dragging) return;
      pose.yaw += (e.clientX - lx) * 0.004;
      pose.pitch = MathUtils.clamp(pose.pitch - (e.clientY - ly) * 0.004, -1.55, 1.55);
      lx = e.clientX;
      ly = e.clientY;
    };
    const pu = () => {
      dragging = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    el.addEventListener('pointerdown', pd);
    el.addEventListener('pointermove', pm);
    el.addEventListener('pointerup', pu);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      el.removeEventListener('pointerdown', pd);
      el.removeEventListener('pointermove', pm);
      el.removeEventListener('pointerup', pu);
    };
  }, [gl]);

  useFrame((_, delta) => {
    const k = keys.current;
    const dt = Math.min(delta, 0.1);
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 750 : 150) * dt;
    const fx = Math.sin(pose.yaw);
    const fz = -Math.cos(pose.yaw);
    // forward (fx, fz); right is forward turned 90° clockwise: (−fz, fx)
    _move.set(0, 0, 0);
    if (k.has('KeyW')) _move.set(_move.x + fx, _move.y, _move.z + fz);
    if (k.has('KeyS')) _move.set(_move.x - fx, _move.y, _move.z - fz);
    if (k.has('KeyD')) _move.set(_move.x - fz, _move.y, _move.z + fx);
    if (k.has('KeyA')) _move.set(_move.x + fz, _move.y, _move.z - fx);
    if (k.has('KeyE')) _move.y += 1;
    if (k.has('KeyQ')) _move.y -= 1;
    pose.x += _move.x * speed;
    pose.y += _move.y * speed;
    pose.z += _move.z * speed;
    const terrain = getTerrain();
    if (terrain) pose.y = Math.max(pose.y, terrain.heightAt(pose.x, pose.z) + 2);
    camera.position.set(pose.x, pose.y, pose.z);
    // three.js camera looks along −Z: yaw clockwise from north = rotation by −yaw about +Y
    _euler.set(pose.pitch, -pose.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(_euler);
    camera.updateMatrixWorld();
  }, A10_PRIORITY.camera);
  return null;
}

function Readout() {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const s = terrainStreaming;
  const terrain = getTerrain();
  const ground = terrain ? terrain.heightAt(pose.x, pose.z) : 0;
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, lineHeight: 1.5 }}>
      <div>
        cam {pose.x.toFixed(0)}, {pose.z.toFixed(0)} · {(pose.y - ground).toFixed(0)} m AGL ·{' '}
        {((pose.yaw * 180) / Math.PI).toFixed(0)}°
      </div>
      <div>
        tiles {s.drawn} drawn / {s.tiles} held · {(s.triangles / 1000).toFixed(0)}k tri ·{' '}
        {s.pending} pending
      </div>
      <div>
        trees {s.trees} · build {s.buildMs.toFixed(0)} ms · frame {s.frameMs.toFixed(2)} ms
      </div>
      <div>
        haze vis {envFrame.visibilityKm.toFixed(0)} km · t {envFrame.hours.toFixed(2)} h
      </div>
    </div>
  );
}

const PANEL: CSSProperties = {
  position: 'fixed',
  top: 12,
  left: 12,
  zIndex: 10,
  padding: '10px 12px',
  width: 300,
  borderRadius: 8,
  background: 'rgba(12, 18, 14, 0.78)',
  color: '#dfe8dc',
  font: '12px system-ui, sans-serif',
  display: 'grid',
  gap: 8,
};

function Panel({ terrain }: { terrain: Terrain | null }) {
  const [time, setTime] = useState(environmentOverrides.timeOfDay ?? DEFAULT_SETTINGS.timeOfDay);
  const [vis, setVis] = useState(environmentOverrides.visibilityKm ?? 30);
  const quality = useA10Store((s) => s.settings.quality);
  useEffect(() => {
    environmentOverrides.timeOfDay = time;
  }, [time]);
  useEffect(() => {
    environmentOverrides.visibilityKm = vis;
  }, [vis]);
  return (
    <div style={PANEL}>
      <strong>Terrain sandbox</strong>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[3000, 1000, 300].map((agl) => (
          <button
            key={agl}
            type="button"
            className="fac-btn"
            disabled={!terrain}
            onClick={() => terrain && presetPose(terrain, agl, num('area') ?? 0)}
          >
            {agl} m
          </button>
        ))}
        {(['low', 'medium', 'high'] as const).map((q) => (
          <button
            key={q}
            type="button"
            className={q === quality ? 'fac-btn fac-btn--primary' : 'fac-btn'}
            onClick={() => useA10Store.getState().overrideSettings({ quality: q })}
          >
            {q}
          </button>
        ))}
      </div>
      <label>
        Time {time.toFixed(1)} h
        <input
          type="range"
          min={6}
          max={19}
          step={0.1}
          value={time}
          style={{ width: '100%' }}
          onChange={(e) => setTime(Number(e.target.value))}
        />
      </label>
      <label>
        Visibility {vis.toFixed(0)} km
        <input
          type="range"
          min={4}
          max={80}
          step={1}
          value={vis}
          style={{ width: '100%' }}
          onChange={(e) => setVis(Number(e.target.value))}
        />
      </label>
      {terrain ? <Readout /> : <div>Generating the range…</div>}
      <div style={{ opacity: 0.7 }}>Drag to look · WASD fly · Q/E down/up · Shift fast</div>
    </div>
  );
}

function Stage() {
  const quality = useA10Quality();
  return (
    <>
      <Environment />
      <TerrainView />
      <FreeCamera />
      <RenderPipeline key={quality.level} />
    </>
  );
}

export default function TerrainSandbox() {
  const quality = useA10Store((s) => s.settings.quality);
  const [terrain, setTerrain] = useState<Terrain | null>(getTerrain);

  // URL parameters once: quality, time, visibility, thermal, camera
  useMemo(() => {
    const q = params.get('quality');
    useA10Store.getState().overrideSettings({
      quality: q === 'low' || q === 'high' ? q : 'medium',
      adaptiveQuality: false,
    });
    environmentOverrides.timeOfDay = num('time') ?? DEFAULT_SETTINGS.timeOfDay;
    environmentOverrides.visibilityKm = num('vis') ?? 30;
    terrainUniforms.uThermal.value = num('thermal') ?? 0;
  }, []);

  useEffect(() => onTerrain(setTerrain), []);
  useEffect(() => {
    void prepareWorld(num('seed') ?? useA10Store.getState().settings.worldSeed).then((t) => {
      const cam = vec('cam');
      const look = vec('look');
      if (cam && cam.length === 3) {
        pose.x = cam[0];
        pose.y = cam[1];
        pose.z = cam[2];
      } else presetPose(t, num('preset') ?? 3000, num('area') ?? 0);
      if (look && look.length === 2) {
        pose.yaw = (look[0] * Math.PI) / 180;
        pose.pitch = (look[1] * Math.PI) / 180;
      }
    });
  }, []);

  return (
    <div className="a10-app">
      <Canvas
        dpr={DPR[quality]}
        gl={{ antialias: true, stencil: true, powerPreference: 'high-performance' }}
        camera={{ fov: 62, near: 1, far: 90000, position: [0, 3000, 0] }}
      >
        <Stage />
      </Canvas>
      {params.get('ui') !== '0' && <Panel terrain={terrain} />}
    </div>
  );
}
