/**
 * The tactical awareness display (TAD): a heading-up moving map (PLAN_A10.md §7 "Display pages",
 * §2 realism aids; ARCHITECTURE §12.7). Drawn from the terrain data — roads, rivers, the
 * airbase's paved areas — with the own aircraft, the steerpoints, the SPI, the pod's point and,
 * only with the realism aid (`realism.mapMarkers`), the target areas.
 *
 * Map frame: the anchor (own aircraft, or the SPI when the map is centred on it) sits at a page
 * point; the map turns so the aircraft's heading points up; `range` nautical miles reach from the
 * anchor to the top of the screen (the A-10C TAD's range convention). Range and centre are the
 * avionics' page settings (TAD OSBs: `sim.avionics.pages`).
 *
 * Cost: every polyline is culled by its bounding circle, and a vertex is kept only once it is
 * ≈1.5 px from the last one kept, so the whole 64 km map at 160 nm is a few hundred strokes.
 */
import type { Sim } from '../../core/types';
import { NM } from '../../core/units';
import type { RoadPolyline } from '../../core/world/types';
import { clipSegment, type Box, type Segment, type Vec2 } from '../hud/hudMath';
import { ALIGN_LEFT } from '../hud/strokeFont';
import type { PageContext } from './context';
import { MFD_COLOR as C, MFD_TEXT as T, TAD } from './mfdLayout';
import type { MfdPainter } from './painter';

/** World → page transform of the map. */
export interface TadFrame {
  /** World point at the anchor, m. */
  ox: number;
  oz: number;
  /** Cosine and sine of the heading (map rotation). */
  cos: number;
  sin: number;
  /** Page units per metre. */
  k: number;
  /** Page point of the anchor. */
  ax: number;
  ay: number;
}

export function createTadFrame(): TadFrame {
  return { ox: 0, oz: 0, cos: 1, sin: 0, k: 1, ax: 0, ay: 0 };
}

/**
 * The map frame: anchored on the own aircraft (depressed, `TAD.ownAnchorY`) or on the SPI (the
 * page centre), heading up, `rangeNm` from the anchor to the top of the screen.
 */
export function tadFrame(
  ownX: number,
  ownZ: number,
  heading: number,
  rangeNm: number,
  centerOnSpi: boolean,
  spiX: number,
  spiZ: number,
  out: TadFrame,
): TadFrame {
  const range = Math.max(0.1, rangeNm) * NM;
  if (centerOnSpi) {
    out.ox = spiX;
    out.oz = spiZ;
    out.ax = 0;
    out.ay = 0;
  } else {
    out.ox = ownX;
    out.oz = ownZ;
    out.ax = 0;
    out.ay = TAD.ownAnchorY;
  }
  out.k = (1 - out.ay) / range;
  out.cos = Math.cos(heading);
  out.sin = Math.sin(heading);
  return out;
}

/**
 * Page point of the world point (x, z): ahead (the heading) is up, the right wing right.
 * World: +X east, +Z south; heading 0 = north, clockwise.
 */
export function tadProject(f: TadFrame, wx: number, wz: number, out: Vec2): Vec2 {
  const dx = wx - f.ox;
  const dz = wz - f.oz;
  out.x = f.ax + (dx * f.cos + dz * f.sin) * f.k;
  out.y = f.ay + (dx * f.sin - dz * f.cos) * f.k;
  return out;
}

/** What the last TAD drew (tests). */
export interface TadInfo {
  ownX: number;
  ownY: number;
  /** Strokes of roads and rivers drawn. */
  mapStrokes: number;
  steerpoints: number;
  spi: boolean;
  spiX: number;
  spiY: number;
  targetAreas: number;
}

export function createTadInfo(): TadInfo {
  return {
    ownX: 0,
    ownY: 0,
    mapStrokes: 0,
    steerpoints: 0,
    spi: false,
    spiX: 0,
    spiY: 0,
    targetAreas: 0,
  };
}

const CLIP: Box = { left: -TAD.clip, right: TAD.clip, bottom: -TAD.clip, top: TAD.clip };
const _f = createTadFrame();
const _p: Vec2 = { x: 0, y: 0 };
const _q: Vec2 = { x: 0, y: 0 };
const _seg: Segment = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Bounding circles of polylines (x, z, radius), computed once per polyline. */
const bounds = new WeakMap<Float64Array, Float64Array>();

