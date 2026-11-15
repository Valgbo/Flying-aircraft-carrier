/**
 * World — everything above the water that is not a cloud: the sky dome, the sun / moon
 * directional light with its ship-following shadow frustum, hemisphere + ambient fill, and
 * the scene fog. All of it is driven by `settings.timeOfDay` through the time-of-day model in
 * `./sky/timeOfDay`.
 *
 * Every frame it writes `sim.env.sunDirection` (direction of the dominant light), `daylight`,
 * `sunColor`, `horizonColor` and `zenithColor`. `sim.env.horizonColor` is the colour of the
 * haze right now — the clear-air horizon colour, blending toward the grey-white of the cloud
 * interior while the camera is inside a cloud — and the scene fog shows exactly that colour,
 * so anything that fades into it (ocean, clouds, the dome's horizon) stays seamless.
 *
 * One subtlety: when the renderer itself tone-maps (post-processing off), three.js applies fog
 * after tone mapping, in display space. The scene fog is then given the tone-mapped horizon
 * colour, so fogged built-in materials still end up the same colour on screen as the sky.
 * Custom shaders should fade to `sim.env.horizonColor` before their own tone mapping instead
 * of reading `scene.fog.color`.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { ACESFilmicToneMapping, Color, Vector3 } from 'three';
import type { AmbientLight, DirectionalLight, FogExp2, HemisphereLight, Mesh } from 'three';
import { CARRIER_BOUNDING_RADIUS } from '../config/layout';
import { sim } from '../state/sim';
import { useGameStore } from '../state/useGameStore';
import { useQuality } from '../state/useQuality';
import { CLEAR_FOG_DENSITY, fogDensityFor, skyWhiteout } from './sky/atmosphere';
import { getSkyState } from './sky/currentSky';
import { createSkyDomeMaterial } from './sky/skyDomeMaterial';
import { acesFilmicToneMap } from './sky/toneMap';

/** Radius of the dome mesh, m. Depth is ignored, so it only has to lie inside the frustum. */
const DOME_RADIUS = 1000;
/** The dome is drawn before every other object. */
const DOME_RENDER_ORDER = -1000;

/** Half-size of the square shadow frustum: the whole ship with a margin, m. */
const SHADOW_HALF_SIZE = CARRIER_BOUNDING_RADIUS * 1.15;
/** Distance from the ship to the shadow-casting light, m. */
const LIGHT_DISTANCE = 700;
/** The shadow frustum spans the ship plus this much along the light, m. */
const SHADOW_DEPTH_MARGIN = 25;
/** Depth bias, in units of the shadow frustum's depth range (≈ 6 cm). */
const SHADOW_BIAS = -0.00012;
/** Offset along the surface normal, in shadow texels — what actually removes acne on the deck. */
const SHADOW_NORMAL_BIAS_TEXELS = 1.6;

/** How far the fog colour goes from cloud shade to sunlit cloud when the camera is inside a cloud. */
const CLOUD_INTERIOR_LIT_SHARE = 0.55;

const WORLD_UP = new Vector3(0, 1, 0);
const _right = new Vector3();
const _up = new Vector3();
const _cloudInterior = new Color();

