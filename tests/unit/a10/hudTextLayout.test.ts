/**
 * HUD text layout (avionics wave-2 request 3): no two texts of the HUD overlap, so every line of
 * the side data blocks holds one item. In CCIP consent with the release armed the `REL n`
 * countdown used to be overprinted by the SPI's slant range, which was drawn under an SPI mark
 * held on the field's edge, over the left data block, without a collision test.
 *
 * The states are the HUD sandbox's presets (src/a10/dev/sandboxes/hud.tsx, with the avionics'
 * own fire control and delivery logic answering the pickle), a real consent run stepped from the
 * press to the release and the bomb's time of fall, and sweeps of the texts that move with a
 * symbol (the time to release beside the solution cue, the slant range beside the gun and rocket
 * reticles) over the data blocks.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { hudAnglesOfPoint, spiToSteerpoint, stepFireControl } from '../../../src/a10/core/avionics';
import type { GunPacSwitch, MasterArm, MasterMode } from '../../../src/a10/core/avionics/types';
import { bodyDirFromHudAngles, quaternionFromAttitude } from '../../../src/a10/core/frames';
import { stepSensors } from '../../../src/a10/core/sensors';
import { createSim, stepSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import { DEG, FT, KT } from '../../../src/a10/core/units';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { tasFromCas } from '../../../src/a10/core/world/atmosphere';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { HUD_SIZES, computeHudLayout, fieldHalfWidthAt } from '../../../src/a10/view/hud/hudLayout';
import { anglesFromPlane } from '../../../src/a10/view/hud/hudMath';
import { textWidth } from '../../../src/a10/view/hud/strokeFont';
import { HudSymbology, type HudDrawState } from '../../../src/a10/view/hud/symbology';

const EYE = A10_GEOMETRY.eye;
const LAYOUT = computeHudLayout();
const H = HUD_SIZES.text;

/** A text the HUD drew: anchor, alignment and baseline direction. */
interface Text {
  text: string;
  x: number;
  y: number;
  align: number;
  ux: number;
  uy: number;
}

/** The four corners of a text's cap-height box (x0, y0, x1, y1, …), along its baseline. */
function corners(t: Text): number[] {
  const w = textWidth(t.text.length, H);
  // Baseline u, up v = (−uy, ux); the anchor is the middle of the capitals at `align`.
  const ox = t.x - t.align * w * t.ux + (H / 2) * t.uy;
  const oy = t.y - t.align * w * t.uy - (H / 2) * t.ux;
  return [
    ox,
    oy,
    ox + w * t.ux,
    oy + w * t.uy,
    ox + w * t.ux - H * t.uy,
    oy + w * t.uy + H * t.ux,
    ox - H * t.uy,
    oy + H * t.ux,
  ];
}

/** Separating-axis test of two convex quads: true when their insides overlap. */
function overlap(a: number[], b: number[]): boolean {
  for (const q of [a, b]) {
    for (let e = 0; e < 4; e++) {
      const i = e * 2;
      const j = ((e + 1) % 4) * 2;
      const nx = -(q[j + 1] - q[i + 1]);
      const ny = q[j] - q[i];
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (let k = 0; k < 8; k += 2) {
        const pa = a[k] * nx + a[k + 1] * ny;
        const pb = b[k] * nx + b[k + 1] * ny;
        minA = Math.min(minA, pa);
        maxA = Math.max(maxA, pa);
        minB = Math.min(minB, pb);
        maxB = Math.max(maxB, pb);
      }
      const len = Math.hypot(nx, ny) || 1;
      if ((Math.min(maxA, maxB) - Math.max(minA, minB)) / len <= 1e-9) return false;
    }
  }
  return true;
}

/** The texts that reach past the side of the glass, seen from the design eye. */
function outsideGlass(texts: Text[]): string[] {
  const f = LAYOUT.field;
  const out: string[] = [];
  for (const t of texts) {
    const c = corners(t);
    for (let k = 0; k < 8; k += 2) {
      const half = fieldHalfWidthAt(f, Math.atan(c[k + 1]));
      if (Math.abs(Math.atan(c[k]) - f.center) > half + 1e-9) {
        out.push(`"${t.text}" (${(t.x / DEG).toFixed(2)}°, ${(t.y / DEG).toFixed(2)}°)`);
        break;
      }
    }
  }
  return out;
}

