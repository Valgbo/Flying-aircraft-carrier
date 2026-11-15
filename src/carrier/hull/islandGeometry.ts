/**
 * Island (command superstructure) geometry on the ISLAND footprint: a tapered base block, a
 * flared navigation bridge whose window band wraps the forward end, a taller aft block that
 * carries the enclosed sensor mast, the flight-control gallery on the port side, and the
 * rotating search radar on the bridge roof.
 *
 * The bridge is laid out around ISLAND.bridgeEye: the eye sits 1.8 m above the bridge floor,
 * more than a metre inside the port and forward glass, with nothing else near it. The forward
 * port corner is cut back into one wide pane square in front of the bridge camera, whose
 * default sight line passes through its middle between two thin corner posts. The glass is a
 * separate single-sided mesh (invisible from inside), and the room has grey inward faces
 * everywhere except the window band, so the bridge camera looks out through a lit frame.
 */
import { Color, Matrix4, type BufferGeometry } from 'three';
import { DECK, ISLAND } from '../../config/layout';
import { PALETTE } from '../../config/palette';
import { DEG2RAD } from '../../utils/math';
import { DecalBuilder, decalAspect } from './decals';
import { MeshBuilder, v3cross, v3lerp, v3normalize, v3scale, v3sub, type V3 } from './geo';
import { PLATING_UV_SCALE } from './hullGeometry';
import { PAINT } from './paint';

const X0 = ISLAND.centerX - ISLAND.width / 2;
const X1 = ISLAND.centerX + ISLAND.width / 2;
const Z0 = ISLAND.centerZ - ISLAND.length / 2;
const Z1 = ISLAND.centerZ + ISLAND.length / 2;
const BASE_Y = DECK.y;
const ROOF_Y = DECK.y + ISLAND.height;
const MAST_TOP_Y = DECK.y + ISLAND.mastHeight;
const [EYE_X, EYE_Y, EYE_Z] = ISLAND.bridgeEye;

/** Levels of the bridge, all tied to the eye point. */
const SHOULDER_Y = EYE_Y - 5.5;
const CHINE_Y = EYE_Y - 2.4;
const FLOOR_Y = EYE_Y - 1.8;
const SILL_Y = EYE_Y - 1.4;
const HEAD_Y = EYE_Y + 1.4;
const CEILING_Y = EYE_Y + 1.5;
const BRIDGE_ROOF_Y = EYE_Y + 2.6;

/** No window mullion stands closer than this (in plan) to the bridge eye point. */
const EYE_CLEARANCE = 2.4;
/** Default sight line of the bridge camera: this far to port of dead ahead (BRIDGE_VIEW.yaw). */
const SIGHT_YAW = 13 * DEG2RAD;
/** The pane in front of the eye reaches this far to either side of the sight line. */
const PANE_HALF_ANGLE = 40 * DEG2RAD;

/** How far the base block's walls lean in between the deck and the shoulder. */
const BASE_LEAN = 2;

const BRIDGE_Z1 = EYE_Z + 15;
/** The aft block starts where the bridge ends, so none of it shows inside the bridge. */
const AFT_Z0 = BRIDGE_Z1 - 1;
const AFT_Z1 = Z1 - 4;
const MAST_Z = (AFT_Z0 + AFT_Z1) / 2 + 1.4;
const MAST_BODY_TOP_Y = ROOF_Y + 11.5;

/** Pivot of the rotating radar (carrier-local): on a pedestal on the bridge roof. */
export const RADAR_PIVOT: V3 = [ISLAND.centerX, BRIDGE_ROOF_Y + 2.4, EYE_Z + 5];

/**
 * Chamfered rectangle at height y. Point order: front edge (port → starboard), starboard
 * side, back edge, port side — so segment i runs from point i to point i + 1.
 */
function octRing(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  cx: number,
  cz: number,
  y: number,
): V3[] {
  return [
    [x0 + cx, y, z0],
    [x1 - cx, y, z0],
    [x1, y, z0 + cz],
    [x1, y, z1 - cz],
    [x1 - cx, y, z1],
    [x0 + cx, y, z1],
    [x0, y, z1 - cz],
    [x0, y, z0 + cz],
  ];
}