export default function World() {
  const quality = useQuality();
  const dome = useRef<Mesh>(null);
  const sun = useRef<DirectionalLight>(null);
  const hemisphere = useRef<HemisphereLight>(null);
  const ambient = useRef<AmbientLight>(null);
  const fog = useRef<FogExp2>(null);

  const domeMaterial = useMemo(() => createSkyDomeMaterial(), []);
  useEffect(() => () => domeMaterial.dispose(), [domeMaterial]);

  // Shadow frustum: a fixed-size box around the ship; only its position changes per frame.
  useEffect(() => {
    const light = sun.current;
    if (!light) return;
    const shadow = light.shadow;
    const texel = (2 * SHADOW_HALF_SIZE) / quality.shadowMapSize;
    shadow.camera.left = -SHADOW_HALF_SIZE;
    shadow.camera.right = SHADOW_HALF_SIZE;
    shadow.camera.top = SHADOW_HALF_SIZE;
    shadow.camera.bottom = -SHADOW_HALF_SIZE;
    shadow.camera.near = LIGHT_DISTANCE - SHADOW_HALF_SIZE - SHADOW_DEPTH_MARGIN;
    shadow.camera.far = LIGHT_DISTANCE + SHADOW_HALF_SIZE + SHADOW_DEPTH_MARGIN;
    shadow.camera.updateProjectionMatrix();
    shadow.bias = SHADOW_BIAS;
    shadow.normalBias = texel * SHADOW_NORMAL_BIAS_TEXELS;
    if (shadow.mapSize.x !== quality.shadowMapSize) {
      shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
      // the renderer allocates a map of the new size on the next frame
      shadow.map?.dispose();
      shadow.map = null;
    }
  }, [quality.shadowMapSize]);

  useFrame(({ camera, gl }) => {
    const sky = getSkyState(useGameStore.getState().settings.timeOfDay);
    const env = sim.env;
    const whiteout = skyWhiteout(env.cloudCover);

    // ---- shared environment state ----
    env.sunDirection.copy(sky.lightDirection);
    env.daylight = sky.daylight;
    env.sunColor.copy(sky.lightColor);
    env.zenithColor.copy(sky.zenithColor);
    _cloudInterior.copy(sky.cloudShadeColor).lerp(sky.cloudLitColor, CLOUD_INTERIOR_LIT_SHARE);
    env.horizonColor.copy(sky.horizonColor).lerp(_cloudInterior, whiteout);

    if (fog.current) {
      fog.current.color.copy(env.horizonColor);
      if (gl.toneMapping === ACESFilmicToneMapping) {
        acesFilmicToneMap(fog.current.color, gl.toneMappingExposure);
      }
      fog.current.density = fogDensityFor(env.cloudCover);
    }

    // ---- sky dome ----
    if (dome.current) dome.current.position.copy(camera.position);
    const u = domeMaterial.uniforms;
    u.uSunDirection.value.copy(sky.sunDirection);
    u.uMoonDirection.value.copy(sky.moonDirection);
    u.uZenithColor.value.copy(sky.zenithColor);
    u.uHorizonColor.value.copy(sky.horizonColor);
    u.uHazeColor.value.copy(env.horizonColor);
    u.uGlowColor.value.copy(sky.horizonGlowColor);
    u.uSunDiscColor.value.copy(sky.sunDiscColor);
    u.uSunHaloColor.value.copy(sky.sunHaloColor);
    u.uMoonDiscColor.value.copy(sky.moonDiscColor);
    u.uStarVisibility.value = sky.starVisibility;
    u.uWhiteout.value = whiteout;
    u.uTime.value = sim.time;

    // ---- fill light ----
    if (hemisphere.current) {
      hemisphere.current.color.copy(sky.hemisphereSkyColor);
      hemisphere.current.groundColor.copy(sky.hemisphereGroundColor);
    }
    if (ambient.current) ambient.current.color.copy(sky.ambientColor);

    // ---- dominant light, aimed at the ship ----
    const light = sun.current;
    if (light) {
      light.color.copy(sky.lightColor);
      // Snap the aim point to whole shadow texels in the light's own frame (the same frame
      // three.js builds for the shadow camera), so shadow edges do not crawl as the ship moves.
      const direction = sky.lightDirection;
      const texel = (2 * SHADOW_HALF_SIZE) / light.shadow.mapSize.x;
      const position = sim.carrier.position;
      _right.crossVectors(WORLD_UP, direction).normalize();
      _up.crossVectors(direction, _right);
      const x = Math.round(position.dot(_right) / texel) * texel;
      const y = Math.round(position.dot(_up) / texel) * texel;
      light.target.position
        .copy(direction)
        .multiplyScalar(position.dot(direction))
        .addScaledVector(_right, x)
        .addScaledVector(_up, y);
      light.target.updateMatrixWorld();
      light.position.copy(light.target.position).addScaledVector(direction, LIGHT_DISTANCE);
    }
  });

  return (
    <>
      <fogExp2 ref={fog} attach="fog" args={['#ffffff', CLEAR_FOG_DENSITY]} />
      <mesh
        ref={dome}
        material={domeMaterial}
        renderOrder={DOME_RENDER_ORDER}
        frustumCulled={false}
      >
        <sphereGeometry args={[DOME_RADIUS, 48, 32]} />
      </mesh>
      <hemisphereLight ref={hemisphere} intensity={1} />
      <ambientLight ref={ambient} intensity={1} />
      <directionalLight ref={sun} intensity={1} castShadow={quality.shadows} />
    </>
  );
}
