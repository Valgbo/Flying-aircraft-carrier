/**
 * Hull geometry: the lofted shell (closed, including the elevator bay), the sponsons under
 * the deck edge, the outrigger pylons and the quality-scaled details — all merged into one
 * vertex-coloured BufferGeometry (one draw call). The identity markings are a second, tiny
 * geometry of decal quads.
 */
import type { BufferGeometry, Color } from 'three';
import { ELEVATOR, HULL } from '../../config/layout';
import { DecalBuilder, decalAspect } from './decals';
import { MeshBuilder, v3cross, v3normalize, v3scale, v3sub, type V3 } from './geo';
import {
  BOW_Z,
  HULL_TOP_Y,
  LEVEL,
  LEVEL_COUNT,
  SPONSONS,
  SPONSON_OVERHANG,
  STERN_Z,
  deckEdgeX,
  hullProfile,
  hullSidePoint,
  hullStations,
  keelYAt,
  type Side,
  type Sponson,
} from './hullShape';
import { PAINT } from './paint';
import { addPylons } from './pylons';

/** Plating texture repeats per metre for the projected UVs of all painted ship structure. */
export const PLATING_UV_SCALE = 1 / 40;

/**
 * A closed station ring: starboard levels keel → top, the split point of the hull top, then
 * the port levels top → keel. `colors[j]` paints the band between loop[j] and loop[j + 1]
 * (the last band is the flat bottom back to the start).
 */
interface Ring {
  loop: V3[];
  colors: Color[];
}

const LOOP_SIZE = LEVEL_COUNT * 2 + 1;
const MID = LEVEL_COUNT;

function makeRing(z: number, bay: boolean): Ring {
  const stbd = hullProfile(1, z, bay);
  const port = hullProfile(-1, z);
  // the top is split at the elevator's inboard edge so the bay walls share its vertices
  const mid: V3 = [Math.min(ELEVATOR.minX, stbd[LEVEL.top][0]), HULL_TOP_Y, z];
  const side: Color[] = [
    PAINT.bottom,
    PAINT.bottom,
    PAINT.bootStripe,
    PAINT.hull,
    PAINT.hull,
    PAINT.hull,
    PAINT.hullDark,
  ];
  // inside the bay: floor, the dark hangar opening, and the lintel above it
  const stbdColors = bay
    ? [...side.slice(0, 4), PAINT.walkway, PAINT.recess, PAINT.hullDark]
    : side;
  return {
    loop: [...stbd, mid, ...[...port].reverse()],
    colors: [...stbdColors, PAINT.hullDark, PAINT.hullDark, ...[...side].reverse(), PAINT.bottom],
  };
}

/** Skin two rings (a forward of b). The loop runs counter-clockwise seen from astern, which makes these quads face outward. */
function skin(b: MeshBuilder, fore: Ring, aft: Ring): void {
  for (let j = 0; j < LOOP_SIZE; j++) {
    const k = (j + 1) % LOOP_SIZE;
    b.quad(fore.loop[j], fore.loop[k], aft.loop[k], aft.loop[j], fore.colors[j]);
  }
}

/** Flat end face of the hull (stem face or transom), banded with the side paint. */
function endCap(b: MeshBuilder, ring: Ring, facingAft: boolean): void {
  const s = (i: number): V3 => ring.loop[i];
  const p = (i: number): V3 => ring.loop[LOOP_SIZE - 1 - i];
  const tri = (a: V3, c: V3, d: V3, color: Color): void => {
    if (facingAft) b.tri(a, c, d, color);
    else b.tri(a, d, c, color);
  };
  for (let i = 0; i < LEVEL.shelf; i++) {
    tri(s(i), s(i + 1), p(i + 1), ring.colors[i]);
    tri(s(i), p(i + 1), p(i), ring.colors[i]);
  }
  // top band as a fan that includes the split point, so its upper edge matches the hull top
  const color = ring.colors[LEVEL.shelf];
  tri(p(LEVEL.shelf), s(LEVEL.shelf), s(LEVEL.top), color);
  tri(p(LEVEL.shelf), s(LEVEL.top), ring.loop[MID], color);
  tri(p(LEVEL.shelf), ring.loop[MID], p(LEVEL.top), color);
}

