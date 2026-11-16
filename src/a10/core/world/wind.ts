/**
 * Wind: the mean boundary-layer profile over the terrain and a deterministic turbulence field.
 *
 * Mean wind (windAt): WorldState.surfaceWind is the standard 10 m wind over open ground
 * (z0 = 0.03 m). Above the blending height (the top of the surface layer, 100 m) the flow no
 * longer feels the local ground cover, so there
 *    u(z) = u_ref(z_b) · (z / z_b)^α          (power law, α = 1/7, up to the boundary-layer top)
 * with u_ref(z) = U10 · ln(z / z0_ref) / ln(10 / z0_ref). Below z_b the local log law, matched at
 * z_b, gives the effect of the ground cover:
 *    u(z) = u_ref(z_b) · ln((z − d) / z0) / ln((z_b − d) / z0)
 * z0 = 0.0002 m over water, 1 m over forest (displacement d = 0.7·canopy height), 0.03 m elsewhere.
 * The direction veers clockwise with ln(height) by WorldState.windVeer at the boundary-layer top.
 *
 * Turbulence (gustAt): frozen turbulence carried by the mean wind (Taylor's hypothesis). Three
 * octaves of 3D gradient noise per component, scaled to the Dryden intensities and length scales
 * of MIL-F-8785C (σw = 0.1·W20 and Lw = h at low level; σu/σw = 1/(0.177 + 0.000823 h)^0.4;
 * isotropic, L = 1,750 ft above 2,000 ft), plus WorldState.turbulence × a "moderate" intensity
 * that is strongest near the ground. No random draws: the same place and time give the same gust.
 */
import { Vector3 } from 'three';
import { noise3 } from './noise';
import { TURBULENCE, WIND } from './params';
import type { WorldState } from './types';

const LN_REF = Math.log(WIND.referenceHeight / WIND.roughnessOpen);
const ZB = WIND.surfaceLayerTop;
/** Reference-profile factor at the blending height. */
const REF_AT_ZB = Math.log(ZB / WIND.roughnessOpen) / LN_REF;

/**
 * Speed factor (× the 10 m wind) at `agl` metres above ground with local roughness z0 and
 * displacement d. Exported for tests.
 */
export function windProfileFactor(agl: number, z0: number, d: number, blTop: number): number {
  if (agl >= ZB) {
    const z = agl < blTop ? agl : blTop;
    return REF_AT_ZB * Math.pow(z / ZB, WIND.powerExponent);
  }
  const ze = agl - d;
  if (ze <= z0) return 0;
  return (REF_AT_ZB * Math.log(ze / z0)) / Math.log((ZB - d) / z0);
}

/** Clockwise turning of the wind at height agl (rad), 0 at 10 m, `veer` at the boundary-layer top. */
function veerAt(agl: number, veer: number, blTop: number): number {
  if (agl <= WIND.referenceHeight) return 0;
  const f = Math.log(agl / WIND.referenceHeight) / Math.log(blTop / WIND.referenceHeight);
  return veer * (f < 1 ? f : 1);
}

/**
 * Mean wind at a world position (world m/s, the direction the air moves toward), without
 * turbulence. Writes and returns `out`.
 */
export function windAt(world: WorldState, position: Vector3, out: Vector3): Vector3 {
  const w = world.surfaceWind;
  const terrain = world.terrain;
  const ground = terrain.heightAt(position.x, position.z);
  const agl = position.y - ground;
  const blTop = world.boundaryLayerHeight ?? WIND.boundaryLayerHeight;
  let z0: number = WIND.roughnessOpen;
  let d = 0;
  if (agl < ZB) {
    if (terrain.waterLevelAt && terrain.waterLevelAt(position.x, position.z) > -Infinity) {
      z0 = WIND.roughnessWater;
    } else {
      const c = terrain.canopyAt(position.x, position.z);
      if (c > 0) {
        z0 = WIND.roughnessForest;
        d = WIND.displacementFraction * c;
      }
    }
  }
  const k = windProfileFactor(agl > 0 ? agl : 0, z0, d, blTop);
  const phi = veerAt(agl, world.windVeer ?? WIND.veer, blTop);
  // Rotate clockwise seen from above: in (east, north) = (x, −z) coordinates.
  const east = w.x;
  const north = -w.z;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  return out.set((east * c + north * s) * k, w.y * k, -(-east * s + north * c) * k);
}

/** Dryden-style intensity (σ, m/s) and length scales (m) at a height, for gustAt and tests. */
export interface GustScales {
  sigmaU: number;
  sigmaW: number;
  lengthU: number;
  lengthW: number;
}

const FT = 0.3048;

