/**
 * Cockpit instruments: what every FlightGear property read by the cockpit model's animations
 * means in this simulation, and the driver that poses needles, drums, switches and lamps from
 * it every frame. OWNED BY THE COCKPIT MODULE.
 *
 * The converted cockpit (public/a10/models/a10-cockpit.glb) keeps FlightGear's animations as
 * data in a10-meta.json: pivots (rotate/translate about a hinge, by a FlightGear property, with
 * a gain or a table already in radians or metres), toggles (select animations) and uvAnims
 * (textranslate: drum counters and clock digits). Here:
 *
 *   1. `fillCockpitValues` turns the simulation into the FlightGear property values the
 *      animations expect, in FlightGear's units (degrees, knots, feet, percent, pounds…), into
 *      one Float64Array indexed by COCKPIT_PROPS — pure and allocation-free;
 *   2. `createInstrumentDriver` binds every pivot, drum and lamp of a cockpit model to those
 *      values once, and `update` poses them every frame without allocating.
 *
 * Properties that have no meaning here (radios, APU, ILS…) read 0, which is FlightGear's own
 * default, so those instruments rest exactly as FlightGear shows them on a cold panel.
 */
import { Mesh, Object3D, Vector3, type Material, type MeshStandardMaterial } from 'three';
import type { PivotMeta, A10Meta } from '../../assets/meta';
import { headingOf } from '../../core/frames';
import type { Sim } from '../../core/types';
import { DEG, FT, LB, NM } from '../../core/units';

// ---------------------------------------------------------------------------------------------
// The FlightGear properties the cockpit reads, and what they are here
// ---------------------------------------------------------------------------------------------

/** Every value the cockpit animations read, in FlightGear's units. */
export const COCKPIT_PROPS = [
  'pitchDeg',
  'rollDeg',
  'headingDeg',
  'iasKt',
  'altitudeFt',
  'vsFpm',
  'alphaDeg',
  'g',
  'gMax',
  'gMin',
  /** Slip ball, FlightGear units: 10 × lateral / normal specific force (+ ball left). */
  'slip',
  'n1L',
  'n1R',
  'n2L',
  'n2R',
  /** Interstage turbine temperature, °C (custom table: FlightGear's input is not °C). */
  'ittL',
  'ittR',
  'fuelFlowL',
  'fuelFlowR',
  /** Oil pressure, psi (custom table, as ITT). */
  'oilL',
  'oilR',
  'hydL',
  'hydR',
  'fuelLeftLb',
  'fuelRightLb',
  'fuelTotalLb',
  'throttleL',
  'throttleR',
  /** FlightGear stick: + forward (nose down). */
  'stickElevator',
  /** + right. */
  'stickAileron',
  /** + right pedal. */
  'pedals',
  /** Flap handle 0 UP, 1 MVR, 2 DN. */
  'flapSetting',
  /** Flap angle / 30°. */
  'flapNorm',
  /** Gear handle 0 up, 1 down. */
  'gearHandle',
  /** FlightGear Master Arm: −1 TRAIN, 0 SAFE, 1 ARM. */
  'masterArmSwitch',
  /** GUN/PAC on the gun-rate switch: −1 GUNARM, 0 SAFE, 1 ARM. */
  'gunPacSwitch',
  /** HUD mode selector knob, 0..3 = master mode NAV, GUNS, CCIP, CCRP. */
  'hudModeKnob',
  'rounds',
  'clockHour',
  'clockMinute',
  'clockSecond',
  /** Bearing to the active steerpoint, degrees (the HSI bearing pointer). */
  'steerBearingDeg',
  /** Distance to the active steerpoint, nautical miles (the HSI miles drums). */
  'steerDistanceNm',
  /** HSI course arrow and course drums, degrees. */
  'courseDeg',
  /** Engine operate switches: 1 = NORM. */
  'engineSwitchL',
  'engineSwitchR',
  /** Landing-light switch: 1 = OFF (middle). */
  'landLightSwitch',
  /** HUD brightness knob, 0..1. */
  'hudIntensity',
  /** Warning-panel knobs, 0..1. */
  'knobHalf',
] as const;

export type CockpitProp = (typeof COCKPIT_PROPS)[number];

export const PROP: Readonly<Record<CockpitProp, number>> = Object.fromEntries(
  COCKPIT_PROPS.map((k, i) => [k, i]),
) as Record<CockpitProp, number>;

