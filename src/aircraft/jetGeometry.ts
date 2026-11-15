/**
 * Procedural geometry of the carrier's strike jet — an original design in the ship's own
 * faceted language: a chined, blended fuselage, a cranked-delta wing with a diamond section,
 * twin outward-canted tails, a dorsal intake behind the canopy and one flat, wide nozzle.
 *
 * Model frame: -Z forward (nose), +Y up, +X starboard, origin on the ground under the centre
 * of gravity (so placing the origin at deck height puts the wheels on the deck). Built to
 * JET_DIMS: nose at z = -8.4, nozzle at z = +8.6, span 11 m, tail tips 4.55 m up.
 *
 * Everything is flat-shaded triangle soup merged by material: airframe (vertex-coloured),
 * canopy glass, landing gear + hook, afterburner glow, navigation lights, tail-number decals.
 */
import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import { PALETTE } from '../config/palette';
import { JET_DIMS } from './opsConfig';

type P3 = readonly [x: number, y: number, z: number];

/** Collects coloured triangles; `mirror` flips everything to the port side. */
class SoupBuilder {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  private readonly uvs: number[] = [];
  mirror = false;

  /** Add a triangle wound so that its normal points along `facing` (roughly). */
  tri(a: P3, b: P3, c: P3, color: Color, facing: P3): void {
    const m = this.mirror ? -1 : 1;
    const ax = a[0] * m;
    const bx = b[0] * m;
    const cx = c[0] * m;
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (cx - ax) - (bx - ax) * (c[2] - a[2]);
    const nz = (bx - ax) * (c[1] - a[1]) - (b[1] - a[1]) * (cx - ax);
    const outward = nx * facing[0] * m + ny * facing[1] + nz * facing[2] >= 0;
    const second = outward ? b : c;
    const third = outward ? c : b;
    this.positions.push(ax, a[1], a[2], second[0] * m, second[1], second[2]);
    this.positions.push(third[0] * m, third[1], third[2]);
    for (let i = 0; i < 3; i++) this.colors.push(color.r, color.g, color.b);
  }

  quad(a: P3, b: P3, c: P3, d: P3, color: Color, facing: P3): void {
    this.tri(a, b, c, color, facing);
    this.tri(a, c, d, color, facing);
  }

  /** Triangle / quad facing away from `centre` (for closed, roughly convex parts). */
  triAway(a: P3, b: P3, c: P3, color: Color, centre: P3): void {
    this.tri(a, b, c, color, [
      (a[0] + b[0] + c[0]) / 3 - centre[0],
      (a[1] + b[1] + c[1]) / 3 - centre[1],
      (a[2] + b[2] + c[2]) / 3 - centre[2],
    ]);
  }

  quadAway(a: P3, b: P3, c: P3, d: P3, color: Color, centre: P3): void {
    this.triAway(a, b, c, color, centre);
    this.triAway(a, c, d, color, centre);
  }

  /** A textured quad (a → b along u, a → d along v) with a fixed winding. */
  decal(a: P3, b: P3, c: P3, d: P3): void {
    const corners: [P3, number, number][] = [
      [a, 0, 0],
      [b, 1, 0],
      [c, 1, 1],
      [a, 0, 0],
      [c, 1, 1],
      [d, 0, 1],
    ];
    for (const [p, u, v] of corners) {
      this.positions.push(p[0], p[1], p[2]);
      this.colors.push(1, 1, 1);
      this.uvs.push(u, v);
    }
  }

