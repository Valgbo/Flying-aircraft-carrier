import { DataTexture, FogExp2, Mesh, PerspectiveCamera, Scene, type Color } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { HARD_LANDING_SINK_RATE } from '../../src/config/physicsConfig';
import { QUALITY_PRESETS } from '../../src/config/quality';
import { WAVES, waveHeightAt, waveOmega } from '../../src/config/waves';
import {
  DETAIL_HEIGHT_RMS,
  DETAIL_SLOPE_RMS,
  generateDetailPixels,
} from '../../src/scene/ocean/detailTexture';
import { OCEAN, computeLayerOffsets, textureLayers } from '../../src/scene/ocean/oceanConfig';
import {
  createOceanSurface,
  startSplash,
  updateOceanSurface,
} from '../../src/scene/ocean/oceanFrame';
import {
  OCEAN_HALF_EXTENT,
  OCEAN_UNIFORM_HALF,
  buildOceanGeometry,
  oceanGridLayout,
} from '../../src/scene/ocean/oceanGrid';
import { oceanFragmentShader, oceanVertexShader } from '../../src/scene/ocean/oceanShader';
import {
  GERSTNER_HEIGHT_ERROR,
  WAVE_COUNT,
  WAVE_TERMS,
  computeWavePhases,
  evalWaveDisplacement,
  evalWaveSurface,
  waveDisplacementGLSL,
  waveSurfaceGLSL,
} from '../../src/scene/ocean/waveExpr';
import { acesFilmicToneMap } from '../../src/scene/sky/toneMap';
import { resetSimForScreen, sim } from '../../src/state/sim';
import { mulberry32 } from '../../src/utils/math';

const AMPLITUDE_SUM = WAVES.reduce((sum, w) => sum + w.amplitude, 0);
const MAX_SLOPE = WAVES.reduce((sum, w) => sum + (w.amplitude * 2 * Math.PI) / w.wavelength, 0);
const MAX_RATE = WAVES.reduce((sum, w) => sum + w.amplitude * waveOmega(w.wavelength), 0);

