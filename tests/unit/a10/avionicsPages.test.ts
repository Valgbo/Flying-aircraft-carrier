/**
 * The A-10C display pages' option-select buttons (PLAN_A10.md §7 "Display pages", §12;
 * ARCHITECTURE §12.7: the OSB labels the displays and the cockpit's hover text come from the
 * avionics' OSB tables): every page's labels and actions, the DSMS profile editing round trips,
 * laser-code entry on the DSMS and TGP pages, selective jettison, the TGP latch and the Maverick
 * power the sensors module reads, the TAD scale and centre, STAT and MSG.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  buildDsmsView,
  createDsmsView,
  nextValue,
  OSB_TABLE,
  osbActive,
  osbBinding,
  osbLabel,
  osbValue,
  PAGE_SELECT_OSB,
  PROFILE_EDIT,
  RELEASE,
  stepFireControl,
  stepLaserDigit,
  TAD_RANGES_NM,
  UFC_ENTRY,
  scratchpadLaserCode,
  ufcKey,
} from '../../../src/a10/core/avionics';
import type { MfdPage, SensorRequest } from '../../../src/a10/core/avionics/types';
import type { MaverickSeekerState } from '../../../src/a10/core/sensors/types';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { createFlatTerrain } from '../../../src/a10/core/world';

const FT = 0.3048;

function makeSim(loadoutId = 'tankHunter'): Sim {
  return createSim({ terrain: createFlatTerrain(0), scenario: 'empty', loadoutId, seed: 2 });
}

/** Press OSB `n` on the left display showing `page` (the cockpit's click command). */
function press(sim: Sim, page: MfdPage, n: number, times = 1): SimEvent[] {
  sim.avionics.mfd.left = page;
  sim.avionics.sensorRequests.length = 0;
  sim.events.length = 0;
  for (let i = 0; i < times; i++) applyCommand(sim, { type: 'osb', display: 'L', button: n });
  return [...sim.events];
}

function labels(sim: Sim, page: MfdPage): Record<number, string> {
  sim.avionics.mfd.left = page;
  const out: Record<number, string> = {};
  for (let n = 1; n <= 20; n++) {
    const l = osbLabel(sim, 'L', n);
    if (l) out[n] = l;
  }
  return out;
}

function requests(sim: Sim): Omit<SensorRequest, 't'>[] {
  return sim.avionics.sensorRequests.map(({ t: _t, ...r }) => r);
}

function messages(ev: SimEvent[]): string[] {
  return ev.flatMap((e) => (e.type === 'message' ? [e.text] : []));
}

const PAGE_ROW = { 11: 'STAT', 12: 'DSMS', 13: 'MAV', 14: 'TGP', 15: 'TAD' };

describe('OSB labels of every page', () => {
  it('each page has its buttons and the page-select row; the cockpit and displays read the same table', () => {
    const sim = makeSim();
    expect(labels(sim, 'DSMS')).toEqual({
      1: 'SEL',
      2: 'JETT',
      3: 'CODE',
      4: 'INC',
      6: 'PROF+',
      7: 'PROF-',
      8: 'MODE',
      9: 'REL',
      10: 'QTY',
      16: 'MIN',
      17: 'ARM',
      18: 'DRAG',
      19: 'FUZE',
      20: 'SPC',
      ...PAGE_ROW,
    });
    expect(labels(sim, 'TGP')).toEqual({
      1: 'PIC',
      2: 'FOV',
      3: 'ZM+',
      4: 'ZM-',
      5: 'SLV',
      6: 'TRK',
      7: 'INR',
      8: 'LTCH',
      9: 'CODE',
      10: 'INC',
      ...PAGE_ROW,
    });
    expect(labels(sim, 'MAV')).toEqual({
      1: 'PWR',
      2: 'FOV',
      3: 'PIC',
      4: 'STEP',
      5: 'SLV',
      6: 'TRK',
      7: 'BRK',
      ...PAGE_ROW,
    });
    expect(labels(sim, 'TAD')).toEqual({
      1: 'RNG+',
      2: 'RNG-',
      3: 'CEN',
      6: 'STP+',
      7: 'STP-',
      ...PAGE_ROW,
    });
    expect(labels(sim, 'STAT')).toEqual({ 1: 'MSG', ...PAGE_ROW });
    expect(labels(sim, 'MSG')).toEqual({ 1: 'STAT', 2: 'CLR', ...PAGE_ROW });
    // The static table and the binding lookup agree with the live labels.
    for (const page of Object.keys(OSB_TABLE) as MfdPage[]) {
      for (let n = 1; n <= 20; n++) {
        const b = osbBinding(page, n);
        const own = OSB_TABLE[page][n];
        if (own) expect(b?.label).toBe(own.label);
        else expect(b?.label ?? '').toBe(PAGE_SELECT_OSB[n] ?? '');
      }
    }
    // The page-select button of the page shown is lit.
    sim.avionics.mfd.left = 'TGP';
    expect(osbActive(sim, 'L', 14)).toBe(true);
    expect(osbActive(sim, 'L', 15)).toBe(false);
  });

  it('every press clicks (osb switch event) and buttons without a function do nothing else', () => {
    const sim = makeSim();
    sim.avionics.mfd.left = 'DSMS';
    const snapshot = () =>
      JSON.stringify({
        ...sim.avionics,
        release: null,
        gun: null,
        lastSwitch: null,
        lastSwitchValue: null,
      });
    const before = snapshot();
    const ev = press(sim, 'DSMS', 5);
    expect(ev).toEqual([{ type: 'switch', t: sim.time, name: 'osb', value: 'L5' }]);
    expect(snapshot()).toBe(before);
    expect(sim.avionics.lastSwitch.name).toBe('osb');
  });
});

