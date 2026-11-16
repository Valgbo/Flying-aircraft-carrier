/**
 * CloudLayer — an endless layer of scattered cumulus one can fly under, through and above.
 * Carrier-free: every input comes in as a prop (src/engine re-exports it); the carrier's
 * `Clouds` passes its sim, store and quality, the A-10 its own world and wind.
 *
 * The layer is one deterministic tile of clouds (see `./cloudLayout`) that repeats in X and Z
 * around the camera and drifts with the wind. Every puff is a camera-facing sprite; the whole
 * layer is ONE instanced draw call (see `./cloudMaterial`).
 *
 * Per frame the component only updates uniforms. The sprites are alpha-blended without depth
 * write, so they are kept sorted back to front — but only re-sorted when the camera has moved
 * appreciably relative to the layer (an insertion sort over the previous order, which is then
 * almost sorted already).
 *
 * It also writes `env.cloudCover`: how deep the camera is inside cloud (the sky thickens the
 * fog with it).
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  PlaneGeometry,
  type Vector3,
} from 'three';
import { damp } from '../../utils/math';
import { CLEAR_FOG_DENSITY, fogDensityFor } from './atmosphere';
import {
  CLOUD_SEED,
  CLOUD_WIND_X,
  CLOUD_WIND_Z,
  DEFAULT_CLOUD_SHAPE,
  SPRITE_STRIDE,
  cloudCoverAt,
  createCloudLayout,
  edgeFadeEnd,
  edgeFadeStart,
  wrapCentered,
  type CloudLayout,
  type CloudShape,
} from './cloudLayout';
import { createCloudMaterial, type CloudMaterial } from './cloudMaterial';
import { createCloudNoiseTexture } from './cloudTexture';
import type { SkyClock, SkyEnv } from './skyEnv';
import type { SkyState } from './timeOfDay';

/** Re-sort the sprites once the camera has moved this far relative to the layer, m. */
const RESORT_DISTANCE = 120;
/** Response rate of `env.cloudCover` toward its instantaneous value, 1/s. */
const COVER_RESPONSE = 5;
/** Clouds draw before other transparent things (exhaust, glass…), which are nearer as a rule. */
const CLOUD_RENDER_ORDER = -10;

/** The cloud layer as scene objects plus the scratch data needed to keep it sorted. */
interface CloudField {
  layout: CloudLayout;
  mesh: Mesh<InstancedBufferGeometry, CloudMaterial>;
  /** Sprite records in draw order (what the GPU reads). */
  buffer: InstancedInterleavedBuffer;
  /** Draw order: indices into `layout.sprites`, far to near. */
  order: Uint16Array;
  /** Squared distance of each sprite from the camera, indexed like `layout.sprites`. */
  distance: Float32Array;
  /** Camera position relative to the drifting layer at the last sort. */
  sortedAt: { x: number; y: number; z: number; valid: boolean };
  dispose: () => void;
}

function createCloudField(cloudCount: number, shape: Readonly<CloudShape>): CloudField {
  const layout = createCloudLayout(cloudCount, CLOUD_SEED, shape);
  const quad = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(quad.getIndex());
  geometry.setAttribute('position', quad.getAttribute('position'));
  const buffer = new InstancedInterleavedBuffer(layout.sprites.slice(), SPRITE_STRIDE);
  geometry.setAttribute('aCenter', new InterleavedBufferAttribute(buffer, 3, 0));
  geometry.setAttribute('aShape', new InterleavedBufferAttribute(buffer, 4, 3));
  geometry.setAttribute('aLocal', new InterleavedBufferAttribute(buffer, 3, 7));
  geometry.setAttribute('aCloud', new InterleavedBufferAttribute(buffer, 3, 10));
  geometry.instanceCount = layout.spriteCount;

  const noise = createCloudNoiseTexture();
  const material = createCloudMaterial(noise);
  material.uniforms.uTile.value = layout.tileSize;
  material.uniforms.uEdgeFade.value.set(
    edgeFadeStart(layout.tileSize),
    edgeFadeEnd(layout.tileSize),
  );

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = CLOUD_RENDER_ORDER;
  mesh.matrixAutoUpdate = false;

  const order = new Uint16Array(layout.spriteCount);
  for (let i = 0; i < order.length; i++) order[i] = i;

  return {
    layout,
    mesh,
    buffer,
    order,
    distance: new Float32Array(layout.spriteCount),
    sortedAt: { x: 0, y: 0, z: 0, valid: false },
    dispose: () => {
      geometry.dispose();
      quad.dispose();
      material.dispose();
      noise.dispose();
    },
  };
}

/**
 * Put the sprites in back-to-front order for a camera at (x, y, z) relative to the drifting
 * layer and upload them. Allocation-free.
 */
