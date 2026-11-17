/**
 * The terrain view's engine (main thread, no React): owns the workers, the quadtree's nodes,
 * the tile meshes and the trees, and does the per-frame work —
 *
 *   1. select the tiles for the camera (lod.ts) and show exactly those;
 *   2. request missing tiles and tree cells from the workers (coarse and near first; a few in
 *      flight per worker so a stale request never blocks a needed one for long);
 *   3. turn finished builds into meshes within a time budget per frame (no hitches);
 *   4. drop tiles not used for a while beyond a memory budget (geometry, texture, material
 *      disposed);
 *   5. copy the environment (a10Env) into the shared shader uniforms.
 */
import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataTexture,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Sphere,
  UnsignedByteType,
  Vector3,
  Vector4,
  type Camera,
  type ShaderMaterial,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { CloudLayout } from '../../../engine';
import type { Terrain } from '../../core/world/types';
import { a10Env } from '../environment/env';
import { a10Lights, cloudShadowSource, envClock, envFrame } from '../environment/envState';
import { cloudShadowHeight, createCloudShadowTexture } from './cloudShadow';
import {
  TILE_QUADS,
  morphRange,
  nodeKey,
  nodeOrigin,
  nodeSize,
  selectTiles,
  vertexSpacing,
  type LodNode,
  type LodSelectionHost,
} from './lod';
import { bindTile, createTerrainMaterial, terrainUniforms } from './terrainMaterial';
import type { WorkerReply, WorkerRequest } from './terrainProtocol';
import { terrainStreaming } from './terrainStats';
import { createTerrain } from '../../core/world';
import { DETAIL_LAYER_COUNT, DETAIL_SIZE, buildDetailTextures } from './detailTextures';
import { buildTile, prepareFeatures, type FeatureIndex, type TileData, type TileSpec } from './tileBuilder';
import { buildTreeCell, type TreeCellSpec } from './treeCells';
import { TreeLayer } from './treeLayer';

/**
 * Texture texels per tile edge (the texture has one more sample per edge): 256 on tiles of
 * 2 km and more (crisp fields seen from altitude), 128 on the small near tiles (close-range
 * detail textures carry those).
 */
export function tileTexels(level: number): number {
  const size = nodeSize(level);
  // 2 m texels near the aircraft, 8 m on the tiles seen from 3,000 m, coarser beyond
  return size <= 256 ? 128 : size <= 2048 ? 256 : 128;
}
/** Tiles kept in memory at most (drawn ones are never dropped). */
const TILE_BUDGET = 260;
/** Requests in flight per worker. */
const IN_FLIGHT_PER_WORKER = 2;
/** Main-thread time per frame for turning finished builds into meshes, ms, and at most tiles. */
const UPLOAD_BUDGET_MS = 2;
const UPLOADS_PER_FRAME = 3;

interface TileMesh {
  mesh: Mesh<BufferGeometry, ShaderMaterial>;
  texture: Texture;
  tileParams: Vector4;
  triangles: number;
}

interface TerrainNode extends LodNode {
  tile: TileMesh | null;
  pending: boolean;
  wantedAt: number;
  requestDistance: number;
  lastDrawn: number;
}

interface WorkerSlot {
  worker: Worker;
  ready: boolean;
  failed: boolean;
  inFlight: number;
}

type Job =
  | { kind: 'tile'; node: TerrainNode; priority: number }
  | { kind: 'trees'; spec: TreeCellSpec; priority: number };

const _camera = new Vector3();
const _range: [number, number] = [0, 0];

export interface TerrainFrameSettings {
  detail: number;
  treeCount: number;
  treeDistance: number;
}