/** Every pair of overlapping texts, as readable strings (empty when the layout is clean). */
function overlaps(texts: Text[]): string[] {
  const boxes = texts.map(corners);
  const out: string[] = [];
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++)
      if (overlap(boxes[i], boxes[j]))
        out.push(
          `"${texts[i].text}" (${(texts[i].x / DEG).toFixed(2)}°, ${(texts[i].y / DEG).toFixed(2)}°) × "${texts[j].text}" (${(texts[j].x / DEG).toFixed(2)}°, ${(texts[j].y / DEG).toFixed(2)}°)`,
        );
  return out;
}

/** Build the HUD and record its texts (the step state, or the step state as a drawn state). */
function hudTexts(sim: Sim, hud: HudSymbology, drawn: boolean): Text[] {
  const texts: Text[] = [];
  const ac = sim.aircraft;
  const state: HudDrawState | undefined = drawn
    ? {
        position: ac.position.clone(),
        orientation: ac.orientation.clone(),
        velocity: ac.velocity.clone(),
      }
    : undefined;
  hud.build(
    sim,
    EYE,
    { seg() {} },
    (text, x, y, align, ux = 1, uy = 0) => texts.push({ text, x, y, align, ux, uy }),
    state,
  );
  return texts;
}

// ---------------------------------------------------------------------------------------------
// The HUD sandbox's presets (the same numbers and the same set-up as dev/sandboxes/hud.tsx)
// ---------------------------------------------------------------------------------------------

interface Params {
  headingDeg: number;
  pitchDeg: number;
  bankDeg: number;
  alphaDeg: number;
  iasKt: number;
  altFt: number;
  g: number;
  maxG: number;
  mode: MasterMode;
  arm: MasterArm;
  gunPac: GunPacSwitch;
  pacStage: 0 | 1 | 2;
  rounds: number;
  store: string;
  pickle: boolean;
  ccrpLead: number;
  targetDeg: number;
  tof: number;
  sensors: boolean;
  pullUp: boolean;
  altAlert: boolean;
}

const DEFAULTS: Params = {
  headingDeg: 35,
  pitchDeg: 3,
  bankDeg: 0,
  alphaDeg: 4,
  iasKt: 250,
  altFt: 8000,
  g: 1,
  maxG: 1,
  mode: 'NAV',
  arm: 'SAFE',
  gunPac: 'ARM',
  pacStage: 0,
  rounds: 1150,
  store: 'MK82LD',
  pickle: false,
  ccrpLead: 0,
  targetDeg: 15,
  tof: 0,
  sensors: false,
  pullUp: false,
  altAlert: false,
};

