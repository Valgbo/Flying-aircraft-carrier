/**
 * The armour model matches the drawn vehicle (review TE-6; data/vehicles.ts: "a round that hits the
 * drawn vehicle hits the armour model"). A ray grid perpendicular to the line of fire compares
 * the 3D model as the vehicle shader shows an intact vehicle (view/vehicles/models, turret ahead,
 * the thrown-track part hidden) with segmentHitVehicle; the flat ground stops both. For every
 * class, both levels of detail and 15 aspects (dives of 10°, 30° and 60°, from the bow round to
 * the stern), the share of the drawn silhouette that no armour stops ("drawn but missed") and of
 * the armour that nothing drawn covers ("hit but not drawn") stay small.
 *
 * The drawn side is rasterised into a depth grid (exact, triangle by triangle); the armour side
 * is one segmentHitVehicle per cell.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createSim } from '../../../src/a10/core/sim';
import {
  createVehicle,
  segmentHitVehicle,
  VEHICLE_MODELS,
  type VehicleHit,
  type VehicleKind,
} from '../../../src/a10/core/targets';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { buildVehicleGeometry } from '../../../src/a10/view/vehicles/models';
import { PART } from '../../../src/a10/view/vehicles/models/builder';

const DEG = Math.PI / 180;
const CELL = 0.05;
const LONG = 120_000;
const DIVES = [10, 30, 60];
const BEARINGS = [0, 45, 90, 135, 180];

/** Triangles of the drawn model of an intact vehicle (x, y, z per vertex). */
function drawnTriangles(kind: VehicleKind, lod: 0 | 1): Float32Array {
  const g = buildVehicleGeometry(kind, lod, 1);
  const p = g.getAttribute('position');
  const aux = g.getAttribute('aAux');
  const out: number[] = [];
  for (let t = 0; t < p.count / 3; t++) {
    // the thrown track is shown only once a track has been thrown
    if (Math.round(aux.getW(t * 3)) === PART.thrownTrack) continue;
    for (let k = 0; k < 3; k++) out.push(p.getX(t * 3 + k), p.getY(t * 3 + k), p.getZ(t * 3 + k));
  }
  g.dispose();
  return new Float32Array(out);
}

interface Agreement {
  /** Share of the drawn silhouette with no armour behind it, %. */
  missed: number;
  /** Share of the armour silhouette with nothing drawn there, %. */
  extra: number;
}

const _hit: VehicleHit = {
  vehicleId: 0,
  t: 0,
  point: new Vector3(),
  normal: new Vector3(),
  thicknessMm: 0,
  part: 'hull',
  face: 'front',
  plate: 0,
};

/** Compare both levels of detail with the armour, seen from `bearing` (0 = the bow) in a `dive`. */
function compare(
  kind: VehicleKind,
  lods: Float32Array[],
  dive: number,
  bearing: number,
): Agreement[] {
  const sim = createSim({ seed: 1, terrain: createFlatTerrain(0), scenario: 'empty' });
  createVehicle(sim, kind, 0, 0, 0, 1);
  const b = bearing * DEG;
  const d = new Vector3(
    -Math.sin(b) * Math.cos(dive * DEG),
    -Math.sin(dive * DEG),
    Math.cos(b) * Math.cos(dive * DEG),
  );
  const u = new Vector3().crossVectors(d, new Vector3(0, 1, 0)).normalize();
  const w = new Vector3().crossVectors(u, d).normalize();
  const m = VEHICLE_MODELS[kind];
  const c = new Vector3(0, (m.min[1] + m.max[1]) / 2, (m.min[2] + m.max[2]) / 2);
  // the grid covers the armour and both drawn models
  let a0 = Infinity;
  let a1 = -Infinity;
  let b0 = Infinity;
  let b1 = -Infinity;
  const extend = (x: number, y: number, z: number) => {
    const px = x - c.x;
    const py = y - c.y;
    const pz = z - c.z;
    const a = px * u.x + py * u.y + pz * u.z;
    const bb = px * w.x + py * w.y + pz * w.z;
    a0 = Math.min(a0, a);
    a1 = Math.max(a1, a);
    b0 = Math.min(b0, bb);
    b1 = Math.max(b1, bb);
  };
  for (const x of [m.min[0], m.max[0]])
    for (const y of [m.min[1], m.max[1]]) for (const z of [m.min[2], m.max[2]]) extend(x, y, z);
  for (const T of lods) for (let i = 0; i < T.length; i += 3) extend(T[i], T[i + 1], T[i + 2]);
  a0 -= 2 * CELL;
  b0 -= 2 * CELL;
  const nu = Math.ceil((a1 + 2 * CELL - a0) / CELL);
  const nw = Math.ceil((b1 + 2 * CELL - b0) / CELL);
  const half = 20;
  // the armour (and where each ray meets the ground: depth along d from the grid plane)
  const armour = new Uint8Array(nu * nw);
  const ground = new Float32Array(nu * nw);
  const o = new Vector3();
  const p1 = new Vector3();
  for (let j = 0; j < nw; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i;
      o.copy(c)
        .addScaledVector(u, a0 + (i + 0.5) * CELL)
        .addScaledVector(w, b0 + (j + 0.5) * CELL);
      const s = d.y < -1e-9 ? -o.y / d.y : Infinity;
      ground[k] = s;
      const tMax = Math.min(half, s);
      if (tMax <= -half) continue;
      p1.copy(o).addScaledVector(d, tMax);
      o.addScaledVector(d, -half);
      if (segmentHitVehicle(sim, o, p1, _hit)) armour[k] = 1;
    }
  }
  // each level of detail: the nearest drawn surface per cell
  const depth = new Float32Array(nu * nw);
  const A = [0, 0, 0];
  const B = [0, 0, 0];
  const S = [0, 0, 0];
  return lods.map((T) => {
    depth.fill(Infinity);
    for (let t = 0; t < T.length; t += 9) {
      for (let v = 0; v < 3; v++) {
        const px = T[t + 3 * v] - c.x;
        const py = T[t + 3 * v + 1] - c.y;
        const pz = T[t + 3 * v + 2] - c.z;
        A[v] = (px * u.x + py * u.y + pz * u.z - a0) / CELL - 0.5;
        B[v] = (px * w.x + py * w.y + pz * w.z - b0) / CELL - 0.5;
        S[v] = px * d.x + py * d.y + pz * d.z;
      }
      const det = (A[1] - A[0]) * (B[2] - B[0]) - (A[2] - A[0]) * (B[1] - B[0]);
      if (Math.abs(det) < 1e-12) continue;
      const iMin = Math.max(0, Math.ceil(Math.min(A[0], A[1], A[2])));
      const iMax = Math.min(nu - 1, Math.floor(Math.max(A[0], A[1], A[2])));
      const jMin = Math.max(0, Math.ceil(Math.min(B[0], B[1], B[2])));
      const jMax = Math.min(nw - 1, Math.floor(Math.max(B[0], B[1], B[2])));
      for (let j = jMin; j <= jMax; j++) {
        for (let i = iMin; i <= iMax; i++) {
          const l1 = ((i - A[0]) * (B[2] - B[0]) - (A[2] - A[0]) * (j - B[0])) / det;
          const l2 = ((A[1] - A[0]) * (j - B[0]) - (i - A[0]) * (B[1] - B[0])) / det;
          if (l1 < -1e-9 || l2 < -1e-9 || l1 + l2 > 1 + 1e-9) continue;
          const s = (1 - l1 - l2) * S[0] + l1 * S[1] + l2 * S[2];
          const k = j * nu + i;
          if (s < depth[k]) depth[k] = s;
        }
      }
    }
    let drawn = 0;
    let hit = 0;
    let missed = 0;
    let extra = 0;
    for (let k = 0; k < nu * nw; k++) {
      const isDrawn = depth[k] < ground[k] && depth[k] < half;
      const isArmour = armour[k] === 1;
      if (isDrawn) drawn++;
      if (isArmour) hit++;
      if (isDrawn && !isArmour) missed++;
      if (isArmour && !isDrawn) extra++;
    }
    return { missed: (100 * missed) / drawn, extra: (100 * extra) / hit };
  });
}

