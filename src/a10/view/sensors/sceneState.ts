/**
 * The world scene as a sensor sees it: what the sensor render changes around its own draw of the
 * world scene, and puts back exactly afterwards (ARCHITECTURE §6: "the sensors module sets
 * [uThermal] around its own render and restores it"). GPU-free, allocation-free per frame.
 *
 * Both bands
 *   terrain `uPixelAngle`  one EFFECTIVE pixel of the sensor (thin roads stay ≈1.5 px wide in
 *                          the picture, not in the outside view's pixels);
 *   terrain `uDepthBias`   the ribbons' depth bias for the sensor camera's near plane;
 *   terrain `uDetailDistance`  the close-range ground detail follows the sensor's magnification;
 *   shadow map             not re-rendered for the sensor camera (the sun's shadows only cover
 *                          the aircraft's surroundings; the world pass updates them).
 * Television (CCD)
 *   thermal hooks off (visible colours); the haze density of the SENSOR's height (terrain
 *   `uHazeDensity` and the scene fog: the seekers' law, not the outside camera's); the fog colour
 *   in LINEAR units, because the picture is drawn into a linear render target (the environment
 *   hands built-in materials a display-referred fog colour when it draws to the screen).
 * Infrared (the picture's polarity is applied later, so both WHOT and BHOT draw white-hot)
 *   terrain `uThermal` = 1, `uThermalParams.z` = 1 (its level as is), `uHazeDensity` = 0 (the
 *   haze is applied afterwards from the depth buffer, to every surface alike: radiometry.ts);
 *   vehicles `setThermalMode(1)`, `setThermalLevelGain(0.3, 1/75 per K)` (the contrast model's);
 *   HIDDEN: the sky dome and the cloud layer (render order ≤ −10, ARCHITECTURE §6: the sky is
 *   the infrared sky model instead) and every object whose material has no thermal output — a
 *   ShaderMaterial without a `uThermal` uniform (contact shadows, decals, blast rings) or a
 *   built-in material that was not extended (store bodies in flight): drawn in visible colours
 *   they would read as temperatures.
 */
import { Color, Material, type Object3D, type Scene } from 'three';
import { a10Env } from '../environment/env';
import { terrainUniforms } from '../terrain/terrainMaterial';
import {
  getThermalMode,
  setThermalLevelGain,
  setThermalMode,
  thermalUniforms,
  type ThermalMode,
} from '../vehicles/thermal';
import { TERRAIN_THERMAL_GAIN, VEHICLE_THERMAL_GAIN, VEHICLE_THERMAL_LEVEL } from './radiometry';

export type SceneBand = 'IR' | 'TV';

/** What a sensor render needs from the shared hooks. */
export interface SensorSceneSettings {
  band: SceneBand;
  /** Angle of one effective sensor pixel, rad. */
  pixelAngle: number;
  /** The sensor camera's near plane, m. */
  near: number;
  /** Distance over which the terrain's close-range detail fades out, m. */
  detailDistance: number;
  /** Television: haze density at the sensor's height (FogExp2 law), 1/m. */
  hazeDensity: number;
}

/** The renderer's shadow-map switch (a WebGLRenderer, or a stand-in in tests). */
export interface ShadowMapHost {
  shadowMap: { autoUpdate: boolean };
}

export interface SavedSceneState {
  active: boolean;
  band: SceneBand;
  terrainThermal: number;
  terrainGain: number;
  hazeDensity: number;
  pixelAngle: number;
  depthBiasX: number;
  depthBiasY: number;
  detailDistance: number;
  vehicleMode: ThermalMode;
  vehicleLevel: number;
  vehicleGain: number;
  fogColor: Color;
  fogDensity: number;
  hasFog: boolean;
  shadowAutoUpdate: boolean;
  /** Objects hidden for this render (restored to visible on exit). */
  hidden: (Object3D | null)[];
  hiddenCount: number;
}

export function createSavedSceneState(): SavedSceneState {
  return {
    active: false,
    band: 'TV',
    terrainThermal: 0,
    terrainGain: 1,
    hazeDensity: 0,
    pixelAngle: 0,
    depthBiasX: 0,
    depthBiasY: 0,
    detailDistance: 0,
    vehicleMode: 0,
    vehicleLevel: 0,
    vehicleGain: 0,
    fogColor: new Color(),
    fogDensity: 0,
    hasFog: false,
    shadowAutoUpdate: true,
    hidden: [],
    hiddenCount: 0,
  };
}

/** Render order at or below which an object is the sky dome or the cloud layer. */
export const SKY_RENDER_ORDER = -10;

const thermalAware = new WeakMap<Material, boolean>();

/**
 * Whether a material draws a thermal picture: a shader material with a `uThermal` uniform (the
 * terrain, the trees, the particles), or a built-in material its owner extended in
 * `onBeforeCompile` (the vehicles add their thermal uniforms there).
 */