export class TerrainSystem implements LodSelectionHost<TerrainNode> {
  readonly group = new Group();
  readonly trees: TreeLayer;
  private readonly nodes = new Map<number, TerrainNode>();
  private readonly workers: WorkerSlot[] = [];
  private readonly selected: TerrainNode[] = [];
  private previous: TerrainNode[] = [];
  private readonly wanted: TerrainNode[] = [];
  private readonly arrived: TileData[] = [];
  private readonly jobs = new Map<number, Job>();
  private nextJob = 1;
  private treesThisFrame = 0;
  private frame = 0;
  private tileCount = 0;
  private detail = -1;
  private detailTexture: DataArrayTexture | null = null;
  private cloudTexture: DataTexture | null = null;
  private cloudLayout: CloudLayout | null = null;
  private disposed = false;
  private readonly anisotropy: number;
  /** The one material every tile draws with. */
  private readonly material: ShaderMaterial = createTerrainMaterial();
  /** Main-thread fallback when no worker could start. */
  private local: { terrain: Terrain; features: FeatureIndex | null } | null = null;

  constructor(
    private readonly terrain: Terrain,
    gl: WebGLRenderer,
    treeCapacity: number,
  ) {
    this.group.name = 'Terrain';
    this.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
    this.trees = new TreeLayer(treeCapacity);
    this.group.add(this.trees.mesh);
    // two workers: enough to keep up at 300 kn on a strafing pass, each holding one terrain
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const count = Math.max(1, Math.min(2, cores - 1));
    for (let i = 0; i < count; i++) this.spawnWorker(i === 0);
  }

  private spawnWorker(withDetail: boolean): void {
    const worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
    const slot: WorkerSlot = { worker, ready: false, failed: false, inFlight: 0 };
    worker.onmessage = (e: MessageEvent<WorkerReply>) => this.onReply(slot, e.data);
    worker.onerror = (e) => {
      console.error('[terrain] worker error', e.message);
      if (!slot.ready) this.failWorker(slot);
    };
    const post = (m: WorkerRequest) => worker.postMessage(m);
    post({ type: 'init', data: this.terrain.data });
    if (withDetail) post({ type: 'detail' });
    this.workers.push(slot);
  }

  private onReply(slot: WorkerSlot, msg: WorkerReply): void {
    if (this.disposed) return;
    switch (msg.type) {
      case 'ready':
        slot.ready = true;
        break;
      case 'detail':
        this.setDetailTexture(msg.data);
        break;
      case 'tile': {
        slot.inFlight--;
        const job = this.jobs.get(msg.id);
        this.jobs.delete(msg.id);
        terrainStreaming.buildMs = terrainStreaming.buildMs * 0.9 + msg.ms * 0.1;
        if (job && job.kind === 'tile') this.arrived.push(msg.tile);
        break;
      }
      case 'trees': {
        slot.inFlight--;
        this.jobs.delete(msg.id);
        this.trees.receive(msg.cell);
        break;
      }
      case 'error': {
        console.error('[terrain] worker:', msg.message);
        if (!slot.ready) {
          this.failWorker(slot);
          break;
        }
        const job = this.jobs.get(msg.id);
        if (job) {
          slot.inFlight--;
          this.jobs.delete(msg.id);
          if (job.kind === 'tile') job.node.pending = false;
          else this.trees.fail(job.spec.key);
        }
        break;
      }
    }
  }

  /** A worker that cannot start: without any, tiles are built here, one per frame. */
  private failWorker(slot: WorkerSlot): void {
    slot.failed = true;
    slot.worker.terminate();
    if (this.workers.every((w) => w.failed) && !this.local) {
      console.warn('[terrain] no worker: building tiles on the main thread');
      this.local = { terrain: createTerrain(this.terrain.data), features: null };
      this.local.features = prepareFeatures(this.local.terrain);
      this.setDetailTexture(buildDetailTextures());
    }
  }

  private setDetailTexture(data: Uint8Array<ArrayBuffer>): void {
    const tex = new DataArrayTexture(data, DETAIL_SIZE, DETAIL_SIZE, DETAIL_LAYER_COUNT);
    tex.format = RGBAFormat;
    tex.type = UnsignedByteType;
    tex.generateMipmaps = true;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.anisotropy = this.anisotropy;
    tex.needsUpdate = true;
    this.detailTexture = tex;
    terrainUniforms.uDetail.value = tex;
  }

  // ---- LodSelectionHost ----

