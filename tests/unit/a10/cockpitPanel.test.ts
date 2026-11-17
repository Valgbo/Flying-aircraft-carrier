/**
 * The A-10C front panel built onto the FlightGear A-10A cockpit (src/a10/view/cockpit: mfcd.ts,
 * displays.ts, ahcp.ts, ufc.ts, clickables.ts): the MFCDs' twenty OSBs each, numbered 1–20
 * clockwise from the top left, every one a pick target whose click queues its `osb` command and
 * whose hover label comes from the avionics' OSB table; the AHCP's switches with explicit
 * command values for left and right clicks; the UFC keys the avionics supports; both display
 * surfaces shown at the MFCD screens; and the panels placed over the A-10A instruments they
 * replace.
 */
import { describe, expect, it } from 'vitest';
import { Box3, Matrix4, Ray, Vector3 } from 'three';
import {
  osbBinding,
  scratchpadLaserCode,
  ufcKey as avionicsUfcKey,
} from '../../../src/a10/core/avionics';
import type { MfdPage } from '../../../src/a10/core/avionics/types';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import {
  AHCP_SWITCHES,
  Ahcp,
  ahcpPosition,
  clickDecor,
  createAhcpDecorState,
  leverAngle,
} from '../../../src/a10/view/cockpit/ahcp';
import {
  ahcpClickId,
  allOsbClickIds,
  allUfcClickIds,
  clickCommand,
  clickHoverText,
  osbClickId,
  parseOsb,
  ufcClickId,
  ufcKeyOf,
  type ClickId,
} from '../../../src/a10/view/cockpit/clickables';
import { COVERED_BY_A10C } from '../../../src/a10/view/cockpit/cockpitModel';
import { createDisplaySurfaces } from '../../../src/a10/view/cockpit/displays';
import {
  MFCD_SIDES,
  MfcdPanels,
  OSB_COUNT,
  OSB_RING,
  mfcdFaceMatrix,
  mfcdScreenCorners,
  osbPlacement,
  pressDepth,
} from '../../../src/a10/view/cockpit/mfcd';
import { AHCP, MFCD, MFCD_MOUNT, UFC } from '../../../src/a10/view/cockpit/panelData';
import {
  HOVER_LABEL,
  hoverLabelLayout,
  pickTarget,
  type PickTarget,
} from '../../../src/a10/view/cockpit/picking';
import {
  COCKPIT_CONTROLS,
  commandForControl,
  createSwitchState,
  type CockpitSwitchState,
} from '../../../src/a10/view/cockpit/switches';
import { UFC_KEYS, Ufc, ufcKey, ufcScratchpadKey } from '../../../src/a10/view/cockpit/ufc';

const metaFiles = import.meta.glob('../../../public/a10/models/a10-meta.json', {
  eager: true,
  import: 'default',
});
const meta = Object.values(metaFiles)[0] as {
  pick: { file: string; node: string; frame: string; box: { min: number[]; max: number[] } }[];
  cockpit: {
    pivots: { node: string }[];
    toggles: { node: string }[];
    models: { node: string }[];
  };
};

const EYE = new Vector3(A10_GEOMETRY.eye.x, A10_GEOMETRY.eye.y, A10_GEOMETRY.eye.z);
const LEFT = 0;
const RIGHT = 2;

function sim(): Sim {
  return createSim({
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    seed: 9,
    start: { x: 0, z: 0, agl: 2000, heading: 0, speed: 130 },
  });
}

function state(patch: Partial<CockpitSwitchState> = {}): CockpitSwitchState {
  return { ...createSwitchState(), ...patch };
}

/** The pick target of every OSB, as the cockpit model builds them. */
function osbTargets(panels: MfcdPanels): PickTarget[] {
  const out: PickTarget[] = [];
  const min = new Vector3();
  const max = new Vector3();
  for (const id of allOsbClickIds()) {
    const o = parseOsb(id);
    if (!o) continue;
    panels.osbBox(o.button, min, max);
    out.push({
      id,
      label: id,
      frame: panels.faces[o.display],
      box: new Box3(min.clone(), max.clone()),
      pad: 0.0015,
    });
  }
  return out;
}

