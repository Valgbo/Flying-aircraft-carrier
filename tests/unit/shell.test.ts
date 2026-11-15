import { PerspectiveCamera } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { HOTSPOTS, TURBINE_LABELS, type HotspotId } from '../../src/config/layout';
import { HOVER_THROTTLE, PHYS, WEIGHT } from '../../src/config/physicsConfig';
import {
  BINDING_ORDER,
  DEFAULT_KEY_BINDINGS,
  type BindingId,
  type KeyBindings,
} from '../../src/state/bindings';
import { resetSimForScreen, sim } from '../../src/state/sim';
import {
  GAMEPAD_CHEAT_SHEET,
  KEYBOARD_CHEAT_ROWS,
  TOUCH_CHEAT_SHEET,
  cheatSheetFor,
  keyboardCheatSheet,
} from '../../src/ui/shell/cheatSheet';
import { focusTrapTarget, gridStep, isArrowKey } from '../../src/ui/shell/focusOrder';
import {
  TIME_SLIDER_MAX,
  TIME_SLIDER_STEP,
  formatDeg,
  formatMeganewtons,
  formatMeters,
  formatPercent,
  formatRatio,
  formatSignedDeg,
  formatTimeOfDay,
  rangeFraction,
  snapToStep,
} from '../../src/ui/shell/format';
import {
  HOTSPOT_CONTENT,
  getHotspotContent,
  hotspotIndex,
} from '../../src/ui/shell/hotspotContent';
import {
  PIN_ENTER_INSET,
  PIN_EXIT_INSET,
  clearHotspotProjections,
  hotspotFrame,
  hotspotProjections,
  insideViewport,
  pinScaleForDepth,
  projectHotspots,
  rankByDepth,
  subscribeHotspotFrame,
  type HotspotProjection,
} from '../../src/ui/shell/hotspotProjection';
import { findBindingByCode, findDuplicateBindings, rebind } from '../../src/ui/shell/rebind';
import { MAX_TOTAL_THRUST, liftStateFor, summariseThrust } from '../../src/ui/shell/thrust';

const NBSP = ' ';
const MINUS = '−';

describe('shell: formatting', () => {
  it('formats the time of day as HH:MM and wraps at midnight', () => {
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatTimeOfDay(16.5)).toBe('16:30');
    expect(formatTimeOfDay(9.25)).toBe('09:15');
    expect(formatTimeOfDay(23.999)).toBe('00:00');
    expect(formatTimeOfDay(24)).toBe('00:00');
    expect(formatTimeOfDay(-0.5)).toBe('23:30');
    expect(formatTimeOfDay(Number.NaN)).toBe('--:--');
  });

  it('never shows 24:00 anywhere on the time slider', () => {
    for (let h = 0; h <= TIME_SLIDER_MAX; h += TIME_SLIDER_STEP) {
      expect(formatTimeOfDay(h)).toMatch(/^([01]\d|2[0-3]):(00|15|30|45)$/);
    }
    expect(formatTimeOfDay(TIME_SLIDER_MAX)).toBe('23:45');
  });

  it('formats percentages, degrees, forces, lengths and ratios', () => {
    expect(formatPercent(0.613)).toBe(`61${NBSP}%`);
    expect(formatPercent(1.4)).toBe(`100${NBSP}%`);
    expect(formatPercent(-1)).toBe(`0${NBSP}%`);
    expect(formatDeg(-20)).toBe(`${MINUS}20°`);
    expect(formatDeg(25)).toBe('25°');
    expect(formatSignedDeg(-20)).toBe(`${MINUS}20°`);
    expect(formatSignedDeg(60)).toBe('+60°');
    expect(formatSignedDeg(0.2)).toBe('0°');
    expect(formatMeganewtons(400_000)).toBe(`400${NBSP}MN`);
    expect(formatMeganewtons(1_600_000)).toBe(`1,600${NBSP}MN`);
    expect(formatMeters(38)).toBe(`38${NBSP}m`);
    expect(formatMeters(8.75, 1)).toBe(`8.8${NBSP}m`);
    expect(formatRatio(1.6309)).toBe('1.63×');
  });

  it('snaps slider values onto the step grid and clamps them', () => {
    expect(snapToStep(16.4999999, 0, 24, 0.25)).toBe(16.5);
    expect(snapToStep(61.3, 0, 100, 1)).toBe(61);
    expect(snapToStep(-30, -20, 60, 1)).toBe(-20);
    expect(snapToStep(99, -20, 60, 1)).toBe(60);
    expect(snapToStep(Number.NaN, 5, 10, 1)).toBe(5);
    expect(rangeFraction(0, -20, 60)).toBeCloseTo(0.25, 10);
    expect(rangeFraction(100, 0, 50)).toBe(1);
    expect(rangeFraction(1, 3, 3)).toBe(0);
  });
});

