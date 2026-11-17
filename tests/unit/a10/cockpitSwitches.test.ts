/**
 * The clickable cockpit's mapping table (src/a10/view/cockpit/switches.ts): every required
 * control exists, sits on a part of the model or on a hotspot, and queues the right Command
 * with explicit values for left and right clicks.
 */
import { describe, expect, it } from 'vitest';
import type { Command } from '../../../src/a10/core/types';
import {
  ALTITUDE_ALERT_STEPS_FT,
  COCKPIT_CONTROLS,
  commandForControl,
  controlStateText,
  createSwitchState,
  readSwitchState,
  stepAltitudeAlert,
  type CockpitControlId,
  type CockpitSwitchState,
} from '../../../src/a10/view/cockpit/switches';
import { HOTSPOTS } from '../../../src/a10/view/cockpit/hotspots';

const FT = 0.3048;
const metaFiles = import.meta.glob('../../../public/a10/models/a10-meta.json', {
  eager: true,
  import: 'default',
});
const meta = Object.values(metaFiles)[0] as {
  pick: { file: string; node: string; frame: string }[];
  cockpit: { pivots: { node: string }[] };
};

function state(patch: Partial<CockpitSwitchState> = {}): CockpitSwitchState {
  return { ...createSwitchState(), ...patch };
}

const LEFT = 0;
const RIGHT = 2;

