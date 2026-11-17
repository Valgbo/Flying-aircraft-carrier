/**
 * HUD wave 2 (PLAN_A10.md §6.4–6.7, §7; ARCHITECTURE §12.7): the store symbology built from a
 * real simulation state — CCIP bomb fall line, minimum range staple, delay cue and consent
 * release, rockets, CCRP steering and countdowns, the SPI and the sensor marks, the weapon block.
 * The release solutions are set by hand (the avionics module computes them in parallel); the
 * sensors' states likewise.
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { hudAnglesOfPoint } from '../../../src/a10/core/avionics';
import type { ReleaseSolution } from '../../../src/a10/core/avionics/types';
import {
  bodyDirFromHudAngles,
  hudAnglesFromBodyDir,
  quaternionFromAttitude,
  worldToBody,
} from '../../../src/a10/core/frames';
import type { MaverickSeekerState } from '../../../src/a10/core/sensors/types';
import { createSim } from '../../../src/a10/core/sim';
import { createVehicle } from '../../../src/a10/core/targets';
import type { Sim } from '../../../src/a10/core/types';
import { FT, KT } from '../../../src/a10/core/units';
import type { StoreBody } from '../../../src/a10/core/weapons/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { HUD_GLASS, HUD_SIZES, computeHudLayout } from '../../../src/a10/view/hud/hudLayout';
import {
  DEG,
  belowGlass,
  holdOnBox,
  minimumRangeFraction,
  planeFromAngles,
} from '../../../src/a10/view/hud/hudMath';
import type { SegmentSink } from '../../../src/a10/view/hud/strokeFont';
import {
  HudSymbology,
  storesLeft,
  type HudDrawState,
} from '../../../src/a10/view/hud/symbology';

const EYE = A10_GEOMETRY.eye;
const LAYOUT = computeHudLayout();

class Recorder implements SegmentSink {
  segs: number[][] = [];
  seg(x0: number, y0: number, x1: number, y1: number, w: number, i: number): void {
    this.segs.push([x0, y0, x1, y1, w, i]);
  }
}

/** The default load ("tank hunter": rockets, Mavericks, GBU-12s, Mk-82s, the pod). */
function flight(opts: {
  pitch: number;
  bank?: number;
  alpha?: number;
  heading?: number;
  alt?: number;
}): Sim {
  const sim = createSim({
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    seed: 3,
    start: { x: 0, z: 0, agl: 2400, heading: 0, speed: 300 * KT },
  });
  const ac = sim.aircraft;
  const h = (opts.heading ?? 30) * DEG;
  quaternionFromAttitude(h, opts.pitch * DEG, (opts.bank ?? 0) * DEG, ac.orientation);
  ac.heading = h;
  const dir = bodyDirFromHudAngles(0, -(opts.alpha ?? 2.5) * DEG, new Vector3());
  ac.velocity.copy(dir.applyQuaternion(ac.orientation)).multiplyScalar(300 * KT);
  const alt = opts.alt ?? 1500;
  ac.position.set(0, alt, 0);
  ac.altitude = alt;
  ac.agl = alt;
  ac.ias = 300 * KT;
  ac.gLoad = 1;
  ac.maxG = 1;
  ac.prevPosition.copy(ac.position);
  ac.prevOrientation.copy(ac.orientation);
  ac.prevVelocity.copy(ac.velocity);
  return sim;
}

/** A ground point (flat ground at y = 0) seen at HUD angles az/el from the design eye. */
function groundAt(sim: Sim, azDeg: number, elDeg: number): Vector3 {
  const ac = sim.aircraft;
  const eye = new Vector3(EYE.x, EYE.y, EYE.z).applyQuaternion(ac.orientation).add(ac.position);
  const d = bodyDirFromHudAngles(azDeg * DEG, elDeg * DEG, new Vector3()).applyQuaternion(
    ac.orientation,
  );
  return eye.addScaledVector(d, -eye.y / d.y);
}

