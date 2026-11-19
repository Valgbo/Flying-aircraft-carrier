/**
 * The terrain's close-detail bump (terrainMaterial.ts) in a sensor's picture.
 *
 * 1. Moiré. The bump's slope was a one-texel difference of the mipmapped detail texture: on the
 *    coarse mip level a distant (or magnified-from-afar) pixel samples, that is a step per mip
 *    texel, and the steps beat against the pixel grid — broad moiré arcs over fields, ±8 K
 *    stripes in a thermal picture. Now the difference spans the pixel's footprint and the bump
 *    fades out before rows alias.
 * 2. Thermal response. On the drawn (steep) bump a high sun warms no facet and cools every facet
 *    that leans away, so a whole field read colder than the seekers' contrast model has it. Now
 *    the facets change the sun term linearly by THERMAL_BUMP of their slope: no change of the
 *    mean, a few kelvin across rows.
 *
 * The shader cannot run here: its code is pinned by its source, and the numbers come from the
 * generated detail texture itself through the shader's formulas.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CONTRAST } from '../../../src/a10/data/sensors';
import {
  DETAIL_SCALE,
  DETAIL_SIZE,
  buildDetailTextures,
} from '../../../src/a10/view/terrain/detailTextures';
import { DETAIL } from '../../../src/a10/view/terrain/palette';
import {
  BUMP_FADE_TEXELS,
  THERMAL_BUMP,
  createTerrainMaterial,
} from '../../../src/a10/view/terrain/terrainMaterial';
import { sunDirectionAt } from '../../../src/scene/sky/timeOfDay';

const material = createTerrainMaterial();
const fragment = material.fragmentShader;
const N = DETAIL_SIZE;
const data = buildDetailTextures();

/** Height (the alpha channel, 0..1) of layer `l` at texel (x, y), wrapping. */
function height(l: number, x: number, y: number): number {
  const xi = ((x % N) + N) % N;
  const yi = ((y % N) + N) % N;
  return data[(l * N * N + yi * N + xi) * 4 + 3] / 255;
}

/** The shader's bump strength and heat uptake of a ground class (pinned below). */
function bumpK(cls: number): number {
  return cls === 2 ? 1.4 : cls === 3 ? 1.0 : 0.5;
}
function uptake(cls: number): number {
  return cls === 5 ? 0.25 : cls === 3 || cls === 6 ? 0.85 : 0.6;
}

/** Kelvin per unit of the sun term for a class in full sun (the shader's thermal law). */
function kelvinPerSun(cls: number): number {
  return CONTRAST.groundSunGain * CONTRAST.kelvinPerLevel * uptake(cls);
}

/** The sun at 13:00 (solar heating 1), and its horizontal direction. */
const sun = sunDirectionAt(13, new Vector3());
const sunXZ = Math.hypot(sun.x, sun.z);

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

