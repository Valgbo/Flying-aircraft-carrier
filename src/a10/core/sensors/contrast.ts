/**
 * The contrast model shared by the seekers and the sensor pictures (ARCHITECTURE §12.5, PLAN §8).
 *
 * What the targeting pod and the Mavericks can track is decided from the SAME inputs the sensor
 * pictures are drawn from, so what looks hot (or dark) on a display is what a seeker can lock:
 *
 *   sun        the sky's daily arc and daylight (src/scene/sky/timeOfDay.ts), solar heating and
 *              the lagging ambient level of the terrain's thermal picture (terrainSystem.ts)
 *   ground     thermal level = class level + (solar · uptake · max(n·sun, 0) − 0.15) · 0.35
 *                              + (ambient − 0.4) · 0.3                      (terrainMaterial.ts)
 *   vehicles   thermal level = 0.3 + heat / 75 K per zone (engine deck, exhaust, running gear,
 *              hull; a fire adds 320/320/160/260 K)                 (view/vehicles/thermal.ts)
 *   haze       f = 1 − exp(−(ρ·d)²), ρ from the meteorological visibility, thinning with the
 *              observer's height above the haze floor (view/environment/haze.ts)
 *
 * IR (D and G Mavericks, the pod's WHOT/BHOT): the target's signature is the root-mean-square
 * temperature difference of its visible zones against the ground around it (a tracker keys on
 * the contrast pattern, so an idling tank whose mean matches a sunlit field still shows its hot
 * deck and exhaust). Haze pulls both toward the cold sky level, which leaves (1 − 0.7·f) of the
 * difference, as the thermal picture draws it. Contrast = 1 − exp(−ΔT / 10 K).
 *
 * TV (H and K Mavericks, the pod's CCD): the Weber contrast of the paint (or a charred wreck, a
 * white scoring panel, a fire) against the ground's albedo, diluted by airlight with Koschmieder's
 * law C' = C·(1 − f) / ((1 − f) + K·f) (K = horizon/ground luminance ≈ 4), times a light factor
 * that falls to nothing toward dusk. Contrast = 1 − exp(−C' / 0.25).
 *
 * Smoke from burning vehicles between the observer and the target blocks a TV contrast and passes
 * 30 % of an IR one (`smokeBetween`). Every function here is pure and allocation-free; the sensor
 * view can call them per frame (or mirror them in a shader) with the same inputs.
 */
import { Vector3 } from 'three';
import { CONTRAST, GROUND_LUMINANCE, GROUND_THERMAL, SMOKE } from '../../data/sensors';
import { findVehicle } from '../targets';
import type { Vehicle } from '../targets/types';
import type { Sim } from '../types';
import type { FieldSample, SurfaceKind, Terrain } from '../world/types';
import { vehicleCentre } from './geometry';
import type { SensorBand } from './types';

// ---- sun ------------------------------------------------------------------------------------------

/** The sun and the thermal scene at a time of day. */
export interface SunState {
  /** Unit vector toward the sun, world. */
  dir: Vector3;
  /** sin(sun elevation) (= dir.y). */
  sinElevation: number;
  /** 0 below ≈ −9° sun elevation, 1 above ≈ +9° (the sky's daylight). */
  daylight: number;
  /** Solar heating of the ground, 0..1 (the terrain's uThermalParams.x). */
  solar: number;
  /** Ambient thermal level of the scene (the terrain's uThermalParams.y). */
  ambient: number;
  /** Light for a television sensor, 0 (night) .. 1 (sun well up). */
  tvLight: number;
}