  /** A box between two end points with a square cross-section (struts, the hook). */
  bar(from: P3, to: P3, half: number, color: Color): void {
    const centre: P3 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
    // cross-section axes: X and whichever of Y / Z is more perpendicular to the bar
    const alongZ = Math.abs(to[2] - from[2]) > Math.abs(to[1] - from[1]);
    const ring = (p: P3): P3[] =>
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([u, v]) =>
        alongZ ? [p[0] + u * half, p[1] + v * half, p[2]] : [p[0] + u * half, p[1], p[2] + v * half],
      );
    const r0 = ring(from);
    const r1 = ring(to);
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4;
      this.quadAway(r0[k], r0[n], r1[n], r1[k], color, centre);
    }
    this.quadAway(r0[0], r0[1], r0[2], r0[3], color, centre);
    this.quadAway(r1[0], r1[1], r1[2], r1[3], color, centre);
  }

  /** A wheel: a short cylinder with its axle along X. */
  wheel(centre: P3, radius: number, halfWidth: number, color: Color, segments = 10): void {
    const rim = (side: number, i: number): P3 => {
      const a = (i / segments) * Math.PI * 2;
      return [
        centre[0] + side * halfWidth,
        centre[1] + Math.cos(a) * radius,
        centre[2] + Math.sin(a) * radius,
      ];
    };
    for (let i = 0; i < segments; i++) {
      this.quadAway(rim(-1, i), rim(-1, i + 1), rim(1, i + 1), rim(1, i), color, centre);
      for (const side of [-1, 1]) {
        const hub: P3 = [centre[0] + side * halfWidth, centre[1], centre[2]];
        this.tri(hub, rim(side, i), rim(side, i + 1), color, [side, 0, 0]);
      }
    }
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    if (this.uvs.length > 0) geometry.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
    // non-indexed, so every triangle gets its own face normal: the faceted look
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /** Run `add` for the starboard side and again mirrored for the port side. */
  bothSides(add: () => void): void {
    this.mirror = false;
    add();
    this.mirror = true;
    add();
    this.mirror = false;
  }
}

// ---- dimensions ----------------------------------------------------------------------------

const NOSE_Z = -JET_DIMS.nose;
const NOZZLE_Z = JET_DIMS.tail;
/** Height of the chine line (the fuselage's widest point) above the ground. */
const CHINE_Y = 2;

/** Fuselage cross-sections from nose to nozzle: a six-sided, chined lozenge. */
interface Station {
  z: number;
  /** Half-width at the chine, of the flat top and of the flat bottom. */
  w: number;
  wt: number;
  wb: number;
  yt: number;
  yb: number;
  yc: number;
}

const STATIONS: readonly Station[] = [
  { z: NOSE_Z, w: 0.06, wt: 0.03, wb: 0.03, yt: 2.0, yb: 1.92, yc: 1.96 },
  { z: -6.6, w: 0.62, wt: 0.22, wb: 0.3, yt: 2.38, yb: 1.6, yc: 1.98 },
  { z: -4.6, w: 1.05, wt: 0.42, wb: 0.55, yt: 2.62, yb: 1.38, yc: CHINE_Y },
  { z: -2.4, w: 1.45, wt: 0.62, wb: 0.85, yt: 2.78, yb: 1.26, yc: CHINE_Y },
  { z: 0.5, w: 1.7, wt: 0.78, wb: 1.05, yt: 2.84, yb: 1.2, yc: CHINE_Y },
  { z: 3.5, w: 1.7, wt: 0.78, wb: 1.05, yt: 2.74, yb: 1.22, yc: CHINE_Y },
  { z: 6.2, w: 1.45, wt: 0.68, wb: 0.9, yt: 2.56, yb: 1.34, yc: 1.98 },
  { z: 7.7, w: 1.05, wt: 0.55, wb: 0.7, yt: 2.4, yb: 1.5, yc: 1.95 },
];
/** The flat nozzle continues the last station and narrows to its exit. */
const NOZZLE_EXIT: Station = { z: NOZZLE_Z, w: 0.82, wt: 0.46, wb: 0.56, yt: 2.3, yb: 1.6, yc: 1.95 };

/** Centre of the nozzle exit — the afterburner glow is built around it. */
export const NOZZLE_CENTRE: P3 = [0, 1.95, NOZZLE_Z];
/** The landing gear folds flat toward this height (inside the wing and belly). */
export const GEAR_FOLD_Y = 1.95;

function ringOf(s: Station): P3[] {
  return [
    [-s.wt, s.yt, s.z],
    [s.wt, s.yt, s.z],
    [s.w, s.yc, s.z],
    [s.wb, s.yb, s.z],
    [-s.wb, s.yb, s.z],
    [-s.w, s.yc, s.z],
  ];
}

const WING = {
  rootX: 1.1,
  tipX: JET_DIMS.halfSpan,
  /** Planform [x, z]: root leading edge, crank, tip leading edge, tip trailing edge, root trailing edge. */
  rootLead: [1.1, -3.4],
  crank: [2.7, 0.9],
  tipLead: [JET_DIMS.halfSpan, 4.4],
  tipTrail: [JET_DIMS.halfSpan, 5.5],
  rootTrail: [1.1, 6.5],
  /** Ridge of the diamond section (thickest line), root and tip. */
  rootRidge: [1.1, 2.6],
  tipRidge: [JET_DIMS.halfSpan, 4.95],
} as const;

