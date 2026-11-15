/**
 * The ocean material and its per-frame update: everything the shader needs to know about the
 * camera, the sky, the ship and the four turbine blasts, read from `sim` once per frame.
 *
 * World coordinates and time never reach the GPU directly. The mesh sits at a snapped centre;
 * wave phases, texture offsets and animation phases are reduced on the CPU in double precision,
 * so the picture is as stable an hour into a flight 500 km from the origin as at the start.
 */
import {
  Color,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type Camera,
  type Fog,
  type FogExp2,
  type Mesh,
  type Scene,
  type Texture,
} from 'three';
import { sim } from '../../state/sim';
import { getDownwash, type Downwash } from '../../state/simHelpers';
import type { QualityLevel } from '../../state/types';
import { smoothstep } from '../../utils/math';
import { OCEAN, computeLayerOffsets, textureLayers, type TextureLayer } from './oceanConfig';
import { FINE_RING_OMEGA, RING_OMEGA, oceanFragmentShader, oceanVertexShader } from './oceanShader';
import { WAVE_COUNT, computeWavePhases } from './waveExpr';

const TAU = Math.PI * 2;
const TURBINES = 4;

export type OceanUniforms = {
  uDetail: { value: Texture };
  uWavePhase: { value: Float32Array };
  uLayerOffset: { value: Float32Array };
  uAnisotropy: { value: number };
  uCamLocal: { value: Vector3 };
  uSunDir: { value: Vector3 };
  uSunColor: { value: Color };
  uHorizonColor: { value: Color };
  uZenithColor: { value: Color };
  uFogColor: { value: Color };
  uFog: { value: Vector4 };
  uShip: { value: Vector4 };
  uShipState: { value: Vector3 };
  uShadow: { value: Vector4 };
  uDownwash: { value: Float32Array };
  uRingPhase: { value: Vector2 };
  uFlowPhase: { value: number };
};

export interface OceanSurface {
  material: ShaderMaterial;
  uniforms: OceanUniforms;
  /** Texture layers in uniform order (depends on the quality level). */
  layers: readonly TextureLayer[];
}

/**
 * Build the material for a quality level. `anisotropy` is what the detail texture is actually
 * filtered with (the shader's analytic fades assume the same). The caller disposes the material.
 */
export function createOceanSurface(
  level: QualityLevel,
  detail: Texture,
  anisotropy: number,
): OceanSurface {
  const layers = textureLayers(level);
  const uniforms: OceanUniforms = {
    uDetail: { value: detail },
    uWavePhase: { value: new Float32Array(WAVE_COUNT) },
    uLayerOffset: { value: new Float32Array(layers.length * 2) },
    uAnisotropy: { value: Math.max(1, anisotropy) },
    uCamLocal: { value: new Vector3(0, 100, 0) },
    uSunDir: { value: new Vector3(0, 1, 0) },
    uSunColor: { value: new Color(1, 1, 1) },
    uHorizonColor: { value: new Color(0.5, 0.6, 0.7) },
    uZenithColor: { value: new Color(0.1, 0.2, 0.5) },
    uFogColor: { value: new Color(0.5, 0.6, 0.7) },
    uFog: { value: new Vector4(OCEAN.defaultFogDensity, 0, 1, 0) },
    uShip: { value: new Vector4(0, 0, 0, -1) },
    uShipState: { value: new Vector3() },
    uShadow: { value: new Vector4(0, 0, 1, 0) },
    // a zero radius would divide by zero in the shader even at zero strength
    uDownwash: { value: new Float32Array(TURBINES * 4).fill(1) },
    uRingPhase: { value: new Vector2() },
    uFlowPhase: { value: 0 },
  };
  for (let i = 0; i < TURBINES; i++) uniforms.uDownwash.value[i * 4 + 3] = 0;
  const material = new ShaderMaterial({
    name: 'Ocean',
    uniforms,
    vertexShader: oceanVertexShader(),
    fragmentShader: oceanFragmentShader(level),
    fog: false,
  });
  return { material, uniforms, layers };
}

const _forward = new Vector3();
const _downwash: Downwash = { x: 0, z: 0, distance: 0, strength: 0 };

/**
 * Per-frame update (no allocations). Centres `mesh` under the camera — pulled toward the ship
 * while it is near, so the dense middle of the grid covers the hull — snapped to the `snap`
 * lattice, then refreshes every uniform from `sim`.
 */