function boundsOf(points: Float64Array): Float64Array {
  let b = bounds.get(points);
  if (!b) {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      x0 = Math.min(x0, points[i]);
      x1 = Math.max(x1, points[i]);
      z0 = Math.min(z0, points[i + 1]);
      z1 = Math.max(z1, points[i + 1]);
    }
    b = new Float64Array([(x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2]);
    bounds.set(points, b);
  }
  return b;
}

/** Draw a map polyline (x, z pairs), culled, decimated and clipped. Returns strokes drawn. */
function polyline(p: MfdPainter, f: TadFrame, pts: Float64Array, w: number): number {
  if (pts.length < 4) return 0;
  const b = boundsOf(pts);
  tadProject(f, b[0], b[1], _p);
  if (Math.hypot(_p.x, _p.y) - b[2] * f.k > TAD.clip * Math.SQRT2) return 0;
  let n = 0;
  tadProject(f, pts[0], pts[1], _p);
  let lx = _p.x;
  let ly = _p.y;
  const last = pts.length - 2;
  for (let i = 2; i < pts.length; i += 2) {
    tadProject(f, pts[i], pts[i + 1], _q);
    const dx = _q.x - lx;
    const dy = _q.y - ly;
    if (i < last && dx * dx + dy * dy < TAD.decimate * TAD.decimate) continue;
    if (clipSegment(lx, ly, _q.x, _q.y, CLIP, _seg)) {
      p.seg(_seg.x0, _seg.y0, _seg.x1, _seg.y1, w);
      n++;
    }
    lx = _q.x;
    ly = _q.y;
  }
  return n;
}

/** A clipped stroke between two world points. */
function worldSeg(
  p: MfdPainter,
  f: TadFrame,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): void {
  tadProject(f, x0, z0, _p);
  tadProject(f, x1, z1, _q);
  if (clipSegment(_p.x, _p.y, _q.x, _q.y, CLIP, _seg)) p.seg(_seg.x0, _seg.y0, _seg.x1, _seg.y1);
}

function inside(x: number, y: number): boolean {
  return x >= -TAD.clip && x <= TAD.clip && y >= -TAD.clip && y <= TAD.clip;
}

/** The own-aircraft symbol (an A-10 planform, heading up) at a page point. */
function ownShip(p: MfdPainter, x: number, y: number): void {
  p.seg(x, y + 0.055, x, y - 0.06, 1.6);
  p.seg(x - 0.06, y + 0.005, x + 0.06, y + 0.005, 1.6);
  p.seg(x - 0.028, y - 0.05, x + 0.028, y - 0.05, 1.6);
}

