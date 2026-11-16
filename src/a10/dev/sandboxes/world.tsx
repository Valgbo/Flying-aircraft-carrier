/**
 * World sandbox (/a10/?sandbox=world): a 2D map of the generated range drawn to a canvas —
 * hillshade, surface colours, fields, forests, roads, the river, the airbase, the target areas
 * with their names and the air start — with a seed input. Hover for the ground under the mouse.
 * Owned by the WORLD module.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Vector3 } from 'three';
import {
  createTerrain,
  generateTerrainData,
  type FieldSample,
  type SurfaceKind,
  type Terrain,
} from '../../core/world';

const MAP_PX = 1000;

/** Map palette (muted, as seen from altitude). */
const SURFACE_RGB: Record<SurfaceKind, [number, number, number]> = {
  grass: [122, 146, 86],
  field: [176, 166, 98],
  dirt: [150, 122, 88],
  sand: [214, 199, 156],
  rock: [150, 145, 136],
  forest: [58, 88, 50],
  road: [84, 84, 88],
  concrete: [190, 190, 184],
  water: [70, 112, 150],
  mud: [112, 100, 76],
};

/** Crop tints for fields (by variant). */
const CROP_RGB: Record<FieldSample['crop'], [number, number, number]> = {
  cereal: [196, 178, 104],
  greenCrop: [132, 160, 82],
  rapeseed: [205, 192, 86],
  ploughed: [138, 108, 78],
  pasture: [122, 148, 86],
  fallow: [166, 158, 112],
};

const ROAD_STYLE = {
  highway: { color: '#f2d27a', width: 3, casing: '#5b4a24' },
  road: { color: '#f4f0e6', width: 2, casing: '#4a4a4a' },
  track: { color: '#c9a878', width: 1.2, casing: '' },
} as const;

const AREA_COLOR: Record<string, string> = {
  open: '#ffe14d',
  treeline: '#9cff6b',
  road: '#ff9f40',
  dugIn: '#ff6bd6',
  range: '#ff4040',
  village: '#ffffff',
};

interface Info {
  ms: number;
  drawMs: number;
  roads: number;
  areas: number;
  maxH: number;
  minH: number;
}

function initialSeed(): number {
  const s = Number(new URLSearchParams(location.search).get('seed'));
  return Number.isFinite(s) && s > 0 ? Math.floor(s) : 1;
}

export default function WorldSandbox() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [seed, setSeed] = useState(initialSeed);
  const [input, setInput] = useState(String(initialSeed()));
  const [busy, setBusy] = useState(true);
  const [info, setInfo] = useState<Info | null>(null);
  const [hover, setHover] = useState<string>('');
  const terrainRef = useRef<Terrain | null>(null);

  useEffect(() => {
    setBusy(true);
    // Let "Generating…" paint before the (synchronous) generation runs.
    const id = setTimeout(() => {
      const t0 = performance.now();
      const terrain = createTerrain(generateTerrainData(seed));
      const ms = performance.now() - t0;
      terrainRef.current = terrain;
      const t1 = performance.now();
      if (canvas.current) drawMap(canvas.current, terrain);
      setInfo({
        ms,
        drawMs: performance.now() - t1,
        roads: terrain.roads.length,
        areas: terrain.targetAreas.length,
        maxH: terrain.maxHeight,
        minH: terrain.minHeight,
      });
      setBusy(false);
      document.body.dataset.worldReady = String(seed);
    }, 30);
    return () => clearTimeout(id);
  }, [seed]);

  const onMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const t = terrainRef.current;
    const c = canvas.current;
    if (!t || !c) return;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * t.size;
    const z = ((e.clientY - r.top) / r.height - 0.5) * t.size;
    const h = t.heightAt(x, z);
    const slope = t.slopeAt ? (t.slopeAt(x, z) * 180) / Math.PI : 0;
    setHover(
      `x ${(x / 1000).toFixed(2)} km  z ${(z / 1000).toFixed(2)} km  ·  ${h.toFixed(1)} m  ·  ${t.surfaceAt(x, z)}` +
        `  ·  slope ${slope.toFixed(1)}°  ·  canopy ${t.canopyAt(x, z).toFixed(1)} m`,
    );
  }, []);

  return (
    <div style={PAGE}>
      <div style={BAR}>
        <strong>World</strong>
        <label>
          seed{' '}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setSeed(Math.max(1, Math.floor(Number(input)) || 1))}
            style={{ width: 80 }}
          />
        </label>
        <button type="button" onClick={() => setSeed(Math.max(1, Math.floor(Number(input)) || 1))}>
          Generate
        </button>
        <button
          type="button"
          onClick={() => {
            const s = seed + 1;
            setInput(String(s));
            setSeed(s);
          }}
        >
          Next seed
        </button>
        {busy ? (
          <span>Generating…</span>
        ) : info ? (
          <span style={{ opacity: 0.8 }}>
            generated in {info.ms.toFixed(0)} ms · drawn in {info.drawMs.toFixed(0)} ms · {info.roads}{' '}
            roads · {info.areas} target areas · {info.minH.toFixed(0)}–{info.maxH.toFixed(0)} m
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <canvas
          ref={canvas}
          width={MAP_PX}
          height={MAP_PX}
          onMouseMove={onMove}
          style={{ width: 'min(100vh - 90px, 100vw - 260px)', aspectRatio: '1', background: '#222' }}
        />
        <Legend />
      </div>
      <div style={{ minHeight: 18, fontSize: 12, opacity: 0.85 }}>{hover}</div>
    </div>
  );
}