describe('DSMS: the selected profile’s settings', () => {
  it('MODE, REL, QTY, SPC, FUZE, ARM, MIN step through their values and come back (round trips)', () => {
    const sim = makeSim('rangeTraining');
    const av = sim.avionics;
    av.selectedProfile = 'MK82LD';
    const p = av.profiles.find((x) => x.id === 'MK82LD')!;
    const start = { ...p };
    const cycles: [number, number, () => unknown][] = [
      [8, 2, () => p.mode],
      [9, 4, () => p.release],
      [10, PROFILE_EDIT.rippleQty.length, () => p.rippleQty],
      [20, PROFILE_EDIT.rippleSpacing.length, () => p.rippleSpacing],
      [19, 3, () => p.fuze],
      [17, PROFILE_EDIT.armingTime.length, () => p.armingTime],
      [16, PROFILE_EDIT.minAltitude.length, () => p.minAltitude],
    ];
    const seen: Record<number, unknown[]> = {};
    for (const [osb, n, get] of cycles) {
      seen[osb] = [get()];
      for (let i = 0; i < n; i++) {
        press(sim, 'DSMS', osb);
        seen[osb].push(get());
      }
      // n presses: back where it started, every value in between different.
      expect(get()).toEqual(seen[osb][0]);
      expect(new Set(seen[osb].slice(0, n)).size).toBe(n);
    }
    expect({ ...p }).toEqual(start);
    expect(seen[9]).toEqual(['SGL', 'PRS', 'RIP_SGL', 'RIP_PRS', 'SGL']);
    expect(seen[19]).toEqual(['NOSE', 'TAIL', 'N/T', 'NOSE']);
    // The values the display prints under the labels.
    av.mfd.left = 'DSMS';
    p.release = 'RIP_PRS';
    p.rippleSpacing = 75 * FT;
    p.minAltitude = 1500 * FT;
    p.armingTime = 4;
    expect(osbValue(sim, 'L', 9)).toBe('RIP PRS');
    expect(osbValue(sim, 'L', 20)).toBe('75');
    expect(osbValue(sim, 'L', 16)).toBe('1500');
    expect(osbValue(sim, 'L', 17)).toBe('4.0');
    expect(osbValue(sim, 'L', 6)).toBe('MK82LD');
    // The stores page data shows the edits.
    const view = buildDsmsView(sim, createDsmsView());
    const v = view.profiles.find((x) => x.id === 'MK82LD')!;
    expect(v.release).toBe('RIP_PRS');
    expect(v.minAltitude).toBeCloseTo(1500 * FT, 9);
    expect(v.modes).toEqual(['CCIP', 'CCRP']);
  });

  it('MODE in CCIP/CCRP brings the master mode along; stores without a choice refuse with a message', () => {
    const sim = makeSim('tankHunter');
    const av = sim.avionics;
    av.selectedProfile = 'MK82LD';
    av.masterMode = 'CCIP';
    av.profiles.find((x) => x.id === 'MK82LD')!.mode = 'CCIP';
    press(sim, 'DSMS', 8);
    expect(av.profiles.find((x) => x.id === 'MK82LD')!.mode).toBe('CCRP');
    expect(av.masterMode).toBe('CCRP');
    av.selectedProfile = 'M156-131';
    expect(messages(press(sim, 'DSMS', 8))).toEqual(['M156-131: CCIP ONLY']);
    av.selectedProfile = 'AGM65D';
    expect(messages(press(sim, 'DSMS', 8))).toEqual(['AGM65D: NO MODE']);
  });

  it('DRAG toggles low / high drag only for the Mk-82 AIR', () => {
    const sim = makeSim('heavyBombs');
    const av = sim.avionics;
    const air = av.profiles.find((x) => x.store === 'MK-82AIR')!;
    expect(air.drag).toBe('HD');
    av.selectedProfile = air.id;
    press(sim, 'DSMS', 18);
    expect(air.drag).toBe('LD');
    av.mfd.left = 'DSMS';
    expect(osbValue(sim, 'L', 18)).toBe('LD');
    press(sim, 'DSMS', 18);
    expect(air.drag).toBe('HD');
    const ld = av.profiles.find((x) => x.store === 'MK-82')!;
    av.selectedProfile = ld.id;
    expect(messages(press(sim, 'DSMS', 18))).toEqual(['MK82LD: NO HIGH DRAG']);
    expect(ld.drag).toBe('LD');
  });

  it('laser code of a GBU-12 profile: CODE moves the cursor digit, INC steps it (1–2, then 1–8)', () => {
    const sim = makeSim('tankHunter');
    const av = sim.avionics;
    av.selectedProfile = 'GBU12';
    const p = av.profiles.find((x) => x.id === 'GBU12')!;
    expect(p.laserCode).toBe(RELEASE.laserCode);
    av.mfd.left = 'DSMS';
    expect(osbValue(sim, 'L', 3)).toBe('1688');
    // Units digit (cursor 3): 8 → 1.
    press(sim, 'DSMS', 3, 3);
    expect(av.pages.dsmsCodeDigit).toBe(3);
    press(sim, 'DSMS', 4);
    expect(p.laserCode).toBe(1681);
    // Hundreds (cursor 1): 6 → 7 → 8 → 1.
    press(sim, 'DSMS', 3, 2);
    expect(av.pages.dsmsCodeDigit).toBe(1);
    press(sim, 'DSMS', 4, 3);
    expect(p.laserCode).toBe(1181);
    // Thousands (cursor 0): 1 → 2 → 1.
    press(sim, 'DSMS', 3, 3);
    press(sim, 'DSMS', 4);
    expect(p.laserCode).toBe(2181);
    press(sim, 'DSMS', 4);
    expect(p.laserCode).toBe(1181);
    // The DSMS view and the release request carry it.
    expect(buildDsmsView(sim).profiles.find((x) => x.id === 'GBU12')!.laserCode).toBe(1181);
    // Not a laser bomb: refused.
    av.selectedProfile = 'MK82LD';
    expect(messages(press(sim, 'DSMS', 4))).toEqual(['MK82LD: NO LASER CODE']);
    expect(osbValue(sim, 'L', 3)).toBe('');
  });

  it('laser code digits wrap and snap into the allowed range', () => {
    expect(stepLaserDigit(1688, 3)).toBe(1681);
    expect(stepLaserDigit(1688, 2)).toBe(1618);
    expect(stepLaserDigit(1688, 0)).toBe(2688);
    expect(stepLaserDigit(2688, 0)).toBe(1688);
    // An invalid code (a 9 and a 0) snaps into 1–8 on the other digits.
    expect(stepLaserDigit(1090, 3)).toBe(1181);
    expect(nextValue([1, 2, 4], 3)).toBe(4);
    expect(nextValue([1, 2, 4], 4)).toBe(1);
  });

  it('selective jettison: SEL steps through the stations that can be dropped, JETT needs Master Arm ARM', () => {
    const sim = makeSim('tankHunter');
    const av = sim.avionics;
    const sel: number[] = [];
    for (let i = 0; i < 9; i++) {
      press(sim, 'DSMS', 1);
      sel.push(av.pages.jettisonStation);
    }
    // ECM pod (1), TGP (10) and the AIM-9 rails (11) stay: never offered.
    expect(sel).toEqual([2, 3, 4, 5, 7, 8, 9, 0, 2]);
    press(sim, 'DSMS', 1, 2);
    expect(av.pages.jettisonStation).toBe(4);
    av.mfd.left = 'DSMS';
    expect(osbValue(sim, 'L', 1)).toBe('STA 4');
    expect(messages(press(sim, 'DSMS', 2))).toEqual(['JETT: MASTER ARM NOT ARM']);
    expect(sim.stores.stations[3].stores).toEqual(['GBU-12']);
    av.masterArm = 'ARM';
    const ev = press(sim, 'DSMS', 2);
    expect(sim.stores.stations[3].stores).toEqual([]);
    expect(ev.some((e) => e.type === 'switch' && e.name === 'jettison' && e.value === '4')).toBe(
      true,
    );
    expect(av.pages.jettisonStation).toBe(0);
    // Nothing chosen: a message.
    expect(messages(press(sim, 'DSMS', 2))).toEqual(['JETT: SELECT A STATION']);
    const view = buildDsmsView(sim);
    expect(view.stations[3].jettisonable).toBe(false);
    expect(view.stations[9].jettisonable).toBe(false);
  });
});

