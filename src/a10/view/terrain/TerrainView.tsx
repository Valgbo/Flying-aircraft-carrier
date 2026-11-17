/**
 * Terrain rendering. OWNED BY THE ENVIRONMENT + TERRAIN-VIEW MODULE.
 *
 * Chunked level-of-detail terrain built in Web Workers (terrainSystem.ts): every vertex is a
 * sample of the world's one height function (Terrain.heightAt, rebuilt in the worker from
 * getTerrain().data), with roads, the river, the airbase pavements and the forest canopy draped
 * on each tile, a ground texture baked per tile from the world's surface classes and fields,
 * close-range detail, haze and cloud shadows from the environment, and instanced trees near the
 * aircraft. See docs in lod.ts, tileBuilder.ts, terrainMaterial.ts and treeLayer.ts.
 *
 * Hooks for other modules: `terrainUniforms.uThermal` (0 visible, 1 white-hot, 2 black-hot;
 * the sensors module sets it around its own render and restores it) and `terrainStreaming`
 * (live numbers). Terrain picking is the core's (Terrain.raycast), not the view's.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import type { Terrain } from '../../core/world/types';
import { getTerrain, onTerrain } from '../../state/runtime';
import { getA10Quality } from '../quality';
import { terrainUniforms } from './terrainMaterial';
import { terrainStreaming } from './terrainStats';
import { TerrainSystem, type TerrainFrameSettings } from './terrainSystem';

if (import.meta.env.DEV && typeof window !== 'undefined') {
  // development read-out (sandbox, screenshots): live numbers and the shared uniforms
  (window as unknown as { __A10_TERRAIN__: unknown }).__A10_TERRAIN__ = {
    stats: terrainStreaming,
    uniforms: terrainUniforms,
  };
}

/** The preset's terrain settings, refreshed every frame (no allocation per frame). */
const frameSettings: TerrainFrameSettings = { detail: 1, treeCount: 0, treeDistance: 0 };

export default function TerrainView() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const [terrain, setTerrain] = useState<Terrain | null>(getTerrain);
  const system = useRef<TerrainSystem | null>(null);

  useEffect(() => onTerrain(setTerrain), []);

  useEffect(() => {
    if (!terrain) return;
    const sys = new TerrainSystem(terrain, gl, getA10Quality().treeCount);
    scene.add(sys.group);
    system.current = sys;
    return () => {
      system.current = null;
      scene.remove(sys.group);
      sys.dispose();
    };
  }, [terrain, gl, scene]);

  useFrame(({ camera, size, viewport }) => {
    const sys = system.current;
    if (!sys) return;
    sys.viewHeight = size.height * viewport.dpr;
    const q = getA10Quality();
    frameSettings.detail = q.terrainDetail;
    frameSettings.treeCount = q.treeCount;
    frameSettings.treeDistance = q.treeDistance;
    sys.update(camera, frameSettings);
  });

  return null;
}
