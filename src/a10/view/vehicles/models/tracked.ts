/**
 * Tracked vehicles built from their VehicleShape (data/vehicles.ts): the T-72-class main battle
 * tank (and the range hulk made from its hull) and the BMP-class infantry fighting vehicle.
 * Every dimension below is derived from the shape fields; the proportions follow photographs of
 * the classes (sloped glacis, low rounded cast turret, six road wheels a side with return rollers,
 * external fuel drums at the rear of the tank; wedge nose and small turret of the IFV).
 */
import { Matrix4, Vector2 } from 'three';
import type { VehicleShape } from '../../../core/targets/types';
import { VEHICLE_PALETTE as P } from '../palette';
import { ModelBuilder, PART, ZONE } from './builder';

const DEG = Math.PI / 180;

export interface TrackedOptions {
  /** 'mbt' (rear sprocket, drums, cast turret) or 'ifv' (front sprocket, small turret). */
  style: 'mbt' | 'ifv';
  /** External fuel drums at the rear (not on the hulk). */
  drums: boolean;
  /** Level of detail: 0 near (full), 1 far (simple). */
  lod: 0 | 1;
}

function rect(w: number, y0: number, y1: number): number[] {
  return [-w, y0, w, y0, w, y1, -w, y1];
}

export interface RunningGearLayout {
  rw: number;
  yw: number;
  wheelsZ: number[];
  yTop: number;
  th: number;
}