export function updateOceanSurface(
  surface: OceanSurface,
  mesh: Mesh,
  camera: Camera,
  scene: Scene,
  snap: number,
): void {
  const u = surface.uniforms;
  const time = sim.time;
  const env = sim.env;
  const carrier = sim.carrier;
  const ship = carrier.position;
  const cam = camera.position;

  // ---- mesh centre ----------------------------------------------------------------------------
  const toShipX = ship.x - cam.x;
  const toShipZ = ship.z - cam.z;
  const pull =
    1 - smoothstep(0.6 * OCEAN.maxCentreBias, OCEAN.maxCentreBias, Math.hypot(toShipX, toShipZ));
  const centreX = Math.round((cam.x + toShipX * pull) / snap) * snap;
  const centreZ = Math.round((cam.z + toShipZ * pull) / snap) * snap;
  mesh.position.set(centreX, 0, centreZ);
  u.uCamLocal.value.set(cam.x - centreX, cam.y, cam.z - centreZ);

  // ---- waves, ripples, animation phases -------------------------------------------------------
  computeWavePhases(centreX, centreZ, time, u.uWavePhase.value);
  computeLayerOffsets(surface.layers, centreX, centreZ, time, u.uLayerOffset.value);
  u.uRingPhase.value.set((RING_OMEGA * time) % TAU, (FINE_RING_OMEGA * time) % TAU);
  u.uFlowPhase.value = (time / OCEAN.downwash.flowPeriod) % 1;

  // ---- sky ------------------------------------------------------------------------------------
  u.uSunDir.value.copy(env.sunDirection).normalize();
  u.uSunColor.value.copy(env.sunColor);
  u.uHorizonColor.value.copy(env.horizonColor);
  u.uZenithColor.value.copy(env.zenithColor);
  const fog = scene.fog;
  if (fog && (fog as FogExp2).isFogExp2) {
    u.uFog.value.set((fog as FogExp2).density, 0, 1, 0);
    u.uFogColor.value.copy(fog.color);
  } else if (fog && (fog as Fog).isFog) {
    const linear = fog as Fog;
    u.uFog.value.set(0, linear.near, Math.max(linear.far, linear.near + 1), 1);
    u.uFogColor.value.copy(fog.color);
  } else {
    u.uFog.value.set(OCEAN.defaultFogDensity, 0, 1, 0);
    u.uFogColor.value.copy(env.horizonColor);
  }

  // ---- ship -------------------------------------------------------------------------------------
  _forward.set(0, 0, -1).applyQuaternion(carrier.quaternion);
  const flat = Math.hypot(_forward.x, _forward.z);
  const forwardX = flat > 1e-4 ? _forward.x / flat : 0;
  const forwardZ = flat > 1e-4 ? _forward.z / flat : -1;
  u.uShip.value.set(ship.x - centreX, ship.z - centreZ, forwardX, forwardZ);

  const clearance = Math.max(carrier.keelClearance, 0);
  const inWater = 1 - smoothstep(0, OCEAN.hullFoamEndHeight, carrier.keelClearance);
  // the analytic wake only knows the present course and speed: it trails straight astern and is
  // drawn for headway only
  const wakeSpeed = Math.max(carrier.forwardSpeed, 0) * inWater;
  u.uShipState.value.set(
    inWater,
    wakeSpeed,
    Math.min(wakeSpeed * OCEAN.wakePersistence, OCEAN.wakeMaxLength),
  );

  // contact shadow: the hull's blob slides away from the sun as the ship climbs
  const sun = u.uSunDir.value;
  const height = Math.max(ship.y, 0);
  const slide = height / Math.max(sun.y, 0.3);
  u.uShadow.value.set(
    ship.x - centreX - sun.x * slide,
    ship.z - centreZ - sun.z * slide,
    6 + 0.35 * clearance,
    (1 - smoothstep(OCEAN.shadowFullHeight, OCEAN.shadowEndHeight, clearance)) *
      smoothstep(0.03, 0.2, sun.y),
  );

  // ---- turbine downwash -----------------------------------------------------------------------
  const blasts = u.uDownwash.value;
  for (let i = 0; i < TURBINES; i++) {
    getDownwash(i, _downwash);
    const active = _downwash.strength > 0 && Number.isFinite(_downwash.distance);
    const o = i * 4;
    blasts[o] = _downwash.x - centreX;
    blasts[o + 1] = _downwash.z - centreZ;
    blasts[o + 2] =
      OCEAN.downwash.radiusBase +
      OCEAN.downwash.radiusPerMetre * (active ? Math.min(_downwash.distance, 120) : 0);
    blasts[o + 3] = active ? _downwash.strength : 0;
  }
}
