/**
 * Geometry of one turbine, in the nacelle frame (see model.ts). Every function returns ONE
 * merged BufferGeometry, shared by the four turbines:
 *
 *   nacelle  — duct ring, flame-holder ring, centre body, stators, exit guide vanes,
 *              trunnion pads / collars / stub axles and the tilt actuators (static)
 *   rotor    — fan hub and spinner (spins)
 *   blades   — the fan blades (spin; fade into the blur disc at speed)
 *   glow     — additive overlays lit by the combustion: flame ring, duct liner, stator
 *              flanks, a gas-glow disc and the hot tail cone
 *   blurDisc — the annulus that carries the motion-blur texture
 *   decal    — the turbine number, per index (it sits on the outboard quarters)
 */
import {
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Matrix4,
  Vector3,
} from 'three';
import { TURBINE } from '../../config/layout';
import { PALETTE } from '../../config/palette';
import { TAU } from '../../utils/math';
import { MeshBuilder } from './meshBuilder';
import {
  ATLAS_WHITE_V,
  DUCT_INNER_PROFILE,
  DUCT_OUTER_PROFILE,
  NOZZLE_Y,
  SKIN_TILES,
  bladeSection,
  linerV,
  profileArcFractions,
  profileRadiusAt,
  skinV,
  spinDirection,
  type ProfilePoint,
  type TurbineDetail,
} from './model';

const WHITE_UV = [0.5, ATLAS_WHITE_V] as const;

const C = {
  machinery: new Color(PALETTE.machinery),
  dark: new Color(PALETTE.machineryDark),
  pad: new Color('#353c43'),
  steel: new Color('#87919a'),
  bright: new Color('#c3cbd1'),
  white: new Color(PALETTE.markingWhite),
  yellow: new Color(PALETTE.markingYellow),
  skin: new Color('#ffffff'),
};

/** Local y of the origin of the glow mesh (its geometry is stored relative to it for sorting). */
export const GLOW_ORIGIN_Y = -3.5;

// ---- shared layout of the internals ----

const HUB_R = TURBINE.hubRadius;
const STATOR = { top: -1.7, bottom: -4.3, thickness: 0.55, lean: 0.17, inner: HUB_R - 0.3 };
const VANE = { top: -4.5, bottom: -6.4, thickness: 0.22, lean: 0.24, inner: 15.8, outer: 18.7 };
/** Flame-holder ring on the duct wall below the fan: wall top, inner top, inner bottom, wall bottom. */
const FLAME_RING: readonly ProfilePoint[] = [
  { r: 19.2, y: -2.1 },
  { r: 17.1, y: -2.4 },
  { r: 17.5, y: -3.0 },
  { r: 19.1, y: -3.5 },
];
/** Static centre body under the fan hub, ending in the tail cone that pokes out of the nozzle. */
const CENTRE_BODY: readonly ProfilePoint[] = [
  { r: 0, y: -9.6 },
  { r: 2.2, y: -7.4 },
  { r: 3.8, y: -5.0 },
  { r: HUB_R - 0.1, y: -3.6 },
  { r: HUB_R - 0.1, y: -1.5 },
  { r: 0, y: -1.5 },
];
/** Rotating hub and spinner (y relative to the fan plane). */
const ROTOR: readonly ProfilePoint[] = [
  { r: 0, y: -2.35 },
  { r: HUB_R - 0.05, y: -2.35 },
  { r: HUB_R, y: -1.9 },
  { r: HUB_R, y: 2.3 },
  { r: HUB_R - 0.3, y: 3.4 },
  { r: HUB_R - 1.2, y: 4.7 },
  { r: HUB_R - 2.6, y: 5.9 },
  { r: 0, y: 6.5 },
];

function statorMatrix(angle: number, lean: number, y: number, radius: number): Matrix4 {
  return new Matrix4()
    .makeRotationY(angle)
    .multiply(new Matrix4().makeTranslation(0, y, radius))
    .multiply(new Matrix4().makeRotationZ(lean));
}

function statorAngle(k: number, count: number): number {
  return ((k + 0.5) / count) * TAU;
}

// ---- nacelle ----

