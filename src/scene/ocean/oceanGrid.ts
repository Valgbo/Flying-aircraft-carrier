/**
 * The ocean mesh: one square grid, centred near the camera, whose spacing is uniform in the
 * middle (the part that covers the hull) and grows geometrically toward an edge 36 km out.
 *
 * Vertices sit at y = 0 in OCEAN-LOCAL coordinates (world axes, origin at the mesh position).
 * The mesh position is snapped to multiples of `baseCell`, so in the uniform middle every
 * vertex always lands on the same world lattice and the sampled waves do not swim when the
 * camera moves. Further out the cells are too coarse for the short waves anyway: the vertex
 * shader fades each wave by the `aCell` attribute (the size of the cells around the vertex)
 * and the fragment shader's analytic normals carry the look.
 */
import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';

/** Half the side of the mesh, m. The corners lie 51 km out, inside the 60 km far plane. */
export const OCEAN_HALF_EXTENT = 36_000;

/** Half the side of the uniform middle, m: covers the 320 m hull and its four turbines. */
export const OCEAN_UNIFORM_HALF = 160;

export interface OceanGridLayout {
  /** Grid-line coordinates along one axis, ascending and symmetric about 0 (segments + 1 values). */
  lines: Float64Array;
  /** The larger of the two cell widths next to each grid line, m. */
  cellAt: Float64Array;
  /** Cell width of the uniform middle = the world lattice the mesh position snaps to, m. */
  baseCell: number;
  segments: number;
}

/** Solve r in  first · r · (rⁿ − 1) / (r − 1) = span  (the n outer cells fill `span`). */
function solveGrowth(first: number, count: number, span: number): number {
  let lo = 1 + 1e-9;
  let hi = 8;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const total = (first * mid * (mid ** count - 1)) / (mid - 1);
    if (total < span) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Grid lines for a grid of `segments` cells per side (rounded up to an even number, at least 8).
 * Half of the cells form the uniform middle, the rest grow geometrically out to the edge.
 */
export function oceanGridLayout(segments: number): OceanGridLayout {
  const n = Math.max(8, 2 * Math.ceil(segments / 2));
  // cells from the centre to the edge of the uniform middle, and from there to the mesh edge
  const inner = Math.max(2, Math.round(n / 4));
  const outer = n / 2 - inner;
  const baseCell = OCEAN_UNIFORM_HALF / inner;
  const growth = solveGrowth(baseCell, outer, OCEAN_HALF_EXTENT - OCEAN_UNIFORM_HALF);

  const half = new Float64Array(n / 2 + 1);
  for (let i = 0; i <= inner; i++) half[i] = i * baseCell;
  let width = baseCell;
  for (let i = inner + 1; i <= n / 2; i++) {
    width *= growth;
    half[i] = half[i - 1] + width;
  }
  half[n / 2] = OCEAN_HALF_EXTENT;

  const lines = new Float64Array(n + 1);
  for (let i = 0; i <= n / 2; i++) {
    lines[n / 2 + i] = half[i];
    lines[n / 2 - i] = -half[i];
  }
  const cellAt = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const before = i > 0 ? lines[i] - lines[i - 1] : 0;
    const after = i < n ? lines[i + 1] - lines[i] : 0;
    cellAt[i] = Math.max(before, after);
  }
  return { lines, cellAt, baseCell, segments: n };
}

/**
 * Build the grid geometry: `position` (x, 0, z), `aCell` (local cell size, m) and a 32-bit
 * index. Diagonals alternate in a checkerboard so the displaced surface has no grain.
 */
export function buildOceanGeometry(layout: OceanGridLayout): BufferGeometry {
  const { lines, cellAt, segments: n } = layout;
  const side = n + 1;
  const positions = new Float32Array(side * side * 3);
  const cells = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const v = j * side + i;
      positions[v * 3] = lines[i];
      positions[v * 3 + 2] = lines[j];
      cells[v] = Math.max(cellAt[i], cellAt[j]);
    }
  }
  const indices = new Uint32Array(n * n * 6);
  let o = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i; // (x0, z0)
      const b = a + 1; // (x1, z0)
      const c = a + side; // (x0, z1)
      const d = c + 1; // (x1, z1)
      // counter-clockwise seen from above (+Y)
      if ((i + j) % 2 === 0) {
        indices[o++] = a;
        indices[o++] = c;
        indices[o++] = b;
        indices[o++] = b;
        indices[o++] = c;
        indices[o++] = d;
      } else {
        indices[o++] = a;
        indices[o++] = c;
        indices[o++] = d;
        indices[o++] = a;
        indices[o++] = d;
        indices[o++] = b;
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aCell', new BufferAttribute(cells, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  // the shader moves the vertices, so the box three.js would compute is meaningless; the mesh is
  // never frustum-culled, this just keeps anything that asks for bounds well-defined
  geometry.boundingSphere = new Sphere(new Vector3(), OCEAN_HALF_EXTENT * Math.SQRT2);
  return geometry;
}