const STORE_PRESETS: Record<string, Partial<Params>> = {
  ccip: { mode: 'CCIP', arm: 'ARM', pitchDeg: -45, alphaDeg: 2, iasKt: 350, altFt: 3000 },
  delay: { mode: 'CCIP', arm: 'ARM', pitchDeg: -5, alphaDeg: 3, iasKt: 300, altFt: 3000 },
  consent: {
    mode: 'CCIP',
    arm: 'ARM',
    pitchDeg: -5,
    alphaDeg: 3,
    iasKt: 300,
    altFt: 3000,
    pickle: true,
  },
  rockets: {
    mode: 'CCIP',
    arm: 'ARM',
    store: 'M156-131',
    pitchDeg: -15,
    alphaDeg: 2.5,
    iasKt: 300,
    altFt: 2500,
  },
  ccrp: {
    mode: 'CCRP',
    arm: 'ARM',
    pitchDeg: 2,
    alphaDeg: 4,
    iasKt: 300,
    altFt: 6000,
    ccrpLead: 12,
    targetDeg: 8,
  },
  ccrpcue: {
    mode: 'CCRP',
    arm: 'ARM',
    pitchDeg: 2,
    alphaDeg: 4,
    iasKt: 300,
    altFt: 6000,
    ccrpLead: 3,
    targetDeg: 0,
  },
  tof: {
    mode: 'CCRP',
    arm: 'ARM',
    store: 'GBU12',
    pitchDeg: 2,
    alphaDeg: 4,
    iasKt: 300,
    altFt: 8000,
    ccrpLead: 20,
    targetDeg: 0,
    tof: 24,
    sensors: true,
  },
  passed: {
    mode: 'CCRP',
    arm: 'ARM',
    pitchDeg: 2,
    alphaDeg: 4,
    iasKt: 300,
    altFt: 6000,
    ccrpLead: -4,
    targetDeg: 0,
  },
  invalid: {
    mode: 'CCRP',
    arm: 'ARM',
    store: 'M156-131',
    pitchDeg: 2,
    alphaDeg: 4,
    iasKt: 300,
    altFt: 6000,
  },
  sensors: {
    mode: 'NAV',
    pitchDeg: -12,
    alphaDeg: 3,
    iasKt: 280,
    altFt: 5000,
    targetDeg: 4,
    sensors: true,
  },
};

const FLIGHT_PRESETS: Record<string, Partial<Params>> = {
  cruise: {},
  dive: {
    mode: 'GUNS',
    arm: 'ARM',
    pitchDeg: -30,
    alphaDeg: 2.5,
    iasKt: 300,
    altFt: 2300,
    maxG: 3.4,
    rounds: 1088,
  },
  shallow: {
    mode: 'GUNS',
    arm: 'ARM',
    pitchDeg: -8,
    alphaDeg: 3,
    iasKt: 320,
    altFt: 650,
    maxG: 2.8,
  },
  turn: { bankDeg: 50, pitchDeg: 6, alphaDeg: 9, g: 3.6, maxG: 4.1, iasKt: 280, altFt: 6500 },
  pullup: {
    mode: 'GUNS',
    arm: 'ARM',
    pitchDeg: -24,
    alphaDeg: 2,
    iasKt: 340,
    altFt: 700,
    pullUp: true,
    altAlert: true,
  },
};

/** The tanks around the target (offsets from the steerpoint, m), as the sandbox places them. */
const TANKS = [0, 1, 2, 3].map((i) => new Vector3((i - 1.5) * 22, 1.2, (i % 2) * 15 - 7));
const TERRAIN = createFlatTerrain(0);

/** The sandbox's fake flight: the tank hunter's load, two steerpoints, the seekers made. */
function sandboxSim(): Sim {
  const sim = createSim({
    terrain: TERRAIN,
    scenario: 'empty',
    seed: 7,
    loadoutId: 'tankHunter',
    start: { x: 0, z: 0, agl: 2400, heading: 0, speed: 130 },
  });
  const sp = sim.avionics.steerpoints;
  sp.length = 0;
  sp.push({ id: 1, name: 'TGT1', position: new Vector3(0, 0, 0) });
  sp.push({ id: 2, name: 'IP', position: new Vector3(0, 0, 0) });
  sim.avionics.activeSteerpoint = 0;
  stepSensors(sim, 1 / 120);
  return sim;
}

function selectProfile(sim: Sim, P: Params): void {
  const av = sim.avionics;
  const p = av.profiles.find((q) => q.id === P.store) ?? av.profiles[0];
  if (!p) return;
  av.selectedProfile = p.id;
  if ((P.mode === 'CCIP' || P.mode === 'CCRP') && p.mode !== 'NONE') {
    if (P.mode === 'CCRP' && !p.store.startsWith('LAU')) p.mode = 'CCRP';
    else if (P.mode === 'CCIP' && p.store !== 'GBU-12') p.mode = 'CCIP';
  }
}