function smoothstepJs(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Run a generated GLSL function body as JavaScript. The generator only emits `float x = …;`
 * statements over sin / cos / abs / smoothstep and a final `return vec3(…);`, so the
 * translation is mechanical — and it executes the very text the GPU compiles.
 */
function compileGlsl(source: string, params: string[]): (...args: unknown[]) => number[] {
  const lines = source.trim().split('\n');
  const body = lines
    .slice(1, -1)
    .join('\n')
    .replace(/\bfloat /g, 'const ')
    .replace(/return vec3\((.*)\);/s, 'return [$1];');
  const run = new Function(...params, 'sin', 'cos', 'abs', 'smoothstep', body);
  return (...args) => run(...args, Math.sin, Math.cos, Math.abs, smoothstepJs) as number[];
}

describe('wave table', () => {
  it('describes a moderate sea: a long swell plus shorter wind waves', () => {
    expect(WAVES.length).toBeGreaterThanOrEqual(4);
    expect(WAVES.length).toBeLessThanOrEqual(10);
    const significant = 4 * Math.sqrt(WAVES.reduce((sum, w) => sum + w.amplitude ** 2 / 2, 0));
    expect(significant).toBeGreaterThan(2);
    expect(significant).toBeLessThan(3);
    expect(Math.max(...WAVES.map((w) => w.wavelength))).toBeGreaterThan(150);
    for (const w of WAVES) {
      expect(Math.hypot(w.dirX, w.dirZ)).toBeCloseTo(1, 9);
      // no component is anywhere near breaking (steepness k·a well under 0.3)
      expect((2 * Math.PI * w.amplitude) / w.wavelength).toBeLessThan(0.1);
      expect(w.steepness).toBeGreaterThanOrEqual(0);
      expect(w.steepness).toBeLessThanOrEqual(1);
    }
  });

  it('obeys the deep-water dispersion relation', () => {
    for (const w of WAVES) {
      const k = (2 * Math.PI) / w.wavelength;
      expect(waveOmega(w.wavelength) ** 2).toBeCloseTo(9.81 * k, 9);
    }
  });
});

describe('waveHeightAt', () => {
  it('stays inside the amplitude envelope and actually uses it', () => {
    const random = mulberry32(11);
    let highest = -Infinity;
    let lowest = Infinity;
    let sumSquares = 0;
    const samples = 20_000;
    for (let i = 0; i < samples; i++) {
      const h = waveHeightAt(
        (random() - 0.5) * 40_000,
        (random() - 0.5) * 40_000,
        random() * 3_600,
      );
      expect(Math.abs(h)).toBeLessThanOrEqual(AMPLITUDE_SUM + 1e-9);
      highest = Math.max(highest, h);
      lowest = Math.min(lowest, h);
      sumSquares += h * h;
    }
    expect(highest).toBeGreaterThan(0.55 * AMPLITUDE_SUM);
    expect(lowest).toBeLessThan(-0.55 * AMPLITUDE_SUM);
    const expectedRms = Math.sqrt(WAVES.reduce((sum, w) => sum + w.amplitude ** 2 / 2, 0));
    expect(Math.sqrt(sumSquares / samples)).toBeCloseTo(expectedRms, 1);
  });

  it('is continuous in space and time', () => {
    const random = mulberry32(5);
    for (let i = 0; i < 2_000; i++) {
      const x = (random() - 0.5) * 10_000;
      const z = (random() - 0.5) * 10_000;
      const t = random() * 600;
      const h = waveHeightAt(x, z, t);
      const step = 0.05;
      expect(Math.abs(waveHeightAt(x + step, z, t) - h)).toBeLessThanOrEqual(MAX_SLOPE * step);
      expect(Math.abs(waveHeightAt(x, z + step, t) - h)).toBeLessThanOrEqual(MAX_SLOPE * step);
      expect(Math.abs(waveHeightAt(x, z, t + 0.01) - h)).toBeLessThanOrEqual(MAX_RATE * 0.01);
    }
  });

  it('travels in the direction the table says', () => {
    // Following the swell at its phase speed keeps the surface more alike than going against it.
    const swell = WAVES[0];
    const speed = waveOmega(swell.wavelength) / ((2 * Math.PI) / swell.wavelength);
    const tau = 2;
    const random = mulberry32(23);
    let withSwell = 0;
    let againstSwell = 0;
    for (let i = 0; i < 4_000; i++) {
      const x = (random() - 0.5) * 20_000;
      const z = (random() - 0.5) * 20_000;
      const t = random() * 900;
      const h = waveHeightAt(x, z, t);
      const dx = swell.dirX * speed * tau;
      const dz = swell.dirZ * speed * tau;
      withSwell += h * waveHeightAt(x + dx, z + dz, t + tau);
      againstSwell += h * waveHeightAt(x - dx, z - dz, t + tau);
    }
    expect(withSwell).toBeGreaterThan(0);
    expect(withSwell).toBeGreaterThan(againstSwell + 0.2 * Math.abs(withSwell));
  });

  it('is cheap: 10,000 evaluations take a few milliseconds', () => {
    let sink = 0;
    for (let i = 0; i < 2_000; i++) sink += waveHeightAt(i, -i, i * 0.01); // warm up
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) sink += waveHeightAt(i * 1.37, i * -0.61, i * 0.016);
    const elapsed = performance.now() - start;
    expect(Number.isFinite(sink)).toBe(true);
    // ≈ 1 ms on an idle machine; the bound leaves room for a loaded CI box
    expect(elapsed).toBeLessThan(60);
  });
});

