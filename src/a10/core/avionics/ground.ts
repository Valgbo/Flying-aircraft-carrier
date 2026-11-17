/**
 * The ground as the fire-control computer knows it (PLAN_A10.md §7, "Fire-control inputs"),
 * chosen with the altitude-source switch:
 *
 *   DELTA  the terrain database: the real terrain (Terrain.segmentHit), right over hills;
 *   RADAR  a flat plane at the ground height straight below the aircraft (altitude − radar
 *          altitude), only while the radar altimeter is in range;
 *   BARO   a flat plane at the elevation of the active steerpoint (the target elevation).
 *
 * Over sloping ground RADAR and BARO are wrong, as they are in the aircraft: with ground rising
 * toward the target both assume it too low, so the computed impact is too far and the pipper too
 * low (the rounds land long), and the other way round over falling ground.
 */
import { Vector3 } from 'three';
import type { Sim } from '../types';
import type { Terrain, TerrainHit } from '../world/types';
import { FIRE_CONTROL } from '../../data/avionics';
import type { AltSource } from './types';

export interface FireControlGround {
  source: AltSource;
  /** The source has data now (radar altimeter in range; a steerpoint for BARO). */
  valid: boolean;
  /** The terrain database (DELTA), or null. */
  terrain: Terrain | null;
  /** Height of the RADAR / BARO plane, m; NaN for DELTA. */
  plane: number;
  /** No ground above this height anywhere, m: a chord wholly above it needs no test. */
  ceiling: number;
}

export function createFireControlGround(): FireControlGround {
  return { source: 'DELTA', valid: false, terrain: null, plane: NaN, ceiling: Infinity };
}

/** The ground model for an altitude source, from the aircraft's present state. */
export function updateFireControlGround(
  sim: Sim,
  source: AltSource,
  out: FireControlGround,
): FireControlGround {
  const ac = sim.aircraft;
  out.source = source;
  out.terrain = null;
  out.plane = NaN;
  if (source === 'DELTA') {
    const terrain = sim.world.terrain;
    out.terrain = terrain;
    out.valid = true;
    out.ceiling = terrain.maxHeight;
  } else if (source === 'RADAR') {
    // The radar altimeter measures the height above the ground straight below.
    const agl = ac.agl;
    out.valid = Number.isFinite(agl) && agl >= 0 && agl <= FIRE_CONTROL.radarAltimeterMax;
    out.plane = ac.position.y - agl;
    out.ceiling = out.plane;
  } else {
    const av = sim.avionics;
    const sp = av.steerpoints[av.activeSteerpoint];
    out.valid = sp !== undefined;
    out.plane = sp ? sp.position.y : NaN;
    out.ceiling = out.plane;
  }
  if (!out.valid) out.ceiling = Infinity;
  return out;
}

/**
 * First intersection of the segment p0→p1 with the computer's ground. Planes: exact; DELTA: the
 * terrain's own segment query. A segment that starts below the ground hits at p0.
 */
export function groundSegmentHit(
  g: FireControlGround,
  p0: Vector3,
  p1: Vector3,
  out: TerrainHit,
): boolean {
  if (g.terrain) return g.terrain.segmentHit(p0, p1, out);
  const h = g.plane;
  const a = p0.y - h;
  const b = p1.y - h;
  if (a > 0 && b > 0) return false;
  const t = a <= 0 ? 0 : a / (a - b);
  out.point.set(p0.x + (p1.x - p0.x) * t, h, p0.z + (p1.z - p0.z) * t);
  out.normal.set(0, 1, 0);
  const len = p0.distanceTo(p1);
  out.distance = t * len;
  out.t = t;
  out.surface = 'grass';
  return true;
}

/** Scratch hit records for callers (no allocation per step). */
export function createTerrainHit(): TerrainHit {
  return { point: new Vector3(), normal: new Vector3(), distance: 0, t: 0, surface: 'grass' };
}
