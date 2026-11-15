/**
 * Clouds — an endless layer of scattered cumulus the ship can fly under, through and above.
 *
 * The layer is one deterministic tile of clouds (see `./sky/cloudLayout`) that repeats in X
 * and Z around the camera and drifts with a constant wind. Every puff is a camera-facing
 * sprite; the whole layer is ONE instanced draw call (see `./sky/cloudMaterial`).
 *
 * Per frame the component only updates uniforms. The sprites are alpha-blended without depth
 * write, so they are kept sorted back to front — but only re-sorted when the camera has moved
 * appreciably relative to the layer (an insertion sort over the previous order, which is then
 * almost sorted already).
 *
 * It also writes `sim.env.cloudCover`: how deep the camera is inside cloud (the world module
 * thickens the fog with it).
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  PlaneGeometry,
} from 'three';
import { sim } from '../state/sim';
import { useGameStore } from '../state/useGameStore';
import { useQuality } from '../state/useQuality';
import { damp } from '../utils/math';
import { fogDensityFor } from './sky/atmosphere';
import {
  CLOUD_WIND_X,
  CLOUD_WIND_Z,
  SPRITE_STRIDE,
  cloudCoverAt,
  createCloudLayout,
  edgeFadeEnd,
  edgeFadeStart,
  wrapCentered,
  type CloudLayout,
} from './sky/cloudLayout';
import { createCloudMaterial, type CloudMaterial } from './sky/cloudMaterial';
import { createCloudNoiseTexture } from './sky/cloudTexture';
import { getSkyState } from './sky/currentSky';

/** Re-sort the sprites once the camera has moved this far relative to the layer, m. */
const RESORT_DISTANCE = 120;
/** Response rate of `sim.env.cloudCover` toward its instantaneous value, 1/s. */
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

function createCloudField(cloudCount: number): CloudField {
  const layout = createCloudLayout(cloudCount);
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

export default function Clouds() {
  const cloudCount = useQuality().cloudCount;
  const field = useMemo(() => createCloudField(cloudCount), [cloudCount]);
  useEffect(() => () => field.dispose(), [field]);

  useFrame(({ camera }) => {
    const { layout, sortedAt } = field;
    const tile = layout.tileSize;
    const driftX = CLOUD_WIND_X * sim.time;
    const driftZ = CLOUD_WIND_Z * sim.time;
    // camera position in the frame that drifts with the layer
    const x = camera.position.x - driftX;
    const y = camera.position.y;
    const z = camera.position.z - driftZ;

    const dx = x - sortedAt.x;
    const dy = y - sortedAt.y;
    const dz = z - sortedAt.z;
    if (!sortedAt.valid || dx * dx + dy * dy + dz * dz > RESORT_DISTANCE * RESORT_DISTANCE) {
      sortSprites(field, x, y, z);
    }

    // how deep the camera is inside cloud; eased in simulated time, immediate while time stands still
    const cover = cloudCoverAt(layout, x, y, z, 0, 0);
    sim.env.cloudCover =
      sim.dt > 0 ? damp(sim.env.cloudCover, cover, COVER_RESPONSE, sim.dt) : cover;

    const sky = getSkyState(useGameStore.getState().settings.timeOfDay);
    const u = field.mesh.material.uniforms;
    u.uShift.value.set(positiveModulo(-x, tile), positiveModulo(-z, tile));
    u.uLightDirection.value.copy(sky.lightDirection);
    u.uLitColor.value.copy(sky.cloudLitColor);
    u.uShadeColor.value.copy(sky.cloudShadeColor);
    u.uLightColor.value.copy(sky.lightColor);
    u.uFogColor.value.copy(sim.env.horizonColor);
    u.uFogDensity.value = fogDensityFor(sim.env.cloudCover);
  });

  useEffect(
    () => () => {
      sim.env.cloudCover = 0;
    },
    [],
  );

  return <primitive object={field.mesh} />;
}
