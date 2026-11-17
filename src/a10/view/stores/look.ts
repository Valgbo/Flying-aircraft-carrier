/**
 * How stores look in flight and when they burst: the motor flame and smoke of a Hydra 70 rocket
 * and of a Maverick, the cloud of a launch, and the white-phosphorus mark. OWNED BY THE
 * STORES-VIEW MODULE (wave 2).
 *
 * Sizes, rates and colours are visual tuning (metres, seconds, particles per metre of path), set
 * from footage-level descriptions and checked on screenshots. The few physical facts behind them
 * carry a `*_NOTES` entry (data/sources.ts ids). Burn times, masses and charges are NOT here: the
 * views read them from the simulation (body.motorTime, detonation charge), so they cannot drift.
 */
import type { SourceNote } from '../../data/sources';

export interface MotorLook {
  /** Flame jet behind the nozzle: length (m) and core sprite size (m); a softer glow around it. */
  flameLength: number;
  flameSize: number;
  glowSize: number;
  /** Smoke trail: spacing of the puffs along the path near the camera (m), size at birth and at
   *  the end of their life (m), life (s), opacity. */
  smokeSpacing: number;
  smokeS0: number;
  smokeS1: number;
  smokeLife: number;
  smokeAlpha: number;
  /** Smoke colour (linear albedo). */
  smokeColour: readonly [number, number, number];
  /** Ignition: flash size (m) and the cloud at the launcher (puffs, sizes, life). */
  launchFlash: number;
  launchPuffs: number;
  launchS0: number;
  launchS1: number;
  launchLife: number;
}

export const MOTOR_LOOK: Record<'rocket' | 'missile', MotorLook> = {
  // Hydra 70, Mk 66 motor: a white-hot pinpoint and a white-grey trail, thick near the launch
  rocket: {
    flameLength: 1.2,
    flameSize: 0.5,
    glowSize: 1.8,
    smokeSpacing: 0.9,
    smokeS0: 0.8,
    smokeS1: 3.2,
    smokeLife: 6,
    smokeAlpha: 0.5,
    smokeColour: [0.76, 0.75, 0.73],
    launchFlash: 2.4,
    launchPuffs: 3,
    launchS0: 0.5,
    launchS1: 3.2,
    launchLife: 2.6,
  },
  // AGM-65D/H: a reduced-smoke motor — a big flame and launch cloud, a thin, light trail
  missile: {
    flameLength: 2.2,
    flameSize: 0.8,
    glowSize: 3,
    smokeSpacing: 1.4,
    smokeS0: 1,
    smokeS1: 4,
    smokeLife: 7,
    smokeAlpha: 0.3,
    smokeColour: [0.8, 0.8, 0.79],
    launchFlash: 4.5,
    launchPuffs: 9,
    launchS0: 1.2,
    launchS1: 7.5,
    launchLife: 4.5,
  },
};

export const MOTOR_LOOK_NOTES: Record<'rocket' | 'missile', SourceNote> = {
  rocket: {
    source: 'gdotsHydra',
    confidence: 'estimate',
    note: 'Mk 66 solid motor (burn ≈1.07 s): a smoke trail and a bright flame; sizes are visual',
  },
  missile: {
    source: 'designationSystems',
    confidence: 'approximate',
    note:
      'AGM-65D onward fly the reduced-smoke TX-633 (SR114-TC-1) motor: a light trail; the ' +
      'boost/sustain burn time comes from the simulation (body.motorTime)',
  },
};

/**
 * The white-phosphorus mark of an M156 warhead: a dense white cloud that drifts downwind and lasts
 * minutes, fed by burning phosphorus on the ground, so the pilot can find the target on the next
 * pass (PLAN §6.7, §8).
 */
export const WP_MARK = {
  /** How long the burning phosphorus keeps the mark going, s. */
  duration: 240,
  /** Share of the smoke made in the first minute (the bulk of the phosphorus burns early). */
  earlyShare: 0.6,
  /** Puffs per second at the start, at full detail, and their size (m) and life (s). */
  rate: 2.2,
  puffS0: 8,
  puffS1: 40,
  puffLife: 70,
  /** The burst: the white bloom (puffs) and the burning streamers (fragments). */
  bloomPuffs: 24,
  streamers: 18,
} as const;

export const WP_MARK_NOTES: Record<keyof typeof WP_MARK, SourceNote> = {
  duration: {
    source: 'plan',
    confidence: 'estimate',
    note:
      'one M156 holds ≈1 kg (2.125 lb) of WP (NSN 1340-00-782-5849 listing); no public smoke ' +
      'duration for it — WP smoke rockets with more fill give > 5 min (M259); minutes here',
  },
  earlyShare: { source: 'plan', confidence: 'estimate', note: 'visual' },
  rate: { source: 'plan', confidence: 'estimate', note: 'visual' },
  puffS0: {
    source: 'plan',
    confidence: 'estimate',
    note: 'the burning pellets cover metres of ground: the smoke is a dense cloud at once; visual',
  },
  puffS1: {
    source: 'turner1970',
    confidence: 'estimate',
    note:
      'a plume ≈40–80 m wide a few hundred metres downwind (Pasquill–Gifford class D spread: ' +
      'σy ≈ 20–35 m at 300–500 m); visual',
  },
  puffLife: { source: 'plan', confidence: 'estimate', note: 'visual' },
  bloomPuffs: { source: 'plan', confidence: 'estimate', note: 'visual' },
  streamers: { source: 'plan', confidence: 'estimate', note: 'visual' },
};

/**
 * The Mk 82 AIR's BSU-49 ballute: the inflation, when the simulation gives no filling times
 * (body.flight.balluteStart/balluteFull), s.
 */
export const BALLUTE_FILL = 0.2;

/**
 * The GBU-12's canards (MAU-169 computer-control group): bang-bang — each one at full deflection
 * toward the laser spot the seeker sees (PLAN §6.6), neutral without a spot. Drawn from the body's
 * guidance (`body.guidance`, the guided module's), so they move only when it has a target.
 */
export const CANARD = {
  /** Full deflection, rad. */
  max: (10 * Math.PI) / 180,
  /** Actuator rate, rad/s (stop to stop in about a tenth of a second). */
  rate: 3.5,
  /** Seeker error inside which an axis is not commanded, rad. */
  deadband: 0.004,
} as const;

export const CANARD_NOTES: Record<keyof typeof CANARD, SourceNote> = {
  max: {
    source: 'plan',
    confidence: 'estimate',
    note:
      'Paveway II steers bang-bang with all-moving canards (public descriptions; the deflection ' +
      'angle is not published): ±10° drawn',
  },
  rate: { source: 'plan', confidence: 'estimate', note: 'pneumatic actuators: visual' },
  deadband: { source: 'plan', confidence: 'estimate', note: 'visual' },
};

/** A released store is blended from where it hung into its flight path over this time, s. */
export const HANDOFF_BLEND = 0.25;
/** Larger differences than this between the hung and the released store are not blended, m. */
export const HANDOFF_MAX = 3;