/** CCIP with a profile, the solution's impact at HUD angles az/el (set as the avionics would). */
function ccip(sim: Sim, profile: string, azDeg: number, elDeg: number): ReleaseSolution {
  const av = sim.avionics;
  av.masterMode = 'CCIP';
  av.sight = 'CCIP';
  av.masterArm = 'ARM';
  av.selectedProfile = profile;
  av.ccipInvalid = false;
  const rel = av.release;
  rel.valid = true;
  rel.impact.copy(groundAt(sim, azDeg, elDeg));
  const a = hudAnglesOfPoint(sim.aircraft, rel.impact, { az: 0, el: 0 });
  rel.az = a.az;
  rel.el = a.el;
  rel.timeOfFall = 9;
  rel.timeToRelease = 0;
  rel.belowMinimum = false;
  return rel;
}

/** The step state as a drawn state (the renderer's path: every point projected). */
function drawnOf(sim: Sim): HudDrawState {
  const ac = sim.aircraft;
  return {
    position: ac.position.clone(),
    orientation: ac.orientation.clone(),
    velocity: ac.velocity.clone(),
  };
}

function build(sim: Sim, drawn?: HudDrawState, hud = new HudSymbology(LAYOUT)) {
  const rec = new Recorder();
  const texts: { text: string; x: number; y: number }[] = [];
  const info = { ...hud.build(sim, EYE, rec, (text, x, y) => texts.push({ text, x, y }), drawn) };
  return {
    info,
    rec,
    texts,
    has: (t: string) => texts.some((e) => e.text === t),
    hud,
  };
}

/** Distance of point p from the infinite line through a and b (plane units). */
function lineDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.abs((px - ax) * dy - (py - ay) * dx) / Math.hypot(dx, dy);
}