function applySensors(sim: Sim, P: Params): void {
  const av = sim.avionics;
  const tgp = sim.sensors.tgp;
  const target = av.steerpoints[0].position;
  const eye = new Vector3(EYE.x, EYE.y, EYE.z)
    .applyQuaternion(sim.aircraft.orientation)
    .add(sim.aircraft.position);
  av.tgpPower = P.sensors;
  tgp.powered = P.sensors;
  tgp.warmup = 0;
  tgp.mode = 'POINT';
  tgp.point.copy(target).add(TANKS[1]);
  tgp.pointValid = P.sensors;
  tgp.los.subVectors(tgp.point, eye).normalize();
  const mav = sim.sensors.mavericks[0];
  if (mav) {
    sim.sensors.selectedMaverick = P.sensors ? 0 : -1;
    mav.powered = P.sensors;
    mav.align = 0;
    mav.locked = P.sensors;
    mav.lockPoint.copy(target).add(TANKS[3]);
    mav.los.subVectors(mav.lockPoint, eye).normalize();
  }
  if (P.sensors) {
    av.spi.valid = true;
    av.spi.source = 'TGP';
    av.spi.position.copy(tgp.point);
  } else spiToSteerpoint(sim);
}

/** Write the preset into the simulation and run the avionics' fire control (no stepping). */
function applyParams(sim: Sim, P: Params): void {
  const ac = sim.aircraft;
  const av = sim.avionics;
  const alt = P.altFt * FT;
  quaternionFromAttitude(P.headingDeg * DEG, P.pitchDeg * DEG, P.bankDeg * DEG, ac.orientation);
  ac.heading = (((P.headingDeg % 360) + 360) % 360) * DEG;
  ac.pitch = P.pitchDeg * DEG;
  ac.bank = P.bankDeg * DEG;
  const tas = tasFromCas(P.iasKt * KT, alt);
  const dir = bodyDirFromHudAngles(0, -P.alphaDeg * DEG, new Vector3()).applyQuaternion(
    ac.orientation,
  );
  ac.velocity.copy(dir).multiplyScalar(tas);
  ac.position.set(0, alt, 0);
  ac.prevPosition.copy(ac.position);
  ac.prevOrientation.copy(ac.orientation);
  ac.prevVelocity.copy(ac.velocity);
  ac.tas = tas;
  ac.ias = P.iasKt * KT;
  ac.alpha = P.alphaDeg * DEG;
  ac.altitude = alt;
  ac.agl = alt;
  ac.verticalSpeed = ac.velocity.y;
  ac.groundSpeed = Math.hypot(ac.velocity.x, ac.velocity.z);
  ac.gLoad = P.g;
  ac.maxG = Math.max(P.g, P.maxG);
  ac.warnings.pullUp = P.pullUp;
  ac.warnings.altitude = P.altAlert;
  ac.pac.stage = P.pacStage;
  ac.pac.active = P.gunPac === 'ARM' && P.pacStage > 0;
  av.masterMode = P.mode;
  av.masterArm = P.arm;
  av.gunPac = P.gunPac;
  sim.gun.rounds = P.rounds;
  selectProfile(sim, P);
  sim.input.weaponRelease = P.pickle;
  applySensors(sim, P);
  stepFireControl(sim, 1 / 120);
  // Nothing executes releases here.
  sim.stores.releaseQueue.length = 0;
  if (P.tof > 0) av.release.timeToImpact = P.tof;
}

/** The target placed `lead` seconds of flight before the CCRP release point (the sandbox's way). */
function placeCcrpTarget(sim: Sim, P: Params): void {
  const av = sim.avionics;
  const ac = sim.aircraft;
  const sp = av.steerpoints[0].position;
  const gs = Math.max(1, ac.groundSpeed);
  const brg = Math.atan2(ac.velocity.x, -ac.velocity.z) + P.targetDeg * DEG;
  const fall = Math.sqrt((2 * Math.max(1, ac.agl)) / 9.81);
  let d = gs * (fall + P.ccrpLead);
  for (let k = 0; k < 6; k++) {
    sp.set(ac.position.x + Math.sin(brg) * d, 0, ac.position.z - Math.cos(brg) * d);
    applyParams(sim, P);
    const rel = av.release;
    if (!rel.valid) break;
    d -= (rel.timeToRelease - P.ccrpLead) * gs;
  }
}