/** FlightGear property path → our value. Unknown paths read 0 (FlightGear's own default). */
export const FG_PROPERTY: Readonly<Record<string, CockpitProp>> = {
  'orientation/pitch-deg': 'pitchDeg',
  'orientation/roll-deg': 'rollDeg',
  'instrumentation/heading-indicator-fg/indicated-heading-deg': 'headingDeg',
  'instrumentation/magnetic-compass/indicated-heading-deg': 'headingDeg',
  'instrumentation/airspeed-indicator/indicated-speed-kt': 'iasKt',
  'instrumentation/altimeter/indicated-altitude-ft': 'altitudeFt',
  'instrumentation/vertical-speed-indicator/indicated-speed-fpm': 'vsFpm',
  'orientation/alpha-deg': 'alphaDeg',
  'accelerations/pilot-g': 'g',
  'sim/model/A-10/instrumentation/g-meter/g-max': 'gMax',
  'sim/model/A-10/instrumentation/g-meter/g-min': 'gMin',
  'instrumentation/slip-skid-ball/indicated-slip-skid': 'slip',
  'engines/engine[0]/n1': 'n1L',
  'engines/engine[1]/n1': 'n1R',
  'engines/engine[0]/n2': 'n2L',
  'engines/engine[1]/n2': 'n2R',
  'engines/engine[0]/egt-degf': 'ittL',
  'engines/engine[1]/egt-degf': 'ittR',
  'engines/engine[0]/fuel-flow_pph': 'fuelFlowL',
  'engines/engine[1]/fuel-flow_pph': 'fuelFlowR',
  'engines/engine[0]/oil-pressure-psi': 'oilL',
  'engines/engine[1]/oil-pressure-psi': 'oilR',
  'systems/A-10-hydraulics/hyd-psi[0]': 'hydL',
  'systems/A-10-hydraulics/hyd-psi[1]': 'hydR',
  'sim/model/A-10/consumables/fuel/fuel-dsp-left': 'fuelLeftLb',
  'sim/model/A-10/consumables/fuel/fuel-dsp-right': 'fuelRightLb',
  'sim/model/A-10/consumables/fuel/fuel-dsp-drum': 'fuelTotalLb',
  'sim/model/A-10/controls/engines/engine[0]/throttle': 'throttleL',
  'sim/model/A-10/controls/engines/engine[1]/throttle': 'throttleR',
  'controls/flight/elevator': 'stickElevator',
  'controls/flight/aileron': 'stickAileron',
  'controls/flight/rudder': 'pedals',
  'sim/flaps/current-setting': 'flapSetting',
  'surface-positions/left-flap-pos-norm': 'flapNorm',
  'sim/model/A-10/controls/gear/ld-gear-handle-anim': 'gearHandle',
  'controls/armament/master-arm-switch': 'masterArmSwitch',
  'A-10/stations/station[11]/selected': 'gunPacSwitch',
  'controls/hud/m-sel': 'hudModeKnob',
  'ai/submodels/submodel[1]/count': 'rounds',
  'sim/time/utc/hour': 'clockHour',
  'sim/time/utc/minute': 'clockMinute',
  'sim/time/utc/second': 'clockSecond',
  'sim/model/A-10/instrumentation/tacan/indicated-bearing-mag-deg': 'steerBearingDeg',
  'instrumentation/tacan/indicated-distance-nm': 'steerDistanceNm',
  'instrumentation/nav[1]/radials/selected-deg': 'courseDeg',
  'sim/model/A-10/controls/engines/engine[0]/starter-switch-position': 'engineSwitchL',
  'sim/model/A-10/controls/engines/engine[1]/starter-switch-position': 'engineSwitchR',
  'sim/model/A-10/controls/lighting/land-lights-switch': 'landLightSwitch',
  'sim/model/A-10/controls/hud/intens': 'hudIntensity',
  'sim/model/A-10/instrumentation/warnings/audio-alt-volume': 'knobHalf',
  'A-10/displays/cmsc/cmsc-disp-int': 'knobHalf',
};

