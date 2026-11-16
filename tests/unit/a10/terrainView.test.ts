/**
 * Terrain view (environment + terrain-view module): level-of-detail selection, tile geometry
 * on the world's one height function, ribbons, the canopy shell, tree cells and the haze law.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createFlatTerrain, createTerrain, generateTerrainData } from '../../../src/a10/core/world';
import type { RoadPolyline, Terrain } from '../../../src/a10/core/world/types';
import {
  hazeAmount,
  hazeDensityFor,
  hazeDistanceFor,
  hazeFactor,
} from '../../../src/a10/view/environment/haze';
import {
  MAX_LEVEL_BY_DETAIL,
  ROOT_SIZE,
  TILE_QUADS,
  nodeKey,
  nodeOrigin,
  nodeSize,
  selectTiles,
  vertexSpacing,
  type LodNode,
} from '../../../src/a10/view/terrain/lod';
import { rasterCloudShadow } from '../../../src/a10/view/terrain/cloudShadow';
import { buildDetailTextures, DETAIL_LAYER_COUNT, DETAIL_SIZE } from '../../../src/a10/view/terrain/detailTextures';
import { DETAIL, rowIndex } from '../../../src/a10/view/terrain/palette';
import {
  KIND,
  buildTile,
  prepareFeatures,
  type TileSpec,
} from '../../../src/a10/view/terrain/tileBuilder';
import { TREE_STRIDE, buildTreeCell } from '../../../src/a10/view/terrain/treeCells';
import { createCloudLayout } from '../../../src/engine';

/** A host where every node is ready at once (the selection's steady state). */
function readyHost() {
  const nodes = new Map<number, LodNode>();
  return {
    nodes,
    node(level: number, ix: number, iz: number) {
      const key = nodeKey(level, ix, iz);
      let n = nodes.get(key);
      if (!n) {
        n = { key, level, ix, iz, minY: 0, maxY: 300, ready: true };
        nodes.set(key, n);
      }
      return n;
    },
    request() {},
  };
}

function spec(level: number, ix: number, iz: number, extra: Partial<TileSpec> = {}): TileSpec {
  return {
    key: nodeKey(level, ix, iz),
    level,
    x0: nodeOrigin(level, ix),
    z0: nodeOrigin(level, iz),
    size: nodeSize(level),
    quads: TILE_QUADS,
    texels: 32,
    roads: true,
    tracks: true,
    rivers: true,
    paved: true,
    canopy: true,
    ...extra,
  };
}

describe('terrain level of detail', () => {
  it('covers the ground once, fine near a low aircraft and coarse far away', () => {
    const host = readyHost();
    const out: LodNode[] = [];
    selectTiles(host, 1000, 450, -2000, 1, out, 34000);
    // no overlaps: the selected squares' areas add up to the covered area, no node contains another
    const keys = new Set(out.map((n) => n.key));
    for (const n of out) {
      let lv = n.level;
      let ix = n.ix;
      let iz = n.iz;
      while (lv > 0) {
        lv--;
        ix >>= 1;
        iz >>= 1;
        expect(keys.has(nodeKey(lv, ix, iz))).toBe(false);
      }
    }
    // the tile under the aircraft is the finest level of the preset (8 m on medium)
    const under = out.find((n) => {
      const s = nodeSize(n.level);
      const x0 = nodeOrigin(n.level, n.ix);
      const z0 = nodeOrigin(n.level, n.iz);
      return 1000 >= x0 && 1000 < x0 + s && -2000 >= z0 && -2000 < z0 + s;
    })!;
    expect(under.level).toBe(MAX_LEVEL_BY_DETAIL[1]);
    expect(vertexSpacing(under.level)).toBeLessThanOrEqual(8);
    // a ring of the same angular size per level: a bounded number of tiles in all
    expect(out.length).toBeLessThan(240);
  });

  it('draws nothing finer than 32 m from 3,000 m up', () => {
    const host = readyHost();
    const out: LodNode[] = [];
    selectTiles(host, 0, 3300, 0, 1, out);
    for (const n of out) expect(vertexSpacing(n.level)).toBeGreaterThanOrEqual(32);
  });

  it('keeps a coarse tile until all four children exist (no holes)', () => {
    const nodes = new Map<number, LodNode>();
    const requested: number[] = [];
    const host = {
      node(level: number, ix: number, iz: number) {
        const key = nodeKey(level, ix, iz);
        let n = nodes.get(key);
        if (!n) {
          n = { key, level, ix, iz, minY: 0, maxY: 300, ready: level <= 3 };
          nodes.set(key, n);
        }
        return n;
      },
      request(n: LodNode) {
        requested.push(n.level);
      },
    };
    const out: LodNode[] = [];
    selectTiles(host, 0, 300, 0, 1, out);
    expect(out.length).toBeGreaterThan(0);
    for (const n of out) expect(n.ready).toBe(true);
    // the covered area is the whole root
    const area = out.reduce((s, n) => s + nodeSize(n.level) ** 2, 0);
    expect(area).toBeCloseTo(ROOT_SIZE * ROOT_SIZE, -3);
    expect(Math.min(...requested)).toBe(4);
  });
});