/** A ray from the design eye point toward a BODY point. */
function rayTo(p: Vector3): Ray {
  return new Ray(EYE.clone(), p.clone().sub(EYE).normalize());
}

describe('MFCD option-select buttons', () => {
  it('has twenty per display, five per edge, numbered clockwise from the top left', () => {
    const p = (b: number) => osbPlacement(b);
    // the corners of the numbering
    expect(p(1).edge).toBe(0);
    expect(p(1).x).toBeLessThan(0);
    expect(p(5).x).toBeGreaterThan(0);
    expect(p(6).edge).toBe(1);
    expect(p(6).y).toBeGreaterThan(p(10).y);
    expect(p(11).edge).toBe(2);
    expect(p(11).x).toBeGreaterThan(p(15).x);
    expect(p(16).edge).toBe(3);
    expect(p(16).y).toBeLessThan(p(20).y);
    // clockwise: walking 1 → 20 the angle around the screen centre always decreases
    let last = Math.atan2(p(1).y, p(1).x);
    for (let b = 2; b <= OSB_COUNT; b++) {
      let a = Math.atan2(p(b).y, p(b).x);
      while (a > last) a -= Math.PI * 2;
      expect(last - a, `OSB ${b}`).toBeLessThan(Math.PI / 2);
      last = a;
    }
    // five per edge, evenly at the pitch, centred on each edge, in the band outside the screen
    for (let e = 0; e < 4; e++) {
      const row = Array.from({ length: OSB_COUNT }, (_, i) => p(i + 1)).filter((q) => q.edge === e);
      expect(row.length).toBe(MFCD.osbPerSide);
      const along = row.map((q) => (e % 2 === 0 ? q.x : q.y)).sort((a, b) => a - b);
      for (let i = 1; i < along.length; i++)
        expect(along[i] - along[i - 1]).toBeCloseTo(MFCD.osbPitch, 9);
      expect(along[0] + along[along.length - 1]).toBeCloseTo(0, 9);
      for (const q of row) {
        const r = e % 2 === 0 ? Math.abs(q.y) : Math.abs(q.x);
        expect(r).toBeCloseTo(OSB_RING, 9);
        expect(r - MFCD.osbCap.across / 2).toBeGreaterThan(MFCD.screen / 2);
        expect(r + MFCD.osbCap.across / 2).toBeLessThan(MFCD.bezel / 2);
      }
    }
  });

  it('every OSB of both displays is a pick target that queues its osb command', () => {
    const ids = allOsbClickIds();
    expect(ids.length).toBe(40);
    expect(new Set(ids).size).toBe(40);
    const panels = new MfcdPanels();
    const targets = osbTargets(panels);
    const m = new Matrix4();
    for (const side of MFCD_SIDES) {
      mfcdFaceMatrix(side, m);
      for (let b = 1; b <= OSB_COUNT; b++) {
        const pl = osbPlacement(b);
        // the eye looks at the cap's top: that OSB is hit, not a neighbour
        const top = new Vector3(pl.x, pl.y, MFCD.osbCap.height).applyMatrix4(m);
        const hit = pickTarget(targets, rayTo(top));
        expect(hit?.id, `${side}${b}`).toBe(osbClickId(side, b));
        for (const button of [LEFT, RIGHT])
          expect(clickCommand(hit!.id, button, state())).toEqual({
            type: 'osb',
            display: side,
            button: b,
          });
      }
    }
    // the gaps between neighbours hit nothing twice: each target is hit by its own ray only
    const hits = new Set<string>();
    for (const t of targets) {
      const c = t.box.getCenter(new Vector3()).applyMatrix4(t.frame.matrixWorld);
      hits.add(pickTarget(targets, rayTo(c))!.id);
    }
    expect(hits.size).toBe(40);
    panels.dispose();
  });

  it('labels the hover from the avionics OSB table for the page each display shows', () => {
    const s = sim();
    const pages: MfdPage[] = ['DSMS', 'TGP', 'MAV', 'TAD', 'STAT', 'MSG'];
    const decor = createAhcpDecorState();
    for (const page of pages) {
      s.avionics.mfd.left = page;
      s.avionics.mfd.right = page === 'DSMS' ? 'TAD' : 'DSMS';
      for (let b = 1; b <= OSB_COUNT; b++) {
        const text = clickHoverText(osbClickId('L', b), s, state(), decor);
        expect(text.startsWith(`LEFT MFCD OSB ${b}`)).toBe(true);
        const binding = osbBinding(page, b);
        if (binding) expect(text, `${page} ${b}`).toContain(binding.label);
        else expect(text).toBe(`LEFT MFCD OSB ${b}`);
        const right = osbBinding(s.avionics.mfd.right, b);
        const rtext = clickHoverText(osbClickId('R', b), s, state(), decor);
        expect(rtext.startsWith(`RIGHT MFCD OSB ${b}`)).toBe(true);
        if (right) expect(rtext).toContain(right.label);
      }
    }
    // the page-select row reads the page it selects
    s.avionics.mfd.left = 'DSMS';
    expect(clickHoverText(osbClickId('L', 14), s, state(), decor)).toContain(
      osbBinding('DSMS', 14)?.label ?? '?',
    );
  });

  it('fits every OSB hover label in its box, neither cut nor shrunk', () => {
    // bold 34 px Arial: capitals and digits average ≈ 0.62 em; 0.68 em errs on the wide side
    const charPx = 0.68 * HOVER_LABEL.font;
    const s = sim();
    const decor = createAhcpDecorState();
    let longest = '';
    for (const page of ['DSMS', 'TGP', 'MAV', 'TAD', 'STAT', 'MSG'] as MfdPage[]) {
      s.avionics.mfd.left = page;
      s.avionics.mfd.right = page;
      for (const id of allOsbClickIds()) {
        const text = clickHoverText(id, s, state(), decor);
        if (text.length > longest.length) longest = text;
      }
    }
    const textPx = longest.length * charPx;
    const layout = hoverLabelLayout(textPx);
    expect(layout.font, longest).toBe(HOVER_LABEL.font);
    expect(layout.width).toBeLessThanOrEqual(HOVER_LABEL.width);
    expect(layout.width).toBeGreaterThanOrEqual(textPx + HOVER_LABEL.padding - 1);
    // the wave-1 label (512 px, text centred) cut such a label at both ends
    expect(textPx + HOVER_LABEL.padding, longest).toBeGreaterThan(512);
    // a short label gets a short box (the sprite shows only the box)
    expect(hoverLabelLayout(100).width).toBe(100 + HOVER_LABEL.padding);
    // a label too long even for the canvas is drawn smaller, never cut
    const huge = hoverLabelLayout(3000);
    expect(huge.font).toBeLessThan(HOVER_LABEL.font);
    expect((3000 * huge.font) / HOVER_LABEL.font + HOVER_LABEL.padding).toBeLessThanOrEqual(
      HOVER_LABEL.width,
    );
    expect(huge.width).toBeLessThanOrEqual(HOVER_LABEL.width);
  });

  it('a pressed cap goes in and springs back', () => {
    const panels = new MfcdPanels();
    expect(panels.osbDepth('L', 7)).toBe(0);
    panels.pressOsb('L', 7);
    expect(panels.osbDepth('L', 7)).toBeCloseTo(MFCD.osbTravel, 9);
    expect(panels.osbDepth('L', 8)).toBe(0);
    expect(panels.osbDepth('R', 7)).toBe(0);
    panels.update(MFCD.osbPressTime * 0.5, 0);
    expect(panels.osbDepth('L', 7)).toBeCloseTo(MFCD.osbTravel, 9);
    panels.update(MFCD.osbPressTime * 0.3, 0);
    expect(panels.osbDepth('L', 7)).toBeGreaterThan(0);
    expect(panels.osbDepth('L', 7)).toBeLessThan(MFCD.osbTravel);
    panels.update(MFCD.osbPressTime, 0);
    expect(panels.osbDepth('L', 7)).toBe(0);
    expect(pressDepth(0)).toBe(0);
    panels.dispose();
  });
});

