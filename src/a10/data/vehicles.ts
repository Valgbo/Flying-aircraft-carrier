/**
 * Ground vehicle reference data (PLAN_A10.md §9, §6.3, §6.5 and §19): the overall shapes shared
 * by the damage model and the 3D models, public armour estimates, the armour of every class as
 * convex parts made of plates, the internal components, and the constants of the damage, blast,
 * fragment, driving, thermal and scenario models. Owned by the TARGETS module.
 *
 * Frames: the vehicle-local frame of docs/a10/ARCHITECTURE.md §2 (+X right, +Y up, -Z forward,
 * origin on the ground under the hull centre). Turret parts and boxes are given with the turret
 * facing forward (turretYaw = 0); the targets module turns them about the ring axis.
 *
 * Armour layouts are DERIVED from VEHICLE_SHAPES with the same proportions the 3D modeller uses
 * (src/a10/view/vehicles/models), so a round that hits the drawn vehicle hits the armour model.
 * Thicknesses are nominal plate thicknesses in mm of rolled homogeneous armour (RHA) equivalent;
 * the slope comes from the plate's normal, never from the number.
 */
import type {
  ArmourFace,
  ArmourPart,
  ArmourPartKind,
  ArmourPlate,
  ComponentBox,
  ComponentEffect,
  ComponentId,
  VehicleClassModel,
  VehicleKind,
  VehicleShape,
} from '../core/targets/types';
import type { SourceNote } from './sources';

const DEG = Math.PI / 180;

export const VEHICLE_SHAPES: Record<VehicleKind, VehicleShape> = {
  mbt: {
    hullLength: 6.9,
    hullWidth: 3.46,
    hullHeight: 1.25,
    hullClearance: 0.47,
    turret: { offsetZ: -0.6, radius: 1.1, height: 0.75 },
    gunLength: 6.0,
    running: { type: 'tracks', width: 0.58 },
  },
  ifv: {
    hullLength: 6.7,
    hullWidth: 2.94,
    hullHeight: 1.4,
    hullClearance: 0.42,
    turret: { offsetZ: -0.2, radius: 0.75, height: 0.5 },
    gunLength: 2.0,
    running: { type: 'tracks', width: 0.3 },
  },
  apc: {
    hullLength: 7.6,
    hullWidth: 2.9,
    hullHeight: 1.55,
    hullClearance: 0.47,
    turret: { offsetZ: -1.2, radius: 0.5, height: 0.45 },
    gunLength: 1.6,
    running: { type: 'wheels', axles: 4, radius: 0.6 },
  },
  truckCargo: {
    hullLength: 7.2,
    hullWidth: 2.5,
    hullHeight: 2.3,
    hullClearance: 0.9,
    turret: null,
    gunLength: 0,
    running: { type: 'wheels', axles: 3, radius: 0.55 },
    cabLength: 2.2,
  },
  truckFuel: {
    hullLength: 7.2,
    hullWidth: 2.5,
    hullHeight: 2.0,
    hullClearance: 0.9,
    turret: null,
    gunLength: 0,
    running: { type: 'wheels', axles: 3, radius: 0.55 },
    cabLength: 2.2,
  },
  truckAmmo: {
    hullLength: 7.2,
    hullWidth: 2.5,
    hullHeight: 2.3,
    hullClearance: 0.9,
    turret: null,
    gunLength: 0,
    running: { type: 'wheels', axles: 3, radius: 0.55 },
    cabLength: 2.2,
  },
  hulk: {
    hullLength: 6.9,
    hullWidth: 3.46,
    hullHeight: 1.25,
    hullClearance: 0.47,
    turret: { offsetZ: -0.6, radius: 1.1, height: 0.75 },
    gunLength: 4.0,
    running: { type: 'tracks', width: 0.58 },
  },
  panel: {
    hullLength: 0.3,
    hullWidth: 6.1,
    hullHeight: 6.1,
    hullClearance: 0,
    turret: null,
    gunLength: 0,
    running: { type: 'wheels', axles: 0, radius: 0 },
  },
};

// ---- Armour thicknesses ------------------------------------------------------------------------

/** Public armour estimates for a T-72-class tank, mm of steel (variants differ). */
export const T72_ARMOUR = {
  hullRoof: 20,
  engineDeck: 20,
  hullRear: 40,
  hullSide: 80,
  hullSideOverEngine: 70,
  turretFront: 350,
  /** Turret sides: estimates vary widely; the plan treats them as immune to the gun at range. */
  turretSide: 130,
  turretRoof: 40,
  glacis: 200,
  belly: 20,
  /** Lower front plate below the nose. */
  lowerFront: 85,
  /** Cast turret rear and rear quarters. */
  turretRear: 70,
  /** Upper (sloped) band of the cast turret, by sector: front, side, rear. */
  turretShoulderFront: 250,
  turretShoulderSide: 100,
  turretShoulderRear: 60,
  /** Turret ring and floor (only reached from inside). */
  turretRing: 60,
  /** Engine-compartment bulkhead (internal). */
  bulkhead: 10,
  /** Track run seen from outside: road wheels, track links and the rubber skirt. */
  trackRun: 20,
  /** Fender (track guard) sheet. */
  fender: 5,
  /** External fuel cells and stowage boxes on the fenders. */
  fenderStowage: 2,
  /** The two 200 l drums carried across the rear. */
  fuelDrum: 1.2,
  /** Gun barrel wall. */
  gunBarrel: 20,
} as const;

export const T72_ARMOUR_NOTES: Record<keyof typeof T72_ARMOUR, SourceNote> = {
  hullRoof: { source: 'tankograd', confidence: 'approximate' },
  engineDeck: { source: 'warThunderT72', confidence: 'approximate' },
  hullRear: { source: 'tankograd', confidence: 'approximate' },
  hullSide: { source: 'tankograd', confidence: 'approximate' },
  hullSideOverEngine: { source: 'tankograd', confidence: 'approximate' },
  turretFront: { source: 'tankograd', confidence: 'approximate' },
  turretSide: { source: 'tankograd', confidence: 'estimate', note: 'estimates range 130–500 mm' },
  turretRoof: { source: 'plan', confidence: 'estimate' },
  glacis: { source: 'plan', confidence: 'estimate', note: 'composite; immune to 30 mm' },
  belly: { source: 'tankograd', confidence: 'approximate' },
  lowerFront: {
    source: 'warThunderT72',
    confidence: 'approximate',
    note: 'lower front plate ≈85 mm at ≈60°',
  },
  turretRear: { source: 'warThunderT72', confidence: 'approximate', note: 'cast rear ≈65–80 mm' },
  turretShoulderFront: {
    source: 'warThunderT72',
    confidence: 'estimate',
    note: 'upper front of the cast turret; immune to 30 mm',
  },
  turretShoulderSide: { source: 'warThunderT72', confidence: 'estimate' },
  turretShoulderRear: { source: 'warThunderT72', confidence: 'estimate' },
  turretRing: { source: 'plan', confidence: 'estimate', note: 'internal face only' },
  bulkhead: { source: 'plan', confidence: 'estimate', note: 'internal face only' },
  trackRun: {
    source: 'plan',
    confidence: 'estimate',
    note: 'steel road-wheel discs and track links in the line of fire',
  },
  fender: { source: 'plan', confidence: 'estimate' },
  fenderStowage: {
    source: 'plan',
    confidence: 'estimate',
    note: 'sheet-steel fuel cells and boxes',
  },
  fuelDrum: { source: 'plan', confidence: 'estimate', note: '200 l steel drum wall' },
  gunBarrel: {
    source: 'plan',
    confidence: 'estimate',
    note: '125 mm barrel wall, ≈15–30 mm from muzzle to chamber',
  },
};

/** BMP-class infantry fighting vehicle (PLAN §9: thin, about 6 to 25 mm). */
export const BMP_ARMOUR = {
  /** Flat upper glacis (≈75–80° from vertical). */
  upperFront: 7,
  /** Sloped plate in front of the turret ring. */
  frontTop: 7,
  lowerFront: 19,
  sideUpper: 16,
  sideLower: 18,
  rear: 16,
  roof: 6,
  belly: 6,
  /** Floor of the sponsons over the tracks (internal in most places). */
  sponsonFloor: 10,
  turretFront: 23,
  turretSide: 15,
  turretRear: 10,
  turretShoulderFront: 15,
  turretShoulderSide: 10,
  turretShoulderRear: 8,
  turretRoof: 6,
  trackRun: 12,
  gunBarrel: 8,
} as const;

export const BMP_ARMOUR_NOTES: Record<keyof typeof BMP_ARMOUR, SourceNote> = {
  upperFront: {
    source: 'warThunderBmp2',
    confidence: 'approximate',
    note: 'BMP-1/2 upper front 7 mm at ≈80° (War Thunder wiki BMP-2, Wikipedia BMP-2)',
  },
  frontTop: { source: 'plan', confidence: 'estimate' },
  lowerFront: {
    source: 'warThunderBmp2',
    confidence: 'approximate',
    note: 'BMP-2 lower front ≈19 mm at 57°',
  },
  sideUpper: {
    source: 'warThunderBmp2',
    confidence: 'approximate',
    note: 'BMP-2 upper side ≈16 mm',
  },
  sideLower: {
    source: 'warThunderBmp2',
    confidence: 'approximate',
    note: 'BMP-2 lower side ≈18 mm',
  },
  rear: { source: 'plan', confidence: 'approximate', note: 'rear doors are hollow fuel tanks' },
  roof: { source: 'plan', confidence: 'approximate' },
  belly: { source: 'plan', confidence: 'approximate' },
  sponsonFloor: { source: 'plan', confidence: 'estimate' },
  turretFront: {
    source: 'warThunderBmp2',
    confidence: 'approximate',
    note: 'BMP-2 turret front ≈23 mm',
  },
  turretSide: { source: 'plan', confidence: 'approximate' },
  turretRear: { source: 'plan', confidence: 'estimate' },
  turretShoulderFront: { source: 'plan', confidence: 'estimate' },
  turretShoulderSide: { source: 'plan', confidence: 'estimate' },
  turretShoulderRear: { source: 'plan', confidence: 'estimate' },
  turretRoof: { source: 'plan', confidence: 'approximate' },
  trackRun: { source: 'plan', confidence: 'estimate' },
  gunBarrel: { source: 'plan', confidence: 'estimate', note: '30 mm 2A42 barrel' },
};

/** BTR-class wheeled personnel carrier (PLAN §9: very thin, about 7 to 10 mm). */
export const BTR_ARMOUR = {
  upperFront: 10,
  lowerFront: 10,
  nose: 10,
  frontQuarter: 8,
  sideUpper: 7,
  sideLower: 9,
  rear: 7,
  roof: 7,
  engineDeck: 7,
  belly: 7,
  turretFront: 10,
  turretSide: 7,
  turretRoof: 7,
  /** Tyre and rim in the line of fire. */
  wheel: 6,
  gunBarrel: 5,
} as const;

export const BTR_ARMOUR_NOTES: Record<keyof typeof BTR_ARMOUR, SourceNote> = {
  upperFront: {
    source: 'warThunderBtr80',
    confidence: 'approximate',
    note: 'BTR-80 front ≈10 mm sloped (War Thunder wiki BTR-80, Wikipedia BTR-80)',
  },
  lowerFront: { source: 'plan', confidence: 'approximate' },
  nose: { source: 'plan', confidence: 'approximate' },
  frontQuarter: { source: 'plan', confidence: 'estimate' },
  sideUpper: { source: 'warThunderBtr80', confidence: 'approximate', note: 'BTR-80 sides 7–9 mm' },
  sideLower: { source: 'plan', confidence: 'approximate' },
  rear: { source: 'plan', confidence: 'approximate' },
  roof: { source: 'plan', confidence: 'approximate' },
  engineDeck: { source: 'plan', confidence: 'approximate' },
  belly: { source: 'plan', confidence: 'estimate' },
  turretFront: { source: 'plan', confidence: 'approximate' },
  turretSide: { source: 'plan', confidence: 'approximate' },
  turretRoof: { source: 'plan', confidence: 'approximate' },
  wheel: { source: 'plan', confidence: 'estimate', note: 'run-flat tyre and steel rim' },
  gunBarrel: { source: 'plan', confidence: 'estimate', note: '14.5 mm KPVT barrel' },
};