export function isThermalAware(material: Material): boolean {
  let aware = thermalAware.get(material);
  if (aware === undefined) {
    const uniforms = (material as Material & { uniforms?: Record<string, unknown> }).uniforms;
    aware =
      uniforms !== undefined
        ? 'uThermal' in uniforms
        : material.onBeforeCompile !== Material.prototype.onBeforeCompile;
    thermalAware.set(material, aware);
  }
  return aware;
}

/** Whether an object is left out of the infrared picture (see the file comment). */
export function hiddenInInfrared(obj: Object3D): boolean {
  const m = (obj as Object3D & { material?: Material | Material[] }).material;
  if (m === undefined || m === null) return false;
  if (obj.renderOrder <= SKY_RENDER_ORDER) return true;
  if (Array.isArray(m)) {
    for (let i = 0; i < m.length; i++) if (!isThermalAware(m[i])) return true;
    return false;
  }
  return !isThermalAware(m);
}

let collecting: SavedSceneState | null = null;

function collect(obj: Object3D): void {
  const s = collecting;
  if (s === null || !hiddenInInfrared(obj)) return;
  if (s.hiddenCount < s.hidden.length) s.hidden[s.hiddenCount] = obj;
  else s.hidden.push(obj);
  s.hiddenCount++;
}

/** Set the world scene up for one sensor render (call `exitSensorScene` right after). */
export function enterSensorScene(
  scene: Scene,
  gl: ShadowMapHost,
  settings: SensorSceneSettings,
  saved: SavedSceneState,
): void {
  if (saved.active) exitSensorScene(scene, gl, saved);
  const u = terrainUniforms;
  saved.active = true;
  saved.band = settings.band;
  saved.terrainThermal = u.uThermal.value;
  saved.terrainGain = u.uThermalParams.value.z;
  saved.hazeDensity = u.uHazeDensity.value;
  saved.pixelAngle = u.uPixelAngle.value;
  saved.depthBiasX = u.uDepthBias.value.x;
  saved.depthBiasY = u.uDepthBias.value.y;
  saved.detailDistance = u.uDetailDistance.value;
  saved.vehicleMode = getThermalMode();
  saved.vehicleLevel = thermalUniforms.uThermalLevel.value;
  saved.vehicleGain = thermalUniforms.uThermalGain.value;
  const fog = scene.fog as (Scene['fog'] & { density?: number }) | null;
  saved.hasFog = fog !== null;
  if (fog) {
    saved.fogColor.copy(fog.color);
    saved.fogDensity = fog.density ?? 0;
  }
  saved.shadowAutoUpdate = gl.shadowMap.autoUpdate;

  gl.shadowMap.autoUpdate = false;
  u.uPixelAngle.value = settings.pixelAngle;
  // a few depth-buffer steps at the ribbon's distance for this near plane (as the terrain does)
  u.uDepthBias.value.set(0.2, 4 / (Math.max(1e-3, settings.near) * 16777216));
  u.uDetailDistance.value = settings.detailDistance;

  if (settings.band === 'IR') {
    u.uThermal.value = 1;
    u.uThermalParams.value.z = TERRAIN_THERMAL_GAIN;
    u.uHazeDensity.value = 0;
    setThermalMode(1);
    setThermalLevelGain(VEHICLE_THERMAL_LEVEL, VEHICLE_THERMAL_GAIN);
    saved.hiddenCount = 0;
    collecting = saved;
    scene.traverseVisible(collect);
    collecting = null;
    for (let i = 0; i < saved.hiddenCount; i++) saved.hidden[i]!.visible = false;
  } else {
    u.uThermal.value = 0;
    u.uHazeDensity.value = settings.hazeDensity;
    setThermalMode(0);
    if (fog) {
      fog.color.copy(a10Env.horizonColor);
      if (fog.density !== undefined) fog.density = settings.hazeDensity;
    }
    saved.hiddenCount = 0;
  }
}

/** Put back everything `enterSensorScene` changed. */
export function exitSensorScene(scene: Scene, gl: ShadowMapHost, saved: SavedSceneState): void {
  if (!saved.active) return;
  saved.active = false;
  for (let i = 0; i < saved.hiddenCount; i++) {
    const obj = saved.hidden[i];
    if (obj) obj.visible = true;
    saved.hidden[i] = null;
  }
  saved.hiddenCount = 0;
  const u = terrainUniforms;
  u.uThermal.value = saved.terrainThermal;
  u.uThermalParams.value.z = saved.terrainGain;
  u.uHazeDensity.value = saved.hazeDensity;
  u.uPixelAngle.value = saved.pixelAngle;
  u.uDepthBias.value.set(saved.depthBiasX, saved.depthBiasY);
  u.uDetailDistance.value = saved.detailDistance;
  setThermalMode(saved.vehicleMode);
  setThermalLevelGain(saved.vehicleLevel, saved.vehicleGain);
  const fog = scene.fog as (Scene['fog'] & { density?: number }) | null;
  if (saved.hasFog && fog) {
    fog.color.copy(saved.fogColor);
    if (fog.density !== undefined) fog.density = saved.fogDensity;
  }
  gl.shadowMap.autoUpdate = saved.shadowAutoUpdate;
}
