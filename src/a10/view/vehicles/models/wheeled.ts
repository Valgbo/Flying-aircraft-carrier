/**
 * Wheeled vehicles built from their VehicleShape: the BTR-class 8-wheeled personnel carrier
 * (boat-shaped hull, small turret at the front) and three 6-wheeled trucks with a bonneted cab
 * (cargo under a canvas tilt, fuel in a tank body, ammunition in stacked crates).
 */
import { Matrix4 } from 'three';
import type { VehicleShape } from '../../../core/targets/types';
import { VEHICLE_PALETTE as P } from '../palette';
import { ModelBuilder, PART, ZONE } from './builder';

export type TruckBody = 'cargo' | 'fuel' | 'ammo';

function axleZs(n: number, front: number, rear: number): number[] {
  if (n <= 1) return [(front + rear) / 2];
  // a wider gap in the middle of an even number of axles (BTR-style)
  const gaps: number[] = [];
  for (let i = 0; i < n - 1; i++) gaps.push(n >= 4 && i === n / 2 - 1 ? 1.2 : 1);
  const total = gaps.reduce((a, g) => a + g, 0);
  const out = [front];
  let z = front;
  for (const g of gaps) {
    z += ((rear - front) * g) / total;
    out.push(z);
  }
  return out;
}

/** A tyre with its hub (rotates about its axle). */
function tyre(b: ModelBuilder, xc: number, y: number, z: number, r: number, width: number, side: 1 | -1, lod: 0 | 1): void {
  const aux = [y, z, r, PART.wheel];
  b.setPart(PART.wheel, y, z, r).setZone(ZONE.running);
  const seg = lod === 0 ? b.seg(16, 8) : 6;
  b.setColor(P.rubber);
  b.cylinderX(xc - width / 2, xc + width / 2, y, z, r, seg, true, aux);
  if (lod === 1) return;
  const xo = xc + (side * width) / 2;
  b.setColor(P.paint);
  b.discX(xo + side * 0.004, y, z, r * 0.58, seg, side, aux);
  b.setColor(P.paintDark);
  b.cylinderX(Math.min(xo, xo + side * 0.06), Math.max(xo, xo + side * 0.06), y, z, r * 0.2, b.seg(8, 6), true, aux);
  b.setColor(P.bareSteel);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    b.discX(xo + side * 0.008, y + Math.cos(a) * r * 0.38, z + Math.sin(a) * r * 0.38, r * 0.05, 5, side, aux);
  }
  // tread blocks so the tyre is seen to roll
  if (b.detail > 0.6) {
    b.setColor('#141413');
    const blocks = 14;
    for (let k = 0; k < blocks; k++) {
      const a = (k / blocks) * Math.PI * 2;
      b.push(new Matrix4().makeTranslation(xc, y + Math.cos(a) * r, z + Math.sin(a) * r).multiply(new Matrix4().makeRotationX(a)));
      b.box(0, 0.005, 0, width * 0.92, 0.03, 0.07);
      b.pop();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// BTR-class personnel carrier
// ---------------------------------------------------------------------------------------------

export function buildApc(s: VehicleShape, lod: 0 | 1, detail: number): ModelBuilder {
  const b = new ModelBuilder(lod === 0 ? detail : 0.4);
  const L = s.hullLength;
  const W = s.hullWidth;
  const C = s.hullClearance;
  const H = s.hullHeight;
  const top = C + H;
  const r = s.running.type === 'wheels' ? s.running.radius : 0.6;
  const n = s.running.type === 'wheels' ? s.running.axles : 4;
  const ww = Math.min(0.42, r * 0.65);
  const xw = W / 2 - ww / 2 - 0.02;
  const yWaist = Math.max(C + 0.5, 2 * r + 0.05);
  const hex = (z: number, wb: number, yb: number, ww2: number, yw: number, wt: number, yt: number) => ({
    z,
    pts: [-wb, yb, wb, yb, ww2, yw, wt, yt, -wt, yt, -ww2, yw],
  });
  b.setPart(PART.hull).setColor(P.paint).setZone(ZONE.hull);
  b.loft([
    hex(-L / 2, 0.3, C + 0.5, 0.45, C + 0.56, 0.4, C + 0.62),
    hex(-L / 2 + 0.7, 0.55, C + 0.08, W / 2 - 0.3, yWaist - 0.05, 0.85, top - 0.55),
    hex(-L / 2 + 1.6, 0.65, C, W / 2 - 0.05, yWaist, W / 2 - 0.42, top),
    hex(L / 2 - 1.7, 0.65, C, W / 2 - 0.05, yWaist, W / 2 - 0.42, top),
    hex(L / 2 - 0.35, 0.65, C + 0.05, W / 2 - 0.06, yWaist, W / 2 - 0.45, top - 0.22),
    hex(L / 2, 0.6, C + 0.25, W / 2 - 0.12, yWaist - 0.05, W / 2 - 0.5, top - 0.32),
  ]);
  // engine deck and exhaust at the rear
  b.setColor(P.grille).setPart(PART.bare).setZone(ZONE.engine);
  b.box(0, top - 0.06, L / 2 - 1.05, 1.3, 0.05, 1.1);
  b.setZone(ZONE.exhaust);
  for (const side of [-1, 1]) b.box(side * (W / 2 - 0.35), top - 0.32, L / 2 - 0.12, 0.35, 0.16, 0.2);
  b.setZone(ZONE.hull).setPart(PART.hull).setColor(P.paint);
  if (lod === 0) {
    // trim vane folded on the nose, roof hatches, side doors, headlights
    b.setColor(P.paintDark);
    b.push(new Matrix4().makeTranslation(0, top - 0.42, -L / 2 + 1.05).multiply(new Matrix4().makeRotationX(-0.95)));
    b.box(0, 0, 0, 1.5, 0.05, 0.62);
    b.pop();
    for (const x of [-0.45, 0.45]) b.box(x, top + 0.025, -0.2, 0.55, 0.05, 0.6);
    for (const side of [-1, 1]) {
      b.push(new Matrix4().makeTranslation(side * (W / 2 - 0.22), (yWaist + top) / 2 + 0.05, 0.15).multiply(new Matrix4().makeRotationZ(side * 0.42)));
      b.box(0, 0, 0, 0.05, 0.55, 0.7);
      b.pop();
    }
    b.setColor(P.lens).setPart(PART.bare);
    for (const x of [-0.5, 0.5]) b.box(x, top - 0.47, -L / 2 + 0.85, 0.14, 0.12, 0.1);
    b.setPart(PART.hull).setColor(P.paint);
  }
  // wheels
  const zs = axleZs(n, -L / 2 + 1.55, L / 2 - 1.4);
  for (const z of zs) for (const side of [-1, 1] as const) tyre(b, side * xw, r, z, r, ww, side, lod);
  // the small turret at the front with its heavy machine gun
  if (s.turret) {
    const tz = s.turret.offsetZ;
    const R = s.turret.radius;
    const Ht = s.turret.height;
    const front = tz - R;
    const pivotY = top + Ht * 0.4;
    const pivotZ = front + 0.12;
    b.setPart(PART.turret, tz, pivotY, pivotZ).setColor(P.paint).setZone(ZONE.hull);
    b.dome(0, tz, top - 0.02, Ht + 0.02, () => R, b.seg(12, 7), lod === 0 ? 3 : 1, 1.5);
    b.setPart(PART.gun, tz, pivotY, pivotZ);
    const seg = b.seg(8, 5);
    b.tubeZ(0, pivotY, front - 0.35, pivotZ + 0.05, 0.075, 0.09, seg);
    b.tubeZ(0, pivotY, front - s.gunLength, front - 0.35, 0.04, 0.045, seg, true, false);
    if (lod === 0) b.tubeZ(0.14, pivotY - 0.02, front - 0.55, front - 0.1, 0.02, 0.02, 4);
    b.setPart(PART.hull);
  }
  return b;
}

// ---------------------------------------------------------------------------------------------
// Trucks
// ---------------------------------------------------------------------------------------------

export function buildTruck(s: VehicleShape, body: TruckBody, lod: 0 | 1, detail: number): ModelBuilder {
  const b = new ModelBuilder(lod === 0 ? detail : 0.4);
  const L = s.hullLength;
  const W = s.hullWidth;
  const C = s.hullClearance;
  const H = s.hullHeight;
  const top = C + H;
  const cab = s.cabLength ?? 2.2;
  const r = s.running.type === 'wheels' ? s.running.radius : 0.55;
  const n = s.running.type === 'wheels' ? s.running.axles : 3;
  const ww = Math.min(0.42, r * 0.72);
  const xw = W / 2 - ww / 2 - 0.02;
  const zFront = -L / 2;
  const zBonnet = zFront + cab * 0.47;
  const zCabRear = zFront + cab;
  const zBed = zCabRear + 0.12;
  const yFrame = C - 0.05;
  const yBed = C + 0.32;
  const cabTop = Math.min(top - 0.25, C + 1.75);

  // chassis rails and bumper
  b.setPart(PART.bare).setColor(P.paintDark).setZone(ZONE.hull);
  for (const x of [-0.45, 0.45]) b.box(x, yFrame, 0.05, 0.12, 0.24, L - 0.35);
  b.setPart(PART.hull).setColor(P.paintDark);
  b.box(0, C - 0.12, zFront + 0.08, W - 0.3, 0.18, 0.14);

  // bonnet over the engine (hot)
  b.setColor(P.paint).setZone(ZONE.engineHull);
  b.loft([
    { z: zFront + 0.15, pts: [-0.62, C, 0.62, C, 0.6, C + 0.82, -0.6, C + 0.82] },
    { z: zBonnet, pts: [-0.72, C, 0.72, C, 0.7, C + 0.95, -0.7, C + 0.95] },
  ]);
  b.setColor(P.grille).setPart(PART.bare).setZone(ZONE.engine);
  b.box(0, C + 0.42, zFront + 0.13, 1.0, 0.7, 0.04);
  b.setZone(ZONE.hull).setPart(PART.hull).setColor(P.paint);
  // front mudguards over the front wheels
  const zs = axleZs(n, zFront + 0.85, L / 2 - 0.9);
  if (n >= 3) {
    // tandem rear axles sit close together
    zs[zs.length - 2] = zs[zs.length - 1] - 1.38;
  }
  for (const side of [-1, 1]) {
    b.box(side * xw, 2 * r + 0.1, zs[0], ww + 0.12, 0.05, 1.15);
    b.push(new Matrix4().makeTranslation(side * xw, 2 * r - 0.08, zs[0] - 0.62).multiply(new Matrix4().makeRotationX(0.75)));
    b.box(0, 0, 0, ww + 0.12, 0.04, 0.45);
    b.pop();
  }
  // the cab with a sloped windscreen
  const cw = W / 2 - 0.1;
  b.loft([
    { z: zBonnet, pts: [-cw, C, cw, C, cw, C + 0.95, -cw, C + 0.95] },
    { z: zBonnet + 0.3, pts: [-cw, C, cw, C, cw, cabTop, -cw, cabTop] },
    { z: zCabRear, pts: [-cw, C, cw, C, cw, cabTop, -cw, cabTop] },
  ]);
  b.setColor(P.glass).setPart(PART.glass);
  {
    const ang = Math.atan2(0.3, cabTop - C - 0.95);
    const yMid = (C + 0.95 + cabTop) / 2 + 0.05;
    b.push(new Matrix4().makeTranslation(0, yMid, zBonnet + 0.16).multiply(new Matrix4().makeRotationX(-ang)));
    b.box(-cw / 2 - 0.02, 0, -0.012, cw - 0.2, (cabTop - C - 0.95) * 0.8, 0.02);
    b.box(cw / 2 + 0.02, 0, -0.012, cw - 0.2, (cabTop - C - 0.95) * 0.8, 0.02);
    b.pop();
    for (const side of [-1, 1]) b.box(side * (cw + 0.008), cabTop - 0.33, zBonnet + 0.65, 0.02, 0.42, 0.55);
  }
  b.setPart(PART.hull).setColor(P.paint);
  if (lod === 0) {
    // headlights, mirrors, a step, the side fuel tank, the exhaust stack behind the cab
    b.setColor(P.lens).setPart(PART.bare);
    for (const x of [-0.82, 0.82]) b.box(x, 2 * r + 0.2, zs[0] - 0.55, 0.16, 0.14, 0.1);
    b.setColor(P.bareSteel);
    for (const side of [-1, 1]) b.box(side * (cw + 0.2), cabTop - 0.35, zBonnet + 0.2, 0.04, 0.25, 0.14);
    b.setColor(P.paintDark).setPart(PART.hull);
    b.tubeZ(-0.95, C - 0.15, zCabRear - 0.1, zCabRear + 0.9, 0.24, 0.24, b.seg(10, 6));
    b.setColor(P.bareSteel).setPart(PART.bare).setZone(ZONE.exhaust);
    b.cylinderY(0.95, zCabRear + 0.04, C, cabTop + 0.15, 0.06, b.seg(6, 5));
    b.setZone(ZONE.hull).setPart(PART.hull).setColor(P.paint);
  }

  // the body behind the cab
  const bedLen = L / 2 - zBed;
  const zMid = zBed + bedLen / 2;
  b.setColor(P.paintDark);
  b.box(0, yBed, zMid, W, 0.12, bedLen);
  if (body === 'cargo') {
    b.setColor(P.paint);
    for (const side of [-1, 1]) b.box(side * (W / 2 - 0.03), yBed + 0.33, zMid, 0.06, 0.55, bedLen);
    b.box(0, yBed + 0.33, L / 2 - 0.03, W, 0.55, 0.06);
    b.box(0, yBed + 0.33, zBed + 0.03, W, 0.55, 0.06);
    // the tilt frame (stays when the canvas burns) and the canvas over it
    const yTilt = yBed + 0.6;
    b.setColor(P.bareSteel).setPart(PART.bare);
    const bows = 4;
    for (let k = 0; k < bows; k++) {
      const z = zBed + 0.15 + ((bedLen - 0.3) * k) / (bows - 1);
      for (const side of [-1, 1]) b.box(side * (W / 2 - 0.06), (yTilt + top) / 2 - 0.1, z, 0.05, top - yTilt - 0.2, 0.05);
      b.box(0, top - 0.12, z, W - 0.12, 0.05, 0.05);
    }
    b.setPart(PART.tarp).setColor(P.canvas);
    const tw = W / 2 - 0.02;
    const shoulder = top - 0.32;
    const arc: number[] = [-tw, yTilt, tw, yTilt, tw, shoulder];
    const steps = lod === 0 ? 6 : 2;
    for (let k = 1; k < steps; k++) {
      const a = (k / steps) * Math.PI;
      arc.push(Math.cos(a) * tw, shoulder + Math.sin(a) * (top - shoulder));
    }
    arc.push(-tw, shoulder);
    b.loft([
      { z: zBed + 0.02, pts: arc },
      { z: L / 2 - 0.02, pts: arc },
    ]);
    b.setPart(PART.hull);
  } else if (body === 'fuel') {
    const yb = yBed + 0.08;
    const rv = (top - yb) / 2;
    const rh = W / 2 - 0.1;
    const zt0 = zBed + 0.05;
    const zt1 = L / 2 - 0.35;
    b.setColor(P.fuelTank);
    b.tubeZ(0, yb + rv, zt0, zt1, rh, rh, b.seg(18, 8), true, true, rv / rh);
    // saddles, a walkway and the filler hatches on top, the hose cabinet at the rear
    b.setColor(P.paintDark);
    b.box(0, yb + 0.12, zt0 + 0.5, W - 0.25, 0.22, 0.2);
    b.box(0, yb + 0.12, zt1 - 0.5, W - 0.25, 0.22, 0.2);
    if (lod === 0) {
      b.box(0, top + 0.02, (zt0 + zt1) / 2, 0.5, 0.04, zt1 - zt0 - 0.6);
      for (const z of [zt0 + 1.1, zt1 - 1.1]) b.cylinderY(0, z, top - 0.05, top + 0.1, 0.22, b.seg(10, 6));
    }
    b.setColor(P.paint);
    b.box(0, (yBed + top) / 2 - 0.25, L / 2 - 0.17, W - 0.2, top - yBed - 0.6, 0.32);
  } else {
    b.setColor(P.paint);
    for (const side of [-1, 1]) b.box(side * (W / 2 - 0.03), yBed + 0.25, zMid, 0.06, 0.4, bedLen);
    b.box(0, yBed + 0.25, L / 2 - 0.03, W, 0.4, 0.06);
    // stacked ammunition crates
    const rows = 2;
    const cols = Math.max(2, Math.floor((bedLen - 0.2) / 1.0));
    const layers = lod === 0 ? 3 : 1;
    const cw2 = (W - 0.25) / rows;
    const cl = (bedLen - 0.25) / cols;
    const chh = Math.min(0.5, (top - yBed - 0.3) / 3);
    for (let ly = 0; ly < layers; ly++) {
      for (let rI = 0; rI < rows; rI++) {
        for (let c = 0; c < cols; c++) {
          if (ly === 2 && (c + rI) % 3 === 0) continue;
          const shade = 0.9 + 0.2 * (((c * 7 + rI * 3 + ly * 5) % 5) / 4);
          b.setColor(P.crate);
          b.color.multiplyScalar(lod === 0 ? shade : 1);
          const h = lod === 0 ? chh : chh * 2.5;
          b.box(-W / 2 + 0.125 + cw2 * (rI + 0.5), yBed + 0.06 + h * (ly + 0.5), zBed + 0.125 + cl * (c + 0.5), cw2 - 0.06, h - 0.04, cl - 0.06);
        }
      }
    }
  }
  b.setPart(PART.hull).setColor(P.paint);

  // wheels
  for (const z of zs) for (const side of [-1, 1] as const) tyre(b, side * xw, r, z, r, ww, side, lod);
  return b;
}
