/**
 * Weapons-range options (PLAN_A10.md §11.2): the conditions a range event is flown in — the
 * surface wind (its speed, and the clock direction it blows FROM seen along the event's run-in,
 * the way a range officer reads it to a pilot), the turbulence, and on the tactical lane the
 * moving column's speed. Chosen on the main menu (RangeOptionsDialog), remembered under
 * 'a10-range-v1' (a key of its own: the loadout choices keep their 'a10-ui-v1' format), and
 * applied to every range flight before its first step (flightSetup.ts). Free hunt keeps the
 * world's own conditions.
 *
 * The world module keeps the weather constant through a flight and documents setting it before
 * the first step (core/world stepWorld); the column follows its group's cruise speed every step
 * (core/targets behaviour stepColumn).
 */
import { findRangeLayout } from '../core/debrief';
import type { Sim } from '../core/types';
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
 * run-in, against the aircraft.
 */
export function rangeWind(
  speedKt: number,
  clock: number,
  runIn: number,
): { x: number; y: number; z: number } {
  const from = runIn + ((clock % 12) * Math.PI) / 6;
  const to = from + Math.PI;
  const u = speedKt * KT;
  return { x: u * Math.sin(to), y: 0, z: -u * Math.cos(to) };
}

/**
 * Put the options on a range flight before its first step: the wind (relative to the event's
 * run-in) and the turbulence, and on the tactical lane the column's cruise speed (its vehicles
 * start at it). Free hunt and an empty world are left alone. Returns whether it applied.
 */
export function applyRangeOptions(sim: Sim, o: RangeOptions): boolean {
  const layout = findRangeLayout(sim);
  if (layout.event === 'none') return false;
  const w = rangeWind(o.windKt, o.windClock, layout.runIn);
  sim.world.surfaceWind.set(w.x, w.y, w.z);
  sim.world.turbulence = TURBULENCE_LEVELS[o.turbulence].value;
  if (layout.event === 'tacticalLane') {
    const speed = o.columnKmh / 3.6;
    for (const g of sim.targets.groups) {
      if (g.template !== 'laneColumn') continue;
      g.speed = speed;
      for (const v of sim.targets.vehicles) if (g.vehicleIds.includes(v.id)) v.speed = speed;
    }
  }
  return true;
}
