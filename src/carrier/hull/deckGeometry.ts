/**
 * Flight-deck geometry:
 *  - the deck surface (top face only, UV-mapped in deck coordinates for the markings texture),
 *  - the deck structure (slab sides and underside, arrestor wires, catapult shuttles and the
 *    quality-scaled deck-edge fittings) merged into one vertex-coloured geometry,
 *  - the elevator platform, which shares the deck material,
 *  - the single light fitting that is instanced for every deck light.
 */
import {
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  ShapeUtils,
  Vector2,
} from 'three';
import { CATAPULTS, DECK, ELEVATOR, type Vec2Tuple } from '../../config/layout';
import { DECK_TEX_STRUCTURE_PATCH, arrestorWires, deckUv, navigationLights } from './deckLayout';
import { MeshBuilder, type V3 } from './geo';
import { PLATING_UV_SCALE } from './hullGeometry';
import {
  BOW_Z,
  HULL_TOP_Y,
  SPONSONS,
  STERN_Z,
  deckEdgeX,
  deckOutlineWithNotch,
  type Side,
} from './hullShape';
import { PAINT } from './paint';

/** The top face of the deck slab at y = DECK.y, with the elevator notch cut out. */
export function buildDeckSurfaceGeometry(): BufferGeometry {
  const outline = deckOutlineWithNotch();
  const faces = ShapeUtils.triangulateShape(
    outline.map((p) => new Vector2(p[0], p[1])),
    [],
  );
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const face of faces) {
    const [a, b, c] = face.map((i) => outline[i]);
    // wind counter-clockwise seen from above so the face points up
    const up = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]) > 0;
    for (const p of up ? [a, b, c] : [a, c, b]) {
      positions.push(p[0], DECK.y, p[1]);
      normals.push(0, 1, 0);
      uvs.push(...deckUv(p[0], p[1]));
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Sides and underside of the deck slab (the top face is the separate textured surface). */
export function addDeckSlab(b: MeshBuilder): void {
  const outline = deckOutlineWithNotch();
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const c = outline[(i + 1) % outline.length];
    // the outline runs clockwise seen from above, so (dz, -dx) points outboard
    const outward: V3 = [c[1] - a[1], 0, -(c[0] - a[0])];
    b.quadFacing(
      [a[0], DECK.y, a[1]],
      [c[0], DECK.y, c[1]],
      [c[0], HULL_TOP_Y, c[1]],
      [a[0], HULL_TOP_Y, a[1]],
      PAINT.hullDark,
      outward,
    );
  }
  b.polygon(
    outline.map((p) => [p[0], HULL_TOP_Y, p[1]] as const),
    PAINT.hullDark,
    [0, -1, 0],
  );
}

/** Cables a few centimetres above the deck, with a sheave housing at each end. */
function addArrestorWires(b: MeshBuilder): void {
  for (const wire of arrestorWires()) {
    b.beam(wire.port, wire.stbd, 0.16, 0.09, PAINT.steel);
    for (const end of [wire.port, wire.stbd]) {
      b.box(
        [end[0] - 0.5, DECK.y, end[2] - 0.5],
        [end[0] + 0.5, DECK.y + 0.2, end[2] + 0.5],
        PAINT.machineryDark,
      );
    }
  }
}

/** The catapult shuttles, parked at the start of each track. */
function addShuttles(b: MeshBuilder): void {
  for (const cat of CATAPULTS) {
    const [x, , z] = cat.start;
    b.box([x - 0.45, DECK.y, z - 0.9], [x + 0.45, DECK.y + 0.18, z + 0.9], PAINT.steel);
  }
}

/** Parts of [lo, hi] that are not covered by any of the `gaps`, in ascending order. */
function subtractIntervals(
  lo: number,
  hi: number,
  gaps: readonly (readonly [number, number])[],
): [number, number][] {
  let spans: [number, number][] = [[lo, hi]];
  for (const [g0, g1] of gaps) {
    const next: [number, number][] = [];
    for (const [a, c] of spans) {
      if (g1 <= a || g0 >= c) next.push([a, c]);
      else {
        if (g0 > a) next.push([a, g0]);
        if (g1 < c) next.push([g1, c]);
      }
    }
    spans = next;
  }
  return spans;
}