function sortSprites(field: CloudField, x: number, y: number, z: number): void {
  const { layout, order, distance } = field;
  const { sprites, spriteCount, tileSize } = layout;
  for (let i = 0; i < spriteCount; i++) {
    const p = i * SPRITE_STRIDE;
    const dx = wrapCentered(sprites[p], x, tileSize);
    const dy = sprites[p + 1] - y;
    const dz = wrapCentered(sprites[p + 2], z, tileSize);
    distance[i] = dx * dx + dy * dy + dz * dz;
  }
  // insertion sort, descending distance: linear when the previous order is nearly right
  for (let i = 1; i < spriteCount; i++) {
    const index = order[i];
    const d = distance[index];
    let j = i - 1;
    while (j >= 0 && distance[order[j]] < d) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = index;
  }
  const target = field.buffer.array as Float32Array;
  for (let i = 0; i < spriteCount; i++) {
    const from = order[i] * SPRITE_STRIDE;
    const to = i * SPRITE_STRIDE;
    for (let k = 0; k < SPRITE_STRIDE; k++) target[to + k] = sprites[from + k];
  }
  field.buffer.needsUpdate = true;
  field.sortedAt.x = x;
  field.sortedAt.y = y;
  field.sortedAt.z = z;
  field.sortedAt.valid = true;
}

/** `value` wrapped into [0, period). */
function positiveModulo(value: number, period: number): number {
  const m = value % period;
  return m < 0 ? m + period : m;
}

export interface CloudLayerProps {
  /** `horizonColor` is read (the haze the clouds fade into); `cloudCover` is written. */
  env: Pick<SkyEnv, 'horizonColor' | 'cloudCover'>;
  /** Drift and the cover easing run on this clock (dt = 0: time stands still). */
  clock: SkyClock;
  /** The sky for this frame (e.g. `getSkyState(hours)`); read every frame, never kept. */
  getSky: () => SkyState;
  /** Number of clouds in the repeating tile (the tile grows with it). */
  cloudCount: number;
  /** Altitudes, spacing and sizes (default: the carrier's sea deck). Must be a stable reference. */
  shape?: Readonly<CloudShape>;
  /**
   * Wind that carries the layer, m/s, read every frame. Given: the drift is integrated over
   * `clock.dt`, so a changing wind never makes the layer jump. Absent: the carrier's constant
   * wind × `clock.time`.
   */
  wind?: { readonly x: number; readonly z: number };
  /** Clear-air fog density, read every frame (default: the carrier's 28 km visibility). */
  getClearFogDensity?: () => number;
  /** World position of the render frame's origin, if the scene is re-centred (floating origin). */
  origin?: Vector3;
  /**
   * Called every frame with the layout and how far the wind has carried it (world m), e.g. to
   * cast the clouds' shadows on the ground from the very same clouds.
   */
  onFrame?: (layout: CloudLayout, driftX: number, driftZ: number) => void;
}

export default function CloudLayer({
  env,
  clock,
  getSky,
  cloudCount,
  shape = DEFAULT_CLOUD_SHAPE,
  wind,
  getClearFogDensity,
  origin,
  onFrame,
}: CloudLayerProps) {
  const field = useMemo(() => createCloudField(cloudCount, shape), [cloudCount, shape]);
  useEffect(() => () => field.dispose(), [field]);
  const drift = useRef({ x: 0, z: 0 });

  useFrame(({ camera }) => {
    const { layout, sortedAt } = field;
    const tile = layout.tileSize;
    let driftX: number;
    let driftZ: number;
    if (wind) {
      drift.current.x += wind.x * clock.dt;
      drift.current.z += wind.z * clock.dt;
      driftX = drift.current.x;
      driftZ = drift.current.z;
    } else {
      driftX = CLOUD_WIND_X * clock.time;
      driftZ = CLOUD_WIND_Z * clock.time;
    }
    // camera position in the frame that drifts with the layer
    const x = camera.position.x + (origin ? origin.x : 0) - driftX;
    const y = camera.position.y;
    const z = camera.position.z + (origin ? origin.z : 0) - driftZ;

    const dx = x - sortedAt.x;
    const dy = y - sortedAt.y;
    const dz = z - sortedAt.z;
    if (!sortedAt.valid || dx * dx + dy * dy + dz * dz > RESORT_DISTANCE * RESORT_DISTANCE) {
      sortSprites(field, x, y, z);
    }

    // how deep the camera is inside cloud; eased in simulated time, immediate while time stands still
    const cover = cloudCoverAt(layout, x, y, z, 0, 0);
    env.cloudCover = clock.dt > 0 ? damp(env.cloudCover, cover, COVER_RESPONSE, clock.dt) : cover;

    const sky = getSky();
    const u = field.mesh.material.uniforms;
    u.uShift.value.set(positiveModulo(-x, tile), positiveModulo(-z, tile));
    u.uLightDirection.value.copy(sky.lightDirection);
    u.uLitColor.value.copy(sky.cloudLitColor);
    u.uShadeColor.value.copy(sky.cloudShadeColor);
    u.uLightColor.value.copy(sky.lightColor);
    u.uFogColor.value.copy(env.horizonColor);
    u.uFogDensity.value = fogDensityFor(
      env.cloudCover,
      getClearFogDensity ? getClearFogDensity() : CLEAR_FOG_DENSITY,
    );
    onFrame?.(layout, driftX, driftZ);
  });

  useEffect(
    () => () => {
      env.cloudCover = 0;
    },
    [env],
  );

  return <primitive object={field.mesh} />;
}
