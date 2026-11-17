/**
 * Cloud shadows on the ground, from the very clouds the sky draws: the cloud layer's tile
 * (CloudLayout, shared through src/engine) is rasterised once into a small periodic coverage
 * texture; the terrain and tree shaders project each ground point toward the sun onto the
 * layer's middle height and look the coverage up there, drifting with the layer. From 3,000 m
 * the moving patches of shade are one of the strongest cues of scale and height.
 */
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  RepeatWrapping,
  UnsignedByteType,
} from 'three';
import type { CloudLayout } from '../../../engine';
import { hash01 } from './noise';

/** Texels per edge of the coverage texture (the whole cloud tile). */
export const CLOUD_SHADOW_SIZE = 256;
const CLOUD_STRIDE = 5;

/** Middle height of the layer's clouds, m (the plane the shadow lookup projects onto). */
export function cloudShadowHeight(layout: CloudLayout): number {
  let sum = 0;
  for (let i = 0; i < layout.cloudCount; i++) {
    const o = i * CLOUD_STRIDE;
    sum += layout.clouds[o + 1] + layout.clouds[o + 4] * 0.4;
  }
  return layout.cloudCount > 0 ? sum / layout.cloudCount : 2000;
}

/** Rasterise the layer's coverage (0 clear … 255 under the thick of a cloud), periodic. */
export function rasterCloudShadow(layout: CloudLayout, size = CLOUD_SHADOW_SIZE): Uint8Array {
  const out = new Float32Array(size * size);
  const texel = layout.tileSize / size;
  for (let i = 0; i < layout.cloudCount; i++) {
    const o = i * CLOUD_STRIDE;
    const cx = layout.clouds[o] / texel;
    const cz = layout.clouds[o + 2] / texel;
    // the shadow of a cumulus is about its base: a little smaller than its widest puffs
    const r = (layout.clouds[o + 3] * 0.95) / texel;
    const r0 = Math.floor(-r - 2);
    const r1 = Math.ceil(r + 2);
    for (let dz = r0; dz <= r1; dz++) {
      for (let dx = r0; dx <= r1; dx++) {
        const px = Math.floor(cx) + dx;
        const pz = Math.floor(cz) + dz;
        const ex = (px + 0.5 - cx) / r;
        const ez = (pz + 0.5 - cz) / r;
        // lumpy outline
        const lump = 0.82 + 0.3 * hash01(Math.floor(px / 2), Math.floor(pz / 2), i * 7 + 3);
        const q = Math.sqrt(ex * ex + ez * ez) / lump;
        if (q >= 1) continue;
        const k = 1 - q * q;
        const v = Math.min(1, k * 1.6);
        const ix = ((px % size) + size) % size;
        const iz = ((pz % size) + size) % size;
        const idx = iz * size + ix;
        out[idx] = Math.max(out[idx], v);
      }
    }
  }
  const bytes = new Uint8Array(size * size);
  for (let k = 0; k < out.length; k++) bytes[k] = Math.round(out[k] * 255);
  return bytes;
}

/** The coverage as a repeating texture (the caller owns and disposes it). */
export function createCloudShadowTexture(layout: CloudLayout): DataTexture {
  const size = CLOUD_SHADOW_SIZE;
  const tex = new DataTexture(
    rasterCloudShadow(layout, size),
    size,
    size,
    RedFormat,
    UnsignedByteType,
  );
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