export function createSunState(): SunState {
  return {
    dir: new Vector3(0, 1, 0),
    sinElevation: 1,
    daylight: 1,
    solar: 1,
    ambient: 0.5,
    tvLight: 1,
  };
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * The sun at local time `hours` (0..24): the sky's daily arc through due east and west reaching
 * CONTRAST.sunCulmination over the southern horizon at noon (+Z is south), the daylight factor,
 * and the terrain picture's solar heating and ambient level.
 */
export function sunStateAt(hours: number, out: SunState): SunState {
  const h = ((hours % 24) + 24) % 24;
  const hourAngle = ((h - 12) / 24) * Math.PI * 2;
  const ch = Math.cos(hourAngle);
  const c = CONTRAST.sunCulmination;
  out.dir.set(-Math.sin(hourAngle), ch * Math.sin(c), ch * Math.cos(c));
  out.sinElevation = out.dir.y;
  out.daylight = smoothstep(CONTRAST.daylightLow, CONTRAST.daylightHigh, out.sinElevation);
  const solarPhase = ((h - CONTRAST.solarStartHour) / CONTRAST.solarSpanHours) * Math.PI;
  out.solar = Math.max(0, Math.sin(solarPhase)) * out.daylight;
  const lagPhase = ((h - CONTRAST.ambientStartHour) / CONTRAST.ambientSpanHours) * Math.PI;
  out.ambient = CONTRAST.ambientBase + CONTRAST.ambientSwing * Math.max(0, Math.sin(lagPhase));
  out.tvLight = smoothstep(CONTRAST.tvLightLow, CONTRAST.tvLightHigh, out.sinElevation);
  return out;
}

// ---- haze -----------------------------------------------------------------------------------------

const VISIBILITY_DEPTH = Math.sqrt(-Math.log(CONTRAST.visibilityContrast));

/**
 * Haze density of the FogExp2 law (1/m) for a visibility (km) seen from `heightAboveFloor` metres
 * above the haze floor (terrain.minHeight): the haze sits in the boundary layer and thins above.
 */
export function hazeDensity(visibilityKm: number, heightAboveFloor: number): number {
  const v = Math.max(CONTRAST.minVisibilityKm, visibilityKm) * 1000;
  return VISIBILITY_DEPTH / v / (1 + Math.max(0, heightAboveFloor) / CONTRAST.hazeAltitudeScale);
}

/** Haze factor (0 clear … 1 all haze) at `distance` for a density: 1 − exp(−(ρ·d)²). */
export function hazeFactor(density: number, distance: number): number {
  const x = density * distance;
  return 1 - Math.exp(-x * x);
}

// ---- infrared ---------------------------------------------------------------------------------------

/**
 * Thermal level (picture units, 0..1) of the ground: its class's level, warmed by the sun on the
 * slope (`sunExposure` = max(n·sun, 0) in sunlight) and by the time of day — the terrain shader's
 * formula, so the background the seeker compares a vehicle with is the one the picture shows.
 */
export function groundThermalLevel(
  surface: SurfaceKind,
  sunExposure: number,
  sun: SunState,
): number {
  const g = GROUND_THERMAL[surface];
  return (
    g.level +
    (sun.solar * g.uptake * sunExposure - CONTRAST.groundSunOffset) * CONTRAST.groundSunGain +
    (sun.ambient - CONTRAST.groundAmbientRef) * CONTRAST.groundAmbientGain
  );
}

/** Kelvin above ambient that a thermal level stands for (vehicles: 0.3 + K/75). */
export function levelToKelvin(level: number): number {
  return (level - CONTRAST.ambientLevel) * CONTRAST.kelvinPerLevel;
}

/** Thermal level of a surface `kelvin` above ambient. */
export function kelvinToLevel(kelvin: number): number {
  return CONTRAST.ambientLevel + kelvin / CONTRAST.kelvinPerLevel;
}

/** Heat of each of a vehicle's zones as the picture draws it, K above ambient (fire included). */
export interface ZoneHeat {
  engine: number;
  exhaust: number;
  running: number;
  hull: number;
}

export function createZoneHeat(): ZoneHeat {
  return { engine: 0, exhaust: 0, running: 0, hull: 0 };
}

/** The four heat zones of a vehicle including its fire (VehicleRenderer's iHeat). */
export function vehicleZoneHeat(v: Vehicle, out: ZoneHeat): ZoneHeat {
  const f = v.fire;
  out.engine = v.heat.engine + f * CONTRAST.fireEngine;
  out.exhaust = v.heat.exhaust + f * CONTRAST.fireExhaust;
  out.running = v.heat.running + f * CONTRAST.fireRunning;
  out.hull = v.heat.hull + f * CONTRAST.fireHull;
  return out;
}

/**
 * Thermal signature of a vehicle against a ground `groundK` kelvin above ambient: the
 * root-mean-square difference over the visible zones (area shares CONTRAST.zone*), K.
 */
export function thermalSignatureK(z: ZoneHeat, groundK: number): number {
  const h = z.hull - groundK;
  const e = z.engine - groundK;
  const r = z.running - groundK;
  const x = z.exhaust - groundK;
  return Math.sqrt(
    CONTRAST.zoneHull * h * h +
      CONTRAST.zoneEngine * e * e +
      CONTRAST.zoneRunning * r * r +
      CONTRAST.zoneExhaust * x * x,
  );
}

/** Apparent IR signature after `haze` (0..1): both ends pulled toward the cold sky level. */
export function irApparentK(signatureK: number, haze: number): number {
  return signatureK * (1 - CONTRAST.irHazeShare * haze);
}

/** 0..1 contrast of an apparent IR signature, K. */
export function irContrast(apparentK: number): number {
  return 1 - Math.exp(-Math.abs(apparentK) / CONTRAST.irScaleK);
}

// ---- television ------------------------------------------------------------------------------------

/** Linear luminance (albedo) of a vehicle as seen in daylight. */
export function vehicleLuminance(v: Vehicle): number {
  if (v.kind === 'panel') return CONTRAST.panelLuminance;
  if (v.condition === 'destroyed' || v.condition === 'catastrophic')
    return CONTRAST.charredLuminance;
  return CONTRAST.paintLuminance;
}

/**
 * Apparent Weber contrast of a vehicle against the ground in a TV picture: intrinsic contrast of
 * the albedos (a fire adds its glow and smoke), Koschmieder's airlight dilution at haze `haze`,
 * and the daylight the CCD needs.
 */
export function tvApparentContrast(
  targetLuminance: number,
  groundLuminance: number,
  fire: number,
  haze: number,
  sun: SunState,
): number {
  const c0 =
    Math.abs(targetLuminance - groundLuminance) / Math.max(1e-4, groundLuminance) +
    fire * CONTRAST.fireTvContrast;
  const t = 1 - haze;
  // t + K·f = 1 + (K − 1)·f ≥ 1 for a haze factor in 0..1: the guard only catches bad input
  return ((c0 * t) / Math.max(1e-9, t + CONTRAST.skyGroundRatio * haze)) * sun.tvLight;
}

/** 0..1 contrast of an apparent TV (Weber) contrast. */
export function tvContrast(apparent: number): number {
  return 1 - Math.exp(-Math.abs(apparent) / CONTRAST.tvScale);
}

// ---- smoke ------------------------------------------------------------------------------------------

/**
 * Does the smoke of a burning vehicle (other than `ignoreId`) lie across the segment a→b? Each
 * fire stronger than SMOKE.minFire feeds a column rising from the vehicle and drifting with the
 * surface wind (drift per metre of rise = wind / rise speed), radius growing with height.
 */
export function smokeBetween(sim: Sim, a: Vector3, b: Vector3, ignoreId: number): boolean {
  const list = sim.targets.vehicles;
  const w = sim.world.surfaceWind;
  const k = 1 / SMOKE.riseSpeed;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v.fire < SMOKE.minFire || v.id === ignoreId) continue;
    // column axis: base + s·(w·k, 1, w·k) for heights s ∈ [0, SMOKE.height]
    const bx = v.position.x;
    const by = v.position.y;
    const bz = v.position.z;
    const ux = w.x * k;
    const uz = w.z * k;
    if (segmentNearColumn(a, b, bx, by, bz, ux, uz, v.fire)) return true;
  }
  return false;
}

