/**
 * What a contrast tracker (the pod's point tracker, a Maverick seeker) can acquire and hold, from
 * geometry rather than image processing (PLAN §2): a vehicle inside the tracking gate around the
 * line of sight, large enough in the picture (√(projected area) / range against the resolution
 * cell of the current field of view), with contrast in the sensor's band above the threshold
 * (`contrast.ts`), and in plain view: terrain and trees (`Terrain.lineOfSight`) and, for a TV
 * sensor, no smoke across the path. Allocation-free.
 */
import { Vector3 } from 'three';
import type { Vehicle } from '../targets/types';
import type { Sim } from '../types';
import { createContrastDetail, vehicleContrast, type ContrastDetail } from './contrast';
import { angularSize, vehicleCentre } from './geometry';
import type { LockFailure, SensorBand } from './types';

/** What a tracker needs of a candidate. */
export interface TrackRules {
  band: SensorBand;
  /** Smallest angular size, rad. */
  minSize: number;
  /** Smallest contrast, 0..1. */
  minContrast: number;
}

/** Result of a check or a search. */
export interface TrackCheck {
  ok: boolean;
  failure: LockFailure;
  vehicleId: number;
  /** Contrast of the (best) candidate, 0..1, and its detail. */
  contrast: number;
  detail: ContrastDetail;
  /** Angular size of the candidate, rad, and its range, m. */
  size: number;
  range: number;
  /** Angle between the line of sight and the candidate, rad. */
  offset: number;
}

export function createTrackCheck(): TrackCheck {
  return {
    ok: false,
    failure: '',
    vehicleId: -1,
    contrast: 0,
    detail: createContrastDetail(),
    size: 0,
    range: 0,
    offset: 0,
  };
}

const _c = new Vector3();
const _u = new Vector3();

/**
 * Check one vehicle against the rules from the sensor head `head`: size, contrast, line of sight
 * (terrain and trees). Fills `out` (failure = the first rule that fails). `skipSight` leaves the
 * line-of-sight test out (a caller that ran it recently).
 */
export function checkVehicle(
  sim: Sim,
  v: Vehicle,
  head: Vector3,
  rules: TrackRules,
  out: TrackCheck,
  skipSight = false,
): boolean {
  vehicleCentre(v, _c);
  _u.subVectors(_c, head);
  const range = _u.length();
  _u.multiplyScalar(1 / Math.max(1e-9, range));
  out.vehicleId = v.id;
  out.range = range;
  out.size = angularSize(v, _u, range);
  out.contrast = 0;
  out.ok = false;
  if (out.size < rules.minSize) {
    out.failure = 'TOO SMALL';
    return false;
  }
  out.contrast = vehicleContrast(sim, v, rules.band, head, out.detail);
  if (out.contrast < rules.minContrast) {
    out.failure = 'LOW CONTRAST';
    return false;
  }
  if (!skipSight && !sim.world.terrain.lineOfSight(head, _c, true)) {
    out.failure = 'NO LINE OF SIGHT';
    return false;
  }
  out.failure = '';
  out.ok = true;
  return true;
}

/** Candidate list scratch (indices into sim.targets.vehicles sorted by angle). */
const MAX_CANDIDATES = 256;
const candIndex = new Int32Array(MAX_CANDIDATES);
const candAngle = new Float64Array(MAX_CANDIDATES);
const _probe = createTrackCheck();

/** Most candidates that get the expensive checks in one search. */
const MAX_TESTED = 6;

/**
 * Search the gate (half-angle `gate` around the unit line of sight `los` from `head`) for the
 * vehicle closest to the line of sight that the tracker can acquire. `exclude` skips one vehicle
 * id. Fills `out`; when nothing qualifies, `out.failure` says why the nearest candidate failed
 * ('NO TARGET' when the gate is empty).
 */
export function searchGate(
  sim: Sim,
  head: Vector3,
  los: Vector3,
  gate: number,
  rules: TrackRules,
  out: TrackCheck,
  exclude = -1,
): boolean {
  const list = sim.targets.vehicles;
  const cosGate = Math.cos(gate);
  let n = 0;
  for (let i = 0; i < list.length && n < MAX_CANDIDATES; i++) {
    const v = list[i];
    if (v.id === exclude) continue;
    vehicleCentre(v, _c);
    _u.subVectors(_c, head);
    const d = _u.length();
    if (d < 1) continue;
    const cos = (_u.x * los.x + _u.y * los.y + _u.z * los.z) / d;
    if (cos < cosGate) continue;
    // insertion by angle (small lists)
    const a = Math.acos(Math.min(1, cos));
    let j = n++;
    while (j > 0 && candAngle[j - 1] > a) {
      candAngle[j] = candAngle[j - 1];
      candIndex[j] = candIndex[j - 1];
      j--;
    }
    candAngle[j] = a;
    candIndex[j] = i;
  }
  out.ok = false;
  out.vehicleId = -1;
  out.contrast = 0;
  out.failure = n === 0 ? 'NO TARGET' : '';
  for (let k = 0; k < n && k < MAX_TESTED; k++) {
    const v = list[candIndex[k]];
    if (checkVehicle(sim, v, head, rules, _probe)) {
      copyCheck(_probe, out);
      out.offset = candAngle[k];
      return true;
    }
    if (k === 0) {
      copyCheck(_probe, out);
      out.offset = candAngle[k];
      out.ok = false;
    }
  }
  return false;
}

function copyCheck(a: TrackCheck, b: TrackCheck): void {
  b.ok = a.ok;
  b.failure = a.failure;
  b.vehicleId = a.vehicleId;
  b.contrast = a.contrast;
  b.size = a.size;
  b.range = a.range;
  b.offset = a.offset;
  const d = a.detail;
  const e = b.detail;
  e.band = d.band;
  e.contrast = d.contrast;
  e.apparent = d.apparent;
  e.haze = d.haze;
  e.smoke = d.smoke;
  e.range = d.range;
}
