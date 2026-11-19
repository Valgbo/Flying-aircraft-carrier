/**
 * Terrain level of detail for a sensor's picture (the targeting pod, a Maverick seeker). The
 * outside view selects its tiles around the world camera; a sensor 8 km out that magnifies 16
 * times needs the ground at its look point as fine as the outside view shows it at 500 m — on
 * Low a point 8 km out is otherwise a 256 m tile, and road ribbons need 128 m or finer. So a
 * sensor gets its own selection (lod.ts selectFocusTiles: the outside view's rule at 1/scale of
 * the distance, inside its picture's pyramid), shown only around its own render
 * (terrainFocus.ts → TerrainSystem.beginFocus/endFocus); the outside view's tiles stay exactly
 * as they were.
 */
import { PerspectiveCamera, Vector3, type WebGLRenderer } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { MAVERICK, TGP } from '../../../src/a10/data/sensors';
import { A10_QUALITY } from '../../../src/a10/view/quality';
import {
  pictureEffectivePixels,
  pictureMagnification,
} from '../../../src/a10/view/sensors/sensorPose';
import { SENSOR_OPTICS, SENSOR_RENDER } from '../../../src/a10/view/sensors/sensorViewData';
import { DETAIL_LAYER_COUNT, DETAIL_SIZE } from '../../../src/a10/view/terrain/detailTextures';
import {
  MAX_LEVEL_BY_DETAIL,
  createLodFocus,
  nodeKey,
  nodeOrigin,
  nodeSize,
  selectFocusTiles,
  selectTiles,
  vertexSpacing,
  type LodFocus,
  type LodNode,
} from '../../../src/a10/view/terrain/lod';
import {
  beginTerrainFocus,
  endTerrainFocus,
  getTerrainFocusTarget,
} from '../../../src/a10/view/terrain/terrainFocus';
import {
  createTerrainMaterial,
  terrainUniforms,
} from '../../../src/a10/view/terrain/terrainMaterial';
import type { WorkerReply, WorkerRequest } from '../../../src/a10/view/terrain/terrainProtocol';
import { terrainStreaming } from '../../../src/a10/view/terrain/terrainStats';
import { TerrainSystem } from '../../../src/a10/view/terrain/terrainSystem';
import type { TileData, TileSpec } from '../../../src/a10/view/terrain/tileBuilder';
import { buildTreeCell } from '../../../src/a10/view/terrain/treeCells';

const DEG = Math.PI / 180;

/** Every node exists and is built, ground between 0 and 300 m (the selection's steady state). */
function host(readyLevel = 99) {
  const nodes = new Map<number, LodNode>();
  const requests: { node: LodNode; distance: number }[] = [];
  return {
    nodes,
    requests,
    node(level: number, ix: number, iz: number) {
      const key = nodeKey(level, ix, iz);
      let n = nodes.get(key);
      if (!n) {
        n = { key, level, ix, iz, minY: 0, maxY: 300, ready: level <= readyLevel };
        nodes.set(key, n);
      }
      return n;
    },
    request(node: LodNode, distance: number) {
      requests.push({ node, distance });
    },
  };
}