/** Soft-skinned trucks (Ural / ZIL class): sheet metal, wood and canvas. */
export const TRUCK_SKIN = {
  bonnet: 1.0,
  grille: 1.0,
  cabSheet: 1.0,
  windscreen: 0.6,
  cabFloor: 2.0,
  sump: 3.0,
  bedSide: 2.0,
  bedFloor: 3.0,
  canvas: 0.3,
  /** Shell of a fuel tanker body. */
  tankerShell: 3.0,
  /** Stacked wooden ammunition crates (≈25 mm of wood). */
  crates: 2.5,
  tyre: 4.0,
  /** The truck's own fuel tank. */
  fuelTank: 1.5,
} as const;

export const TRUCK_SKIN_NOTES: Record<keyof typeof TRUCK_SKIN, SourceNote> = {
  bonnet: { source: 'plan', confidence: 'estimate', note: 'PLAN §9: sheet metal ≈1–3 mm' },
  grille: { source: 'plan', confidence: 'estimate' },
  cabSheet: { source: 'plan', confidence: 'estimate' },
  windscreen: { source: 'plan', confidence: 'estimate', note: 'glass, steel equivalent' },
  cabFloor: { source: 'plan', confidence: 'estimate' },
  sump: { source: 'plan', confidence: 'estimate' },
  bedSide: { source: 'plan', confidence: 'estimate', note: 'wooden or steel dropsides' },
  bedFloor: { source: 'plan', confidence: 'estimate' },
  canvas: { source: 'plan', confidence: 'estimate' },
  tankerShell: { source: 'plan', confidence: 'estimate' },
  crates: { source: 'plan', confidence: 'estimate', note: '25 mm pine ≈ 2.5 mm steel' },
  tyre: { source: 'plan', confidence: 'estimate' },
  fuelTank: { source: 'plan', confidence: 'estimate' },
};

// ---- Layout helpers (pure; used once at load) --------------------------------------------------

type V3 = [number, number, number];

interface PlateDef {
  name: string;
  face: ArmourFace;
  mm: number;
  /** Outward normal (any length) and a point on the plane. */
  n: V3;
  p: V3;
}

interface PartDef {
  name: string;
  part: ArmourPartKind;
  turret: boolean;
  spaced: boolean;
  component: ComponentId | null;
  plates: PlateDef[];
  min: V3;
  max: V3;
}

interface BoxMm {
  front: number;
  rear: number;
  side: number;
  left?: number;
  right?: number;
  top: number;
  bottom: number;
}

const plane = (name: string, face: ArmourFace, mm: number, n: V3, p: V3): PlateDef => ({
  name,
  face,
  mm,
  n,
  p,
});

/** The six plates of an axis-aligned box. */
function boxPlates(name: string, min: V3, max: V3, mm: BoxMm): PlateDef[] {
  return [
    plane(`${name} front`, 'front', mm.front, [0, 0, -1], [0, 0, min[2]]),
    plane(`${name} rear`, 'rear', mm.rear, [0, 0, 1], [0, 0, max[2]]),
    plane(`${name} left`, 'side', mm.left ?? mm.side, [-1, 0, 0], [min[0], 0, 0]),
    plane(`${name} right`, 'side', mm.right ?? mm.side, [1, 0, 0], [max[0], 0, 0]),
    plane(`${name} top`, 'top', mm.top, [0, 1, 0], [0, max[1], 0]),
    plane(`${name} bottom`, 'bottom', mm.bottom, [0, -1, 0], [0, min[1], 0]),
  ];
}

const uniform = (mm: number): BoxMm => ({
  front: mm,
  rear: mm,
  side: mm,
  top: mm,
  bottom: mm,
});

/**
 * The plane that contains the line a→b and runs parallel to a coordinate axis, its normal
 * turned toward `out` (a sloped glacis: axis 'x'; a sloped side: axis 'z'; a chamfer: axis 'y').
 */
function slope(
  name: string,
  face: ArmourFace,
  mm: number,
  a: V3,
  b: V3,
  axis: 'x' | 'y' | 'z',
  out: V3,
): PlateDef {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ax: V3 = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
  let n: V3 = [
    d[1] * ax[2] - d[2] * ax[1],
    d[2] * ax[0] - d[0] * ax[2],
    d[0] * ax[1] - d[1] * ax[0],
  ];
  if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) n = [-n[0], -n[1], -n[2]];
  return plane(name, face, mm, n, a);
}

function part(
  name: string,
  kind: ArmourPartKind,
  plates: PlateDef[],
  min: V3,
  max: V3,
  opts: { turret?: boolean; spaced?: boolean; component?: ComponentId | null } = {},
): PartDef {
  return {
    name,
    part: kind,
    turret: opts.turret ?? false,
    spaced: opts.spaced ?? false,
    component: opts.component ?? null,
    plates,
    min,
    max,
  };
}

function boxPart(
  name: string,
  kind: ArmourPartKind,
  min: V3,
  max: V3,
  mm: BoxMm,
  opts: { turret?: boolean; spaced?: boolean; component?: ComponentId | null } = {},
): PartDef {
  return part(name, kind, boxPlates(name, min, max, mm), min, max, opts);
}

/** One sector of a turret: its compass direction (0 = bow, + clockwise), face and thicknesses. */
interface TurretSector {
  deg: number;
  face: ArmourFace;
  side: number;
  shoulder: number;
}

const SECTORS = (front: [number, number], side: [number, number], rear: [number, number]) =>
  [0, 45, 90, 135, 180, 225, 270, 315].map((deg): TurretSector => {
    const a = deg > 180 ? 360 - deg : deg;
    const [s, sh] = a <= 45 ? front : a <= 90 ? side : rear;
    const face: ArmourFace = a <= 45 ? 'front' : a <= 90 ? 'side' : 'rear';
    return { deg, face, side: s, shoulder: sh };
  });

/**
 * A cast or welded turret as a convex eight-sided frustum: lower side plates leaning in by
 * `sideSlope` from the vertical, an upper band ("shoulders") leaning in by `shoulderSlope` from
 * `shoulderY`, a flat roof, and the ring underneath. `radius(θ)` is the base apothem by sector.
 */
function turretPart(
  name: string,
  cz: number,
  y0: number,
  shoulderY: number,
  roofY: number,
  radius: (deg: number) => number,
  sideSlope: number,
  shoulderSlope: number,
  sectors: TurretSector[],
  roofMm: number,
  ringMm: number,
): PartDef {
  const plates: PlateDef[] = [];
  let rMax = 0;
  for (const s of sectors) {
    const th = s.deg * DEG;
    const dx = Math.sin(th);
    const dz = -Math.cos(th);
    const r0 = radius(s.deg);
    rMax = Math.max(rMax, r0 / Math.cos(22.5 * DEG));
    const cs = Math.cos(sideSlope);
    const ss = Math.sin(sideSlope);
    plates.push(
      plane(
        `${name} ${s.face} ${s.deg}°`,
        s.face,
        s.side,
        [dx * cs, ss, dz * cs],
        [dx * r0, y0, cz + dz * r0],
      ),
    );
    const rs = r0 - (shoulderY - y0) * Math.tan(sideSlope);
    const ch = Math.cos(shoulderSlope);
    const sh = Math.sin(shoulderSlope);
    plates.push(
      plane(
        `${name} upper ${s.face} ${s.deg}°`,
        s.face,
        s.shoulder,
        [dx * ch, sh, dz * ch],
        [dx * rs, shoulderY, cz + dz * rs],
      ),
    );
  }
  plates.push(plane(`${name} roof`, 'top', roofMm, [0, 1, 0], [0, roofY, 0]));
  plates.push(plane(`${name} ring`, 'bottom', ringMm, [0, -1, 0], [0, y0, 0]));
  return part(name, 'turret', plates, [-rMax, y0, cz - rMax], [rMax, roofY, cz + rMax], {
    turret: true,
  });
}

function comp(
  id: ComponentId,
  name: string,
  min: V3,
  max: V3,
  opts: {
    turret?: boolean;
    external?: boolean;
    absorb?: number;
    weight?: number;
    effect?: ComponentEffect;
    breakChance?: number;
  } = {},
): ComponentBox {
  const box: ComponentBox = {
    id,
    name,
    turret: opts.turret ?? false,
    external: opts.external ?? false,
    min,
    max,
    absorbMm: opts.absorb ?? 0,
    weight: opts.weight ?? 1,
    effect: opts.effect ?? 'none',
  };
  if (opts.breakChance !== undefined) box.breakChance = opts.breakChance;
  return box;
}

/** Number the plates, normalise the planes and work out the bounds of a class. */
function compile(
  kind: VehicleKind,
  defs: PartDef[],
  components: ComponentBox[],
  turretZ: number,
): VehicleClassModel {
  const plates: ArmourPlate[] = [];
  const parts: ArmourPart[] = [];
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const def of defs) {
    const list: ArmourPlate[] = [];
    for (const p of def.plates) {
      const l = Math.hypot(p.n[0], p.n[1], p.n[2]);
      const nx = p.n[0] / l;
      const ny = p.n[1] / l;
      const nz = p.n[2] / l;
      const plate: ArmourPlate = {
        index: plates.length,
        name: p.name,
        face: p.face,
        thicknessMm: p.mm,
        nx,
        ny,
        nz,
        d: nx * p.p[0] + ny * p.p[1] + nz * p.p[2],
      };
      plates.push(plate);
      list.push(plate);
    }
    parts.push({
      name: def.name,
      part: def.part,
      turret: def.turret,
      spaced: def.spaced,
      component: def.component,
      plates: list,
      min: def.min,
      max: def.max,
    });
    let x0 = def.min[0];
    let x1 = def.max[0];
    let z0 = def.min[2];
    let z1 = def.max[2];
    if (def.turret) {
      // the turret turns: everything within the circle swept about the ring axis
      let r = 0;
      for (const x of [def.min[0], def.max[0]])
        for (const z of [def.min[2], def.max[2]]) r = Math.max(r, Math.hypot(x, z - turretZ));
      x0 = -r;
      x1 = r;
      z0 = turretZ - r;
      z1 = turretZ + r;
    }
    min[0] = Math.min(min[0], x0);
    max[0] = Math.max(max[0], x1);
    min[1] = Math.min(min[1], def.min[1]);
    max[1] = Math.max(max[1], def.max[1]);
    min[2] = Math.min(min[2], z0);
    max[2] = Math.max(max[2], z1);
  }
  // bounding sphere about (0, sphereY, 0): hull parts by their corners, turret parts by the
  // circle they sweep about the ring axis
  const sphereY = (min[1] + max[1]) / 2;
  let sphereR = 0;
  for (const def of defs) {
    const vy = Math.max(Math.abs(def.min[1] - sphereY), Math.abs(def.max[1] - sphereY));
    let h = 0;
    for (const x of [def.min[0], def.max[0]]) {
      for (const z of [def.min[2], def.max[2]]) {
        h = Math.max(
          h,
          def.turret ? Math.abs(turretZ) + Math.hypot(x, z - turretZ) : Math.hypot(x, z),
        );
      }
    }
    sphereR = Math.max(sphereR, Math.hypot(h, vy));
  }
  return { kind, parts, plates, components, min, max, sphereY, sphereR, turretZ };
}