/** Road wheels, sprocket, idler, return rollers and the track belt on one side (+1 right). */
function runningGear(b: ModelBuilder, s: VehicleShape, side: 1 | -1, style: 'mbt' | 'ifv'): RunningGearLayout {
  const L = s.hullLength;
  const W = s.hullWidth;
  const C = s.hullClearance;
  const tw = s.running.type === 'tracks' ? s.running.width : 0.4;
  const xo = side * (W / 2 - 0.02);
  const xi = side * (W / 2 - 0.02 - tw);
  const x0 = Math.min(xo, xi);
  const x1 = Math.max(xo, xi);
  const th = 0.075;
  const rw = Math.min(0.42, Math.max(0.28, C * 0.8));
  const yw = rw + th;
  const nW = 6;
  const zF = -L / 2 + 0.95;
  const zR = L / 2 - 1.0;
  const wheelsZ: number[] = [];
  for (let i = 0; i < nW; i++) wheelsZ.push(zF + ((zR - zF) * i) / (nW - 1));
  const frontDrive = style === 'ifv';
  const rs = rw * 0.82;
  const ri = rw * 0.78;
  const zs = frontDrive ? -L / 2 + 0.34 : L / 2 - 0.34;
  const zi = frontDrive ? L / 2 - 0.32 : -L / 2 + 0.32;
  const ys = yw + 0.17;
  const yi = yw + 0.13;
  const yTop = Math.max(yw + rw, ys + rs, yi + ri) + th;

  // ---- the belt ----
  const seg = b.seg(7, 3);
  const path: Vector2[] = [];
  const front = { y: frontDrive ? ys : yi, z: frontDrive ? zs : zi, r: (frontDrive ? rs : ri) + th };
  const rear = { y: frontDrive ? yi : ys, z: frontDrive ? zi : zs, r: (frontDrive ? ri : rs) + th };
  path.push(new Vector2(0, zF), new Vector2(0, zR));
  for (let i = 0; i <= seg; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / seg;
    path.push(new Vector2(rear.y + Math.sin(a) * rear.r, rear.z + Math.cos(a) * rear.r));
  }
  // top run with a slight sag between the return rollers
  const nTop = 4;
  for (let i = 1; i < nTop; i++) {
    const f = i / nTop;
    const z = rear.z + (front.z - rear.z) * f;
    const y = rear.y + rear.r + (front.y + front.r - rear.y - rear.r) * f - 0.03 * Math.sin(f * Math.PI * 3) ** 2;
    path.push(new Vector2(y, z));
  }
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / seg;
    path.push(new Vector2(front.y + Math.sin(a) * front.r, front.z + Math.cos(a) * front.r));
  }
  b.setColor(P.trackSteel).setZone(ZONE.running);
  b.trackLoop(x0 + 0.005, x1 - 0.005, path, th, PART.track);

  // ---- wheels (rotate about their axles) ----
  const wseg = b.seg(16, 8);
  const outer = side > 0 ? x1 - 0.035 : x0 + 0.035;
  const inner = side > 0 ? x0 + 0.035 : x1 - 0.035;
  const face = side as 1 | -1;
  const wheel = (y: number, z: number, r: number, toothed: boolean) => {
    const aux = [y, z, r, PART.wheel];
    b.setPart(PART.wheel, y, z, r);
    b.setColor(P.rubber);
    b.cylinderX(Math.min(outer, inner), Math.max(outer, inner), y, z, r, wseg, false, aux);
    b.setColor(P.paint);
    b.discX(outer + face * 0.004, y, z, r * 0.84, wseg, face, aux);
    b.discX(inner - face * 0.004, y, z, r * 0.84, wseg, (-face) as 1 | -1, aux);
    // hub and the holes in the wheel disc show the wheel turning
    b.setColor(P.paintDark);
    b.cylinderX(Math.min(outer, outer + face * 0.07), Math.max(outer, outer + face * 0.07), y, z, r * 0.25, b.seg(8, 6), true, aux);
    if (b.detail > 0.6) {
      b.setColor(P.bareSteel);
      const holes = toothed ? 0 : 6;
      for (let k = 0; k < holes; k++) {
        const a = (k / holes) * Math.PI * 2;
        b.discX(outer + face * 0.008, y + Math.cos(a) * r * 0.55, z + Math.sin(a) * r * 0.55, r * 0.12, 6, face, aux);
      }
    }
    if (toothed) {
      b.setColor(P.bareSteel);
      const teeth = 12;
      for (let k = 0; k < teeth; k++) {
        const a = (k / teeth) * Math.PI * 2;
        const ty = y + Math.cos(a) * r * 1.02;
        const tz = z + Math.sin(a) * r * 1.02;
        b.push(new Matrix4().makeTranslation(0, ty, tz).multiply(new Matrix4().makeRotationX(a)));
        b.box((outer + inner) / 2, 0, 0, Math.abs(outer - inner) * 0.4, 0.09, 0.07);
        b.pop();
      }
    }
  };
  for (const z of wheelsZ) wheel(yw, z, rw, false);
  wheel(ys, zs, rs, true);
  wheel(yi, zi, ri, false);
  // return rollers under the top run
  const rr = 0.1;
  const yr = yTop - th - rr;
  for (let k = 0; k < 3; k++) {
    const z = wheelsZ[1] + ((wheelsZ[4] - wheelsZ[1]) * k) / 2;
    const aux = [yr, z, rr, PART.wheel];
    b.setPart(PART.wheel, yr, z, rr);
    b.setColor(P.rubber);
    b.cylinderX(Math.min(outer, inner) + 0.05, Math.max(outer, inner) - 0.05, yr, z, rr, b.seg(8, 6), true, aux);
  }

  // ---- the track lying on the ground beside the hull when it is thrown (mobility kill) ----
  b.setPart(PART.thrownTrack).setColor(P.trackSteel).setZone(ZONE.running);
  const xt = side * (W / 2 + 0.45);
  b.push(new Matrix4().makeRotationY(side * 0.12));
  b.box(xt, 0.035, 0.6, tw, 0.07, L * 0.85);
  b.pop();
  b.box(side * (W / 2 + 0.2), 0.04, -L / 2 - 0.6, tw * 0.9, 0.08, 1.6);
  b.setPart(PART.hull);
  return { rw, yw, wheelsZ, yTop, th };
}