/** Fore or aft wall of the elevator bay: the difference between the full section and the bay section. */
function bayBulkhead(b: MeshBuilder, full: Ring, bay: Ring, facingAft: boolean): void {
  b.polygon(
    [
      full.loop[LEVEL.sill],
      full.loop[LEVEL.knuckle],
      full.loop[LEVEL.shelf],
      full.loop[LEVEL.top],
      full.loop[MID],
      bay.loop[LEVEL.shelf],
      bay.loop[LEVEL.knuckle],
    ],
    PAINT.hullDark,
    [0, 0, facingAft ? 1 : -1],
  );
}

/** The watertight hull shell: sides, flat bottom, top (under the deck), end faces and the elevator bay. */
export function addHullShell(b: MeshBuilder): void {
  const rings: { z: number; bay: boolean; ring: Ring }[] = [];
  for (const z of hullStations()) {
    if (z === ELEVATOR.minZ) {
      rings.push({ z, bay: false, ring: makeRing(z, false) });
      rings.push({ z, bay: true, ring: makeRing(z, true) });
    } else if (z === ELEVATOR.maxZ) {
      rings.push({ z, bay: true, ring: makeRing(z, true) });
      rings.push({ z, bay: false, ring: makeRing(z, false) });
    } else {
      const bay = z > ELEVATOR.minZ && z < ELEVATOR.maxZ;
      rings.push({ z, bay, ring: makeRing(z, bay) });
    }
  }
  endCap(b, rings[0].ring, false);
  for (let i = 1; i < rings.length; i++) {
    const fore = rings[i - 1];
    const aft = rings[i];
    if (fore.z !== aft.z) skin(b, fore.ring, aft.ring);
    else if (aft.bay) bayBulkhead(b, fore.ring, aft.ring, true);
    else bayBulkhead(b, aft.ring, fore.ring, false);
  }
  endCap(b, rings[rings.length - 1].ring, true);
}

/** Section of a sponson at station z; `reach` 0 keeps it inside the hull, 1 is fully out. */
function sponsonSection(sp: Sponson, z: number, reach: number): V3[] {
  const edge = Math.abs(deckEdgeX(sp.side, z));
  const flare = Math.abs(hullSidePoint(sp.side, z, 5.6)[0]) - 1.2;
  const out = edge - 1.6 + (SPONSON_OVERHANG + 1.6) * reach;
  const chine = flare + (edge + 0.3 - flare) * reach;
  const top = HULL_TOP_Y - 0.1;
  const pts: [number, number][] = [
    [edge - 4.5, top],
    [out, top],
    [out, top - 1.3],
    [chine, 6.4],
    [flare, 5.6],
  ];
  return pts.map(([x, y]) => [sp.side * x, y, z] as const);
}

/** Thickness of the non-skid plate on a sponson (thick enough not to z-fight at range). */
const SPONSON_PLATE = 0.2;

function addSponson(b: MeshBuilder, sp: Sponson, detail: number): void {
  const taper = 4;
  b.loft(
    [
      sponsonSection(sp, sp.z0, 0),
      sponsonSection(sp, sp.z0 + taper, 1),
      sponsonSection(sp, sp.z1 - taper, 1),
      sponsonSection(sp, sp.z1, 0),
    ],
    PAINT.hull,
  );
  const top = HULL_TOP_Y - 0.1;
  const za = sp.z0 + taper;
  const zb = sp.z1 - taper;
  const strip = (z: number, in0: number, in1: number, y0: number, y1: number): V3[] => {
    const outer = Math.abs(deckEdgeX(sp.side, z)) + SPONSON_OVERHANG;
    return [
      [sp.side * (outer - in0), y0, z],
      [sp.side * (outer - in1), y0, z],
      [sp.side * (outer - in1), y1, z],
      [sp.side * (outer - in0), y1, z],
    ];
  };
  // non-skid working surface
  b.loft(
    [strip(za, 3.4, 0.3, top, top + SPONSON_PLATE), strip(zb, 3.4, 0.3, top, top + SPONSON_PLATE)],
    PAINT.walkway,
  );
  if (detail >= 1) {
    // bulwark along the outer edge
    b.loft(
      [strip(za, 0.28, 0, top, top + 1.1), strip(zb, 0.28, 0, top, top + 1.1)],
      PAINT.hullDark,
    );
  }
  if (detail >= sp.mountDetail) addDefensiveMount(b, sp, top + SPONSON_PLATE);
}