/** FNV-1a over the decimal keys: a fingerprint of a selection. */
function fingerprint(keys: number[]): number {
  let h = 0x811c9dc5;
  for (const k of keys) {
    const s = String(k);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 44;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function contains(n: LodNode, x: number, z: number): boolean {
  const s = nodeSize(n.level);
  const x0 = nodeOrigin(n.level, n.ix);
  const z0 = nodeOrigin(n.level, n.iz);
  return x >= x0 && x < x0 + s && z >= z0 && z < z0 + s;
}

/** Whether a node's box (ground 0–300 m) lies wholly outside one side of the picture's pyramid. */
function outsidePicture(n: LodNode, f: LodFocus): boolean {
  const s = nodeSize(n.level);
  const x0 = nodeOrigin(n.level, n.ix);
  const z0 = nodeOrigin(n.level, n.iz);
  const d = new Vector3(f.dx, f.dy, f.dz);
  const r = new Vector3(f.rx, f.ry, f.rz);
  const u = new Vector3(f.ux, f.uy, f.uz);
  const sides = [
    r.clone().addScaledVector(d, f.tanHalf),
    r.clone().negate().addScaledVector(d, f.tanHalf),
    u.clone().addScaledVector(d, f.tanHalf),
    u.clone().negate().addScaledVector(d, f.tanHalf),
  ];
  return sides.some((nrm) => {
    for (const x of [x0, x0 + s])
      for (const y of [0, 300])
        for (const z of [z0, z0 + s])
          if (nrm.dot(new Vector3(x - f.x, y - f.y, z - f.z)) >= 0) return false;
    return true;
  });
}

/** A sensor at `from` looking at `at` with a square picture of `fov`, magnifying `scale` times. */
function focus(from: Vector3, at: Vector3, fov: number, scale: number): LodFocus {
  const f = createLodFocus();
  const d = at.clone().sub(from).normalize();
  const r = new Vector3().crossVectors(d, new Vector3(0, 1, 0)).normalize();
  const u = new Vector3().crossVectors(r, d);
  f.x = from.x;
  f.y = from.y;
  f.z = from.z;
  f.dx = d.x;
  f.dy = d.y;
  f.dz = d.z;
  f.rx = r.x;
  f.ry = r.y;
  f.rz = r.z;
  f.ux = u.x;
  f.uy = u.y;
  f.uz = u.z;
  f.tanHalf = Math.tan(fov / 2);
  f.scale = scale;
  return f;
}

/**
 * The real pictures on a preset (picture size `size`): the pod's NARROW ×1/×2/×8 and WIDE ×1/×2
 * and the Maverick's NARROW/WIDE, each with its field and its magnification over a 720-line
 * outside view at 50° (sensorPose.ts, the renderer's own formulas).
 */
function realPictures(size: number): { name: string; fov: number; scale: number }[] {
  const out: { name: string; fov: number; scale: number }[] = [];
  const pod = (name: string, field: number, zoom: number) => {
    const fov = field / zoom;
    const n = pictureEffectivePixels(
      size,
      fov,
      zoom,
      TGP.imagePixels,
      SENSOR_OPTICS.podFlirWavelengthUm,
      SENSOR_OPTICS.podApertureM,
    );
    out.push({ name, fov, scale: Math.min(16, pictureMagnification(50, 720, fov, n)) });
  };
  pod('pod NARROW ×1', TGP.fovNarrow, 1);
  pod('pod NARROW ×2', TGP.fovNarrow, 2);
  pod('pod NARROW ×8', TGP.fovNarrow, 8);
  pod('pod WIDE ×1', TGP.fovWide, 1);
  pod('pod WIDE ×2', TGP.fovWide, 2);
  for (const [name, fov] of [
    ['Maverick NARROW', MAVERICK.fovNarrow],
    ['Maverick WIDE', MAVERICK.fovWide],
  ] as const) {
    const s = Math.round((size * SENSOR_RENDER.maverickScale) / 16) * 16;
    const n = pictureEffectivePixels(
      s,
      fov,
      1,
      MAVERICK.imagePixels,
      SENSOR_OPTICS.maverickIrWavelengthUm,
      SENSOR_OPTICS.maverickApertureM,
    );
    out.push({ name, fov, scale: Math.min(16, pictureMagnification(50, 720, fov, n)) });
  }
  return out;
}

/** Points of the ground plane y = `ground` the picture sees (a grid of rays inside it). */
function pictureGround(from: Vector3, at: Vector3, fov: number, ground: number, steps = 24) {
  const d = at.clone().sub(from).normalize();
  const right = new Vector3().crossVectors(d, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, d);
  const t = Math.tan(fov / 2);
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const u = (i / steps) * 2 - 1;
      const v = (j / steps) * 2 - 1;
      const r = d
        .clone()
        .addScaledVector(right, u * t)
        .addScaledVector(up, v * t)
        .normalize();
      if (r.y >= -1e-6) continue;
      const s = (ground - from.y) / r.y;
      out.push([from.x + r.x * s, from.z + r.z * s]);
    }
  }
  return out;
}