describe('TGP, MAV, TAD, STAT and MSG pages', () => {
  it('TGP: picture, FOV, zoom, slave, track go to the sensors module with the HOTAS meanings', () => {
    const sim = makeSim();
    const expected: [number, Omit<SensorRequest, 't'>][] = [
      [1, { sensor: 'TGP', action: 'picture', dir: '', long: false, value: 0 }],
      [2, { sensor: 'TGP', action: 'chinaHat', dir: 'fwd', long: false, value: 0 }],
      [3, { sensor: 'TGP', action: 'zoom', dir: '', long: false, value: 1 }],
      [4, { sensor: 'TGP', action: 'zoom', dir: '', long: false, value: -1 }],
      [5, { sensor: 'TGP', action: 'slaveSpi', dir: 'aft', long: true, value: 0 }],
      [6, { sensor: 'TGP', action: 'tms', dir: 'up', long: false, value: 0 }],
      [7, { sensor: 'TGP', action: 'tms', dir: 'down', long: false, value: 0 }],
    ];
    for (const [n, req] of expected) {
      press(sim, 'TGP', n);
      expect(requests(sim), `OSB ${n}`).toEqual([req]);
    }
    sim.avionics.mfd.left = 'TGP';
    expect(osbValue(sim, 'L', 1)).toBe(sim.sensors.tgp.picture);
    expect(osbValue(sim, 'L', 2)).toBe(sim.sensors.tgp.fovSetting === 'WIDE' ? 'WIDE' : 'NARO');
    expect(osbValue(sim, 'L', 6)).toBe(sim.sensors.tgp.mode);
  });

  it('TGP: LTCH latches the laser (the sensors module reads laserLatch); CODE / INC set the pod code', () => {
    const sim = makeSim();
    const av = sim.avionics;
    expect(av.laserLatch).toBe(false);
    const ev = press(sim, 'TGP', 8);
    expect(av.laserLatch).toBe(true);
    expect(ev.some((e) => e.type === 'switch' && e.name === 'laserLatch' && e.value === 'ON')).toBe(
      true,
    );
    expect(osbActive(sim, 'L', 8)).toBe(true);
    expect(osbValue(sim, 'L', 8)).toBe('ON');
    press(sim, 'TGP', 8);
    expect(av.laserLatch).toBe(false);
    expect(av.laserCode).toBe(1688);
    press(sim, 'TGP', 9, 2);
    press(sim, 'TGP', 10);
    expect(av.laserCode).toBe(1618);
    expect(osbValue(sim, 'L', 9)).toBe('1618');
    // The pod code and a bomb's code are separate (they must match for the bomb to guide).
    expect(av.profiles.find((x) => x.id === 'GBU12')!.laserCode).toBe(1688);
  });

  it('MAV: PWR switches the seekers’ power (the sensors module reads mavPower); FOV, PIC, SLV, TRK, BRK requests; STEP', () => {
    const sim = makeSim();
    const av = sim.avionics;
    expect(av.mavPower).toBe(true);
    press(sim, 'MAV', 1);
    expect(av.mavPower).toBe(false);
    expect(osbValue(sim, 'L', 1)).toBe('OFF');
    expect(osbActive(sim, 'L', 1)).toBe(false);
    press(sim, 'MAV', 1);
    expect(av.mavPower).toBe(true);
    const expected: [number, Omit<SensorRequest, 't'>][] = [
      [2, { sensor: 'MAV', action: 'chinaHat', dir: 'fwd', long: false, value: 0 }],
      [3, { sensor: 'MAV', action: 'picture', dir: '', long: false, value: 0 }],
      [5, { sensor: 'MAV', action: 'slaveSpi', dir: '', long: true, value: 0 }],
      [6, { sensor: 'MAV', action: 'tms', dir: 'up', long: false, value: 0 }],
      [7, { sensor: 'MAV', action: 'tms', dir: 'down', long: false, value: 0 }],
    ];
    for (const [n, req] of expected) {
      press(sim, 'MAV', n);
      expect(requests(sim), `OSB ${n}`).toEqual([req]);
    }
    // STEP: the Maverick profiles in turn (D, H, D).
    av.selectedProfile = 'MK82LD';
    press(sim, 'MAV', 4);
    expect(av.selectedProfile).toBe('AGM65H');
    press(sim, 'MAV', 4);
    expect(av.selectedProfile).toBe('AGM65D');
    press(sim, 'MAV', 4);
    expect(av.selectedProfile).toBe('AGM65H');
  });

  it('TAD: range steps and clamps, centre own ship / SPI, steerpoints', () => {
    const sim = makeSim();
    const av = sim.avionics;
    expect(av.pages.tadRange).toBe(20);
    press(sim, 'TAD', 1);
    expect(av.pages.tadRange).toBe(40);
    press(sim, 'TAD', 1, 5);
    expect(av.pages.tadRange).toBe(TAD_RANGES_NM[TAD_RANGES_NM.length - 1]);
    press(sim, 'TAD', 2, 10);
    expect(av.pages.tadRange).toBe(TAD_RANGES_NM[0]);
    expect(osbValue(sim, 'L', 1)).toBe('5');
    press(sim, 'TAD', 3);
    expect(av.pages.tadCenter).toBe('SPI');
    press(sim, 'TAD', 3);
    expect(av.pages.tadCenter).toBe('OWN');
    const n = av.steerpoints.length;
    expect(n).toBeGreaterThan(1);
    const start = av.activeSteerpoint;
    press(sim, 'TAD', 6);
    expect(av.activeSteerpoint).toBe((start + 1) % n);
    expect(osbValue(sim, 'L', 6)).toBe(av.steerpoints[av.activeSteerpoint].name);
    press(sim, 'TAD', 7);
    expect(av.activeSteerpoint).toBe(start);
  });

  it('STAT ↔ MSG, and CLR clears the messages before now', () => {
    const sim = makeSim();
    const av = sim.avionics;
    press(sim, 'STAT', 1);
    expect(av.mfd.left).toBe('MSG');
    sim.time = 12.5;
    press(sim, 'MSG', 2);
    expect(av.pages.msgClearTime).toBe(12.5);
    press(sim, 'MSG', 1);
    expect(av.mfd.left).toBe('STAT');
  });
});

