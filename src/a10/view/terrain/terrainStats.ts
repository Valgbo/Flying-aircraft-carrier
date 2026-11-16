/**
 * Live numbers of the terrain view (for the adaptive-quality gate, the sandbox read-out and
 * performance checks). Written by TerrainView every frame.
 */
export const terrainStreaming = {
  /** Tile and tree-cell builds requested and not yet received. */
  pending: 0,
  /** Tiles held in memory. */
  tiles: 0,
  /** Tiles selected for drawing this frame (before frustum culling). */
  drawn: 0,
  /** Triangles of the selected tiles. */
  triangles: 0,
  /** Instanced trees drawn. */
  trees: 0,
  /** Worker time per tile, ms (moving average). */
  buildMs: 0,
  /** Main-thread time spent turning finished tiles into meshes this frame, ms. */
  uploadMs: 0,
  /** Main-thread time of the terrain view's frame work, ms (moving average). */
  frameMs: 0,
};