function addTrunnion(b: MeshBuilder, side: 1 | -1): void {
  const R = TURBINE.ductOuterRadius;
  // X-axis cylinders: a Y-axis cylinder turned onto the tilt axis
  const onAxis = (x: number, twist = 0) =>
    new Matrix4()
      .makeTranslation(side * x, 0, 0)
      .multiply(new Matrix4().makeRotationZ(-Math.PI / 2))
      .multiply(new Matrix4().makeRotationY(twist));
  // flat octagonal mounting land machined into the duct wall
  b.add(new CylinderGeometry(5.6, 5.6, 1.3, 8), onAxis(R - 0.8, Math.PI / 8), C.pad, WHITE_UV, true);
  // bearing collar: ends flush with the outer radius, where the pylon's bearing takes over
  b.add(new CylinderGeometry(3.7, 3.7, 1.2, 16), onAxis(R - 0.6), C.steel, WHITE_UV);
  b.add(new CylinderGeometry(2.6, 2.6, 0.5, 16), onAxis(R - 0.2), C.pad, WHITE_UV);
  // stub axle: runs into the pylon bearing inboard, shows as a capped stub outboard
  b.add(new CylinderGeometry(1.5, 1.5, 2.2, 12), onAxis(R + 0.1), C.dark, WHITE_UV);
  b.add(new CylinderGeometry(1.9, 1.9, 0.3, 12), onAxis(R + 1.05), C.steel, WHITE_UV);

  // tilt actuators: a ram from each lower corner of the land down the nozzle taper to a foot lug
  for (const fore of [1, -1]) {
    const head = new Vector3(side * 21.0, -2.0, fore * 4.6);
    const foot = new Vector3(side * 19.6, -5.5, fore * 9.0);
    const mid = new Vector3().lerpVectors(head, foot, 0.62);
    b.rod(head, mid, 0.55, 0.55, 8, C.steel, WHITE_UV);
    b.rod(new Vector3().lerpVectors(head, foot, 0.5), foot, 0.26, 0.26, 6, C.bright, WHITE_UV);
    const lug = new Matrix4()
      .makeRotationY(Math.atan2(foot.x, foot.z))
      .setPosition(foot.x * 0.985, foot.y, foot.z * 0.985);
    b.box([1.5, 1.1, 1.3], lug, C.pad, WHITE_UV);
  }
}

export function buildNacelleGeometry(d: TurbineDetail): BufferGeometry {
  const b = new MeshBuilder();

  // duct: faceted outer skin, smooth inner wall, both painted by the atlas
  b.lathe(DUCT_OUTER_PROFILE, {
    segments: d.ductSegments,
    color: C.skin,
    v: profileArcFractions(DUCT_OUTER_PROFILE, true).map(skinV),
    uRepeat: SKIN_TILES,
  });
  b.lathe(DUCT_INNER_PROFILE, {
    segments: d.ductSegments,
    smooth: true,
    color: C.skin,
    v: profileArcFractions(DUCT_INNER_PROFILE).map(linerV),
    uRepeat: SKIN_TILES,
  });

  b.lathe(FLAME_RING, { segments: d.ductSegments, color: C.dark, uv: WHITE_UV });
  b.lathe(CENTRE_BODY, { segments: d.hubSegments, smooth: true, color: C.dark, uv: WHITE_UV });

  // stators: struts from the centre body to the duct wall, just below the fan
  const statorOuter = profileRadiusAt(DUCT_INNER_PROFILE, STATOR.bottom) + 0.25;
  const statorLength = statorOuter - STATOR.inner;
  for (let k = 0; k < d.stators; k++) {
    b.box(
      [STATOR.thickness, STATOR.top - STATOR.bottom, statorLength],
      statorMatrix(
        statorAngle(k, d.stators),
        STATOR.lean,
        (STATOR.top + STATOR.bottom) / 2,
        (statorOuter + STATOR.inner) / 2,
      ),
      C.machinery,
      WHITE_UV,
    );
  }
  // exit guide vanes: short fins on the nozzle wall
  for (let k = 0; k < d.guideVanes; k++) {
    b.box(
      [VANE.thickness, VANE.top - VANE.bottom, VANE.outer - VANE.inner],
      statorMatrix(
        (k / d.guideVanes) * TAU,
        VANE.lean,
        (VANE.top + VANE.bottom) / 2,
        (VANE.outer + VANE.inner) / 2,
      ),
      C.pad,
      WHITE_UV,
    );
  }

  addTrunnion(b, 1);
  addTrunnion(b, -1);
  return b.build();
}

// ---- rotor ----

export function buildRotorGeometry(d: TurbineDetail): BufferGeometry {
  const b = new MeshBuilder();
  const stripe = Math.max(1, Math.round(d.hubSegments / 8));
  b.lathe(ROTOR, {
    segments: d.hubSegments,
    smooth: true,
    color: C.dark,
    uv: WHITE_UV,
    // a spiral stripe on the spinner makes the slow idle rotation readable
    paint: (ring, segment) => {
      if (ring === 2) return C.pad;
      if (ring < 3) return null;
      return (segment + (ring - 3) * stripe) % (d.hubSegments / 2) < stripe ? C.white : null;
    },
  });
  return b.build();
}