/** Closest approach of segment a→b to a smoke column (sampled along the segment's height span). */
function segmentNearColumn(
  a: Vector3,
  b: Vector3,
  bx: number,
  by: number,
  bz: number,
  ux: number,
  uz: number,
  fire: number,
): boolean {
  // Parametrise the segment p(t) = a + t·(b − a); the column's centre at height y is
  // (bx + ux·(y − by), y, bz + uz·(y − by)). Test the horizontal distance at each height the
  // segment crosses inside the column's height range: it is a quadratic in t, so its minimum
  // over t ∈ [t0, t1] is found in closed form.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const top = by + SMOKE.height;
  let t0 = 0;
  let t1 = 1;
  if (Math.abs(dy) < 1e-9) {
    if (a.y < by || a.y > top) return false;
  } else {
    const ta = (by - a.y) / dy;
    const tb = (top - a.y) / dy;
    t0 = Math.max(0, Math.min(ta, tb));
    t1 = Math.min(1, Math.max(ta, tb));
    if (t0 > t1) return false;
  }
  // horizontal offset from the column centre: e(t) = (a.x + dx·t − bx − ux·(a.y + dy·t − by), …)
  const ex0 = a.x - bx - ux * (a.y - by);
  const ez0 = a.z - bz - uz * (a.y - by);
  const ex1 = dx - ux * dy;
  const ez1 = dz - uz * dy;
  const qa = ex1 * ex1 + ez1 * ez1;
  let t = qa > 1e-12 ? -(ex0 * ex1 + ez0 * ez1) / qa : t0;
  t = t < t0 ? t0 : t > t1 ? t1 : t;
  const ex = ex0 + ex1 * t;
  const ez = ez0 + ez1 * t;
  const height = Math.max(0, a.y + dy * t - by);
  const r = (SMOKE.radius + SMOKE.growth * height) * Math.min(1, 0.5 + fire);
  return ex * ex + ez * ez < r * r;
}