// ---- Tracked vehicles --------------------------------------------------------------------------

/**
 * Tracks (review TE-2): a track is broken, not worn down. Nearby strikes (a 30 mm HEI burst on the
 * glacis, a round stopped on the track top) do not break it; a penetrator or fragment that defeats
 * the track run (road wheels and links) severs a link or a pin with this chance per hit, and a
 * heavy blast breaks it. A burst of API down the side of a tank shreds the track; from the front
 * only the few rounds that strike the idler and the track ends can.
 */
export const TRACKS = {
  /** T-72-class track (≈580 mm steel links on rubber-bushed pins). */
  mbtBreakChance: 0.1,
  /** BMP-class track (lighter links). */
  ifvBreakChance: 0.25,
} as const;

export const TRACKS_NOTES: Record<keyof typeof TRACKS, SourceNote> = {
  mbtBreakChance: {
    source: 'plan',
    confidence: 'estimate',
    note: 'tuned (review TE-2): a 1 s frontal burst at ≈900 m immobilises a T-72 in ≈1 pass in 5, a 30° pass from 1,400 m rarely, a side pass usually (tests/unit/a10/targetsStrafing.test.ts)',
  },
  ifvBreakChance: { source: 'plan', confidence: 'estimate' },
};

/** Top of the track run, m, as the 3D model lays out its road wheels, sprocket and idler. */
function trackTopOf(s: VehicleShape): number {
  const rw = Math.min(0.42, Math.max(0.28, s.hullClearance * 0.8));
  const th = 0.075;
  const yw = rw + th;
  return Math.max(yw + rw, yw + 0.17 + rw * 0.82, yw + 0.13 + rw * 0.78) + th;
}

/** T-72-class tank (and the range hulk built from its hull). */
function buildMbt(kind: VehicleKind, s: VehicleShape, drums: boolean, internals: boolean) {
  const A = T72_ARMOUR;
  const L = s.hullLength;
  const W = s.hullWidth;
  const C = s.hullClearance;
  const H = s.hullHeight;
  const top = C + H;
  const tw = s.running.type === 'tracks' ? s.running.width : 0.5;
  const zF = -L / 2;
  const zR = L / 2;
  const wl = W / 2 - tw - 0.06; // hull body between the tracks, as modelled
  const xo = W / 2 - 0.02;
  const xi = xo - tw;
  const yT = trackTopOf(s);
  const yF = yT + 0.03;
  const yN = C + 0.42 * H;
  const zG = zF + (top - yN) / Math.tan(22 * DEG); // top of the upper glacis (68° from vertical)
  const zE = zR - 2.05; // engine-compartment bulkhead
  const t = s.turret ?? { offsetZ: 0, radius: 1, height: 0.7 };
  const tz = t.offsetZ;
  const Ht = t.height;

  const defs: PartDef[] = [];
  defs.push(
    part(
      'hull',
      'hull',
      [
        ...boxPlates('hull', [-wl, C, zF], [wl, top, zE], {
          front: A.glacis,
          rear: A.bulkhead,
          side: A.hullSide,
          top: A.hullRoof,
          bottom: A.belly,
        }),
        slope('upper glacis', 'front', A.glacis, [0, yN + 0.02, zF], [0, top, zG], 'x', [0, 1, -1]),
        slope(
          'lower front',
          'front',
          A.lowerFront,
          [0, C, zF + 0.5],
          [0, yN - 0.05, zF],
          'x',
          [0, -1, -1],
        ),
      ],
      [-wl, C, zF],
      [wl, top, zE],
    ),
  );
  defs.push(
    boxPart('engine compartment', 'hull', [-wl, C, zE], [wl, top, zR], {
      front: A.bulkhead,
      rear: A.hullRear,
      side: A.hullSideOverEngine,
      top: A.engineDeck,
      bottom: A.belly,
    }),
  );
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -xo : xi;
    const x1 = side < 0 ? -xi : xo;
    defs.push(
      boxPart(
        side < 0 ? 'left track' : 'right track',
        'tracks',
        [x0, 0, zF + 0.03],
        [x1, yT, zR - 0.03],
        uniform(A.trackRun),
        { spaced: true, component: 'runningGear' },
      ),
    );
    defs.push(
      boxPart(
        side < 0 ? 'left fender' : 'right fender',
        'fender',
        [side < 0 ? -xo : wl, yF - 0.02, zF + 0.15],
        [side < 0 ? -wl : xo, yF + 0.02, zR - 0.15],
        uniform(A.fender),
        { spaced: true },
      ),
    );
  }
  // fuel cells along the right fender, stowage boxes on the left one (as the model)
  defs.push(
    boxPart(
      'fender fuel cells',
      'tank',
      [wl + 0.03, yF + 0.02, -1.11],
      [xo - 0.03, yF + 0.42, 2.56],
      uniform(A.fenderStowage),
      { spaced: true, component: 'fuel' },
    ),
  );
  defs.push(
    boxPart(
      'stowage boxes',
      'fender',
      [-xo + 0.03, yF + 0.02, -2.61],
      [-wl - 0.03, yF + 0.42, -0.0],
      uniform(A.fenderStowage),
      { spaced: true },
    ),
  );
  if (drums) {
    defs.push(
      boxPart(
        'rear fuel drums',
        'tank',
        [-1.0, top - 0.56, zR + 0.02],
        [1.0, top + 0.02, zR + 0.6],
        uniform(A.fuelDrum),
        { spaced: true, component: 'fuel' },
      ),
    );
  }
  if (s.turret) {
    const R = t.radius;
    const radius = (deg: number) => {
      const th = deg * DEG;
      return 0.97 * R * (1 + 0.1 * Math.cos(th) - 0.03 * Math.cos(2 * th));
    };
    defs.push(
      turretPart(
        'turret',
        tz,
        top,
        top + 0.42 * Ht,
        top + Ht - 0.04,
        radius,
        23 * DEG,
        54 * DEG,
        SECTORS(
          [A.turretFront, A.turretShoulderFront],
          [A.turretSide, A.turretShoulderSide],
          [A.turretRear, A.turretShoulderRear],
        ),
        A.turretRoof,
        A.turretRing,
      ),
    );
    const front = tz - R * 1.08;
    const pivotY = top + Ht * 0.42;
    defs.push(
      boxPart(
        'gun barrel',
        'gun',
        [-0.12, pivotY - 0.12, front - s.gunLength],
        [0.12, pivotY + 0.12, front - 0.3],
        uniform(A.gunBarrel),
        { turret: true, spaced: true, component: 'gun' },
      ),
    );
  }

  const comps: ComponentBox[] = [];
  if (internals) {
    comps.push(
      comp('crew', 'driver', [-0.45, C + 0.1, zF + 0.65], [0.45, C + 1.05, zF + 1.6], {
        effect: 'mobility',
      }),
      comp(
        'fuel',
        'front fuel tank',
        [0.45, C + 0.08, zF + 0.55],
        [wl - 0.03, top - 0.15, zF + 1.65],
      ),
      comp(
        'ammo',
        'front ammunition racks',
        [-wl + 0.03, C + 0.08, zF + 0.55],
        [-0.45, top - 0.2, zF + 1.6],
        {
          weight: 0.6,
        },
      ),
      comp('ammo', 'autoloader carousel', [-1.0, C + 0.05, tz - 1.0], [1.0, C + 0.4, tz + 1.0], {
        weight: 1.4,
      }),
      comp(
        'ammo',
        'hull ammunition racks',
        [wl - 0.33, C + 0.4, tz - 1.0],
        [wl - 0.03, top - 0.12, tz + 0.9],
        {
          weight: 0.5,
        },
      ),
      comp(
        'fuel',
        'fighting-compartment fuel tanks',
        [-wl + 0.03, C + 0.4, tz - 1.0],
        [-wl + 0.33, top - 0.12, tz + 0.9],
        {
          weight: 0.8,
        },
      ),
      comp('crew', 'gunner', [-0.95, C + 0.48, tz - 0.55], [-0.25, top + 0.55, tz + 0.45], {
        turret: true,
        effect: 'firepower',
      }),
      comp('crew', 'commander', [0.25, C + 0.48, tz - 0.55], [0.95, top + 0.55, tz + 0.45], {
        turret: true,
      }),
      comp('gun', 'gun breech', [-0.28, top - 0.05, tz - 1.0], [0.28, top + 0.5, tz + 0.95], {
        turret: true,
        absorb: 40,
        effect: 'firepower',
      }),
      comp(
        'engine',
        'engine and transmission',
        [-wl + 0.05, C + 0.05, zE + 0.08],
        [wl - 0.05, top - 0.08, zR - 0.12],
        {
          absorb: 45,
          effect: 'mobility',
        },
      ),
      comp(
        'optics',
        "gunner's sight",
        [-0.62, top + Ht - 0.12, tz - 0.75],
        [-0.22, top + Ht + 0.15, tz - 0.3],
        {
          turret: true,
          external: true,
          effect: 'firepower',
        },
      ),
      comp(
        'optics',
        "commander's sights",
        [0.22, top + Ht - 0.15, tz - 0.2],
        [0.7, top + Ht + 0.16, tz + 0.35],
        {
          turret: true,
          external: true,
          weight: 0.5,
        },
      ),
      comp(
        'optics',
        "driver's periscope",
        [-0.25, top - 0.02, zG - 0.15],
        [0.25, top + 0.12, zG + 0.1],
        {
          external: true,
          weight: 0.3,
        },
      ),
      comp('runningGear', 'left track', [-xo, 0, zF], [-xi, yT, zR], {
        external: true,
        effect: 'mobility',
        breakChance: TRACKS.mbtBreakChance,
      }),
      comp('runningGear', 'right track', [xi, 0, zF], [xo, yT, zR], {
        external: true,
        effect: 'mobility',
        breakChance: TRACKS.mbtBreakChance,
      }),
      comp(
        'fuel',
        'fender fuel cells',
        [wl + 0.03, yF + 0.02, -1.11],
        [xo - 0.03, yF + 0.42, 2.56],
        {
          external: true,
          weight: 0.4,
        },
      ),
    );
    if (drums) {
      comps.push(
        comp(
          'fuel',
          'rear fuel drums',
          [-1.0, top - 0.56, zR + 0.02],
          [1.0, top + 0.02, zR + 0.6],
          {
            external: true,
            weight: 0.3,
          },
        ),
      );
    }
  }
  return compile(kind, defs, comps, s.turret ? tz : 0);
}