describe('HUD CCIP bombs', () => {
  it('the CCIP fall line passes from the velocity vector through the pipper', () => {
    for (const [bank, az, el] of [
      [0, 0, -8],
      [25, 2.5, -7],
      [-40, -3, -9],
    ]) {
      const sim = flight({ pitch: -30, bank });
      ccip(sim, 'MK82LD', az, el);
      for (const drawn of [undefined, drawnOf(sim)]) {
        const { info, rec } = build(sim, drawn);
        expect(info.pipper).toBe(true);
        expect(info.pipperBelowField).toBe(false);
        expect(info.pbil).toBe(true);
        expect(info.pbilDashed).toBe(false);
        // It starts on the velocity vector's circle and ends on the reticle, on the line
        // through both centres.
        const r0 = Math.hypot(info.pbilX0 - info.tvvX, info.pbilY0 - info.tvvY);
        const r1 = Math.hypot(info.pbilX1 - info.pipperX, info.pbilY1 - info.pipperY);
        expect(r0).toBeCloseTo(HUD_SIZES.tvvRadius, 9);
        expect(r1).toBeCloseTo(HUD_SIZES.bombReticleRadius, 9);
        const L = [info.tvvX, info.tvvY, info.pipperX, info.pipperY] as const;
        expect(lineDistance(info.pbilX0, info.pbilY0, ...L)).toBeLessThan(1e-12);
        expect(lineDistance(info.pbilX1, info.pbilY1, ...L)).toBeLessThan(1e-12);
        // …and is drawn as that one solid stroke.
        expect(
          rec.segs.some(
            ([x0, y0, x1, y1]) =>
              Math.abs(x0 - info.pbilX0) < 1e-12 &&
              Math.abs(y0 - info.pbilY0) < 1e-12 &&
              Math.abs(x1 - info.pbilX1) < 1e-12 &&
              Math.abs(y1 - info.pbilY1) < 1e-12,
          ),
        ).toBe(true);
      }
    }
  });

  it('the delay cue appears exactly when the pipper is below the glass', () => {
    const sim = flight({ pitch: -12, alpha: 2 });
    const rel = ccip(sim, 'MK82LD', 0, -10);
    const edge = LAYOUT.glassBottom;
    let seenBelow = 0;
    let seenAbove = 0;
    for (const az of [0, 1.5]) {
      for (let el = -12; el >= -18; el -= 0.05) {
        // Set the solution's direction directly (the step state's angles).
        rel.az = az * DEG;
        rel.el = el * DEG;
        const { info } = build(sim);
        const p = planeFromAngles(rel.az, rel.el, { x: 0, y: 0 });
        const below = belowGlass(EYE, { x: p.x, y: p.y, z: -1 }, HUD_GLASS);
        expect(info.pipperBelowField).toBe(below);
        expect(info.delayCue).toBe(below);
        expect(info.pbilDashed).toBe(below);
        if (below) {
          seenBelow++;
          // On the fall line, the margin above the glass's bottom edge.
          const L = [info.tvvX, info.tvvY, info.pipperX, info.pipperY] as const;
          expect(lineDistance(info.delayCueX, info.delayCueY, ...L)).toBeLessThan(1e-12);
          const t = (info.delayCueX - edge.x0) / (edge.x1 - edge.x0);
          const edgeY = edge.y0 + (edge.y1 - edge.y0) * t;
          expect(info.delayCueY - edgeY).toBeCloseTo(HUD_SIZES.delayCueMargin, 9);
        } else seenAbove++;
      }
    }
    expect(seenBelow).toBeGreaterThan(20);
    expect(seenAbove).toBeGreaterThan(20);
  });

  it('draws the delay cue at the ground point the computer designates when it gives one', () => {
    const sim = flight({ pitch: -10, alpha: 2 });
    const rel = ccip(sim, 'MK82LD', 0, -22) as ReleaseSolution & {
      delayCue?: Vector3;
      delayCueValid?: boolean;
    };
    const point = groundAt(sim, 0.2, -13.9);
    rel.delayCue = point;
    rel.delayCueValid = true;
    const { info } = build(sim, drawnOf(sim));
    expect(info.delayCue).toBe(true);
    const a = hudAnglesOfPoint(sim.aircraft, point, { az: 0, el: 0 });
    const p = planeFromAngles(a.az, a.el, { x: 0, y: 0 });
    expect(info.delayCueX).toBeCloseTo(p.x, 9);
    expect(info.delayCueY).toBeCloseTo(p.y, 9);
  });

  it('places the minimum range staple where the minimum release height puts the pipper', () => {
    // The fraction: 1 at the minimum height, smaller above it, above 1 below it.
    const v = [0, -150 * Math.sin(30 * DEG), -150 * Math.cos(30 * DEG)] as const;
    expect(minimumRangeFraction(450, 450, ...v)).toBeCloseTo(1, 12);
    const f1 = minimumRangeFraction(900, 450, ...v);
    const f2 = minimumRangeFraction(1800, 450, ...v);
    expect(f1).toBeLessThan(1);
    expect(f2).toBeLessThan(f1);
    expect(minimumRangeFraction(300, 450, ...v)).toBeGreaterThan(1);
    expect(Number.isNaN(minimumRangeFraction(-5, 450, ...v))).toBe(true);
    // In a level release the time of fall goes as √h: the drop angle nearly so.
    const level = minimumRangeFraction(1000, 250, 150, 0, 0);
    expect(level).toBeCloseTo(0.5, 1);

    // In the HUD: on the fall line at that fraction.
    const sim = flight({ pitch: -30, alt: 1200 });
    const rel = ccip(sim, 'MK82LD', 0.5, -9);
    const { info } = build(sim, drawnOf(sim));
    const prof = sim.avionics.profiles.find((p) => p.id === 'MK82LD');
    expect(prof).toBeDefined();
    const ac = sim.aircraft;
    const f = minimumRangeFraction(
      ac.position.y - rel.impact.y,
      prof?.minAltitude ?? 0,
      ac.velocity.x,
      ac.velocity.y,
      ac.velocity.z,
    );
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(1);
    expect(info.staple).toBe(true);
    expect(info.stapleX).toBeCloseTo(info.tvvX + (info.pipperX - info.tvvX) * f, 12);
    expect(info.stapleY).toBeCloseTo(info.tvvY + (info.pipperY - info.tvvY) * f, 12);
  });

  it('after a consent designation shows the target, the steering and the time to release', () => {
    const sim = flight({ pitch: -10, alpha: 2 });
    const rel = ccip(sim, 'MK82LD', 0, -20);
    rel.designatedValid = true;
    rel.designated.copy(groundAt(sim, 0.4, -13));
    rel.timeToRelease = 3.4;
    rel.azimuthError = 0;
    const { info, has } = build(sim, drawnOf(sim));
    expect(info.designated).toBe(true);
    const a = hudAnglesOfPoint(sim.aircraft, rel.designated, { az: 0, el: 0 });
    const p = planeFromAngles(a.az, a.el, { x: 0, y: 0 });
    expect(info.designatedX).toBeCloseTo(p.x, 9);
    expect(info.designatedY).toBeCloseTo(p.y, 9);
    expect(info.asl).toBe(true);
    expect(info.cue).toBe(true);
    expect(has('REL 4')).toBe(true);
    expect(info.timeToRelease).toBeCloseTo(3.4, 12);
    // The release cue as the bomb leaves.
    rel.releaseNow = true;
    expect(build(sim, drawnOf(sim)).info.releaseCue).toBe(true);
  });

  it('flashes the reticle below the minimum release height', () => {
    const sim = flight({ pitch: -30 });
    const rel = ccip(sim, 'MK82LD', 0, -8);
    /** Strokes of the reticle circle: both ends on its radius around the pipper. */
    const reticle = (t: number) => {
      sim.time = t;
      const { info, rec } = build(sim);
      const R = HUD_SIZES.bombReticleRadius;
      const on = (x: number, y: number) =>
        Math.abs(Math.hypot(x - info.pipperX, y - info.pipperY) - R) < 1e-9;
      return rec.segs.filter(([x0, y0, x1, y1]) => on(x0, y0) && on(x1, y1)).length;
    };
    const steady = [0, 0.13, 0.26, 0.39].map(reticle);
    expect(steady).toEqual([48, 48, 48, 48]);
    rel.belowMinimum = true;
    const flashing = [0, 0.13, 0.26, 0.39].map(reticle);
    expect(flashing).toEqual([48, 48, 0, 0]); // 2 Hz: on for 0.25 s, off for 0.25 s
  });
});