describe('the display surfaces', () => {
  it('shows both screens, square, at the MFCD windows, facing the pilot', () => {
    const added: unknown[] = [];
    const d = createDisplaySurfaces(
      { add: (...o: unknown[]) => added.push(...o) },
      { left: mfcdScreenCorners('L'), right: mfcdScreenCorners('R') },
    );
    expect(added.length).toBe(2);
    for (const s of [d.left, d.right]) {
      expect(s.mesh.visible, s.id).toBe(true);
      expect(s.width).toBeCloseTo(MFCD.screen, 6);
      expect(s.height).toBeCloseTo(MFCD.screen, 6);
      const centre = new Vector3();
      for (const c of s.corners) centre.add(c);
      centre.multiplyScalar(0.25);
      expect(Math.abs(centre.x)).toBeCloseTo(MFCD_MOUNT.x, 3);
      expect(s.normal.dot(EYE.clone().sub(centre).normalize())).toBeGreaterThan(0.85);
    }
    // the left screen is the right one's mirror image, on the left
    expect(d.left.corners[0].x).toBeCloseTo(-d.right.corners[1].x, 9);
    expect(d.left.corners[0].x).toBeLessThan(d.left.corners[1].x);
    expect(d.left.corners[0].y).toBeGreaterThan(d.left.corners[3].y);
    d.left.show(false);
    expect(d.left.mesh.visible).toBe(false);
  });
});

