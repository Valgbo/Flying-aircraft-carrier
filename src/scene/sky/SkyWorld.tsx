/**
 * SkyWorld — everything in the sky that is not a cloud: the sky dome, the sun / moon
 * directional light with a shadow frustum that follows one point, hemisphere + ambient fill,
 * and the scene fog. Carrier-free: every input comes in as a prop (src/engine re-exports it);
 * the carrier's `World` passes its sim, store and ship, the A-10 its own world.
 *
 * Every frame it writes `env.sunDirection` (direction of the dominant light), `daylight`,
 * `sunColor`, `horizonColor` and `zenithColor`. `env.horizonColor` is the colour of the haze
 * right now — the clear-air horizon colour, blending toward the grey-white of the cloud
 * interior while the camera is inside a cloud — and the scene fog shows exactly that colour, so
 * anything that fades into it (sea, terrain, clouds, the dome's horizon) stays seamless.
 *
 * One subtlety: when the renderer itself tone-maps (no post-processing), three.js applies fog
 * after tone mapping, in display space. The scene fog is then given the tone-mapped horizon
 * colour, so fogged built-in materials still end up the same colour on screen as the sky.
 * Custom shaders should fade to `env.horizonColor` before their own tone mapping instead of
 * reading `scene.fog.color`.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { ACESFilmicToneMapping, Color, Vector3 } from 'three';
import type { AmbientLight, DirectionalLight, FogExp2, HemisphereLight, Mesh } from 'three';
import { CLEAR_FOG_DENSITY, fogDensityFor, skyWhiteout } from './atmosphere';
import type { SkyClock, SkyEnv } from './skyEnv';
import { createSkyDomeMaterial } from './skyDomeMaterial';
import type { SkyState } from './timeOfDay';
import { acesFilmicToneMap } from './toneMap';

/** Radius of the dome mesh, m. Depth is ignored, so it only has to lie inside the frustum. */
const DOME_RADIUS = 1000;
/** The dome is drawn before every other object. */
const DOME_RENDER_ORDER = -1000;

/** Distance from the shadow focus to the shadow-casting light, m (at least). */
const LIGHT_DISTANCE = 700;
/** Default extra depth of the shadow frustum along the light, m. */
const SHADOW_DEPTH_MARGIN = 25;
/** Depth bias, in units of the shadow frustum's depth range (≈ 6 cm for the carrier). */
const SHADOW_BIAS = -0.00012;
/** Offset along the surface normal, in shadow texels — what actually removes shadow acne. */
const SHADOW_NORMAL_BIAS_TEXELS = 1.6;
/** Square shadow frustum: the focus radius with a margin. */
const SHADOW_SIZE_FACTOR = 1.15;

/** How far the fog colour goes from cloud shade to sunlit cloud when the camera is inside a cloud. */
const CLOUD_INTERIOR_LIT_SHARE = 0.55;

const WORLD_UP = new Vector3(0, 1, 0);
const _right = new Vector3();
const _up = new Vector3();
const _cloudInterior = new Color();

/** The lights SkyWorld drives, handed to `onLights` every frame. */
export interface SkyLights {
  sun: DirectionalLight;
  hemisphere: HemisphereLight;
  ambient: AmbientLight;
}

export interface SkyWorldProps {
  /** Written every frame (cloudCover is read: the cloud layer writes it). */
  env: SkyEnv;
  /** Star twinkle runs on `clock.time`. */
  clock: Pick<SkyClock, 'time'>;
  /** The sky for this frame (e.g. `getSkyState(hours)`); read every frame, never kept. */
  getSky: () => SkyState;
  /** The shadow frustum is centred here (world / render frame); read every frame. */
  shadowFocus: Vector3;
  /** Radius around `shadowFocus` that must lie inside the shadow frustum, m. */
  shadowRadius: number;
  castShadow: boolean;
  shadowMapSize: number;
  /** Extra depth of the shadow frustum along the light on both sides, m (default 25). */
  shadowDepthMargin?: number;
  /** Clear-air fog density, read every frame (default: the carrier's 28 km visibility). */
  getClearFogDensity?: () => number;
  /**
   * Whether built-in materials apply their fog after the renderer's tone mapping this frame
   * (default: when the renderer tone-maps with ACES — i.e. no post-processing chain).
   */
  isFogDisplayReferred?: () => boolean;
  /** Called every frame after the lights were set from the sky (to retint or read them). */
  onLights?: (sky: SkyState, lights: SkyLights) => void;
}

