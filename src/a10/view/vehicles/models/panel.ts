/**
 * The strafe scoring panel: a white 20 × 20 ft board (size from its VehicleShape) with a black
 * bullseye on both faces (drawn by the material from per-vertex panel coordinates), held up by
 * wooden posts and braces behind it.
 */
import { Matrix4 } from 'three';
import type { VehicleShape } from '../../../core/targets/types';
import { VEHICLE_PALETTE as P } from '../palette';
import { ModelBuilder, PART, ZONE } from './builder';

export function buildPanel(s: VehicleShape, lod: 0 | 1, detail: number): ModelBuilder {
  const b = new ModelBuilder(lod === 0 ? detail : 0.4);
  const w = s.hullWidth / 2;
  const y0 = s.hullClearance;
  const y1 = s.hullClearance + s.hullHeight;
  const t = Math.min(0.12, s.hullLength * 0.4);
  const zf = -t / 2;
  const zb = t / 2;
  b.setColor(P.panelWhite).setZone(ZONE.hull);
  // the faces carry (u, v) in -1..1 for the bullseye
  const face = (z: number, nz: number) => {
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const order = nz < 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (const k of order) {
      const [u, v] = corners[k];
      b.vertex(u * w, y0 + ((v + 1) / 2) * (y1 - y0), z, 0, 0, nz, [
        nz < 0 ? -u : u,
        v,
        0,
        PART.panel,
      ]);
    }
  };
  face(zf, -1);
  face(zb, 1);
  // edges of the board
  b.setPart(PART.panel, 3, 3, 0);
  b.box(-w, (y0 + y1) / 2, 0, 0.02, y1 - y0, t);
  b.box(w, (y0 + y1) / 2, 0, 0.02, y1 - y0, t);
  b.box(0, y1, 0, 2 * w, 0.02, t);
  // posts and braces behind it
  b.setPart(PART.bare).setColor(P.wood);
  const posts = lod === 0 ? [-0.8, 0, 0.8] : [-0.8, 0.8];
  for (const f of posts) {
    const x = f * w;
    b.box(x, (y1 * 0.92) / 2, zb + 0.08, 0.14, y1 * 0.92, 0.14);
    if (lod === 0) {
      const len = Math.hypot(y1 * 0.6, 1.8);
      const ang = Math.atan2(1.8, y1 * 0.6);
      b.setColor(P.woodDark);
      b.push(
        new Matrix4()
          .makeTranslation(x, y1 * 0.3, zb + 0.08 + 0.9)
          .multiply(new Matrix4().makeRotationX(ang)),
      );
      b.box(0, 0, 0, 0.1, len, 0.1);
      b.pop();
      b.setColor(P.wood);
    }
  }
  if (lod === 0) b.box(0, y1 * 0.15, zb + 0.08, 2 * w * 0.85, 0.12, 0.08);
  return b;
}