describe('the armament HUD control panel', () => {
  it('has the five live switches as controls and five decorative ones, in two rows', () => {
    expect(AHCP_SWITCHES.filter((s) => s.row === 0).map((s) => s.id)).toEqual([
      'masterArm',
      'gunPac',
      'laserArm',
      'tgpPower',
      'altSource',
    ]);
    expect(AHCP_SWITCHES.filter((s) => s.row === 1).every((s) => !s.live)).toBe(true);
    for (const s of AHCP_SWITCHES.filter((x) => x.live)) {
      const c = COCKPIT_CONTROLS.find((x) => x.id === s.id);
      expect(c?.target.kind, s.id).toBe('ahcp');
    }
    const ids = AHCP_SWITCHES.map((s) => ahcpClickId(s.id));
    expect(new Set(ids).size).toBe(10);
  });

  it('queues explicit values for left and right clicks, as the wave-1 switches did', () => {
    const cases: [ClickId, number, Partial<CockpitSwitchState>][] = [
      ['masterArm', LEFT, { masterArm: 'SAFE' }],
      ['masterArm', RIGHT, { masterArm: 'SAFE' }],
      ['masterArm', LEFT, { masterArm: 'TRAIN' }],
      ['gunPac', LEFT, { gunPac: 'SAFE' }],
      ['gunPac', RIGHT, { gunPac: 'SAFE' }],
      ['laserArm', LEFT, { laserArm: 'SAFE' }],
      ['laserArm', RIGHT, { laserArm: 'ARM' }],
      ['tgpPower', LEFT, { tgpPower: false }],
      ['altSource', LEFT, { altSource: 'RADAR' }],
      ['altSource', RIGHT, { altSource: 'BARO' }],
    ];
    const expected = [
      { type: 'masterArm', value: 'ARM' },
      { type: 'masterArm', value: 'TRAIN' },
      { type: 'masterArm', value: 'ARM' },
      { type: 'gunPac', value: 'GUNARM' },
      { type: 'gunPac', value: 'ARM' },
      { type: 'laserArm', value: 'ARM' },
      { type: 'laserArm', value: 'TRAIN' },
      { type: 'tgpPower', value: true },
      { type: 'altSource', value: 'BARO' },
      { type: 'altSource', value: 'RADAR' },
    ];
    cases.forEach(([id, button, s], i) => {
      expect(clickCommand(id, button, state(s)), `${id} ${button}`).toEqual(expected[i]);
      // the same as the switch table's own rule
      expect(clickCommand(id, button, state(s))).toEqual(
        commandForControl(id as 'masterArm', button, state(s)),
      );
    });
  });

  it('shows the simulation switch positions and flips the decorative ones locally', () => {
    const decor = createAhcpDecorState();
    const def = (id: string) => AHCP_SWITCHES.find((s) => s.id === id)!;
    expect(ahcpPosition(def('masterArm'), state({ masterArm: 'ARM' }), decor)).toBe(0);
    expect(ahcpPosition(def('masterArm'), state({ masterArm: 'SAFE' }), decor)).toBe(1);
    expect(ahcpPosition(def('masterArm'), state({ masterArm: 'TRAIN' }), decor)).toBe(2);
    expect(ahcpPosition(def('gunPac'), state({ gunPac: 'GUNARM' }), decor)).toBe(2);
    expect(ahcpPosition(def('tgpPower'), state({ tgpPower: true }), decor)).toBe(0);
    expect(ahcpPosition(def('altSource'), state({ altSource: 'RADAR' }), decor)).toBe(2);
    // decorative: no command; left moves up, right down; two-way switches toggle
    for (const button of [LEFT, RIGHT])
      expect(clickCommand(ahcpClickId('cicu'), button, state())).toBeNull();
    expect(clickDecor(decor, 'iffcc', RIGHT)).toBe(1);
    expect(clickDecor(decor, 'iffcc', RIGHT)).toBe(2);
    expect(clickDecor(decor, 'iffcc', RIGHT)).toBe(2);
    expect(clickDecor(decor, 'iffcc', LEFT)).toBe(1);
    expect(clickDecor(decor, 'hudNormStby', LEFT)).toBe(1);
    expect(clickDecor(decor, 'hudNormStby', LEFT)).toBe(0);
    expect(clickHoverText(ahcpClickId('iffcc'), sim(), state(), decor)).toBe('IFFCC  TEST');
    // levers: up, centre, down
    expect(leverAngle(0, 3)).toBeGreaterThan(0);
    expect(leverAngle(1, 3)).toBe(0);
    expect(leverAngle(2, 3)).toBeLessThan(0);
    expect(leverAngle(1, 2)).toBeLessThan(0);
  });

  it('puts its switches where the eye can click each one, and the levers follow the state', () => {
    const ahcp = new Ahcp();
    const targets: PickTarget[] = AHCP_SWITCHES.map((s) => {
      const min = new Vector3();
      const max = new Vector3();
      ahcp.switchBox(s.id, min, max);
      return {
        id: ahcpClickId(s.id),
        label: s.label,
        frame: ahcp.frame,
        box: new Box3(min, max),
        pad: 0.002,
      };
    });
    for (const t of targets) {
      const c = t.box.getCenter(new Vector3()).applyMatrix4(t.frame.matrixWorld);
      expect(pickTarget(targets, rayTo(c))?.id).toBe(t.id);
    }
    ahcp.update(state({ masterArm: 'ARM', gunPac: 'GUNARM', tgpPower: true }), 0);
    expect(ahcp.shownPosition('masterArm')).toBe(0);
    expect(ahcp.shownPosition('gunPac')).toBe(2);
    expect(ahcp.shownPosition('tgpPower')).toBe(0);
    expect(ahcp.shownPosition('laserArm')).toBe(1);
    ahcp.dispose();
  });
});