describe('SPI from the sensors (PLAN §7 "SOI and SPI")', () => {
  it('MAV page as SOI: TMS forward long makes the lock point the SPI, which follows the lock and stays when it breaks', () => {
    const sim = makeSim();
    const av = sim.avionics;
    const seeker = {
      station: 3,
      powered: true,
      align: 0,
      locked: true,
      lockedVehicle: 4,
      lockPoint: new Vector3(50, 0, -7000),
      inZone: true,
    } as unknown as MaverickSeekerState;
    sim.sensors.mavericks = [seeker];
    sim.sensors.selectedMaverick = 0;
    applyCommand(sim, { type: 'mfdPage', display: 'R', page: 'MAV' });
    applyCommand(sim, { type: 'coolie', dir: 'right', long: true });
    expect(av.soi).toBe('RMFD');
    sim.events.length = 0;
    applyCommand(sim, { type: 'tms', dir: 'up', long: true });
    expect(av.spi.source).toBe('MAV');
    expect(av.spi.position.toArray()).toEqual([50, 0, -7000]);
    expect(
      sim.events.some((e) => e.type === 'switch' && e.name === 'spi' && e.value === 'MAV'),
    ).toBe(true);
    // The seeker tracks a moving vehicle: the SPI follows.
    seeker.lockPoint.set(60, 0, -7010);
    stepFireControl(sim, 1 / 120);
    expect(av.spi.position.toArray()).toEqual([60, 0, -7010]);
    // Lock broken: the SPI stays where it was.
    seeker.locked = false;
    seeker.lockPoint.set(0, 0, 0);
    stepFireControl(sim, 1 / 120);
    expect(av.spi.position.toArray()).toEqual([60, 0, -7010]);
    // TMS aft long: back to the steerpoint.
    applyCommand(sim, { type: 'tms', dir: 'down', long: true });
    expect(av.spi.source).toBe('STPT');
  });
});