// ---- the whole model -------------------------------------------------------------------------------

/** Detail of a contrast evaluation (the seekers use the signature for capture decisions). */
export interface ContrastDetail {
  band: SensorBand;
  /** Final 0..1 contrast. */
  contrast: number;
  /** IR: apparent signature, K. TV: apparent Weber contrast. */
  apparent: number;
  /** Haze factor along the path. */
  haze: number;
  /** Smoke lies across the path. */
  smoke: boolean;
  /** Slant range, m. */
  range: number;
}

export function createContrastDetail(): ContrastDetail {
  return { band: 'IR', contrast: 0, apparent: 0, haze: 0, smoke: false, range: 0 };
}

const _sun = createSunState();
const _zones = createZoneHeat();
const _n = new Vector3();
const _c = new Vector3();
const _field: FieldSample = {
  id: 0,
  variant: 0,
  crop: 'pasture',
  rowHeading: 0,
  edgeDistance: 0,
  hedge: false,
  track: false,
};
let _sunHours = NaN;

/** The sun for the sim's time of day (cached: the time of day changes slowly). */
export function simSun(sim: Sim): SunState {
  const h = sim.world.timeOfDay;
  if (h !== _sunHours) {
    sunStateAt(h, _sun);
    _sunHours = h;
  }
  return _sun;
}

/** Thermal level of the ground at (x, z) in the scene's sun (the class of a ploughed field too). */
export function groundLevelAt(terrain: Terrain, x: number, z: number, sun: SunState): number {
  let surface = terrain.surfaceAt(x, z);
  terrain.normalAt(x, z, _n);
  const exposure = Math.max(0, _n.dot(sun.dir));
  let level = groundThermalLevel(surface, exposure, sun);
  if (surface === 'field' && terrain.fieldAt && terrain.fieldAt(x, z, _field)) {
    if (_field.crop === 'ploughed') {
      surface = 'dirt';
      level = groundThermalLevel(surface, exposure, sun);
    }
  }
  return level;
}

/**
 * Contrast of vehicle `v` against its background in `band`, seen from `from` (world), with the
 * details in `out`. Haze from the world's visibility and the observer's height; smoke across the
 * path from other burning vehicles.
 */
export function vehicleContrast(
  sim: Sim,
  v: Vehicle,
  band: SensorBand,
  from: Vector3,
  out: ContrastDetail,
): number {
  const terrain = sim.world.terrain;
  const sun = simSun(sim);
  vehicleCentre(v, _c);
  const range = from.distanceTo(_c);
  const density = hazeDensity(sim.world.visibilityKm, from.y - terrain.minHeight);
  const haze = hazeFactor(density, range);
  const smoke = smokeBetween(sim, from, _c, v.id);
  out.band = band;
  out.range = range;
  out.haze = haze;
  out.smoke = smoke;
  if (band === 'IR') {
    const groundK = levelToKelvin(groundLevelAt(terrain, v.position.x, v.position.z, sun));
    let k = irApparentK(thermalSignatureK(vehicleZoneHeat(v, _zones), groundK), haze);
    if (smoke) k *= SMOKE.irTransmission;
    out.apparent = k;
    out.contrast = irContrast(k);
  } else {
    const ground = GROUND_LUMINANCE[terrain.surfaceAt(v.position.x, v.position.z)];
    const c = smoke ? 0 : tvApparentContrast(vehicleLuminance(v), ground, v.fire, haze, sun);
    out.apparent = c;
    out.contrast = tvContrast(c);
  }
  return out.contrast;
}

const _detail = createContrastDetail();

/**
 * Contrast of a vehicle against its background for a sensor band, 0..1, seen from `from`
 * (ARCHITECTURE §12.5). The seekers lock on it; the sensor pictures are drawn from the same inputs.
 */
export function targetContrast(
  sim: Sim,
  vehicleId: number,
  band: SensorBand,
  from: Vector3,
): number {
  const v = findVehicle(sim, vehicleId);
  if (!v) return 0;
  return vehicleContrast(sim, v, band, from, _detail);
}
