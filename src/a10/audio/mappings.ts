/**
 * Pure parameter mappings of the A-10 sound: simulation quantities in, linear gains, playback
 * rates and frequencies out. No Web Audio in here, so all of it is unit-tested in Node
 * (tests/unit/a10/audio.test.ts). Every function returns a finite, bounded number for any input:
 * NaN and ±Infinity count as 0 (or as the documented default).
 *
 * Gains here are RELATIVE (0..1 within a layer); the absolute levels of the mix live with the
 * voices (gun.ts, engines.ts …) and are measured by the audio sandbox.
 */
import { clamp, clamp01, smoothstep, volumeToGain } from '../../engine';
import { A10 } from '../data/aircraft';
import { GAU8 } from '../data/gun';

function finite(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

// ---- mix settings --------------------------------------------------------------------------

/** The mixer's buses. The gun is the loudness reference; the cockpit bus is never ducked. */
export type BusId = 'gun' | 'engines' | 'airframe' | 'world' | 'cockpit';
export const BUS_IDS: readonly BusId[] = ['gun', 'engines', 'airframe', 'world', 'cockpit'];

/** Volume used when the stored one is unusable (matches the store's default). */
export const DEFAULT_VOLUME = 0.8;
/** Largest per-bus trim (+6 dB). */
export const MAX_TRIM = 2;

/** Master gain from the store's settings: square-law volume, 0 when muted, any junk → default. */
export function masterGain(volume: unknown, muted: unknown): number {
  if (muted === true) return 0;
  const v = typeof volume === 'number' && Number.isFinite(volume) ? volume : DEFAULT_VOLUME;
  return volumeToGain(clamp01(v));
}

export type BusTrims = Record<BusId, number>;

export function defaultTrims(): BusTrims {
  return { gun: 1, engines: 1, airframe: 1, world: 1, cockpit: 1 };
}

/**
 * Per-bus trims (linear, 0..MAX_TRIM, default 1) from untrusted input: a parsed URL flag, the
 * console handle or storage. Unknown buses and bad values are ignored.
 */
export function sanitizeTrims(raw: unknown, base: BusTrims = defaultTrims()): BusTrims {
  const out: BusTrims = { ...base };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const bus of BUS_IDS) {
    const v = r[bus];
    if (typeof v === 'number' && Number.isFinite(v)) out[bus] = clamp(v, 0, MAX_TRIM);
  }
  return out;
}

/** Parse "gun:1,engines:0.6" (the `?audiomix=` URL flag) into trims; junk entries are skipped. */
export function parseTrims(text: string | null | undefined): BusTrims {
  const raw: Record<string, number> = {};
  if (typeof text === 'string') {
    for (const part of text.split(',')) {
      const [k, v] = part.split(':');
      if (!k || v === undefined || v.trim() === '') continue;
      raw[k.trim()] = Number(v);
    }
  }
  return sanitizeTrims(raw);
}

// ---- engines (TF34) ------------------------------------------------------------------------

/**
 * TF34 speeds the mappings are built around (data/aircraft.ts TF34: fan ≈0.28 and core 0.60 at
 * idle on the ground; the fan windmills faster in flight).
 */
export const ENGINE_N1_IDLE = 0.28;
export const ENGINE_N2_IDLE = 0.6;
/** Core speed at which the recorded whine loops play at their own speed. */
export const ENGINE_N2_REF = 0.92;

export interface EngineLayers {
  /** Outside fan buzz (fan2), cockpit fan (fan3), high whine, core whine, exhaust roar. */
  fan: number;
  fanInside: number;
  whine: number;
  whineLow: number;
  jet: number;
  /** Playback rates of the loops. */
  fanRate: number;
  whineRate: number;
  jetRate: number;
}

export function createEngineLayers(): EngineLayers {
  return {
    fan: 0,
    fanInside: 0,
    whine: 0,
    whineLow: 0,
    jet: 0,
    fanRate: 1,
    whineRate: 1,
    jetRate: 1,
  };
}

/** Fan speed above idle, 0 (idle) … 1 (MAX). */
export function fanSpool(n1: number): number {
  return clamp01((finite(n1) - ENGINE_N1_IDLE) / (1 - ENGINE_N1_IDLE));
}

/** Core speed above idle, 0 (idle) … 1 (MAX). */
export function coreSpool(n2: number): number {
  return clamp01((finite(n2) - ENGINE_N2_IDLE) / (1 - ENGINE_N2_IDLE));
}

/**
 * Layer gains and playback rates of one engine from its spool speeds. The TF34 is a high-bypass
 * fan: at idle the core whine is what you hear; with power the fan buzz and then the exhaust
 * roar come up (jet noise grows very steeply with exhaust speed). The fan's pitch range is
 * compressed (idle plays at 0.55×, not the real 0.3×) so the loop never turns to mud.
 * `running` false (or a stopped core) silences the engine.
 */