  node(level: number, ix: number, iz: number, parent: TerrainNode | null): TerrainNode {
    const key = nodeKey(level, ix, iz);
    let n = this.nodes.get(key);
    if (!n) {
      n = {
        key,
        level,
        ix,
        iz,
        minY: parent ? parent.minY : this.terrain.minHeight - 10,
        maxY: parent ? parent.maxY : this.terrain.maxHeight + 30,
        ready: false,
        tile: null,
        pending: false,
        wantedAt: -1,
        requestDistance: 0,
        lastDrawn: 0,
      };
      this.nodes.set(key, n);
    }
    return n;
  }

  request(node: TerrainNode, distance: number): void {
    if (node.ready || node.pending) return;
    if (node.wantedAt !== this.frame) {
      node.wantedAt = this.frame;
      node.requestDistance = distance;
      this.wanted.push(node);
    }
  }

  // ---- per frame ----

  /** Drawing-buffer height, px (set by the view). */
  viewHeight = 720;

  update(camera: Camera, settings: TerrainFrameSettings): void {
    if (this.disposed) return;
    const t0 = performance.now();
    this.frame++;
    camera.getWorldPosition(_camera);
    if (settings.detail !== this.detail) this.setDetail(settings.detail);
    this.updateUniforms(camera);

    // 1. selection
    this.wanted.length = 0;
    selectTiles(this, _camera.x, _camera.y, _camera.z, this.detail, this.selected);
    for (const n of this.previous) if (n.tile) n.tile.mesh.visible = false;
    let triangles = 0;
    for (const n of this.selected) {
      n.tile!.mesh.visible = true;
      n.lastDrawn = this.frame;
      triangles += n.tile!.triangles;
    }
    this.previous.length = 0;
    for (const n of this.selected) this.previous.push(n);

    // 2. requests: tiles first (coarse, then near), then tree cells
    this.wanted.sort((a, b) => a.level - b.level || a.requestDistance - b.requestDistance);
    for (const node of this.wanted) {
      if (!this.dispatchTile(node)) break;
    }
    const ground = this.terrain.heightAt(_camera.x, _camera.z);
    this.treesThisFrame = 0;
    this.trees.update(
      _camera.x,
      _camera.z,
      Math.max(0, _camera.y - ground),
      settings.treeCount,
      settings.treeDistance,
      (spec, priority) => this.dispatchTrees(spec, priority),
    );

    // 3. finished builds → meshes, within the time budget
    const u0 = performance.now();
    for (let k = 0; k < UPLOADS_PER_FRAME && this.arrived.length > 0; k++) {
      this.accept(this.arrived.shift()!);
      if (performance.now() - u0 > UPLOAD_BUDGET_MS) break;
    }
    terrainStreaming.uploadMs = performance.now() - u0;

    // 4. memory
    if (this.tileCount > TILE_BUDGET && this.frame % 30 === 0) this.evict();

    terrainStreaming.pending = this.jobs.size + this.arrived.length;
    terrainStreaming.tiles = this.tileCount;
    terrainStreaming.drawn = this.selected.length;
    terrainStreaming.triangles = triangles;
    terrainStreaming.trees = this.trees.instances;
    terrainStreaming.frameMs = terrainStreaming.frameMs * 0.95 + (performance.now() - t0) * 0.05;
  }

  private idleWorker(): WorkerSlot | null {
    let best: WorkerSlot | null = null;
    for (const w of this.workers) {
      if (!w.ready || w.inFlight >= IN_FLIGHT_PER_WORKER) continue;
      if (!best || w.inFlight < best.inFlight) best = w;
    }
    return best;
  }