/** A preset's state, as the sandbox shows it a few frames after choosing it. */
function presetSim(preset: Partial<Params>): Sim {
  const P: Params = { ...DEFAULTS, ...preset };
  const sim = sandboxSim();
  applyParams(sim, P);
  const sp = sim.avionics.steerpoints;
  const brg = (P.headingDeg + P.targetDeg) * DEG;
  const g = sim.avionics.gun;
  if (g.valid && P.mode === 'GUNS') sp[0].position.copy(g.impact).setY(0);
  else if (P.mode === 'CCRP' && P.ccrpLead !== 0) placeCcrpTarget(sim, P);
  else sp[0].position.set(Math.sin(brg) * 4000, 0, -Math.cos(brg) * 4000);
  sp[1].position.set(-Math.sin(brg) * 9000, 0, Math.cos(brg) * 9000);
  // The sandbox writes its state every frame (the pickle stays held).
  for (let k = 0; k < 3; k++) applyParams(sim, P);
  return sim;
}

describe('HUD text layout: one item per line, no text over another', () => {
  for (const [name, preset] of Object.entries({ ...STORE_PRESETS, ...FLIGHT_PRESETS })) {
    it(`preset ${name}`, () => {
      const sim = presetSim(preset);
      for (const soi of ['HUD', 'LMFD'] as const) {
        sim.avionics.soi = soi;
        for (const drawn of [false, true]) {
          const texts = hudTexts(sim, new HudSymbology(LAYOUT), drawn);
          expect(texts.length).toBeGreaterThan(10);
          expect(overlaps(texts), `${name}, SOI ${soi}`).toEqual([]);
          expect(outsideGlass(texts), `${name}, SOI ${soi}`).toEqual([]);
        }
      }
    });
  }

  it('the store presets show what they are meant to (the countdown line included)', () => {
    const has = (preset: Partial<Params>, re: RegExp) =>
      hudTexts(presetSim(preset), new HudSymbology(LAYOUT), true).some((t) => re.test(t.text));
    expect(has(STORE_PRESETS.consent, /^REL \d+$/)).toBe(true);
    expect(has(STORE_PRESETS.ccrp, /^REL \d+$/)).toBe(true);
    expect(has(STORE_PRESETS.tof, /^TOF \d+$/)).toBe(true);
    expect(has(STORE_PRESETS.invalid, /^CCRP INVALID$/)).toBe(true);
    expect(has(STORE_PRESETS.sensors, /^SPI TGP$/)).toBe(true);
  });

  it('a real consent run, from the press through the release to the time of fall', () => {
    // The wave-2 check flight: a 30° dive from 2,600 m at 300 kt, Mk-82 in CCIP, the SPI on a
    // steerpoint far to the left (held on the edge of the HUD), the pickle held until the bomb
    // leaves, then the bomb's time of fall.
    const sim = createSim({
      terrain: TERRAIN,
      scenario: 'empty',
      seed: 5,
      start: { x: 0, z: 0, agl: 2600, heading: 0, speed: 300 * KT, gamma: -30 * DEG },
    });
    const av = sim.avionics;
    av.steerpoints.length = 0;
    av.steerpoints.push({ id: 1, name: 'ALPHA', position: new Vector3(-15600, 0, -2100) });
    av.activeSteerpoint = 0;
    spiToSteerpoint(sim);
    av.masterArm = 'ARM';
    av.selectedProfile = 'MK82LD';
    // A hard pull earlier in the flight: MAX g would want the countdown's line.
    sim.aircraft.maxG = 4.2;
    sim.commands.push({ type: 'masterMode', value: 'CCIP' });
    for (let k = 0; k < 120; k++) stepSim(sim);
    expect(av.sight).toBe('CCIP');
    expect(av.release.belowGlass).toBe(true);
    sim.input.weaponRelease = true;
    const hud = new HudSymbology(LAYOUT);
    const seen = new Set<string>();
    for (let k = 0; k < 120 * 12 && !sim.aircraft.crashed; k++) {
      stepSim(sim);
      sim.aircraft.maxG = Math.max(sim.aircraft.maxG, 4.2);
      if (sim.debrief.weapons.length > 0) sim.input.weaponRelease = false;
      if (k % 12 !== 0) continue;
      const texts = hudTexts(sim, hud, k % 24 === 0);
      for (const t of texts) {
        if (/^REL \d+$/.test(t.text)) seen.add('REL');
        if (/^TOF \d+$/.test(t.text)) seen.add('TOF');
        if (t.text === 'SPI STPT') seen.add('SPI');
      }
      if (av.release.armed) seen.add('armed');
      expect(overlaps(texts), `t = ${sim.time.toFixed(2)} s`).toEqual([]);
    }
    // The run went through the armed consent release, its countdown and the time of fall.
    expect([...seen].sort()).toEqual(['REL', 'SPI', 'TOF', 'armed']);
  });
});

