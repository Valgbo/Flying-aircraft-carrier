/**
 * Multifunction displays (ARCHITECTURE §12.7, PLAN_A10.md §7): page layouts and their OSB labels
 * from the avionics' OSB table, the SOI indication, the stores page from buildDsmsView, the
 * moving map's projection at every scale, the sensor pages following the sensors' state, the
 * messages page, and the redraw scheduling. GPU-free: the pages draw onto a recorder; the
 * renderer is driven with a stand-in WebGL renderer that counts the drawings.
 */
import { Vector3, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildDsmsView,
  createDsmsView,
  OSB_TABLE,
  PAGE_SELECT_OSB,
} from '../../../src/a10/core/avionics';
import type { MfdPage } from '../../../src/a10/core/avionics/types';
import { quaternionFromAttitude } from '../../../src/a10/core/frames';
import type { MaverickSeekerState } from '../../../src/a10/core/sensors/types';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import { NM } from '../../../src/a10/core/units';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { DEG } from '../../../src/a10/view/hud/hudMath';
import {
  createPageInfo,
  drawPage,
  pageInterval,
  pageSignature,
  RedrawSchedule,
} from '../../../src/a10/view/mfd/compose';
import { MessageLog, type PageContext } from '../../../src/a10/view/mfd/context';
import {
  MFD_COLOR,
  MFD_TEXT,
  OSB_ANCHORS,
  SOI_BOX,
  STORE_SHORT,
  TAD,
} from '../../../src/a10/view/mfd/mfdLayout';
import { MfdDisplayRenderer, MfdRenderer } from '../../../src/a10/view/mfd/MfdRenderer';
import { osbActive, osbLabel, osbValue, stationX } from '../../../src/a10/view/mfd/pages';
import { MfdPainter, type ColorSink } from '../../../src/a10/view/mfd/painter';
import { createTadFrame, tadFrame, tadProject } from '../../../src/a10/view/mfd/tad';

const PAGES: MfdPage[] = ['DSMS', 'TGP', 'MAV', 'TAD', 'STAT', 'MSG'];

class Recorder implements ColorSink {
  color = 0;
  segs: number[][] = [];
  seg(x0: number, y0: number, x1: number, y1: number, w: number, i: number): void {
    this.segs.push([x0, y0, x1, y1, w, i, this.color]);
  }
}

function sim0(): Sim {
  const sim = createSim({
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    seed: 2,
    start: { x: 0, z: 0, agl: 2400, heading: 0, speed: 130 },
  });
  return sim;
}

interface Text {
  text: string;
  x: number;
  y: number;
  color: number;
}

function draw(sim: Sim, page: MfdPage, opts: { soi?: boolean; display?: 'L' | 'R' } = {}) {
  const rec = new Recorder();
  const texts: Text[] = [];
  const p = new MfdPainter(rec);
  p.reset(rec, (text, x, y, color) => texts.push({ text, x, y, color }));
  const ctx: PageContext = {
    sim,
    display: opts.display ?? 'L',
    page,
    soi: opts.soi ?? false,
    time: sim.time,
    picture: null,
    dsms: buildDsmsView(sim, createDsmsView()),
    messages: new MessageLog(),
  };
  const info = createPageInfo();
  drawPage(ctx, p, info);
  const find = (t: string) => texts.find((e) => e.text === t);
  return { rec, texts, info, ctx, has: (t: string) => find(t) !== undefined, find };
}