  private dispatchTile(node: TerrainNode): boolean {
    const slot = this.local ? null : this.idleWorker();
    if (!slot && !this.local) return false;
    if (this.local && this.arrived.length > 0) return false;
    const level = node.level;
    const s = vertexSpacing(level);
    const spec: TileSpec = {
      key: node.key,
      level,
      x0: nodeOrigin(level, node.ix),
      z0: nodeOrigin(level, node.iz),
      size: nodeSize(level),
      quads: TILE_QUADS,
      texels: tileTexels(level),
      roads: s <= 128,
      tracks: s <= 32,
      rivers: s <= 512,
      paved: s <= 256,
      canopy: s <= 64,
    };
    if (!slot) {
      // fallback: one tile per frame on this thread
      node.pending = true;
      this.arrived.push(buildTile(this.local!.terrain, spec, this.local!.features));
      return false;
    }
    const id = this.nextJob++;
    this.jobs.set(id, { kind: 'tile', node, priority: node.requestDistance });
    node.pending = true;
    slot.inFlight++;
    slot.worker.postMessage({ type: 'tile', id, spec } satisfies WorkerRequest);
    return true;
  }

  private dispatchTrees(spec: TreeCellSpec, priority: number): boolean {
    if (this.local) {
      this.trees.receive(buildTreeCell(this.local.terrain, spec));
      void priority;
      return false;
    }
    // tree cells are cheap: they get one extra slot per worker and one dispatch per frame
    if (this.treesThisFrame >= 1) return false;
    let slot: WorkerSlot | null = null;
    for (const w of this.workers) {
      if (!w.ready || w.inFlight > IN_FLIGHT_PER_WORKER) continue;
      if (!slot || w.inFlight < slot.inFlight) slot = w;
    }
    if (!slot) return false;
    this.treesThisFrame++;
    const id = this.nextJob++;
    this.jobs.set(id, { kind: 'trees', spec, priority });
    slot.inFlight++;
    slot.worker.postMessage({ type: 'trees', id, spec } satisfies WorkerRequest);
    return true;
  }

  private accept(tile: TileData): void {
    const node = this.nodes.get(tile.key);
    if (!node || node.tile) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(tile.position, 3));
    geometry.setAttribute('aNormal', new BufferAttribute(tile.normal, 4, true));
    geometry.setAttribute('aMorph', new BufferAttribute(tile.morph, 1));
    geometry.setAttribute('aInfo', new BufferAttribute(tile.info, 4));
    geometry.setAttribute('aRibbon', new BufferAttribute(tile.ribbon, 2));
    geometry.setAttribute('aSide', new BufferAttribute(tile.side, 3));
    geometry.setIndex(new BufferAttribute(tile.index, 1));
    const size = nodeSize(node.level);
    const half = size / 2;
    const midY = (tile.minY + tile.maxY) / 2 - tile.oy;
    geometry.boundingSphere = new Sphere(
      new Vector3(0, midY, 0),
      Math.hypot(half, half, (tile.maxY - tile.minY) / 2 + vertexSpacing(node.level)),
    );

    const t = tile.texels + 1;
    const texture = new DataTexture(tile.texture, t, t, RGBAFormat, UnsignedByteType);
    texture.colorSpace = SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.anisotropy = this.anisotropy;
    texture.needsUpdate = true;

    morphRange(node.level, this.detail, _range);
    const tileParams = new Vector4(size, tile.texels, _range[0], _range[1]);
    const material = this.material;
    const mesh = new Mesh(geometry, material);
    mesh.onBeforeRender = () => bindTile(material, texture, tileParams);
    mesh.position.set(tile.ox, tile.oy, tile.oz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    mesh.name = `TerrainTile L${node.level} ${node.ix},${node.iz}`;
    this.group.add(mesh);

    node.tile = { mesh, texture, tileParams, triangles: tile.triangleCount };
    node.ready = true;
    node.pending = false;
    node.minY = tile.minY;
    node.maxY = tile.maxY;
    this.tileCount++;
  }

  private setDetail(detail: number): void {
    this.detail = detail;
    for (const n of this.nodes.values()) {
      if (!n.tile) continue;
      morphRange(n.level, detail, _range);
      n.tile.tileParams.z = _range[0];
      n.tile.tileParams.w = _range[1];
    }
  }