describe('HUD CCIP rockets', () => {
  it('draws the rocket reticle and slant range, without a fall line or delay cue', () => {
    const sim = flight({ pitch: -15 });
    const rel = ccip(sim, 'M156-131', 0, -7);
    let r = build(sim, drawnOf(sim));
    expect(r.info.pipper).toBe(true);
    expect(r.info.pbil).toBe(false);
    const range = sim.aircraft.position.distanceTo(rel.impact);
    expect(r.has((range / FT / 1000).toFixed(1))).toBe(true);
    expect(r.has('M156-131')).toBe(true);
    expect(r.has('7 SGL')).toBe(true); // seven rockets in the pod
    // Below the glass: still no delay cue (rockets have no consent release).
    ccip(sim, 'M156-131', 0, -19);
    r = build(sim, drawnOf(sim));
    expect(r.info.pipperBelowField).toBe(true);
    expect(r.info.delayCue).toBe(false);
  });
});

describe('HUD CCRP', () => {
  function ccrp(azErrDeg: number, t = 12.3): Sim {
    const sim = flight({ pitch: 2, alpha: 2, alt: 1500 });
    const av = sim.avionics;
    av.masterMode = 'CCRP';
    av.sight = 'CCRP';
    av.masterArm = 'ARM';
    av.selectedProfile = 'GBU12';
    const rel = av.release;
    rel.valid = true;
    rel.impact.copy(groundAt(sim, 3, -8));
    rel.designated.copy(rel.impact);
    rel.designatedValid = true;
    rel.timeToRelease = t;
    rel.timeOfFall = 21.5;
    rel.azimuthError = azErrDeg * DEG;
    rel.cueEl = Math.min(t, 5) * 0.5 * DEG;
    return sim;
  }

  it('the CCRP steering line moves with the azimuth error', () => {
    const dxs: number[] = [];
    for (const e of [-3, -1, 0, 1, 3]) {
      const { info } = build(ccrp(e), drawnOf(ccrp(e)));
      expect(info.asl).toBe(true);
      dxs.push(info.aslDx);
      // Wings level, no drift: the line is offset by the steering error itself (+ right).
      expect(info.aslDx).toBeCloseTo(Math.tan(e * DEG), 3);
    }
    for (let k = 1; k < dxs.length; k++) expect(dxs[k]).toBeGreaterThan(dxs[k - 1]);
    expect(Math.abs(dxs[2])).toBeLessThan(1e-9);
  });

  it('puts the solution cue at the avionics angle above the velocity vector', () => {
    const sim = ccrp(0, 3);
    const { info } = build(sim, drawnOf(sim));
    expect(info.cue).toBe(true);
    // Level flight: the cue is cueEl above the velocity vector's elevation, on the line.
    const gamma = Math.atan2(
      sim.aircraft.velocity.y,
      Math.hypot(sim.aircraft.velocity.x, sim.aircraft.velocity.z),
    );
    const d = new Vector3(0, Math.sin(gamma + sim.avionics.release.cueEl), 0);
    const track = Math.atan2(sim.aircraft.velocity.x, -sim.aircraft.velocity.z);
    const c = Math.cos(gamma + sim.avionics.release.cueEl);
    d.x = Math.sin(track) * c;
    d.z = -Math.cos(track) * c;
    const body = worldToBody(sim.aircraft.orientation, d, new Vector3());
    expect(info.cueX).toBeCloseTo(body.x / -body.z, 9);
    expect(info.cueY).toBeCloseTo(body.y / -body.z, 9);
  });

  it('counts down to release, then the time of fall, then the time to impact of a falling bomb', () => {
    const sim = ccrp(0, 12.3);
    let r = build(sim);
    expect(r.has('REL 13')).toBe(true);
    expect(r.has('13')).toBe(true); // beside the solution cue
    sim.avionics.release.timeToRelease = 4.2;
    expect(build(sim).has('REL 5')).toBe(true);
    sim.avionics.release.timeToRelease = 0;
    r = build(sim);
    expect(r.has('TOF 22')).toBe(true);
    expect(r.info.timeOfFall).toBeCloseTo(21.5, 12);

    // A bomb leaves: the HUD follows it and counts its time to impact down.
    const rel = sim.avionics.release as ReleaseSolution & { timeToImpact?: number };
    rel.timeToImpact = -1; // the computer keeps none: the HUD's own watch
    sim.avionics.release.timeOfFall = 20.2;
    const hud = new HudSymbology(LAYOUT);
    sim.time = 100;
    sim.projectiles.bodies.push(fakeBomb(7, 100));
    r = build(sim, undefined, hud);
    expect(r.has('TOF 21')).toBe(true);
    expect(r.info.releaseCue).toBe(true);
    sim.time = 110;
    r = build(sim, undefined, hud);
    expect(r.has('TOF 11')).toBe(true);
    expect(r.info.releaseCue).toBe(false);
    // It hits: back to the solution's own countdown.
    sim.projectiles.bodies.length = 0;
    expect(build(sim, undefined, hud).has('TOF 21')).toBe(true);

    // The computer's time to impact, when it keeps one, wins.
    rel.timeToImpact = 7.2;
    expect(build(sim, undefined, hud).has('TOF 8')).toBe(true);
  });

  it('says CCRP INVALID without a solution or a CCRP weapon', () => {
    const sim = ccrp(0);
    expect(build(sim).has('CCRP INVALID')).toBe(false);
    sim.avionics.release.valid = false;
    expect(build(sim).has('CCRP INVALID')).toBe(true);
    sim.avionics.release.valid = true;
    sim.avionics.sight = 'NONE';
    expect(build(sim).has('CCRP INVALID')).toBe(true);
  });
});

