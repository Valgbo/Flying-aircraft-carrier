/**
 * HUD module: projection, collimation and clipping math, ladder geometry, range bar, heading
 * tape, text, and the symbology built from a real simulation state (PLAN_A10.md §7, §6.2).
 */
import { PerspectiveCamera, Quaternion, Vector3, Euler } from 'three';
import { describe, expect, it } from 'vitest';
import {
  bodyDirFromHudAngles,
  bodyToWorld,
  hudPlaneFromBodyDir,
  quaternionFromAttitude,
  worldToBody,
} from '../../../src/a10/core/frames';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import { FT, KT, NM } from '../../../src/a10/core/units';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { GAU8 } from '../../../src/a10/data/gun';
import { syncHudCamera } from '../../../src/a10/view/hud/HudRenderer';
import {
  GUN_SIGHT,
  HUD_GLASS,
  HUD_SIZES,
  HUD_WIDTHS,
  computeHudLayout,
} from '../../../src/a10/view/hud/hudLayout';
import {
  DEG,
  TextBuf,
  anglesFromPlane,
  belowGlass,
  bottomEdgeCrossing,
  clampToBox,
  clipSegment,
  clockPoint,
  glassField,
  headingDelta,
  headingLabel,
  headingTapeMarks,
  ladderBasis,
  ladderRungs,
  planeFromAngles,
  planeFromDir,
  rangeBarSweep,
  rayGlassUV,
  rungBend,
  rungDir,
  seenThroughGlass,
  type GlassField,
  type LadderBasis,
  type Vec3Like,
} from '../../../src/a10/view/hud/hudMath';
import {
  GLYPH_H,
  GLYPH_W,
  drawText,
  glyph,
  textWidth,
  type SegmentSink,
} from '../../../src/a10/view/hud/strokeFont';
import { HudSymbology } from '../../../src/a10/view/hud/symbology';

const EYE = A10_GEOMETRY.eye;

function field(eye = EYE): GlassField {
  return glassField(eye, HUD_GLASS, {
    top: 0,
    bottom: 0,
    halfWidthTop: 0,
    halfWidthBottom: 0,
    center: 0,
  });
}

/** Records every segment written. */
class Recorder implements SegmentSink {
  segs: number[][] = [];
  seg(x0: number, y0: number, x1: number, y1: number, w: number, i: number): void {
    this.segs.push([x0, y0, x1, y1, w, i]);
  }
}

describe('HUD projection', () => {
  it('plane coordinates agree with core/frames and round-trip', () => {
    const p = { x: 0, y: 0 };
    const q = { x: 0, y: 0 };
    const a = { az: 0, el: 0 };
    const d = new Vector3();
    for (const [az, el] of [
      [0, 0],
      [3, -2],
      [-7, -14],
      [12, 8],
    ]) {
      planeFromAngles(az * DEG, el * DEG, p);
      expect(hudPlaneFromBodyDir(bodyDirFromHudAngles(az * DEG, el * DEG, d), q)).toBe(true);
      expect(p.x).toBeCloseTo(q.x, 12);
      expect(p.y).toBeCloseTo(q.y, 12);
      anglesFromPlane(p.x, p.y, a);
      expect(a.az / DEG).toBeCloseTo(az, 9);
      expect(a.el / DEG).toBeCloseTo(el, 9);
    }
  });

  it('directions behind the eye do not project', () => {
    const p = { x: 0, y: 0 };
    expect(planeFromDir({ x: 0, y: 0, z: 1 }, p)).toBe(false);
    expect(planeFromDir({ x: 1, y: 0, z: 0 }, p)).toBe(false);
    expect(planeFromDir({ x: 0.1, y: -0.2, z: -2 }, p)).toBe(true);
    expect(p.x).toBeCloseTo(0.05, 12);
    expect(p.y).toBeCloseTo(-0.1, 12);
  });
});