/** BMP-class infantry fighting vehicle. */
function buildIfv(s: VehicleShape) {
  const A = BMP_ARMOUR;
  const L = s.hullLength;
  const W = s.hullWidth;
  const C = s.hullClearance;
  const H = s.hullHeight;
  const top = C + H;
  const tw = s.running.type === 'tracks' ? s.running.width : 0.3;
  const zF = -L / 2;
  const zR = L / 2;
  const wl = W / 2 - tw - 0.05;
  const xo = W / 2 - 0.02;
  const xi = xo - tw;
  const yT = trackTopOf(s);
  const yF = yT + 0.03;
  const yN = C + 0.45;
  const wT = W / 2 - 0.4;
  const yMid = C + 0.67 * H;
  const t = s.turret ?? { offsetZ: 0, radius: 0.7, height: 0.5 };
  const tz = t.offsetZ;
  const R = t.radius;
  const Ht = t.height;

  // The glacis (≈16°) and the steeper plate in front of the turret ring (≈35°) make a concave
  // profile: two convex parts, split where they meet. The glacis plane also trims the lower hull
  // so the nose runs smoothly into it.
  const zKnee = zF + 1.7;
  const glacis = () =>
    slope(
      'upper glacis',
      'front',
      A.upperFront,
      [0, yN + 0.01, zF],
      [0, yMid, zKnee],
      'x',
      [0, 1, -1],
    );
  const upperSides = () => [
    slope('right upper side', 'side', A.sideUpper, [W / 2, yF, 0], [wT, top, 0], 'z', [1, 1, 0]),
    slope('left upper side', 'side', A.sideUpper, [-W / 2, yF, 0], [-wT, top, 0], 'z', [-1, 1, 0]),
  ];
  const defs: PartDef[] = [
    part(
      'lower hull',
      'hull',
      [
        ...boxPlates('lower hull', [-wl, C, zF], [wl, yF, zR], {
          front: A.lowerFront,
          rear: A.rear,
          side: A.sideLower,
          top: A.sponsonFloor,
          bottom: A.belly,
        }),
        slope(
          'lower front',
          'front',
          A.lowerFront,
          [0, C, zF + 0.55],
          [0, yN, zF],
          'x',
          [0, -1, -1],
        ),
        glacis(),
      ],
      [-wl, C, zF],
      [wl, yF, zR],
    ),
    part(
      'glacis',
      'hull',
      [
        ...boxPlates('glacis', [-W / 2, yF, zF], [W / 2, yMid, zKnee], {
          front: A.upperFront,
          rear: A.frontTop,
          side: A.sideUpper,
          top: A.upperFront,
          bottom: A.sponsonFloor,
        }),
        glacis(),
        ...upperSides(),
      ],
      [-W / 2, yF, zF],
      [W / 2, yMid, zKnee],
    ),
    part(
      'upper hull',
      'hull',
      [
        ...boxPlates('upper hull', [-W / 2, yF, zKnee], [W / 2, top, zR], {
          front: A.frontTop,
          rear: A.rear,
          side: A.sideUpper,
          top: A.roof,
          bottom: A.sponsonFloor,
        }),
        slope(
          'front roof',
          'front',
          A.frontTop,
          [0, yMid, zKnee],
          [0, top, zF + 2.35],
          'x',
          [0, 1, -1],
        ),
        ...upperSides(),
      ],
      [-W / 2, yF, zKnee],
      [W / 2, top, zR],
    ),
  ];
  for (const side of [-1, 1]) {
    defs.push(
      boxPart(
        side < 0 ? 'left track' : 'right track',
        'tracks',
        [side < 0 ? -xo : xi, 0, zF + 0.05],
        [side < 0 ? -xi : xo, yT, zR - 0.05],
        uniform(A.trackRun),
        { spaced: true, component: 'runningGear' },
      ),
    );
  }
  defs.push(
    turretPart(
      'turret',
      tz,
      top,
      top + 0.5 * Ht,
      top + Ht - 0.03,
      (deg) => 0.97 * R * (1 + 0.06 * Math.cos(deg * DEG)),
      30 * DEG,
      55 * DEG,
      SECTORS(
        [A.turretFront, A.turretShoulderFront],
        [A.turretSide, A.turretShoulderSide],
        [A.turretRear, A.turretShoulderRear],
      ),
      A.turretRoof,
      A.turretSide,
    ),
  );
  const front = tz - R * 0.95;
  const pivotY = top + Ht * 0.45;
  defs.push(
    boxPart(
      'gun barrel',
      'gun',
      [-0.07, pivotY - 0.07, front - s.gunLength],
      [0.07, pivotY + 0.07, front - 0.05],
      uniform(A.gunBarrel),
      { turret: true, spaced: true, component: 'gun' },
    ),
  );
  // the driver's periscopes sit on the upper glacis
  const glacisY = (z: number) => yN + 0.01 + ((z - zF) * (yMid - yN - 0.01)) / (zKnee - zF);
  const comps: ComponentBox[] = [
    comp('crew', 'driver', [-1.05, C + 0.08, zF + 0.5], [-0.35, C + 1.03, zF + 1.5], {
      effect: 'mobility',
    }),
    comp('engine', 'engine', [0.0, C + 0.05, zF + 0.4], [1.08, C + 0.88, zF + 1.9], {
      absorb: 30,
      effect: 'mobility',
    }),
    comp('crew', 'gunner', [-0.6, C + 0.48, tz - 0.45], [0.0, top + 0.38, tz + 0.45], {
      turret: true,
      effect: 'firepower',
    }),
    comp('crew', 'commander', [0.0, C + 0.48, tz - 0.45], [0.6, top + 0.38, tz + 0.45], {
      turret: true,
    }),
    comp('crew', 'troop compartment', [-1.0, C + 0.08, 0.6], [1.0, C + 1.33, zR - 0.35]),
    comp(
      'fuel',
      'rear-door fuel tanks',
      [-0.95, C + 0.13, zR - 0.33],
      [0.95, C + 1.13, zR - 0.03],
      {
        weight: 0.6,
      },
    ),
    comp('fuel', 'centre fuel tank', [-0.25, C + 0.08, 0.6], [0.25, C + 0.88, zR - 0.45], {
      weight: 0.8,
    }),
    comp('ammo', '30 mm ammunition', [-0.7, C + 0.05, tz - 0.6], [0.7, C + 0.43, tz + 0.6]),
    comp('ammo', 'missile rack', [0.6, C + 0.48, -1.3], [1.05, C + 1.18, 0.3], { weight: 0.4 }),
    comp('gun', 'gun breech', [-0.18, top - 0.05, tz - 0.75], [0.18, top + 0.35, tz + 0.35], {
      turret: true,
      absorb: 15,
      effect: 'firepower',
    }),
    comp(
      'optics',
      "gunner's sight",
      [-0.42, top + Ht - 0.05, tz - 0.45],
      [-0.15, top + Ht + 0.15, tz - 0.1],
      {
        turret: true,
        external: true,
        effect: 'firepower',
      },
    ),
    comp(
      'optics',
      "driver's periscopes",
      [-0.85, glacisY(-2.4) - 0.03, -2.4],
      [-0.35, glacisY(-2.15) + 0.12, -2.15],
      {
        external: true,
        weight: 0.3,
      },
    ),
    comp('runningGear', 'left track', [-xo, 0, zF], [-xi, yT, zR], {
      external: true,
      effect: 'mobility',
      breakChance: TRACKS.ifvBreakChance,
    }),
    comp('runningGear', 'right track', [xi, 0, zF], [xo, yT, zR], {
      external: true,
      effect: 'mobility',
      breakChance: TRACKS.ifvBreakChance,
    }),
  ];
  return compile('ifv', defs, comps, tz);
}

// ---- Wheeled vehicles --------------------------------------------------------------------------

/** Axle positions as the 3D model spaces them (a wider gap in the middle of four axles). */
function axleZs(n: number, front: number, rear: number): number[] {
  if (n <= 1) return [(front + rear) / 2];
  const gaps: number[] = [];
  for (let i = 0; i < n - 1; i++) gaps.push(n >= 4 && i === n / 2 - 1 ? 1.2 : 1);
  const total = gaps.reduce((a, g) => a + g, 0);
  const out = [front];
  let z = front;
  for (const g of gaps) {
    z += ((rear - front) * g) / total;
    out.push(z);
  }
  return out;
}

/** BTR-class 8 × 8 personnel carrier. */
function buildApc(s: VehicleShape) {
  const A = BTR_ARMOUR;
  const L = s.hullLength;
  const W = s.hullWidth;
  const C = s.hullClearance;
  const H = s.hullHeight;
  const top = C + H;
  const zF = -L / 2;
  const zR = L / 2;
  const r = s.running.type === 'wheels' ? s.running.radius : 0.6;
  const n = s.running.type === 'wheels' ? s.running.axles : 4;
  const yW = Math.max(C + 0.5, 2 * r + 0.05); // waist
  const xW = W / 2 - 0.05;
  const xB = 0.65;
  const xT = W / 2 - 0.42;
  const t = s.turret ?? { offsetZ: -1.2, radius: 0.5, height: 0.45 };
  const tz = t.offsetZ;
  const R = t.radius;
  const Ht = t.height;

  const defs: PartDef[] = [
    part(
      'hull',
      'hull',
      [
        ...boxPlates('hull', [-W / 2, C, zF], [W / 2, top, zR], {
          front: A.nose,
          rear: A.rear,
          side: A.sideUpper,
          top: A.roof,
          bottom: A.belly,
        }),
        slope('right lower side', 'side', A.sideLower, [xB, C, 0], [xW, yW, 0], 'z', [1, -1, 0]),
        slope('left lower side', 'side', A.sideLower, [-xB, C, 0], [-xW, yW, 0], 'z', [-1, -1, 0]),
        slope('right upper side', 'side', A.sideUpper, [xW, yW, 0], [xT, top, 0], 'z', [1, 1, 0]),
        slope('left upper side', 'side', A.sideUpper, [-xW, yW, 0], [-xT, top, 0], 'z', [-1, 1, 0]),
        slope(
          'upper front',
          'front',
          A.upperFront,
          [0, C + 0.62, zF],
          [0, top, zF + 1.6],
          'x',
          [0, 1, -1],
        ),
        slope(
          'lower front',
          'front',
          A.lowerFront,
          [0, C + 0.08, zF + 0.7],
          [0, C + 0.5, zF],
          'x',
          [0, -1, -1],
        ),
        slope(
          'right front quarter',
          'front',
          A.frontQuarter,
          [xW, 0, zF + 1.6],
          [W / 2 - 0.3, 0, zF + 0.7],
          'y',
          [1, 0, -1],
        ),
        slope(
          'left front quarter',
          'front',
          A.frontQuarter,
          [-xW, 0, zF + 1.6],
          [-(W / 2 - 0.3), 0, zF + 0.7],
          'y',
          [-1, 0, -1],
        ),
        slope(
          'engine deck',
          'top',
          A.engineDeck,
          [0, top, zR - 1.7],
          [0, top - 0.32, zR],
          'x',
          [0, 1, 1],
        ),
        slope(
          'right rear quarter',
          'side',
          A.rear,
          [xW, 0, zR - 1.7],
          [W / 2 - 0.12, 0, zR],
          'y',
          [1, 0, 1],
        ),
        slope(
          'left rear quarter',
          'side',
          A.rear,
          [-xW, 0, zR - 1.7],
          [-(W / 2 - 0.12), 0, zR],
          'y',
          [-1, 0, 1],
        ),
      ],
      [-W / 2, C, zF],
      [W / 2, top, zR],
    ),
  ];
  const ww = Math.min(0.42, r * 0.65);
  const xw = W / 2 - ww / 2 - 0.02;
  const zs = axleZs(n, zF + 1.55, zR - 1.4);
  const comps: ComponentBox[] = [];
  zs.forEach((z, i) => {
    for (const side of [-1, 1]) {
      const name = `${side < 0 ? 'left' : 'right'} wheel ${i + 1}`;
      const min: V3 = [side * xw - ww / 2, 0, z - r];
      const max: V3 = [side * xw + ww / 2, 2 * r, z + r];
      defs.push(
        boxPart(name, 'wheels', min, max, uniform(A.wheel), {
          spaced: true,
          component: 'runningGear',
        }),
      );
      comps.push(
        comp('runningGear', name, min, max, { external: true, weight: 1 / (2 * zs.length) }),
      );
    }
  });
  defs.push(
    turretPart(
      'turret',
      tz,
      top - 0.02,
      top + 0.23,
      top + Ht - 0.02,
      () => 0.97 * R,
      35 * DEG,
      55 * DEG,
      SECTORS(
        [A.turretFront, A.turretRoof],
        [A.turretSide, A.turretRoof],
        [A.turretSide, A.turretRoof],
      ),
      A.turretRoof,
      A.turretSide,
    ),
  );
  const front = tz - R;
  const pivotY = top + Ht * 0.4;
  defs.push(
    boxPart(
      'gun barrel',
      'gun',
      [-0.06, pivotY - 0.06, front - s.gunLength],
      [0.06, pivotY + 0.06, front - 0.05],
      uniform(A.gunBarrel),
      { turret: true, spaced: true, component: 'gun' },
    ),
  );
  const frontY = (z: number) => C + 0.62 + ((z - zF) * (top - C - 0.62)) / 1.6;
  comps.push(
    comp('crew', 'driver', [-1.0, C + 0.18, zF + 0.8], [0.0, C + 1.38, zF + 1.9], {
      effect: 'mobility',
    }),
    comp('crew', 'commander', [0.0, C + 0.18, zF + 0.8], [1.0, C + 1.38, zF + 1.9]),
    comp('crew', 'gunner', [-0.4, C + 0.63, tz - 0.4], [0.4, top + 0.35, tz + 0.4], {
      turret: true,
      effect: 'firepower',
    }),
    comp('crew', 'troop compartment', [-1.15, C + 0.13, -0.8], [1.15, C + 1.38, 1.7]),
    comp('engine', 'engine', [-1.0, C + 0.13, zR - 1.75], [1.0, C + 1.33, zR - 0.2], {
      absorb: 30,
      effect: 'mobility',
    }),
    comp('fuel', 'left fuel tank', [-1.3, C + 0.38, 1.2], [-0.9, C + 1.13, 2.0], { weight: 0.5 }),
    comp('fuel', 'right fuel tank', [0.9, C + 0.38, 1.2], [1.3, C + 1.13, 2.0], { weight: 0.5 }),
    comp('ammo', 'machine-gun ammunition', [-0.55, C + 0.13, tz - 0.5], [0.55, C + 0.53, tz + 0.5]),
    comp('gun', 'gun breech', [-0.14, top + 0.05, tz - 0.5], [0.14, top + 0.35, tz + 0.2], {
      turret: true,
      absorb: 8,
      effect: 'firepower',
    }),
    comp(
      'optics',
      "gunner's sight",
      [-0.32, top + Ht - 0.05, tz - 0.35],
      [-0.1, top + Ht + 0.12, tz - 0.12],
      {
        turret: true,
        external: true,
        effect: 'firepower',
      },
    ),
    comp(
      'optics',
      "driver's vision blocks",
      [-0.8, frontY(-3.05) - 0.05, -3.05],
      [0.8, frontY(-2.85) + 0.1, -2.85],
      {
        external: true,
        weight: 0.4,
      },
    ),
  );
  return compile('apc', defs, comps, tz);
}

