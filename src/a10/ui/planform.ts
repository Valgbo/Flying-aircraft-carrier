/**
 * The A-10's top view as SVG paths, in metres in the BODY frame (x right, y = body z, so the nose
 * points up the screen). A drawing for the loadout schematic and the title mark, sized to the
 * public dimensions in data/aircraft.ts (span 17.53 m, length 16.26 m, wing area 47 m²);
 * tests/unit/a10/ui-planform.test.ts checks the drawing against them.
 */
import { A10 } from '../data/aircraft';
import { A10_GEOMETRY } from '../data/geometry';

type Pt = readonly [number, number];

const HALF_SPAN = A10.span / 2;
/** Nose (gun muzzle) and tail end along body z: the muzzle position anchors the length. */
export const NOSE_Z = A10_GEOMETRY.muzzle.z;
export const TAIL_Z = NOSE_Z + A10.length;

/** Fuselage half-width along the body (z, half-width), nose to tail. */
const FUSELAGE: readonly Pt[] = [
  [NOSE_Z + 0.75, 0.2],
  [NOSE_Z + 1.1, 0.42],
  [NOSE_Z + 1.7, 0.58],
  [NOSE_Z + 2.5, 0.66],
  [NOSE_Z + 3.5, 0.72],
  [-4.2, 0.76],
  [-3.0, 0.8],
  [-1.7, 0.82],
  [0.0, 0.82],
  [1.4, 0.78],
  [2.6, 0.68],
  [3.8, 0.56],
  [5.0, 0.44],
  [6.0, 0.34],
  [TAIL_Z - 0.55, 0.26],
  [TAIL_Z, 0.15],
];

/** Wing: straight centre section, tapered outer panels (root chord 3.05 m, tip 2.0 m). */
export const WING = {
  centreHalfSpan: 3.2,
  rootLe: -1.7,
  rootTe: 1.35,
  tipLe: -1.05,
  tipTe: 0.95,
} as const;

const fmt = (n: number) => Number(n.toFixed(3)).toString();

