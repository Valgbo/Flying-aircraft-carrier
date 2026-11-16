/**
 * Environment: sky, sun and fill light, haze, clouds, post-processing and the automatic
 * graphics downgrade of the A-10 view. OWNED BY THE ENVIRONMENT + TERRAIN-VIEW MODULE.
 *
 * Built from the carrier's sky (shared through src/engine): `SkyWorld` draws the dome, the
 * sun/moon light, hemisphere + ambient fill and the scene fog; `CloudLayer` the cumulus. This
 * file feeds them the A-10's world:
 *
 *   - time of day: sim.world.timeOfDay (settings.timeOfDay before a flight);
 *   - haze: sim.world.visibilityKm, thinning with the camera's height above the valley floor
 *     (`./haze`); one law for everything — scene.fog for built-in materials, the same density
 *     and colour in every custom shader (a10Env.hazeDensity / a10Env.horizonColor);
 *   - a land sky (`./sky`): whiter horizon in haze, green-brown ground bounce;
 *   - clouds: scattered cumulus with bases 1,500–2,300 m, well above the 900 m ridges,
 *     drifting with the wind at cloud height;
 *   - shadows: the sun's shadow frustum follows the aircraft (its own and its ground shadow
 *     on low passes) when the preset has shadows and the renderer has shadow maps on;
 *   - post-processing on presets that ask for it (`./PostPass`, pipeline order 900).
 *
 * Every frame it updates `a10Env` (env.ts) — the interface other modules read.
 */
import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import {
  CloudLayer,
  SkyWorld,
  createSkyState,
  fogDensityFor,
  type CloudLayout,
  type CloudShape,
  type SkyLights,
  type SkyState,
} from '../../../engine';
import { windAt } from '../../core/world';
import { getSim, getTerrain } from '../../state/runtime';
import { useA10Store } from '../../state/store';
import { frameInfo } from '../frame';
import { useA10Quality } from '../quality';
import AdaptiveQuality from './AdaptiveQuality';
import { a10Env } from './env';
import {
  a10Lights,
  cloudShadowSource,
  envClock,
  envFrame,
  environmentOverrides,
  postState,
} from './envState';
import { DEFAULT_VISIBILITY_KM, hazeDensityFor } from './haze';
import PostPass from './PostPass';
import { computeA10Sky } from './sky';

/** Scattered fair-weather cumulus over a land range: bases well above the 900 m ridges. */
export const LAND_CLOUD_SHAPE: Readonly<CloudShape> = {
  baseMin: 1500,
  baseMax: 2300,
  topMax: 3700,
  spacing: 4000,
  radiusMin: 400,
  radiusMax: 950,
};

/** Cloud height used to sample the wind that carries the layer, m above the ground. */
const CLOUD_WIND_HEIGHT = 1800;
/** Clouds always drift a little, even in a calm at the surface, m/s (toward the east). */
const MIN_CLOUD_DRIFT = 3;
/** Shadow frustum around the aircraft: its size, and depth enough to reach the ground below. */
const AIRCRAFT_SHADOW_RADIUS = 14;
const AIRCRAFT_SHADOW_DEPTH = 600;

const sky: SkyState = createSkyState();
let skyHours = Number.NaN;
let skyVisibility = Number.NaN;
const shadowFocus = new Vector3();
const cloudWind = { x: MIN_CLOUD_DRIFT, z: 0 };
const _probe = new Vector3();
const _wind = new Vector3();

const getA10Sky = () => sky;
const getClearDensity = () => envFrame.clearDensity;
/** Built-in materials fog after the renderer's ACES unless the post pass renders linear HDR. */
const isFogDisplayReferred = () => !postState.active;

function onLights(_sky: SkyState, lights: SkyLights): void {
  a10Lights.hemiSky.copy(lights.hemisphere.color).multiplyScalar(lights.hemisphere.intensity);
  a10Lights.hemiGround
    .copy(lights.hemisphere.groundColor)
    .multiplyScalar(lights.hemisphere.intensity);
  a10Lights.ambient.copy(lights.ambient.color).multiplyScalar(lights.ambient.intensity);
  a10Env.ambientColor.copy(a10Lights.hemiSky).add(a10Lights.ambient);
  // exactly the density SkyWorld gave the scene fog this frame
  a10Env.hazeDensity = fogDensityFor(a10Env.cloudCover, envFrame.clearDensity);
}