describe('MFD page frame', () => {
  it('gives each OSB its label from the table, at its button', () => {
    const sim = sim0();
    let labelled = 0;
    for (const page of PAGES) {
      const { texts } = draw(sim, page);
      for (let n = 1; n <= 20; n++) {
        const label = osbLabel(sim, page, n, 'L');
        const own = OSB_TABLE[page][n];
        // The label is the table's own (or the page-select row's).
        if (own && typeof own.label === 'string') expect(label).toBe(own.label);
        else if (!own) expect(label).toBe(PAGE_SELECT_OSB[n] ?? '');
        if (!label) continue;
        labelled++;
        const a = OSB_ANCHORS[n];
        const first = label.length > 5 && label.includes(' ') ? label.split(' ')[0] : label;
        const near = texts.find(
          (t) => t.text === first && Math.abs(t.x - a.x) < 1e-9 && Math.abs(t.y - a.y) < 0.1,
        );
        expect(near, `${page} OSB ${n} "${label}"`).toBeDefined();
      }
    }
    expect(labelled).toBeGreaterThanOrEqual(PAGES.length * 5);
  });

  it('prints each OSB live value under its label and boxes the active options', () => {
    const sim = sim0();
    for (const page of PAGES) {
      const { texts, rec } = draw(sim, page);
      for (let n = 1; n <= 20; n++) {
        const a = OSB_ANCHORS[n];
        const value = osbValue(sim, page, n, 'L');
        if (value) {
          const near = texts.find(
            (t) =>
              t.text === value &&
              Math.abs(t.x - a.x) < 1e-9 &&
              Math.abs(t.y - a.y) < 0.2 &&
              t.color === MFD_COLOR.green,
          );
          expect(near, `${page} OSB ${n} value "${value}"`).toBeDefined();
        }
        if (osbActive(sim, page, n, 'L')) {
          const box = rec.segs.filter(
            ([x0, y0, x1, y1, , , c]) =>
              c === MFD_COLOR.green &&
              Math.abs((x0 + x1) / 2 - a.x) < 0.25 &&
              Math.abs((y0 + y1) / 2 - a.y) < 0.15 &&
              (Math.abs(x0 - x1) < 1e-12 || Math.abs(y0 - y1) < 1e-12),
          );
          expect(box.length, `${page} OSB ${n} boxed`).toBeGreaterThanOrEqual(4);
        }
      }
    }
  });

  it('places the OSB labels around the screen, numbered clockwise from the top left', () => {
    // 1–5 top, left to right; 6–10 right, top to bottom; 11–15 bottom, right to left; 16–20 left,
    // bottom to top.
    for (let n = 1; n <= 4; n++) expect(OSB_ANCHORS[n + 1].x).toBeGreaterThan(OSB_ANCHORS[n].x);
    for (let n = 6; n <= 9; n++) expect(OSB_ANCHORS[n + 1].y).toBeLessThan(OSB_ANCHORS[n].y);
    for (let n = 11; n <= 14; n++) expect(OSB_ANCHORS[n + 1].x).toBeLessThan(OSB_ANCHORS[n].x);
    for (let n = 16; n <= 19; n++) expect(OSB_ANCHORS[n + 1].y).toBeGreaterThan(OSB_ANCHORS[n].y);
    expect(OSB_ANCHORS[1].y).toBeGreaterThan(0.8);
    expect(OSB_ANCHORS[13].y).toBeLessThan(-0.8);
    expect(OSB_ANCHORS[8].x).toBeGreaterThan(0.9);
    expect(OSB_ANCHORS[18].x).toBeLessThan(-0.9);
  });

  it('boxes the page shown on the page-select row', () => {
    const sim = sim0();
    for (const page of PAGES) {
      const n = Object.entries(PAGE_SELECT_OSB).find(([, p]) => p === page)?.[0];
      if (!n || OSB_TABLE[page][Number(n)]) continue;
      const a = OSB_ANCHORS[Number(n)];
      const { rec } = draw(sim, page);
      // A box: four strokes around the label's anchor, in green.
      const around = rec.segs.filter(
        ([x0, y0, x1, y1, , , c]) =>
          c === MFD_COLOR.green &&
          Math.abs((x0 + x1) / 2 - a.x) < 0.2 &&
          Math.abs((y0 + y1) / 2 - a.y) < 0.06 &&
          (Math.abs(x0 - x1) < 1e-12 || Math.abs(y0 - y1) < 1e-12),
      );
      expect(around.length, page).toBeGreaterThanOrEqual(4);
    }
  });

  it('draws the SOI box on the sensor of interest and NOT SOI on the other sensor pages', () => {
    const sim = sim0();
    const box = (rec: Recorder) =>
      rec.segs.filter(
        ([x0, y0, x1, y1, w]) =>
          w === 2.2 &&
          [x0, y0, x1, y1].every((v) => Math.abs(Math.abs(v) - SOI_BOX) < 1e-12),
      ).length;
    for (const page of ['TAD', 'TGP', 'MAV'] as MfdPage[]) {
      const soi = draw(sim, page, { soi: true });
      expect(box(soi.rec)).toBe(4);
      expect(soi.has('NOT SOI')).toBe(false);
      const not = draw(sim, page, { soi: false });
      expect(box(not.rec)).toBe(0);
      expect(not.has('NOT SOI')).toBe(true);
    }
    // A page that cannot be the SOI says nothing about it.
    expect(draw(sim, 'DSMS').has('NOT SOI')).toBe(false);
  });
});