describe('shell: hotspot content', () => {
  it('has a card for every hotspot of the layout, with a title, 2–3 sentences and specs', () => {
    for (const { id } of HOTSPOTS) {
      const content = getHotspotContent(id);
      expect(content.id).toBe(id);
      expect(content.title.length).toBeGreaterThan(3);
      expect(content.kicker.length).toBeGreaterThan(3);
      const sentences = content.description.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(sentences.length).toBeLessThanOrEqual(3);
      expect(content.specs.length).toBeGreaterThanOrEqual(3);
      for (const spec of content.specs) {
        expect(spec.label).not.toBe('');
        expect(spec.value).not.toBe('');
        expect(spec.value).not.toMatch(/NaN|undefined/);
      }
    }
    expect(Object.keys(HOTSPOT_CONTENT).sort()).toEqual(HOTSPOTS.map((h) => h.id).sort());
  });

  it('gives each turbine its own name and the facts of the layout and physics config', () => {
    const titles = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const content = getHotspotContent(`turbine-${i}` as HotspotId);
      titles.add(content.title);
      expect(content.kind).toBe('turbine');
      expect(content.title).toContain(TURBINE_LABELS[i]);
      const values = content.specs.map((s) => s.value).join(' | ');
      expect(values).toContain(`38${NBSP}m`);
      expect(values).toContain(`400${NBSP}MN`);
      expect(values).toContain(`${MINUS}20°`);
      expect(values).toContain('+60°');
      expect(content.description).toMatch(/hover/i);
      expect(content.description).toMatch(/forward/i);
      expect(content.description).toMatch(/turn/i);
    }
    expect(titles.size).toBe(4);
    // port turbines push the bow to starboard when they lean forward, and vice versa
    expect(getHotspotContent('turbine-0').description).toContain('turn to starboard');
    expect(getHotspotContent('turbine-1').description).toContain('turn to port');
  });

  it('maps hotspot ids to their index in HOTSPOTS', () => {
    expect(hotspotIndex(null)).toBe(-1);
    HOTSPOTS.forEach((h, i) => expect(hotspotIndex(h.id)).toBe(i));
  });
});

