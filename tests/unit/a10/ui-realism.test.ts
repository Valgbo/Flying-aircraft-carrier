import { describe, expect, it } from 'vitest';
import { realismFlags } from '../../../src/a10/core/sim';
import { KILL_MESSAGES, REALISM_PRESETS, realismRows } from '../../../src/a10/ui/realism';

/** PLAN_A10.md §2, the realism presets table, word for word. */
const PLAN_TABLE: Record<string, [string, string, string]> = {
  'Finding targets': [
    'Your eyes, the pod, smoke and dust',
    'Target areas marked on the map display',
    'Boxes on the HUD',
  ],
  'Sensor lock': [
    'Manual slew and track',
    'Manual, with a larger capture gate',
    'Snaps to the nearest vehicle',
  ],
  'Gun trigger': [
    'Two stages, PAC on the first',
    'Two stages, PAC on the first',
    'One stage, PAC always on',
  ],
  Trim: ['Manual', 'Automatic', 'Automatic'],
  'Ammunition and stores': ['Real load', 'Real load', 'Unlimited'],
  'Fuze arming, duds, fragment warnings': ['On', 'On', 'Off'],
  'Flying into the ground': ['Ends the flight', 'Ends the flight', 'The aircraft bounces off'],
};

describe('realism table', () => {
  it('derived from the simulation flags, it says what PLAN §2 says', () => {
    const rows = realismRows();
    for (const [aid, values] of Object.entries(PLAN_TABLE)) {
      const row = rows.find((r) => r.aid === aid);
      expect(row, aid).toBeDefined();
      expect(REALISM_PRESETS.map((p) => row!.values[p])).toEqual(values);
    }
  });

  it('follows the flags, not a copy of the table', () => {
    const rows = realismRows((p) => ({ ...realismFlags(p), autoTrim: false }));
    expect(rows.find((r) => r.aid === 'Trim')!.values.relaxed).toBe('Manual');
  });

  it('kill messages only in Relaxed', () => {
    expect(KILL_MESSAGES).toEqual({ authentic: false, standard: false, relaxed: true });
    const row = realismRows().find((r) => r.aid === 'Kill messages')!;
    expect(row.values).toEqual({ authentic: 'Off', standard: 'Off', relaxed: 'On' });
  });
});