/** Bonneted 6 × 6 trucks: cargo (canvas tilt), fuel (tank body), ammunition (crates). */
function buildTruck(kind: 'truckCargo' | 'truckFuel' | 'truckAmmo', s: VehicleShape) {
  const T = TRUCK_SKIN;
  const L = s.hullLength;
  const W = s.hullWidth;
  const C = s.hullClearance;
  const H = s.hullHeight;
  const top = C + H;
  const cab = s.cabLength ?? 2.2;
  const r = s.running.type === 'wheels' ? s.running.radius : 0.55;
  const n = s.running.type === 'wheels' ? s.running.axles : 3;
  const zF = -L / 2;
  const zR = L / 2;
  const zBonnet = zF + cab * 0.47;
  const zCabRear = zF + cab;
  const zBed = zCabRear + 0.12;
  const yBed = C + 0.32;
  const cabTop = Math.min(top - 0.25, C + 1.75);
  const cw = W / 2 - 0.1;

  const defs: PartDef[] = [
    boxPart('bonnet', 'cab', [-0.72, C, zF + 0.15], [0.72, C + 0.95, zBonnet], {
      front: T.grille,
      rear: T.cabSheet,
      side: T.bonnet,
      top: T.bonnet,
      bottom: T.sump,
    }),
    boxPart('cab', 'cab', [-cw, C, zBonnet], [cw, cabTop, zCabRear], {
      front: T.windscreen,
      rear: T.cabSheet,
      side: T.cabSheet,
      top: T.cabSheet,
      bottom: T.cabFloor,
    }),
    boxPart(
      'fuel tank',
      'tank',
      [-1.19, C - 0.39, zCabRear - 0.1],
      [-0.71, C + 0.09, zCabRear + 0.9],
      uniform(T.fuelTank),
      {
        spaced: true,
        component: 'fuel',
      },
    ),
  ];
  const comps: ComponentBox[] = [
    comp('engine', 'engine', [-0.5, C + 0.1, zF + 0.25], [0.5, C + 0.85, zBonnet - 0.05], {
      absorb: 40,
      effect: 'mobility',
    }),
    comp('crew', 'cab', [-1.05, C + 0.4, zBonnet + 0.1], [1.05, cabTop - 0.1, zCabRear - 0.08], {
      effect: 'mobility',
    }),
    comp(
      'fuel',
      'fuel tank',
      [-1.19, C - 0.39, zCabRear - 0.1],
      [-0.71, C + 0.09, zCabRear + 0.9],
      {
        external: true,
      },
    ),
  ];
  if (kind === 'truckCargo') {
    defs.push(
      boxPart('cargo bed', 'cargo', [-W / 2, yBed - 0.06, zBed], [W / 2, yBed + 0.6, zR], {
        front: T.bedSide,
        rear: T.bedSide,
        side: T.bedSide,
        top: T.canvas,
        bottom: T.bedFloor,
      }),
      part(
        'canvas tilt',
        'cargo',
        [
          ...boxPlates(
            'tilt',
            [-W / 2 + 0.02, yBed + 0.6, zBed + 0.02],
            [W / 2 - 0.02, top, zR - 0.02],
            uniform(T.canvas),
          ),
          slope(
            'right tilt shoulder',
            'top',
            T.canvas,
            [W / 2 - 0.02, top - 0.32, 0],
            [W / 2 - 0.4, top, 0],
            'z',
            [1, 1, 0],
          ),
          slope(
            'left tilt shoulder',
            'top',
            T.canvas,
            [-W / 2 + 0.02, top - 0.32, 0],
            [-W / 2 + 0.4, top, 0],
            'z',
            [-1, 1, 0],
          ),
        ],
        [-W / 2 + 0.02, yBed + 0.6, zBed + 0.02],
        [W / 2 - 0.02, top, zR - 0.02],
      ),
    );
    comps.push(
      comp('cargo', 'cargo', [-1.15, yBed + 0.05, zBed + 0.1], [1.15, top - 0.15, zR - 0.1], {
        absorb: 8,
      }),
    );
  } else if (kind === 'truckFuel') {
    const yb = yBed + 0.08;
    const rv = (top - yb) / 2;
    const rh = W / 2 - 0.1;
    const yc = yb + rv;
    const z0 = zBed + 0.05;
    const z1 = zR - 0.35;
    const plates: PlateDef[] = [
      plane('tank front', 'front', T.tankerShell, [0, 0, -1], [0, 0, z0]),
      plane('tank rear', 'rear', T.tankerShell, [0, 0, 1], [0, 0, z1]),
    ];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const face: ArmourFace = sn > 0.5 ? 'top' : sn < -0.5 ? 'bottom' : 'side';
      // tangent plane of the elliptical shell at angle a (outward normal ∝ (cos a / rh, sin a / rv))
      plates.push(
        plane(
          `tank shell ${k}`,
          face,
          T.tankerShell,
          [c / rh, sn / rv, 0],
          [rh * c, yc + rv * sn, 0],
        ),
      );
    }
    defs.push(part('tank body', 'tank', plates, [-rh, yb, z0], [rh, top, z1]));
    comps.push(
      comp(
        'fuel',
        'tank load',
        [-rh + 0.1, yb + 0.1, z0 + 0.05],
        [rh - 0.1, top - 0.1, z1 - 0.05],
        { weight: 3 },
      ),
    );
  } else {
    const chh = Math.min(0.5, (top - yBed - 0.3) / 3);
    const cTop = yBed + 0.06 + 3 * chh;
    defs.push(
      // the bed is open on top: the crates stand out of it (their own part)
      boxPart('cargo bed', 'cargo', [-W / 2, yBed - 0.06, zBed], [W / 2, yBed + 0.45, zR], {
        front: T.bedSide,
        rear: T.bedSide,
        side: T.bedSide,
        top: 0,
        bottom: T.bedFloor,
      }),
      boxPart(
        'ammunition crates',
        'cargo',
        [-W / 2 + 0.125, yBed + 0.06, zBed + 0.125],
        [W / 2 - 0.125, cTop, zR - 0.125],
        uniform(T.crates),
      ),
    );
    comps.push(
      comp(
        'ammo',
        'ammunition load',
        [-W / 2 + 0.2, yBed + 0.1, zBed + 0.2],
        [W / 2 - 0.2, cTop - 0.05, zR - 0.2],
        {
          absorb: 25,
          weight: 2,
        },
      ),
    );
  }
  const ww = Math.min(0.42, r * 0.72);
  const xw = W / 2 - ww / 2 - 0.02;
  const zs = axleZs(n, zF + 0.85, zR - 0.9);
  if (n >= 3) zs[zs.length - 2] = zs[zs.length - 1] - 1.38;
  zs.forEach((z, i) => {
    for (const side of [-1, 1]) {
      const name = `${side < 0 ? 'left' : 'right'} wheel ${i + 1}`;
      const min: V3 = [side * xw - ww / 2, 0, z - r];
      const max: V3 = [side * xw + ww / 2, 2 * r, z + r];
      defs.push(
        boxPart(name, 'wheels', min, max, uniform(T.tyre), {
          spaced: true,
          component: 'runningGear',
        }),
      );
      comps.push(
        comp('runningGear', name, min, max, { external: true, weight: 1 / (2 * zs.length) }),
      );
    }
  });
  return compile(kind, defs, comps, 0);
}

/** The 20 × 20 ft strafe panel: a board that every round passes through. */
function buildPanel(s: VehicleShape) {
  const w = s.hullWidth / 2;
  const t = Math.min(0.12, s.hullLength * 0.4) / 2;
  return compile(
    'panel',
    [
      boxPart(
        'panel',
        'panel',
        [-w, s.hullClearance, -t],
        [w, s.hullClearance + s.hullHeight, t],
        uniform(0),
      ),
    ],
    [],
    0,
  );
}

/** The damage model of every class (armour parts, plates, components, bounds). */
export const VEHICLE_MODELS: Record<VehicleKind, VehicleClassModel> = {
  mbt: buildMbt('mbt', VEHICLE_SHAPES.mbt, true, true),
  ifv: buildIfv(VEHICLE_SHAPES.ifv),
  apc: buildApc(VEHICLE_SHAPES.apc),
  truckCargo: buildTruck('truckCargo', VEHICLE_SHAPES.truckCargo),
  truckFuel: buildTruck('truckFuel', VEHICLE_SHAPES.truckFuel),
  truckAmmo: buildTruck('truckAmmo', VEHICLE_SHAPES.truckAmmo),
  hulk: buildMbt('hulk', VEHICLE_SHAPES.hulk, false, false),
  panel: buildPanel(VEHICLE_SHAPES.panel),
};

// ---- What a 30 mm round does (PLAN §6.3) -------------------------------------------------------