/**
 * A falling bomb with the contract fields the HUD reads (ARCHITECTURE §12.2); the weapons module
 * adds its own fields to StoreBody, which the HUD does not use.
 */
function fakeBomb(id: number, t: number): StoreBody {
  const body = {
    id,
    type: 'GBU-12',
    kind: 'laserBomb',
    alive: true,
    station: 4,
    releaseTime: t,
    position: new Vector3(0, 1400, 0),
    velocity: new Vector3(0, 0, -150),
    orientation: new Quaternion(),
    motorTime: 0,
    armed: false,
    data: {},
    delivery: 'CCRP',
    aim: new Vector3(),
    aimValid: true,
    highDrag: false,
    armingTime: 4,
    laserCode: 1688,
    guidance: { mode: 'NONE', vehicleId: -1, point: new Vector3(), valid: false },
    record: -1,
  };
  return body as unknown as StoreBody;
}

describe('HUD SPI and sensor marks', () => {
  /** A seeker with the contract fields the HUD reads (the sensors module adds its own). */
  function seeker(sim: Sim): MaverickSeekerState {
    const s = {
      station: 3,
      powered: true,
      align: 0,
      los: new Vector3(0, -1, 0),
      fov: 'WIDE',
      locked: false,
      lockedVehicle: -1,
      lockPoint: new Vector3(),
      inZone: false,
      gimbalAz: 0,
      gimbalEl: 0,
      contrast: 0,
    } as unknown as MaverickSeekerState;
    sim.sensors.mavericks.length = 0;
    sim.sensors.mavericks.push(s);
    sim.sensors.selectedMaverick = 0;
    return s;
  }

  it('the SPI and sensor diamonds sit at the right HUD angles from the eye', () => {
    const sim = flight({ pitch: -20, bank: 15 });
    const av = sim.avionics;
    av.spi.valid = true;
    av.spi.source = 'STPT';
    av.spi.position.copy(groundAt(sim, 2, -11));
    const tgp = sim.sensors.tgp;
    tgp.powered = true;
    tgp.warmup = 0;
    av.tgpPower = true;
    tgp.pointValid = true;
    tgp.point.copy(groundAt(sim, -3, -6));
    const mav = seeker(sim);
    mav.locked = true;
    mav.lockPoint.copy(groundAt(sim, 4, -14));
    const expectAt = (x: number, y: number, point: Vector3) => {
      const a = hudAnglesOfPoint(sim.aircraft, point, { az: 0, el: 0 });
      const p = planeFromAngles(a.az, a.el, { x: 0, y: 0 });
      expect(x).toBeCloseTo(p.x, 9);
      expect(y).toBeCloseTo(p.y, 9);
    };
    for (const drawn of [undefined, drawnOf(sim)]) {
      const { info } = build(sim, drawn);
      expect(info.spi && info.tgp && info.mav).toBe(true);
      expect(info.spiHeld).toBe(false);
      expectAt(info.spiX, info.spiY, av.spi.position);
      expectAt(info.tgpX, info.tgpY, tgp.point);
      expectAt(info.mavX, info.mavY, mav.lockPoint);
    }
    // Unlocked, the seeker's line of sight is a direction.
    mav.locked = false;
    mav.los.copy(bodyDirFromHudAngles(1 * DEG, -9 * DEG, new Vector3())).applyQuaternion(
      sim.aircraft.orientation,
    );
    const { info } = build(sim);
    const a = hudAnglesFromBodyDir(
      worldToBody(sim.aircraft.orientation, mav.los, new Vector3()),
      { az: 0, el: 0 },
    );
    const p = planeFromAngles(a.az, a.el, { x: 0, y: 0 });
    expect(info.mavX).toBeCloseTo(p.x, 9);
    expect(info.mavY).toBeCloseTo(p.y, 9);
  });

  it('shows the slant range to the SPI and holds an SPI outside the field at its edge', () => {
    const sim = flight({ pitch: -5 });
    const av = sim.avionics;
    av.spi.valid = true;
    av.spi.source = 'STPT';
    av.spi.position.copy(groundAt(sim, 1, -6));
    let r = build(sim);
    const nm = sim.aircraft.position.distanceTo(av.spi.position) / 1852;
    expect(r.has(nm.toFixed(1))).toBe(true);
    expect(r.has('SPI STPT')).toBe(true);
    // 25° right of the nose: outside the field, held on its edge toward the SPI.
    av.spi.position.copy(groundAt(sim, 25, -4));
    r = build(sim);
    expect(r.info.spiHeld).toBe(true);
    const box = LAYOUT.tvvBox;
    expect(r.info.spiX).toBeCloseTo(box.right, 9);
    const cx = (box.left + box.right) / 2;
    const cy = (box.bottom + box.top) / 2;
    const a = hudAnglesOfPoint(sim.aircraft, av.spi.position, { az: 0, el: 0 });
    const p = planeFromAngles(a.az, a.el, { x: 0, y: 0 });
    const held = holdOnBox(cx, cy, p.x, p.y, box, { x: 0, y: 0 });
    expect(r.info.spiY).toBeCloseTo(held.y, 9);
  });

  it('gives the pod diamond a tail when the pod is the SPI generator', () => {
    const sim = flight({ pitch: -10 });
    const av = sim.avionics;
    const tgp = sim.sensors.tgp;
    av.tgpPower = true;
    tgp.powered = true;
    tgp.warmup = 0;
    tgp.pointValid = true;
    tgp.point.copy(groundAt(sim, 1, -7));
    av.spi.valid = true;
    av.spi.position.copy(tgp.point);
    av.spi.source = 'STPT';
    const plain = build(sim).info;
    const tail = (segs: number[][]) =>
      segs.some(
        ([x0, y0, x1, y1]) =>
          Math.abs(x0 - plain.tgpX) < 1e-12 &&
          Math.abs(x1 - plain.tgpX) < 1e-12 &&
          Math.abs(y0 - (plain.tgpY - HUD_SIZES.tgpDiamond)) < 1e-12 &&
          y1 < y0,
      );
    expect(tail(build(sim).rec.segs)).toBe(false);
    av.spi.source = 'TGP';
    const r = build(sim);
    expect(tail(r.rec.segs)).toBe(true);
    expect(r.has('SPI TGP')).toBe(true);
    // No pod picture yet (warming up): no diamond.
    tgp.warmup = 30;
    expect(build(sim).info.tgp).toBe(false);
  });
});

