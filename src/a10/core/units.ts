/**
 * Unit conversions. The simulation core is SI throughout (m, kg, s, N, rad). The cockpit and
 * the interface show what the real aircraft shows: knots, feet, nautical miles, milliradians.
 */

/** m/s per knot. */
export const KT = 0.514444;
/** m per foot. */
export const FT = 0.3048;
/** m per nautical mile. */
export const NM = 1852;
/** kg per pound (mass). */
export const LB = 0.45359237;
/** N per pound-force. */
export const LBF = 4.4482216;
/** rad per degree. */
export const DEG = Math.PI / 180;
/** rad per milliradian. */
export const MIL = 0.001;

export const msToKt = (v: number): number => v / KT;
export const ktToMs = (v: number): number => v * KT;
export const mToFt = (v: number): number => v / FT;
export const ftToM = (v: number): number => v * FT;
export const mToNm = (v: number): number => v / NM;
export const radToDeg = (v: number): number => v / DEG;
export const degToRad = (v: number): number => v * DEG;
/** m/s → ft/min (vertical speed). */
export const msToFpm = (v: number): number => (v / FT) * 60;