/** A generic close-in defensive mount: drum base, faceted housing, sensor dome and twin barrels. */
function addDefensiveMount(b: MeshBuilder, sp: Sponson, y: number): void {
  const z = (sp.z0 + sp.z1) / 2;
  const x = sp.side * (Math.abs(deckEdgeX(sp.side, z)) + 0.7);
  b.cylinder([x, y, z], [x, y + 0.8, z], 1.5, 1.35, 12, PAINT.hullDark);
  b.cylinder([x, y + 0.8, z], [x, y + 2.3, z], 1.25, 0.9, 6, PAINT.hull, { smooth: false });
  b.sphere([x, y + 2.35, z], 0.72, 10, 4, PAINT.offWhite, 0);
  for (const dz of [0.36, -0.36]) {
    b.cylinder(
      [x + sp.side * 0.8, y + 1.6, z + dz],
      [x + sp.side * 3.2, y + 2.6, z + dz],
      0.13,
      0.11,
      6,
      PAINT.machineryDark,
    );
  }
}

/** A raised panel on the hull side between two stations and two heights (boat bays, hatches, louvres). */
function hullPanel(
  b: MeshBuilder,
  side: Side,
  z0: number,
  z1: number,
  y0: number,
  y1: number,
  proud: number,
  face: Color,
): void {
  const base: V3[] = [
    hullSidePoint(side, z0, y0),
    hullSidePoint(side, z1, y0),
    hullSidePoint(side, z1, y1),
    hullSidePoint(side, z0, y1),
  ];
  let normal = v3normalize(v3cross(v3sub(base[1], base[0]), v3sub(base[3], base[0])));
  if (normal[0] * side < 0) normal = v3scale(normal, -1);
  b.raisedPanel(base, normal, proud, face, PAINT.hullDark);
}

function addHullDetails(b: MeshBuilder, detail: number): void {
  if (detail < 1) return;
  for (const side of [1, -1] as const) {
    // boat bay amidships and a row of machinery louvres
    hullPanel(b, side, 16, 32, -3.6, 1.2, 0.18, PAINT.recess);
    hullPanel(b, side, 52, 58, -3.2, -0.6, 0.15, PAINT.machineryDark);
    hullPanel(b, side, 62, 68, -3.2, -0.6, 0.15, PAINT.machineryDark);
    // bilge strakes
    const a = hullProfile(side, -44)[LEVEL.bilge];
    const c = hullProfile(side, 104)[LEVEL.bilge];
    b.beam(a, c, 0.4, 1.8, PAINT.bottom, [side * 0.6, -0.8, 0]);
    // ventral fins under the cut-away stern
    const x = side * 8.5;
    const fin: V3[] = [
      [0, HULL.keelY + 0.4, 122],
      [0, HULL.keelY + 0.4, 156],
      [0, keelYAt(158) + 0.5, 158],
    ];
    b.loft(
      [
        fin.map((p) => [x - 0.45, p[1], p[2]] as const),
        fin.map((p) => [x + 0.45, p[1], p[2]] as const),
      ],
      PAINT.bottom,
    );
  }
  // port side has room for a second boat bay where starboard has the elevator
  hullPanel(b, -1, -56, -42, -3.6, 1.2, 0.18, PAINT.recess);
  // transom: stern gallery slot under the deck lip and two exhaust louvres low down
  b.box([-17, 9.7, STERN_Z], [25, 10.9, STERN_Z + 0.2], PAINT.recess);
  for (const x of [-11, 5]) {
    b.box([x, -3.4, STERN_Z], [x + 6, 0.4, STERN_Z + 0.2], PAINT.machineryDark);
  }
  if (detail >= 2) {
    for (const side of [1, -1] as const) {
      hullPanel(b, side, -72, -68, -2.8, 0.6, 0.12, PAINT.hullDark);
      hullPanel(b, side, 38, 42, -2.8, 0.6, 0.12, PAINT.hullDark);
      hullPanel(b, side, 124, 136, -3, -0.4, 0.15, PAINT.machineryDark);
    }
    // sensor pod under the forefoot
    const podZ = BOW_Z + 20;
    b.sphere([0, keelYAt(podZ) + 1.1, podZ], 2.6, 12, 6, PAINT.hullDark);
  }
}

