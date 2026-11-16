/** Messages between the terrain view and its workers. */
import type { TerrainData } from '../../core/world/types';
import type { TileData, TileSpec } from './tileBuilder';
import type { TreeCell, TreeCellSpec } from './treeCells';

export type WorkerRequest =
  | { type: 'init'; data: TerrainData }
  | { type: 'detail' }
  | { type: 'tile'; id: number; spec: TileSpec }
  | { type: 'trees'; id: number; spec: TreeCellSpec };

export type WorkerReply =
  | { type: 'ready' }
  | { type: 'detail'; data: Uint8Array<ArrayBuffer> }
  | { type: 'tile'; id: number; tile: TileData; ms: number }
  | { type: 'trees'; id: number; cell: TreeCell }
  | { type: 'error'; id: number; message: string };