export const ROUND_EFFECTS = {
  /** Beyond this angle from the plate normal a round glances off (contract §5), rad. */
  ricochetObliquity: 70 * DEG,
  /** Plates thinner than this are cut, not deflected, at any angle, mm (sheet metal, tyres). */
  ricochetMinThicknessMm: 5,
  /** Share of the velocity along the plate kept by a ricochet, and of the normal part reversed. */
  ricochetTangential: 0.72,
  ricochetNormal: 0.12,
  /** Random deflection of a ricochet, rad (one sigma). */
  ricochetScatter: 3 * DEG,
  /** Round-to-round scatter of the penetration (striking yaw, plate hardness): sigma and clip. */
  penetrationSigma: 0.04,
  penetrationClip: 0.1,
  /** Path of a penetrator behind the armour, m, from just through to a large excess. */
  residualMin: 1.5,
  residualMax: 3.0,
  /** Excess penetration (mm) that gives the longest residual path. */
  residualRefMm: 30,
  /** Behind-armour debris: rays, cone half-angle range (rad), weight of each ray. */
  debrisRays: 6,
  debrisConeMin: 10 * DEG,
  debrisConeMax: 25 * DEG,
  debrisWeight: 0.35,
  /** HEI burst: external components within this radius can be hurt, m. */
  heiBurstRadius: 1.5,
  /** HEI that defeats a thin skin bursts inside: components within this radius, m. */
  heiInteriorRadius: 1.2,
  /** A direct hit within this distance of an external component (sight, tank) strikes it, m. */
  directHitRadius: 0.3,
  /** A kinetic round striking an external component is this much less damaging than a burst. */
  kineticExternalFactor: 0.5,
  /** After defeating a spaced layer, how far to look for the armour behind it, m. */
  spacedSearch: 4,
  /** Spaced layers (track run, fender, tank) a round may cross before the main armour. */
  maxLayers: 3,
} as const;

export const ROUND_EFFECTS_NOTES: Record<keyof typeof ROUND_EFFECTS, SourceNote> = {
  ricochetObliquity: {
    source: 'plan',
    confidence: 'approximate',
    note: 'docs/a10/ARCHITECTURE.md §5',
  },
  ricochetMinThicknessMm: { source: 'plan', confidence: 'estimate' },
  ricochetTangential: {
    source: 'plan',
    confidence: 'estimate',
    note: 'AP ricochets keep ≈60–80 % of their speed and leave flatter than they arrived',
  },
  ricochetNormal: { source: 'plan', confidence: 'estimate' },
  ricochetScatter: { source: 'plan', confidence: 'estimate' },
  penetrationSigma: {
    source: 'plan',
    confidence: 'estimate',
    note: 'brief: ±5–10 % deterministic scatter is realistic',
  },
  penetrationClip: { source: 'plan', confidence: 'estimate' },
  residualMin: { source: 'plan', confidence: 'estimate', note: 'brief: 1.5–3 m behind the armour' },
  residualMax: { source: 'plan', confidence: 'estimate' },
  residualRefMm: { source: 'plan', confidence: 'estimate' },
  debrisRays: { source: 'plan', confidence: 'estimate' },
  debrisConeMin: {
    source: 'plan',
    confidence: 'estimate',
    note: 'behind-armour debris cone ≈20–60° full angle for KE penetrators',
  },
  debrisConeMax: { source: 'plan', confidence: 'estimate' },
  debrisWeight: { source: 'plan', confidence: 'estimate' },
  heiBurstRadius: {
    source: 'plan',
    confidence: 'estimate',
    note: 'PGU-13/B ≈13 g HE + incendiary: fragments effective over ≈1–2 m',
  },
  heiInteriorRadius: { source: 'plan', confidence: 'estimate' },
  directHitRadius: { source: 'plan', confidence: 'estimate' },
  kineticExternalFactor: {
    source: 'plan',
    confidence: 'estimate',
    note: 'a clean hole through a track link or sight housing vs an HEI burst on it',
  },
  spacedSearch: { source: 'plan', confidence: 'estimate' },
  maxLayers: { source: 'plan', confidence: 'estimate' },
};

/** Chance that a penetrator crossing a component box hurts it, and how much health it removes. */
export const COMPONENT_VULNERABILITY: Record<
  ComponentId,
  { pHit: number; damageMin: number; damageMax: number }
> = {
  engine: { pHit: 0.7, damageMin: 0.35, damageMax: 0.9 },
  fuel: { pHit: 0.85, damageMin: 0.2, damageMax: 0.6 },
  ammo: { pHit: 0.85, damageMin: 0.3, damageMax: 0.8 },
  gun: { pHit: 0.6, damageMin: 0.4, damageMax: 1.0 },
  runningGear: { pHit: 0.5, damageMin: 0.3, damageMax: 0.85 },
  optics: { pHit: 0.85, damageMin: 0.6, damageMax: 1.0 },
  crew: { pHit: 0.75, damageMin: 0.5, damageMax: 1.0 },
  cargo: { pHit: 0.6, damageMin: 0.1, damageMax: 0.4 },
};

export const COMPONENT_VULNERABILITY_NOTES: Record<ComponentId, SourceNote> = {
  engine: { source: 'plan', confidence: 'estimate', note: 'PLAN §6.3: engine hit → mobility kill' },
  fuel: { source: 'plan', confidence: 'estimate' },
  ammo: { source: 'plan', confidence: 'estimate', note: 'PLAN §9: ammunition hit is catastrophic' },
  gun: { source: 'plan', confidence: 'estimate' },
  runningGear: { source: 'plan', confidence: 'estimate' },
  optics: { source: 'plan', confidence: 'estimate' },
  crew: { source: 'plan', confidence: 'estimate' },
  cargo: { source: 'plan', confidence: 'estimate' },
};

/** Health at or below which a component box, or the crew as a whole, is out of action. */
export const KILL_RULES = {
  /** A box at or below this health has failed (its `effect` applies). */
  boxDead: 0.3,
  /** Crew health at or below this: crew casualties → destroyed. */
  crewKill: 0.45,
  /** Running gear (all boxes) at or below this: mobility kill (wheeled vehicles only). */
  runningGearKill: 0.55,
  /** A fire inside the hull at or above this intensity: destroyed (burning). */
  fireKill: 0.35,
  /** Trucks: a dead engine plus this many other failed components: destroyed. */
  truckFailures: 1,
} as const;

export const KILL_RULES_NOTES: Record<keyof typeof KILL_RULES, SourceNote> = {
  boxDead: { source: 'plan', confidence: 'estimate' },
  crewKill: {
    source: 'plan',
    confidence: 'estimate',
    note: 'PLAN §9: crew casualties → destroyed',
  },
  runningGearKill: { source: 'plan', confidence: 'estimate' },
  fireKill: { source: 'plan', confidence: 'estimate', note: 'PLAN §9: destroyed and burning' },
  truckFailures: { source: 'plan', confidence: 'estimate' },
};

/** Ignition chances per damaging hit, by cause, and the fire each source makes. */
export const FIRE_SOURCES = {
  /** Diesel in the hull: hard to light, but the DU core of an API round is pyrophoric. */
  fuelInternal: { api: 0.35, hei: 0.5, fragment: 0.12, blast: 0.3, intensity: 0.85, load: 260 },
  /** External cells, drums and a truck's own tank: burn outside the crew space. */
  fuelExternal: { api: 0.25, hei: 0.45, fragment: 0.1, blast: 0.35, intensity: 0.45, load: 90 },
  /** Ruptured oil and fuel lines. */
  engine: { api: 0.12, hei: 0.22, fragment: 0.05, blast: 0.1, intensity: 0.45, load: 70 },
  /** Propellant fire when a hit on the ammunition does not detonate it. */
  ammo: { api: 0.8, hei: 0.6, fragment: 0.4, blast: 0.6, intensity: 1.0, load: 300 },
  cargo: { api: 0.08, hei: 0.25, fragment: 0.05, blast: 0.15, intensity: 0.6, load: 400 },
  /** The load of a fuel tanker. */
  tanker: { api: 0.4, hei: 0.65, fragment: 0.15, blast: 0.6, intensity: 1.0, load: 900 },
} as const;

export const FIRE_SOURCES_NOTES: Record<keyof typeof FIRE_SOURCES, SourceNote> = {
  fuelInternal: {
    source: 'wikiGau8',
    confidence: 'estimate',
    note: 'API: pyrophoric depleted-uranium core; diesel ignites less readily than petrol',
  },
  fuelExternal: { source: 'plan', confidence: 'estimate' },
  engine: { source: 'plan', confidence: 'estimate' },
  ammo: { source: 'plan', confidence: 'estimate' },
  cargo: { source: 'plan', confidence: 'estimate' },
  tanker: { source: 'plan', confidence: 'estimate', note: 'PLAN §9: large secondary explosions' },
};

/** Fire growth and decay, and how fires turn into ammunition cook-offs. */
export const FIRE_MODEL = {
  /** Time constant of a fire growing toward its intensity, s. */
  growTime: 12,
  /** Time constant of a fire dying once its fuel is spent, s. */
  decayTime: 90,
  /** Fires below this intensity are out. */
  out: 0.01,
  /** A cook-off is decided once an inside fire reaches this intensity. */
  cookOffFire: 0.4,
} as const;

export const FIRE_MODEL_NOTES: Record<keyof typeof FIRE_MODEL, SourceNote> = {
  growTime: { source: 'plan', confidence: 'estimate' },
  decayTime: { source: 'plan', confidence: 'estimate' },
  out: { source: 'plan', confidence: 'estimate' },
  cookOffFire: { source: 'plan', confidence: 'estimate' },
};

/**
 * What the ammunition (or a tanker's load) does, per class: chance a damaging hit detonates it,
 * share of detonations that are immediate, delay of the others (s), chance that a fire cooks it
 * off later and the delay, and the TNT-equivalent charge of the explosion (kg, the 'detonation'
 * event; matches the effects module's sizes). Ammunition trucks then pop for a while.
 */
export const AMMO_EFFECTS: Record<
  VehicleKind,
  {
    pDetonate: number;
    pImmediate: number;
    delay: [number, number];
    pCookOff: number;
    cookOffDelay: [number, number];
    charge: number;
    pops: [number, number];
    popCharge: [number, number];
    popSpan: [number, number];
  } | null
> = {
  mbt: {
    pDetonate: 0.55,
    pImmediate: 0.5,
    delay: [1, 10],
    pCookOff: 0.65,
    cookOffDelay: [15, 150],
    charge: 28,
    pops: [0, 0],
    popCharge: [0, 0],
    popSpan: [0, 0],
  },
  ifv: {
    pDetonate: 0.4,
    pImmediate: 0.5,
    delay: [1, 8],
    pCookOff: 0.5,
    cookOffDelay: [15, 120],
    charge: 10,
    pops: [0, 0],
    popCharge: [0, 0],
    popSpan: [0, 0],
  },
  apc: {
    pDetonate: 0.2,
    pImmediate: 0.6,
    delay: [1, 6],
    pCookOff: 0.3,
    cookOffDelay: [20, 120],
    charge: 6,
    pops: [0, 0],
    popCharge: [0, 0],
    popSpan: [0, 0],
  },
  truckAmmo: {
    pDetonate: 0.25,
    pImmediate: 0.3,
    delay: [1, 12],
    pCookOff: 0.95,
    cookOffDelay: [5, 45],
    charge: 70,
    pops: [6, 14],
    popCharge: [1, 6],
    popSpan: [20, 90],
  },
  truckFuel: {
    pDetonate: 0,
    pImmediate: 0,
    delay: [0, 0],
    pCookOff: 0.7,
    cookOffDelay: [4, 30],
    charge: 45,
    pops: [0, 0],
    popCharge: [0, 0],
    popSpan: [0, 0],
  },
  truckCargo: null,
  hulk: null,
  panel: null,
};