describe('HUD glass and collimation', () => {
  it('the glass field seen from the design eye matches its corners', () => {
    const f = field();
    const a = { az: 0, el: 0 };
    const corner = (i: number) =>
      anglesFromPlane(
        (HUD_GLASS[i].x - EYE.x) / -(HUD_GLASS[i].z - EYE.z),
        (HUD_GLASS[i].y - EYE.y) / -(HUD_GLASS[i].z - EYE.z),
        a,
      );
    expect(f.halfWidthTop).toBeCloseTo((corner(1).az - corner(0).az) / 2, 9);
    expect(f.halfWidthBottom).toBeCloseTo((corner(2).az - corner(3).az) / 2, 9);
    expect(f.top).toBeGreaterThan(0); // the boresight passes just under the top edge
    expect(f.bottom).toBeLessThan(-10 * DEG);
    expect(Math.abs(f.center)).toBeLessThan(0.1 * DEG);
  });

  it('the boresight is seen through the glass; far-off directions are not', () => {
    expect(seenThroughGlass(EYE, { x: 0, y: 0, z: -1 }, HUD_GLASS)).toBe(true);
    const d = new Vector3();
    expect(seenThroughGlass(EYE, bodyDirFromHudAngles(0, -6 * DEG, d), HUD_GLASS)).toBe(true);
    expect(seenThroughGlass(EYE, bodyDirFromHudAngles(0, 5 * DEG, d), HUD_GLASS)).toBe(false);
    expect(seenThroughGlass(EYE, bodyDirFromHudAngles(10 * DEG, -5 * DEG, d), HUD_GLASS)).toBe(
      false,
    );
    expect(belowGlass(EYE, bodyDirFromHudAngles(0, -20 * DEG, d), HUD_GLASS)).toBe(true);
    expect(belowGlass(EYE, bodyDirFromHudAngles(0, -6 * DEG, d), HUD_GLASS)).toBe(false);
    expect(belowGlass(EYE, bodyDirFromHudAngles(0, 5 * DEG, d), HUD_GLASS)).toBe(false);
  });

  it('moving the head slides the glass window over fixed directions', () => {
    // A fixed symbol direction (collimated) crosses the glass at a point that moves with the
    // head: a 5 cm move to the right moves it 5 cm right on the glass (u grows by 5/23.75).
    const dir = { x: 0, y: -0.05, z: -1 };
    const uv0 = { x: 0, y: 0 };
    const uv1 = { x: 0, y: 0 };
    expect(rayGlassUV(EYE, dir, HUD_GLASS, uv0)).toBe(true);
    const moved = { x: EYE.x + 0.05, y: EYE.y, z: EYE.z };
    expect(rayGlassUV(moved, dir, HUD_GLASS, uv1)).toBe(true);
    const width = HUD_GLASS[1].x - HUD_GLASS[0].x;
    expect(uv1.x - uv0.x).toBeCloseTo(0.05 / width, 9);
    expect(uv1.y).toBeCloseTo(uv0.y, 9);
    // Lowering the head hides low symbols under the glass's bottom edge (as with a window,
    // raising it shows lower directions); raising it hides high ones over the top edge.
    const low = { x: EYE.x, y: EYE.y - 0.3, z: EYE.z };
    const high = { x: EYE.x, y: EYE.y + 0.3, z: EYE.z };
    expect(seenThroughGlass(EYE, dir, HUD_GLASS)).toBe(true);
    expect(seenThroughGlass(low, dir, HUD_GLASS)).toBe(false);
    expect(belowGlass(low, dir, HUD_GLASS)).toBe(true);
    expect(seenThroughGlass(high, dir, HUD_GLASS)).toBe(false);
    expect(belowGlass(high, dir, HUD_GLASS)).toBe(false);
  });

  it('the rotation-only HUD camera draws a direction where the world at infinity appears', () => {
    // Cockpit camera: the head, offset and turned, as the camera rig places it.
    const cockpit = new PerspectiveCamera(48, 16 / 9, 0.03, 40);
    cockpit.position.set(EYE.x + 0.12, EYE.y - 0.04, EYE.z + 0.08);
    cockpit.quaternion.setFromEuler(new Euler(-6 * DEG, 9 * DEG, 2 * DEG, 'YXZ'));
    cockpit.zoom = 1.3;
    cockpit.updateProjectionMatrix();
    cockpit.updateMatrixWorld();
    const hud = new PerspectiveCamera();
    syncHudCamera(hud, cockpit, cockpit.quaternion);
    expect(hud.position.length()).toBe(0);
    for (const [az, el] of [
      [0, -2],
      [4, -9],
      [-6, 1],
    ]) {
      const d = bodyDirFromHudAngles(az * DEG, el * DEG, new Vector3());
      // HUD scene: the direction on the plane z = -1.
      const a = new Vector3(d.x / -d.z, d.y / -d.z, -1).project(hud);
      // The same direction 100 km away, seen by the cockpit camera from the offset head.
      const b = cockpit.position.clone().addScaledVector(d, 1e5).project(cockpit);
      expect(a.x).toBeCloseTo(b.x, 4);
      expect(a.y).toBeCloseTo(b.y, 4);
    }
  });

  it('finds where the bottom edge of the glass cuts a fall line', () => {
    const out = { x: 0, y: 0 };
    const f = field();
    const t = bottomEdgeCrossing(
      EYE,
      HUD_GLASS,
      0,
      Math.tan(-3 * DEG),
      0,
      Math.tan(-30 * DEG),
      out,
    );
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(Math.tan(f.bottom), 6);
    // A line that stays inside the glass never meets the edge.
    expect(bottomEdgeCrossing(EYE, HUD_GLASS, 0, -0.05, 0, -0.1, out)).toBe(-1);
  });
});