describe('shell: key rebinding', () => {
  const noDuplicates = (b: KeyBindings) =>
    new Set(BINDING_ORDER.map((id) => b[id])).size === BINDING_ORDER.length;

  it('assigns a free key without touching the other bindings', () => {
    const result = rebind(DEFAULT_KEY_BINDINGS, 'throttleUp', 'KeyI');
    expect(result.changed).toBe(true);
    expect(result.swappedWith).toBeNull();
    expect(result.bindings.throttleUp).toBe('KeyI');
    expect(result.bindings).toEqual({ ...DEFAULT_KEY_BINDINGS, throttleUp: 'KeyI' });
    // the input is not mutated
    expect(DEFAULT_KEY_BINDINGS.throttleUp).toBe('KeyW');
  });

  it('swaps the two bindings when the key is already taken', () => {
    const result = rebind(DEFAULT_KEY_BINDINGS, 'throttleUp', 'KeyA');
    expect(result.swappedWith).toBe('yawLeft');
    expect(result.bindings.throttleUp).toBe('KeyA');
    expect(result.bindings.yawLeft).toBe('KeyW');
    expect(noDuplicates(result.bindings)).toBe(true);
  });

  it('reports no change when the key is already the binding', () => {
    const result = rebind(DEFAULT_KEY_BINDINGS, 'cycleCamera', 'KeyC');
    expect(result.changed).toBe(false);
    expect(result.bindings).toBe(DEFAULT_KEY_BINDINGS);
  });

  it('never produces a duplicate, whatever sequence of rebinds is applied', () => {
    const codes = [...Object.values(DEFAULT_KEY_BINDINGS), 'KeyI', 'KeyK', 'ShiftLeft', 'Digit1'];
    let bindings: KeyBindings = { ...DEFAULT_KEY_BINDINGS };
    let seed = 12345;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 400; i++) {
      const id: BindingId = BINDING_ORDER[next(BINDING_ORDER.length)];
      bindings = rebind(bindings, id, codes[next(codes.length)]).bindings;
      expect(noDuplicates(bindings)).toBe(true);
    }
    expect(findDuplicateBindings(bindings).size).toBe(0);
  });

  it('finds bindings by key and flags duplicates in tables it did not produce', () => {
    expect(findBindingByCode(DEFAULT_KEY_BINDINGS, 'Space')).toBe('launchJet');
    expect(findBindingByCode(DEFAULT_KEY_BINDINGS, 'Space', 'launchJet')).toBeNull();
    expect(findBindingByCode(DEFAULT_KEY_BINDINGS, 'F13')).toBeNull();
    expect(findDuplicateBindings(DEFAULT_KEY_BINDINGS).size).toBe(0);
    const clash: KeyBindings = { ...DEFAULT_KEY_BINDINGS, resetFlight: 'KeyW' };
    expect([...findDuplicateBindings(clash)].sort()).toEqual(['resetFlight', 'throttleUp']);
  });
});

describe('shell: focus order', () => {
  it('wraps Tab at the ends of a focus trap and leaves the middle to the browser', () => {
    expect(focusTrapTarget(5, 4, -1, false)).toBe(0);
    expect(focusTrapTarget(5, 0, -1, true)).toBe(4);
    expect(focusTrapTarget(5, 2, -1, false)).toBeNull();
    expect(focusTrapTarget(5, 2, -1, true)).toBeNull();
    expect(focusTrapTarget(0, -1, -1, false)).toBeNull();
  });

  it('enters the trap at the right end, or next to the element that last had focus', () => {
    expect(focusTrapTarget(5, -1, -1, false)).toBe(0);
    expect(focusTrapTarget(5, -1, -1, true)).toBe(4);
    // a slider blurred itself on pointer release: Tab continues from it
    expect(focusTrapTarget(5, -1, 2, false)).toBe(3);
    expect(focusTrapTarget(5, -1, 2, true)).toBe(1);
    expect(focusTrapTarget(5, -1, 4, false)).toBe(0);
    expect(focusTrapTarget(5, -1, 0, true)).toBe(4);
  });

  it('moves through a vertical list, a single row and a grid with the arrow keys', () => {
    expect(isArrowKey('ArrowUp')).toBe(true);
    expect(isArrowKey('Enter')).toBe(false);
    // list (desktop menu)
    expect(gridStep(0, 'ArrowDown', 4, 1)).toBe(1);
    expect(gridStep(3, 'ArrowDown', 4, 1)).toBe(0);
    expect(gridStep(0, 'ArrowUp', 4, 1)).toBe(3);
    // single row (phone landscape)
    expect(gridStep(3, 'ArrowRight', 4, 4)).toBe(0);
    expect(gridStep(1, 'ArrowDown', 4, 4)).toBe(2);
    // 2 × 2 grid (phone portrait)
    expect(gridStep(0, 'ArrowDown', 4, 2)).toBe(2);
    expect(gridStep(2, 'ArrowDown', 4, 2)).toBe(0);
    expect(gridStep(1, 'ArrowUp', 4, 2)).toBe(3);
    expect(gridStep(1, 'ArrowRight', 4, 2)).toBe(2);
    // ragged last row: column 1 has no item in the last row
    expect(gridStep(1, 'ArrowDown', 5, 2)).toBe(3);
    expect(gridStep(3, 'ArrowDown', 5, 2)).toBe(1);
    // nothing focused yet
    expect(gridStep(-1, 'ArrowDown', 4, 1)).toBe(0);
    expect(gridStep(-1, 'ArrowUp', 4, 1)).toBe(3);
    expect(gridStep(0, 'ArrowDown', 0, 1)).toBe(-1);
  });
});

