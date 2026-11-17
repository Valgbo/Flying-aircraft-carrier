/**
 * HUD geometry: pure functions for the collimated HUD (docs/a10/ARCHITECTURE.md §2, §6;
 * PLAN_A10.md §7). No rendering, no allocation per call (results go into `out` arguments).
 *
 * Three spaces are used:
 *  - BODY directions (+X right, +Y up, −Z nose): where a symbol is, seen from the pilot's eye.
 *    A collimated symbol is a direction only — it sits at infinity, like the ground it marks.
 *  - HUD ANGLES (az + right, el + up) relative to the boresight (body −Z), rad
 *    (core/frames.ts `hudAnglesFromBodyDir` / `bodyDirFromHudAngles`).
 *  - The HUD PLANE: gnomonic coordinates on the plane z = −1 in body coordinates, x right, y up.
 *    This is the flat image a real HUD draws and its optics collimate: straight lines stay
 *    straight, and every symbol is drawn there. Plane units ≈ radians near the boresight.
 */
import type { Vector3 } from 'three';

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface Angles {
  az: number;
  el: number;
}

export const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------------------------

/** HUD-plane point of HUD angles: (tan az, tan el / cos az). */
export function planeFromAngles(az: number, el: number, out: Vec2): Vec2 {
  out.x = Math.tan(az);
  out.y = Math.tan(el) / Math.cos(az);
  return out;
}

/** HUD angles of a HUD-plane point (the inverse of `planeFromAngles`). */
export function anglesFromPlane(x: number, y: number, out: Angles): Angles {
  out.az = Math.atan(x);
  out.el = Math.atan2(y, Math.hypot(x, 1));
  return out;
}

/**
 * HUD-plane point of a body-frame direction (need not be unit length). Returns false (and
 * leaves `out` unchanged) when the direction points sideways or behind the eye.
 */
export function planeFromDir(d: Vec3Like, out: Vec2): boolean {
  if (d.z > -1e-6) return false;
  out.x = d.x / -d.z;
  out.y = d.y / -d.z;
  return true;
}

// ---------------------------------------------------------------------------------------------
// The combiner glass seen from an eye
// ---------------------------------------------------------------------------------------------

/**
 * The combiner glass: four corners in body coordinates, in the order top-left, top-right,
 * bottom-right, bottom-left (data/geometry.ts `hudCorners`). It is a rectangle.
 */
export type GlassCorners = readonly [Vec3Like, Vec3Like, Vec3Like, Vec3Like];

/**
 * Where the ray from `eye` along `dir` crosses the plane of the glass, as glass coordinates:
 * u from the left edge (0) to the right edge (1), v from the top edge (0) to the bottom edge
 * (1). Returns false when the ray is parallel to the glass or the glass is behind the eye.
 * The ray passes THROUGH the glass when 0 ≤ u ≤ 1 and 0 ≤ v ≤ 1.
 */
export function rayGlassUV(eye: Vec3Like, dir: Vec3Like, glass: GlassCorners, out: Vec2): boolean {
  const tl = glass[0];
  const e1x = glass[1].x - tl.x;
  const e1y = glass[1].y - tl.y;
  const e1z = glass[1].z - tl.z;
  const e2x = glass[3].x - tl.x;
  const e2y = glass[3].y - tl.y;
  const e2z = glass[3].z - tl.z;
  // Plane normal n = e1 × e2 (any orientation works for the intersection).
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const denom = nx * dir.x + ny * dir.y + nz * dir.z;
  if (Math.abs(denom) < 1e-12) return false;
  const t = (nx * (tl.x - eye.x) + ny * (tl.y - eye.y) + nz * (tl.z - eye.z)) / denom;
  if (t <= 0) return false;
  const rx = eye.x + dir.x * t - tl.x;
  const ry = eye.y + dir.y * t - tl.y;
  const rz = eye.z + dir.z * t - tl.z;
  out.x = (rx * e1x + ry * e1y + rz * e1z) / (e1x * e1x + e1y * e1y + e1z * e1z);
  out.y = (rx * e2x + ry * e2y + rz * e2z) / (e2x * e2x + e2y * e2y + e2z * e2z);
  return true;
}

const _uv: Vec2 = { x: 0, y: 0 };

