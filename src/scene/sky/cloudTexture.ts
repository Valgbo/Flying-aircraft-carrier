/**
 * Procedural noise texture for the cloud sprites, generated in code (no image assets).
 *
 * It is a seamlessly tiling texture, not a picture of a cloud: every sprite samples it with
 * its own offset, rotation and scale and carves its outline out of a soft disc with it, so no
 * two puffs look alike.
 *
 *   R — billowy low-frequency noise: erodes the outline of the puff
 *   G, B — two independent finer noises: bump the shading inside the puff (x and y)
 */
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  RepeatWrapping,
} from 'three';
import { mulberry32 } from '../../utils/math';

const SIZE = 128;

/** Smooth value noise on a `period` × `period` lattice that wraps, sampled at (x, y) in lattice units. */
function tilingValueNoise(lattice: Float32Array, period: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const xa = x0 % period;
  const xb = (x0 + 1) % period;
  const ya = y0 % period;
  const yb = (y0 + 1) % period;
  const top = lattice[ya * period + xa] * (1 - sx) + lattice[ya * period + xb] * sx;
  const bottom = lattice[yb * period + xa] * (1 - sx) + lattice[yb * period + xb] * sx;
  return top * (1 - sy) + bottom * sy;
}

/** A tiling fractal noise field in 0..1, `SIZE` × `SIZE`, starting at `basePeriod` cells per tile. */
function tilingFractalNoise(
  random: () => number,
  basePeriod: number,
  octaves: number,
): Float32Array {
  const field = new Float32Array(SIZE * SIZE);
  let amplitude = 1;
  let total = 0;
  let period = basePeriod;
  for (let octave = 0; octave < octaves; octave++) {
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = random();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        field[y * SIZE + x] +=
          amplitude * tilingValueNoise(lattice, period, (x / SIZE) * period, (y / SIZE) * period);
      }
    }
    total += amplitude;
    amplitude *= 0.5;
    period *= 2;
  }
  // normalise to the full 0..1 range so the shader's thresholds mean the same for any seed
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.length; i++) {
    field[i] /= total;
    if (field[i] < min) min = field[i];
    if (field[i] > max) max = field[i];
  }
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - min) / (max - min);
  return field;
}

/** Create the cloud noise texture. The caller owns it and must dispose it. */
export function createCloudNoiseTexture(seed = 0xc10d_7e87): DataTexture {
  const random = mulberry32(seed);
  const billows = tilingFractalNoise(random, 3, 4);
  const detailX = tilingFractalNoise(random, 6, 3);
  const detailY = tilingFractalNoise(random, 6, 3);
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    data[i * 4] = Math.round(billows[i] * 255);
    data[i * 4 + 1] = Math.round(detailX[i] * 255);
    data[i * 4 + 2] = Math.round(detailY[i] * 255);
    data[i * 4 + 3] = 255;
  }
  const texture = new DataTexture(data, SIZE, SIZE, RGBAFormat);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