describe('shell: controls cheat-sheet', () => {
  it('lists every binding exactly once', () => {
    const listed = KEYBOARD_CHEAT_ROWS.flatMap((row) => row.ids);
    expect([...listed].sort()).toEqual([...BINDING_ORDER].sort());
  });

  it('shows the live key names and follows a rebind', () => {
    const rows = keyboardCheatSheet(DEFAULT_KEY_BINDINGS);
    expect(rows[0]).toEqual({ keys: ['W', 'S'], label: 'Climb / descend' });
    const rebound = rebind(DEFAULT_KEY_BINDINGS, 'throttleUp', 'KeyI').bindings;
    expect(keyboardCheatSheet(rebound)[0].keys).toEqual(['I', 'S']);
    expect(cheatSheetFor('gamepad', DEFAULT_KEY_BINDINGS)).toBe(GAMEPAD_CHEAT_SHEET);
    expect(cheatSheetFor('touch', DEFAULT_KEY_BINDINGS)).toBe(TOUCH_CHEAT_SHEET);
    expect(cheatSheetFor('keyboard', DEFAULT_KEY_BINDINGS)).toEqual(rows);
  });
});

describe('shell: thrust readout', () => {
  it('reads a level hover at the hover throttle', () => {
    const thrust = [0, 1, 2, 3].map(() => HOVER_THROTTLE * PHYS.maxThrust);
    const summary = summariseThrust(thrust, [0, 0, 0, 0]);
    expect(summary.totalKN).toBeCloseTo(WEIGHT, 6);
    expect(summary.liftKN).toBeCloseTo(WEIGHT, 6);
    expect(summary.forwardKN).toBeCloseTo(0, 6);
    expect(summary.liftRatio).toBeCloseTo(1, 9);
    expect(summary.state).toBe('hover');
  });

  it('splits tilted thrust into lift and forward push', () => {
    const full = [PHYS.maxThrust, PHYS.maxThrust, PHYS.maxThrust, PHYS.maxThrust];
    const summary = summariseThrust(full, [60, 60, 60, 60]);
    expect(summary.totalKN).toBe(MAX_TOTAL_THRUST);
    expect(summary.liftKN).toBeCloseTo(MAX_TOTAL_THRUST * 0.5, 3);
    expect(summary.forwardKN).toBeCloseTo(MAX_TOTAL_THRUST * Math.sin(Math.PI / 3), 3);
    // 1.63 × weight at full power, but only half of it lifts at 60° of tilt
    expect(summary.state).toBe('sink');
    expect(summariseThrust(full, [0, 0, 0, 0]).state).toBe('climb');
    expect(summariseThrust(full, [-20, -20, -20, -20]).forwardKN).toBeLessThan(0);
  });

  it('classifies lift with a small hover band', () => {
    expect(liftStateFor(1)).toBe('hover');
    expect(liftStateFor(1.019)).toBe('hover');
    expect(liftStateFor(0.981)).toBe('hover');
    expect(liftStateFor(1.03)).toBe('climb');
    expect(liftStateFor(0.97)).toBe('sink');
    expect(liftStateFor(0)).toBe('sink');
  });
});

