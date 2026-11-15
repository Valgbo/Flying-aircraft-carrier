/**
 * The four outrigger pylons that carry the turbines: a tapered box-girder arm growing out of
 * a root fairing on the hull side, braced by an under-strut and two diagonal struts, ending
 * in the bearing housing of the tilt pivot.
 *
 * Clearance contract: the duct is a ring of outer radius TURBINE.ductOuterRadius centred on
 * the mount, tilting about the local X axis through it. Its swept volume therefore starts at
 * |x| = |mountX| − ductOuterRadius. The bearing cap ends exactly there, on the tilt axis, and
 * nothing here reaches further outboard.
 */
import { Matrix4 } from 'three';
import { TURBINE_MOUNTS } from '../../config/layout';
import type { MeshBuilder, V3 } from './geo';
import { pylonTipX } from './hullShape';
import { PAINT } from './paint';

/** Start of the arm, well inside the hull so the root never shows a gap. */
const ROOT_X = 14;
const BEARING_RADIUS = 3.3;

interface ArmSection {
  x: number;
  halfLength: number;
  bottom: number;
  top: number;
}

/** Chamfered rectangular section of the arm in the plane x = const (y relative to the tilt axis). */
function sectionRing(s: ArmSection, grow = 0): V3[] {
  const hl = s.halfLength + grow;
  const y0 = s.bottom - grow;
  const y1 = s.top + grow;
  const cz = Math.min(hl * 0.3, 1.6);
  const cy = Math.min((y1 - y0) * 0.22, 1.2);
  return [
    [s.x, y0, -hl + cz],
    [s.x, y0, hl - cz],
    [s.x, y0 + cy, hl],
    [s.x, y1 - cy, hl],
    [s.x, y1, hl - cz],
    [s.x, y1, -hl + cz],
    [s.x, y1 - cy, -hl],
    [s.x, y0 + cy, -hl],
  ];
}

function sectionAt(a: ArmSection, b: ArmSection, x: number): ArmSection {
  const t = (x - a.x) / (b.x - a.x);
  return {
    x,
    halfLength: a.halfLength + (b.halfLength - a.halfLength) * t,
    bottom: a.bottom + (b.bottom - a.bottom) * t,
    top: a.top + (b.top - a.top) * t,
  };
}

/**
 * One pylon in its own frame: +x outboard, y relative to the tilt axis, z relative to the
 * mount with +z pointing away from midships.
 */
function addPylon(b: MeshBuilder, tipX: number, detail: number): void {
  const root: ArmSection = { x: ROOT_X, halfLength: 14, bottom: -4, top: 6.6 };
  const mid: ArmSection = { x: 26, halfLength: 8.2, bottom: -3.4, top: 4.2 };
  const tip: ArmSection = { x: tipX - 3.4, halfLength: 4.3, bottom: -2.7, top: 2.9 };
  b.loft([sectionRing(root), sectionRing(mid), sectionRing(tip)], PAINT.hull, {
    capStart: false,
  });

  // tilt-pivot bearing: housing, clamp collar and the cap that meets the duct on the tilt axis
  b.cylinder(
    [tipX - 4.6, 0, 0],
    [tipX, 0, 0],
    BEARING_RADIUS,
    BEARING_RADIUS,
    20,
    PAINT.machinery,
    {
      capStart: false,
      capColor: PAINT.machineryDark,
    },
  );
  b.cylinder([tipX - 3.9, 0, 0], [tipX - 2.9, 0, 0], 3.9, 3.9, 20, PAINT.hullDark);

  // bracing: a deep strut up from the lower hull and two diagonals in plan
  b.beam([ROOT_X + 1, -7.5, 0], [tipX - 7.5, -2.1, 0], 2.6, 1.7, PAINT.hullDark);
  for (const sz of [1, -1]) {
    b.beam([ROOT_X - 1, -0.5, sz * 21], [tipX - 6.5, 0, sz * 3.4], 1.5, 2.2, PAINT.hullDark);
  }

  if (detail >= 1) {
    // ring frames: the arm reads as a built-up girder rather than a plain box
    for (const x of [30, tipX - 6.5]) {
      const lo = sectionAt(mid, tip, x - 0.35);
      const hi = sectionAt(mid, tip, x + 0.35);
      b.loft([sectionRing(lo, 0.3), sectionRing(hi, 0.3)], PAINT.hullDark);
    }
  }
  if (detail >= 2) {
    // service conduits along the top of the arm
    for (const sz of [1, -1]) {
      const a = sectionAt(mid, tip, 27);
      const c = sectionAt(mid, tip, tipX - 5);
      b.cylinder(
        [a.x, a.top + 0.2, sz * 1.6],
        [c.x, c.top + 0.2, sz * 1.6],
        0.32,
        0.32,
        6,
        PAINT.machinery,
      );
    }
  }
}

export function addPylons(b: MeshBuilder, detail: number): void {
  TURBINE_MOUNTS.forEach((mount, index) => {
    const side = mount[0] >= 0 ? 1 : -1;
    const away = mount[2] >= 0 ? 1 : -1;
    const frame = new Matrix4()
      .makeTranslation(0, mount[1], mount[2])
      .multiply(new Matrix4().makeScale(side, 1, away));
    b.transformed(frame, () => addPylon(b, pylonTipX(index), detail));
  });
}
