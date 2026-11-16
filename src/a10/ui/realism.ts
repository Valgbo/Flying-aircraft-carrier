/**
 * The realism presets as the settings dialog explains them (PLAN_A10.md §2). The table is
 * derived from the very flags the simulation runs with (core/sim.ts realismFlags), so it cannot
 * drift from what a preset really does. Covered by tests/unit/a10/ui-realism.test.ts.
 */
import { realismFlags } from '../core/sim';
import type { RealismFlags, RealismPreset } from '../core/types';

export const REALISM_PRESETS: readonly RealismPreset[] = ['authentic', 'standard', 'relaxed'];

export const REALISM_INFO: Record<RealismPreset, { label: string; summary: string }> = {
  authentic: {
    label: 'Authentic',
    summary:
      'The real procedure and the real limits. Nothing is found, locked or forgiven for you.',
  },
  standard: {
    label: 'Standard',
    summary: 'Real weapons and switches, with target areas on the map and automatic trim.',
  },
  relaxed: {
    label: 'Relaxed',
    summary: 'Boxes on targets, a one-stage trigger, unlimited stores and no crashes.',
  },
};

/**
 * Interface aids outside the simulation that also follow the preset: kill confirmations come
 * up as messages only in Relaxed (in the aircraft you see the result, nobody tells you).
 */
export const KILL_MESSAGES: Record<RealismPreset, boolean> = {
  authentic: false,
  standard: false,
  relaxed: true,
};

export interface RealismRow {
  aid: string;
  values: Record<RealismPreset, string>;
}

const ROWS: readonly { aid: string; value: (f: RealismFlags, preset: RealismPreset) => string }[] =
  [
    {
      aid: 'Finding targets',
      value: (f) =>
        f.hudBoxes
          ? 'Boxes on the HUD'
          : f.mapMarkers
            ? 'Target areas marked on the map display'
            : 'Your eyes, the pod, smoke and dust',
    },
    {
      aid: 'Sensor lock',
      value: (f) =>
        f.snapLock
          ? 'Snaps to the nearest vehicle'
          : f.largeGate
            ? 'Manual, with a larger capture gate'
            : 'Manual slew and track',
    },
    {
      aid: 'Gun trigger',
      value: (f) =>
        f.twoStageTrigger ? 'Two stages, PAC on the first' : 'One stage, PAC always on',
    },
    { aid: 'Trim', value: (f) => (f.autoTrim ? 'Automatic' : 'Manual') },
    { aid: 'Ammunition and stores', value: (f) => (f.unlimitedAmmo ? 'Unlimited' : 'Real load') },
    { aid: 'Fuze arming, duds, fragment warnings', value: (f) => (f.fuzeEffects ? 'On' : 'Off') },
    {
      aid: 'Flying into the ground',
      value: (f) => (f.invulnerable ? 'The aircraft bounces off' : 'Ends the flight'),
    },
    { aid: 'Kill messages', value: (_f, preset) => (KILL_MESSAGES[preset] ? 'On' : 'Off') },
  ];

/** The comparison table: one row per aid, one value per preset. */
export function realismRows(
  flagsFor: (p: RealismPreset) => RealismFlags = realismFlags,
): RealismRow[] {
  const flags = REALISM_PRESETS.map((p) => [p, flagsFor(p)] as const);
  return ROWS.map((row) => {
    const values = {} as Record<RealismPreset, string>;
    for (const [p, f] of flags) values[p] = row.value(f, p);
    return { aid: row.aid, values };
  });
}