describe('HUD clipping helpers', () => {
  const box = { left: -1, right: 1, bottom: -1, top: 1 };
  const s = { x0: 0, y0: 0, x1: 0, y1: 0 };

  it('clips segments to a box (Liang–Barsky)', () => {
    expect(clipSegment(-0.5, 0, 0.5, 0, box, s)).toBe(true);
    expect([s.x0, s.x1]).toEqual([-0.5, 0.5]);
    expect(clipSegment(-3, 0, 3, 0, box, s)).toBe(true);
    expect(s.x0).toBeCloseTo(-1, 12);
    expect(s.x1).toBeCloseTo(1, 12);
    expect(clipSegment(0, 0, 2, 2, box, s)).toBe(true);
    expect(s.x1).toBeCloseTo(1, 12);
    expect(s.y1).toBeCloseTo(1, 12);
    expect(clipSegment(2, 2, 3, 0, box, s)).toBe(false);
    expect(clipSegment(-2, 1.5, 2, 1.5, box, s)).toBe(false);
  });

  it('holds a point inside a box and says when it did', () => {
    const p = { x: 0, y: 0 };
    expect(clampToBox(0.2, 0.3, box, p)).toBe(false);
    expect(clampToBox(3, -0.5, box, p)).toBe(true);
    expect(p).toEqual({ x: 1, y: -0.5 });
  });
});

describe('HUD pitch ladder', () => {
  const basis = (): LadderBasis => ({ h: new Vector3(), u: new Vector3(), s: new Vector3() });

  it('puts the 0° rung on the true horizon and every rung at its true elevation', () => {
    const q = quaternionFromAttitude(40 * DEG, 12 * DEG, -35 * DEG, new Quaternion());
    const up = worldToBody(q, new Vector3(0, 1, 0), new Vector3());
    const tvv = bodyDirFromHudAngles(1.5 * DEG, -4 * DEG, new Vector3());
    const b = basis();
    expect(ladderBasis(tvv, up, new Vector3(0, 0, -1), b)).toBe(true);
    const d = { x: 0, y: 0, z: 0 };
    const w = new Vector3();
    for (const p of [0, 5, -10, 30]) {
      for (const a of [-0.04, 0, 0.04]) {
        rungDir(b, p * DEG, a, 0, d);
        bodyToWorld(q, w.set(d.x, d.y, d.z), w);
        if (a === 0) expect(Math.asin(w.y / w.length()) / DEG).toBeCloseTo(p, 9);
        else if (p === 0) expect(w.y / w.length()).toBeCloseTo(0, 12);
      }
    }
    // The ladder is centred on the velocity vector's azimuth: the rung centre lies in the
    // vertical plane through it.
    rungDir(b, 0, 0, 0, d);
    const tvvW = bodyToWorld(q, tvv, new Vector3());
    const cW = bodyToWorld(q, new Vector3(d.x, d.y, d.z), new Vector3());
    expect(Math.atan2(cW.x, -cW.z)).toBeCloseTo(Math.atan2(tvvW.x, -tvvW.z), 9);
  });

  it('rolls with the bank: the horizon rung is tilted by the bank angle in level flight', () => {
    const q = quaternionFromAttitude(0, 0, 30 * DEG, new Quaternion());
    const up = worldToBody(q, new Vector3(0, 1, 0), new Vector3());
    const b = basis();
    ladderBasis(new Vector3(0, 0, -1), up, new Vector3(0, 0, -1), b);
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 0, y: 0 };
    const d = { x: 0, y: 0, z: 0 };
    planeFromDir(rungDir(b, 0, -0.05, 0, d), p0);
    planeFromDir(rungDir(b, 0, 0.05, 0, d), p1);
    // Bank right: the horizon tilts so its right end is higher in the HUD.
    expect(Math.atan2(p1.y - p0.y, p1.x - p0.x) / DEG).toBeCloseTo(30, 6);
  });

  it('chooses rungs around the flight path and bends dive rungs by half the pitch', () => {
    const out = new Int16Array(48);
    const n = ladderRungs(-32, 20, 5, out);
    expect(Array.from(out.slice(0, n))).toEqual([-50, -45, -40, -35, -30, -25, -20, -15]);
    expect(ladderRungs(85, 20, 5, out)).toBe(6); // 65..90
    expect(out[n === 0 ? 0 : 5]).toBe(90);
    expect(rungBend(10)).toBe(0);
    expect(rungBend(-30)).toBeCloseTo(15 * DEG, 12);
  });
});