describe('MFD stores page (DSMS)', () => {
  it('shows the stations and profiles from buildDsmsView', () => {
    const sim = sim0();
    const v = buildDsmsView(sim, createDsmsView());
    const { has, texts, find } = draw(sim, 'DSMS');
    // Every profile with the stores left.
    for (const pr of v.profiles) expect(has(pr.name), pr.name).toBe(true);
    // Every loaded station: its short name above its place on the row, and how many.
    const n = v.stations.length;
    for (let i = 0; i < n; i++) {
      const s = v.stations[i];
      const x = stationX(i, n);
      expect(texts.some((t) => t.text === String(s.station) && Math.abs(t.x - x) < 1e-9)).toBe(
        true,
      );
      if (!s.store) continue;
      const name = STORE_SHORT[s.store as keyof typeof STORE_SHORT];
      const at = texts.find((t) => t.text === name && Math.abs(t.x - x) < 1e-9);
      expect(at, `station ${s.station} ${s.store}`).toBeDefined();
      const count = s.store.startsWith('LAU-') ? 7 : s.count;
      expect(
        texts.some((t) => t.text === String(count) && Math.abs(t.x - x) < 1e-9 && t.y > at!.y),
      ).toBe(true);
    }
    // The gun and Master Arm.
    expect(has(`GUN ${sim.gun.rounds}/${sim.gun.roundsLoaded} CM`)).toBe(true);
    expect(find('SAFE')?.color).toBe(MFD_COLOR.yellow);
    // The selected profile in green with its settings.
    const sel = v.profiles.find((p) => p.selected);
    expect(sel).toBeDefined();
    expect(find(sel!.name)?.color).toBe(MFD_COLOR.green);
    expect(has(sel!.fuze)).toBe(true);
  });

  it('follows the stores as they change', () => {
    const sim = sim0();
    const before = draw(sim, 'DSMS');
    // Station 5's Mk-82 leaves.
    sim.stores.stations[4].stores.length = 0;
    const after = draw(sim, 'DSMS');
    const x = stationX(4, 11);
    const m82 = (t: { text: string; x: number }) => t.text === 'M82' && Math.abs(t.x - x) < 1e-9;
    expect(before.texts.some(m82)).toBe(true);
    expect(after.texts.some(m82)).toBe(false);
  });
});