/** A rectangular strip hung outboard of a deck-edge point: offsets `o0..o1` along the outward normal, heights `y0..y1`. */
function edgeStrip(
  p: Vec2Tuple,
  n: Vec2Tuple,
  o0: number,
  o1: number,
  y0: number,
  y1: number,
): V3[] {
  return [
    [p[0] + n[0] * o0, y0, p[1] + n[1] * o0],
    [p[0] + n[0] * o1, y0, p[1] + n[1] * o1],
    [p[0] + n[0] * o1, y1, p[1] + n[1] * o1],
    [p[0] + n[0] * o0, y1, p[1] + n[1] * o0],
  ];
}

/** Catwalks with a bulwark along both long sides, interrupted at the elevator and the sponsons. */
function addCatwalks(b: MeshBuilder): void {
  const pts = DECK.outline;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % pts.length];
    if (a[1] === c[1]) continue; // bow and stern edges carry safety nets instead
    const side: Side = a[0] + c[0] >= 0 ? 1 : -1;
    const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const n: Vec2Tuple = [(c[1] - a[1]) / length, -(c[0] - a[0]) / length];
    const gaps: [number, number][] = SPONSONS.filter((sp) => sp.side === side).map((sp) => [
      sp.z0 - 0.5,
      sp.z1 + 0.5,
    ]);
    if (side > 0) gaps.push([ELEVATOR.minZ - 0.5, ELEVATOR.maxZ + 0.5]);
    const zLo = Math.min(a[1], c[1]) + 0.8;
    const zHi = Math.max(a[1], c[1]) - 0.8;
    for (const [z0, z1] of subtractIntervals(zLo, zHi, gaps)) {
      if (z1 - z0 < 3) continue;
      const p0: Vec2Tuple = [deckEdgeX(side, z0), z0];
      const p1: Vec2Tuple = [deckEdgeX(side, z1), z1];
      b.loft(
        [edgeStrip(p0, n, -0.2, 1.4, 11.75, 12), edgeStrip(p1, n, -0.2, 1.4, 11.75, 12)],
        PAINT.walkway,
      );
      b.loft(
        [edgeStrip(p0, n, 1.26, 1.4, 12, 13), edgeStrip(p1, n, 1.26, 1.4, 12, 13)],
        PAINT.hullDark,
      );
    }
  }
}

/** Safety nets angled up and out from the bow and stern edges (they stay within the hull length). */
function addSafetyNets(b: MeshBuilder): void {
  const pts = DECK.outline;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % pts.length];
    if (a[1] !== c[1]) continue;
    const dir = a[1] < 0 ? -1 : 1;
    const reach = Math.abs((dir < 0 ? BOW_Z : STERN_Z) - a[1]);
    const n: Vec2Tuple = [0, dir];
    const x0 = Math.min(a[0], c[0]) + 1;
    const x1 = Math.max(a[0], c[0]) - 1;
    const section = (x: number): V3[] => {
      const p: Vec2Tuple = [x, a[1]];
      // inner edge on the slab side just below deck level, outer edge raised to deck level
      const [inner, outer] = edgeStrip(p, n, 0, reach, DECK.y - 0.55, DECK.y - 0.43);
      return [
        inner,
        [outer[0], DECK.y + 0.02, outer[2]],
        [outer[0], DECK.y + 0.14, outer[2]],
        [inner[0], DECK.y - 0.43, inner[2]],
      ];
    };
    b.loft([section(x0), section(x1)], PAINT.net);
  }
}

/** Whip antennas canted outboard from the catwalks; their tips stay well inside the ducts' reach. */
function addAntennas(b: MeshBuilder, detail: number): void {
  const spots: [Side, number][] = [
    [-1, 16],
    [-1, 48],
    [1, 46],
    [1, -68],
  ];
  if (detail >= 2) spots.push([-1, -26], [-1, 100], [1, 118], [1, 30]);
  for (const [side, z] of spots) {
    const x = deckEdgeX(side, z) + side * 1.1;
    b.box([x - 0.35, 12, z - 0.35], [x + 0.35, 12.7, z + 0.35], PAINT.machinery);
    b.beam([x, 12.7, z], [x + side * 4.9, 17.2, z], 0.14, 0.14, PAINT.offWhite);
  }
}