/** The tank's or the IFV's hull and fittings (everything that does not turn). */
function hullMbt(b: ModelBuilder, s: VehicleShape, opts: TrackedOptions, yTop: number): void {
  const L = s.hullLength;
  const W = s.hullWidth;
  const C = s.hullClearance;
  const H = s.hullHeight;
  const tw = s.running.type === 'tracks' ? s.running.width : 0.5;
  const top = C + H;
  const wl = W / 2 - tw - 0.06;
  const yN = C + 0.42 * H;
  const slope = Math.tan(22 * DEG);
  const zG = -L / 2 + (top - yN) / slope;
  b.setPart(PART.hull).setColor(P.paint).setZone(ZONE.hull);
  b.loft([
    { z: -L / 2, pts: rect(wl * 0.97, yN - 0.05, yN + 0.02) },
    { z: -L / 2 + 0.5, pts: rect(wl, C, yN + 0.5 * slope) },
    { z: zG, pts: rect(wl, C, top) },
    { z: L / 2 - 0.3, pts: rect(wl, C, top) },
    { z: L / 2, pts: rect(wl, C + 0.2, top - 0.1) },
  ]);
  // fenders over the tracks
  const yF = yTop + 0.03;
  const fw = W / 2 - wl;
  for (const side of [-1, 1]) {
    const xc = side * (wl + fw / 2);
    b.box(xc, yF, 0.08, fw, 0.035, L - 0.3);
    // front mud flap angled down over the idler
    b.push(new Matrix4().makeTranslation(xc, yF - 0.12, -L / 2 + 0.05).multiply(new Matrix4().makeRotationX(-38 * DEG)));
    b.box(0, 0, 0, fw, 0.03, 0.45);
    b.pop();
    // hull side plate above the fender
    if (opts.lod === 0) {
      // stowage: fuel cells along the right fender, boxes on the left one
      const boxes = side > 0 ? [-0.7, 0.25, 1.2, 2.15] : [-2.2, -1.3, -0.4];
      for (const z of boxes) {
        if (z > L / 2 - 0.5) continue;
        b.setColor(side > 0 ? P.paintDark : P.paint);
        b.box(xc, yF + 0.22, z, fw - 0.06, 0.4, 0.82);
      }
      b.setColor(P.paint);
    }
  }
  // exhaust outlet on the left rear fender line
  b.setColor(P.grille).setZone(ZONE.exhaust).setPart(PART.bare);
  b.box(-(wl + 0.02), yF + 0.18, L / 2 - 1.55, 0.06, 0.22, 0.55);
  // engine deck grilles
  b.setZone(ZONE.engine);
  for (const x of [-0.55, 0.55]) b.box(x, top + 0.015, L / 2 - 1.05, 0.75, 0.03, 1.5);
  b.setZone(ZONE.engineHull).setPart(PART.hull).setColor(P.paint);
  b.box(0, top + 0.03, L / 2 - 1.05, 0.25, 0.06, 1.6);
  b.setZone(ZONE.hull);
  if (opts.lod === 0) {
    // headlights on the glacis, the driver's hatch and periscope
    b.setColor(P.lens).setPart(PART.bare);
    for (const x of [-(wl - 0.18), wl - 0.18]) {
      const z = -L / 2 + 0.95;
      b.box(x, yN + (z + L / 2) * slope + 0.07, z, 0.16, 0.14, 0.12);
    }
    b.setColor(P.paintDark).setPart(PART.hull);
    b.cylinderY(0, zG + 0.15, top, top + 0.07, 0.3, b.seg(10, 6));
    b.setColor(P.glass).setPart(PART.glass);
    b.box(0, top + 0.1, zG - 0.05, 0.3, 0.07, 0.08);
    // a splash board across the glacis
    b.setColor(P.paint).setPart(PART.hull);
    b.box(0, yN + 0.95 * slope + 0.04, -L / 2 + 0.95, wl * 1.6, 0.08, 0.06);
  }
  if (opts.drums) {
    // two external 200 l fuel drums across the rear, and the unditching beam
    const r = 0.29;
    const yd = top - 0.27;
    for (const x of [-0.56, 0.56]) {
      b.setColor(P.drum).setPart(PART.hull);
      b.cylinderX(x - 0.44, x + 0.44, yd, L / 2 + r + 0.02, r, b.seg(12, 6), true);
      if (opts.lod === 0) {
        b.setColor(P.drumBand);
        for (const dx of [-0.2, 0.2]) b.cylinderX(x + dx - 0.02, x + dx + 0.02, yd, L / 2 + r + 0.02, r + 0.012, b.seg(12, 6), false);
      }
    }
    if (opts.lod === 0) {
      b.setColor(P.woodDark).setPart(PART.bare);
      b.cylinderX(-1.05, 1.05, top + 0.06, L / 2 - 0.12, 0.11, b.seg(8, 5), true);
    }
  }
  b.setPart(PART.hull).setColor(P.paint);
}