describe('MFD moving map (TAD)', () => {
  it('projects own ship and steerpoints correctly at each scale', () => {
    const f = createTadFrame();
    const p = { x: 0, y: 0 };
    const own = { x: 1200, z: -3400 };
    for (const range of TAD.ranges) {
      for (const hdgDeg of [0, 37, 90, 211]) {
        const h = hdgDeg * DEG;
        tadFrame(own.x, own.z, h, range, false, 0, 0, f);
        // Own ship at its depressed anchor.
        tadProject(f, own.x, own.z, p);
        expect(p.x).toBeCloseTo(0, 12);
        expect(p.y).toBeCloseTo(TAD.ownAnchorY, 12);
        // A steerpoint `range` nm straight ahead sits at the top of the screen; half as far,
        // half way up.
        const ahead = (d: number) => [own.x + Math.sin(h) * d * NM, own.z - Math.cos(h) * d * NM];
        let [x, z] = ahead(range);
        tadProject(f, x, z, p);
        expect(p.x).toBeCloseTo(0, 9);
        expect(p.y).toBeCloseTo(1, 9);
        [x, z] = ahead(range / 2);
        tadProject(f, x, z, p);
        expect(p.y).toBeCloseTo(TAD.ownAnchorY + (1 - TAD.ownAnchorY) / 2, 9);
        // One nm off the right wing.
        tadProject(f, own.x + Math.cos(h) * NM, own.z + Math.sin(h) * NM, p);
        expect(p.x).toBeCloseTo((1 - TAD.ownAnchorY) / range, 9);
        expect(p.y).toBeCloseTo(TAD.ownAnchorY, 9);
      }
      // Centred on the SPI: the SPI at the centre, own ship where it is from there.
      tadFrame(own.x, own.z, 0, range, true, own.x, own.z - 2 * NM, f);
      tadProject(f, own.x, own.z - 2 * NM, p);
      expect(p.x).toBeCloseTo(0, 12);
      expect(p.y).toBeCloseTo(0, 12);
      tadProject(f, own.x, own.z, p);
      expect(p.y).toBeCloseTo(-2 / range, 9);
    }
  });

  it('draws own ship, steerpoints and the SPI where the projection puts them', () => {
    const sim = sim0();
    const ac = sim.aircraft;
    ac.position.set(500, 2400, 800);
    ac.heading = 60 * DEG;
    quaternionFromAttitude(ac.heading, 0, 0, ac.orientation);
    const av = sim.avionics;
    av.steerpoints.length = 0;
    av.steerpoints.push({ id: 1, name: 'A', position: new Vector3(500 + 3 * NM, 0, 800) });
    av.steerpoints.push({ id: 2, name: 'B', position: new Vector3(500, 0, 800 - 4 * NM) });
    av.activeSteerpoint = 0;
    av.spi.valid = true;
    av.spi.source = 'STPT';
    av.spi.position.copy(av.steerpoints[0].position);
    const { info, texts } = draw(sim, 'TAD');
    expect(info.tad.ownX).toBeCloseTo(0, 12);
    expect(info.tad.ownY).toBeCloseTo(TAD.ownAnchorY, 12);
    expect(info.tad.steerpoints).toBe(2);
    const f = tadFrame(500, 800, ac.heading, TAD.defaultRange, false, 0, 0, createTadFrame());
    const p = tadProject(f, 500, 800 - 4 * NM, { x: 0, y: 0 });
    expect(texts.some((t) => t.text === '2' && Math.abs(t.x - p.x) < 1e-9)).toBe(true);
    tadProject(f, 500 + 3 * NM, 800, p);
    expect(info.tad.spi).toBe(true);
    expect(info.tad.spiX).toBeCloseTo(p.x, 9);
    expect(info.tad.spiY).toBeCloseTo(p.y, 9);
    expect(texts.some((t) => t.text === `${TAD.defaultRange} NM`)).toBe(true);
  });

  it('marks the target areas only with the realism aid', () => {
    const sim = sim0();
    expect(sim.options.realism.mapMarkers).toBe(false);
    expect(draw(sim, 'TAD').info.tad.targetAreas).toBe(0);
    const marked = createSim({
      terrain: sim.world.terrain,
      scenario: 'empty',
      seed: 2,
      realism: { ...sim.options.realism, mapMarkers: true },
      start: { x: 0, z: 0, agl: 2400, heading: 0, speed: 130 },
    });
    // The flat test world has no target areas: the count is what the terrain lists in range.
    const areas = marked.world.terrain.targetAreas.length;
    expect(draw(marked, 'TAD').info.tad.targetAreas).toBeLessThanOrEqual(areas);
  });
});