describe('terrain tiles', () => {
  const terrain = createTerrain(generateTerrainData(7));

  it('puts every ground vertex on heightAt (one height function), local to the tile', () => {
    const level = 8;
    const ix = 128;
    const iz = 131;
    const t = buildTile(terrain, spec(level, ix, iz), null);
    const n = TILE_QUADS;
    const s = vertexSpacing(level);
    const x0 = nodeOrigin(level, ix);
    const z0 = nodeOrigin(level, iz);
    for (const [i, j] of [
      [0, 0],
      [n, n],
      [17, 25],
      [n, 3],
    ]) {
      const v = j * (n + 1) + i;
      const x = t.position[v * 3] + t.ox;
      const y = t.position[v * 3 + 1] + t.oy;
      const z = t.position[v * 3 + 2] + t.oz;
      expect(x).toBeCloseTo(x0 + i * s, 3);
      expect(z).toBeCloseTo(z0 + j * s, 3);
      expect(y).toBeCloseTo(terrain.heightAt(x, z), 3);
      expect(t.info[v * 4]).toBe(KIND.ground);
      // even vertices have no geomorph
      if (i % 2 === 0 && j % 2 === 0) expect(t.morph[v]).toBe(0);
    }
    // local data: small numbers
    for (let k = 0; k < t.vertexCount * 3; k++) expect(Math.abs(t.position[k])).toBeLessThan(4000);
    expect(t.minY).toBeLessThanOrEqual(t.maxY);
  });

  it('winds every ground and ribbon triangle facing up, skirts facing out', () => {
    const roads: RoadPolyline[] = [
      { id: 0, kind: 'road', width: 7, points: new Float64Array([-300, -40, 300, 40]) },
    ];
    const withRoad: Terrain = { ...createFlatTerrain(100), roads };
    const t = buildTile(withRoad, spec(9, 256, 256), prepareFeatures(withRoad));
    const p = t.position;
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    let ribbons = 0;
    for (let k = 0; k < t.index.length; k += 3) {
      const i0 = t.index[k];
      const i1 = t.index[k + 1];
      const i2 = t.index[k + 2];
      const kind = t.info[i0 * 4];
      // a triangle's kind: all three corners agree (skirts start on ground vertices)
      if (t.info[i1 * 4] !== kind || t.info[i2 * 4] !== kind) continue;
      a.fromArray(p, i0 * 3);
      b.fromArray(p, i1 * 3);
      c.fromArray(p, i2 * 3);
      const nrm = b.clone().sub(a).cross(c.clone().sub(a));
      if (kind === KIND.ground || kind === KIND.road) expect(nrm.y).toBeGreaterThan(0);
      if (kind === KIND.road) ribbons++;
    }
    expect(ribbons).toBeGreaterThan(0);
    // ribbons lie on the (flat) ground, a few centimetres up
    for (let v = 0; v < t.vertexCount; v++) {
      if (t.info[v * 4] !== KIND.road) continue;
      expect(p[v * 3 + 1] + t.oy - 100).toBeGreaterThan(0);
      expect(p[v * 3 + 1] + t.oy - 100).toBeLessThan(0.3);
    }
  });

  it('builds a canopy shell with walls where canopyAt says trees', () => {
    const forest: Terrain = {
      ...createFlatTerrain(50),
      canopyAt: (x: number, z: number) => (Math.hypot(x - 64, z - 64) < 70 ? 18 : 0),
    };
    const t = buildTile(forest, spec(9, 256, 256), null);
    let top = 0;
    let wall = 0;
    for (let v = 0; v < t.vertexCount; v++) {
      if (t.info[v * 4] === KIND.canopy) top++;
      if (t.info[v * 4] === KIND.canopyWall) wall++;
    }
    expect(top).toBeGreaterThan(50);
    expect(wall).toBeGreaterThan(20);
    expect(t.maxY).toBeGreaterThan(50 + 14);
    // walls join neighbouring outline points only (no long slivers across the stand)
    const s = vertexSpacing(9);
    for (let k = 0; k < t.index.length; k += 3) {
      const ids = [t.index[k], t.index[k + 1], t.index[k + 2]];
      if (!ids.every((i) => t.info[i * 4] === KIND.canopyWall)) continue;
      for (const [a, b] of [
        [ids[0], ids[1]],
        [ids[1], ids[2]],
        [ids[0], ids[2]],
      ]) {
        const dx = t.position[a * 3] - t.position[b * 3];
        const dz = t.position[a * 3 + 2] - t.position[b * 3 + 2];
        expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(s * 1.5);
      }
    }
  });

  it('bakes a texture with a class in every texel', () => {
    const t = buildTile(terrain, spec(7, 64, 64), null);
    expect(t.texture.length).toBe((t.texels + 1) ** 2 * 4);
    for (let k = 3; k < t.texture.length; k += 4) expect(t.texture[k] & 7).toBeLessThan(8);
    expect(rowIndex(0)).toBe(0);
    expect(rowIndex(Math.PI / 2)).toBe(16);
    expect(DETAIL.paved).toBe(6);
  });
});