/**
 * Outline of the bridge at height y, in the point order of octRing. The forward corners are
 * cut back so that the posts at either end of the port one stand PANE_HALF_ANGLE to the left
 * and right of the bridge camera's sight line — at every height, so each post lies in a
 * vertical plane through the eye. The starboard corner mirrors it.
 */
function bridgeOutline(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  aftCx: number,
  aftCz: number,
  y: number,
): V3[] {
  const cx = EYE_X + (EYE_Z - z0) * Math.tan(PANE_HALF_ANGLE - SIGHT_YAW) - x0;
  const cz = EYE_Z - (EYE_X - x0) / Math.tan(PANE_HALF_ANGLE + SIGHT_YAW) - z0;
  return [
    [x0 + cx, y, z0],
    [x1 - cx, y, z0],
    [x1, y, z0 + cz],
    [x1, y, z1 - aftCz],
    [x1 - aftCx, y, z1],
    [x0 + aftCx, y, z1],
    [x0, y, z1 - aftCz],
    [x0, y, z0 + cz],
  ];
}

/** Ring segments of the bridge that are glazed: the front, both forward chamfers and both sides. */
const GLAZED_SEGMENTS: ReadonlySet<number> = new Set([0, 1, 2, 6, 7]);
/** The forward port chamfer: the undivided pane the bridge camera looks through. */
const EYE_PANE_SEGMENT = 7;

const bridgeChine = bridgeOutline(EYE_X - 1.8, X1 - 0.2, EYE_Z - 3.6, BRIDGE_Z1, 1.6, 2.2, CHINE_Y);
const bridgeRoof = bridgeOutline(
  EYE_X - 0.74,
  X1 - 1.26,
  EYE_Z - 1.98,
  BRIDGE_Z1 - 1,
  1.3,
  1.8,
  BRIDGE_ROOF_Y,
);

/** Outline of the bridge's outer wall at height y (between the chine and the roof). */
function bridgeRing(y: number): V3[] {
  const t = (y - CHINE_Y) / (BRIDGE_ROOF_Y - CHINE_Y);
  return bridgeChine.map((p, i) => v3lerp(p, bridgeRoof[i], t));
}

function addBaseBlock(b: MeshBuilder): void {
  const base = octRing(X0, X1, Z0, Z1, 2, 4, BASE_Y);
  const top = octRing(X0 + BASE_LEAN, X1 - BASE_LEAN, Z0 + 2.5, Z1 - 2.5, 1.4, 3, SHOULDER_Y);
  b.loft([base, top], PAINT.hull, { capStart: false, capColor: PAINT.walkway });
}