describe('cockpit controls table', () => {
  it('has every control the brief asks for, once', () => {
    const ids = COCKPIT_CONTROLS.map((c) => c.id);
    for (const id of [
      'masterArm',
      'gunPac',
      'laserArm',
      'tgpPower',
      'altSource',
      'masterMode',
      'flaps',
      'gear',
      'autopilot',
      'altitudeAlert',
    ] as CockpitControlId[])
      expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('places model controls on FlightGear pick targets or moving parts that exist', () => {
    for (const c of COCKPIT_CONTROLS) {
      if (c.target.kind === 'pick') {
        const node = c.target.node;
        expect(meta.pick.some((p) => p.file === 'cockpit' && p.node === node), node).toBe(true);
      } else if (c.target.kind === 'mesh') {
        const node = c.target.node;
        expect(meta.cockpit.pivots.some((p) => p.node === node), node).toBe(true);
      }
    }
  });

  it('gives every hotspot control a switch on the A-10C box, and the box only those', () => {
    const hot = COCKPIT_CONTROLS.filter((c) => c.target.kind === 'hotspot').map((c) => c.id);
    expect(HOTSPOTS.map((h) => h.id).sort()).toEqual([...hot].sort());
    // one switch per cell of the 3 × 2 face
    const cells = new Set(HOTSPOTS.map((h) => `${h.col},${h.row}`));
    expect(cells.size).toBe(HOTSPOTS.length);
    for (const h of HOTSPOTS) {
      expect(h.col).toBeGreaterThanOrEqual(0);
      expect(h.col).toBeLessThan(3);
      expect(h.row === 0 || h.row === 1).toBe(true);
    }
  });
});

describe('commands for clicks', () => {
  it('Master Arm: left toggles ARM / SAFE, right toggles TRAIN / SAFE', () => {
    expect(commandForControl('masterArm', LEFT, state({ masterArm: 'SAFE' }))).toEqual({
      type: 'masterArm',
      value: 'ARM',
    });
    expect(commandForControl('masterArm', LEFT, state({ masterArm: 'ARM' }))).toEqual({
      type: 'masterArm',
      value: 'SAFE',
    });
    expect(commandForControl('masterArm', LEFT, state({ masterArm: 'TRAIN' }))).toEqual({
      type: 'masterArm',
      value: 'ARM',
    });
    expect(commandForControl('masterArm', RIGHT, state({ masterArm: 'SAFE' }))).toEqual({
      type: 'masterArm',
      value: 'TRAIN',
    });
    expect(commandForControl('masterArm', RIGHT, state({ masterArm: 'TRAIN' }))).toEqual({
      type: 'masterArm',
      value: 'SAFE',
    });
  });

  it('GUN/PAC steps SAFE → GUNARM → ARM → SAFE (right click backwards)', () => {
    const order = ['SAFE', 'GUNARM', 'ARM'] as const;
    order.forEach((cur, i) => {
      expect(commandForControl('gunPac', LEFT, state({ gunPac: cur }))).toEqual({
        type: 'gunPac',
        value: order[(i + 1) % 3],
      });
      expect(commandForControl('gunPac', RIGHT, state({ gunPac: cur }))).toEqual({
        type: 'gunPac',
        value: order[(i + 2) % 3],
      });
    });
  });

  it('laser arm, TGP power and the altitude source', () => {
    expect(commandForControl('laserArm', LEFT, state({ laserArm: 'SAFE' }))).toEqual({
      type: 'laserArm',
      value: 'ARM',
    });
    expect(commandForControl('laserArm', RIGHT, state({ laserArm: 'ARM' }))).toEqual({
      type: 'laserArm',
      value: 'TRAIN',
    });
    expect(commandForControl('tgpPower', LEFT, state({ tgpPower: false }))).toEqual({
      type: 'tgpPower',
      value: true,
    });
    expect(commandForControl('tgpPower', RIGHT, state({ tgpPower: true }))).toEqual({
      type: 'tgpPower',
      value: false,
    });
    expect(commandForControl('altSource', LEFT, state({ altSource: 'BARO' }))).toEqual({
      type: 'altSource',
      value: 'DELTA',
    });
    expect(commandForControl('altSource', LEFT, state({ altSource: 'RADAR' }))).toEqual({
      type: 'altSource',
      value: 'BARO',
    });
    expect(commandForControl('altSource', RIGHT, state({ altSource: 'BARO' }))).toEqual({
      type: 'altSource',
      value: 'RADAR',
    });
  });

  it('master mode: left = next (as the key), right = the previous mode explicitly', () => {
    expect(commandForControl('masterMode', LEFT, state({ masterMode: 'NAV' }))).toEqual({
      type: 'masterMode',
      value: 'next',
    });
    expect(commandForControl('masterMode', RIGHT, state({ masterMode: 'NAV' }))).toEqual({
      type: 'masterMode',
      value: 'CCRP',
    });
    expect(commandForControl('masterMode', RIGHT, state({ masterMode: 'CCIP' }))).toEqual({
      type: 'masterMode',
      value: 'GUNS',
    });
  });

  it('flap lever: left one notch down and from DN back to UP, right one notch up', () => {
    const left = [0, 1, 2].map((h) => commandForControl('flaps', LEFT, state({ flapHandle: h })));
    expect(left).toEqual([
      { type: 'flaps', value: 1 },
      { type: 'flaps', value: 2 },
      { type: 'flaps', value: 0 },
    ]);
    expect(commandForControl('flaps', RIGHT, state({ flapHandle: 2 }))).toEqual({
      type: 'flaps',
      value: 'up',
    });
  });

  it('gear handle, autopilot and the g-meter', () => {
    expect(commandForControl('gear', LEFT, state())).toEqual({ type: 'gear', value: 'toggle' });
    expect(commandForControl('autopilot', LEFT, state())).toEqual({
      type: 'autopilot',
      action: 'toggle',
    });
    expect(commandForControl('autopilot', RIGHT, state())).toEqual({
      type: 'autopilot',
      action: 'disengage',
    });
    expect(commandForControl('autopilotMode', LEFT, state())).toEqual({
      type: 'autopilot',
      action: 'mode',
    });
    // the g-meter reset is the cockpit's own, no command
    expect(commandForControl('gMeterReset', LEFT, state())).toBeNull();
  });

  it('altitude alert steps off, 200, 500, 1,000, 1,500, 2,000 ft and wraps', () => {
    expect([...ALTITUDE_ALERT_STEPS_FT]).toEqual([0, 200, 500, 1000, 1500, 2000]);
    let m = 0;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const c = commandForControl('altitudeAlert', LEFT, state({ altitudeAlert: m })) as Extract<
        Command,
        { type: 'altitudeAlert' }
      >;
      m = c.value;
      seen.push(Math.round(m / FT));
    }
    expect(seen).toEqual([200, 500, 1000, 1500, 2000, 0]);
    expect(stepAltitudeAlert(0, -1)).toBeCloseTo(2000 * FT, 6);
    expect(stepAltitudeAlert(500 * FT, -1)).toBeCloseTo(200 * FT, 6);
    expect(stepAltitudeAlert(200 * FT, -1)).toBe(0);
  });

  it('every control yields a command or is cockpit-local, for both buttons', () => {
    for (const c of COCKPIT_CONTROLS)
      for (const b of [LEFT, RIGHT]) {
        const cmd = commandForControl(c.id, b, state());
        if (c.id === 'gMeterReset') expect(cmd).toBeNull();
        else expect(cmd, c.id).not.toBeNull();
      }
  });
});

describe('switch state', () => {
  it('reads the simulation and labels the hover text', () => {
    const s = readSwitchState(
      {
        avionics: {
          masterArm: 'ARM',
          gunPac: 'GUNARM',
          laserArm: 'TRAIN',
          tgpPower: true,
          altSource: 'RADAR',
          masterMode: 'CCIP',
        },
        aircraft: {
          flapHandle: 1,
          gearDown: true,
          autopilot: { engaged: true, mode: 'ALT_HDG' },
          altitudeAlert: 500 * FT,
        },
      },
      createSwitchState(),
    );
    expect(controlStateText('masterArm', s)).toBe('ARM');
    expect(controlStateText('gunPac', s)).toBe('GUNARM');
    expect(controlStateText('laserArm', s)).toBe('TRAIN');
    expect(controlStateText('tgpPower', s)).toBe('ON');
    expect(controlStateText('altSource', s)).toBe('RADAR');
    expect(controlStateText('masterMode', s)).toBe('CCIP');
    expect(controlStateText('flaps', s)).toBe('MVR');
    expect(controlStateText('gear', s)).toBe('DOWN');
    expect(controlStateText('autopilot', s)).toBe('ENGAGED');
    expect(controlStateText('autopilotMode', s)).toBe('ALT/HDG');
    expect(controlStateText('altitudeAlert', s)).toBe('500 FT');
  });
});