describe('close-detail bump: the shader', () => {
  it('takes the slope over the pixel’s footprint and fades it before rows alias', () => {
    expect(fragment).not.toMatch(/float e = 1\.0 \/ 256\.0;/);
    expect(fragment).toContain(`float e = max(1.0, texels) / ${DETAIL_SIZE}.0;`);
    expect(fragment).toContain('float fade = 1.0 - smoothstep(BUMP_FADE.x, BUMP_FADE.y, texels);');
    expect(fragment).toContain(
      `const vec2 BUMP_FADE = vec2(${BUMP_FADE_TEXELS[0].toFixed(1)}, ${BUMP_FADE_TEXELS[1].toFixed(1)});`,
    );
    // the footprint comes from derivatives taken before any branch (uniform control flow)
    const main = fragment.slice(fragment.indexOf('void main()'));
    expect(main.indexOf('dFdx(vWorld.xz)')).toBeGreaterThan(0);
    expect(main.indexOf('dFdx(vWorld.xz)')).toBeLessThan(main.indexOf('if ('));
    expect(main).toContain('float footprint = max(length(wx), length(wy));');
    // every bump goes through it: the ground's, and the canopy's two
    expect(main).toContain('facet = bumpSlope(p, cls, ax, ay, footprint, bumpK * near * near);');
    expect(main).toContain('bumpedAt(N, vWorld.xz, 5.0, CROWN_SCALE, footprint, 1.2)');
    expect(main).toMatch(/bumped\(N, vWorld\.xz, 5\.0, [^;]*footprint, 1\.6 \* near\)/);
    expect(main).toContain('float bumpK = cls == 2.0 ? 1.4 : cls == 3.0 ? 1.0 : 0.5;');
  });

  it('warms the ground’s facets linearly by THERMAL_BUMP of their slope', () => {
    expect(fragment).toContain(`const float THERMAL_BUMP = ${THERMAL_BUMP.toFixed(3)};`);
    expect(fragment).toContain(
      'float sun = max(max(dot(Nsun, uSunDir), 0.0) - THERMAL_BUMP * dot(facet, uSunDir.xz), 0.0) * sunVisible;',
    );
    expect(fragment).toMatch(
      /heatUptake = cls == 5\.0 \? 0\.25 : cls == 3\.0 \|\| cls == 6\.0 \? 0\.85 : 0\.6/,
    );
  });
});