/**
 * Needle tables (input in OUR units → rad) that replace FlightGear's where its input is not a
 * physical quantity. FlightGear drives the ITT and oil-pressure needles with a normalised
 * thrust setting: off 118°, idle 179°, max 295° (ITT) and off 159° … max 386° (oil). On the
 * dial faces (°C × 100 and 0–100 psi) that is 23.6° per 100 °C with 100 °C at 118°, and
 * 2.27° per psi with 0 psi at 159°, so the needles read the simulated ITT and oil pressure.
 */
export const NEEDLE_OVERRIDES: Readonly<Partial<Record<CockpitProp, readonly [number, number][]>>> =
  {
    ittL: [
      [0, (118 - 23.6) * DEG],
      [1200, (118 + 23.6 * 11) * DEG],
    ],
    ittR: [
      [0, (118 - 23.6) * DEG],
      [1200, (118 + 23.6 * 11) * DEG],
    ],
    oilL: [
      [0, 159 * DEG],
      [100, (159 + 227) * DEG],
    ],
    oilR: [
      [0, 159 * DEG],
      [100, (159 + 227) * DEG],
    ],
  };

/** AoA indexer bands (FlightGear A-10-base.xml): on speed 8° ± 0.5°, gear down only. */
export const AOA_INDEXER = { tooSlow: 9.5, slow: 8.5, fast: 7.5, tooFast: 6.5 } as const;

const MASTER_ARM_VALUE: Record<string, number> = { TRAIN: -1, SAFE: 0, ARM: 1 };
const GUN_PAC_VALUE: Record<string, number> = { GUNARM: -1, SAFE: 0, ARM: 1 };
const MODE_VALUE: Record<string, number> = { NAV: 0, GUNS: 1, CCIP: 2, CCRP: 3 };

/** Cockpit-side memory: the accelerometer's max/min markers and smoothed readings. */
export interface CockpitMemory {
  gMax: number;
  gMin: number;
  /** Low-passed slip ball (FlightGear low-passes it too). */
  slip: number;
  /** Indicated vertical speed lags like a real VSI. */
  vsFpm: number;
  /** Set after the first update (no smoothing on the first frame). */
  primed: boolean;
}

export function createCockpitMemory(): CockpitMemory {
  return { gMax: 1, gMin: 1, slip: 0, vsFpm: 0, primed: false };
}

/** Reset the accelerometer's max/min markers (its push-to-set button). */
export function resetGMeter(mem: CockpitMemory, g = 1): void {
  mem.gMax = Math.max(1, g);
  mem.gMin = Math.min(1, g);
}

/** The lamps the cockpit lights, decided with the values. */
export interface CockpitLamps {
  masterCaution: boolean;
  gunReady: boolean;
  /** AoA indexer: −2 too fast … 0 on speed … +2 too slow, null when dark (gear up). */
  aoaIndexer: -2 | -1 | 0 | 1 | 2 | null;
  gearSafe: boolean;
  gearInTransit: boolean;
  /** Steerpoint distance and bearing are valid (HSI miles flag hidden). */
  steerValid: boolean;
  /** Armament panel station lamps: per FlightGear station id 0..10, the store count lit (0 = dark). */
  stationCount: Int8Array;
}

export function createCockpitLamps(): CockpitLamps {
  return {
    masterCaution: false,
    gunReady: false,
    aoaIndexer: null,
    gearSafe: false,
    gearInTransit: false,
    steerValid: false,
    stationCount: new Int8Array(11),
  };
}

const LB_PER_KG = 1 / LB;
const PPH_PER_KGS = 3600 / LB;
const FPM_PER_MS = 60 / FT;

function lowPass(prev: number, next: number, dt: number, tau: number): number {
  if (dt <= 0) return prev;
  return prev + (next - prev) * (1 - Math.exp(-dt / tau));
}

/**
 * The FlightGear property values for this frame (indexed by PROP) and the lamps, from the
 * simulation. `dt` (sim seconds) drives the instrument lags. Allocation-free.
 */