/** Mid-surface height of the wing at span station x (slight anhedral). */
function wingY(x: number): number {
  return CHINE_Y - 0.03 * (x - WING.rootX);
}

const TAIL = {
  baseX: 0.9,
  baseY: 2.1,
  /** Outward cant from the vertical. */
  cant: (27 * Math.PI) / 180,
  height: 2.75,
  /** Planform [z, height along the fin]. */
  baseLead: 4.0,
  baseTrail: 7.5,
  tipLead: 6.9,
  tipTrail: 8.5,
  /** The fin tip is painted dark from this height up. */
  bandFrom: 2.15,
} as const;

const TAIL_OUT: P3 = [Math.sin(TAIL.cant), Math.cos(TAIL.cant), 0];
const TAIL_NORMAL: P3 = [Math.cos(TAIL.cant), -Math.sin(TAIL.cant), 0];

/** Point on the starboard fin: `z`, `h` metres up the fin, `offset` metres outboard of its mid-plane. */
function finPoint(z: number, h: number, offset: number): P3 {
  return [
    TAIL.baseX + TAIL_OUT[0] * h + TAIL_NORMAL[0] * offset,
    TAIL.baseY + TAIL_OUT[1] * h + TAIL_NORMAL[1] * offset,
    z,
  ];
}

function finLead(h: number): number {
  return TAIL.baseLead + ((TAIL.tipLead - TAIL.baseLead) * h) / TAIL.height;
}

function finTrail(h: number): number {
  return TAIL.baseTrail + ((TAIL.tipTrail - TAIL.baseTrail) * h) / TAIL.height;
}

function finHalfThickness(h: number): number {
  return 0.085 - (0.055 * h) / TAIL.height;
}

// ---- parts ---------------------------------------------------------------------------------