/** The T-72-class cast turret with its gun (yaw about the ring, gun elevates on the trunnion). */
function turretMbt(b: ModelBuilder, s: VehicleShape, opts: TrackedOptions): void {
  if (!s.turret) return;
  const top = s.hullClearance + s.hullHeight;
  const tz = s.turret.offsetZ;
  const R = s.turret.radius;
  const Ht = s.turret.height;
  const front = tz - R * 1.08;
  const pivotY = top + Ht * 0.42;
  const pivotZ = front + 0.12;
  b.setPart(PART.turret, tz, pivotY, pivotZ).setColor(P.paint).setZone(ZONE.hull);
  b.cylinderY(0, tz, top - 0.02, top + 0.09, R * 0.9, b.seg(18, 8), false);
  const radius = (th: number) => R * (1 + 0.1 * Math.cos(th) - 0.03 * Math.cos(2 * th));
  b.dome(0, tz, top + 0.06, Ht - 0.06, radius, b.seg(24, 10), opts.lod === 0 ? b.seg(7, 3) : 2, 0.55);
  if (opts.lod === 0) {
    // commander's cupola (right) with its machine gun, gunner's sight (left), searchlight, snorkel
    const domeY = (x: number, z: number) => {
      const r = Math.hypot(x, z - tz) / R;
      return top + 0.06 + (Ht - 0.06) * Math.max(0, 1 - r * r) ** 0.6;
    };
    const cx = R * 0.42;
    const cz = tz + 0.12;
    const cy = domeY(cx, cz);
    b.setColor(P.paintDark);
    b.cylinderY(cx, cz, cy - 0.08, cy + 0.14, 0.33, b.seg(12, 6));
    b.setPart(PART.turretBare, tz, pivotY, pivotZ).setColor(P.bareSteel);
    b.tubeZ(cx + 0.05, cy + 0.27, cz - 1.05, cz - 0.15, 0.03, 0.03, 5);
    b.box(cx + 0.05, cy + 0.2, cz - 0.2, 0.12, 0.14, 0.3);
    b.setPart(PART.turret, tz, pivotY, pivotZ).setColor(P.paintDark);
    const gx = -R * 0.4;
    const gz = tz - R * 0.45;
    b.box(gx, domeY(gx, gz) + 0.08, gz, 0.26, 0.24, 0.36);
    b.setColor(P.glass).setPart(PART.turretBare, tz, pivotY, pivotZ);
    b.box(gx, domeY(gx, gz) + 0.12, gz - 0.185, 0.18, 0.1, 0.02);
    // infrared searchlight right of the gun
    b.setColor(P.paintDark).setPart(PART.turret, tz, pivotY, pivotZ);
    b.tubeZ(0.42, pivotY + 0.32, front + 0.1, front + 0.55, 0.16, 0.16, b.seg(10, 6));
    b.setColor(P.lens).setPart(PART.turretBare, tz, pivotY, pivotZ);
    b.tubeZ(0.42, pivotY + 0.32, front + 0.08, front + 0.1, 0.13, 0.13, b.seg(10, 6), true, false);
    // snorkel stowed across the turret rear
    b.setColor(P.paint).setPart(PART.turret, tz, pivotY, pivotZ);
    b.cylinderX(-0.65, 0.55, top + 0.42, tz + R * 0.98, 0.09, b.seg(8, 5), true);
    // smoke grenade dischargers either side of the gun
    b.setColor(P.paintDark);
    for (const side of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        const a = (side * (28 + k * 9) * Math.PI) / 180;
        const x = Math.sin(a) * radius(a) * 0.98;
        const z = tz - Math.cos(a) * radius(a) * 0.98;
        b.box(x, top + Ht * 0.55, z, 0.07, 0.07, 0.16);
      }
    }
  }

  // ---- the gun ----
  b.setPart(PART.gun, tz, pivotY, pivotZ).setColor(P.paint).setZone(ZONE.hull);
  const seg = b.seg(12, 5);
  const muzzleZ = front - s.gunLength;
  b.tubeZ(0, pivotY, front - 0.32, pivotZ + 0.1, 0.19, 0.24, seg); // mantlet
  if (opts.lod === 0) {
    // barrel with its thermal sleeve bands and the fume extractor
    const z0 = front - 0.32;
    const len = z0 - muzzleZ;
    const bands = 4;
    let z = z0;
    for (let k = 0; k < bands; k++) {
      const zEnd = z0 - len * 0.62 * ((k + 1) / bands);
      b.tubeZ(0, pivotY, zEnd + 0.04, z, 0.098, 0.105, seg, false, false);
      b.setColor(P.paintDark);
      b.tubeZ(0, pivotY, zEnd, zEnd + 0.04, 0.112, 0.112, seg, true, true);
      b.setColor(P.paint);
      z = zEnd;
    }
    const zFume = muzzleZ + len * 0.3;
    b.tubeZ(0, pivotY, zFume + 0.3, z, 0.09, 0.098, seg, false, false);
    b.tubeZ(0, pivotY, zFume - 0.3, zFume + 0.3, 0.135, 0.135, seg, true, true);
    b.tubeZ(0, pivotY, muzzleZ, zFume - 0.3, 0.08, 0.086, seg, false, false);
    b.setColor(P.bareSteel).setPart(PART.gun, tz, pivotY, pivotZ);
    b.tubeZ(0, pivotY, muzzleZ - 0.01, muzzleZ + 0.01, 0.08, 0.08, seg, true, false);
  } else {
    b.tubeZ(0, pivotY, muzzleZ, front - 0.32, 0.09, 0.11, seg, true, false);
  }
  b.setPart(PART.hull);
}