function addBridge(b: MeshBuilder, glass: MeshBuilder, detail: number): void {
  const foot = octRing(X0 + BASE_LEAN, X1 - BASE_LEAN, Z0 + 2.5, BRIDGE_Z1 - 1, 1.4, 2, SHOULDER_Y);
  const floor = bridgeRing(FLOOR_Y);
  const sill = bridgeRing(SILL_Y);
  const head = bridgeRing(HEAD_Y);
  const ceiling = bridgeRing(CEILING_Y);
  b.loft([foot, bridgeChine, sill], PAINT.hull, { capStart: false, capEnd: false });
  b.loft([head, bridgeRoof], PAINT.hullDark, { capStart: false, capColor: PAINT.walkway });

  const centreX = (bridgeChine[0][0] + bridgeChine[4][0]) / 2;
  const centreZ = (bridgeChine[0][2] + bridgeChine[4][2]) / 2;
  const posts = new Set<number>();
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    const mid = v3lerp(sill[i], sill[j], 0.5);
    const out: V3 = [mid[0] - centreX, 0, mid[2] - centreZ];
    const inward = v3scale(out, -1);
    if (GLAZED_SEGMENTS.has(i)) {
      glass.quadFacing(sill[i], sill[j], head[j], head[i], PAINT.recess, out);
      posts.add(i).add(j);
      // intermediate mullions
      const length = Math.hypot(sill[j][0] - sill[i][0], sill[j][2] - sill[i][2]);
      const divided = detail >= 1 && i !== EYE_PANE_SEGMENT;
      const panes = divided ? Math.max(1, Math.round(length / 2.4)) : 1;
      for (let k = 1; k < panes; k++) {
        const t = k / panes;
        const foot = v3lerp(sill[i], sill[j], t);
        // keep the surroundings of the bridge camera's eye point open
        if (Math.hypot(foot[0] - EYE_X, foot[2] - EYE_Z) < EYE_CLEARANCE) continue;
        b.beam(foot, v3lerp(head[i], head[j], t), 0.07, 0.12, PAINT.hullDark, out);
      }
    } else {
      b.quadFacing(sill[i], sill[j], head[j], head[i], PAINT.hull, out);
      b.quadFacing(sill[i], sill[j], head[j], head[i], PAINT.interior, inward);
    }
    // inside of the room below the sill and above the window head
    b.quadFacing(floor[i], floor[j], sill[j], sill[i], PAINT.interior, inward);
    b.quadFacing(head[i], head[j], ceiling[j], ceiling[i], PAINT.interior, inward);
  }
  for (const i of posts) {
    const out: V3 = [sill[i][0] - centreX, 0, sill[i][2] - centreZ];
    b.beam(sill[i], head[i], 0.07, 0.07, PAINT.hullDark, out);
  }
  b.polygon(floor, PAINT.interior, [0, 1, 0]);
  b.polygon(ceiling, PAINT.interior, [0, -1, 0]);
}

/** Point on a side wall of the aft block at height y. */
function aftWallPoint(side: 1 | -1, z: number, y: number): V3 {
  const t = (y - SHOULDER_Y) / (ROOF_Y - SHOULDER_Y);
  const foot = side < 0 ? X0 + 2.2 : X1 - 2.2;
  const roof = ISLAND.centerX + side * 2.6;
  return [foot + (roof - foot) * t, y, z];
}

function addAftBlock(b: MeshBuilder, detail: number): void {
  const foot = octRing(X0 + 2.2, X1 - 2.2, AFT_Z0, AFT_Z1, 1.2, 2.5, SHOULDER_Y);
  const roof = octRing(
    ISLAND.centerX - 2.6,
    ISLAND.centerX + 2.6,
    AFT_Z0 + 6,
    AFT_Z1 - 6,
    1,
    2,
    ROOF_Y,
  );
  b.loft([foot, roof], PAINT.hull, { capStart: false, capColor: PAINT.walkway });
  if (detail < 1) return;
  // flat sensor faces on both flanks
  for (const side of [1, -1] as const) {
    const y0 = SHOULDER_Y + 6.4;
    const y1 = ROOF_Y - 1.6;
    const base = [
      aftWallPoint(side, MAST_Z - 5, y0),
      aftWallPoint(side, MAST_Z + 5, y0),
      aftWallPoint(side, MAST_Z + 5, y1),
      aftWallPoint(side, MAST_Z - 5, y1),
    ];
    let normal = v3normalize(v3cross(v3sub(base[1], base[0]), v3sub(base[3], base[0])));
    if (normal[0] * side < 0) normal = v3scale(normal, -1);
    b.raisedPanel(base, normal, 0.16, PAINT.sensor, PAINT.hullDark);
  }
}