/** True when a symbol in body direction `dir` is visible through the glass from `eye`. */
export function seenThroughGlass(eye: Vec3Like, dir: Vec3Like, glass: GlassCorners): boolean {
  if (!rayGlassUV(eye, dir, glass, _uv)) return false;
  return _uv.x >= 0 && _uv.x <= 1 && _uv.y >= 0 && _uv.y <= 1;
}

/**
 * True when the direction passes BELOW the bottom edge of the glass from `eye` (the CCIP
 * pipper of a shallow dive; PLAN_A10.md §6.5). Directions that miss the glass plane entirely
 * count as below when they point down.
 */
export function belowGlass(eye: Vec3Like, dir: Vec3Like, glass: GlassCorners): boolean {
  if (!rayGlassUV(eye, dir, glass, _uv)) return dir.y < 0;
  return _uv.y > 1;
}

/** Angular extent of the glass seen from an eye, rad (HUD angles of its corners and edges). */
export interface GlassField {
  /** Elevation of the top edge on the boresight azimuth, and of the bottom edge. */
  top: number;
  bottom: number;
  /** Half-width in azimuth at the top edge and at the bottom edge (the glass is a trapezoid in angle). */
  halfWidthTop: number;
  halfWidthBottom: number;
  /** Azimuth of the glass centre line (0 when the eye is on the centreline). */
  center: number;
}

const _d = { x: 0, y: 0, z: 0 };
const _a: Angles = { az: 0, el: 0 };

function anglesOf(eye: Vec3Like, p: Vec3Like, out: Angles): Angles {
  _d.x = p.x - eye.x;
  _d.y = p.y - eye.y;
  _d.z = p.z - eye.z;
  out.az = Math.atan2(_d.x, -_d.z);
  out.el = Math.atan2(_d.y, Math.hypot(_d.x, _d.z));
  return out;
}

/** The glass's angular field seen from `eye` (layout of the fixed symbology, tests). */
export function glassField(eye: Vec3Like, glass: GlassCorners, out: GlassField): GlassField {
  const tl = anglesOf(eye, glass[0], _a);
  const tlAz = tl.az;
  const trAz = anglesOf(eye, glass[1], _a).az;
  const brAz = anglesOf(eye, glass[2], _a).az;
  const blAz = anglesOf(eye, glass[3], _a).az;
  // Edge midpoints give the elevation on the centre line.
  _mid.x = (glass[0].x + glass[1].x) / 2;
  _mid.y = (glass[0].y + glass[1].y) / 2;
  _mid.z = (glass[0].z + glass[1].z) / 2;
  out.top = anglesOf(eye, _mid, _a).el;
  _mid.x = (glass[2].x + glass[3].x) / 2;
  _mid.y = (glass[2].y + glass[3].y) / 2;
  _mid.z = (glass[2].z + glass[3].z) / 2;
  out.bottom = anglesOf(eye, _mid, _a).el;
  out.halfWidthTop = (trAz - tlAz) / 2;
  out.halfWidthBottom = (brAz - blAz) / 2;
  out.center = (tlAz + trAz + brAz + blAz) / 4;
  return out;
}
const _mid = { x: 0, y: 0, z: 0 };

/**
 * Where the bottom edge of the glass, seen from `eye`, crosses the HUD-plane segment a → b
 * (e.g. the bomb fall line from the velocity vector down to a CCIP pipper below the glass).
 * Writes the crossing point and returns the fraction along a → b (0..1), or -1 when the
 * segment does not cross the edge line.
 */
export function bottomEdgeCrossing(
  eye: Vec3Like,
  glass: GlassCorners,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  out: Vec2,
): number {
  // The bottom edge (a straight 3-D segment) is a straight line in the gnomonic plane.
  _d.x = glass[3].x - eye.x;
  _d.y = glass[3].y - eye.y;
  _d.z = glass[3].z - eye.z;
  if (!planeFromDir(_d, _p0)) return -1;
  _d.x = glass[2].x - eye.x;
  _d.y = glass[2].y - eye.y;
  _d.z = glass[2].z - eye.z;
  if (!planeFromDir(_d, _p1)) return -1;
  return segmentLineIntersection(ax, ay, bx, by, _p0.x, _p0.y, _p1.x, _p1.y, out);
}
const _p0: Vec2 = { x: 0, y: 0 };
const _p1: Vec2 = { x: 0, y: 0 };

/**
 * Intersection of the segment a → b with the infinite line through c and d. Returns the
 * fraction along a → b (0..1) and writes the point, or -1 when they do not meet on the segment.
 */