/** Turbulence intensities and length scales at `agl` metres for a 10 m wind `u10` (m/s). */
export function gustScales(world: WorldState, agl: number, u10: number, out: GustScales): GustScales {
  const h = Math.max(agl, 3);
  const hFt = h / FT;
  const blTop = world.boundaryLayerHeight ?? WIND.boundaryLayerHeight;
  // Wind-driven part (MIL-F-8785C low-altitude model), W20 from the 10 m wind.
  const w20 = u10 * windProfileFactor(20 * FT, WIND.roughnessOpen, 0, blTop);
  const lowRatio = 1 / Math.pow(0.177 + 0.000823 * Math.min(hFt, 1000), 0.4);
  let sigmaW = TURBULENCE.sigmaPerW20 * w20;
  let sigmaU = sigmaW * lowRatio;
  let lw = Math.max(TURBULENCE.minScale, h);
  let lu = Math.max(TURBULENCE.minScale, h / Math.pow(0.177 + 0.000823 * Math.min(hFt, 1000), 1.2));
  // Blend to the isotropic medium-altitude model between 1,000 and 2,000 ft.
  const t = clamp01((h - TURBULENCE.lowAltitudeTop) / (TURBULENCE.highAltitudeBottom - TURBULENCE.lowAltitudeTop));
  if (t > 0) {
    const L = TURBULENCE.highAltitudeScale;
    lw += (L - lw) * t;
    lu += (L - lu) * t;
    // Aloft the wind-driven intensity decays with the boundary layer.
    const aloft = 1 - 0.7 * clamp01((h - TURBULENCE.lowAltitudeTop) / Math.max(1, blTop));
    sigmaU = (sigmaU + (sigmaW - sigmaU) * t) * aloft;
    sigmaW *= aloft;
  }
  // The turbulence setting: "moderate" near the ground, fading to a lower value above the
  // boundary layer.
  const lowness = 1 - clamp01(h / blTop);
  const extra =
    world.turbulence *
    (TURBULENCE.moderateSigmaAloft + (TURBULENCE.moderateSigma - TURBULENCE.moderateSigmaAloft) * lowness);
  out.sigmaU = Math.sqrt(sigmaU * sigmaU + extra * extra);
  out.sigmaW = Math.sqrt(sigmaW * sigmaW + extra * extra * 0.8);
  out.lengthU = lu;
  out.lengthW = lw;
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** RMS of the 3-octave noise sum below (measured), so σ scales are exact on average. */
const OCTAVE_RMS = 0.3;
const SEED_U = 0x6a09e667 | 0;
const SEED_V = 0xbb67ae85 | 0;
const SEED_W = 0x3c6ef372 | 0;

/** Three octaves (×1, ×2.3, ×5.1 frequency; −5/3-like fall-off) of 3D noise, ≈ unit RMS. */
function turb(x: number, y: number, z: number, seed: number): number {
  const a = noise3(x, y, z, seed);
  const b = noise3(x * 2.3 + 5.2, y * 2.3 - 1.3, z * 2.3 + 9.1, seed ^ 0x1b873593);
  const c = noise3(x * 5.1 - 3.7, y * 5.1 + 7.9, z * 5.1 - 2.2, seed ^ 0x2545f491);
  return (a + 0.56 * b + 0.32 * c) / (OCTAVE_RMS * Math.sqrt(1 + 0.56 * 0.56 + 0.32 * 0.32));
}

const _wind = new Vector3();
const _scales: GustScales = { sigmaU: 0, sigmaW: 0, lengthU: 1, lengthW: 1 };

/**
 * Turbulent gust velocity at a world position and sim time (world m/s), to ADD to windAt.
 * Smooth in space and time, zero-mean, deterministic; strongest near the ground.
 */
export function gustAt(world: WorldState, position: Vector3, time: number, out: Vector3): Vector3 {
  const ground = world.terrain.heightAt(position.x, position.z);
  const agl = Math.max(1, position.y - ground);
  windAt(world, position, _wind);
  const u10 = Math.hypot(world.surfaceWind.x, world.surfaceWind.z);
  gustScales(world, agl, u10, _scales);
  if (_scales.sigmaU <= 0 && _scales.sigmaW <= 0) return out.set(0, 0, 0);
  // Frozen field advected with the mean wind; slow evolution through the vertical coordinate.
  const px = position.x - _wind.x * time;
  const pz = position.z - _wind.z * time;
  const py = position.y;
  const lu = _scales.lengthU;
  const lw = _scales.lengthW;
  const evolve = time * 0.05;
  const gu = _scales.sigmaU * turb(px / lu, py / lu + evolve, pz / lu, SEED_U);
  const gv = _scales.sigmaU * turb(px / lu + 31.7, py / lu - evolve, pz / lu - 17.3, SEED_V);
  const gw = _scales.sigmaW * turb(px / lw - 11.1, py / lw + evolve, pz / lw + 23.5, SEED_W);
  // Along-wind (u), cross-wind (v) and vertical (w) axes; world x/z when the air is still.
  let ax = _wind.x;
  let az = _wind.z;
  const l = Math.hypot(ax, az);
  if (l > 1e-6) {
    ax /= l;
    az /= l;
  } else {
    ax = 1;
    az = 0;
  }
  return out.set(gu * ax - gv * az, gw, gu * az + gv * ax);
}
