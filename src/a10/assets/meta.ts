/**
 * Types of public/a10/models/a10-meta.json, written by scripts/a10/convert-ac3d.mjs.
 * OWNED BY THE AIRCRAFT (ASSETS) MODULE. Aircraft files use the BODY frame (+X right wing, +Y up,
 * −Z nose, origin = reference point R); stores use BODY-aligned axes with the origin at the top
 * of their suspension lugs. Lengths in metres, angles in radians.
 */
export type Vec3T = [number, number, number];
export type QuatT = [number, number, number, number];

/** Inputs of the exterior pivots, in the simulation's own units (see aircraft.ts). */
export type ExteriorInput =
  | 'aileron'
  | 'elevator'
  | 'rudder'
  | 'speedBrake'
  | 'flaps'
  | 'slats'
  | 'canopy'
  | 'gearNose'
  | 'gearLeft'
  | 'gearRight'
  | 'compressionNose'
  | 'compressionLeft'
  | 'compressionRight'
  | 'wheelNose'
  | 'wheelLeft'
  | 'wheelRight'
  | 'n1Left'
  | 'n1Right'
  | 'barrelAngle';

export interface PivotDrive {
  /**
   * Exterior: an ExteriorInput (our units: surfaces −1..1, flaps rad, gear 0..1, n1 0..1, m/s).
   * Cockpit and pilot: the FlightGear property path.
   */
  input: string | null;
  /** Angle (rad) or travel (m) per unit of input; for spin, rad/s per unit. */
  gain?: number;
  offset?: number;
  /** Piecewise-linear [input, rad|m], sorted by input, clamped at both ends. */
  table?: [number, number][];
  min?: number;
  max?: number;
  /** No input: a fixed rotation. */
  constant?: boolean;
  note?: string;
}

export interface PivotMeta {
  /** Node name in the GLB (`<first target>__<channel>`). */
  node: string;
  type: 'rotate' | 'translate' | 'spin';
  /** Unit axis in the parent's frame (= the file frame at rest). */
  axis: Vec3T;
  /** Hinge centre at rest, file frame. */
  centre: Vec3T;
  /** FlightGear object names the animation moves. */
  targets: string[];
  /** Enclosing pivot (outer transform) or null. */
  parent: string | null;
  fg: {
    file: string;
    line: number;
    type: string;
    property?: string;
    factor?: number;
    offset?: number;
    table?: [number, number][];
    min?: number;
    max?: number;
  };
  drive: PivotDrive;
}

export interface ToggleMeta {
  node: string;
  /** Visibility with every FlightGear property at its default (0 / false / ''). */
  default: boolean;
  conditions: { cond: string; src: string }[];
  semantic?: {
    station?: number;
    view?: 'outside' | 'inside';
    variant?: 'A-10A' | 'A-10A+';
    gear?: 'up' | 'moving';
    lamp?: 'on' | 'off';
  };
}

export interface PickMeta {
  file: 'cockpit' | 'pilot';
  node: string;
  /** Node whose local frame `box` is in (a pivot, or the file root). */
  frame: string;
  box: { min: Vec3T; max: Vec3T };
  /** Invisible click target (not drawn). */
  hotspot: boolean;
  actions: {
    kind: 'pick' | 'knob' | 'slider';
    src: string;
    property: string | null;
    bindings: Record<string, string>[];
  }[];
}

export interface StorePlacement {
  /** Lug point of the store (or rack), aircraft BODY frame. */
  position: Vec3T;
  quaternion: QuatT;
  source: string;
}

export interface StationMeta {
  /** 1 (left wing tip) … 6 (centreline) … 11 (right wing tip). */
  station: number;
  /** FlightGear payload id (station − 1). */
  fgId: number;
  pylon: string;
  /** Pylon bottom, BODY. */
  suspension: Vec3T;
  /** Pylon bottom slope about +X (negative = nose down), rad. */
  pitch: number;
  /** FlightGear's placement of each store model id it can carry here. */
  placements: Record<string, StorePlacement>;
}

export interface RackMount {
  /** Lug point of the carried store, in the rack's frame (rack lugs = origin). */
  position: Vec3T;
  quaternion: QuatT;
  model: string;
}

export interface StoreModelMeta {
  label: string;
  file: string;
  lugFg: Vec3T;
  /** The store's own reference point (mid-length on the body axis) relative to the lugs. */
  centre: Vec3T;
  length: number;
  /** Largest cross-section extent, fins and wings included. */
  diameter: number;
  /** Of the parts drawn by default (not the hidden ones of `toggles`). */
  bounds: { min: Vec3T; max: Vec3T };
  lugObject: string | null;
  /**
   * Parts FlightGear shows only in some states, at their default visibility in the templates:
   * the Mk 82 AIR's `MK-82AIR_Chute` (its BSU-49 ballute, deployed after a high-drag release) is
   * hidden; show it on a released bomb with `getObjectByName(node).visible = true`.
   */
  toggles?: ToggleMeta[];
}