// The targeting pod 8 km from its look point (3,000 m up, 21° down): from here the outside
// view's selection draws the look point in a level-4 tile on Low (256 m between vertices: no
// roads) and level 5 on Medium (128 m: roads).
const POD = new Vector3(14956, 3000, -3000);
const LOOK = new Vector3(7500, 150, -3000);
/** NARROW ×2 (0.5°) and WIDE ×1 (4°). */
const NARROW2 = 0.5 * DEG;
const WIDE = 4 * DEG;

describe('terrain level of detail for a sensor picture', () => {
  it('leaves the outside view’s selection exactly as it was (golden fingerprints)', () => {
    // fingerprints of the selection before sensor pictures had their own (count, FNV-1a of the
    // sorted keys, and of the requests a partly built quadtree makes)
    const golden: [number, number, number, number, number | undefined, number, number, number][] = [
      [1000, 450, -2000, 0, 34000, 99, 139, 3330742753],
      [1000, 450, -2000, 1, 34000, 99, 226, 2244849874],
      [1000, 450, -2000, 2, 34000, 99, 298, 801829193],
      [0, 3300, 0, 0, undefined, 99, 64, 1922687916],
      [0, 3300, 0, 1, undefined, 99, 64, 1922687916],
      [5000, 1200, 8000, 0, 30000, 99, 113, 4141110621],
      [-20000, 3000, 15000, 1, 20000, 99, 80, 2311520132],
      [0, 300, 0, 1, undefined, 5, 76, 166763571],
    ];
    for (const [x, y, z, detail, max, ready, count, hash] of golden) {
      const h = host(ready);
      const out: LodNode[] = [];
      // a sensor's selection in between must not disturb the outside view's
      selectFocusTiles(host(), focus(POD, LOOK, NARROW2, 16), 0, [], 30000);
      selectTiles(h, x, y, z, detail, out, max);
      const keys = out.map((n) => n.key).sort((a, b) => a - b);
      expect([keys.length, fingerprint(keys)]).toEqual([count, hash]);
      if (ready === 5) {
        const req = [...new Set(h.requests.map((r) => r.node.key))].sort((a, b) => a - b);
        expect([req.length, fingerprint(req)]).toEqual([48, 3522124441]);
      }
    }
  });

  it('refines the pod’s look point 8 km out to the road level on Low (≤ 128 m)', () => {
    const main: LodNode[] = [];
    selectTiles(host(), POD.x, POD.y, POD.z, 0, main);
    const mainAt = main.find((n) => contains(n, LOOK.x, LOOK.z))!;
    // the problem: the outside view's tile there has no road ribbons (roads need ≤ 128 m)
    expect(vertexSpacing(mainAt.level)).toBe(256);
    for (const [fov, scale] of [
      [NARROW2, 16],
      [WIDE, 4.75],
    ]) {
      const out: LodNode[] = [];
      selectFocusTiles(host(), focus(POD, LOOK, fov, scale), 0, out);
      const at = out.find((n) => contains(n, LOOK.x, LOOK.z));
      expect(at, `fov ${fov / DEG}°`).toBeDefined();
      expect(vertexSpacing(at!.level)).toBeLessThanOrEqual(128);
    }
    // magnified 16 times, the look point is as fine as the preset goes (16 m on Low)
    const narrow: LodNode[] = [];
    selectFocusTiles(host(), focus(POD, LOOK, NARROW2, 16), 0, narrow);
    expect(narrow.find((n) => contains(n, LOOK.x, LOOK.z))!.level).toBe(MAX_LEVEL_BY_DETAIL[0]);
    // without magnification nothing changes: the outside view's level
    const plain: LodNode[] = [];
    selectFocusTiles(host(), focus(POD, LOOK, NARROW2, 1), 0, plain);
    expect(plain.find((n) => contains(n, LOOK.x, LOOK.z))!.level).toBe(mainAt.level);
  });

  it('covers the whole picture once, with a handful of tiles (every preset and picture)', () => {
    const presets = [A10_QUALITY.low, A10_QUALITY.medium, A10_QUALITY.high];
    for (const preset of presets) {
      const detail = preset.terrainDetail;
      for (const { name, fov, scale } of realPictures(preset.sensorResolution)) {
        const out: LodNode[] = [];
        selectFocusTiles(host(), focus(POD, LOOK, fov, scale), detail, out);
        // no overlaps: no selected node contains another
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
        // no holes: every ground point the picture sees (top and bottom of the ground's
        // bounds) lies in exactly one selected tile
        for (const ground of [0, 300]) {
          for (const [x, z] of pictureGround(POD, LOOK, fov, ground)) {
            const n = out.filter((t) => contains(t, x, z)).length;
            expect(n, `${name}: ${x.toFixed(0)}, ${z.toFixed(0)} on ${preset.level}`).toBe(1);
          }
        }
        // a sensor-sized footprint: far fewer tiles than the outside view's from here (79 on
        // Low, 115 on Medium); at least as fine at the look point as the outside view's
        expect(out.length, `${name} on ${preset.level}`).toBeLessThanOrEqual(24);
        const main: LodNode[] = [];
        selectTiles(host(), POD.x, POD.y, POD.z, detail, main);
        expect(out.find((t) => contains(t, LOOK.x, LOOK.z))!.level).toBeGreaterThanOrEqual(
          main.find((t) => contains(t, LOOK.x, LOOK.z))!.level,
        );
      }
    }
  });

  it('asks for the missing tiles of the picture with their magnified distances, and none outside it', () => {
    const h = host(5); // built down to 128 m
    const out: LodNode[] = [];
    const f = focus(POD, LOOK, NARROW2, 16);
    selectFocusTiles(h, f, 0, out);
    // until the finer tiles are built, the 128 m tile is drawn (coarser for a moment, no hole)
    expect(out.find((n) => contains(n, LOOK.x, LOOK.z))!.level).toBe(5);
    const look = h.requests.find((r) => r.node.level === 6 && contains(r.node, LOOK.x, LOOK.z));
    expect(look).toBeDefined();
    // the distance it is wanted at is the magnified one (the selection's priority)
    const n = look!.node;
    const s = nodeSize(n.level);
    const x0 = nodeOrigin(n.level, n.ix);
    const z0 = nodeOrigin(n.level, n.iz);
    const dx = Math.max(x0 - POD.x, 0, POD.x - x0 - s);
    const dz = Math.max(z0 - POD.z, 0, POD.z - z0 - s);
    const dy = POD.y - 300;
    expect(look!.distance).toBeCloseTo(Math.hypot(dx, dy, dz) / 16, 6);
    // nothing outside the picture is wanted (nor drawn)
    for (const r of h.requests) expect(outsidePicture(r.node, f)).toBe(false);
    for (const n of out) expect(outsidePicture(n, f)).toBe(false);
    expect(h.requests.every((r) => r.node.level === 6)).toBe(true);
  });

  it('is the outside view’s selection when it neither magnifies nor narrows', () => {
    // a picture of nearly 180° straight down holds the whole ground below the camera
    const f = focus(POD, new Vector3(POD.x, 0, POD.z - 1e-3), NARROW2, 1);
    f.tanHalf = 1e6;
    for (const detail of [0, 1, 2]) {
      const a: LodNode[] = [];
      const b: LodNode[] = [];
      selectTiles(host(), POD.x, POD.y, POD.z, detail, a, 40000);
      selectFocusTiles(host(), f, detail, b, 40000);
      expect(b.map((n) => n.key).sort((x, y) => x - y)).toEqual(
        a.map((n) => n.key).sort((x, y) => x - y),
      );
    }
  });
});