describe('HUD gun reticle range bar', () => {
  it('sweeps in proportion to slant range, a full circle at 12,000 ft', () => {
    const full = GUN_SIGHT.rangeBarFull;
    expect(full).toBeCloseTo(12000 * FT, 9);
    expect(rangeBarSweep(4000 * FT, full)).toBeCloseTo((2 * Math.PI) / 3, 9);
    expect(rangeBarSweep(0, full)).toBe(0);
    expect(rangeBarSweep(-5, full)).toBe(0);
    expect(rangeBarSweep(2 * full, full)).toBeCloseTo(2 * Math.PI, 12);
  });

  it('runs counter-clockwise from 12 o’clock', () => {
    const p = { x: 0, y: 0 };
    clockPoint(0, 0, 1, 0, p);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(1, 12);
    clockPoint(0, 0, 1, Math.PI / 2, p);
    expect(p.x).toBeCloseTo(-1, 12); // 9 o'clock
    expect(p.y).toBeCloseTo(0, 12);
  });
});

describe('HUD heading tape', () => {
  it('wraps through north and labels tens of degrees, north as 36', () => {
    const marks = new Int16Array(24);
    const offs = new Float32Array(24);
    const n = headingTapeMarks(358, 20, 5, marks, offs);
    expect(Array.from(marks.slice(0, n))).toEqual([340, 345, 350, 355, 0, 5, 10, 15]);
    expect(offs[4]).toBeCloseTo(2, 6);
    expect(headingLabel(0)).toBe(36);
    expect(headingLabel(90)).toBe(9);
    expect(headingLabel(350)).toBe(35);
    expect(headingDelta(10, 350)).toBeCloseTo(20, 12);
    expect(headingDelta(350, 10)).toBeCloseTo(-20, 12);
    expect(headingDelta(180, 0)).toBeCloseTo(180, 12);
  });
});

describe('HUD text', () => {
  it('formats numbers without strings', () => {
    const b = new TextBuf();
    expect(b.clear().int(250).toString()).toBe('250');
    expect(b.clear().int(7, 2).toString()).toBe('07');
    expect(b.clear().int(-40).toString()).toBe('-40');
    expect(b.clear().fixed(4.0, 1).toString()).toBe('4.0');
    expect(b.clear().fixed(12.35, 1).toString()).toBe('12.4');
    expect(b.clear().fixed(0.04, 1).toString()).toBe('0.0');
    expect(b.clear().fixed(-1.25, 2).toString()).toBe('-1.25');
    expect(b.clear().time(155).toString()).toBe('2:35');
    expect(b.clear().time(3725).toString()).toBe('1:02:05');
    expect(b.clear().time(-1).toString()).toBe('--:--');
    expect(b.clear().str('R ').int(1520).toString()).toBe('R 1520');
    expect(b.clear().int(Number.NaN).toString()).toBe('--');
  });

  it('has a stroke glyph for every character the HUD writes', () => {
    const used = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.:/-+ ';
    for (const ch of used) {
      const g = glyph(ch.charCodeAt(0));
      if (ch === ' ') expect(g).toBeNull();
      else expect(g && g.length > 0).toBe(true);
    }
    // Lower case draws as upper case; unknown characters draw as '?'.
    expect(glyph('a'.charCodeAt(0))).toBe(glyph('A'.charCodeAt(0)));
    expect(glyph('~'.charCodeAt(0))).toBe(glyph('?'.charCodeAt(0)));
  });

  it('lays text out inside its box, aligned and rotated', () => {
    const rec = new Recorder();
    const buf = new TextBuf().str('8020');
    const size = 0.012;
    drawText(rec, buf.codes, buf.len, 0.1, 0.2, size, 1);
    const w = textWidth(4, size);
    for (const [x0, y0, x1, y1] of rec.segs) {
      for (const [x, y] of [
        [x0, y0],
        [x1, y1],
      ]) {
        expect(x).toBeGreaterThanOrEqual(0.1 - w - 1e-12);
        expect(x).toBeLessThanOrEqual(0.1 + 1e-12);
        expect(y).toBeGreaterThanOrEqual(0.2 - size / 2 - 1e-12);
        expect(y).toBeLessThanOrEqual(0.2 + size / 2 + 1e-12);
      }
    }
    expect(textWidth(1, GLYPH_H)).toBe(GLYPH_W);
    // Rotated 90°: the baseline runs up the plane.
    const rot = new Recorder();
    drawText(rot, buf.codes, buf.len, 0, 0, size, 0, 1, 1, 0, 1);
    for (const [x0, y0] of rot.segs) {
      expect(y0).toBeGreaterThanOrEqual(-1e-12);
      expect(Math.abs(x0)).toBeLessThanOrEqual(size / 2 + 1e-12);
    }
  });
});