describe('ground classes in a thermal picture', () => {
  it('blends the class temperature across texel edges (no staircase along hedgerows)', () => {
    // a magnified thermal picture (finer tiles, 4 m texels) showed every hedgerow and field
    // edge as a staircase of texels: the class came from the nearest texel
    const main = fragment.slice(fragment.indexOf('void main()'));
    expect(main).toContain(
      'vec2 ground = uThermal > 0.5 ? groundThermalAt(vUv) : groundThermal(cls);',
    );
    const at = fragment.slice(fragment.indexOf('vec2 groundThermalAt(vec2 uv)'));
    expect(at).toMatch(/vec2 w = fract\(f\);/);
    expect(at.match(/groundThermal\(classAt\(/g)).toHaveLength(4);
    expect(at).toContain('return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);');
    // the class table itself is the contrast model's (tests/unit/a10/sensorsContrast.test.ts)
    expect(fragment).toMatch(/float temperature = cls == 3\.0 \? /);
  });
});

describe('close-detail bump: a thermal picture of a field', () => {
  // ---- one line of heights across the rows, sampled as the GPU samples it ----
  // GL's mipmaps (box filter, wrapping), trilinear filtering at a level of detail, and the
  // anisotropic filter's probes: a pixel seen at 20° depression (the pod 8 km out, 3 km up) is
  // three times longer along the view than across it, so the GPU samples the mip level of the
  // shorter side at three points along the longer one.
  const ANISO = 3;
  function mipChain(line: number[]): number[][] {
    const out = [line];
    while (out[out.length - 1].length > 1) {
      const a = out[out.length - 1];
      out.push(Array.from({ length: a.length / 2 }, (_, i) => (a[2 * i] + a[2 * i + 1]) / 2));
    }
    return out;
  }
  function linear(level: number[], t: number): number {
    const n = level.length;
    const u = t - 0.5;
    const i = Math.floor(u);
    const w = u - i;
    return level[((i % n) + n) % n] * (1 - w) + level[(((i + 1) % n) + n) % n] * w;
  }
  function trilinear(chain: number[][], t: number, f: number): number {
    const lod = Math.max(0, Math.min(chain.length - 1, Math.log2(Math.max(1, f))));
    const a = Math.floor(lod);
    const b = Math.min(chain.length - 1, a + 1);
    const w = lod - a;
    return linear(chain[a], t / 2 ** a) * (1 - w) + linear(chain[b], t / 2 ** b) * w;
  }
  /** What a texture fetch returns at t (texels) for a pixel f texels long along the line. */
  function fetch(chain: number[][], t: number, f: number): number {
    const a = Math.max(1, Math.min(ANISO, Math.floor(f)));
    let sum = 0;
    for (let j = 0; j < a; j++) sum += trilinear(chain, t + ((j + 0.5) / a - 0.5) * f, f / a);
    return sum / a;
  }
  const fade = (f: number) => {
    const [a, b] = BUMP_FADE_TEXELS;
    const x = Math.min(1, Math.max(0, (f - a) / (b - a)));
    return 1 - x * x * (3 - 2 * x);
  };

  /**
   * The rows of layer `cls` (across v) lying across the sun at 13:00, seen by `count` pixels `f`
   * texels long: their bump slopes (world, along the sun's azimuth) and the kelvin the thermal
   * picture adds — before (a one-texel difference, the sun on the bumped normal) and now (a
   * difference over the footprint with the fade, linear in THERMAL_BUMP of the slope).
   */
  function stripes(cls: number, f: number, count = 600) {
    const chain = mipChain(Array.from({ length: N }, (_, y) => height(cls, 17, y)));
    const toWorld = (N / DETAIL_SCALE[cls]) * bumpK(cls);
    const k = kelvinPerSun(cls);
    const slopeBefore: number[] = [];
    const slopeNow: number[] = [];
    const before: number[] = [];
    const now: number[] = [];
    for (let i = 0; i < count; i++) {
      const t = 3.37 + i * f; // pixel centres, in texels across the rows
      const g0 = (fetch(chain, t + 1, f) - fetch(chain, t, f)) * toWorld;
      const e = Math.max(1, f);
      const g1 = ((fetch(chain, t + e, f) - fetch(chain, t, f)) / e) * toWorld * fade(f);
      slopeBefore.push(g0);
      slopeNow.push(g1);
      const n = Math.hypot(g0, 1);
      before.push(k * (Math.max((sun.y + g0 * sunXZ) / n, 0) - sun.y));
      now.push(k * (Math.max(sun.y - THERMAL_BUMP * g1 * sunXZ, 0) - sun.y));
    }
    const rms = (a: number[]) => Math.sqrt(a.reduce((acc, v) => acc + v * v, 0) / a.length);
    return { slopeBefore, slopeNow, rmsBefore: rms(before), rmsNow: rms(now) };
  }

  it('shows no stripes where the rows are finer than its pixels (the moiré over fields)', () => {
    // a pod pixel at 5–8 km (NARROW ×1–×2: 0.17–0.55 m) is 14–44 texels of the crop layer
    // (rows 32 texels apart) long, and 6–20 of the ploughed one (furrows 21 apart)
    for (const [cls, footprints] of [
      [DETAIL.crop, [16, 23.3, 31.7]],
      [DETAIL.ploughed, [16, 19.6, 23.3]],
    ] as const) {
      for (const f of footprints) {
        const s = stripes(cls, f);
        // before: kelvin-sized stripes that are aliases of the rows (they beat against the
        // pixel grid: the broad arcs over fields)
        expect(s.rmsBefore, `class ${cls} at ${f} texels`).toBeGreaterThan(1.5);
        // now: a uniform field
        expect(s.rmsNow, `class ${cls} at ${f} texels`).toBe(0);
      }
    }
  });

  it('keeps the bump as it was up close, and the rows where the pixels resolve them', () => {
    for (const cls of [DETAIL.crop, DETAIL.ploughed]) {
      // under a texel per pixel: the very slope of before (the outside view up close)
      const close = stripes(cls, 0.5, 300);
      for (let i = 0; i < close.slopeNow.length; i++)
        expect(close.slopeNow[i]).toBeCloseTo(close.slopeBefore[i], 12);
      // resolved rows (≥ 4 pixels per row) keep a thermal texture of a kelvin or more
      for (const f of [2, 4]) expect(stripes(cls, f).rmsNow).toBeGreaterThan(1);
    }
  });

  it('keeps every ground class’s mean on the contrast model, a few kelvin across its rows', () => {
    // the whole layer, two orientations of its rows to the sun, as pixels 1–8 texels wide see it
    // (a box-filtered mip level per footprint, bilinear: the GPU's own sampling of a level)
    const report: string[] = [];
    for (const cls of [0, 1, 2, 3, 4, 6, 7]) {
      const k = kelvinPerSun(cls);
      const toWorld = (N / DETAIL_SCALE[cls]) * bumpK(cls);
      for (const m of [0, 1, 2, 3]) {
        const f = 2 ** m;
        const s = N >> m;
        const level = new Float64Array(s * s);
        for (let y = 0; y < s; y++)
          for (let x = 0; x < s; x++) {
            let a = 0;
            for (let j = 0; j < f; j++)
              for (let i = 0; i < f; i++) a += height(cls, x * f + i, y * f + j);
            level[y * s + x] = a / (f * f);
          }
        const at = (u: number, v: number) => {
          const x = u - 0.5;
          const y = v - 0.5;
          const i = Math.floor(x);
          const j = Math.floor(y);
          const fx = x - i;
          const fy = y - j;
          const g = (a: number, b: number) => level[(((b % s) + s) % s) * s + (((a % s) + s) % s)];
          return (
            g(i, j) * (1 - fx) * (1 - fy) +
            g(i + 1, j) * fx * (1 - fy) +
            g(i, j + 1) * (1 - fx) * fy +
            g(i + 1, j + 1) * fx * fy
          );
        };
        const before: number[] = [];
        const now: number[] = [];
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            const u = (x + 0.5) / f;
            const v = (y + 0.5) / f;
            const h0 = at(u, v);
            // before: one texel (1/f of this level's texel)
            const bx = (at(u + 1 / f, v) - h0) * toWorld;
            const by = (at(u, v + 1 / f) - h0) * toWorld;
            // now: the footprint (one texel of this level), faded
            const nx = ((at(u + 1, v) - h0) / f) * toWorld * fade(f);
            const ny = ((at(u, v + 1) - h0) / f) * toWorld * fade(f);
            for (const along of [false, true]) {
              const lx = along ? sunXZ : 0;
              const lz = along ? 0 : sunXZ;
              const len = Math.hypot(bx, 1, by);
              before.push(k * (Math.max((sun.y - bx * lx - by * lz) / len, 0) - sun.y));
              now.push(k * (Math.max(sun.y - THERMAL_BUMP * (nx * lx + ny * lz), 0) - sun.y));
            }
          }
        }
        const mean = (a: number[]) => a.reduce((acc, v) => acc + v, 0) / a.length;
        const b = [...before].sort((p, q) => p - q);
        const a = [...now].sort((p, q) => p - q);
        const line =
          `class ${cls}, ${f} texels per pixel: before mean ${mean(before).toFixed(2)} K, ` +
          `1–99 % ${quantile(b, 0.01).toFixed(1)}…${quantile(b, 0.99).toFixed(1)} K; now mean ` +
          `${mean(now).toFixed(2)} K, 1–99 % ${quantile(a, 0.01).toFixed(1)}…${quantile(a, 0.99).toFixed(1)} K`;
        report.push(line);
        // a field's level is the seekers' (what looks hot is what they can lock)
        expect(Math.abs(mean(now)), line).toBeLessThan(0.1);
        // a few kelvin across rows and furrows where a pod's pixel resolves them (≥ 2 texels:
        // per-texel grain at 2 cm is out of any sensor's reach)
        if (f >= 2) {
          expect(quantile(a, 0.99), line).toBeLessThan(8);
          expect(-quantile(a, 0.01), line).toBeLessThan(8);
        }
      }
    }
    // before, crop and ploughed fields read several kelvin colder than the contrast model even
    // at 8 texels per pixel (the reason for the change)
    expect(report.join('\n')).toMatch(/class 1, 8 texels per pixel: before mean -[3-9]/);
    expect(report.join('\n')).toMatch(/class 2, 8 texels per pixel: before mean -[3-9]/);
  }, 30_000); // every texel of seven layers at four footprints: a few seconds
});