function Legend() {
  const items: Array<[string, string]> = [
    ['field (crops)', rgb(CROP_RGB.cereal)],
    ['ploughed / dirt', rgb(SURFACE_RGB.dirt)],
    ['grass, pasture', rgb(SURFACE_RGB.grass)],
    ['forest', rgb(SURFACE_RGB.forest)],
    ['rock', rgb(SURFACE_RGB.rock)],
    ['water', rgb(SURFACE_RGB.water)],
    ['sand bank', rgb(SURFACE_RGB.sand)],
    ['mud', rgb(SURFACE_RGB.mud)],
    ['concrete', rgb(SURFACE_RGB.concrete)],
  ];
  return (
    <div style={{ fontSize: 12, lineHeight: '20px', minWidth: 200 }}>
      {items.map(([n, c]) => (
        <div key={n}>
          <span style={{ display: 'inline-block', width: 14, height: 10, background: c, marginRight: 6 }} />
          {n}
        </div>
      ))}
      <div style={{ marginTop: 8 }}>
        <span style={{ color: ROAD_STYLE.highway.color }}>━</span> highway{' '}
        <span style={{ color: ROAD_STYLE.road.color }}>━</span> road{' '}
        <span style={{ color: ROAD_STYLE.track.color }}>━</span> track
      </div>
      <div style={{ marginTop: 8 }}>
        {Object.entries(AREA_COLOR)
          .filter(([k]) => k !== 'village')
          .map(([k, c]) => (
            <div key={k}>
              <span style={{ color: c }}>◯</span> {k}
            </div>
          ))}
        <div>
          <span style={{ color: '#ff40ff' }}>➤</span> air start
        </div>
      </div>
      <div style={{ marginTop: 8, opacity: 0.7 }}>Grid lines every 10 km. North is up.</div>
    </div>
  );
}