// ---- the terrain system: the sensor's tiles are shown only around its own render ----

/**
 * A stand-in for the terrain workers: answers as terrainWorker.ts does, with tiles of the right
 * key, bounds and triangle count but almost no geometry (what is tested is the selection, the
 * requests and the meshes' visibility, not the build).
 */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: WorkerReply }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  private readonly queue: WorkerRequest[] = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: WorkerRequest): void {
    this.queue.push(m);
  }
  terminate(): void {}
  flush(): void {
    for (const m of this.queue.splice(0)) {
      const reply = answer(m);
      if (reply) this.onmessage?.({ data: reply });
    }
  }
}

const flat = createFlatTerrain(0);

function fakeTile(spec: TileSpec): TileData {
  return {
    key: spec.key,
    ox: spec.x0 + spec.size / 2,
    oy: 0,
    oz: spec.z0 + spec.size / 2,
    minY: 0,
    maxY: 0,
    vertexCount: 3,
    triangleCount: 2 * spec.quads * spec.quads,
    position: new Float32Array(9),
    normal: new Int8Array(12),
    morph: new Float32Array(3),
    info: new Uint8Array(12),
    ribbon: new Float32Array(6),
    side: new Float32Array(9),
    index: new Uint16Array([0, 1, 2]),
    texels: 1,
    texture: new Uint8Array(16),
  };
}