/** A closed path through `pts` smoothed with Catmull-Rom splines (tension 0.5). */
export function smoothClosedPath(pts: readonly Pt[]): string {
  const n = pts.length;
  let d = `M${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return `${d}Z`;
}

/** A straight-edged closed path. */
export function polygonPath(pts: readonly Pt[]): string {
  return `M${pts.map((p) => `${fmt(p[0])} ${fmt(p[1])}`).join('L')}Z`;
}

/** Outline of the fuselage (both sides), nose cone included. */
function fuselageOutline(): Pt[] {
  const right: Pt[] = FUSELAGE.map(([z, w]) => [w, z] as const);
  const left: Pt[] = [...FUSELAGE].reverse().map(([z, w]) => [-w, z] as const);
  return [[0, NOSE_Z + 0.55], ...right, ...left];
}

/** The wing as a polygon, tip to tip (the tips are drawn square; see wingPath). */
export function wingPolygon(): Pt[] {
  const { centreHalfSpan: c, rootLe, rootTe, tipLe, tipTe } = WING;
  return [
    [-HALF_SPAN, tipLe],
    [-c, rootLe],
    [c, rootLe],
    [HALF_SPAN, tipLe],
    [HALF_SPAN, tipTe],
    [c, rootTe],
    [-c, rootTe],
    [-HALF_SPAN, tipTe],
  ];
}

/** Shoelace area of a polygon, m². */
export function polygonArea(pts: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function wingPath(): string {
  const { centreHalfSpan: c, rootLe, rootTe, tipLe, tipTe } = WING;
  const r = 0.28;
  const s = HALF_SPAN;
  return (
    `M${fmt(-s + r)} ${fmt(tipLe)}L${fmt(-c)} ${fmt(rootLe)}L${fmt(c)} ${fmt(rootLe)}` +
    `L${fmt(s - r)} ${fmt(tipLe)}Q${fmt(s)} ${fmt(tipLe)} ${fmt(s)} ${fmt(tipLe + r)}` +
    `L${fmt(s)} ${fmt(tipTe - r)}Q${fmt(s)} ${fmt(tipTe)} ${fmt(s - r)} ${fmt(tipTe)}` +
    `L${fmt(c)} ${fmt(rootTe)}L${fmt(-c)} ${fmt(rootTe)}L${fmt(-s + r)} ${fmt(tipTe)}` +
    `Q${fmt(-s)} ${fmt(tipTe)} ${fmt(-s)} ${fmt(tipTe - r)}L${fmt(-s)} ${fmt(tipLe + r)}` +
    `Q${fmt(-s)} ${fmt(tipLe)} ${fmt(-s + r)} ${fmt(tipLe)}Z`
  );
}

/** A capsule (rounded rectangle) along body z centred on (x, z). */
export function capsulePath(x: number, z: number, length: number, width: number): string {
  const r = Math.min(width, length) / 2;
  const x0 = x - width / 2;
  const x1 = x + width / 2;
  const z0 = z - length / 2;
  const z1 = z + length / 2;
  return (
    `M${fmt(x0)} ${fmt(z0 + r)}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x1)} ${fmt(z0 + r)}` +
    `L${fmt(x1)} ${fmt(z1 - r)}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x0)} ${fmt(z1 - r)}Z`
  );
}

/** Main landing gear pods: fairings ahead of the wing leading edge. */
const GEAR_POD_X = 3.1;
/** Engine nacelles high on the rear fuselage. */
const NACELLE = { x: 1.62, z: 3.7, length: 3.6, width: 1.26 };
/** Horizontal tail and the twin fins at its tips. */
const TAIL = { halfSpan: 2.95, le: 5.75, te: 7.25 };

export interface PlanformPaths {
  wing: string;
  fuselage: string;
  /** Gun barrel ahead of the nose. */
  gun: string;
  canopy: { cx: number; cy: number; rx: number; ry: number };
  gearPods: string;
  nacelles: string;
  /** Intake and exhaust rims of the nacelles (stroked). */
  nacelleRims: string;
  tailplane: string;
  fins: string;
  /** Hinge lines of flaps, ailerons and elevators (stroked, faint). */
  hinges: string;
}

let cached: PlanformPaths | null = null;

export function planformPaths(): PlanformPaths {
  if (cached) return cached;
  const n = NACELLE;
  const nacelleRims = [-1, 1]
    .map((side) => {
      const x = side * n.x;
      const zf = n.z - n.length / 2 + 0.35;
      const za = n.z + n.length / 2 - 0.3;
      return `M${fmt(x - n.width / 2 + 0.08)} ${fmt(zf)}H${fmt(x + n.width / 2 - 0.08)}M${fmt(x - n.width / 2 + 0.12)} ${fmt(za)}H${fmt(x + n.width / 2 - 0.12)}`;
    })
    .join('');
  const t = TAIL;
  const hingeZ = (x: number) => {
    const ax = Math.abs(x);
    const f =
      ax <= WING.centreHalfSpan
        ? 0
        : (ax - WING.centreHalfSpan) / (HALF_SPAN - WING.centreHalfSpan);
    const le = WING.rootLe + (WING.tipLe - WING.rootLe) * f;
    const te = WING.rootTe + (WING.tipTe - WING.rootTe) * f;
    return le + (te - le) * 0.74;
  };
  const hinge = (x0: number, x1: number) =>
    `M${fmt(x0)} ${fmt(hingeZ(x0))}L${fmt(x1)} ${fmt(hingeZ(x1))}`;
  const hinges = [
    hinge(0.9, 4.7),
    hinge(5.0, HALF_SPAN - 0.35),
    hinge(-0.9, -4.7),
    hinge(-5.0, -HALF_SPAN + 0.35),
    `M0.35 ${fmt(t.le + 0.95)}H${fmt(t.halfSpan - 0.2)}M-0.35 ${fmt(t.le + 0.95)}H${fmt(-t.halfSpan + 0.2)}`,
  ].join('');
  cached = {
    wing: wingPath(),
    fuselage: smoothClosedPath(fuselageOutline()),
    gun: capsulePath(0, NOSE_Z + 0.42, 0.9, 0.12),
    canopy: { cx: 0, cy: A10_GEOMETRY.eye.z - 0.45, rx: 0.44, ry: 1.05 },
    gearPods: [-1, 1]
      .map((side) => capsulePath(side * GEAR_POD_X, WING.rootLe - 0.45, 2.1, 0.74))
      .join(''),
    nacelles: [-1, 1].map((side) => capsulePath(side * n.x, n.z, n.length, n.width)).join(''),
    nacelleRims,
    tailplane: polygonPath([
      [-t.halfSpan, t.le + 0.1],
      [-0.3, t.le],
      [0.3, t.le],
      [t.halfSpan, t.le + 0.1],
      [t.halfSpan, t.te],
      [-t.halfSpan, t.te],
    ]),
    fins: [-1, 1]
      .map((side) => capsulePath(side * t.halfSpan, (t.le + t.te) / 2 + 0.05, 2.2, 0.28))
      .join(''),
    hinges,
  };
  return cached;
}

/** The drawing's extent in metres (for viewBox): x −span/2…span/2, y nose…tail. */
export const PLANFORM_BOUNDS = {
  minX: -HALF_SPAN,
  maxX: HALF_SPAN,
  minY: NOSE_Z,
  maxY: TAIL_Z,
} as const;
