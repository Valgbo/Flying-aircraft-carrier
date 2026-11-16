/**
 * The terrain worker: rebuilds the world's Terrain from `getTerrain().data` with createTerrain
 * (the very same height function the simulation uses) and builds tiles, tree cells and the
 * generated detail textures off the main thread. Everything it returns travels as transferred
 * typed arrays (no copies).
 *
 * Protocol (see terrainProtocol.ts): init → ready; detail → detail; tile → tile; trees → trees.
 */
import { createTerrain } from '../../core/world';
import type { Terrain } from '../../core/world/types';
import { buildDetailTextures } from './detailTextures';
import { createBakeScratch, type BakeScratch } from './palette';
import type { WorkerReply, WorkerRequest } from './terrainProtocol';
import { buildTile, prepareFeatures, type FeatureIndex } from './tileBuilder';
import { buildTreeCell } from './treeCells';

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

let terrain: Terrain | null = null;
let features: FeatureIndex | null = null;
let scratch: BakeScratch | null = null;

function reply(message: WorkerReply, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

scope.onmessage = (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init': {
        terrain = createTerrain(msg.data);
        features = prepareFeatures(terrain);
        scratch = createBakeScratch(terrain.seed, terrain);
        reply({ type: 'ready' });
        break;
      }
      case 'detail': {
        const data = buildDetailTextures();
        reply({ type: 'detail', data }, [data.buffer]);
        break;
      }
      case 'tile': {
        if (!terrain) throw new Error('terrain worker: tile before init');
        const t0 = performance.now();
        const tile = buildTile(terrain, msg.spec, features, scratch!);
        reply({ type: 'tile', id: msg.id, tile, ms: performance.now() - t0 }, [
          tile.position.buffer,
          tile.normal.buffer,
          tile.morph.buffer,
          tile.info.buffer,
          tile.ribbon.buffer,
          tile.side.buffer,
          tile.index.buffer,
          tile.texture.buffer,
        ]);
        break;
      }
      case 'trees': {
        if (!terrain) throw new Error('terrain worker: trees before init');
        const cell = buildTreeCell(terrain, msg.spec);
        reply({ type: 'trees', id: msg.id, cell }, [cell.data.buffer]);
        break;
      }
    }
  } catch (err) {
    reply({
      type: 'error',
      id: 'id' in msg ? msg.id : -1,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