describe('vertex-shader surface vs. waveHeightAt', () => {
  const phases = new Array<number>(WAVE_COUNT).fill(0);

  it('wraps the phases without changing the wave', () => {
    computeWavePhases(123_456.7, -98_765.4, 4_321.5, phases);
    for (let i = 0; i < WAVE_COUNT; i++) {
      expect(Math.abs(phases[i])).toBeLessThanOrEqual(Math.PI + 1e-9);
      const t = WAVE_TERMS[i];
      const exact = t.kx * 123_456.7 + t.kz * -98_765.4 - t.omega * 4_321.5;
      expect(Math.sin(phases[i])).toBeCloseTo(Math.sin(exact), 6);
    }
  });

  it('has exactly the height of waveHeightAt at the rest point', () => {
    const random = mulberry32(3);
    for (let i = 0; i < 500; i++) {
      const centreX = Math.round((random() - 0.5) * 400_000);
      const centreZ = Math.round((random() - 0.5) * 400_000);
      const time = random() * 5_000;
      computeWavePhases(centreX, centreZ, time, phases);
      const x = (random() - 0.5) * 320;
      const z = (random() - 0.5) * 320;
      const d = evalWaveDisplacement(x, z, 0, phases);
      expect(d.height).toBeCloseTo(waveHeightAt(centreX + x, centreZ + z, time), 6);
    }
  });

  it('puts the drawn surface within 0.3 m of waveHeightAt under the hull on every preset', () => {
    expect(GERSTNER_HEIGHT_ERROR).toBeLessThan(0.1);
    const random = mulberry32(8);
    for (const preset of Object.values(QUALITY_PRESETS)) {
      const cell = oceanGridLayout(preset.oceanSegments).baseCell;
      let worst = 0;
      for (let i = 0; i < 2_000; i++) {
        const time = random() * 2_000;
        computeWavePhases(0, 0, time, phases);
        const x = (random() - 0.5) * 2 * OCEAN_UNIFORM_HALF;
        const z = (random() - 0.5) * 2 * OCEAN_UNIFORM_HALF;
        const d = evalWaveDisplacement(x, z, cell, phases);
        // the vertex ends up at (x + sway); compare with the physics height above that point
        const physics = waveHeightAt(x + d.offsetX, z + d.offsetZ, time);
        worst = Math.max(worst, Math.abs(d.height - physics));
      }
      expect(worst).toBeLessThan(0.3);
    }
  });

  it('drops waves the mesh cannot carry instead of aliasing them', () => {
    computeWavePhases(0, 0, 10, phases);
    const coarse = evalWaveDisplacement(40, -70, 5_000, phases);
    expect(coarse.height).toBe(0);
    expect(coarse.offsetX).toBe(0);
    expect(coarse.offsetZ).toBe(0);
  });

  it('compiles to GLSL that computes the same numbers as the TypeScript port', () => {
    const displacement = compileGlsl(waveDisplacementGLSL(), ['p', 'cell', 'uWavePhase']);
    const surface = compileGlsl(waveSurfaceGLSL(), ['p', 'du', 'dv', 'gain', 'uWavePhase']);
    const zero = { x: 0, y: 0 };
    const random = mulberry32(42);
    for (let i = 0; i < 300; i++) {
      computeWavePhases(random() * 9_000, random() * -9_000, random() * 900, phases);
      const x = (random() - 0.5) * 2_000;
      const z = (random() - 0.5) * 2_000;
      const cell = random() < 0.5 ? 2.5 : random() * 60;

      const glsl = displacement({ x, y: z }, cell, phases);
      const port = evalWaveDisplacement(x, z, cell, phases);
      expect(glsl[0]).toBeCloseTo(port.offsetX, 6);
      expect(glsl[1]).toBeCloseTo(port.height, 6);
      expect(glsl[2]).toBeCloseTo(port.offsetZ, 6);

      const glslSurface = surface({ x, y: z }, zero, zero, { x: 1, y: 1, z: 1 }, phases);
      const portSurface = evalWaveSurface(x, z, phases);
      expect(glslSurface[0]).toBeCloseTo(portSurface.slopeX, 6);
      expect(glslSurface[1]).toBeCloseTo(portSurface.slopeZ, 6);
      expect(glslSurface[2]).toBeCloseTo(portSurface.crest, 6);
    }
  });

  it('shades with the slope of the surface it displaces', () => {
    // finite differences of the displaced surface agree with the analytic slope
    computeWavePhases(0, 0, 77, phases);
    const random = mulberry32(19);
    const e = 0.01;
    for (let i = 0; i < 200; i++) {
      const x = (random() - 0.5) * 300;
      const z = (random() - 0.5) * 300;
      const a = evalWaveDisplacement(x - e, z, 0, phases);
      const b = evalWaveDisplacement(x + e, z, 0, phases);
      const c = evalWaveDisplacement(x, z - e, 0, phases);
      const d = evalWaveDisplacement(x, z + e, 0, phases);
      // tangents of the displaced surface along the two rest axes
      const tx = [2 * e + b.offsetX - a.offsetX, b.height - a.height, b.offsetZ - a.offsetZ];
      const tz = [d.offsetX - c.offsetX, d.height - c.height, 2 * e + d.offsetZ - c.offsetZ];
      const nx = tz[1] * tx[2] - tz[2] * tx[1];
      const ny = tz[2] * tx[0] - tz[0] * tx[2];
      const nz = tz[0] * tx[1] - tz[1] * tx[0];
      const s = evalWaveSurface(x, z, phases);
      expect(-nx / ny).toBeCloseTo(s.slopeX, 4);
      expect(-nz / ny).toBeCloseTo(s.slopeZ, 4);
      expect(Math.abs(s.crest)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('ocean grid', () => {
  it.each(Object.values(QUALITY_PRESETS).map((p) => p.oceanSegments))(
    'is symmetric, dense in the middle and reaches the far edge with %i segments',
    (segments) => {
      const layout = oceanGridLayout(segments);
      const { lines, baseCell, segments: n } = layout;
      expect(n).toBe(segments);
      expect(lines.length).toBe(n + 1);
      expect(lines[n]).toBe(OCEAN_HALF_EXTENT);
      expect(lines[n / 2]).toBeCloseTo(0, 9);
      for (let i = 0; i < n; i++) {
        expect(lines[i + 1]).toBeGreaterThan(lines[i]);
        expect(lines[i]).toBeCloseTo(-lines[n - i], 6);
      }
      // uniform over the hull, never coarser toward the centre
      for (let i = n / 2; i < n; i++) {
        const width = lines[i + 1] - lines[i];
        if (lines[i + 1] <= OCEAN_UNIFORM_HALF + 1e-6) expect(width).toBeCloseTo(baseCell, 6);
        else expect(width).toBeGreaterThan(baseCell);
      }
      // the far proxy needs the outermost ring of vertices beyond its end, wherever the camera is
      expect(OCEAN_HALF_EXTENT - OCEAN.maxCentreBias - baseCell).toBeGreaterThan(OCEAN.farEnd);

      const geometry = buildOceanGeometry(layout);
      expect(geometry.getAttribute('position').count).toBe((n + 1) ** 2);
      expect(geometry.getAttribute('aCell').count).toBe((n + 1) ** 2);
      expect(geometry.getIndex()?.count).toBe(n * n * 6);
      geometry.dispose();
    },
  );
});

describe('ocean shader sources', () => {
  it('are generated for every quality level, with fewer ripple octaves on Low', () => {
    const vertex = oceanVertexShader();
    expect(vertex).toContain('oceanWaveDisplacement');
    expect(vertex).toContain(`uWavePhase[${WAVE_COUNT}]`);
    const fetches = (source: string) => source.split('texture2D(').length - 1;
    const low = oceanFragmentShader('low');
    const high = oceanFragmentShader('high');
    for (const source of [low, high]) {
      expect(source).toContain('#include <tonemapping_fragment>');
      expect(source).toContain('#include <colorspace_fragment>');
      expect(source).not.toMatch(/NaN|undefined|Infinity/);
    }
    expect(fetches(low)).toBeLessThan(fetches(high));
  });

  it('keeps texture offsets wrapped however far and long the flight', () => {
    const layers = textureLayers('high');
    const offsets = new Float32Array(layers.length * 2);
    computeLayerOffsets(layers, 512_345.5, -1_204_000.25, 86_400, offsets);
    for (const value of offsets) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('ocean frame update', () => {
  afterEach(() => resetSimForScreen('menu'));

  function frame() {
    const surface = createOceanSurface('low', new DataTexture(), 1);
    const mesh = new Mesh();
    const camera = new PerspectiveCamera();
    camera.position.set(0, 80, 300);
    const scene = new Scene();
    return { surface, update: () => updateOceanSurface(surface, mesh, camera, scene, 8), scene };
  }

  it('fades the sea to the scene-linear horizon colour, whatever colour the scene fog carries', () => {
    const { surface, update, scene } = frame();
    sim.env.horizonColor.setRGB(0.52, 0.66, 0.8);
    // what World stores in the fog when the renderer tone-maps (the Low preset): the horizon
    // colour already tone-mapped for the built-in materials. The ocean shader tone-maps its own
    // output, so taking this colour would map it twice and split the sea from the sky.
    const mapped = acesFilmicToneMap(sim.env.horizonColor.clone(), 1);
    expect(mapped.equals(sim.env.horizonColor)).toBe(false);
    scene.fog = new FogExp2(mapped, 0.00012);
    update();
    const fogColor: Color = surface.uniforms.uFogColor.value;
    expect(fogColor.toArray()).toEqual(sim.env.horizonColor.toArray());
    // …while the fog's distances are still honoured
    expect(surface.uniforms.uFog.value.x).toBeCloseTo(0.00012, 9);
    scene.fog = null;
    update();
    expect(fogColor.toArray()).toEqual(sim.env.horizonColor.toArray());
    expect(surface.uniforms.uFog.value.x).toBeCloseTo(OCEAN.defaultFogDensity, 9);
  });

  it('starts a splash on splashdown that ages with sim.time and dissolves', () => {
    const { surface, update } = frame();
    const splash = surface.uniforms.uSplash.value;
    sim.time = 40;
    update();
    expect(splash.toArray()).toEqual([0, 0]);

    startSplash(surface, HARD_LANDING_SINK_RATE);
    update();
    expect(splash.x).toBe(0);
    expect(splash.y).toBeCloseTo(1, 9);
    sim.time = 41.5;
    update();
    expect(splash.x).toBeCloseTo(1.5, 9);
    // paused: sim.time stands still, and so does the splash
    update();
    expect(splash.x).toBeCloseTo(1.5, 9);
    sim.time = 40 + OCEAN.splash.duration + 0.01;
    update();
    expect(splash.toArray()).toEqual([0, 0]);

    // a gentle touch-down is a small splash, a crash is capped, a restarted clock ends it
    startSplash(surface, 0.2 * HARD_LANDING_SINK_RATE);
    update();
    expect(splash.y).toBeCloseTo(0.2, 9);
    startSplash(surface, 10 * HARD_LANDING_SINK_RATE);
    update();
    expect(splash.y).toBe(OCEAN.splash.maxStrength);
    sim.time = 3;
    update();
    expect(splash.toArray()).toEqual([0, 0]);
  });

  it('declares every uniform the shaders use, including the swirl layers', () => {
    const { surface } = frame();
    const layers = textureLayers('low');
    expect(surface.uniforms.uLayerOffset.value).toHaveLength(layers.length * 2);
    const source = surface.material.fragmentShader;
    expect(source).toContain(`uniform vec2 uLayerOffset[${layers.length}];`);
    expect(source).toContain(`uLayerOffset[${layers.length - 1}])`);
    expect(surface.material.fragmentShader).toContain('uniform vec2 uSplash;');
  });
});

describe('detail texture', () => {
  it('is deterministic, centred and has the advertised slope and height contrast', () => {
    const pixels = generateDetailPixels();
    expect(generateDetailPixels()).toEqual(pixels);
    const count = pixels.length / 4;
    const mean = [0, 0, 0, 0];
    const square = [0, 0, 0, 0];
    for (let i = 0; i < pixels.length; i++) {
      const v = pixels[i] / 127.5 - 1;
      mean[i % 4] += v / count;
      square[i % 4] += (v * v) / count;
    }
    for (let c = 0; c < 4; c++) expect(Math.abs(mean[c])).toBeLessThan(0.02);
    expect(Math.sqrt((square[0] + square[1]) / 2)).toBeCloseTo(DETAIL_SLOPE_RMS, 1);
    expect(Math.sqrt(square[2])).toBeCloseTo(DETAIL_HEIGHT_RMS, 1);
  });
});
