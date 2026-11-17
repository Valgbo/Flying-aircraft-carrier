/**
 * Cockpit instruments (src/a10/view/cockpit/instruments.ts): the FlightGear properties the
 * cockpit model's animations read, filled from the simulation in FlightGear's units; simgear's
 * drum (textranslate step/scroll) semantics, checked on the rounds counter and the clock; the
 * lamp rules; and that every animation of the converted cockpit binds to a known value.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { quaternionFromAttitude } from '../../../src/a10/core/frames';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import { DEG, FT, KT, LB, NM } from '../../../src/a10/core/units';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { altimeterDrums } from '../../../src/a10/view/cockpit/altimeterCounter';
import {
  COCKPIT_PROPS,
  createCockpitLamps,
  createCockpitMemory,
  drumDigit,
  FG_PROPERTY,
  fillCockpitValues,
  lookupTable,
  NEEDLE_OVERRIDES,
  PROP,
  resetGMeter,
  stepScroll,
  textranslateShift,
  toggleRule,
} from '../../../src/a10/view/cockpit/instruments';

const metaFiles = import.meta.glob('../../../public/a10/models/a10-meta.json', {
  eager: true,
  import: 'default',
});
const meta = Object.values(metaFiles)[0] as {
  cockpit: {
    pivots: { node: string; drive: { input: string | null } }[];
    uvAnims: {
      node: string;
      property: string | null;
      factor: number;
      offset: number;
      step: number | null;
      scroll: number | null;
      table: [number, number][] | null;
    }[];
    toggles: { node: string }[];
  };
};

function sim(): Sim {
  const s = createSim({
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    seed: 3,
    start: { x: 0, z: 0, agl: 2000, heading: 0, speed: 130 },
  });
  return s;
}

function fill(s: Sim) {
  const values = new Float64Array(COCKPIT_PROPS.length);
  const lamps = createCockpitLamps();
  const mem = createCockpitMemory();
  fillCockpitValues(s, mem, 1 / 60, values, lamps);
  return { values, lamps, mem };
}

describe('simulation → FlightGear property values', () => {
  it('fills attitude, air data and g in FlightGear units', () => {
    const s = sim();
    const ac = s.aircraft;
    quaternionFromAttitude(40 * DEG, 12 * DEG, -30 * DEG, ac.orientation);
    ac.heading = 40 * DEG;
    ac.pitch = 12 * DEG;
    ac.bank = -30 * DEG;
    ac.ias = 250 * KT;
    ac.position.y = 8000 * FT;
    ac.verticalSpeed = (2000 * FT) / 60;
    ac.alpha = 6 * DEG;
    ac.gLoad = 3.5;
    const { values } = fill(s);
    expect(values[PROP.headingDeg]).toBeCloseTo(40, 6);
    expect(values[PROP.pitchDeg]).toBeCloseTo(12, 6);
    expect(values[PROP.rollDeg]).toBeCloseTo(-30, 6);
    expect(values[PROP.iasKt]).toBeCloseTo(250, 3);
    expect(values[PROP.altitudeFt]).toBeCloseTo(8000, 3);
    expect(values[PROP.vsFpm]).toBeCloseTo(2000, 3);
    expect(values[PROP.alphaDeg]).toBeCloseTo(6, 6);
    expect(values[PROP.g]).toBeCloseTo(3.5, 9);
    expect(values[PROP.gMax]).toBeCloseTo(3.5, 9);
    expect(values[PROP.gMin]).toBeCloseTo(1, 9);
  });

  it('keeps the accelerometer max/min markers until reset', () => {
    const s = sim();
    const values = new Float64Array(COCKPIT_PROPS.length);
    const lamps = createCockpitLamps();
    const mem = createCockpitMemory();
    for (const g of [1, 4.2, 2, -1.5, 1]) {
      s.aircraft.gLoad = g;
      fillCockpitValues(s, mem, 1 / 60, values, lamps);
    }
    expect(values[PROP.gMax]).toBeCloseTo(4.2, 9);
    expect(values[PROP.gMin]).toBeCloseTo(-1.5, 9);
    resetGMeter(mem, 1);
    fillCockpitValues(s, mem, 1 / 60, values, lamps);
    expect(values[PROP.gMax]).toBe(1);
    expect(values[PROP.gMin]).toBe(1);
  });

  it('fills engines, fuel, controls and switches', () => {
    const s = sim();
    const ac = s.aircraft;
    ac.engines[0].n1 = 0.82;
    ac.engines[1].n2 = 0.93;
    ac.engines[0].itt = 760;
    ac.engines[1].fuelFlow = (2400 * LB) / 3600;
    ac.fuel = 6000 * LB;
    s.input.throttle[0] = 0.7;
    s.input.pitch = 0.5;
    s.input.roll = -0.25;
    s.input.rudder = 0.4;
    ac.flapHandle = 2;
    ac.surfaces.flaps = 20 * DEG;
    ac.gearDown = true;
    s.avionics.masterArm = 'TRAIN';
    s.avionics.gunPac = 'GUNARM';
    s.avionics.masterMode = 'CCIP';
    s.gun.rounds = 987;
    const { values } = fill(s);
    expect(values[PROP.n1L]).toBeCloseTo(82, 6);
    expect(values[PROP.n2R]).toBeCloseTo(93, 6);
    expect(values[PROP.ittL]).toBe(760);
    expect(values[PROP.fuelFlowR]).toBeCloseTo(2400, 6);
    expect(values[PROP.fuelTotalLb]).toBeCloseTo(6000, 6);
    expect(values[PROP.fuelLeftLb] + values[PROP.fuelRightLb]).toBeCloseTo(6000, 6);
    expect(values[PROP.throttleL]).toBe(0.7);
    // FlightGear's stick: + forward; ours: + back
    expect(values[PROP.stickElevator]).toBe(-0.5);
    expect(values[PROP.stickAileron]).toBe(-0.25);
    expect(values[PROP.pedals]).toBe(0.4);
    expect(values[PROP.flapSetting]).toBe(2);
    expect(values[PROP.flapNorm]).toBeCloseTo(20 / 30, 9);
    expect(values[PROP.gearHandle]).toBe(1);
    expect(values[PROP.masterArmSwitch]).toBe(-1);
    expect(values[PROP.gunPacSwitch]).toBe(-1);
    expect(values[PROP.hudModeKnob]).toBe(2);
    expect(values[PROP.rounds]).toBe(987);
    // the core drives oil pressure and hydraulics
    expect(values[PROP.oilR]).toBeGreaterThan(40);
    expect(values[PROP.hydR]).toBeCloseTo(3000, 6);
  });

  it('points the HSI bearing and miles at the active steerpoint, and the clock at the time of day', () => {
    const s = sim();
    s.aircraft.position.set(0, 2000, 0);
    s.avionics.steerpoints.length = 0;
    // 10 nm due east
    s.avionics.steerpoints.push({ id: 1, name: 'T', position: new Vector3(10 * NM, 0, 0) });
    s.avionics.activeSteerpoint = 0;
    s.world.timeOfDay = 14.5 + 7 / 3600;
    const { values, lamps } = fill(s);
    expect(values[PROP.steerBearingDeg]).toBeCloseTo(90, 6);
    expect(values[PROP.steerDistanceNm]).toBeCloseTo(10, 6);
    expect(lamps.steerValid).toBe(true);
    expect(values[PROP.clockHour]).toBe(14);
    expect(values[PROP.clockMinute]).toBe(30);
    expect(values[PROP.clockSecond]).toBe(7);
  });
});

describe('FlightGear drum semantics (simgear textranslate)', () => {
  const rds = (node: string) => {
    const u = meta.cockpit.uvAnims.find((x) => x.node === node);
    if (!u) throw new Error(node);
    return u;
  };

  it('rolls the step like an odometer', () => {
    expect(stepScroll(1149, 10, 0.5)).toBe(1140);
    expect(stepScroll(1149.75, 10, 0.5)).toBeCloseTo(1145, 9);
    expect(stepScroll(1150, 10, 0.5)).toBe(1150);
    expect(stepScroll(7.3, null, null)).toBe(7.3);
    expect(stepScroll(-3, 10, 0)).toBe(-10);
  });

  it('shows 1150 rounds as 1 1 5 0 on the four drums, and 987 as 0 9 8 7', () => {
    const digits = (n: number) =>
      ['rds-rem-x1000', 'rds-rem-x100', 'rds-rem-x10', 'rds-rem-x1'].map((d) =>
        drumDigit(textranslateShift(rds(d), n)),
      );
    expect(digits(1150)).toEqual([1, 1, 5, 0]);
    expect(digits(987)).toEqual([0, 9, 8, 7]);
    expect(digits(0)).toEqual([0, 0, 0, 0]);
  });

  it('shows the clock as hh:mm:ss on the six digits', () => {
    const d = (node: string, v: number) => {
      const u = meta.cockpit.uvAnims.find((x) => x.node === node);
      if (!u) throw new Error(node);
      return drumDigit(textranslateShift(u, v));
    };
    expect([d('h10', 14), d('h1', 14), d('m10', 37), d('m1', 37), d('s10', 5), d('s1', 5)]).toEqual(
      [1, 4, 3, 7, 0, 5],
    );
  });

  it('applies the offset before the factor', () => {
    expect(
      textranslateShift({ factor: 0.01, offset: -10, step: 10, scroll: 0.5, table: null }, 120),
    ).toBeCloseTo(1.1, 9);
  });
});

describe('the altimeter counter', () => {
  it('shows 10,000 / 1,000 / 100 ft drums, rolling on like an odometer', () => {
    const d = new Float64Array(3);
    altimeterDrums(8350, d);
    expect(Math.floor(d[0])).toBe(0);
    expect(Math.floor(d[1])).toBe(8);
    expect(d[2]).toBeCloseTo(3.5, 9);
    altimeterDrums(12400, d);
    expect([Math.floor(d[0]), Math.floor(d[1]), Math.floor(d[2])]).toEqual([1, 2, 4]);
    // in the last 100 ft before 10,000 the upper drums roll together
    altimeterDrums(9950, d);
    expect(d[1]).toBeCloseTo(9.5, 6);
    expect(d[0]).toBeCloseTo(0.5, 6);
    altimeterDrums(-200, d);
    expect([...d]).toEqual([0, 0, 0]);
  });
});

describe('needles', () => {
  it('reads the ITT and oil pressure on their dials, not FlightGear thrust fractions', () => {
    const itt = NEEDLE_OVERRIDES.ittL;
    const oil = NEEDLE_OVERRIDES.oilL;
    if (!itt || !oil) throw new Error('missing overrides');
    const flat = (t: readonly [number, number][]) => t.flat();
    // FlightGear: 100 °C at 118°, 23.6° per 100 °C; 0 psi at 159°, 2.27° per psi
    expect(lookupTable(flat(itt), 100) / DEG).toBeCloseTo(118, 6);
    expect(lookupTable(flat(itt), 880) / DEG).toBeCloseTo(118 + 23.6 * 7.8, 6);
    expect(lookupTable(flat(oil), 0) / DEG).toBeCloseTo(159, 6);
    expect(lookupTable(flat(oil), 100) / DEG).toBeCloseTo(386, 6);
  });
});

describe('lamps', () => {
  it('lights GUN READY with Master Arm at ARM, the gun armed, rounds left and the gear up', () => {
    const s = sim();
    s.avionics.masterArm = 'ARM';
    s.avionics.gunPac = 'ARM';
    expect(fill(s).lamps.gunReady).toBe(true);
    s.avionics.gunPac = 'SAFE';
    expect(fill(s).lamps.gunReady).toBe(false);
    s.avionics.gunPac = 'GUNARM';
    s.gun.rounds = 0;
    expect(fill(s).lamps.gunReady).toBe(false);
    s.gun.rounds = 10;
    s.aircraft.gearDown = true;
    expect(fill(s).lamps.gunReady).toBe(false);
  });

  it('lights the AoA indexer only with the gear down, on speed at 8°', () => {
    const s = sim();
    s.aircraft.alpha = 8 * DEG;
    expect(fill(s).lamps.aoaIndexer).toBeNull();
    s.aircraft.gearDown = true;
    s.aircraft.gearPosition = 1;
    expect(fill(s).lamps.aoaIndexer).toBe(0);
    s.aircraft.alpha = 11 * DEG;
    expect(fill(s).lamps.aoaIndexer).toBe(2);
    s.aircraft.alpha = 4 * DEG;
    expect(fill(s).lamps.aoaIndexer).toBe(-2);
  });

  it('lights the station lamps of the selected profile in CCIP with Master Arm out of SAFE', () => {
    const s = sim();
    s.avionics.profiles = [
      {
        id: 'mk82',
        store: 'MK-82',
        mode: 'CCIP',
        release: 'SGL',
        rippleQty: 1,
        rippleSpacing: 0,
        fuze: 'NOSE',
        minAltitude: 300,
        armingTime: 4,
      },
    ];
    s.avionics.selectedProfile = 'mk82';
    s.stores.stations = [
      { station: 4, rack: null, stores: ['MK-82'] },
      { station: 8, rack: 'TER-9A', stores: ['MK-82', 'MK-82'] },
      { station: 3, rack: null, stores: ['AGM-65D'] },
    ];
    s.avionics.masterMode = 'CCIP';
    s.avionics.masterArm = 'SAFE';
    expect([...fill(s).lamps.stationCount]).toEqual(new Array(11).fill(0));
    s.avionics.masterArm = 'ARM';
    const count = fill(s).lamps.stationCount;
    expect(count[3]).toBe(1);
    expect(count[7]).toBe(2);
    expect(count[2]).toBe(0);
    const lamps = createCockpitLamps();
    lamps.stationCount.set(count);
    const v = new Float64Array(COCKPIT_PROPS.length);
    expect(toggleRule('s-7-0')?.(lamps, v)).toBe(true);
    expect(toggleRule('s-7-1')?.(lamps, v)).toBe(true);
    expect(toggleRule('s-7-2')?.(lamps, v)).toBe(false);
    expect(toggleRule('s-7-E')?.(lamps, v)).toBe(false);
  });

  it('powers the panel: OFF flags out of view, round counter drums lit', () => {
    const lamps = createCockpitLamps();
    const v = new Float64Array(COCKPIT_PROPS.length);
    expect(toggleRule('A-10-adi-off-flag')?.(lamps, v)).toBe(false);
    expect(toggleRule('A-10-HSI-off-flag')?.(lamps, v)).toBe(false);
    expect(toggleRule('rds-rem-x1')?.(lamps, v)).toBe(true);
    lamps.masterCaution = true;
    expect(toggleRule('master-caution-on')?.(lamps, v)).toBe(true);
    expect(toggleRule('some-unknown-node')).toBeNull();
  });
});

describe('the converted cockpit binds', () => {
  it('drives every animation the brief lists from a known value', () => {
    const driven = meta.cockpit.pivots.filter((p) => p.drive.input && FG_PROPERTY[p.drive.input]);
    const nodes = new Set(driven.map((p) => p.node));
    for (const n of [
      'sphere__pitch-deg',
      'sphere__roll-deg',
      'stdby-adi-drum__pitch-deg',
      'hsi__indicated-heading-deg',
      'A-10-asi-needle__indicated-speed-kt',
      'altimeter-needle__indicated-altitude-ft',
      'A-10-vsi-6kfpm-needle__indicated-speed-fpm',
      'A-10-AoA-gauge-needle__alpha-deg',
      'A-10-accel-needle__pilot-g',
      'needle-max__g-max',
      'needle-min__g-min',
      'needle-fan-l__n1',
      'needle-core-r__n2',
      'needle-temp-l__egt-degf',
      'needle-fuel-l__fuel-flow_pph',
      'needle-l__fuel-dsp-left',
      'master-arm-switch__master-arm-switch',
      'gun-rate-switch__selected',
      'stick-upper__elevator',
      'stick-upper__aileron',
      'CPT-L-pedal__rudder',
      'l-throttle__throttle',
      'flaps-lever__current-setting',
      'ld-gear-handle__ld-gear-handle-anim',
      'mode-selector__m-sel',
    ])
      expect(nodes.has(n), n).toBe(true);
    // every drum of the rounds counter, the clock and the fuel totaliser has a value
    for (const u of meta.cockpit.uvAnims.filter((x) =>
      /^(rds-rem|h1|h10|m1|m10|s1|s10|A-10-fuel-gauges-drum|drum-5)/.test(x.node),
    ))
      expect(u.property && FG_PROPERTY[u.property], u.node).toBeTruthy();
    // lamps the brief asks for have rules
    for (const n of ['master-caution-on', 'gun-ready', 'aoa-on-speed', 's-3-0', 'rds-rem-x10'])
      expect(
        meta.cockpit.toggles.some((t) => t.node === n),
        n,
      ).toBe(true);
  });
});