describe('HUD layout', () => {
  it('keeps the fixed symbology inside the glass seen from the design eye', () => {
    const L = computeHudLayout();
    const f = L.field;
    const a = { az: 0, el: 0 };
    for (let k = 0; k < L.lineY.length; k++) {
      for (const x of [L.leftX, L.rightX]) {
        anglesFromPlane(x, L.lineY[k], a);
        expect(a.el).toBeLessThan(f.top);
        expect(a.el).toBeGreaterThan(f.bottom);
        expect(Math.abs(a.az)).toBeLessThan(f.halfWidthBottom);
      }
    }
    anglesFromPlane(0, L.tapeY - HUD_SIZES.tapeMajorTick - 1.1 * DEG, a);
    expect(a.el).toBeGreaterThan(f.bottom);
    expect(L.ladderBox.bottom).toBeCloseTo(L.ladderBandBox.top, 12);
    expect(L.ladderBandBox.right).toBeLessThan(L.ladderBox.right);
  });
});

// ---------------------------------------------------------------------------------------------
// The symbology from a real simulation state
// ---------------------------------------------------------------------------------------------

function flight(opts: { pitch: number; bank?: number; alpha?: number; heading?: number }): Sim {
  const sim = createSim({
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    seed: 3,
    start: { x: 0, z: 0, agl: 8000 * FT, heading: 0, speed: 250 * KT },
  });
  const ac = sim.aircraft;
  const h = (opts.heading ?? 30) * DEG;
  quaternionFromAttitude(h, opts.pitch * DEG, (opts.bank ?? 0) * DEG, ac.orientation);
  ac.heading = h;
  const dir = bodyDirFromHudAngles(0, -(opts.alpha ?? 4) * DEG, new Vector3());
  ac.velocity.copy(dir.applyQuaternion(ac.orientation)).multiplyScalar(130);
  ac.ias = 250 * KT;
  ac.altitude = 8000 * FT;
  ac.position.set(0, 8000 * FT, 0);
  ac.agl = 8000 * FT;
  ac.gLoad = 1;
  ac.maxG = 1;
  return sim;
}

function build(sim: Sim, eye: Vec3Like = EYE) {
  const hud = new HudSymbology(computeHudLayout());
  const rec = new Recorder();
  const texts: { text: string; x: number; y: number }[] = [];
  const info = hud.build(sim, eye, rec, (text, x, y) => texts.push({ text, x, y }));
  return { info: { ...info }, rec, texts, has: (t: string) => texts.some((e) => e.text === t) };
}