function buildAirframe(): BufferGeometry {
  const b = new SoupBuilder();
  const top = new Color(PALETTE.jet);
  const dark = new Color(PALETTE.jetDark);
  const panel = top.clone().lerp(dark, 0.45);
  const metal = new Color(PALETTE.machineryDark);

  // fuselage loft: light above the chine, dark below it
  const loft = (from: Station, to: Station, upper: Color, lower: Color): void => {
    const r0 = ringOf(from);
    const r1 = ringOf(to);
    const axis: P3 = [0, (from.yc + to.yc) / 2, (from.z + to.z) / 2];
    for (let k = 0; k < 6; k++) {
      const n = (k + 1) % 6;
      const color = k === 0 || k === 1 || k === 5 ? upper : lower;
      b.quadAway(r0[k], r0[n], r1[n], r1[k], color, axis);
    }
  };
  for (let i = 0; i < STATIONS.length - 1; i++) loft(STATIONS[i], STATIONS[i + 1], top, dark);
  const last = STATIONS[STATIONS.length - 1];
  loft(last, NOZZLE_EXIT, metal, metal);
  const exit = ringOf(NOZZLE_EXIT);
  for (let k = 1; k < 5; k++) b.tri(exit[0], exit[k], exit[k + 1], metal, [0, 0, 1]);

  // dorsal intake: a raked scoop on the spine behind the canopy, fairing aft into the fuselage
  b.bothSides(() => {
    const lipLow: P3 = [0.62, 2.76, -1.9];
    const lipHigh: P3 = [0.5, 3.3, -1.65];
    const aft: P3 = [0.3, 2.72, 3.4];
    const centreLow: P3 = [0, 2.76, -1.9];
    const centreHigh: P3 = [0, 3.3, -1.65];
    const centreAft: P3 = [0, 2.72, 3.4];
    b.quad(centreLow, lipLow, lipHigh, centreHigh, metal, [0, 0.3, -1]);
    b.quad(centreHigh, lipHigh, aft, centreAft, top, [0, 1, 0]);
    b.tri(lipLow, aft, lipHigh, panel, [1, 0.4, 0]);
  });

  // wings: diamond section — a ridge line with facets falling to sharp leading and trailing edges
  b.bothSides(() => {
    const at = (p: readonly [number, number], half: number, side: number): P3 => [
      p[0],
      wingY(p[0]) + side * half,
      p[1],
    ];
    for (const side of [1, -1]) {
      const facing: P3 = [0, side, 0];
      const front = side > 0 ? top : dark;
      const rear = side > 0 ? panel : dark;
      const rootLead = at(WING.rootLead, 0.03, side);
      const crank = at(WING.crank, 0.03, side);
      const tipLead = at(WING.tipLead, 0.02, side);
      const tipTrail = at(WING.tipTrail, 0.02, side);
      const rootTrail = at(WING.rootTrail, 0.03, side);
      const rootRidge = at(WING.rootRidge, 0.2, side);
      const tipRidge = at(WING.tipRidge, 0.045, side);
      b.tri(rootRidge, rootLead, crank, front, facing);
      b.tri(rootRidge, crank, tipLead, front, facing);
      b.tri(rootRidge, tipLead, tipRidge, front, facing);
      b.quad(rootRidge, tipRidge, tipTrail, rootTrail, rear, facing);
    }
    // close the thin edges
    const rim: [readonly [number, number], number][] = [
      [WING.rootLead, 0.03],
      [WING.crank, 0.03],
      [WING.tipLead, 0.02],
      [WING.tipRidge, 0.045],
      [WING.tipTrail, 0.02],
      [WING.rootTrail, 0.03],
    ];
    const centre: P3 = [3, wingY(3), 3.2];
    for (let i = 0; i < rim.length - 1; i++) {
      const [p, hp] = rim[i];
      const [q, hq] = rim[i + 1];
      b.quadAway(
        [p[0], wingY(p[0]) + hp, p[1]],
        [q[0], wingY(q[0]) + hq, q[1]],
        [q[0], wingY(q[0]) - hq, q[1]],
        [p[0], wingY(p[0]) - hp, p[1]],
        dark,
        centre,
      );
    }
  });

  // twin canted fins with a dark tip band
  b.bothSides(() => {
    const slab = (h0: number, h1: number, color: Color): void => {
      const corners = (offsetSign: number): P3[] => [
        finPoint(finLead(h0), h0, offsetSign * finHalfThickness(h0)),
        finPoint(finTrail(h0), h0, offsetSign * finHalfThickness(h0)),
        finPoint(finTrail(h1), h1, offsetSign * finHalfThickness(h1)),
        finPoint(finLead(h1), h1, offsetSign * finHalfThickness(h1)),
      ];
      const outer = corners(1);
      const inner = corners(-1);
      b.quad(outer[0], outer[1], outer[2], outer[3], color, TAIL_NORMAL);
      b.quad(inner[0], inner[1], inner[2], inner[3], color, [
        -TAIL_NORMAL[0],
        -TAIL_NORMAL[1],
        0,
      ]);
      b.quad(outer[0], outer[3], inner[3], inner[0], color, [0, 0, -1]);
      b.quad(outer[1], outer[2], inner[2], inner[1], color, [0, 0, 1]);
      b.quad(outer[3], outer[2], inner[2], inner[3], color, TAIL_OUT);
    };
    slab(0, TAIL.bandFrom, top);
    slab(TAIL.bandFrom, TAIL.height, dark);
  });

  return b.build();
}

function buildCanopy(): BufferGeometry {
  const b = new SoupBuilder();
  const glass = new Color(PALETTE.glass);
  const centre: P3 = [0, 2.6, -4.4];
  const front: P3 = [0, 2.4, -6.3];
  const rear: P3 = [0, 2.76, -2.5];
  const ridgeFront: P3 = [0, 3.12, -5.0];
  const ridgeRear: P3 = [0, 3.15, -3.9];
  b.bothSides(() => {
    const sillFront: P3 = [0.37, 2.5, -5.2];
    const sillRear: P3 = [0.46, 2.62, -3.8];
    b.triAway(front, sillFront, ridgeFront, glass, centre);
    b.quadAway(sillFront, sillRear, ridgeRear, ridgeFront, glass, centre);
    b.triAway(sillRear, rear, ridgeRear, glass, centre);
  });
  return b.build();
}

function buildGear(): BufferGeometry {
  const b = new SoupBuilder();
  const strut = new Color(PALETTE.markingWhite).multiplyScalar(0.8);
  const tyre = new Color('#15181b');
  const hook = new Color(PALETTE.machineryDark);
  const hookTip = new Color(PALETTE.markingYellow);
  // nose gear
  b.bar([0, 1.55, -5.4], [0, 0.32, -5.4], 0.07, strut);
  b.wheel([0, 0.3, -5.4], 0.3, 0.11, tyre);
  // main gear, splayed out under the wing roots
  b.bothSides(() => {
    b.bar([1.3, 1.6, 1.3], [1.72, 0.42, 1.3], 0.085, strut);
    b.wheel([1.75, 0.38, 1.3], 0.38, 0.14, tyre);
  });
  // arrestor hook, trailing down to just above the deck
  b.bar([0, 1.45, 6.5], [0, 0.42, 8.25], 0.055, hook);
  b.bar([0, 0.42, 8.25], [0, 0.22, 8.6], 0.085, hookTip);
  return b.build();
}