export function fillCockpitValues(
  sim: Sim,
  mem: CockpitMemory,
  dt: number,
  out: Float64Array,
  lamps: CockpitLamps,
): void {
  const ac = sim.aircraft;
  const av = sim.avionics;
  const g = Number.isFinite(ac.gLoad) ? ac.gLoad : 1;
  if (!mem.primed) {
    mem.gMax = Math.max(1, g);
    mem.gMin = Math.min(1, g);
  }
  mem.gMax = Math.max(mem.gMax, g);
  mem.gMin = Math.min(mem.gMin, g);
  const vs = ac.verticalSpeed * FPM_PER_MS;
  const slip = (10 * ac.lateralG) / Math.max(0.3, Math.abs(g));
  if (mem.primed) {
    mem.vsFpm = lowPass(mem.vsFpm, vs, dt, 0.35);
    mem.slip = lowPass(mem.slip, slip, dt, 0.25);
  } else {
    mem.vsFpm = vs;
    mem.slip = slip;
    mem.primed = true;
  }

  out[PROP.pitchDeg] = ac.pitch / DEG;
  out[PROP.rollDeg] = ac.bank / DEG;
  out[PROP.headingDeg] = ac.heading / DEG;
  out[PROP.iasKt] = ac.ias / 0.514444;
  out[PROP.altitudeFt] = ac.position.y / FT;
  out[PROP.vsFpm] = mem.vsFpm;
  out[PROP.alphaDeg] = ac.alpha / DEG;
  out[PROP.g] = g;
  out[PROP.gMax] = mem.gMax;
  out[PROP.gMin] = mem.gMin;
  out[PROP.slip] = mem.slip;

  for (let i = 0; i < 2; i++) {
    const e = ac.engines[i];
    const n2 = e ? e.n2 : 0;
    // oil pressure and hydraulics follow the core (no lubrication model in the simulation)
    const load = Math.min(1, Math.max(0, (n2 - 0.55) / 0.45));
    const oil = n2 < 0.05 ? 0 : Math.min(1, n2 / 0.55) * (42 + 18 * load);
    const hyd = 3000 * Math.min(1, Math.max(0, n2 / 0.45));
    out[i === 0 ? PROP.n1L : PROP.n1R] = (e ? e.n1 : 0) * 100;
    out[i === 0 ? PROP.n2L : PROP.n2R] = n2 * 100;
    out[i === 0 ? PROP.ittL : PROP.ittR] = e ? e.itt : 0;
    out[i === 0 ? PROP.fuelFlowL : PROP.fuelFlowR] = (e ? e.fuelFlow : 0) * PPH_PER_KGS;
    out[i === 0 ? PROP.oilL : PROP.oilR] = oil;
    out[i === 0 ? PROP.hydL : PROP.hydR] = hyd;
  }
  const fuelLb = Math.max(0, ac.fuel) * LB_PER_KG;
  out[PROP.fuelLeftLb] = fuelLb / 2;
  out[PROP.fuelRightLb] = fuelLb / 2;
  out[PROP.fuelTotalLb] = fuelLb;

  const input = sim.input;
  out[PROP.throttleL] = input.throttle[0];
  out[PROP.throttleR] = input.throttle[1];
  out[PROP.stickElevator] = -input.pitch;
  out[PROP.stickAileron] = input.roll;
  out[PROP.pedals] = input.rudder;
  out[PROP.flapSetting] = ac.flapHandle;
  out[PROP.flapNorm] = ac.surfaces.flaps / (30 * DEG);
  out[PROP.gearHandle] = ac.gearDown ? 1 : 0;
  out[PROP.masterArmSwitch] = MASTER_ARM_VALUE[av.masterArm] ?? 0;
  out[PROP.gunPacSwitch] = GUN_PAC_VALUE[av.gunPac] ?? 0;
  out[PROP.hudModeKnob] = MODE_VALUE[av.masterMode] ?? 0;
  out[PROP.rounds] = Math.max(0, Math.round(sim.gun.rounds));

  const hours = ((sim.world.timeOfDay % 24) + 24) % 24;
  const totalS = hours * 3600;
  out[PROP.clockHour] = Math.floor(totalS / 3600);
  out[PROP.clockMinute] = Math.floor((totalS % 3600) / 60);
  out[PROP.clockSecond] = Math.floor(totalS % 60);

  const sp = av.steerpoints[av.activeSteerpoint];
  if (sp) {
    const dx = sp.position.x - ac.position.x;
    const dz = sp.position.z - ac.position.z;
    const brg = headingOf(dx, dz) / DEG;
    out[PROP.steerBearingDeg] = brg;
    out[PROP.steerDistanceNm] = Math.min(999.9, Math.hypot(dx, dz) / NM);
    out[PROP.courseDeg] = Math.round(brg) % 360;
    lamps.steerValid = true;
  } else {
    out[PROP.steerBearingDeg] = 0;
    out[PROP.steerDistanceNm] = 0;
    out[PROP.courseDeg] = 0;
    lamps.steerValid = false;
  }
  out[PROP.engineSwitchL] = 1;
  out[PROP.engineSwitchR] = 1;
  out[PROP.landLightSwitch] = 1;
  out[PROP.hudIntensity] = 0.85;
  out[PROP.knobHalf] = 0.5;

  // lamps
  lamps.masterCaution = !!ac.warnings.masterCaution;
  const gear = Number.isFinite(ac.gearPosition) ? ac.gearPosition : ac.gearDown ? 1 : 0;
  lamps.gearSafe = gear >= 1;
  lamps.gearInTransit = gear > 0 && gear < 1;
  lamps.gunReady =
    av.masterArm === 'ARM' && av.gunPac !== 'SAFE' && sim.gun.rounds > 0 && !ac.gearDown;
  if (gear >= 1) {
    const a = out[PROP.alphaDeg];
    lamps.aoaIndexer =
      a > AOA_INDEXER.tooSlow
        ? 2
        : a > AOA_INDEXER.slow
          ? 1
          : a > AOA_INDEXER.fast
            ? 0
            : a > AOA_INDEXER.tooFast
              ? -1
              : -2;
  } else lamps.aoaIndexer = null;
  fillStationLamps(sim, lamps.stationCount);
}

