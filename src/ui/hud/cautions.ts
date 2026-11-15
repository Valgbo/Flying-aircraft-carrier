/**
 * Caution logic of the HUD: which banners are active for a telemetry snapshot, in priority
 * order. Pure, so the thresholds are unit-tested.
 *
 * A banner that is already showing clears a little later than it sets (hysteresis), so a
 * value hovering on a threshold does not make it flicker at the 10 Hz telemetry rate.
 */
import type { Telemetry } from '../../state/types';

export type CautionId =
  'sinkRate' | 'lowAltitude' | 'engineOut' | 'bankAngle' | 'pitch' | 'ceiling' | 'manual';

/** warning = act now (red, flashing) · caution = be aware (amber) · advisory = a mode reminder. */
export type CautionLevel = 'warning' | 'caution' | 'advisory';

export interface Caution {
  id: CautionId;
  label: string;
  level: CautionLevel;
}

export const CAUTION_LIMITS = {
  /** SINK RATE: descending faster than this (m/s) … */
  sinkRate: 15,
  /** … with less than this much air under the keel (m). */
  sinkRateClearance: 400,
  /** LOW ALTITUDE: keel clearance below this (m) while descending and not afloat. */
  lowAltitudeClearance: 40,
  /** Vertical speed that counts as descending, m/s. */
  descending: 0.5,
  /** BANK ANGLE: |roll| above this, degrees. */
  bankDeg: 20,
  /** PITCH: |pitch| above this, degrees. */
  pitchDeg: 15,
  /** CEILING: altitude above this, m. */
  ceiling: 3300,
} as const;

/** Fraction by which a showing banner's threshold is relaxed before it clears. */
const HYSTERESIS = 0.08;

/** Highest priority first. */
const DEFINITIONS: readonly Caution[] = [
  { id: 'sinkRate', label: 'SINK RATE', level: 'warning' },
  { id: 'lowAltitude', label: 'LOW ALTITUDE', level: 'warning' },
  { id: 'engineOut', label: 'ENGINE OUT', level: 'warning' },
  { id: 'bankAngle', label: 'BANK ANGLE', level: 'caution' },
  { id: 'pitch', label: 'PITCH', level: 'caution' },
  { id: 'ceiling', label: 'CEILING', level: 'caution' },
  { id: 'manual', label: 'MANUAL CONTROL', level: 'advisory' },
];

function isActive(id: CautionId, t: Telemetry, assistEnabled: boolean, showing: boolean): boolean {
  // a showing banner clears at a slightly easier value than the one that set it
  const above = showing ? 1 - HYSTERESIS : 1;
  const below = showing ? 1 + HYSTERESIS : 1;
  const L = CAUTION_LIMITS;
  switch (id) {
    case 'sinkRate':
      return t.verticalSpeed < -L.sinkRate * above && t.keelClearance < L.sinkRateClearance * below;
    case 'lowAltitude':
      return (
        !t.afloat &&
        t.keelClearance < L.lowAltitudeClearance * below &&
        t.verticalSpeed < (showing ? 0 : -L.descending)
      );
    case 'engineOut':
      return !t.afloat && t.enabled.some((on) => !on);
    case 'bankAngle':
      return Math.abs(t.rollDeg) > L.bankDeg * above;
    case 'pitch':
      return Math.abs(t.pitchDeg) > L.pitchDeg * above;
    case 'ceiling':
      return t.altitude > L.ceiling * (showing ? 1 - HYSTERESIS / 4 : 1);
    case 'manual':
      return !assistEnabled;
  }
}

/**
 * Active cautions for a telemetry snapshot, highest priority first.
 * `showing` is the list returned for the previous snapshot (enables the hysteresis).
 */
export function deriveCautions(
  telemetry: Telemetry,
  assistEnabled: boolean,
  showing: readonly Caution[] = [],
): Caution[] {
  const active: Caution[] = [];
  for (const def of DEFINITIONS) {
    const wasShowing = showing.some((c) => c.id === def.id);
    if (isActive(def.id, telemetry, assistEnabled, wasShowing)) active.push(def);
  }
  return active;
}

/**
 * The banners that fit on screen: the `maxBanners` most urgent warnings / cautions, followed
 * by the advisory chips (which are small and always shown).
 */
export function selectVisibleCautions(cautions: readonly Caution[], maxBanners: number): Caution[] {
  const banners = cautions.filter((c) => c.level !== 'advisory').slice(0, Math.max(0, maxBanners));
  const advisories = cautions.filter((c) => c.level === 'advisory');
  return [...banners, ...advisories];
}

/** True when two caution lists show the same banners in the same order. */
export function sameCautions(a: readonly Caution[], b: readonly Caution[]): boolean {
  return a.length === b.length && a.every((c, i) => c.id === b[i].id);
}