  private evict(): void {
    const candidates: TerrainNode[] = [];
    for (const n of this.nodes.values()) {
      if (n.tile && n.lastDrawn !== this.frame && n.level > 1) candidates.push(n);
    }
    candidates.sort((a, b) => a.lastDrawn - b.lastDrawn);
    let excess = this.tileCount - TILE_BUDGET;
    for (const n of candidates) {
      if (excess <= 0) break;
      this.release(n);
      excess--;
    }
    // forget idle nodes far from anything (bounds are cheap to rebuild)
    if (this.nodes.size > 4000) {
      for (const [key, n] of this.nodes) {
        if (!n.tile && !n.pending && this.frame - n.wantedAt > 600 && n.level > 2) this.nodes.delete(key);
      }
    }
  }

  private release(n: TerrainNode): void {
    const t = n.tile;
    if (!t) return;
    this.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    t.texture.dispose();
    n.tile = null;
    n.ready = false;
    this.tileCount--;
  }

  private updateUniforms(camera: Camera): void {
    const u = terrainUniforms;
    u.uSunDir.value.copy(a10Env.sunDirection);
    u.uSunColor.value.copy(a10Env.sunColor);
    u.uHemiSky.value.copy(a10Lights.hemiSky);
    u.uHemiGround.value.copy(a10Lights.hemiGround);
    u.uAmbient.value.copy(a10Lights.ambient);
    u.uHazeColor.value.copy(a10Env.horizonColor);
    u.uHazeDensity.value = a10Env.hazeDensity;
    u.uZenithColor.value.copy(a10Env.zenithColor);
    u.uTime.value = envClock.time;
    // depth bias of ribbons: a few depth-buffer steps at their distance (24-bit, this near plane)
    const near = (camera as { near?: number }).near ?? 1;
    u.uDepthBias.value.set(0.2, 4 / (near * 16777216));
    // angle of one pixel (thin roads stay about a pixel and a half wide far away)
    const fov = (camera as { fov?: number }).fov ?? 62;
    u.uPixelAngle.value = (2 * Math.tan(((fov / 2) * Math.PI) / 180)) / Math.max(1, this.viewHeight);
    // thermal: solar heating by time of day (peaks in the early afternoon), ambient level
    const h = envFrame.hours;
    const solar = Math.max(0, Math.sin(((h - 6.5) / 13) * Math.PI)) * a10Env.daylight;
    const lag = Math.max(0, Math.sin(((h - 8.5) / 13) * Math.PI));
    u.uThermalParams.value.set(solar, 0.3 + 0.25 * lag, 1.2, 0);

    // cloud shadows from the cloud layer as drawn
    const layout = cloudShadowSource.layout;
    if (layout && layout !== this.cloudLayout) {
      this.cloudTexture?.dispose();
      this.cloudTexture = createCloudShadowTexture(layout);
      this.cloudLayout = layout;
      u.uCloudShadow.value = this.cloudTexture;
      u.uCloudParams.value.x = layout.tileSize;
      u.uCloudParams.value.y = cloudShadowHeight(layout);
      u.uCloudFade.value.x = layout.tileSize * 0.39;
      u.uCloudFade.value.y = layout.tileSize * 0.485;
    }
    if (layout) {
      u.uCloudParams.value.z = cloudShadowSource.driftX;
      u.uCloudParams.value.w = cloudShadowSource.driftZ;
      const sunUp = Math.max(0, a10Env.sunDirection.y);
      u.uCloudFade.value.z = 0.62 * a10Env.daylight * Math.min(1, sunUp * 4);
    } else {
      u.uCloudFade.value.z = 0;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.workers) w.worker.terminate();
    this.workers.length = 0;
    for (const n of this.nodes.values()) this.release(n);
    this.nodes.clear();
    this.trees.dispose();
    this.material.dispose();
    this.group.removeFromParent();
    this.detailTexture?.dispose();
    this.cloudTexture?.dispose();
    if (terrainUniforms.uDetail.value === this.detailTexture) terrainUniforms.uDetail.value = null;
    if (terrainUniforms.uCloudShadow.value === this.cloudTexture)
      terrainUniforms.uCloudShadow.value = null;
    this.arrived.length = 0;
    this.jobs.clear();
  }
}