function answer(m: WorkerRequest): WorkerReply | null {
  switch (m.type) {
    case 'init':
      return { type: 'ready' };
    case 'detail':
      return {
        type: 'detail',
        data: new Uint8Array(DETAIL_SIZE * DETAIL_SIZE * DETAIL_LAYER_COUNT * 4),
      };
    case 'tile':
      return { type: 'tile', id: m.id, tile: fakeTile(m.spec), ms: 1 };
    case 'trees':
      return { type: 'trees', id: m.id, cell: buildTreeCell(flat, m.spec) };
  }
}

/** Names of the tile meshes drawn right now. */
function visibleTiles(sys: TerrainSystem): string[] {
  return sys.group.children
    .filter((o) => o.visible && o.name.startsWith('TerrainTile'))
    .map((o) => o.name)
    .sort();
}

/** Level of the drawn tile containing (x, z), from its mesh name ("TerrainTile L<l> ix,iz"). */
function drawnLevelAt(sys: TerrainSystem, x: number, z: number): number {
  for (const o of sys.group.children) {
    if (!o.visible || !o.name.startsWith('TerrainTile')) continue;
    const m = /L(\d+) (\d+),(\d+)/.exec(o.name)!;
    const n = { level: +m[1], ix: +m[2], iz: +m[3] } as LodNode;
    if (contains(n, x, z)) return n.level;
  }
  return -1;
}