describe('the up-front controller', () => {
  it('steps the steerpoint and the altitude alert; digits and CLR feed the scratchpad', () => {
    expect(clickCommand(ufcClickId('STEER_UP'), LEFT, state())).toEqual({
      type: 'steerpoint',
      dir: 1,
    });
    expect(clickCommand(ufcClickId('STEER_DN'), LEFT, state())).toEqual({
      type: 'steerpoint',
      dir: -1,
    });
    const alt = clickCommand(ufcClickId('ALT_ALRT'), LEFT, state({ altitudeAlert: 0 }));
    expect(alt).toEqual(commandForControl('altitudeAlert', LEFT, state({ altitudeAlert: 0 })));
    expect(alt?.type).toBe('altitudeAlert');
    for (const k of UFC_KEYS) {
      const id = ufcClickId(k.id);
      if (['STEER_UP', 'STEER_DN', 'ALT_ALRT'].includes(k.id)) continue;
      const pad = ufcScratchpadKey(k.id);
      if (pad) expect(clickCommand(id, LEFT, state()), k.id).toEqual({ type: 'ufc', key: pad });
      else expect(clickCommand(id, LEFT, state()), k.id).toBeNull();
      expect(ufcKeyOf(id)).toBe(k.id);
    }
    // the UFC holds the wave-1 altitude-alert control
    expect(COCKPIT_CONTROLS.find((c) => c.id === 'altitudeAlert')?.target).toEqual({
      kind: 'ufc',
      key: 'ALT_ALRT',
    });
  });

  it("names the avionics scratchpad's key for each digit and CLR", () => {
    for (const k of UFC_KEYS) {
      const key = ufcScratchpadKey(k.id);
      if (/^[0-9]$/.test(k.id) || k.id === 'CLR') expect(key, k.id).toBe(k.id);
      else expect(key, k.id).toBeNull();
    }
    // the avionics' own handler takes them: 1-6-8-8 is a laser code, CLR empties the pad
    const s = sim();
    for (const id of ['1', '6', '8', '8'] as const) avionicsUfcKey(s, ufcScratchpadKey(id) ?? '');
    expect(s.avionics.pages.scratchpad).toBe('1688');
    expect(scratchpadLaserCode(s.avionics.pages.scratchpad)).toBe(1688);
    avionicsUfcKey(s, ufcScratchpadKey('CLR') ?? '');
    expect(s.avionics.pages.scratchpad).toBe('');
  });

  it('gives every key its own click box', () => {
    const ufc = new Ufc();
    const targets: PickTarget[] = allUfcClickIds().map((id) => {
      const min = new Vector3();
      const max = new Vector3();
      ufc.keyBox(ufcKeyOf(id)!, min, max);
      return { id, label: id, frame: ufc.frame, box: new Box3(min, max), pad: 0.001 };
    });
    expect(targets.length).toBe(UFC_KEYS.length);
    for (const t of targets) {
      const c = t.box.getCenter(new Vector3()).applyMatrix4(t.frame.matrixWorld);
      expect(pickTarget(targets, rayTo(c))?.id, t.id).toBe(t.id);
    }
    ufc.press('5');
    expect(ufc.keyDepth('5')).toBeCloseTo(UFC.keyTravel, 9);
    ufc.update(1, false, 0);
    expect(ufc.keyDepth('5')).toBe(0);
    expect(ufcKey('MASTER_CAUTION').name).toBe('MASTER CAUTION');
    ufc.dispose();
  });
});