function rgb(c: [number, number, number]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Draw the whole map: ground pixels, then vector overlays. */
function drawMap(cv: HTMLCanvasElement, t: Terrain): void {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const W = cv.width;
  const size = t.size;
  const half = size / 2;
  const px = size / W;
  const img = ctx.createImageData(W, W);
  const n = new Vector3();
  const field: FieldSample = {
    id: 0,
    variant: 0,
    crop: 'cereal',
    rowHeading: 0,
    edgeDistance: 0,
    hedge: false,
    track: false,
  };
  // Light from the north-west, 45° up.
  const lx = -0.5;
  const ly = 0.7071;
  const lz = -0.5;
  for (let j = 0; j < W; j++) {
    const z = -half + (j + 0.5) * px;
    for (let i = 0; i < W; i++) {
      const x = -half + (i + 0.5) * px;
      const s = t.surfaceAt(x, z);
      let c = SURFACE_RGB[s];
      if ((s === 'field' || s === 'grass' || s === 'dirt') && t.fieldAt && t.fieldAt(x, z, field)) {
        if (field.edgeDistance > 6) c = CROP_RGB[field.crop];
        // A little variation from field to field.
        const v = 0.92 + 0.16 * ((field.variant * 37) % 100) / 100;
        c = [c[0] * v, c[1] * v, c[2] * v];
      }
      if (s === 'forest') {
        const k = 0.8 + 0.4 * (t.canopyAt(x, z) / 22);
        c = [c[0] * k, c[1] * k, c[2] * k];
      }
      // Hillshade with 2× vertical exaggeration.
      t.normalAt(x, z, n);
      const ex = n.x * 2;
      const ez = n.z * 2;
      const l = Math.hypot(ex, n.y, ez);
      const lambert = Math.max(0, (ex * lx + n.y * ly + ez * lz) / l);
      const shade = 0.45 + 0.75 * lambert;
      const o = (j * W + i) * 4;
      img.data[o] = Math.min(255, c[0] * shade);
      img.data[o + 1] = Math.min(255, c[1] * shade);
      img.data[o + 2] = Math.min(255, c[2] * shade);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const toPx = (v: number) => (v + half) / px;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 10 km grid.
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  for (let g = -30000; g <= 30000; g += 10000) {
    ctx.beginPath();
    ctx.moveTo(toPx(g), 0);
    ctx.lineTo(toPx(g), W);
    ctx.moveTo(0, toPx(g));
    ctx.lineTo(W, toPx(g));
    ctx.stroke();
  }

  // River.
  for (const r of t.rivers ?? []) {
    ctx.strokeStyle = 'rgb(70,112,150)';
    ctx.lineWidth = Math.max(1.5, r.widths[r.widths.length >> 1] / px);
    ctx.beginPath();
    for (let k = 0; k < r.points.length; k += 2) {
      if (k === 0) ctx.moveTo(toPx(r.points[k]), toPx(r.points[k + 1]));
      else ctx.lineTo(toPx(r.points[k]), toPx(r.points[k + 1]));
    }
    ctx.stroke();
  }

  // Roads: tracks, then roads, then the highway on top.
  for (const kind of ['track', 'road', 'highway'] as const) {
    const st = ROAD_STYLE[kind];
    for (const pass of [0, 1]) {
      if (pass === 0 && !st.casing) continue;
      ctx.strokeStyle = pass === 0 ? st.casing : st.color;
      ctx.lineWidth = pass === 0 ? st.width + 1.5 : st.width;
      for (const road of t.roads) {
        if (road.kind !== kind) continue;
        ctx.beginPath();
        for (let k = 0; k < road.points.length; k += 2) {
          if (k === 0) ctx.moveTo(toPx(road.points[k]), toPx(road.points[k + 1]));
          else ctx.lineTo(toPx(road.points[k]), toPx(road.points[k + 1]));
        }
        ctx.stroke();
      }
    }
  }

  // Airbase pavements (exaggerated ×1.5 so they read at this scale).
  const ab = t.airbase;
  if (ab?.paved) {
    ctx.fillStyle = '#e8e8e2';
    for (const p of ab.paved) {
      ctx.save();
      ctx.translate(toPx(p.x), toPx(p.z));
      ctx.rotate(p.heading);
      const w = Math.max(2, (p.width * 1.5) / px);
      const h = p.length / px;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }
    label(ctx, 'AIRBASE', toPx(ab.x), toPx(ab.z) - 22, '#ffffff');
  }

  // Target areas.
  ctx.font = 'bold 11px system-ui, sans-serif';
  for (const a of t.targetAreas) {
    const col = AREA_COLOR[a.kind] ?? '#fff';
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(toPx(a.x), toPx(a.z), Math.max(3, a.radius / px), 0, Math.PI * 2);
    ctx.stroke();
    if (a.heading !== undefined && a.kind === 'range') {
      // Run-in direction.
      const ex = Math.sin(a.heading);
      const ez = -Math.cos(a.heading);
      ctx.beginPath();
      ctx.moveTo(toPx(a.x - ex * 3000), toPx(a.z - ez * 3000));
      ctx.lineTo(toPx(a.x - ex * a.radius), toPx(a.z - ez * a.radius));
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    label(ctx, a.name, toPx(a.x) + a.radius / px + 4, toPx(a.z) + 4, col);
  }

  // Air start: arrow toward the first target area.
  const s = t.start;
  const ex = Math.sin(s.heading);
  const ez = -Math.cos(s.heading);
  const sx = toPx(s.x);
  const sz = toPx(s.z);
  ctx.strokeStyle = '#ff40ff';
  ctx.fillStyle = '#ff40ff';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(sx, sz);
  ctx.lineTo(sx + ex * 40, sz + ez * 40);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx + ex * 48, sz + ez * 48);
  ctx.lineTo(sx + ex * 36 - ez * 7, sz + ez * 36 + ex * 7);
  ctx.lineTo(sx + ex * 36 + ez * 7, sz + ez * 36 - ex * 7);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(sx, sz, 4, 0, Math.PI * 2);
  ctx.fill();
  label(ctx, 'START', sx - 18, sz + 18, '#ff40ff');
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

const PAGE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'auto',
  padding: 12,
  background: '#15181c',
  color: '#e6e6e6',
  font: '13px/1.4 system-ui, sans-serif',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const BAR: CSSProperties = { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' };