describe('MFD sensor pages', () => {
  function seeker(sim: Sim, over: Partial<MaverickSeekerState>): MaverickSeekerState {
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
      contrast: 0.4,
      ...over,
    } as unknown as MaverickSeekerState;
    sim.sensors.mavericks.length = 0;
    sim.sensors.mavericks.push(s);
    sim.sensors.selectedMaverick = 0;
    return s;
  }

  it('the TGP page follows the pod: power, warm-up, track mode, laser, mask', () => {
    const sim = sim0();
    const tgp = sim.sensors.tgp;
    sim.avionics.tgpPower = false;
    expect(draw(sim, 'TGP').info.sensor.status).toBe('TGP OFF');
    sim.avionics.tgpPower = true;
    tgp.warmup = 95;
    let r = draw(sim, 'TGP');
    expect(r.info.sensor.status).toBe('NOT TIMED OUT');
    expect(r.has('1:35')).toBe(true);
    tgp.warmup = 0;
    for (const mode of ['INR', 'AREA', 'POINT'] as const) {
      tgp.mode = mode;
      r = draw(sim, 'TGP');
      expect(r.has(mode)).toBe(true);
      expect(r.info.sensor.gate).toBe(mode === 'INR' ? 'NONE' : mode);
    }
    tgp.fovSetting = 'NARROW';
    tgp.zoom = 2;
    tgp.picture = 'BHOT';
    tgp.pointValid = true;
    tgp.point.set(0, 0, -9 * NM);
    sim.aircraft.position.set(0, 0, 0);
    r = draw(sim, 'TGP');
    expect(r.has('NARO')).toBe(true);
    expect(r.has('2.0X')).toBe(true);
    expect(r.has('BHOT')).toBe(true);
    expect(r.has('T 9.0')).toBe(true);
    // Lasing: L flashes in place of T; the latch and the code.
    tgp.lasing = true;
    tgp.latched = true;
    tgp.laserRange = 5 * NM;
    sim.time = 0;
    r = draw(sim, 'TGP');
    expect(r.has('L 5.0')).toBe(true);
    expect(r.has('LTCH')).toBe(true);
    expect(r.has(String(tgp.laserCode))).toBe(true);
    sim.time = 0.3;
    expect(draw(sim, 'TGP').has('L 5.0')).toBe(false);
    tgp.masked = true;
    r = draw(sim, 'TGP');
    expect(r.has('MASK')).toBe(true);
    expect(r.has('POINT-M')).toBe(true);
    // The pod as SPI generator.
    sim.avionics.spi.valid = true;
    sim.avionics.spi.source = 'TGP';
    expect(draw(sim, 'TGP').has('SPI')).toBe(true);
  });

  it('the MAV page follows the seeker: alignment, pointing cross, lock, range', () => {
    const sim = sim0();
    expect(draw(sim, 'MAV').info.sensor.status).toBe('NO MAV');
    const s = seeker(sim, { align: 130 });
    let r = draw(sim, 'MAV');
    expect(r.info.sensor.status).toBe('NOT TIMED OUT');
    expect(r.has('2:10')).toBe(true);
    expect(r.has('65D')).toBe(true); // station 3 carries AGM-65Ds
    s.align = 0;
    s.gimbalAz = 10 * DEG;
    s.gimbalEl = -8.6 * DEG;
    r = draw(sim, 'MAV');
    expect(r.info.sensor.status).toBe('');
    const k = 0.85 / (35 * DEG);
    expect(r.info.sensor.crossX).toBeCloseTo(10 * DEG * k, 12);
    expect(r.info.sensor.crossY).toBeCloseTo(-8.6 * DEG * k, 12);
    expect(r.info.sensor.gate).toBe('SEARCH');
    // The TRK annunciation at the lower left (an OSB may also be labelled TRK).
    const trk = (texts: Text[]) => texts.some((t) => t.text === 'TRK' && Math.abs(t.x + 0.62) < 1e-9);
    expect(trk(r.texts)).toBe(false);
    s.locked = true;
    r = draw(sim, 'MAV');
    expect(r.info.sensor.gate).toBe('LOCK');
    expect(trk(r.texts)).toBe(true);
    expect(r.has('IN RNG')).toBe(false);
    s.inZone = true;
    expect(draw(sim, 'MAV').has('IN RNG')).toBe(true);
    s.powered = false;
    expect(draw(sim, 'MAV').info.sensor.status).toBe('MAV OFF');
  });
});

