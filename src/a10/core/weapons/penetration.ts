/**
 * 30 mm armour penetration as a function of impact speed (PLAN_A10.md §6.3).
 *
 * The published figures (≈69 mm of steel at 500 m and ≈38 mm at 1,000 m) are read as the
 * performance of a round fired from an aircraft at 300 kn, so the fit is
 *     P(v) = P_REF · (v / V_REF)^EXPONENT
 * where V_REF and EXPONENT come from flying our own ballistic model to those two ranges
 * (docs/a10/ARCHITECTURE.md §6). FOUNDATION STAND-IN values; the weapons module owner
 * regenerates them from the final drag law with a unit test that recomputes them.
 */
import { RoundType } from './types';

/** Impact speed at which an API round penetrates P_REF, m/s (stand-in). */
export const API_V_REF = 1018;
/** Penetration at V_REF, mm. */
export const API_P_REF = 69;
/** Exponent of the fit (stand-in). */
export const API_EXPONENT = 4.44;

/** Steel penetration at normal incidence, mm, for a round hitting at `speed` m/s. */
export function penetrationMm(type: RoundType, speed: number): number {
  if (type === RoundType.API)
    return API_P_REF * Math.pow(Math.max(0, speed) / API_V_REF, API_EXPONENT);
  // HEI and TP do not penetrate armour; they defeat thin skin only.
  return type === RoundType.HEI ? 8 : 6;
}