/**
 * Afterburner: a glowing plate in the nozzle and a two-layer flame behind it, built around
 * the origin (the nozzle exit) pointing along +Z so the flame can be stretched with power.
 * Colours fade to black toward the tip — with additive blending that is a fade to nothing.
 */
function buildGlow(): BufferGeometry {
  const b = new SoupBuilder();
  const segments = 8;
  const ellipse = (rx: number, ry: number, z: number, i: number): P3 => {
    const a = (i / segments) * Math.PI * 2;
    return [Math.cos(a) * rx, Math.sin(a) * ry, z];
  };
  const plate = new Color(1, 0.62, 0.3);
  const outer = new Color(1, 0.5, 0.2);
  const core = new Color(0.75, 0.85, 1);
  const black = new Color(0, 0, 0);
  const cone = (rx: number, ry: number, length: number, color: Color): void => {
    const tip: P3 = [0, 0, length];
    for (let i = 0; i < segments; i++) {
      const p = ellipse(rx, ry, 0.04, i);
      const q = ellipse(rx, ry, 0.04, i + 1);
      const mid: P3 = [(p[0] + q[0]) / 4, (p[1] + q[1]) / 4, length / 2];
      b.triAway(p, q, mid, color, [0, 0, length / 4]);
      b.triAway(mid, tip, p, black, [0, 0, length / 2]);
      b.triAway(mid, q, tip, black, [0, 0, length / 2]);
    }
  };
  for (let i = 0; i < segments; i++) {
    b.tri([0, 0, 0.02], ellipse(0.66, 0.3, 0.02, i), ellipse(0.66, 0.3, 0.02, i + 1), plate, [
      0, 0, 1,
    ]);
  }
  cone(0.6, 0.28, 5.2, outer);
  cone(0.34, 0.16, 2.8, core);
  return b.build();
}

function buildNavLights(): BufferGeometry {
  const b = new SoupBuilder();
  // above 1 so they bloom; red to port, green to starboard
  const green = new Color(PALETTE.lightGreen).multiplyScalar(2.6);
  const red = new Color(PALETTE.lightRed).multiplyScalar(2.6);
  const light = (side: number, color: Color): void => {
    const x = side * (WING.tipX + 0.02);
    const y = wingY(WING.tipX);
    b.bar([x, y, 4.75], [x, y, 5.15], 0.07, color);
  };
  light(1, green);
  light(-1, red);
  return b.build();
}

/** Tail-number decals on the outboard face of both fins; u runs left to right as read from outside. */
function buildNumberDecals(): BufferGeometry {
  const b = new SoupBuilder();
  const h0 = 0.75;
  const h1 = 1.85;
  const zFront = 6.05;
  const zBack = 7.15;
  const lift = (h: number): number => finHalfThickness(h) + 0.025;
  // starboard fin, seen from starboard: the nose is to the right
  b.decal(
    finPoint(zBack, h0, lift(h0)),
    finPoint(zFront, h0, lift(h0)),
    finPoint(zFront, h1, lift(h1)),
    finPoint(zBack, h1, lift(h1)),
  );
  // port fin, seen from port: the nose is to the left
  const port = (p: P3): P3 => [-p[0], p[1], p[2]];
  b.decal(
    port(finPoint(zFront, h0, lift(h0))),
    port(finPoint(zBack, h0, lift(h0))),
    port(finPoint(zBack, h1, lift(h1))),
    port(finPoint(zFront, h1, lift(h1))),
  );
  return b.build();
}

export interface JetGeometries {
  airframe: BufferGeometry;
  canopy: BufferGeometry;
  gear: BufferGeometry;
  glow: BufferGeometry;
  navLights: BufferGeometry;
  numbers: BufferGeometry;
}

/** Build the shared geometry of the air wing. The caller disposes each geometry. */
export function buildJetGeometries(): JetGeometries {
  return {
    airframe: buildAirframe(),
    canopy: buildCanopy(),
    gear: buildGear(),
    glow: buildGlow(),
    navLights: buildNavLights(),
    numbers: buildNumberDecals(),
  };
}