describe('MFD messages page', () => {
  it('lists the flight messages, newest first', () => {
    const sim = sim0();
    const rec = new Recorder();
    const texts: Text[] = [];
    const p = new MfdPainter(rec);
    p.reset(rec, (text, x, y, color) => texts.push({ text, x, y, color }));
    const log = new MessageLog(4);
    log.addEvents([
      { type: 'message', t: 61, text: 'MAV NOT LOCKED', level: 'warn' },
      { type: 'switch', t: 62, name: 'osb', value: 'L6' },
      { type: 'message', t: 75, text: 'CCRP INVALID', level: 'info' },
    ]);
    const ctx: PageContext = {
      sim,
      display: 'R',
      page: 'MSG',
      soi: false,
      time: 80,
      picture: null,
      dsms: createDsmsView(),
      messages: log,
    };
    drawPage(ctx, p, createPageInfo());
    const a = texts.find((t) => t.text === '1:15 CCRP INVALID');
    const b = texts.find((t) => t.text === '1:01 MAV NOT LOCKED');
    expect(a && b).toBeTruthy();
    expect(a!.y).toBeGreaterThan(b!.y);
    expect(b!.color).toBe(MFD_COLOR.yellow);
    // The ring keeps the newest.
    for (let k = 0; k < 6; k++) log.add(100 + k, `M${k}`, 'info');
    expect(log.size).toBe(4);
    expect(log.newest(0)?.text).toBe('M5');
    expect(log.newest(3)?.text).toBe('M2');
  });
});

describe('MFD redraw scheduling', () => {
  it('redraws on a page change, at most at its rate, and only when its inputs change', () => {
    const s = new RedrawSchedule();
    expect(s.due(0, 'DSMS', false, 7, 0.1, 1)).toBe(true);
    s.done(0, 'DSMS', false, 7);
    expect(s.due(0.05, 'DSMS', false, 8, 0.1, 1)).toBe(false); // too soon
    expect(s.due(0.2, 'DSMS', false, 7, 0.1, 1)).toBe(false); // unchanged
    expect(s.due(0.2, 'DSMS', false, 8, 0.1, 1)).toBe(true); // changed
    expect(s.due(1.2, 'DSMS', false, 7, 0.1, 1)).toBe(true); // keep-alive
    expect(s.due(0.01, 'TAD', false, 7, 0.1, 1)).toBe(true); // new page at once
    expect(s.due(0.01, 'DSMS', true, 7, 0.1, 1)).toBe(true); // became the SOI
    expect(pageInterval('TGP', 15)).toBeCloseTo(1 / 15, 12);
    expect(pageInterval('TAD', 15)).toBeCloseTo(1 / 15, 12);
  });

  it('a text page signature changes with what it shows and only then', () => {
    const sim = sim0();
    const ctx = draw(sim, 'DSMS').ctx;
    const a = pageSignature(ctx);
    expect(pageSignature(ctx)).toBe(a);
    sim.aircraft.position.x += 100; // not on the DSMS
    expect(pageSignature(ctx)).toBe(a);
    sim.avionics.profiles[0].fuze = sim.avionics.profiles[0].fuze === 'NOSE' ? 'TAIL' : 'NOSE';
    expect(pageSignature(ctx)).not.toBe(a);
    const b = pageSignature(ctx);
    sim.gun.rounds -= 1;
    expect(pageSignature(ctx)).not.toBe(b);
  });

  it('the renderer draws a display only when it is due', () => {
    const sim = sim0();
    let renders = 0;
    const gl = {
      autoClear: true,
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      getClearColor: (c: unknown) => c,
      getClearAlpha: () => 1,
      setClearColor: () => {},
      clear: () => {},
      render: () => {
        renders++;
      },
    } as unknown as WebGLRenderer;
    const d = new MfdDisplayRenderer('L', new MessageLog());
    expect(d.target.width).toBe(512);
    // A text page: once, then not again while nothing changes.
    let t = 0;
    for (let k = 0; k < 30; k++, t += 1 / 60) d.update(gl, sim, 'DSMS', false, t, 15);
    expect(renders).toBe(1);
    sim.avionics.masterArm = 'ARM';
    d.update(gl, sim, 'DSMS', false, (t += 1 / 60), 15);
    expect(renders).toBe(2);
    // A sensor page: at the sensor rate (15 Hz over one second of 60 Hz frames).
    renders = 0;
    for (let k = 0; k < 60; k++, t += 1 / 60) d.update(gl, sim, 'TGP', false, t, 15);
    expect(renders).toBeGreaterThanOrEqual(14);
    expect(renders).toBeLessThanOrEqual(16);
    d.dispose();
    // Both displays share one message log.
    const both = new MfdRenderer();
    expect(both.left.ctx.messages).toBe(both.right.ctx.messages);
    both.dispose();
    expect(MFD_TEXT.label).toBeGreaterThan(0.04);
  });
});