describe('HUD symbology (NAV)', () => {
  it('draws the velocity vector along the inertial velocity and the readouts', () => {
    const sim = flight({ pitch: 3, alpha: 4 });
    const { info, has, rec } = build(sim);
    const p = { x: 0, y: 0 };
    planeFromAngles(0, -4 * DEG, p);
    expect(info.tvvX).toBeCloseTo(p.x, 9);
    expect(info.tvvY).toBeCloseTo(p.y, 9);
    expect(info.tvvLimited).toBe(false);
    expect(info.gamma / DEG).toBeCloseTo(-1, 6);
    expect(has('250')).toBe(true); // IAS
    expect(has('8000')).toBe(true); // altitude
    expect(has('1.0G')).toBe(true);
    expect(has('NAV')).toBe(true);
    expect(has('SAFE')).toBe(true);
    expect(has(String(sim.gun.rounds))).toBe(true);
    expect(has('R 8000')).toBe(false); // radar altitude only below 5,000 ft AGL
    expect(info.pipper).toBe(false);
    expect(rec.segs.length).toBeLessThan(1500);
    expect(rec.segs.length).toBe(info.segments);
  });

  it('lays the horizon rung on the true horizon', () => {
    const sim = flight({ pitch: 3, alpha: 4 });
    const { rec } = build(sim);
    // Straight ahead, the horizon is 3° below the boresight (pitch 3°): find the long
    // horizontal strokes at that height.
    const y = Math.tan(-3 * DEG);
    const horizon = rec.segs.filter(
      ([x0, y0, x1, y1]) =>
        Math.abs(y0 - y) < 1e-4 && Math.abs(y1 - y) < 1e-4 && Math.abs(x1 - x0) > 1.5 * DEG,
    );
    expect(horizon.length).toBe(2);
  });

  it('shows the steerpoint block and radar altitude, and flashes it with the alert', () => {
    const sim = flight({ pitch: 0, alpha: 4 });
    sim.aircraft.agl = 1520 * FT;
    // createSim builds the flight's steerpoints; this test flies to its own.
    sim.avionics.steerpoints.length = 0;
    sim.avionics.steerpoints.push({ id: 1, name: 'TGT1', position: new Vector3(0, 0, -4000) });
    sim.avionics.activeSteerpoint = 0;
    const { has } = build(sim);
    expect(has('R 1520')).toBe(true);
    expect(has('TGT1')).toBe(true);
    expect(has((4000 / NM).toFixed(1))).toBe(true);
    sim.aircraft.warnings.altitude = true;
    const seen = [0, 0.13, 0.26, 0.39].map((t) => {
      sim.time = t;
      return build(sim).has('R 1520');
    });
    expect(seen).toContain(true);
    expect(seen).toContain(false);
  });

  it('draws the break-X for the ground-collision warning', () => {
    const sim = flight({ pitch: -20, alpha: 2 });
    expect(build(sim).rec.segs.some((s) => s[4] === HUD_WIDTHS.breakX)).toBe(false);
    sim.aircraft.warnings.pullUp = true;
    const thick = build(sim).rec.segs.filter((s) => s[4] === HUD_WIDTHS.breakX);
    expect(thick.length).toBe(2);
  });
});