export interface LiveryMeta {
  id: string;
  name: string;
  /** URL path under public/a10/ (use a10Asset()). */
  main: string;
  detail: string;
  source: string;
}

export interface LightMeta {
  id: 'navLeft' | 'navRight' | 'top' | 'tail' | 'strobeLeft' | 'strobeRight' | 'landing';
  node: string | null;
  position: Vec3T;
  colour: Vec3T;
  kind: 'steady' | 'strobe' | 'landing';
}

export interface A10Meta {
  about: string;
  source: {
    repository: string;
    commit: string;
    date: string;
    licence: string;
    authors: string[];
  };
  frame: {
    axes: string;
    units: string;
    originFG: Vec3T;
    originNote: string;
    acToBody: [Vec3T, Vec3T, Vec3T];
    acToBodyOffset: Vec3T;
  };
  files: { exterior: string; cockpit: string; pilot: string };
  exterior: {
    pivots: PivotMeta[];
    toggles: ToggleMeta[];
    bounds: { min: Vec3T; max: Vec3T };
  };
  cockpit: {
    pivots: PivotMeta[];
    toggles: ToggleMeta[];
    uvAnims: {
      node: string;
      property: string | null;
      factor: number;
      offset: number;
      step: number | null;
      scroll: number | null;
      table: [number, number][] | null;
      /** UV direction in glTF texture space (v down). */
      uv: [number, number];
      src: string;
    }[];
    lods: { node: string; min: number; max: number | null; src: string }[];
    models: {
      node: string;
      file: string;
      offsets: Record<string, number> | null;
      standIn: boolean;
      frozen: boolean;
    }[];
    frozen: {
      model: string;
      targets: string[];
      type: string;
      property: string | null;
      src: string;
    }[];
  };
  pilot: { pivots: PivotMeta[]; toggles: ToggleMeta[] };
  pick: PickMeta[];
  liveries: LiveryMeta[];
  liverySlots: { main: string; detail: string };
  eye: {
    position: Vec3T;
    pitch: number;
    fovDeg: number;
    fovAxis: string;
    headingLimitDeg: number;
    source: string;
  };
  hud: { glassCorners: [Vec3T, Vec3T, Vec3T, Vec3T]; normal: Vec3T; source: string };
  displays: Record<
    'tv' | 'mpcd',
    { node: string; corners: [Vec3T, Vec3T, Vec3T, Vec3T]; shownWhen: string }
  >;
  gun: {
    muzzle: Vec3T;
    direction: Vec3T;
    spinPivot: string;
    clusterAxisPoint: Vec3T;
    fgSpawnPoint: Vec3T;
    fgSpawnSource: string;
    cannonBounds: { min: Vec3T; max: Vec3T };
  };
  gear: {
    contacts: Record<'nose' | 'left' | 'right', { centre: Vec3T; contact: Vec3T; radius: number }>;
    note: string;
  };
  /**
   * Hull points for ground contact with the gear up, on the parts that are always drawn (not the
   * 600-gal tanks). Off-centreline points are the right side's; the left side mirrors X.
   */
  hull: {
    note: string;
    noseTip: Vec3T;
    tailTip: Vec3T;
    /** Lowest fuselage point (one of the belly's two keels). */
    belly: Vec3T;
    /** Lowest fuselage point aft of the wing. */
    aftBelly: Vec3T;
    /** Outermost point, and the tip chord's leading and trailing ends (lower surface). */
    wingTip: { outer: Vec3T; leading: Vec3T; trailing: Vec3T };
    /** Lateral centre; top and bottom at mid-chord. */
    fin: { x: number; top: Vec3T; bottom: Vec3T };
    /** Retracted main wheel's lowest point (below the pod), and the pod bottom near its ends. */
    gearPod: { tyre: Vec3T; front: Vec3T; rear: Vec3T };
    pavePenny: Vec3T;
  };
  /** Fan hub (on the spin axis) and the nozzle exit (aft end of the nacelle). */
  engines: { side: 'left' | 'right'; fan: Vec3T; exhaust: Vec3T }[];
  lights: LightMeta[];
  stations: StationMeta[];
  racks: Record<string, { mounts: RackMount[]; source: string }>;
  stores: Record<string, StoreModelMeta>;
  /** Simulation StoreType → store model id. */
  storeTypes: Record<string, string>;
  checks: { fans: Record<string, { centroid: Vec3T; axisDistance: number }> };
  budget: Record<
    string,
    {
      bytes: number;
      triangles: number;
      drawCalls: number;
      vertices: number;
      materials: number;
      nodes: number;
    }
  >;
  textures: {
    file: string;
    source: string | string[];
    size: [number, number];
    bytes: number;
    livery?: string;
    atlas?: { source: string; x: number; y: number; size: number }[];
  }[];
}