/** Clusters of life-raft canisters slung outboard of the catwalk bulwark. */
function addLifeRafts(b: MeshBuilder, detail: number): void {
  const spots: [Side, number][] = [
    [-1, 26],
    [-1, 66],
    [1, 2],
    [1, 102],
  ];
  if (detail >= 2) spots.push([-1, 88], [1, 52]);
  for (const [side, z] of spots) {
    const x = deckEdgeX(side, z) + side * 1.85;
    for (let k = 0; k < 4; k++) {
      const zc = z + k * 1.9;
      b.cylinder([x, 12.45, zc - 0.75], [x, 12.45, zc + 0.75], 0.42, 0.42, 8, PAINT.offWhite);
    }
    b.box(
      [Math.min(x, x - side * 0.45) - 0.05, 11.95, z - 1],
      [Math.max(x, x - side * 0.45) + 0.05, 12.08, z + 6.7],
      PAINT.machinery,
    );
  }
}

/** Small brackets that carry the navigation lights. */
function addNavLightBrackets(b: MeshBuilder): void {
  for (const light of navigationLights()) {
    const [x, y, z] = light.position;
    b.box([x - 0.3, y - 0.75, z - 0.3], [x + 0.3, y - 0.12, z + 0.3], PAINT.machineryDark);
  }
}

/** Everything on the deck that is painted structure: slab, wires, shuttles and edge fittings. */
export function buildDeckStructureGeometry(detail: number): BufferGeometry {
  const b = new MeshBuilder(PLATING_UV_SCALE);
  addDeckSlab(b);
  addArrestorWires(b);
  addShuttles(b);
  addNavLightBrackets(b);
  if (detail >= 1) {
    addCatwalks(b);
    addAntennas(b, detail);
    addLifeRafts(b, detail);
  }
  if (detail >= 2) addSafetyNets(b);
  return b.build();
}

/** Just the slab sides and underside (for the unit tests). */
export function buildDeckSlabGeometry(): BufferGeometry {
  const b = new MeshBuilder(PLATING_UV_SCALE);
  addDeckSlab(b);
  return b.build();
}

/** Clearance between the platform and the notch walls, so their faces never coincide. */
const ELEVATOR_GAP = 0.05;
const PLATFORM_THICKNESS = 1.2;

/**
 * The elevator platform in its raised position (the mesh is moved down by the schedule in
 * elevator.ts). The top face continues the deck texture; every other face samples the plain
 * structure patch, so the whole platform is one draw call with the deck material.
 */
export function buildElevatorGeometry(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const plain = deckUv(
    (DECK_TEX_STRUCTURE_PATCH.minX + DECK_TEX_STRUCTURE_PATCH.maxX) / 2,
    (DECK_TEX_STRUCTURE_PATCH.minZ + DECK_TEX_STRUCTURE_PATCH.maxZ) / 2,
  );
  const quad = (corners: readonly V3[], normal: V3, deckMapped: boolean): void => {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = corners[i];
      positions.push(p[0], p[1], p[2]);
      normals.push(normal[0], normal[1], normal[2]);
      uvs.push(...(deckMapped ? deckUv(p[0], p[2]) : plain));
    }
  };
  const box = (min: V3, max: V3, deckTop: boolean): void => {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    quad(
      [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
      [0, 1, 0],
      deckTop,
    );
    quad(
      [
        [x0, y0, z1],
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
      ],
      [0, -1, 0],
      false,
    );
    quad(
      [
        [x1, y0, z1],
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
      ],
      [1, 0, 0],
      false,
    );
    quad(
      [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ],
      [-1, 0, 0],
      false,
    );
    quad(
      [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      [0, 0, 1],
      false,
    );
    quad(
      [
        [x1, y0, z0],
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
      ],
      [0, 0, -1],
      false,
    );
  };
  const x0 = ELEVATOR.minX + ELEVATOR_GAP;
  const x1 = ELEVATOR.maxX - ELEVATOR_GAP;
  const z0 = ELEVATOR.minZ + ELEVATOR_GAP;
  const z1 = ELEVATOR.maxZ - ELEVATOR_GAP;
  const underside = ELEVATOR.topY - PLATFORM_THICKNESS;
  box([x0, underside, z0], [x1, ELEVATOR.topY, z1], true);
  // two deep girders under the outboard part, which overhangs the hull side
  for (const z of [ELEVATOR.minZ + 5.5, ELEVATOR.maxZ - 5.5]) {
    box([x0 + 5.6, underside - 1.5, z - 0.5], [x1 - 0.4, underside, z + 0.5], false);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

/** One deck light fitting: a low hexagonal puck centred on its origin. */
export function buildLightFittingGeometry(): BufferGeometry {
  return new CylinderGeometry(0.22, 0.3, 0.14, 6);
}