describe('the panels on the A-10A cockpit', () => {
  /** A BODY point → the face frame of a display (x right, y up on the face). */
  function onFace(side: 'L' | 'R', p: Vector3): Vector3 {
    return p.clone().applyMatrix4(mfcdFaceMatrix(side, new Matrix4()).invert());
  }

  it('covers the A-10A standby ADI, AoA gauge, clock and HUD panel knobs with the left MFCD', () => {
    // centres of the covered instruments' moving parts (from the converted model)
    const covered = [
      new Vector3(-0.1915, 0.893, -5.25), // standby ADI
      new Vector3(-0.1815, 0.828, -5.25), // AoA gauge needle
      new Vector3(-0.253, 0.82, -5.25), // clock digits
      new Vector3(-0.261, 0.914, -5.24), // HUD mode selector
      new Vector3(-0.314, 0.874, -5.24), // HUD intensity knob
      new Vector3(-0.192, 0.94, -5.252), // master caution lamp
    ];
    for (const p of covered) {
      const f = onFace('L', p);
      expect(Math.abs(f.x), `${p.toArray()}`).toBeLessThan(MFCD.bezel / 2);
      expect(Math.abs(f.y), `${p.toArray()}`).toBeLessThan(MFCD.bezel / 2);
      expect(f.z).toBeLessThan(0); // behind the face
    }
    for (const n of COVERED_BY_A10C)
      expect(
        meta.cockpit.models.some((m) => m.node === n) ||
          meta.cockpit.toggles.some((t) => t.node === n),
        n,
      ).toBe(true);
  });

  it('keeps the MFCDs clear of the airspeed indicator, altimeter and engine gauges', () => {
    const clear = [
      new Vector3(-0.113, 0.852, -5.23), // airspeed needle hub
      new Vector3(0.1145, 0.84, -5.25), // altimeter needle hub
      new Vector3(0.22, 0.765, -5.232), // left engine fan needle
      new Vector3(0.272, 0.765, -5.232), // right engine fan needle
    ];
    for (const p of clear) {
      const side = p.x < 0 ? 'L' : 'R';
      const f = onFace(side, p);
      const inside = Math.abs(f.x) < MFCD.bezel / 2 && Math.abs(f.y) < MFCD.bezel / 2;
      expect(inside, `${p.toArray()}`).toBe(false);
    }
  });

  it('covers the A-10A armament panel with the AHCP plate', () => {
    const ahcp = new Ahcp();
    const inv = ahcp.frame.matrix.clone().invert();
    const station = meta.pick.filter((p) => /^stn\d+-btn$/.test(p.node));
    expect(station.length).toBe(11);
    for (const p of station) {
      for (const corner of [p.box.min, p.box.max]) {
        const f = new Vector3(corner[0], corner[1], corner[2]).applyMatrix4(inv);
        expect(Math.abs(f.x), p.node).toBeLessThan(AHCP.width / 2);
        expect(Math.abs(f.y), p.node).toBeLessThan(AHCP.height / 2);
        expect(f.z, p.node).toBeLessThan(0.002);
      }
    }
    ahcp.dispose();
  });

  it('moves the master mode control to the stick grip (the A-10C has no panel selector)', () => {
    const t = COCKPIT_CONTROLS.find((x) => x.id === 'masterMode')?.target;
    expect(t?.kind).toBe('meshTop');
    const node = t && t.kind === 'meshTop' ? t.node : '';
    expect(meta.cockpit.pivots.some((p) => p.node === node)).toBe(true);
    expect(clickCommand('masterMode', LEFT, state())).toEqual({
      type: 'masterMode',
      value: 'next',
    });
  });

  it('places the UFC under the HUD glass without raising its lower edge', () => {
    // the UFC's top edge, seen from the eye, stays at or below the A-10A panel's (≈ −10.9°)
    const top = new Vector3(0, UFC.height / 2, 0).applyMatrix4(new Ufc().frame.matrix);
    const el =
      Math.atan2(top.y - EYE.y, Math.hypot(top.x - EYE.x, top.z - EYE.z)) * (180 / Math.PI);
    expect(el).toBeLessThan(-10.7);
  });
});