describe('HUD symbology (GUNS)', () => {
  function guns(): Sim {
    const sim = flight({ pitch: -30, alpha: 2.5 });
    const av = sim.avionics;
    av.masterMode = 'GUNS';
    av.sight = 'GUN';
    av.masterArm = 'ARM';
    av.gunPac = 'ARM';
    av.gun.valid = true;
    av.gun.pipperAz = 0.4 * DEG;
    av.gun.pipperEl = -2.6 * DEG;
    av.gun.slantRange = 4000 * FT;
    return sim;
  }

  it('puts the pipper at the fire-control direction with its slant range and gun cross', () => {
    const sim = guns();
    const { info, has, rec } = build(sim);
    const p = { x: 0, y: 0 };
    planeFromAngles(0.4 * DEG, -2.6 * DEG, p);
    expect(info.pipper).toBe(true);
    expect(info.pipperX).toBeCloseTo(p.x, 12);
    expect(info.pipperY).toBeCloseTo(p.y, 12);
    expect(info.pipperBelowGlass).toBe(false);
    // The pipper dot.
    expect(
      rec.segs.some(
        ([x0, y0, x1, y1, w]) => w === HUD_WIDTHS.pipper && x0 === x1 && y0 === y1 && x0 === p.x,
      ),
    ).toBe(true);
    expect(has('4.0')).toBe(true);
    expect(has('GUNS')).toBe(true);
    expect(has('ARM')).toBe(true);
    expect(has('PAC')).toBe(true);
    // The gun cross sits on the gun line, 2° below the boresight.
    const gy = Math.tan(-GAU8.gunLineDepression);
    expect(rec.segs.some(([, y0, , y1]) => Math.abs(y0 - gy) < 1e-12 && y1 === y0)).toBe(true);
  });

  it('draws a range bar arc proportional to slant range', () => {
    const sim = guns();
    const R = HUD_SIZES.reticleRadius - HUD_SIZES.rangeBarInset;
    const arcLength = (range: number) => {
      sim.avionics.gun.slantRange = range;
      const { rec } = build(sim);
      return rec.segs
        .filter((s) => s[4] === HUD_WIDTHS.rangeBar)
        .reduce((sum, [x0, y0, x1, y1]) => sum + Math.hypot(x1 - x0, y1 - y0), 0);
    };
    const full = GUN_SIGHT.rangeBarFull;
    expect(arcLength(full / 3) / (2 * Math.PI * R)).toBeCloseTo(1 / 3, 2);
    expect(arcLength(full / 2) / (2 * Math.PI * R)).toBeCloseTo(1 / 2, 2);
  });

  it('annunciates an invalid solution, PAC stages and a safe gun', () => {
    const sim = guns();
    sim.avionics.gun.valid = false;
    let r = build(sim);
    expect(r.has('GUN INVALID')).toBe(true);
    expect(r.info.pipper).toBe(false);
    sim.avionics.gun.valid = true;
    sim.aircraft.pac.active = true;
    sim.aircraft.pac.stage = 1;
    expect(build(sim).has('PAC1')).toBe(true);
    sim.aircraft.pac.stage = 2;
    expect(build(sim).has('PAC2')).toBe(true);
    sim.avionics.gunPac = 'SAFE';
    r = build(sim);
    expect(r.has('GUN SAFE')).toBe(true);
    sim.avionics.gunPac = 'GUNARM';
    expect(build(sim).has('GUN')).toBe(true);
  });

  it('keeps drawing a pipper below the glass (the glass clips it) and reports it', () => {
    const sim = guns();
    sim.avionics.gun.pipperEl = -18 * DEG;
    const { info } = build(sim);
    expect(info.pipper).toBe(true);
    expect(info.pipperBelowGlass).toBe(true);
    // From a head lowered 30 cm the same pipper is below the glass even at -6°.
    sim.avionics.gun.pipperEl = -6 * DEG;
    expect(build(sim).info.pipperBelowGlass).toBe(false);
    expect(build(sim, { x: EYE.x, y: EYE.y - 0.3, z: EYE.z }).info.pipperBelowGlass).toBe(true);
  });

  it('dashes the reticle beyond the range scale', () => {
    const sim = guns();
    const thin = (s: number[]) => s[4] === 1;
    const n0 = build(sim).rec.segs.filter(thin).length;
    sim.avionics.gun.tooFar = true;
    const n1 = build(sim).rec.segs.filter(thin).length;
    expect(n0 - n1).toBe(24); // half of the 48 circle segments
  });
});

describe('HUD symbology (CCIP, CCRP)', () => {
  it('draws the fall line and the delay cue when the bomb pipper is below the glass', () => {
    const sim = flight({ pitch: -30, alpha: 2.5 });
    const av = sim.avionics;
    av.masterMode = 'CCIP';
    av.sight = 'CCIP';
    // A bomb profile (the default load selects its rocket pod first: rockets have no fall line).
    av.selectedProfile = 'MK82LD';
    av.release.valid = true;
    av.release.az = 0;
    av.release.el = -16 * DEG;
    const { info, rec } = build(sim);
    expect(info.pipper).toBe(true);
    expect(info.pipperBelowGlass).toBe(true);
    expect(rec.segs.some((s) => s[4] === 1.6)).toBe(true); // delay cue
    av.release.valid = false;
    av.ccipInvalid = true;
    expect(build(sim).has('CCIP INVALID')).toBe(true);
  });

  it('shows the release countdown in CCRP', () => {
    const sim = flight({ pitch: 2, alpha: 4 });
    const av = sim.avionics;
    av.masterMode = 'CCRP';
    av.sight = 'CCRP';
    av.release.valid = true;
    av.release.az = 2 * DEG;
    av.release.el = -20 * DEG;
    av.release.timeToRelease = 5.2;
    expect(build(sim).has('REL 6')).toBe(true);
    av.release.timeToRelease = 0;
    av.release.timeOfFall = 11.5;
    expect(build(sim).has('TOF 12')).toBe(true);
  });
});