export function segmentLineIntersection(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  out: Vec2,
): number {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-15) return -1;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  if (t < 0 || t > 1) return -1;
  out.x = ax + rx * t;
  out.y = ay + ry * t;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

export interface Box {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Clip a segment to a box (Liang–Barsky). Returns false when nothing of it is inside;
 * otherwise writes the clipped segment into `out`.
 */
export function clipSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  box: Box,
  out: Segment,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  // Each edge: p·t ≤ q.
  for (let e = 0; e < 4; e++) {
    const p = e === 0 ? -dx : e === 1 ? dx : e === 2 ? -dy : dy;
    const q =
      e === 0 ? x0 - box.left : e === 1 ? box.right - x0 : e === 2 ? y0 - box.bottom : box.top - y0;
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  out.x0 = x0 + dx * t0;
  out.y0 = y0 + dy * t0;
  out.x1 = x0 + dx * t1;
  out.y1 = y0 + dy * t1;
  return true;
}

/** True when the point lies inside the box (edges included). */
export function inBox(x: number, y: number, box: Box): boolean {
  return x >= box.left && x <= box.right && y >= box.bottom && y <= box.top;
}

/** Clamp a point into a box; returns true when it had to be moved (a limited symbol). */
export function clampToBox(x: number, y: number, box: Box, out: Vec2): boolean {
  out.x = Math.min(box.right, Math.max(box.left, x));
  out.y = Math.min(box.top, Math.max(box.bottom, y));
  return out.x !== x || out.y !== y;
}

/**
 * Hold a target point on the edge of a box: where the ray from (cx, cy) (inside the box)
 * toward (tx, ty) leaves it, or the point itself when it is inside. A symbol held this way
 * still points the way to its target (the off-field SPI).
 */
export function holdOnBox(
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  box: Box,
  out: Vec2,
): Vec2 {
  const dx = tx - cx;
  const dy = ty - cy;
  let t = 1;
  if (dx > 0) t = Math.min(t, (box.right - cx) / dx);
  else if (dx < 0) t = Math.min(t, (box.left - cx) / dx);
  if (dy > 0) t = Math.min(t, (box.top - cy) / dy);
  else if (dy < 0) t = Math.min(t, (box.bottom - cy) / dy);
  t = Math.max(0, t);
  out.x = cx + dx * t;
  out.y = cy + dy * t;
  return out;
}

// ---------------------------------------------------------------------------------------------
// CCIP bombing cues
// ---------------------------------------------------------------------------------------------

const G0 = 9.80665;

/**
 * Where the minimum range staple sits on the projected bomb impact line, as a fraction of the
 * way from the velocity vector to the pipper. A bomb that falls for t seconds lands g·t²/2 below
 * the straight path the aircraft flies at speed V, so its drop angle from the velocity vector is
 * atan(g·t·cos γ / (2V + g·t·sin γ)) (γ the dive angle). The staple is the drop angle a release
 * at the profile's minimum height above the target would have, over the drop angle now, both
 * for a vacuum fall from the present path (drag and wind change the two nearly alike, so the
 * ratio holds). Above 1 the release is already too low. NaN when there is no answer.
 *
 * @param height height of the aircraft above the impact point, m
 * @param minAltitude the profile's minimum release height above the target, m
 * @param vx inertial velocity, world m/s (vy + up)
 */
export function minimumRangeFraction(
  height: number,
  minAltitude: number,
  vx: number,
  vy: number,
  vz: number,
): number {
  const v = Math.hypot(vx, vy, vz);
  if (!(height > 0) || !(minAltitude > 0) || v < 1) return NaN;
  const w = -vy;
  const sinG = Math.max(-1, Math.min(1, w / v));
  const cosG = Math.sqrt(1 - sinG * sinG);
  const t0 = (-w + Math.sqrt(w * w + 2 * G0 * height)) / G0;
  const tm = (-w + Math.sqrt(w * w + 2 * G0 * minAltitude)) / G0;
  const d0 = Math.atan2(G0 * t0 * cosG, 2 * v + G0 * t0 * sinG);
  const dm = Math.atan2(G0 * tm * cosG, 2 * v + G0 * tm * sinG);
  return d0 > 1e-9 ? dm / d0 : NaN;
}

// ---------------------------------------------------------------------------------------------
// Pitch ladder
// ---------------------------------------------------------------------------------------------

/**
 * The frame the pitch ladder is built in, all in BODY coordinates:
 *  - `h`: the horizontal direction (world-horizontal) of the vertical plane through the
 *    velocity vector — the ladder is centred laterally on the velocity vector;
 *  - `u`: world up;
 *  - `s`: h × u, the world-horizontal direction to the right of that plane (rung axis).
 * The rung for pitch p points at cos p·h + sin p·u, so the 0° rung lies ON the true horizon
 * and every rung sits at its true elevation (conformal ladder), rolled with the bank.
 */
export interface LadderBasis {
  h: Vector3;
  u: Vector3;
  s: Vector3;
}

/**
 * Build the ladder basis from the (possibly limited) velocity-vector direction and world up,
 * both in body coordinates. When the velocity vector is (nearly) vertical, `fallback` (e.g.
 * the nose, body −Z) gives the azimuth instead. Returns false if no basis can be formed.
 */
export function ladderBasis(
  tvv: Vec3Like,
  up: Vec3Like,
  fallback: Vec3Like,
  out: LadderBasis,
): boolean {
  if (!horizontal(tvv, up, out.h) && !horizontal(fallback, up, out.h)) return false;
  out.u.set(up.x, up.y, up.z).normalize();
  out.s.crossVectors(out.h, out.u).normalize();
  return true;
}

function horizontal(v: Vec3Like, up: Vec3Like, out: Vector3): boolean {
  const ul = Math.hypot(up.x, up.y, up.z) || 1;
  const ux = up.x / ul;
  const uy = up.y / ul;
  const uz = up.z / ul;
  const k = v.x * ux + v.y * uy + v.z * uz;
  out.set(v.x - k * ux, v.y - k * uy, v.z - k * uz);
  const len = out.length();
  if (len < 1e-4 * (Math.hypot(v.x, v.y, v.z) || 1)) return false;
  out.multiplyScalar(1 / len);
  return true;
}

/**
 * A point of a ladder rung as a body direction: the rung for pitch `p` (rad) is centred on
 * cos p·h + sin p·u; `a` moves along the rung axis s (+ right), `b` along the local "up the
 * ladder" direction (+ toward higher pitch). a, b are tangents (≈ rad). Not normalised.
 */
export function rungDir(
  basis: LadderBasis,
  p: number,
  a: number,
  b: number,
  out: Vec3Like,
): Vec3Like {
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const { h, u, s } = basis;
  // centre = cp·h + sp·u ; upward tangent = −sp·h + cp·u
  out.x = cp * h.x + sp * u.x + a * s.x + b * (-sp * h.x + cp * u.x);
  out.y = cp * h.y + sp * u.y + a * s.y + b * (-sp * h.y + cp * u.y);
  out.z = cp * h.z + sp * u.z + a * s.z + b * (-sp * h.z + cp * u.z);
  return out;
}

/**
 * Which ladder rungs to draw: every `stepDeg` from −90° to +90° within `spanDeg` of the
 * flight-path angle `gammaDeg`. Writes them into `out` (pitch, degrees) and returns the count.
 */
export function ladderRungs(
  gammaDeg: number,
  spanDeg: number,
  stepDeg: number,
  out: Int16Array,
): number {
  const lo = Math.max(-90, Math.ceil((gammaDeg - spanDeg) / stepDeg) * stepDeg);
  const hi = Math.min(90, Math.floor((gammaDeg + spanDeg) / stepDeg) * stepDeg);
  let n = 0;
  for (let p = lo; p <= hi && n < out.length; p += stepDeg) out[n++] = p;
  return n;
}

/**
 * Bend of a ladder half-rung toward the horizon, rad: the negative (dive) rungs of the A-10C
 * ladder are dashed and angled at half the pitch angle so a glance tells climb from dive;
 * climb rungs are straight.
 */
export function rungBend(pitchDeg: number): number {
  return pitchDeg < 0 ? (-pitchDeg * DEG) / 2 : 0;
}

// ---------------------------------------------------------------------------------------------
// Gun reticle range bar
// ---------------------------------------------------------------------------------------------

/**
 * Sweep of the analog range bar, rad: proportional to slant range, a full circle at
 * `fullScale` metres, clamped to [0, 2π]. It is drawn from 12 o'clock counter-clockwise.
 */
export function rangeBarSweep(slantRange: number, fullScale: number): number {
  if (!(slantRange > 0) || !(fullScale > 0)) return 0;
  return Math.min(1, slantRange / fullScale) * Math.PI * 2;
}

/**
 * Point on a reticle circle at `angle` rad counter-clockwise from 12 o'clock (the range-bar
 * convention), around (cx, cy) with radius r.
 */
export function clockPoint(cx: number, cy: number, r: number, angle: number, out: Vec2): Vec2 {
  out.x = cx - r * Math.sin(angle);
  out.y = cy + r * Math.cos(angle);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Heading tape
// ---------------------------------------------------------------------------------------------

/** Signed difference a − b of two compass angles, degrees in (−180, 180]. */
export function headingDelta(aDeg: number, bDeg: number): number {
  let d = (aDeg - bDeg) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * The marks of a heading tape centred on `headingDeg`, `halfSpanDeg` either side, every
 * `stepDeg`: writes each mark's heading (0..359) and its offset from the centre in degrees
 * (+ right) into `marks`/`offsets` and returns the count.
 */
export function headingTapeMarks(
  headingDeg: number,
  halfSpanDeg: number,
  stepDeg: number,
  marks: Int16Array,
  offsets: Float32Array,
): number {
  const first = Math.ceil((headingDeg - halfSpanDeg) / stepDeg) * stepDeg;
  let n = 0;
  for (let m = first; m <= headingDeg + halfSpanDeg && n < marks.length; m += stepDeg) {
    marks[n] = ((m % 360) + 360) % 360;
    offsets[n] = m - headingDeg;
    n++;
  }
  return n;
}

/** Label of a heading mark on the tape: tens of degrees, 1..36 (north is 36). */
export function headingLabel(markDeg: number): number {
  const t = Math.round(markDeg / 10) % 36;
  return t === 0 ? 36 : t;
}

// ---------------------------------------------------------------------------------------------
// Text without allocation
// ---------------------------------------------------------------------------------------------

/**
 * A reusable character buffer (char codes) for HUD text, filled without allocating: numbers
 * are written digit by digit, constant strings by charCodeAt.
 */
export class TextBuf {
  readonly codes: Uint8Array;
  len = 0;
  private readonly tmp = new Uint8Array(24);

  constructor(capacity = 48) {
    this.codes = new Uint8Array(capacity);
  }

  clear(): this {
    this.len = 0;
    return this;
  }

  ch(code: number): this {
    if (this.len < this.codes.length) this.codes[this.len++] = code;
    return this;
  }

  /** Append a string (char codes ≤ 255; others become '?'), at most `max` characters. */
  str(s: string, max = 1e9): this {
    const n = Math.min(s.length, max);
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      this.ch(c < 256 ? c : 63);
    }
    return this;
  }

  /** Append a non-negative integer (rounded), zero-padded to `minDigits`. Negative → '-'. */
  int(value: number, minDigits = 1): this {
    if (!Number.isFinite(value)) return this.ch(45).ch(45);
    let v = Math.round(value);
    if (v < 0) {
      this.ch(45);
      v = -v;
    }
    let n = 0;
    do {
      this.tmp[n++] = 48 + (v % 10);
      v = Math.floor(v / 10);
    } while (v > 0 && n < this.tmp.length);
    while (n < minDigits && n < this.tmp.length) this.tmp[n++] = 48;
    while (n > 0) this.ch(this.tmp[--n]);
    return this;
  }

  /** Append a number with a fixed count of decimals (rounded half up), e.g. 4.0, 12.35. */
  fixed(value: number, decimals: number): this {
    if (!Number.isFinite(value)) return this.ch(45).ch(45);
    const scale = 10 ** decimals;
    let v = Math.round(Math.abs(value) * scale);
    if (value < 0 && v > 0) this.ch(45);
    const whole = Math.floor(v / scale);
    v -= whole * scale;
    this.int(whole);
    if (decimals > 0) {
      this.ch(46);
      this.int(v, decimals);
    }
    return this;
  }

  /** Append a duration as m:ss, or h:mm:ss from one hour. Negative or non-finite → --:--. */
  time(seconds: number): this {
    if (!Number.isFinite(seconds) || seconds < 0) return this.str('--:--');
    let s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    if (h > 0) this.int(h).ch(58).int(m, 2);
    else this.int(m);
    return this.ch(58).int(s, 2);
  }

  /** The text as a string (tests and debugging only: allocates). */
  toString(): string {
    let s = '';
    for (let i = 0; i < this.len; i++) s += String.fromCharCode(this.codes[i]);
    return s;
  }
}