export const AMMO_EFFECTS_NOTES: Partial<Record<VehicleKind, SourceNote>> = {
  mbt: {
    source: 'plan',
    confidence: 'estimate',
    note: 'T-72 carousel: penetrating hits on the ammunition very often end in a catastrophic explosion, sometimes after a fire',
  },
  ifv: { source: 'plan', confidence: 'estimate' },
  apc: { source: 'plan', confidence: 'estimate', note: '14.5 / 7.62 mm ammunition only' },
  truckAmmo: {
    source: 'plan',
    confidence: 'estimate',
    note: 'PLAN §9: large secondary explosions',
  },
  truckFuel: { source: 'plan', confidence: 'estimate', note: 'tanker load bursting in a fireball' },
};

/** TNT-equivalent charge of the explosion when a vehicle is destroyed catastrophically, kg. */
export const SECONDARY_CHARGE: Record<VehicleKind, number> = {
  mbt: 28,
  ifv: 10,
  apc: 6,
  truckCargo: 4,
  truckFuel: 45,
  truckAmmo: 70,
  hulk: 3,
  panel: 0.5,
};

// ---- Blast and fragments (PLAN §6.5) -----------------------------------------------------------

/**
 * Air blast of a surface burst. Scaled distance Z = R / W^(1/3) (R m to the vehicle's nearest
 * surface, W kg TNT). Side-on impulse i = W^(1/3) · impulseCoeff / Z^impulseExp (Pa·s), a power
 * law through the hemispherical-surface-burst curves of UFC 3-340-02 (Kingery–Bulmash) for
 * 1 < Z < 16: Z 1.2 → ≈360, Z 4 → ≈100, Z 8 → ≈54 Pa·s/kg^(1/3).
 */
export const BLAST = {
  impulseCoeff: 400,
  impulseExp: 0.95,
  /** Closest distance used for Z (charge radius and the vehicle's own surface), m. */
  contactRadius: 0.3,
  /** Firing pit: a dug-in vehicle feels the blast as if this much farther away. */
  dugInFactor: 1.5,
  /** A Mk-82-sized charge for the threshold table: Tritonal 87 kg × ≈1.1 TNT equivalence. */
  mk82ChargeKg: 96,
  /** Its fragmenting case, kg (241 kg bomb, 87 kg filling, fins and fuze). */
  mk82FragmentKg: 125,
} as const;

export const BLAST_NOTES: Record<keyof typeof BLAST, SourceNote> = {
  impulseCoeff: {
    source: 'ufc334002',
    confidence: 'approximate',
    note: 'fit to UFC 3-340-02 (2008) fig. 2-15, hemispherical surface burst',
  },
  impulseExp: { source: 'ufc334002', confidence: 'approximate' },
  contactRadius: { source: 'plan', confidence: 'estimate' },
  dugInFactor: { source: 'plan', confidence: 'estimate', note: 'berm shields the side-on wave' },
  mk82ChargeKg: { source: 'plan', confidence: 'approximate', note: 'Mk-82: 87 kg Tritonal' },
  mk82FragmentKg: { source: 'plan', confidence: 'approximate' },
};

/** One level of blast damage: reached when Z ≤ z AND the impulse ≥ impulse (Pa·s). */
export interface BlastLevel {
  z: number;
  impulse: number;
}

/**
 * Blast damage by class. catastrophic: the hull fails and the ammunition or load goes up;
 * destroyed: hull ruptured, crew incapacitated; heavy: running gear, sights and gear wrecked
 * (mobility and firepower kill); light: external components hurt, more the closer they are.
 *
 * A level is reached when the scaled distance to the vehicle's NEAREST surface is at most `z`
 * (the peak pressure there) AND the impulse at the vehicle's CENTRE is at least `impulse` Pa·s
 * (the whole vehicle is loaded). With a Mk-82-sized charge (W^(1/3) ≈ 4.6) a tank is destroyed
 * within ≈4 m and immobilised within ≈7 m, light armour is destroyed within ≈10–11 m and a truck
 * within ≈32 m (PLAN §6.5). A small charge (a 30 mm HEI burst, a rocket warhead) loads only a
 * small part of a vehicle: its impulse at the centre stays below the floors, so it hurts only
 * what is near it (the light level, and its fragments).
 */
export const BLAST_THRESHOLDS: Record<
  VehicleKind,
  {
    catastrophic: BlastLevel | null;
    destroyed: BlastLevel;
    heavy: BlastLevel;
    light: BlastLevel;
  } | null
> = {
  mbt: {
    catastrophic: { z: 0.45, impulse: 2200 },
    destroyed: { z: 0.9, impulse: 1100 },
    heavy: { z: 1.6, impulse: 650 },
    light: { z: 3.0, impulse: 100 },
  },
  ifv: {
    catastrophic: { z: 0.7, impulse: 1500 },
    destroyed: { z: 2.2, impulse: 600 },
    heavy: { z: 3.2, impulse: 350 },
    light: { z: 5.0, impulse: 60 },
  },
  apc: {
    catastrophic: { z: 0.6, impulse: 1300 },
    destroyed: { z: 2.4, impulse: 550 },
    heavy: { z: 3.5, impulse: 320 },
    light: { z: 5.5, impulse: 55 },
  },
  truckCargo: {
    catastrophic: null,
    destroyed: { z: 7.0, impulse: 250 },
    heavy: { z: 9.5, impulse: 150 },
    light: { z: 14, impulse: 40 },
  },
  truckFuel: {
    catastrophic: { z: 1.2, impulse: 900 },
    destroyed: { z: 7.0, impulse: 250 },
    heavy: { z: 9.5, impulse: 150 },
    light: { z: 14, impulse: 40 },
  },
  truckAmmo: {
    catastrophic: { z: 1.2, impulse: 900 },
    destroyed: { z: 7.0, impulse: 250 },
    heavy: { z: 9.5, impulse: 150 },
    light: { z: 14, impulse: 40 },
  },
  hulk: null,
  panel: null,
};

export const BLAST_THRESHOLDS_NOTES: Record<VehicleKind, SourceNote> = {
  mbt: {
    source: 'plan',
    confidence: 'estimate',
    note: 'PLAN §6.5: a tank needs a hit within a few metres; Z 0.9 ≈ several MPa side-on',
  },
  ifv: { source: 'plan', confidence: 'estimate', note: 'light armour between tank and truck' },
  apc: { source: 'plan', confidence: 'estimate' },
  truckCargo: {
    source: 'plan',
    confidence: 'estimate',
    note: 'PLAN §6.5 / §16: a truck is destroyed at 30 m from a Mk-82 (blast and fragments)',
  },
  truckFuel: { source: 'plan', confidence: 'estimate' },
  truckAmmo: { source: 'plan', confidence: 'estimate' },
  hulk: { source: 'plan', confidence: 'estimate', note: 'range hulk: stays intact for scoring' },
  panel: { source: 'plan', confidence: 'estimate', note: 'range target: stays intact' },
};

/**
 * Statistical fragments: Mott distribution N(>m) = N0·exp(-√(m/μ)), N0 = M/(2μ), with μ scaled
 * with the case size from a Mk-82-class reference; Gurney velocity V0 = √(2E)/√(M/C + 1/2)
 * (cylinder); drag slows each fragment as v = V0·exp(-R/λ), λ = 2·m^(1/3)/(Cd·ρ·γ); steel
 * fragments penetrate P = penCoeff·m_g^(1/3)·(v/1000)^penExp mm of RHA (fitted to fragment-
 * simulating-projectile ballistic limits). Hits on a vehicle ∝ fragments × presented area / 4πR².
 */
export const FRAGMENTS = {
  /** Mott scale mass μ of the reference case, kg, and that case's mass, kg. */
  mottMuRef: 0.0035,
  mottCaseRef: 150,
  /** μ grows as (case mass)^mottScaleExp (geometric similarity). */
  mottScaleExp: 0.5,
  /** Gurney constant √(2E) of TNT, m/s. */
  gurney: 2440,
  /** Fragments lighter than this do not damage vehicles, kg. */
  minMass: 0.001,
  /** Share of the fragments thrown above the ground (a surface burst). */
  groundFactor: 0.5,
  /** Drag coefficient and presented-area shape factor A = γ·m^(2/3) (m², kg). */
  dragCoeff: 1.2,
  shapeFactor: 0.0038,
  /** Penetration: mm of RHA for a 1 g fragment at 1,000 m/s, and the velocity exponent. */
  penCoeff: 4.2,
  penExp: 1.5,
  /** Slower fragments are ignored, m/s. */
  minVelocity: 150,
  /** At most this many fragment hits are traced per vehicle (each then stands for several). */
  maxTraced: 40,
  /** A fragment is this much less likely than a 30 mm penetrator to hurt what it crosses. */
  damageFactor: 0.45,
  /** Residual path behind the plate, m, and the excess penetration for the longest one, mm. */
  residualMin: 0.3,
  residualMax: 1.2,
  residualRefMm: 10,
} as const;

export const FRAGMENTS_NOTES: Record<keyof typeof FRAGMENTS, SourceNote> = {
  mottMuRef: {
    source: 'mott1947',
    confidence: 'estimate',
    note: 'Mott (1947) with B ≈ 0.055 lb½/in^(7/6), Mk-82 wall ≈11 mm, ID ≈250 mm → μ ≈ 3.5 g',
  },
  mottCaseRef: { source: 'plan', confidence: 'estimate' },
  mottScaleExp: {
    source: 'mott1947',
    confidence: 'estimate',
    note: 'μ ∝ t^(5/6)·d^(2/3) ∝ M^(1/2)',
  },
  gurney: {
    source: 'gurney1943',
    confidence: 'approximate',
    note: 'Gurney (1943): TNT √(2E) ≈ 2.44 km/s',
  },
  minMass: { source: 'plan', confidence: 'estimate' },
  groundFactor: { source: 'plan', confidence: 'estimate' },
  dragCoeff: {
    source: 'plan',
    confidence: 'approximate',
    note: 'irregular steel fragments, supersonic',
  },
  shapeFactor: { source: 'plan', confidence: 'approximate', note: 'mean presented area of a cube' },
  penCoeff: {
    source: 'plan',
    confidence: 'estimate',
    note: 'fits FSP limits: 1.1 g at 1,100 m/s ≈ 6 mm; 54 g at 950 m/s ≈ 15 mm',
  },
  penExp: { source: 'plan', confidence: 'estimate' },
  minVelocity: { source: 'plan', confidence: 'estimate' },
  maxTraced: { source: 'plan', confidence: 'estimate', note: 'performance' },
  damageFactor: { source: 'plan', confidence: 'estimate' },
  residualMin: { source: 'plan', confidence: 'estimate' },
  residualMax: { source: 'plan', confidence: 'estimate' },
  residualRefMm: { source: 'plan', confidence: 'estimate' },
};

// ---- Behaviour (PLAN §9) -----------------------------------------------------------------------