function onClouds(layout: CloudLayout, driftX: number, driftZ: number): void {
  cloudShadowSource.layout = layout;
  cloudShadowSource.driftX = driftX;
  cloudShadowSource.driftZ = driftZ;
}

/** Resolves time, visibility, haze, wind and the clock before the sky and clouds read them. */
function EnvironmentDriver() {
  useFrame(({ camera }, delta) => {
    const sim = getSim();
    const settings = useA10Store.getState().settings;
    const hours = environmentOverrides.timeOfDay ?? (sim ? sim.world.timeOfDay : settings.timeOfDay);
    const visibility =
      environmentOverrides.visibilityKm ?? (sim ? sim.world.visibilityKm : DEFAULT_VISIBILITY_KM);
    if (hours !== skyHours || visibility !== skyVisibility) {
      computeA10Sky(hours, visibility, sky);
      skyHours = hours;
      skyVisibility = visibility;
    }
    envFrame.hours = hours;
    envFrame.visibilityKm = visibility;

    // the clock: sim time (frozen while paused); real time before a flight, so clouds drift
    if (sim) {
      envClock.time = sim.time;
      envClock.dt = frameInfo.simDt;
    } else {
      envClock.dt = Math.min(delta, 0.1);
      envClock.time += envClock.dt;
    }

    const terrain = getTerrain();
    envFrame.hazeFloor = terrain ? terrain.minHeight : 0;
    envFrame.clearDensity = hazeDensityFor(visibility, camera.position.y - envFrame.hazeFloor);

    // wind at cloud height carries the layer
    if (sim && terrain) {
      const x = camera.position.x;
      const z = camera.position.z;
      _probe.set(x, terrain.heightAt(x, z) + CLOUD_WIND_HEIGHT, z);
      windAt(sim.world, _probe, _wind);
      const speed = Math.hypot(_wind.x, _wind.z);
      if (speed >= MIN_CLOUD_DRIFT) {
        cloudWind.x = _wind.x;
        cloudWind.z = _wind.z;
      } else if (speed > 1e-3) {
        cloudWind.x = (_wind.x / speed) * MIN_CLOUD_DRIFT;
        cloudWind.z = (_wind.z / speed) * MIN_CLOUD_DRIFT;
      } else {
        cloudWind.x = MIN_CLOUD_DRIFT;
        cloudWind.z = 0;
      }
    }
    envFrame.cloudWindX = cloudWind.x;
    envFrame.cloudWindZ = cloudWind.z;

    shadowFocus.copy(sim ? sim.aircraft.position : camera.position);
  });
  return null;
}

export default function Environment() {
  const quality = useA10Quality();
  return (
    <>
      {/* first: everything below reads what it resolves */}
      <EnvironmentDriver />
      <SkyWorld
        env={a10Env}
        clock={envClock}
        getSky={getA10Sky}
        shadowFocus={shadowFocus}
        shadowRadius={AIRCRAFT_SHADOW_RADIUS}
        shadowDepthMargin={AIRCRAFT_SHADOW_DEPTH}
        castShadow={quality.shadows}
        shadowMapSize={quality.shadowMapSize}
        getClearFogDensity={getClearDensity}
        isFogDisplayReferred={isFogDisplayReferred}
        onLights={onLights}
      />
      <CloudLayer
        env={a10Env}
        clock={envClock}
        getSky={getA10Sky}
        cloudCount={quality.clouds}
        shape={LAND_CLOUD_SHAPE}
        wind={cloudWind}
        getClearFogDensity={getClearDensity}
        onFrame={onClouds}
      />
      {quality.postprocessing && <PostPass />}
      <AdaptiveQuality />
    </>
  );
}