describe('shell: hotspot projection', () => {
  const viewport = { left: 0, top: 0, width: 1280, height: 720 };

  function cameraAt(x: number, y: number, z: number, lookAtShip: boolean): PerspectiveCamera {
    const camera = new PerspectiveCamera(50, viewport.width / viewport.height, 1, 60000);
    const ship = sim.carrier.position;
    camera.position.set(ship.x + x, ship.y + y, ship.z + z);
    if (lookAtShip) camera.lookAt(ship);
    else camera.lookAt(ship.x + 2 * x, ship.y + 2 * y, ship.z + 2 * z);
    camera.updateMatrixWorld();
    return camera;
  }

  beforeEach(() => {
    resetSimForScreen('hangar');
    clearHotspotProjections();
  });

  it('puts every anchor on screen when the camera looks at the ship', () => {
    projectHotspots(cameraAt(-380, 260, -420, true), viewport);
    expect(hotspotFrame.shipDepth).toBeGreaterThan(500);
    hotspotProjections.forEach((p) => {
      expect(p.visible).toBe(true);
      expect(p.depth).toBeGreaterThan(1);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(viewport.width);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(viewport.height);
    });
    // seen from off the port bow, the port turbines are left of the starboard ones on screen…
    expect(hotspotProjections[0].x).not.toBeCloseTo(hotspotProjections[1].x, 0);
    // …and the forward port turbine is nearer than the aft starboard one
    expect(hotspotProjections[0].depth).toBeLessThan(hotspotProjections[3].depth);
  });

  it('offsets the result by the position of the canvas in the viewport', () => {
    const camera = cameraAt(-380, 260, -420, true);
    projectHotspots(camera, viewport);
    const x0 = hotspotProjections[4].x;
    const y0 = hotspotProjections[4].y;
    projectHotspots(camera, { ...viewport, left: 30, top: 12 });
    expect(hotspotProjections[4].x).toBeCloseTo(x0 + 30, 6);
    expect(hotspotProjections[4].y).toBeCloseTo(y0 + 12, 6);
  });

  it('hides anchors behind the camera and notifies subscribers on every publish', () => {
    let calls = 0;
    const unsubscribe = subscribeHotspotFrame(() => calls++);
    const stamp = hotspotFrame.stamp;
    projectHotspots(cameraAt(-380, 260, -420, false), viewport);
    hotspotProjections.forEach((p) => expect(p.visible).toBe(false));
    projectHotspots(cameraAt(-380, 260, -420, true), viewport);
    clearHotspotProjections();
    hotspotProjections.forEach((p) => expect(p.visible).toBe(false));
    expect(calls).toBe(3);
    expect(hotspotFrame.stamp).toBe(stamp + 3);
    unsubscribe();
    projectHotspots(cameraAt(-380, 260, -420, true), viewport);
    expect(calls).toBe(3);
  });

  it('applies hysteresis at the viewport edge so a pin on the edge cannot flicker', () => {
    expect(PIN_ENTER_INSET).toBeGreaterThan(PIN_EXIT_INSET);
    const x = (PIN_ENTER_INSET + PIN_EXIT_INSET) / 2;
    expect(insideViewport(x, 300, 1280, 720, false)).toBe(false);
    expect(insideViewport(x, 300, 1280, 720, true)).toBe(true);
    expect(insideViewport(-5, 300, 1280, 720, true)).toBe(false);
    expect(insideViewport(640, 720 - x, 1280, 720, false)).toBe(false);
    expect(insideViewport(640, 360, 1280, 720, false)).toBe(true);
  });

  it('ranks pins far to near and scales their markers within limits', () => {
    const at = (depth: number): HotspotProjection => ({ x: 0, y: 0, depth, visible: true });
    const ranks = new Int8Array(4);
    rankByDepth([at(300), at(100), at(500), at(300)], ranks);
    // farthest = 1 … nearest = 4; a tie resolves by index (later = on top), stable from frame to frame
    expect(Array.from(ranks)).toEqual([2, 4, 1, 3]);
    expect(pinScaleForDepth(500, 500)).toBe(1);
    expect(pinScaleForDepth(450, 500)).toBeCloseTo(500 / 450, 10);
    expect(pinScaleForDepth(100, 500)).toBe(1.12);
    expect(pinScaleForDepth(5000, 500)).toBe(0.84);
    expect(pinScaleForDepth(0, 500)).toBe(1);
  });
});