export const MOBILITY = {
  /** Columns on roads: cruise speed range, m/s (30–40 km/h), and spacing, m. */
  columnSpeedMin: 30 / 3.6,
  columnSpeedMax: 40 / 3.6,
  columnSpacing: 50,
  /** The range lane's remote-controlled column, m/s. */
  laneSpeed: 15 / 3.6,
  /** Cross-country speed when scattering or moving to cover, m/s. */
  offRoadTracked: 7,
  offRoadWheeled: 6,
  /** Acceleration and braking, m/s². */
  accel: 1.0,
  brake: 2.5,
  /** Tightest turn, m. */
  turnRadiusTracked: 6,
  turnRadiusWheeled: 9,
  /** Distance ahead on the road the driver steers toward, m. */
  lookAhead: 9,
  /** Keep right of the road centre line by this share of the road width. */
  roadKeepRight: 0.22,
  /** Grade above which vehicles slow, slow-down per unit of grade, and the slowest factor. */
  gradeStart: 0.03,
  gradeSlow: 3.5,
  gradeMinFactor: 0.35,
  /** Steepest ground a vehicle will drive onto, rad. */
  maxSlopeTracked: 28 * DEG,
  maxSlopeWheeled: 20 * DEG,
  /** Attacked: a round or blast this close to a vehicle alerts its group, m. */
  alertRadius: 150,
  /** Columns scatter this far off the road, m. */
  scatterMin: 50,
  scatterMax: 200,
  /** Drivers react after this long, s. */
  reactionMin: 1.5,
  reactionMax: 5,
  /** Parked groups: share that start and move to cover, delay before moving, search radius. */
  coverChance: 0.75,
  coverDelayMin: 6,
  coverDelayMax: 25,
  coverSearch: 400,
  /** Engines off when parked: share of parked groups. */
  parkedEnginesOff: 0.5,
  /** Turret: idle scan amplitude and rate, slew rate when alerted, rad and rad/s. */
  turretScan: 60 * DEG,
  turretScanRate: 3 * DEG,
  turretSlewRate: 20 * DEG,
  /** Hull top left above the ground when dug in, m. */
  dugInExposed: 0.25,
} as const;

export const MOBILITY_NOTES: Record<keyof typeof MOBILITY, SourceNote> = {
  columnSpeedMin: { source: 'plan', confidence: 'approximate', note: 'PLAN §9: 30 to 40 km/h' },
  columnSpeedMax: { source: 'plan', confidence: 'approximate' },
  columnSpacing: { source: 'plan', confidence: 'approximate', note: 'brief: ≈50 m' },
  laneSpeed: { source: 'plan', confidence: 'estimate', note: 'PLAN §11: a slow moving column' },
  offRoadTracked: { source: 'plan', confidence: 'estimate' },
  offRoadWheeled: { source: 'plan', confidence: 'estimate' },
  accel: { source: 'plan', confidence: 'estimate' },
  brake: { source: 'plan', confidence: 'estimate' },
  turnRadiusTracked: { source: 'plan', confidence: 'estimate' },
  turnRadiusWheeled: { source: 'plan', confidence: 'estimate' },
  lookAhead: { source: 'plan', confidence: 'estimate' },
  roadKeepRight: { source: 'plan', confidence: 'estimate' },
  gradeStart: { source: 'plan', confidence: 'estimate' },
  gradeSlow: {
    source: 'plan',
    confidence: 'estimate',
    note: '≈15–20 hp/t: a 10 % grade costs about a quarter of the cruise speed',
  },
  gradeMinFactor: { source: 'plan', confidence: 'estimate' },
  maxSlopeTracked: { source: 'plan', confidence: 'estimate' },
  maxSlopeWheeled: { source: 'plan', confidence: 'estimate' },
  alertRadius: { source: 'plan', confidence: 'estimate', note: 'brief: ≈150 m' },
  scatterMin: { source: 'plan', confidence: 'estimate', note: 'brief: 50–200 m off the road' },
  scatterMax: { source: 'plan', confidence: 'estimate' },
  reactionMin: { source: 'plan', confidence: 'estimate' },
  reactionMax: { source: 'plan', confidence: 'estimate' },
  coverChance: { source: 'plan', confidence: 'estimate' },
  coverDelayMin: { source: 'plan', confidence: 'estimate' },
  coverDelayMax: { source: 'plan', confidence: 'estimate' },
  coverSearch: { source: 'plan', confidence: 'estimate' },
  parkedEnginesOff: { source: 'plan', confidence: 'estimate' },
  turretScan: { source: 'plan', confidence: 'estimate' },
  turretScanRate: { source: 'plan', confidence: 'estimate' },
  turretSlewRate: { source: 'plan', confidence: 'estimate', note: 'T-72 traverse ≈24°/s' },
  dugInExposed: { source: 'plan', confidence: 'estimate', note: 'hull-down: turret and hull top' },
};

/**
 * Thermal picture (PLAN §8): temperatures above ambient, K, approached exponentially with the
 * time constants given (s): engine deck and exhaust hot while running, running gear warm while
 * moving, everything cooling over minutes once the engine stops, fires very hot.
 */
export const THERMAL = {
  engineIdle: 32,
  engineLoad: 45,
  engineWarm: 180,
  engineCool: 900,
  exhaustIdle: 70,
  exhaustLoad: 95,
  exhaustWarm: 25,
  exhaustCool: 240,
  runningPerSpeed: 2.2,
  runningMax: 30,
  runningWarm: 240,
  runningCool: 900,
  hullSun: 5,
  hullEngineShare: 0.15,
  hullTime: 1200,
  /** Hull temperature a full fire drives toward, K, and how fast it heats and cools. */
  fireHull: 220,
  fireWarm: 20,
  fireCool: 1500,
} as const;

export const THERMAL_NOTES: Record<keyof typeof THERMAL, SourceNote> = {
  engineIdle: { source: 'plan', confidence: 'estimate' },
  engineLoad: { source: 'plan', confidence: 'estimate' },
  engineWarm: { source: 'plan', confidence: 'estimate' },
  engineCool: { source: 'plan', confidence: 'estimate', note: 'brief: minutes' },
  exhaustIdle: { source: 'plan', confidence: 'estimate' },
  exhaustLoad: { source: 'plan', confidence: 'estimate' },
  exhaustWarm: { source: 'plan', confidence: 'estimate' },
  exhaustCool: { source: 'plan', confidence: 'estimate' },
  runningPerSpeed: { source: 'plan', confidence: 'estimate' },
  runningMax: { source: 'plan', confidence: 'estimate' },
  runningWarm: { source: 'plan', confidence: 'estimate' },
  runningCool: { source: 'plan', confidence: 'estimate' },
  hullSun: { source: 'plan', confidence: 'estimate' },
  hullEngineShare: { source: 'plan', confidence: 'estimate' },
  hullTime: { source: 'plan', confidence: 'estimate' },
  fireHull: { source: 'plan', confidence: 'estimate' },
  fireWarm: { source: 'plan', confidence: 'estimate' },
  fireCool: { source: 'plan', confidence: 'estimate' },
};

// ---- Scenarios (PLAN §11) ----------------------------------------------------------------------

/** Vehicle groups, in column order (the first vehicle leads). */
export const GROUP_TEMPLATES: Record<string, readonly VehicleKind[]> = {
  tankPlatoon: ['mbt', 'mbt', 'mbt'],
  mechPlatoon: ['ifv', 'ifv', 'ifv'],
  mechTeam: ['mbt', 'ifv', 'ifv'],
  apcPlatoon: ['apc', 'apc', 'apc', 'truckCargo'],
  tankCompanyHq: ['mbt', 'mbt', 'apc', 'truckCargo'],
  supplyColumn: ['apc', 'truckCargo', 'truckFuel', 'truckAmmo', 'truckCargo'],
  mixedColumn: ['mbt', 'ifv', 'truckCargo', 'truckFuel', 'truckAmmo'],
  fuelPoint: ['truckFuel', 'truckFuel', 'truckCargo', 'apc'],
  ammoPoint: ['truckAmmo', 'truckAmmo', 'truckCargo', 'ifv'],
};

/** Which templates suit each kind of placement. */
export const PLACEMENT_TEMPLATES = {
  column: ['supplyColumn', 'mixedColumn', 'tankPlatoon', 'mechTeam', 'apcPlatoon'],
  dugIn: ['tankPlatoon', 'mechPlatoon', 'mechTeam'],
  treeline: ['fuelPoint', 'ammoPoint', 'tankCompanyHq', 'mechPlatoon', 'supplyColumn'],
  open: ['tankPlatoon', 'mechTeam', 'apcPlatoon', 'tankCompanyHq', 'fuelPoint', 'ammoPoint'],
} as const;

export const SCENARIO = {
  /** Free hunt: groups alive at any time. */
  huntGroupsMin: 6,
  huntGroupsMax: 10,
  /** Columns among them. */
  huntColumnsMin: 1,
  huntColumnsMax: 2,
  /** Groups are placed at least this far from the start, and replacements from the aircraft, m. */
  minDistance: 8000,
  /** A replacement group appears this long after a group is wiped out, s. */
  respawnDelayMin: 20,
  respawnDelayMax: 60,
  /** Parked spacing inside a group, m. */
  parkedSpacingMin: 25,
  parkedSpacingMax: 60,
  /** Dug-in vehicles abreast, m. */
  dugInSpacing: 45,
  /** Wrecks are removed beyond this many vehicles (oldest, far from the aircraft first). */
  maxVehicles: 160,
  wreckAge: 600,
  wreckDistance: 10000,
} as const;

export const SCENARIO_NOTES: Record<keyof typeof SCENARIO, SourceNote> = {
  huntGroupsMin: { source: 'plan', confidence: 'confirmed', note: 'PLAN §11: six to ten groups' },
  huntGroupsMax: { source: 'plan', confidence: 'confirmed' },
  huntColumnsMin: { source: 'plan', confidence: 'estimate', note: 'brief: a column or two' },
  huntColumnsMax: { source: 'plan', confidence: 'estimate' },
  minDistance: { source: 'plan', confidence: 'estimate', note: 'brief: at least 8 km' },
  respawnDelayMin: { source: 'plan', confidence: 'estimate' },
  respawnDelayMax: { source: 'plan', confidence: 'estimate' },
  parkedSpacingMin: { source: 'plan', confidence: 'estimate' },
  parkedSpacingMax: { source: 'plan', confidence: 'estimate' },
  dugInSpacing: { source: 'plan', confidence: 'estimate' },
  maxVehicles: { source: 'plan', confidence: 'estimate', note: 'PLAN §14: up to 80 alive' },
  wreckAge: { source: 'plan', confidence: 'estimate' },
  wreckDistance: { source: 'plan', confidence: 'estimate' },
};

/** Range layouts (PLAN §11.2). */
export const RANGE_LAYOUT = {
  /** Strafe pit: panels abreast across the run-in line (150 ft apart) and hulks behind them. */
  strafePanels: 4,
  panelSpacing: 46,
  strafeHulks: 2,
  hulksBehind: 60,
  /** Bombing circle: a hulk on the centre and others on rings. */
  circleHulks: 6,
  circleRadiusMin: 40,
  circleRadiusMax: 150,
  /** Tactical lane: hulks scattered in the lane and a slow column on a loop. */
  laneHulks: 6,
  laneColumn: ['mbt', 'ifv', 'truckCargo', 'apc'] as readonly VehicleKind[],
  /** Loop semi-axes as shares of the lane radius (across and along the run-in line). */
  laneLoopAcross: 0.5,
  laneLoopAlong: 0.25,
} as const;

export const RANGE_LAYOUT_NOTES: Record<keyof typeof RANGE_LAYOUT, SourceNote> = {
  strafePanels: { source: 'plan', confidence: 'estimate' },
  panelSpacing: { source: 'plan', confidence: 'estimate' },
  strafeHulks: { source: 'plan', confidence: 'estimate' },
  hulksBehind: { source: 'plan', confidence: 'estimate' },
  circleHulks: { source: 'plan', confidence: 'estimate' },
  circleRadiusMin: { source: 'plan', confidence: 'estimate' },
  circleRadiusMax: { source: 'plan', confidence: 'estimate' },
  laneHulks: { source: 'plan', confidence: 'estimate' },
  laneColumn: { source: 'plan', confidence: 'estimate' },
  laneLoopAcross: { source: 'plan', confidence: 'estimate' },
  laneLoopAlong: { source: 'plan', confidence: 'estimate' },
};