function addMast(b: MeshBuilder, detail: number): void {
  const cx = ISLAND.centerX;
  const foot = octRing(cx - 1.9, cx + 1.9, MAST_Z - 3.6, MAST_Z + 3.4, 0.6, 1.2, ROOF_Y);
  const top = octRing(cx - 0.7, cx + 0.7, MAST_Z - 1, MAST_Z + 1, 0.25, 0.4, MAST_BODY_TOP_Y);
  b.loft([foot, top], PAINT.hull, { capStart: false });
  // pole up to the masthead light, and the yard with its obstruction lights
  b.cylinder(
    [cx, MAST_BODY_TOP_Y, MAST_Z],
    [cx, MAST_TOP_Y - 0.8, MAST_Z],
    0.26,
    0.16,
    8,
    PAINT.hullDark,
  );
  b.beam(
    [cx - 5.2, ROOF_Y + 7.5, MAST_Z],
    [cx + 5.2, ROOF_Y + 7.5, MAST_Z],
    0.4,
    0.5,
    PAINT.hullDark,
  );
  // radar pedestal on the bridge roof and the forward radome
  b.cylinder(
    [RADAR_PIVOT[0], BRIDGE_ROOF_Y, RADAR_PIVOT[2]],
    RADAR_PIVOT,
    1.1,
    0.7,
    12,
    PAINT.hullDark,
    { capStart: false },
  );
  const domeZ = AFT_Z0 + 8.6;
  b.cylinder([cx, ROOF_Y, domeZ], [cx, ROOF_Y + 0.9, domeZ], 1.5, 1.3, 12, PAINT.hullDark, {
    capStart: false,
  });
  b.sphere([cx, ROOF_Y + 2.2, domeZ], 1.9, 14, 7, PAINT.offWhite, -0.75);
  if (detail < 1) return;
  // working platform round the mast, aft dome and whip antennas
  b.box(
    [cx - 2.4, ROOF_Y + 3.6, MAST_Z - 3.4],
    [cx + 2.4, ROOF_Y + 3.9, MAST_Z + 3.4],
    PAINT.hullDark,
  );
  b.sphere([cx, ROOF_Y + 0.9, AFT_Z1 - 7.4], 1.2, 12, 6, PAINT.offWhite, -0.5);
  const whips: [number, number, number, number][] = [
    [bridgeRoof[3][0] - 0.5, BRIDGE_ROOF_Y, bridgeRoof[3][2] - 0.5, 0.9],
    [bridgeRoof[6][0] + 0.5, BRIDGE_ROOF_Y, bridgeRoof[6][2] - 0.5, -0.9],
  ];
  if (detail >= 2) {
    whips.push([cx + 2, ROOF_Y, AFT_Z1 - 6.6, 1.2], [cx - 2, ROOF_Y, AFT_Z1 - 6.6, -1.2]);
    // a fixed array bar on the mast front
    b.box(
      [cx - 1.6, ROOF_Y + 5.2, MAST_Z - 3.1],
      [cx + 1.6, ROOF_Y + 6.4, MAST_Z - 2.7],
      PAINT.sensor,
    );
  }
  for (const [x, y, z, lean] of whips) {
    b.beam([x, y, z], [x + lean, y + 7, z], 0.12, 0.12, PAINT.offWhite);
  }
}

/** Flight-control gallery: a faceted bay overlooking the deck from the port side of the aft block. */
function addGallery(b: MeshBuilder, glass: MeshBuilder): void {
  const z0 = AFT_Z0 + 6.5;
  const z1 = AFT_Z0 + 19.5;
  const taper = 1.5;
  const innerX = X0 + 3.3;
  const profile: [number, number][] = [
    [innerX, SHOULDER_Y + 0.5],
    [X0 + 0.3, SHOULDER_Y + 1.8],
    [X0 - 0.6, EYE_Y - 0.8],
    [X0 + 0.2, EYE_Y - 0.1],
    [innerX, EYE_Y + 0.3],
  ];
  const ring = (z: number, reach: number): V3[] =>
    profile.map(([x, y]) => [innerX - (innerX - x) * reach, y, z] as const);
  b.loft([ring(z0, 0.25), ring(z0 + taper, 1), ring(z1 - taper, 1), ring(z1, 0.25)], PAINT.hull);
  // outward-leaning window strip looking down onto the flight deck
  const lower = ring(0, 1)[1];
  const upper = ring(0, 1)[2];
  const at = (z: number, t: number): V3 => {
    const p = v3lerp(lower, upper, t);
    return [p[0], p[1], z];
  };
  const base = [
    at(z0 + taper + 0.4, 0.14),
    at(z1 - taper - 0.4, 0.14),
    at(z1 - taper - 0.4, 0.9),
    at(z0 + taper + 0.4, 0.9),
  ];
  let normal = v3normalize(v3cross(v3sub(base[1], base[0]), v3sub(base[3], base[0])));
  if (normal[0] > 0) normal = v3scale(normal, -1);
  glass.raisedPanel(base, normal, 0.22, PAINT.recess, PAINT.recess);
}