// ---------------------------------------------------------------------------------------------
// Texts that move with a symbol
// ---------------------------------------------------------------------------------------------

/** Wings level (or banked) at 1,500 m, 300 kt, the velocity vector alpha below the nose. */
function flight(pitch: number, bank = 0, drift = 0): Sim {
  const sim = createSim({
    terrain: TERRAIN,
    scenario: 'empty',
    seed: 3,
    start: { x: 0, z: 0, agl: 2400, heading: 0, speed: 300 * KT },
  });
  const ac = sim.aircraft;
  quaternionFromAttitude(30 * DEG, pitch * DEG, bank * DEG, ac.orientation);
  ac.heading = 30 * DEG;
  const dir = bodyDirFromHudAngles(drift * DEG, -3 * DEG, new Vector3());
  ac.velocity.copy(dir.applyQuaternion(ac.orientation)).multiplyScalar(300 * KT);
  ac.position.set(0, 1500, 0);
  ac.altitude = 1500;
  ac.agl = 1500;
  ac.ias = 300 * KT;
  ac.gLoad = 1;
  ac.maxG = 1;
  ac.prevPosition.copy(ac.position);
  ac.prevOrientation.copy(ac.orientation);
  ac.prevVelocity.copy(ac.velocity);
  return sim;
}

/** A ground point seen at HUD angles az/el (degrees) from the design eye. */
function groundAt(sim: Sim, azDeg: number, elDeg: number): Vector3 {
  const ac = sim.aircraft;
  const eye = new Vector3(EYE.x, EYE.y, EYE.z).applyQuaternion(ac.orientation).add(ac.position);
  const d = bodyDirFromHudAngles(azDeg * DEG, elDeg * DEG, new Vector3()).applyQuaternion(
    ac.orientation,
  );
  return eye.addScaledVector(d, -eye.y / d.y);
}

/** Every text clear of every other; returns the texts (step state and drawn state agree). */
function clean(sim: Sim, label: string): Text[] {
  let texts: Text[] = [];
  for (const drawn of [false, true]) {
    texts = hudTexts(sim, new HudSymbology(LAYOUT), drawn);
    expect(overlaps(texts), label).toEqual([]);
    expect(outsideGlass(texts), label).toEqual([]);
  }
  return texts;
}