export default function SkyWorld({
  env,
  clock,
  getSky,
  shadowFocus,
  shadowRadius,
  castShadow,
  shadowMapSize,
  shadowDepthMargin = SHADOW_DEPTH_MARGIN,
  getClearFogDensity,
  isFogDisplayReferred,
  onLights,
}: SkyWorldProps) {
  const dome = useRef<Mesh>(null);
  const sun = useRef<DirectionalLight>(null);
  const hemisphere = useRef<HemisphereLight>(null);
  const ambient = useRef<AmbientLight>(null);
  const fog = useRef<FogExp2>(null);
  const gl = useThree((state) => state.gl);

  const domeMaterial = useMemo(() => createSkyDomeMaterial(), []);
  useEffect(() => () => domeMaterial.dispose(), [domeMaterial]);

  const halfSize = shadowRadius * SHADOW_SIZE_FACTOR;
  const lightDistance = Math.max(LIGHT_DISTANCE, halfSize + shadowDepthMargin + 50);

  // Shadow frustum: a fixed-size box around the focus; only its position changes per frame.
  useEffect(() => {
    const light = sun.current;
    if (!light) return;
    const shadow = light.shadow;
    const texel = (2 * halfSize) / shadowMapSize;
    shadow.camera.left = -halfSize;
    shadow.camera.right = halfSize;
    shadow.camera.top = halfSize;
    shadow.camera.bottom = -halfSize;
    shadow.camera.near = lightDistance - halfSize - shadowDepthMargin;
    shadow.camera.far = lightDistance + halfSize + shadowDepthMargin;
    shadow.camera.updateProjectionMatrix();
    shadow.bias = SHADOW_BIAS;
    shadow.normalBias = texel * SHADOW_NORMAL_BIAS_TEXELS;
    if (shadow.mapSize.x !== shadowMapSize) {
      shadow.mapSize.set(shadowMapSize, shadowMapSize);
      // the renderer allocates a map of the new size on the next frame
      shadow.map?.dispose();
      shadow.map = null;
    }
  }, [shadowMapSize, halfSize, lightDistance, shadowDepthMargin]);

  useFrame(({ camera }) => {
    const sky = getSky();
    const clearDensity = getClearFogDensity ? getClearFogDensity() : CLEAR_FOG_DENSITY;
    const whiteout = skyWhiteout(env.cloudCover, clearDensity);

    // ---- shared environment state ----
    env.sunDirection.copy(sky.lightDirection);
    env.daylight = sky.daylight;
    env.sunColor.copy(sky.lightColor);
    env.zenithColor.copy(sky.zenithColor);
    _cloudInterior.copy(sky.cloudShadeColor).lerp(sky.cloudLitColor, CLOUD_INTERIOR_LIT_SHARE);
    env.horizonColor.copy(sky.horizonColor).lerp(_cloudInterior, whiteout);

    if (fog.current) {
      fog.current.color.copy(env.horizonColor);
      const displayReferred = isFogDisplayReferred
        ? isFogDisplayReferred()
        : gl.toneMapping === ACESFilmicToneMapping;
      if (displayReferred) {
        acesFilmicToneMap(fog.current.color, gl.toneMappingExposure);
      }
      fog.current.density = fogDensityFor(env.cloudCover, clearDensity);
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
    u.uTime.value = clock.time;

    // ---- fill light ----
    if (hemisphere.current) {
      hemisphere.current.color.copy(sky.hemisphereSkyColor);
      hemisphere.current.groundColor.copy(sky.hemisphereGroundColor);
    }
    if (ambient.current) ambient.current.color.copy(sky.ambientColor);

    // ---- dominant light, aimed at the shadow focus ----
    const light = sun.current;
    if (light) {
      light.color.copy(sky.lightColor);
      // Snap the aim point to whole shadow texels in the light's own frame (the same frame
      // three.js builds for the shadow camera), so shadow edges do not crawl as the focus moves.
      const direction = sky.lightDirection;
      const texel = (2 * halfSize) / light.shadow.mapSize.x;
      const position = shadowFocus;
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
      light.position.copy(light.target.position).addScaledVector(direction, lightDistance);
    }

    if (onLights && light && hemisphere.current && ambient.current) {
      onLights(sky, { sun: light, hemisphere: hemisphere.current, ambient: ambient.current });
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
      <directionalLight ref={sun} intensity={1} castShadow={castShadow} />
    </>
  );
}