describe('trees and textures', () => {
  it('plants trees only under canopy, sorted by rank', () => {
    const forest: Terrain = {
      ...createFlatTerrain(80),
      canopyAt: (x: number) => (x < 100 ? 16 : 0),
    };
    const cell = buildTreeCell(forest, { key: 1, x0: 0, z0: 0, size: 256, seed: 3 });
    expect(cell.count).toBeGreaterThan(50);
    for (let k = 0; k < cell.count; k++) {
      expect(cell.data[k * TREE_STRIDE]).toBeLessThan(100);
      expect(cell.data[k * TREE_STRIDE + 1]).toBe(80);
      if (k > 0) expect(cell.data[k * TREE_STRIDE + 7]).toBeGreaterThanOrEqual(cell.data[(k - 1) * TREE_STRIDE + 7]);
    }
    // deterministic
    const again = buildTreeCell(forest, { key: 1, x0: 0, z0: 0, size: 256, seed: 3 });
    expect(Array.from(again.data)).toEqual(Array.from(cell.data));
  });

  it('generates detail layers whose mean is neutral grey', () => {
    const data = buildDetailTextures();
    expect(data.length).toBe(DETAIL_LAYER_COUNT * DETAIL_SIZE * DETAIL_SIZE * 4);
    const n = DETAIL_SIZE * DETAIL_SIZE;
    for (let layer = 0; layer < DETAIL_LAYER_COUNT; layer++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += data[(layer * n + i) * 4 + 1];
      expect(sum / n).toBeGreaterThan(120);
      expect(sum / n).toBeLessThan(136);
    }
  });

  it('rasterises cloud shadows from the cloud layout', () => {
    const layout = createCloudLayout(16, 1, {
      baseMin: 1500,
      baseMax: 2300,
      topMax: 3700,
      spacing: 4000,
      radiusMin: 400,
      radiusMax: 950,
    });
    const tex = rasterCloudShadow(layout, 64);
    const covered = tex.reduce((s, v) => s + (v > 0 ? 1 : 0), 0) / tex.length;
    expect(covered).toBeGreaterThan(0.03);
    expect(covered).toBeLessThan(0.5);
  });
});

describe('haze law', () => {
  it('follows visibility and thins with height above the valley floor', () => {
    const low = hazeDensityFor(30, 0);
    const high = hazeDensityFor(30, 3000);
    expect(high).toBeLessThan(low);
    // 2 % contrast left at the visibility distance near the ground
    expect(1 - hazeFactor(low, 30000)).toBeCloseTo(0.02, 3);
    // from 3,000 m the range fades out at 40–60 km
    const fadeOut = hazeDistanceFor(high, 0.02);
    expect(fadeOut).toBeGreaterThan(40000);
    expect(fadeOut).toBeLessThan(60000);
    expect(hazeAmount(80)).toBe(0);
    expect(hazeAmount(5)).toBe(1);
  });
});