/** Everything painted on the hull mesh: shell, sponsons, pylons and details. */
export function buildHullGeometry(detail: number): BufferGeometry {
  const b = new MeshBuilder(PLATING_UV_SCALE);
  addHullShell(b);
  for (const sp of SPONSONS) addSponson(b, sp, detail);
  addPylons(b, detail);
  addHullDetails(b, detail);
  return b.build();
}

/** The bare shell only (used by the unit tests to prove it is closed). */
export function buildHullShellGeometry(): BufferGeometry {
  const b = new MeshBuilder(PLATING_UV_SCALE);
  addHullShell(b);
  return b.build();
}

/** Where the hull number sits on the bow quarters and the name on the transom. */
const NUMBER_Z0 = -134;
const NUMBER_Z1 = -126;
const NUMBER_Y0 = -4.3;
const NUMBER_Y1 = 2.1;
const NAME_HEIGHT = 3.6;
const NAME_CENTER: readonly [number, number] = [2, 6.6];
const DECAL_LIFT = 0.15;
/** The belly number: the ship flies, so it is identified from below as well. */
const BELLY_NUMBER_Z = -30;
const BELLY_NUMBER_WIDTH = 20;
const BELLY_LIFT = 0.06;

/** Hull number on both bow quarters and under the keel, and the ship's name across the transom. */
export function buildHullDecalGeometry(): BufferGeometry {
  const d = new DecalBuilder();
  for (const side of [1, -1] as const) {
    // seen from outboard, the bow is to the left on the port side and to the right on starboard
    const zLeft = side < 0 ? NUMBER_Z0 : NUMBER_Z1;
    const zRight = side < 0 ? NUMBER_Z1 : NUMBER_Z0;
    d.quad(
      hullSidePoint(side, zLeft, NUMBER_Y0),
      hullSidePoint(side, zRight, NUMBER_Y0),
      hullSidePoint(side, zRight, NUMBER_Y1),
      hullSidePoint(side, zLeft, NUMBER_Y1),
      'number',
      DECAL_LIFT,
    );
  }
  const halfW = (NAME_HEIGHT * decalAspect('name')) / 2;
  const [cx, cy] = NAME_CENTER;
  d.quad(
    [cx - halfW, cy - NAME_HEIGHT / 2, STERN_Z],
    [cx + halfW, cy - NAME_HEIGHT / 2, STERN_Z],
    [cx + halfW, cy + NAME_HEIGHT / 2, STERN_Z],
    [cx - halfW, cy + NAME_HEIGHT / 2, STERN_Z],
    'name',
    DECAL_LIFT,
  );
  // under the flat bottom, upright for an observer below who has the bow at the top:
  // looking up, starboard is on that observer's left
  const bellyW = BELLY_NUMBER_WIDTH / 2;
  const bellyH = BELLY_NUMBER_WIDTH / decalAspect('number') / 2;
  d.quad(
    [bellyW, HULL.keelY, BELLY_NUMBER_Z + bellyH],
    [-bellyW, HULL.keelY, BELLY_NUMBER_Z + bellyH],
    [-bellyW, HULL.keelY, BELLY_NUMBER_Z - bellyH],
    [bellyW, HULL.keelY, BELLY_NUMBER_Z - bellyH],
    'number',
    BELLY_LIFT,
  );
  return d.build();
}