function hullIfv(b: ModelBuilder, s: VehicleShape, opts: TrackedOptions, yTop: number): void {
  const L = s.hullLength;
  const W = s.hullWidth;
  const C = s.hullClearance;
  const H = s.hullHeight;
  const tw = s.running.type === 'tracks' ? s.running.width : 0.4;
  const top = C + H;
  const wl = W / 2 - tw - 0.05;
  const yF = yTop + 0.03;
  const wT = W / 2 - 0.4;
  const section = (z: number, yb: number, yf: number, yt: number, wfS: number, wtS: number) => ({
    z,
    pts: [-wl, yb, wl, yb, wl, yf, wfS, yf, wtS, yt, -wtS, yt, -wfS, yf, -wl, yf],
  });
  const yN = C + 0.45;
  b.setPart(PART.hull).setColor(P.paint).setZone(ZONE.hull);
  b.loft([
    section(-L / 2, yN - 0.03, yN - 0.01, yN + 0.01, W / 2 - 0.15, W / 2 - 0.3),
    section(-L / 2 + 0.55, C, Math.min(yF, yN + 0.12), yN + 0.17, W / 2 - 0.03, W / 2 - 0.2),
    section(-L / 2 + 1.7, C, yF, C + H * 0.67, W / 2, wT + 0.05),
    section(-L / 2 + 2.35, C, yF, top, W / 2, wT),
    section(L / 2 - 0.15, C, yF, top, W / 2, wT),
    section(L / 2, C + 0.15, yF, top - 0.05, W / 2 - 0.02, wT - 0.02),
  ]);
  // engine (front right) and exhaust on the right side
  b.setColor(P.grille).setPart(PART.bare).setZone(ZONE.engine);
  b.box(0.75, C + H * 0.67 + 0.02, -L / 2 + 1.95, 0.8, 0.03, 0.7);
  b.setZone(ZONE.exhaust);
  b.box(W / 2 - 0.12, yF + 0.22, -L / 2 + 2.0, 0.12, 0.16, 0.45);
  b.setZone(ZONE.hull).setPart(PART.hull);
  if (opts.lod === 0) {
    // rear doors (fuel tanks inside), roof hatches, the driver's hatch, headlights
    b.setColor(P.paintDark);
    for (const x of [-0.45, 0.45]) b.box(x, (C + 0.15 + top) / 2 - 0.05, L / 2 + 0.03, 0.72, (top - C) * 0.62, 0.07);
    for (const x of [-0.42, 0.42]) for (const z of [0.9, 1.9]) b.box(x, top + 0.025, z, 0.6, 0.05, 0.75);
    b.cylinderY(-0.55, -L / 2 + 2.15, C + H * 0.67 + 0.05, C + H * 0.67 + 0.12, 0.27, b.seg(10, 6));
    b.setColor(P.lens).setPart(PART.bare);
    for (const x of [-0.75, 0.75]) b.box(x, yN + 0.35, -L / 2 + 1.1, 0.14, 0.12, 0.12);
    b.setPart(PART.hull).setColor(P.paint);
    // side skirts above the tracks
    for (const side of [-1, 1]) b.box(side * (W / 2 - 0.02), yF - 0.02, 0.1, 0.04, 0.1, L - 0.6);
  }
}