/**
 * The fan blades for a rotor turning toward increasing lathe angle (port turbines). Starboard
 * turbines mirror the mesh (scale.x = -1) and spin the other way. y is relative to the fan plane.
 */
export function buildBladeGeometry(d: TurbineDetail): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  // chord-wise stations: leading edge, maximum thickness, trailing edge
  const stations = [0.4, -0.05, -0.6];
  for (let blade = 0; blade < TURBINE.bladeCount; blade++) {
    const phi0 = (blade / TURBINE.bladeCount) * TAU;
    // upper (suction) and lower (pressure) surfaces are separate so the edges stay crisp
    for (const surface of [1, -1]) {
      const base = positions.length / 3;
      for (let k = 0; k <= d.bladeSpans; k++) {
        const s = bladeSection(k / d.bladeSpans);
        const cp = Math.cos(s.pitch);
        const sp = Math.sin(s.pitch);
        stations.forEach((along, station) => {
          const lift = station === 1 ? (surface * s.thickness) / 2 : 0;
          const tangential = along * s.chord * cp - lift * sp;
          const axial = along * s.chord * sp + lift * cp;
          const phi = phi0 + s.sweep + tangential / s.radius;
          positions.push(s.radius * Math.sin(phi), axial, s.radius * Math.cos(phi));
        });
      }
      for (let k = 0; k < d.bladeSpans; k++) {
        for (let c = 0; c < 2; c++) {
          const i0 = base + k * 3 + c;
          const i1 = i0 + 1;
          const i2 = i0 + 3;
          const i3 = i2 + 1;
          if (surface > 0) indices.push(i0, i1, i3, i0, i3, i2);
          else indices.push(i0, i3, i1, i0, i2, i3);
        }
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// ---- glow overlays ----

/** Glow weights travel in the colour attribute: r = combustion glow, g = hot core. */
function weight(glow: number, core = 0): Color {
  return new Color(glow, core, 0);
}

export function buildGlowGeometry(d: TurbineDetail): BufferGeometry {
  const b = new MeshBuilder();

  // flame ring: the inner and lower faces of the flame holder burn brightest
  b.lathe(
    [
      { r: FLAME_RING[1].r - 0.03, y: FLAME_RING[1].y - 0.03 },
      { r: FLAME_RING[2].r - 0.04, y: FLAME_RING[2].y - 0.04 },
      { r: FLAME_RING[3].r - 0.05, y: FLAME_RING[3].y - 0.04 },
    ],
    { segments: d.ductSegments, smooth: true, color: [weight(1), weight(1), weight(0.7)] },
  );

  // wash on the duct liner from just under the fan to the nozzle exit
  const linerYs = [-0.3, -1.6, -3.6, -5.0, NOZZLE_Y + 0.04];
  const linerWeights = [0, 0.3, 0.5, 0.4, 0.2];
  b.lathe(
    linerYs.map((y) => ({ r: profileRadiusAt(DUCT_INNER_PROFILE, y) - 0.06, y })),
    { segments: d.ductSegments, smooth: true, color: linerWeights.map((w) => weight(w)) },
  );

  // gas glow just under the stators: brightest at the flame ring, a hot spot at the hub
  const discY = STATOR.bottom - 0.15;
  const discRings: [radius: number, glow: number, core: number][] = [
    [18.7, 0.1, 0],
    [17.6, 0.8, 0],
    [16.2, 0.34, 0],
    [13, 0.1, 0],
    [7.5, 0.05, 0.25],
    [HUB_R, 0.12, 0.9],
  ];
  b.lathe(
    discRings.map(([r]) => ({ r, y: discY })),
    { segments: d.ductSegments, smooth: true, color: discRings.map(([, g, c]) => weight(g, c)) },
  );

  // tail cone: glows white-hot near full power
  const coneWeights = [weight(0.25, 1), weight(0.25, 1), weight(0.3, 0.8), weight(0.3, 0.5)];
  b.lathe(
    CENTRE_BODY.slice(0, 4).map((p) => ({ r: p.r + 0.06, y: p.y - 0.03 })),
    { segments: d.hubSegments, smooth: true, color: coneWeights },
  );

  // stator flanks and undersides: dark at the top edge, lit toward the bottom edge
  const statorOuter = profileRadiusAt(DUCT_INNER_PROFILE, STATOR.bottom) - 0.1;
  const half = (statorOuter - (HUB_R + 0.1)) / 2;
  const centre = (statorOuter + HUB_R + 0.1) / 2;
  const h = (STATOR.top - STATOR.bottom) / 2;
  const x = STATOR.thickness / 2 + 0.04;
  const lit = weight(0.34);
  const unlit = weight(0);
  for (let k = 0; k < d.stators; k++) {
    const m = statorMatrix(
      statorAngle(k, d.stators),
      STATOR.lean,
      (STATOR.top + STATOR.bottom) / 2,
      centre,
    );
    const at = (px: number, py: number, pz: number) => new Vector3(px, py, pz).applyMatrix4(m);
    const dir = (dx: number, dy: number) => new Vector3(dx, dy, 0).transformDirection(m);
    for (const side of [1, -1]) {
      b.quad(
        at(side * x, -h, -half * side),
        at(side * x, -h, half * side),
        at(side * x, h, half * side),
        at(side * x, h, -half * side),
        dir(side, 0),
        [lit, lit, unlit, unlit],
      );
    }
    b.quad(
      at(-x, -h - 0.04, half),
      at(-x, -h - 0.04, -half),
      at(x, -h - 0.04, -half),
      at(x, -h - 0.04, half),
      dir(0, -1),
      [lit, lit, lit, lit],
    );
  }

  const geometry = b.build();
  geometry.deleteAttribute('uv');
  geometry.translate(0, -GLOW_ORIGIN_Y, 0);
  return geometry;
}

// ---- motion-blur disc ----

/** Annulus in the fan plane (y = 0): u runs once around, v from the hub (0) to the tip (1). */
export function buildBlurDiscGeometry(d: TurbineDetail): BufferGeometry {
  const b = new MeshBuilder();
  b.lathe(
    [
      { r: TURBINE.fanRadius, y: 0 },
      { r: (TURBINE.fanRadius + HUB_R) / 2, y: 0 },
      { r: HUB_R, y: 0 },
    ],
    { segments: d.discSegments, smooth: true, color: C.skin, v: [1, 0.5, 0], uRepeat: 1 },
  );
  const geometry = b.build();
  geometry.deleteAttribute('color');
  return geometry;
}

// ---- number decal ----

/** Side of the square number decal and its vertical centre on the mid-section of the duct, m. */
const DECAL = { size: 3.9, centreY: 1.55, lift: 0.05 };

/**
 * The turbine number on the two outboard quarters of the duct (the trunnions occupy the
 * beam-on positions). The decal follows the facets of the skin exactly; u picks the cell of
 * the number atlas for this turbine.
 */
export function buildDecalGeometry(index: number, d: TurbineDetail): BufferGeometry {
  const b = new MeshBuilder();
  const R = TURBINE.ductOuterRadius;
  const halfAngle = DECAL.size / 2 / R;
  const y0 = DECAL.centreY - DECAL.size / 2;
  const y1 = DECAL.centreY + DECAL.size / 2;
  const cell = 1 / 4;
  // lathe angle: 0 = aft (+Z), 90° = starboard (+X), 180° = bow, 270° = port
  const outboard = spinDirection(index) > 0 ? 1.5 * Math.PI : 0.5 * Math.PI;
  const step = TAU / d.ductSegments;
  const white: [Color, Color, Color, Color] = [C.skin, C.skin, C.skin, C.skin];

  for (const quarter of [-1, 1]) {
    const centre = outboard + (quarter * Math.PI) / 4;
    const from = centre - halfAngle;
    const to = centre + halfAngle;
    for (let i = Math.floor(from / step); i * step < to; i++) {
      const a0 = i * step;
      const a1 = a0 + step;
      const lo = Math.max(a0, from);
      const hi = Math.min(a1, to);
      if (hi - lo < 1e-6) continue;
      const am = (a0 + a1) / 2;
      const normal = new Vector3(Math.sin(am), 0, Math.cos(am));
      // a point on the flat facet between the skin vertices at a0 and a1
      const onFacet = (a: number, y: number) => {
        const t = (a - a0) / step;
        return new Vector3(
          R * ((1 - t) * Math.sin(a0) + t * Math.sin(a1)),
          y,
          R * ((1 - t) * Math.cos(a0) + t * Math.cos(a1)),
        ).addScaledVector(normal, DECAL.lift);
      };
      const u = (a: number) => (index + (a - from) / (to - from)) * cell;
      b.quad(onFacet(lo, y0), onFacet(hi, y0), onFacet(hi, y1), onFacet(lo, y1), normal, white, [
        u(lo),
        0,
        u(hi),
        0,
        u(hi),
        1,
        u(lo),
        1,
      ]);
    }
  }
  const geometry = b.build();
  geometry.deleteAttribute('color');
  return geometry;
}