/** The static island: painted structure and the glass of the bridge and the gallery. */
export function buildIslandGeometry(detail: number): {
  structure: BufferGeometry;
  glass: BufferGeometry;
} {
  const b = new MeshBuilder(PLATING_UV_SCALE);
  const glass = new MeshBuilder(PLATING_UV_SCALE);
  addBaseBlock(b);
  addBridge(b, glass, detail);
  addAftBlock(b, detail);
  addMast(b, detail);
  addGallery(b, glass);
  return { structure: b.build(), glass: glass.build() };
}

/** The rotating search radar, modelled about its pivot (the mesh is placed at RADAR_PIVOT). */
export function buildRadarGeometry(): BufferGeometry {
  const b = new MeshBuilder(PLATING_UV_SCALE);
  b.cylinder([0, 0, 0], [0, 1, 0], 0.55, 0.5, 10, PAINT.machinery, { capStart: false });
  // the antenna leans back a little; its flat face is the sensor side
  const lean = new Matrix4().makeTranslation(0, 1, 0).multiply(new Matrix4().makeRotationX(0.2));
  b.transformed(lean, () => {
    b.box([-4.2, 0, -0.28], [4.2, 2.6, 0.28], PAINT.hullDark, { '-z': PAINT.sensor });
    for (const x of [-2.8, 0, 2.8])
      b.box([x - 0.2, 0.2, 0.28], [x + 0.2, 2.4, 0.75], PAINT.machinery);
    b.box([-3, 2.6, -0.14], [3, 2.9, 0.14], PAINT.machinery);
  });
  return b.build();
}

/** Masthead light (white) and the two obstruction lights on the yard (red), coloured per vertex. */
export function buildIslandLightGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  const cx = ISLAND.centerX;
  b.sphere([cx, MAST_TOP_Y - 0.42, MAST_Z], 0.42, 10, 6, new Color(PALETTE.lightWhite));
  for (const dx of [-5.2, 5.2]) {
    b.sphere([cx + dx, ROOF_Y + 8.05, MAST_Z], 0.3, 8, 5, new Color(PALETTE.lightRed));
  }
  return b.build();
}

const NUMBER_HEIGHT = 7.2;
const NUMBER_Y0 = BASE_Y + 4.6;
const NUMBER_Z = ISLAND.centerZ + 13.5;

/** Hull number on both flanks of the base block, readable from either beam. */
export function buildIslandDecalGeometry(): BufferGeometry {
  const d = new DecalBuilder();
  const halfW = (NUMBER_HEIGHT * decalAspect('number')) / 2;
  const y1 = NUMBER_Y0 + NUMBER_HEIGHT;
  for (const side of [1, -1] as const) {
    const wallX = (y: number): number => {
      const lean = (BASE_LEAN * (y - BASE_Y)) / (SHOULDER_Y - BASE_Y);
      return side < 0 ? X0 + lean : X1 - lean;
    };
    // seen from outboard, the bow is to the left on the port side and to the right on starboard
    const zLeft = NUMBER_Z + side * halfW;
    const zRight = NUMBER_Z - side * halfW;
    d.quad(
      [wallX(NUMBER_Y0), NUMBER_Y0, zLeft],
      [wallX(NUMBER_Y0), NUMBER_Y0, zRight],
      [wallX(y1), y1, zRight],
      [wallX(y1), y1, zLeft],
      'number',
      0.12,
    );
  }
  return d.build();
}
