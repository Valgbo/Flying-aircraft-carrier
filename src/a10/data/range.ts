/**
 * Weapons-range rules and the debrief's definitions (PLAN_A10.md §11): the strafe pit's foul line
 * and minimum altitude, the bombing circle's scoring, and how the debrief cuts a flight into
 * passes. Owned by the DEBRIEF + RANGE module (core/debrief, the debrief screen).
 *
 * Range rules (public range practice, docs/a10/REFERENCE_DATA.md):
 *  - The strafe foul line is a line on the ground across the run-in, in front of the panels
 *    (US range design marks it with a 15 × 600 ft white line or pylons, perpendicular to the
 *    run-in line). Firing after crossing it is a foul. No public A-10 figure gives its distance;
 *    2,000 ft is the usual figure for the 30 mm gun and is also the minimum range of the GAU-8
 *    gun sight (FIRE_CONTROL.minRange in data/avionics.ts): inside it the pilot risks his own
 *    ricochets and fragments.
 *  - A pass that goes below the event's minimum altitude is a foul (USAF range practice: the
 *    range officer assesses a foul when an aircraft passes below the minimum recovery altitude).
 *    The A-10's figure is in restricted manuals; 100 ft above the ground is our estimate for a
 *    low-angle strafe (the Navy's 10° training pattern fires between 1,100 and 800 ft AGL; the
 *    A-10's low-angle strafe is flown lower).
 *  - A fouled pass scores no hits (the pilot's hits on that pass do not count).
 *  - Bomb scores are the miss distance from the target on the ground and its clock direction
 *    relative to the run-in heading (12 o'clock = long, along the run-in; 6 = short).
 *
 * Pass definitions (our own, so that every pass reads like a pilot's pass): a pass begins with
 * the roll-in (the dive that carries the first weapon event; a level delivery begins at its
 * first release) and ends at the pull-off (the climb after the last weapon event, or a quiet
 * spell after it for a level delivery). A dive or climb without a weapon event is not a pass.
 */
import { FT } from '../core/units';
import type { SourceNote } from './sources';

const DEG = Math.PI / 180;

export const RANGE_RULES = {
  /** Strafe pit: horizontal distance of the foul line in front of the panels, along the run-in, m. */
  strafeFoulLine: 2000 * FT,
  /** Strafe pit: lowest height above the ground allowed from the first round to the pull-off, m. */
  strafeMinAltitude: 100 * FT,
  /** A fouled pass scores no hits. */
  foulVoidsPass: true,
} as const;

export const RANGE_RULES_NOTES: Record<keyof typeof RANGE_RULES, SourceNote> = {
  strafeFoulLine: {
    source: 'plan',
    confidence: 'estimate',
    note:
      'Brief: ≈2,000 ft from the panels, public range practice; = the gun sight minimum range. ' +
      'NAVFAC MIL-HDBK-1027/3B describes the line (15 × 600 ft, across the run-in), not its distance',
  },
  strafeMinAltitude: {
    source: 'plan',
    confidence: 'estimate',
    note:
      'USAF range practice: a foul for passing below the minimum recovery altitude (value in ' +
      'restricted A-10 manuals); Navy P-1209 10° pattern fires 1,100–800 ft AGL; A-10 LAS lower',
  },
  foulVoidsPass: { source: 'plan', confidence: 'approximate', note: 'Range scoring practice' },
};

/** How the debrief cuts the flight into passes (definitions, not measured values). */
export const PASS_RULES = {
  /** A flight path steeper than this below the horizon is a dive (the roll-in starts it), rad. */
  rollInDive: 3 * DEG,
  /** The roll-in is looked for at most this long before the first weapon event, s. */
  maxRollIn: 25,
  /** A climb steeper than this after the last weapon event is the pull-off, rad. */
  pullOffClimb: 2 * DEG,
  /** The pull-off is not looked for earlier than this after the last weapon event, s. */
  pullOffMinTime: 1,
  /** A pass also ends this long after its last weapon event (level deliveries), s. */
  passTimeout: 10,
  /** Rounds that land this long after a pass's last round still belong to it, s (round lifetime). */
  roundWindow: 8,
} as const;

export const PASS_RULES_NOTES: Record<keyof typeof PASS_RULES, SourceNote> = {
  rollInDive: {
    source: 'plan',
    confidence: 'estimate',
    note: 'Low-angle strafe is flown at 5–15°',
  },
  maxRollIn: { source: 'plan', confidence: 'estimate' },
  pullOffClimb: { source: 'plan', confidence: 'estimate' },
  pullOffMinTime: { source: 'plan', confidence: 'estimate' },
  passTimeout: { source: 'plan', confidence: 'estimate', note: 'Ripple and level CCRP deliveries' },
  roundWindow: {
    source: 'plan',
    confidence: 'estimate',
    note: 'GAU-8 round lifetime cap (ROUND_BEHAVIOUR.maxLifetime)',
  },
};

/** What the debrief keeps in memory (a full drum is 1,150 rounds; skips add impacts). */
export const DEBRIEF_LIMITS = {
  /** Impacts kept per flight (rounds, skips, stores). */
  maxImpacts: 30000,
  /** Ground impacts further than this from every vehicle are kept without a vehicle frame, m. */
  nearMissRadius: 40,
  /** A pass target is the vehicle nearest the aim point within this distance, m. */
  targetRadius: 120,
  /** Impacts this close to the pass's target are logged in its frame (plots), m. */
  targetFrameRadius: 600,
} as const;

export const DEBRIEF_LIMITS_NOTES: Record<keyof typeof DEBRIEF_LIMITS, SourceNote> = {
  maxImpacts: { source: 'plan', confidence: 'estimate' },
  nearMissRadius: { source: 'plan', confidence: 'estimate' },
  targetRadius: { source: 'plan', confidence: 'estimate' },
  targetFrameRadius: { source: 'plan', confidence: 'estimate' },
};