export function drawTad(ctx: PageContext, p: MfdPainter, info: TadInfo): void {
  const sim: Sim = ctx.sim;
  const ac = sim.aircraft;
  const av = sim.avionics;
  const terrain = sim.world.terrain;
  const ps = av.pages;
  const spi = av.spi;
  const f = tadFrame(
    ac.position.x,
    ac.position.z,
    ac.heading,
    ps.tadRange,
    ps.tadCenter === 'SPI' && spi.valid,
    spi.position.x,
    spi.position.z,
    _f,
  );
  info.mapStrokes = 0;
  info.steerpoints = 0;
  info.spi = false;
  info.targetAreas = 0;

  // Airbase paved areas.
  const base = terrain.airbase;
  if (base?.paved) {
    p.color(C.grey);
    for (let k = 0; k < base.paved.length; k++) {
      const a = base.paved[k];
      const ux = Math.sin(a.heading) * (a.length / 2);
      const uz = -Math.cos(a.heading) * (a.length / 2);
      const vx = Math.cos(a.heading) * (a.width / 2);
      const vz = Math.sin(a.heading) * (a.width / 2);
      worldSeg(p, f, a.x - ux - vx, a.z - uz - vz, a.x + ux - vx, a.z + uz - vz);
      worldSeg(p, f, a.x + ux - vx, a.z + uz - vz, a.x + ux + vx, a.z + uz + vz);
      worldSeg(p, f, a.x + ux + vx, a.z + uz + vz, a.x - ux + vx, a.z - uz + vz);
      worldSeg(p, f, a.x - ux + vx, a.z - uz + vz, a.x - ux - vx, a.z - uz - vz);
    }
  }
  // Rivers, then roads (highways brighter and wider).
  const rivers = terrain.rivers;
  if (rivers) {
    p.color(C.blue);
    for (let k = 0; k < rivers.length; k++)
      info.mapStrokes += polyline(p, f, rivers[k].points, 1.4);
  }
  const roads: readonly RoadPolyline[] = terrain.roads;
  for (let k = 0; k < roads.length; k++) {
    const r = roads[k];
    p.color(r.kind === 'track' ? C.grey : C.white);
    info.mapStrokes += polyline(p, f, r.points, r.kind === 'highway' ? 1.4 : 0.8);
  }

  // Target areas: only with the realism aid.
  if (sim.options.realism.mapMarkers) {
    p.color(C.yellow);
    const areas = terrain.targetAreas;
    for (let k = 0; k < areas.length; k++) {
      const a = areas[k];
      tadProject(f, a.x, a.z, _p);
      const r = Math.max(0.02, a.radius * f.k);
      if (!inside(_p.x, _p.y)) continue;
      p.circle(_p.x, _p.y, r, true);
      p.str(a.name, _p.x + r + 0.02, _p.y, T.small, ALIGN_LEFT);
      info.targetAreas++;
    }
  }

  // Range ring at half the range around the own aircraft.
  tadProject(f, ac.position.x, ac.position.z, _p);
  const ownX = _p.x;
  const ownY = _p.y;
  info.ownX = ownX;
  info.ownY = ownY;
  p.color(C.grey);
  const half = (ps.tadRange / 2) * NM * f.k;
  p.circle(ownX, ownY, half, true);
  p.buf.clear().fixed(ps.tadRange / 2, ps.tadRange / 2 < 10 ? 1 : 0);
  p.text(ownX + half * 0.72 + 0.02, ownY + half * 0.72, T.small, ALIGN_LEFT);

  // Steerpoints: the active one larger, with the line to it.
  const sps = av.steerpoints;
  const active = av.activeSteerpoint;
  for (let k = 0; k < sps.length; k++) {
    const sp = sps[k];
    tadProject(f, sp.position.x, sp.position.z, _p);
    const isActive = k === active;
    if (isActive) {
      p.color(C.cyan);
      if (clipSegment(ownX, ownY, _p.x, _p.y, CLIP, _seg))
        p.dashes(_seg.x0, _seg.y0, _seg.x1, _seg.y1, 8);
    }
    if (!inside(_p.x, _p.y)) continue;
    p.color(C.cyan);
    p.circle(_p.x, _p.y, isActive ? 0.032 : 0.022, false, isActive ? 1.6 : 1);
    p.buf.clear().int(sp.id);
    p.text(_p.x, _p.y - 0.06, T.small);
    info.steerpoints++;
  }

  // The pod's ground point.
  const tgp = sim.sensors.tgp;
  if (av.tgpPower && tgp.powered && tgp.warmup <= 0 && tgp.pointValid) {
    tadProject(f, tgp.point.x, tgp.point.z, _p);
    if (inside(_p.x, _p.y)) {
      p.color(C.green);
      p.diamond(_p.x, _p.y, 0.022);
    }
  }
  // SPI.
  if (spi.valid) {
    tadProject(f, spi.position.x, spi.position.z, _p);
    if (inside(_p.x, _p.y)) {
      p.color(C.white);
      p.diamond(_p.x, _p.y, 0.04, 1.4);
      p.seg(_p.x, _p.y, _p.x, _p.y, 3);
      p.str('SPI', _p.x + 0.055, _p.y + 0.04, T.small, ALIGN_LEFT);
      info.spi = true;
      info.spiX = _p.x;
      info.spiY = _p.y;
    }
  }

  // Own aircraft (always heading up on a heading-up map).
  p.color(C.cyan);
  if (inside(ownX, ownY)) ownShip(p, ownX, ownY);

  // North arrow (top left); the range is the RNG buttons' value.
  p.color(C.white);
  const nx = -0.55;
  const ny = 0.6;
  // North in page space: the world −Z direction turned by the heading.
  const sx = -f.sin;
  const sy = f.cos;
  p.seg(nx - sx * 0.05, ny - sy * 0.05, nx + sx * 0.06, ny + sy * 0.06, 1.4);
  p.str('N', nx + sx * 0.1, ny + sy * 0.1, T.small);
}