describe('UFC scratchpad: laser codes typed on the up-front controller', () => {
  function type(sim: Sim, keys: string): void {
    for (const k of keys) ufcKey(sim, k);
  }

  it('digits fill the scratchpad, CLR empties it, every key clicks; STEER steps the steerpoint', () => {
    const sim = makeSim();
    const av = sim.avionics;
    sim.events.length = 0;
    type(sim, '1511');
    expect(av.pages.scratchpad).toBe('1511');
    expect(sim.events.filter((e) => e.type === 'switch' && e.name === 'ufc')).toHaveLength(4);
    ufcKey(sim, 'CLR');
    expect(av.pages.scratchpad).toBe('');
    type(sim, '1234567890');
    expect(av.pages.scratchpad).toBe('1234567890'.slice(0, UFC_ENTRY.scratchpadMax));
    ufcKey(sim, 'CLR');
    // Keys without a function change nothing.
    ufcKey(sim, 'ENT');
    ufcKey(sim, 'FUNC');
    expect(av.pages.scratchpad).toBe('');
    const n = av.steerpoints.length;
    expect(n).toBeGreaterThan(1);
    const before = av.activeSteerpoint;
    ufcKey(sim, 'STEER_UP');
    expect(av.activeSteerpoint).toBe((before + 1) % n);
    ufcKey(sim, 'STEER_DN');
    expect(av.activeSteerpoint).toBe(before);
  });

  it('only four-digit PRF codes are laser codes (first digit 1–2, the others 1–8)', () => {
    expect(scratchpadLaserCode('1688')).toBe(1688);
    expect(scratchpadLaserCode('2111')).toBe(2111);
    expect(scratchpadLaserCode('3111')).toBe(0);
    expect(scratchpadLaserCode('1911')).toBe(0);
    expect(scratchpadLaserCode('1680')).toBe(0);
    expect(scratchpadLaserCode('168')).toBe(0);
    expect(scratchpadLaserCode('16881')).toBe(0);
    expect(scratchpadLaserCode('')).toBe(0);
  });

  it('CODE enters a typed code into the GBU-12 profile (DSMS) or the pod (TGP); an invalid code is refused', () => {
    const sim = makeSim('tankHunter');
    const av = sim.avionics;
    av.selectedProfile = 'GBU12';
    const p = av.profiles.find((x) => x.id === 'GBU12')!;
    // DSMS: the profile's code; the cursor digit does not move.
    type(sim, '1511');
    let ev = press(sim, 'DSMS', 3);
    expect(p.laserCode).toBe(1511);
    expect(av.pages.scratchpad).toBe('');
    expect(av.pages.dsmsCodeDigit).toBe(0);
    expect(ev.some((e) => e.type === 'switch' && e.name === 'profile')).toBe(true);
    expect(osbValue(sim, 'L', 3)).toBe('1511');
    // TGP: the pod's code, separate from the bomb's.
    type(sim, '1742');
    ev = press(sim, 'TGP', 9);
    expect(av.laserCode).toBe(1742);
    expect(p.laserCode).toBe(1511);
    expect(
      ev.some((e) => e.type === 'switch' && e.name === 'laserCode' && e.value === '1742'),
    ).toBe(true);
    expect(av.pages.tgpCodeDigit).toBe(0);
    // Invalid: a message, nothing changes, the scratchpad stays for the pilot to clear.
    type(sim, '1911');
    ev = press(sim, 'TGP', 9);
    expect(messages(ev)).toEqual(['INVALID CODE 1911']);
    expect(av.laserCode).toBe(1742);
    expect(av.pages.scratchpad).toBe('1911');
    ev = press(sim, 'DSMS', 3);
    expect(messages(ev)).toEqual(['INVALID CODE 1911']);
    expect(p.laserCode).toBe(1511);
    ufcKey(sim, 'CLR');
    // Empty scratchpad: CODE moves the cursor digit again.
    press(sim, 'TGP', 9);
    expect(av.pages.tgpCodeDigit).toBe(1);
    // A store without a laser code keeps the scratchpad (and says so).
    type(sim, '1688');
    av.selectedProfile = 'MK82LD';
    expect(messages(press(sim, 'DSMS', 3))).toEqual(['MK82LD: NO LASER CODE']);
    expect(av.pages.scratchpad).toBe('1688');
  });
});