function turretIfv(b: ModelBuilder, s: VehicleShape, opts: TrackedOptions): void {
  if (!s.turret) return;
  const top = s.hullClearance + s.hullHeight;
  const tz = s.turret.offsetZ;
  const R = s.turret.radius;
  const Ht = s.turret.height;
  const front = tz - R * 0.95;
  const pivotY = top + Ht * 0.45;
  const pivotZ = front + 0.15;
  b.setPart(PART.turret, tz, pivotY, pivotZ).setColor(P.paint).setZone(ZONE.hull);
  b.dome(0, tz, top, Ht, (th) => R * (1 + 0.06 * Math.cos(th)), b.seg(14, 8), opts.lod === 0 ? 3 : 1, 1.3);
  if (opts.lod === 0) {
    // the anti-tank missile launcher on the roof and the commander's sight
    b.setColor(P.paintDark);
    b.tubeZ(0.32, top + Ht + 0.12, tz - 0.55, tz + 0.55, 0.075, 0.075, b.seg(8, 5));
    b.box(0.32, top + Ht + 0.03, tz, 0.1, 0.1, 0.4);
    b.setPart(PART.turretBare, tz, pivotY, pivotZ).setColor(P.glass);
    b.box(-0.3, top + Ht + 0.06, tz - 0.25, 0.16, 0.12, 0.2);
  }
  b.setPart(PART.gun, tz, pivotY, pivotZ).setColor(P.paint);
  const seg = b.seg(8, 5);
  const muzzleZ = front - s.gunLength;
  b.tubeZ(0, pivotY, front - 0.15, pivotZ + 0.05, 0.11, 0.13, seg);
  b.tubeZ(0, pivotY, muzzleZ + 0.25, front - 0.15, 0.045, 0.055, seg, false, false);
  b.setColor(P.bareSteel);
  b.tubeZ(0, pivotY, muzzleZ, muzzleZ + 0.25, 0.06, 0.06, seg);
  // coaxial machine gun
  if (opts.lod === 0) b.tubeZ(0.16, pivotY + 0.02, front - 0.5, front - 0.1, 0.02, 0.02, 4);
  b.setPart(PART.hull);
}

/** Simple far model: hull, two track boxes, turret and gun (no wheels). */
function farTracks(b: ModelBuilder, s: VehicleShape): number {
  const W = s.hullWidth;
  const L = s.hullLength;
  const tw = s.running.type === 'tracks' ? s.running.width : 0.4;
  const C = s.hullClearance;
  const yTop = Math.min(0.42, Math.max(0.28, C * 0.8)) * 2 + 0.2;
  b.setPart(PART.bare).setColor(P.trackSteel).setZone(ZONE.running);
  for (const side of [-1, 1]) b.box(side * (W / 2 - tw / 2 - 0.02), yTop / 2, 0, tw, yTop, L - 0.3);
  return yTop;
}

export function buildTracked(s: VehicleShape, opts: TrackedOptions, detail: number): ModelBuilder {
  const b = new ModelBuilder(opts.lod === 0 ? detail : 0.4);
  let yTop: number;
  if (opts.lod === 0) {
    const l = runningGear(b, s, 1, opts.style);
    runningGear(b, s, -1, opts.style);
    yTop = l.yTop;
  } else {
    yTop = farTracks(b, s);
  }
  if (opts.style === 'mbt') {
    hullMbt(b, s, opts, yTop);
    turretMbt(b, s, opts);
  } else {
    hullIfv(b, s, opts, yTop);
    turretIfv(b, s, opts);
  }
  return b;
}