/**
 * Armament panel station lamps: with Master Arm out of SAFE in CCIP or CCRP, the stations that
 * carry the selected profile's store light one lamp per store left (FlightGear: 0, 1, 2).
 */
function fillStationLamps(sim: Sim, out: Int8Array): void {
  out.fill(0);
  const av = sim.avionics;
  if (av.masterArm === 'SAFE' || (av.masterMode !== 'CCIP' && av.masterMode !== 'CCRP')) return;
  let store: string | null = null;
  for (let i = 0; i < av.profiles.length; i++)
    if (av.profiles[i].id === av.selectedProfile) store = av.profiles[i].store;
  if (!store) return;
  const st = sim.stores.stations;
  for (let i = 0; i < st.length; i++) {
    const s = st[i];
    if (s.station < 1 || s.station > 11) continue;
    let n = 0;
    for (let k = 0; k < s.stores.length; k++) if (s.stores[k] === store) n++;
    out[s.station - 1] = Math.min(3, n);
  }
}

// ---------------------------------------------------------------------------------------------
// FlightGear animation semantics
// ---------------------------------------------------------------------------------------------

/** Piecewise-linear lookup in a flat [x0, y0, x1, y1, …] table, clamped at both ends. */
export function lookupTable(t: ArrayLike<number>, x: number): number {
  const n = t.length / 2;
  if (n === 0) return 0;
  if (x <= t[0]) return t[1];
  for (let i = 1; i < n; i++) {
    const x1 = t[i * 2];
    if (x <= x1) {
      const x0 = t[i * 2 - 2];
      const y0 = t[i * 2 - 1];
      const y1 = t[i * 2 + 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return t[t.length - 1];
}

/**
 * simgear's SGStepExpression: the value in whole `step`s, rolling on to the next step over the
 * last `scroll` of each one (an odometer drum).
 */
export function stepScroll(v: number, step: number | null, scroll: number | null): number {
  if (!step || step <= 0) return v;
  const base = Math.floor(v / step) * step;
  const sc = scroll ?? 0;
  const toNext = step - (v - base);
  if (sc > 0 && toNext < sc) return base + ((sc - toNext) / sc) * step;
  return base;
}

export interface UvAnimLike {
  factor: number;
  offset: number;
  step: number | null;
  scroll: number | null;
  table: [number, number][] | null;
}

/**
 * The texture shift of a FlightGear textranslate for a property value, in texture units:
 * (step(value) + offset) × factor — simgear adds the offset BEFORE the factor here.
 */
export function textranslateShift(u: UvAnimLike, value: number, flatTable?: Float64Array): number {
  let v = value;
  if (u.table) v = lookupTable(flatTable ?? u.table.flat(), v);
  v = stepScroll(v, u.step, u.scroll);
  return (v + u.offset) * u.factor;
}

/** The digit a drum shows for a shift (digits 0.1 apart on the drum, 0 at shift 0). */
export function drumDigit(shift: number): number {
  const f = shift - Math.floor(shift);
  return Math.round(f * 10) % 10;
}

// ---------------------------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------------------------

interface PivotBinding {
  obj: Object3D;
  type: 0 | 1 | 2;
  axis: Vector3;
  rest: Vector3;
  prop: number;
  gain: number;
  offset: number;
  table: Float64Array | null;
  min: number;
  max: number;
  angle: number;
}

interface UvBinding {
  materials: MeshStandardMaterial[];
  baseX: number[];
  baseY: number[];
  u: number;
  v: number;
  prop: number;
  anim: UvAnimLike;
  table: Float64Array | null;
}

type LampRule = (lamps: CockpitLamps, values: Float64Array) => boolean;

interface ToggleBinding {
  obj: Object3D;
  rule: LampRule;
}

const always = (): boolean => true;
const never = (): boolean => false;

/**
 * Visibility rules for the cockpit's select animations, by node name. FlightGear conditions on
 * electrical power read "powered"; anything not listed keeps the meta's default.
 */
export function toggleRule(node: string): LampRule | null {
  switch (node) {
    // power is on: the OFF flags are out of view, the gear-panel mask is gone, the drums lit
    case 'A-10-adi-off-flag':
    case 'A-10-HSI-off-flag':
    case 'A-10-AoA-gauge-off-flag':
    case 'mask':
    case 'canopy-warning':
    case 'steering-engaged':
    case 'aim-9-light-on':
      return never;
    case 'rds-rem-x1':
    case 'rds-rem-x10':
    case 'rds-rem-x100':
    case 'rds-rem-x1000':
    case 'stdby-adi__2':
      return always;
    case 'miles-flag':
      return (l) => !l.steerValid;
    case 'gun-ready':
      return (l) => l.gunReady;
    case 'master-caution-on':
      return (l) => l.masterCaution;
    case 'l-gear-safe':
    case 'n-gear-safe':
    case 'r-gear-safe':
      return (l) => l.gearSafe;
    case 'l-gear-warn':
    case 'n-gear-warn':
    case 'r-gear-warn':
      return (l) => l.gearInTransit;
    case 'aoa-too-slow':
      return (l) => l.aoaIndexer === 2;
    case 'aoa-slow':
      return (l) => l.aoaIndexer === 1;
    case 'aoa-on-speed':
      return (l) => l.aoaIndexer === 0;
    case 'aoa-fast':
      return (l) => l.aoaIndexer === -1;
    case 'aoa-too-fast':
      return (l) => l.aoaIndexer === -2;
    default: {
      // armament panel station lamps s-<FlightGear id>-<0|1|2|E>
      const m = /^s-(\d+)-([012E])$/.exec(node);
      if (!m) return null;
      const id = Number(m[1]);
      if (m[2] === 'E') return never;
      const k = Number(m[2]);
      return (l) => l.stationCount[id] > k;
    }
  }
}

export interface InstrumentDriver {
  /** FlightGear property values of the last update (indexed by PROP). */
  readonly values: Float64Array;
  readonly lamps: CockpitLamps;
  readonly memory: CockpitMemory;
  /** Bound pivots / drums / lamps (for the sandbox's statistics). */
  readonly counts: { pivots: number; drums: number; toggles: number };
  /** Read the simulation and pose everything. dt in sim seconds. */
  update(sim: Sim, dt: number): void;
  /** Pose from values already in `values` (the sandbox drives this directly). dt in seconds. */
  apply(dt?: number): void;
}

function meshMaterials(obj: Object3D): MeshStandardMaterial[] {
  const out: MeshStandardMaterial[] = [];
  obj.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const mats = (Array.isArray(m.material) ? m.material : [m.material]) as Material[];
    for (const mat of mats) {
      const sm = mat as MeshStandardMaterial;
      if (sm.map && !out.includes(sm)) out.push(sm);
    }
  });
  return out;
}

function bindPivot(root: Object3D, p: PivotMeta): PivotBinding | null {
  const obj = root.getObjectByName(p.node);
  if (!obj) return null;
  const d = p.drive;
  const key = d.input ? FG_PROPERTY[d.input] : undefined;
  const prop = key !== undefined ? PROP[key] : -1;
  const override = key ? NEEDLE_OVERRIDES[key] : undefined;
  const table = override ?? d.table;
  return {
    obj,
    type: p.type === 'rotate' ? 0 : p.type === 'translate' ? 1 : 2,
    axis: new Vector3(p.axis[0], p.axis[1], p.axis[2]).normalize(),
    rest: obj.position.clone(),
    prop,
    gain: d.gain ?? 0,
    offset: d.offset ?? 0,
    table: table ? Float64Array.from(table.flat()) : null,
    min: override ? -Infinity : (d.min ?? -Infinity),
    max: override ? Infinity : (d.max ?? Infinity),
    angle: 0,
  };
}

/**
 * Bind the cockpit model's animations (meta.cockpit) to the simulation. `root` is a cockpit
 * model instance (createCockpitModel); materials of drums must be this instance's own (the
 * driver moves their texture offsets). Nodes for which `skip` returns true are not bound (the
 * A-10A instruments the A-10C panel covers).
 */
export function createInstrumentDriver(
  root: Object3D,
  meta: A10Meta,
  skip: (node: Object3D) => boolean = () => false,
): InstrumentDriver {
  const values = new Float64Array(COCKPIT_PROPS.length);
  const lamps = createCockpitLamps();
  const memory = createCockpitMemory();
  const pivots: PivotBinding[] = [];
  for (const p of meta.cockpit.pivots) {
    const b = bindPivot(root, p);
    if (b && !skip(b.obj)) pivots.push(b);
  }
  const drums: UvBinding[] = [];
  for (const u of meta.cockpit.uvAnims) {
    const key = u.property ? FG_PROPERTY[u.property] : undefined;
    if (key === undefined) continue;
    const obj = root.getObjectByName(u.node);
    if (!obj || skip(obj)) continue;
    const materials = meshMaterials(obj);
    if (!materials.length) continue;
    drums.push({
      materials,
      baseX: materials.map((m) => m.map?.offset.x ?? 0),
      baseY: materials.map((m) => m.map?.offset.y ?? 0),
      u: u.uv[0],
      v: u.uv[1],
      prop: PROP[key],
      anim: u,
      table: u.table ? Float64Array.from(u.table.flat()) : null,
    });
  }
  const toggles: ToggleBinding[] = [];
  for (const t of meta.cockpit.toggles) {
    const rule = toggleRule(t.node);
    if (!rule) continue;
    const obj = root.getObjectByName(t.node);
    if (obj && !skip(obj)) toggles.push({ obj, rule });
  }

  const apply = (dt = 0) => {
    for (let i = 0; i < pivots.length; i++) {
      const p = pivots[i];
      const x = p.prop >= 0 ? values[p.prop] : 0;
      if (p.type === 2) {
        p.angle = (p.angle + p.gain * x * dt) % (Math.PI * 2);
        p.obj.quaternion.setFromAxisAngle(p.axis, p.angle);
        continue;
      }
      let y = p.table ? lookupTable(p.table, x) : p.gain * x + p.offset;
      if (y < p.min) y = p.min;
      if (y > p.max) y = p.max;
      if (p.type === 0) p.obj.quaternion.setFromAxisAngle(p.axis, y);
      else p.obj.position.copy(p.rest).addScaledVector(p.axis, y);
    }
    for (let i = 0; i < drums.length; i++) {
      const d = drums[i];
      const s = textranslateShift(d.anim, values[d.prop], d.table ?? undefined);
      // keep only the fraction: the textures repeat, and float32 offsets stay exact
      const f = s - Math.floor(s);
      for (let k = 0; k < d.materials.length; k++) {
        const map = d.materials[k].map;
        if (!map) continue;
        // three.js recomputes the UV transform from offset/repeat when it draws
        map.offset.set(d.baseX[k] + d.u * f, d.baseY[k] + d.v * f);
      }
    }
    for (let i = 0; i < toggles.length; i++) {
      const t = toggles[i];
      t.obj.visible = t.rule(lamps, values);
    }
  };

  return {
    values,
    lamps,
    memory,
    counts: { pivots: pivots.length, drums: drums.length, toggles: toggles.length },
    update(sim, dt) {
      fillCockpitValues(sim, memory, dt, values, lamps);
      apply(dt);
    },
    apply,
  };
}