describe('HUD weapon block, SOI and aids', () => {
  it('shows the profile, the stores left and the release mode; the gun in GUNS', () => {
    const sim = flight({ pitch: -30 });
    ccip(sim, 'MK82LD', 0, -8);
    let r = build(sim);
    expect(r.has('MK82LD')).toBe(true);
    expect(r.has(`${storesLeft(sim, 'MK-82')} SGL`)).toBe(true);
    expect(storesLeft(sim, 'MK-82')).toBe(2);
    expect(storesLeft(sim, 'LAU-131-M156')).toBe(7);
    const prof = sim.avionics.profiles.find((p) => p.id === 'MK82LD');
    if (prof) prof.release = 'RIP_PRS';
    expect(build(sim).has('2 RIP PRS')).toBe(true);
    sim.avionics.masterMode = 'GUNS';
    sim.avionics.sight = 'GUN';
    sim.avionics.gunPac = 'ARM';
    r = build(sim);
    expect(r.has('PAC')).toBe(true);
    expect(r.has(String(sim.gun.rounds))).toBe(true);
    expect(r.has('MK82LD')).toBe(false);
  });

  it('marks the HUD as the sensor of interest with an asterisk', () => {
    const sim = flight({ pitch: 0 });
    sim.avionics.soi = 'HUD';
    expect(build(sim).has('*')).toBe(true);
    sim.avionics.soi = 'LMFD';
    expect(build(sim).has('*')).toBe(false);
  });

  it('boxes live vehicles only with the relaxed realism aid', () => {
    const sim = flight({ pitch: -10, heading: 0 });
    // Three vehicles ahead (north), one destroyed, one 12 km away.
    const ahead = (z: number) => groundAt(sim, 0, -5).setZ(z);
    for (const [z, kind] of [
      [-3000, 'mbt'],
      [-3100, 'ifv'],
      [-3200, 'truckCargo'],
      [-12000, 'mbt'],
    ] as const) {
      const p = ahead(z);
      createVehicle(sim, kind, p.x, p.z, 0, 1);
    }
    sim.targets.vehicles[1].condition = 'destroyed';
    expect(build(sim).info.vehicleBoxes).toBe(0);
    (sim.options.realism as { hudBoxes: boolean }).hudBoxes = true;
    expect(build(sim).info.vehicleBoxes).toBe(2);
  });

  it('keeps the frame cheap: a full CCRP + sensors frame stays under 1,500 strokes', () => {
    const sim = flight({ pitch: -20, bank: 20 });
    const av = sim.avionics;
    av.spi.valid = true;
    av.spi.position.copy(groundAt(sim, 2, -11));
    av.masterMode = 'CCRP';
    av.sight = 'CCRP';
    av.selectedProfile = 'GBU12';
    av.release.valid = true;
    av.release.timeToRelease = 8;
    av.release.cueEl = 2 * DEG;
    const { info, rec } = build(sim, drawnOf(sim));
    expect(info.segments).toBe(rec.segs.length);
    expect(info.segments).toBeLessThan(1500);
  });
});
