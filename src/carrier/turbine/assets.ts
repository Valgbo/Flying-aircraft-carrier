/**
 * Shared GPU assets of the turbines. The four turbines use the same geometries, textures and
 * materials, built once per quality level and handed out through the hooks below. Users are
 * counted; when the last one unmounts the GPU resources are released (`dispose`). The JS-side
 * objects stay cached, so a later mount (or React StrictMode's mount → unmount → mount) simply
 * lets three.js upload them again.
 */
import { useEffect, useMemo } from 'react';
import type {
  BufferGeometry,
  InstancedBufferGeometry,
  MeshStandardMaterial,
  ShaderMaterial,
  Texture,
} from 'three';
import {
  buildParticleGeometry,
  buildPlumeGeometry,
  createExhaustParticleMaterial,
  createPlumeMaterial,
  createSprayMaterial,
} from './exhaust';
import {
  buildBladeGeometry,
  buildBlurDiscGeometry,
  buildDecalGeometry,
  buildGlowGeometry,
  buildNacelleGeometry,
  buildRotorGeometry,
} from './geometry';
import {
  createBladeMaterial,
  createBlurDiscMaterial,
  createDecalMaterial,
  createGlowMaterial,
  createNacelleMaterial,
} from './materials';
import { sprayParticleCount, turbineDetail } from './model';
import { createBlurStreakTexture, createNumberAtlas, createPaintAtlas } from './textures';

interface Disposable {
  dispose(): void;
}

interface Counted {
  users: number;
  disposables: Disposable[];
}

export interface NacelleAssets extends Counted {
  nacelle: BufferGeometry;
  rotor: BufferGeometry;
  blades: BufferGeometry;
  glow: BufferGeometry;
  blurDisc: BufferGeometry;
  /** Number decal per turbine index. */
  decals: BufferGeometry[];
  nacelleMaterial: MeshStandardMaterial;
  /** Template: every turbine clones it for its own blade opacity. */
  bladeMaterial: MeshStandardMaterial;
  decalMaterial: MeshStandardMaterial;
  glowMaterial: ShaderMaterial;
  discMaterial: ShaderMaterial;
}

export interface ExhaustAssets extends Counted {
  plume: BufferGeometry;
  particles: InstancedBufferGeometry;
  spray: InstancedBufferGeometry;
  plumeMaterial: ShaderMaterial;
  particleMaterial: ShaderMaterial;
  sprayMaterial: ShaderMaterial;
}

const nacelleCache = new Map<number, NacelleAssets>();
const exhaustCache = new Map<string, ExhaustAssets>();

function createNacelleAssets(detail: 0 | 1 | 2): NacelleAssets {
  const d = turbineDetail(detail);
  const paint: Texture = createPaintAtlas(d.atlasSize);
  const numbers: Texture = createNumberAtlas(d.atlasSize / 4);
  const streaks: Texture = createBlurStreakTexture();
  const assets = {
    nacelle: buildNacelleGeometry(d),
    rotor: buildRotorGeometry(d),
    blades: buildBladeGeometry(d),
    glow: buildGlowGeometry(d),
    blurDisc: buildBlurDiscGeometry(d),
    decals: [0, 1, 2, 3].map((index) => buildDecalGeometry(index, d)),
    nacelleMaterial: createNacelleMaterial(paint),
    bladeMaterial: createBladeMaterial(),
    decalMaterial: createDecalMaterial(numbers),
    glowMaterial: createGlowMaterial(),
    discMaterial: createBlurDiscMaterial(streaks),
  };
  return {
    ...assets,
    users: 0,
    disposables: [
      paint,
      numbers,
      streaks,
      assets.nacelle,
      assets.rotor,
      assets.blades,
      assets.glow,
      assets.blurDisc,
      ...assets.decals,
      assets.nacelleMaterial,
      assets.bladeMaterial,
      assets.decalMaterial,
      assets.glowMaterial,
      assets.discMaterial,
    ],
  };
}

function createExhaustAssets(detail: 0 | 1 | 2, particles: number): ExhaustAssets {
  const assets = {
    plume: buildPlumeGeometry(turbineDetail(detail)),
    particles: buildParticleGeometry(particles, 101),
    spray: buildParticleGeometry(sprayParticleCount(particles), 211),
    plumeMaterial: createPlumeMaterial(),
    particleMaterial: createExhaustParticleMaterial(),
    sprayMaterial: createSprayMaterial(),
  };
  return { ...assets, users: 0, disposables: Object.values(assets) };
}

function useCounted<T extends Counted>(assets: T): T {
  useEffect(() => {
    assets.users++;
    return () => {
      assets.users--;
      if (assets.users === 0) assets.disposables.forEach((item) => item.dispose());
    };
  }, [assets]);
  return assets;
}

/** Geometries, textures and materials of the nacelle for a quality `detail` level. */
export function useNacelleAssets(detail: 0 | 1 | 2): NacelleAssets {
  const assets = useMemo(() => {
    let cached = nacelleCache.get(detail);
    if (!cached) {
      cached = createNacelleAssets(detail);
      nacelleCache.set(detail, cached);
    }
    return cached;
  }, [detail]);
  return useCounted(assets);
}

/** Plume, particle and spray assets for a detail level and exhaust particle budget. */
export function useExhaustAssets(detail: 0 | 1 | 2, particles: number): ExhaustAssets {
  const assets = useMemo(() => {
    const key = `${detail}:${particles}`;
    let cached = exhaustCache.get(key);
    if (!cached) {
      cached = createExhaustAssets(detail, particles);
      exhaustCache.set(key, cached);
    }
    return cached;
  }, [detail, particles]);
  return useCounted(assets);
}