/** Worst agreement of a class over all aspects, per level of detail. */
function worst(kind: VehicleKind, skip: (bearing: number) => boolean = () => false) {
  const lods = [drawnTriangles(kind, 0), drawnTriangles(kind, 1)];
  const out = [
    { missed: 0, extra: 0, where: ['', ''] },
    { missed: 0, extra: 0, where: ['', ''] },
  ];
  for (const dive of DIVES)
    for (const bearing of BEARINGS) {
      if (skip(bearing)) continue;
      compare(kind, lods, dive, bearing).forEach((r, lod) => {
        const o = out[lod];
        if (r.missed > o.missed) {
          o.missed = r.missed;
          o.where[0] = `dive ${dive}° from ${bearing}°`;
        }
        if (r.extra > o.extra) {
          o.extra = r.extra;
          o.where[1] = `dive ${dive}° from ${bearing}°`;
        }
      });
    }
  out.forEach((o, lod) =>
    console.log(
      `[targets] ${kind} lod${lod}: drawn but missed ≤ ${o.missed.toFixed(1)} % (${o.where[0]}), ` +
        `hit but not drawn ≤ ${o.extra.toFixed(1)} % (${o.where[1]})`,
    ),
  );
  return out;
}

describe('the armour matches the drawn vehicles (review TE-6)', () => {
  it(
    'trucks: the bed platform, saddles, hose cabinet, bumper, rails and crate stack are armour',
    { timeout: LONG },
    () => {
      for (const kind of ['truckCargo', 'truckFuel', 'truckAmmo'] as VehicleKind[]) {
        const [near, far] = worst(kind);
        expect(near.missed, `${kind} near`).toBeLessThanOrEqual(5);
        expect(near.extra, `${kind} near`).toBeLessThanOrEqual(5);
        // the far model (beyond ≈800 m) simplifies the tilt roof and the crate stack
        expect(far.missed, `${kind} far`).toBeLessThanOrEqual(5);
        expect(far.extra, `${kind} far`).toBeLessThanOrEqual(10);
      }
    },
  );

  it('armoured vehicles stay within a few per cent from every aspect', { timeout: LONG }, () => {
    for (const kind of ['mbt', 'hulk', 'ifv', 'apc'] as VehicleKind[]) {
      for (const [lod, r] of worst(kind).entries()) {
        expect(r.missed, `${kind} lod${lod}`).toBeLessThanOrEqual(7.5);
        expect(r.extra, `${kind} lod${lod}`).toBeLessThanOrEqual(7.5);
      }
    }
  });

  it('the strafe panel: the board is what is drawn (posts and braces are not scored)', () => {
    // edge-on, only the posts and braces behind the board show
    for (const r of worst('panel', (bearing) => bearing === 90)) {
      expect(r.missed).toBeLessThanOrEqual(5);
      expect(r.extra).toBeLessThanOrEqual(5);
    }
  });
});
