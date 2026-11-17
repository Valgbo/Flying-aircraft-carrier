/**
 * Weapons-range options (PLAN_A10.md §11.2): the conditions a range event is flown in — the
 * surface wind (its speed, and the clock direction it blows FROM seen along the event's run-in,
 * the way a range officer reads it to a pilot), the turbulence, and on the tactical lane the
 * moving column's speed. Chosen on the main menu (RangeOptionsDialog), remembered under
 * 'a10-range-v1' (a key of its own: the loadout choices keep their 'a10-ui-v1' format). The UI
 * store hands them to the app store as SimOptions.range (toRangeConditions); startFlight passes
 * them to createSim, which puts them on a range event before its first step (core/sim
 * applyRangeConditions). Free hunt keeps the world's own conditions.
 */
import { rangeWind as rangeWindAlong } from '../core/debrief';
import type { RangeConditions } from '../core/types';
import { KT } from '../core/units';
import { MOBILITY } from '../data/vehicles';
import { formatClockDirection } from './format';

export const RANGE_STORAGE_KEY = 'a10-range-v1';

/** Turbulence settings and the world's turbulence value for each (core/world: 1 = moderate). */
export const TURBULENCE_LEVELS = {
  calm: { value: 0, label: 'Calm', hint: 'Only what the wind itself stirs up.' },
  light: { value: 0.15, label: 'Light', hint: 'A few bumps low down: the usual day.' },
  moderate: { value: 0.5, label: 'Moderate', hint: 'The pipper wanders; fly smoothly.' },
  strong: { value: 1, label: 'Strong', hint: 'Moderate turbulence near the ground.' },
} as const;

export type TurbulenceLevel = keyof typeof TURBULENCE_LEVELS;

const TURBULENCE_IDS = Object.keys(TURBULENCE_LEVELS) as TurbulenceLevel[];

export interface RangeOptions {
  /** Surface wind (10 m above the ground), kn; 0 = calm. */
  windKt: number;
  /** Where the wind blows FROM, as a clock direction along the event's run-in (12 = headwind). */
  windClock: number;
  turbulence: TurbulenceLevel;
  /** Tactical lane: the moving column's speed, km/h (0 = halted). */
  columnKmh: number;
}

/** Surface wind speeds offered, kn. */
export const WIND_SPEEDS_KT: readonly number[] = [0, 5, 10, 15, 20, 25];

/** Column speeds offered, km/h: halted, the lane's own walking pace, a road march (PLAN §9). */
export const COLUMN_SPEEDS_KMH: readonly number[] = [0, 15, 30, 40];

/** The lane's own column speed (data/vehicles.ts MOBILITY.laneSpeed), km/h. */
export const LANE_SPEED_KMH = Math.round(MOBILITY.laneSpeed * 3.6);

export const DEFAULT_RANGE_OPTIONS: Readonly<RangeOptions> = {
  windKt: 0,
  windClock: 12,
  turbulence: 'light',
  columnKmh: LANE_SPEED_KMH,
};

/** A clock direction's name as a pilot hears it: 12 → 'headwind', 3 → 'from the right'… */
export function windClockName(clock: number): string {
  if (clock === 12) return 'headwind';
  if (clock === 6) return 'tailwind';
  if (clock === 3) return 'from the right';
  if (clock === 9) return 'from the left';
  if (clock === 1 || clock === 2) return 'from ahead right';
  if (clock === 10 || clock === 11) return 'from ahead left';
  if (clock === 4 || clock === 5) return 'from behind right';
  return 'from behind left';
}

/** One line for the menu: "Wind 10 kn from 3 o'clock · light turbulence · column 15 km/h". */
export function describeRangeOptions(o: RangeOptions, withColumn = true): string {
  const wind =
    o.windKt > 0 ? `Wind ${o.windKt} kn from ${formatClockDirection(o.windClock)}` : 'Calm wind';
  const parts = [wind, `${TURBULENCE_LEVELS[o.turbulence].label.toLowerCase()} turbulence`];
  if (withColumn) parts.push(o.columnKmh > 0 ? `column ${o.columnKmh} km/h` : 'column halted');
  return parts.join(' · ');
}

function pick(value: unknown, allowed: readonly number[], fallback: number): number {
  return typeof value === 'number' && allowed.includes(value) ? value : fallback;
}

/** Valid options from anything (saved data, a test): unknown values take the defaults. */
export function sanitizeRangeOptions(raw: unknown): RangeOptions {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_RANGE_OPTIONS;
  const clock = r.windClock;
  return {
    windKt: pick(r.windKt, WIND_SPEEDS_KT, d.windKt),
    windClock:
      typeof clock === 'number' && Number.isInteger(clock) && clock >= 1 && clock <= 12
        ? clock
        : d.windClock,
    turbulence: TURBULENCE_IDS.includes(r.turbulence as TurbulenceLevel)
      ? (r.turbulence as TurbulenceLevel)
      : d.turbulence,
    columnKmh: pick(r.columnKmh, COLUMN_SPEEDS_KMH, d.columnKmh),
  };
}

/** The saved options (the defaults when nothing valid is saved or storage is unavailable). */
export function loadRangeOptions(): RangeOptions {
  try {
    const text = localStorage.getItem(RANGE_STORAGE_KEY);
    return sanitizeRangeOptions(text ? JSON.parse(text) : null);
  } catch {
    return { ...DEFAULT_RANGE_OPTIONS };
  }
}

export function saveRangeOptions(o: RangeOptions): void {
  try {
    localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify(o));
  } catch {
    // storage unavailable (private mode): the options last for this visit
  }
}

/**
 * The surface wind of a clock direction along a run-in, world m/s (x east, z south), the
 * direction the air MOVES toward (WorldState.surfaceWind). From 12 o'clock it blows down the
 * run-in, against the aircraft (core/debrief rangeWind, which createSim uses).
 */
export function rangeWind(
  speedKt: number,
  clock: number,
  runIn: number,
): { x: number; y: number; z: number } {
  const out = { x: 0, y: 0, z: 0 };
  rangeWindAlong(speedKt * KT, clock, runIn, out);
  return out;
}

/** The options as the simulation takes them (SimOptions.range: SI units, the world's values). */
export function toRangeConditions(o: RangeOptions): RangeConditions {
  return {
    windSpeed: o.windKt * KT,
    windClock: o.windClock,
    turbulence: TURBULENCE_LEVELS[o.turbulence].value,
    columnSpeed: o.columnKmh / 3.6,
  };
}