describe('terrain system: a sensor picture’s own tiles', () => {
  let sys: TerrainSystem;
  const camera = new PerspectiveCamera(50, 16 / 9, 1, 90000);
  const settings = { detail: 0, treeCount: 0, treeDistance: 0 };

  function frame(): void {
    sys.update(camera, settings);
    for (const w of FakeWorker.all) w.flush();
  }

  beforeEach(() => {
    FakeWorker.all = [];
    vi.stubGlobal('Worker', FakeWorker);
    const gl = { capabilities: { getMaxAnisotropy: () => 1 } } as unknown as WebGLRenderer;
    sys = new TerrainSystem(flat, gl, 0);
    for (const w of FakeWorker.all) w.flush();
    camera.position.copy(POD);
    camera.lookAt(LOOK);
    camera.updateMatrixWorld();
    // the outside view settles: every tile it wants is built
    for (let i = 0; i < 400 && (i < 5 || terrainStreaming.pending > 0); i++) frame();
    frame();
  });

  afterEach(() => {
    sys.dispose();
    vi.unstubAllGlobals();
  });

  it('registers as the focus target and lets go on dispose', () => {
    expect(getTerrainFocusTarget()).toBe(sys);
    sys.dispose(); // (afterEach disposes again: idempotent)
    expect(getTerrainFocusTarget()).toBe(null);
    expect(beginTerrainFocus(focus(POD, LOOK, NARROW2, 16))).toBe(false);
    endTerrainFocus(); // harmless without a target
  });

  it('draws the sensor’s selection around its render, then the outside view’s exactly as before', () => {
    const before = visibleTiles(sys);
    const drawn = terrainStreaming.drawn;
    const triangles = terrainStreaming.triangles;
    expect(drawnLevelAt(sys, LOOK.x, LOOK.z)).toBe(4);
    const f = focus(POD, LOOK, NARROW2, 16);

    // the sensor renders every 4th frame (15 Hz on Low at 60 fps); its tiles stream in
    let finest = -1;
    for (let i = 0; i < 400 && finest !== MAX_LEVEL_BY_DETAIL[0]; i++) {
      if (i % 4 === 0) {
        expect(beginTerrainFocus(f)).toBe(true);
        finest = drawnLevelAt(sys, LOOK.x, LOOK.z);
        // the geomorph counts distances as the selection does
        expect(terrainUniforms.uLodScale.value).toBe(16);
        endTerrainFocus();
        expect(terrainUniforms.uLodScale.value).toBe(1);
        expect(visibleTiles(sys)).toEqual(before);
      }
      frame();
    }
    // the look point at the finest level of the preset in the sensor's picture...
    expect(finest).toBe(MAX_LEVEL_BY_DETAIL[0]);
    expect(beginTerrainFocus(f)).toBe(true);
    const inPicture = visibleTiles(sys);
    expect(inPicture.length).toBeGreaterThan(0);
    expect(inPicture.length).toBeLessThanOrEqual(24);
    expect(terrainStreaming.focusTiles).toBe(inPicture.length);
    expect(terrainStreaming.focusTriangles).toBe(inPicture.length * 2 * 32 * 32);
    endTerrainFocus();
    // ...while the outside view draws what it drew before, tile for tile
    frame();
    expect(visibleTiles(sys)).toEqual(before);
    expect(terrainStreaming.drawn).toBe(drawn);
    expect(terrainStreaming.triangles).toBe(triangles);
    expect(drawnLevelAt(sys, LOOK.x, LOOK.z)).toBe(4);
  });

  it('keeps the sensor’s tiles while it shows, and forgets its requests once it stops', () => {
    const f = focus(POD, LOOK, NARROW2, 16);
    const tiles0 = terrainStreaming.tiles;
    beginTerrainFocus(f);
    endTerrainFocus();
    // one picture is enough for its tiles to be requested and built over the next frames
    for (let i = 0; i < 6; i++) frame();
    expect(terrainStreaming.tiles).toBeGreaterThan(tiles0);
    // a long time without a picture: nothing more is asked for it
    for (let i = 0; i < 120; i++) frame();
    const tiles = terrainStreaming.tiles;
    for (let i = 0; i < 30; i++) frame();
    expect(terrainStreaming.pending).toBe(0);
    expect(terrainStreaming.tiles).toBe(tiles);
  });
});

/** The vertex shader morphs by the distance the selection used. */
describe('terrain geomorph for a magnifying camera', () => {
  it('counts distances 1/uLodScale (1 in the outside view)', () => {
    const m = createTerrainMaterial();
    expect(m.uniforms.uLodScale.value).toBe(1);
    expect(m.vertexShader).toMatch(/\(d \/ uLodScale - uTile\.z\)/);
    m.dispose();
  });
});