describe('HUD texts that move with a symbol keep clear of the others', () => {
  it('the time to release beside the solution cue, the steering line anywhere (CCRP)', () => {
    for (const pitch of [-40, -10, 2]) {
      const sim = flight(pitch);
      const av = sim.avionics;
      av.masterMode = 'CCRP';
      av.sight = 'CCRP';
      av.masterArm = 'ARM';
      av.selectedProfile = 'MK82LD';
      const rel = av.release;
      rel.valid = true;
      rel.impact.copy(groundAt(sim, 0, -12));
      rel.designated.copy(rel.impact);
      rel.designatedValid = true;
      rel.timeToRelease = 3.4;
      rel.timeOfFall = 10;
      for (const errDeg of [-30, -9, -6, -3, 0, 3, 6, 9, 30])
        for (const cueDeg of [-6, 0, 1, 2, 4, 8, 15]) {
          rel.azimuthError = errDeg * DEG;
          rel.cueEl = cueDeg * DEG;
          clean(sim, `CCRP pitch ${pitch}°, steering ${errDeg}°, cue ${cueDeg}°`);
        }
    }
  });

  it('the time to release beside the solution cue in a consent release, banked and drifting', () => {
    for (const pitch of [-35, -20, -8])
      for (const bank of [-30, 0, 30])
        for (const drift of [-6, 0, 6]) {
          const sim = flight(pitch, bank, drift);
          const av = sim.avionics;
          av.masterMode = 'CCIP';
          av.sight = 'CCIP';
          av.masterArm = 'ARM';
          av.selectedProfile = 'MK82LD';
          av.ccipInvalid = false;
          const rel = av.release;
          rel.valid = true;
          rel.impact.copy(groundAt(sim, 0, -22));
          const a = hudAnglesOfPoint(sim.aircraft, rel.impact, { az: 0, el: 0 });
          rel.az = a.az;
          rel.el = a.el;
          rel.designated.copy(groundAt(sim, 0, -13));
          rel.designatedValid = true;
          rel.timeOfFall = 9;
          for (const errDeg of [-20, -8, 8, 20])
            for (const t of [1, 3, 6]) {
              rel.timeToRelease = t;
              rel.azimuthError = errDeg * DEG;
              rel.cueEl = t * 0.6 * DEG;
              clean(sim, `consent ${pitch}°/${bank}°/${drift}°, steering ${errDeg}°, ${t} s`);
            }
        }
  });

  it('the slant range beside the gun and rocket reticles, the pipper over the data blocks', () => {
    for (const pitch of [-30, -15, -5]) {
      const rockets = flight(pitch);
      let av = rockets.avionics;
      av.masterMode = 'CCIP';
      av.sight = 'CCIP';
      av.masterArm = 'ARM';
      av.selectedProfile = 'M156-131';
      av.ccipInvalid = false;
      const rel = av.release;
      rel.valid = true;
      const gun = flight(pitch);
      av = gun.avionics;
      av.masterMode = 'GUNS';
      av.sight = 'GUN';
      av.masterArm = 'ARM';
      const g = av.gun;
      g.valid = true;
      g.slantRange = 1500;
      for (let az = -6; az <= 6; az += 0.5)
        for (let el = -13.5; el <= 0; el += 0.75) {
          rel.impact.copy(groundAt(rockets, az, el));
          rel.az = az * DEG;
          rel.el = el * DEG;
          clean(rockets, `rockets at ${az}°, ${el}° (pitch ${pitch}°)`);
          g.impact.copy(groundAt(gun, az, el));
          g.pipperAz = az * DEG;
          g.pipperEl = el * DEG;
          clean(gun, `gun at ${az}°, ${el}° (pitch ${pitch}°)`);
        }
    }
  });

  it('a moving text goes to the other side of its symbol, and only then is left out', () => {
    const sim = flight(-15);
    const av = sim.avionics;
    av.masterMode = 'GUNS';
    av.sight = 'GUN';
    av.masterArm = 'ARM';
    av.soi = 'HUD';
    av.steerpoints.length = 0;
    // The SPI far to the left: held on the left edge of the hold box, clear of the cases below.
    av.steerpoints.push({ id: 1, name: 'ALPHA', position: groundAt(sim, -40, -5) });
    av.activeSteerpoint = 0;
    spiToSteerpoint(sim);
    const g = av.gun;
    g.valid = true;
    g.slantRange = 1500;
    const rangeText = (x: number, y: number) => {
      const a = anglesFromPlane(x, y, { az: 0, el: 0 });
      g.pipperAz = a.az;
      g.pipperEl = a.el;
      g.impact.copy(groundAt(sim, a.az / DEG, a.el / DEG));
      const texts = clean(sim, `gun pipper at ${x}, ${y}`);
      return texts.find((t) => t.text === (1500 / FT / 1000).toFixed(1));
    };
    // Between the blocks' lines: at the reticle's 3 o'clock.
    const mid = rangeText(0, LAYOUT.lineY[6] + 1.5 * DEG);
    expect(mid?.align).toBe(0);
    expect(mid?.x ?? 0).toBeGreaterThan(0);
    // Its 3 o'clock on the right block's top line (the altitude): at its 9 o'clock.
    const right = rangeText(LAYOUT.rightX - 3 * DEG, LAYOUT.lineY[6]);
    expect(right?.align).toBe(1);
    expect(right?.x ?? 0).toBeLessThan(LAYOUT.rightX - 3 * DEG);
    // On the master mode's line, between "GUNS *" and "SPI STPT": left out.
    expect(rangeText(0, LAYOUT.lineY[3])).toBeUndefined();
  });

  it('keeps the time beside the solution cue on the glass when the steering is held at its edge', () => {
    const sim = flight(2);
    const av = sim.avionics;
    av.masterMode = 'CCRP';
    av.sight = 'CCRP';
    av.masterArm = 'ARM';
    av.selectedProfile = 'MK82LD';
    const rel = av.release;
    rel.valid = true;
    rel.impact.copy(groundAt(sim, 0, -12));
    rel.designated.copy(rel.impact);
    rel.designatedValid = true;
    rel.timeToRelease = 11.6;
    rel.timeOfFall = 20;
    rel.cueEl = 40 * DEG; // far from the release: the cue waits at the top of the line
    for (const side of [1, -1]) {
      rel.azimuthError = side * 30 * DEG; // the line held dashed at the edge of the field
      const hud = new HudSymbology(LAYOUT);
      const texts = clean(sim, `steering held ${side > 0 ? 'right' : 'left'}`);
      const info = hud.build(sim, EYE, { seg() {} });
      expect(info.cue).toBe(true);
      expect(info.cueY).toBeCloseTo(LAYOUT.aslTop, 9);
      const time = texts.find((t) => t.text === '12' && Math.abs(t.y - info.cueY) < 1e-9);
      // Beside the cue on the side toward the middle of the glass.
      expect(time, `held ${side}`).toBeDefined();
      expect(time!.align).toBe(side > 0 ? 1 : 0);
      expect(Math.sign(info.cueX - time!.x)).toBe(side);
    }
  });

  it("keeps the reticle's slant range off the SPI mark held at the edge", () => {
    const sim = flight(-15);
    const av = sim.avionics;
    av.masterMode = 'GUNS';
    av.sight = 'GUN';
    av.masterArm = 'ARM';
    av.steerpoints.length = 0;
    // The SPI 30° right: held on the right edge of the hold box, between the text columns.
    av.steerpoints.push({ id: 1, name: 'ALPHA', position: groundAt(sim, 30, -6) });
    av.activeSteerpoint = 0;
    spiToSteerpoint(sim);
    const g = av.gun;
    g.valid = true;
    g.slantRange = 1500;
    const held = new HudSymbology(LAYOUT).build(sim, EYE, { seg() {} });
    expect(held.spi && held.spiHeld).toBe(true);
    // The pipper just left of the mark: its 3 o'clock would sit on the dashed square.
    const a = anglesFromPlane(held.spiX - 1.5 * DEG, held.spiY, { az: 0, el: 0 });
    g.pipperAz = a.az;
    g.pipperEl = a.el;
    g.impact.copy(groundAt(sim, a.az / DEG, a.el / DEG));
    const texts = clean(sim, 'gun pipper beside the held SPI');
    const range = texts.find((t) => t.text === (1500 / FT / 1000).toFixed(1));
    expect(range?.align).toBe(1); // at 9 o'clock
    const h = HUD_SIZES.spiSquare;
    const square = [
      held.spiX - h,
      held.spiY - h,
      held.spiX + h,
      held.spiY - h,
      held.spiX + h,
      held.spiY + h,
      held.spiX - h,
      held.spiY + h,
    ];
    expect(overlap(corners(range!), square)).toBe(false);
  });
});
