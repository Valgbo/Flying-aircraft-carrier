/**
 * 30 mm armour penetration as a function of impact speed (PLAN_A10.md §6.3).
 *
 * The published figures (≈69 mm of steel at 500 m and ≈38 mm at 1,000 m) are read as the
 * performance of a round fired from an aircraft at 300 kn, level, 1,000 m above sea level in the
 * standard atmosphere, along the line of fire (docs/a10/ARCHITECTURE.md §5). Flying OUR ballistic
 * model under those conditions gives the impact speeds at the two ranges, V500 and V1000, and
 *     P(v) = P_REF · (v / V_REF)^EXPONENT,   V_REF = V500,  P_REF = 69 mm,
 *     EXPONENT = ln(69 / 38) / ln(V500 / V1000)
 * passes through both points. A normal attack therefore matches the published table, while a
 * faster or closer attack penetrates more, as it physically should.
 *
 * The constants below are frozen from `fitApiPenetration()`; tests/unit/a10/ballistics.test.ts
 * refits them from the model and checks both points within 1 mm.
 *
 * HEI and TP do not defeat armour: the HEI's fuze functions on contact and the inert TP's
 * aluminium body breaks up; both hole only thin sheet (data/gun.ts).
 */
import { Vector3 } from 'three';
import { GAU8 } from '../../data/gun';
import { KT } from '../units';
import { flyRoundToRange, muzzleVelocity, type RoundAtRange } from './ballistics';
import { RoundType } from './types';

/** Impact speed at which an API round penetrates P_REF (the speed at 500 m), m/s. */
export const API_V_REF = 1042.84;
/** Penetration at V_REF, mm. */
export const API_P_REF = GAU8.penetration500m;
/** Exponent of the fit. */
export const API_EXPONENT = 4.8603;

/** The firing conditions the published figures are read under. */
export const PENETRATION_FIT_CONDITIONS = {
  /** Height above sea level, m. */
  altitude: 1000,
  /** Aircraft true airspeed, level, m/s. */
  aircraftSpeed: 300 * KT,
  /** Slant ranges of the two published points, m. */
  ranges: [500, 1000],
} as const;

export interface PenetrationFit {
  /** Impact speeds at the two ranges, m/s. */
  v500: number;
  v1000: number;
  vRef: number;
  exponent: number;
}

const _o = new Vector3();
const _v = new Vector3();
const _still = new Vector3();
const _at: RoundAtRange = {
  time: 0,
  speed: 0,
  drop: 0,
  point: new Vector3(),
  velocity: new Vector3(),
};

/** Fit V_REF and the exponent from the ballistic model (see the file comment). */
export function fitApiPenetration(): PenetrationFit {
  const c = PENETRATION_FIT_CONDITIONS;
  _o.set(0, c.altitude, 0);
  _v.set(0, 0, -(muzzleVelocity(RoundType.API) + c.aircraftSpeed));
  flyRoundToRange(RoundType.API, _o, _v, c.ranges[0], _still, _at);
  const v500 = _at.speed;
  flyRoundToRange(RoundType.API, _o, _v, c.ranges[1], _still, _at);
  const v1000 = _at.speed;
  const exponent = Math.log(GAU8.penetration500m / GAU8.penetration1000m) / Math.log(v500 / v1000);
  return { v500, v1000, vRef: v500, exponent };
}

/** Thin-skin rounds: penetration grows with impact energy, from the value at V_REF. */
function thinSkin(reference: number, speed: number): number {
  const r = speed / API_V_REF;
  return reference * r * r;
}

/** Steel penetration at normal incidence, mm, for a round hitting at `speed` m/s. */
export function penetrationMm(type: RoundType, speed: number): number {
  const v = speed > 0 ? speed : 0;
  if (type === RoundType.API) return API_P_REF * Math.pow(v / API_V_REF, API_EXPONENT);
  return thinSkin(type === RoundType.HEI ? GAU8.penetrationHei : GAU8.penetrationTp, v);
}