export function engineLayers(
  n1: number,
  n2: number,
  running: boolean,
  out: EngineLayers,
): EngineLayers {
  const f = fanSpool(n1);
  const c = coreSpool(n2);
  // a core below about half its idle speed makes no sound worth playing
  const alive = running ? smoothstep(0.15, 0.45, finite(n2)) : 0;
  out.fan = alive * (0.35 + 0.65 * Math.pow(f, 1.5));
  out.fanInside = alive * (0.45 + 0.55 * Math.pow(f, 1.2));
  out.whine = alive * (0.75 + 0.25 * c);
  out.whineLow = alive * (0.6 + 0.4 * c);
  out.jet = alive * (0.06 + 0.94 * Math.pow(f, 2.2));
  out.fanRate = 0.55 + 0.6 * f;
  out.whineRate = clamp(finite(n2, ENGINE_N2_IDLE) / ENGINE_N2_REF, 0.4, 1.25);
  out.jetRate = 0.85 + 0.25 * f;
  return out;
}

// ---- airframe ------------------------------------------------------------------------------

/** Airflow noise 0..1 from indicated airspeed (m/s): nothing below 20 m/s, full near Vne. */
export function windGain(ias: number): number {
  const v = clamp01((Math.abs(finite(ias)) - 20) / (A10.vne - 20));
  return Math.pow(v, 1.3);
}

/** Brightness of the airflow noise, Hz: a dull rush when slow, a hiss when fast. */
export function windCutoff(ias: number): number {
  const v = clamp01(Math.abs(finite(ias)) / A10.vne);
  return 350 + 4200 * Math.pow(v, 1.4);
}

/** Angle of attack where the buffet starts and where it is fully developed, rad (estimates). */
export const BUFFET_ALPHA_ONSET = (11 * Math.PI) / 180;
export const BUFFET_ALPHA_FULL = (17 * Math.PI) / 180;

/**
 * Buffet rumble near the stall 0..1: grows from the onset angle of attack to the stall, scaled
 * by dynamic pressure (no airflow, no buffet), plus the high-speed buffet above Vne.
 */
export function buffetGain(alpha: number, ias: number): number {
  const v = Math.abs(finite(ias));
  const stall = smoothstep(BUFFET_ALPHA_ONSET, BUFFET_ALPHA_FULL, finite(alpha));
  const q = clamp01(v / 90);
  const overspeed = smoothstep(0.97 * A10.vne, 1.08 * A10.vne, v);
  return clamp01(stall * q * q + 0.6 * overspeed);
}

/** Speed-brake rumble 0..1 from the opening (0..1) and the airspeed. */
export function speedBrakeGain(opening: number, ias: number): number {
  const o = clamp01(finite(opening));
  const v = clamp01((Math.abs(finite(ias)) - 30) / 170);
  return Math.sqrt(o) * Math.pow(v, 1.2);
}

/** Landing-gear rumble 0..1 (the gear in the airflow). */
export function gearGain(gearDown: boolean, ias: number): number {
  if (!gearDown) return 0;
  return Math.pow(clamp01(Math.abs(finite(ias)) / 110), 1.5);
}

/** Creak of the airframe under load 0..1: nothing below 4 g, strongest at the limit. */
export function creakGain(gLoad: number): number {
  return smoothstep(4, A10.gLimitPositive, finite(gLoad, 1));
}

// ---- the GAU-8/A ---------------------------------------------------------------------------

/** Shot rate of the recorded loop, measured on FlightGear's gau-8.wav (69.7 per second). */
export const GUN_LOOP_SHOT_RATE = 69.7;
/** Playback rate of the loop at the real gun's full rate (65/69.7 ≈ 0.933). */
export const GUN_LOOP_FULL_RATE = GAU8.rate / GUN_LOOP_SHOT_RATE;

/** Firing intensity 0..1: the fraction of full rate. */
export function gunFireLevel(rate: number): number {
  return clamp01(finite(rate) / GAU8.rate);
}

/**
 * Playback rate of the recorded loop: its shots then come at the gun's real rate. During the
 * spin-up it follows the rate down to half speed; below that the loop fades out instead (see
 * gunLoopGain), so the first rounds are carried by the synthesised pulse train.
 */
export function gunLoopRate(rate: number): number {
  return clamp(finite(rate) / GUN_LOOP_SHOT_RATE, 0.5, 1.2);
}

/** Gain of the recorded loop from the firing rate. */
export function gunLoopGain(rate: number): number {
  return Math.pow(gunFireLevel(rate), 0.8);
}

/** Frequency of the synthesised pulse train = rounds per second (one pulse per round). */
export function gunPulseHz(rate: number): number {
  return clamp(finite(rate), 1, 120);
}

/** Gain of the pulse train: the airframe takes every round, from the first one. */
export function gunPulseGain(rate: number): number {
  return Math.pow(gunFireLevel(rate), 0.5);
}

/** Low rumble of the burst. */
export function gunRumbleGain(rate: number): number {
  return Math.pow(gunFireLevel(rate), 1.2);
}

/**
 * Fundamental of the hydraulic drive's whine, Hz, from the barrel speed (0..1). Full speed is a
 * 557 rpm barrel cluster (3,900 rounds/min over 7 barrels) geared up to the drive motors.
 */
export function gunWhineHz(spin: number): number {
  return 70 + 530 * clamp01(finite(spin));
}

/** Gain of the drive whine: rises over the spin-up, falls with the spin-down. */
export function gunWhineGain(spin: number): number {
  return Math.pow(clamp01(finite(spin)), 1.5);
}
