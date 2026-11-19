/**
 * The terrain's hook for a sensor's picture (the targeting pod, a Maverick seeker), for the
 * sensor view to call around its own render of the world scene:
 *
 *   beginTerrainFocus(focus)  select the picture's own tiles (lod.ts selectFocusTiles: the
 *                             outside view's rule at the sensor's magnification, inside its picture)
 *                             and draw them instead of the outside view's; their geomorph counts
 *                             distances the same way (terrainUniforms.uLodScale). False when there
 *                             is no terrain yet: the sensor then sees the outside view's tiles.
 *   endTerrainFocus()         draw the outside view's tiles again, exactly as they were.
 *
 * The picture's missing tiles are requested with their magnified distances and kept wanted while
 * the sensor keeps rendering (at its own, lower rate); the outside view's selection, tiles and
 * budget never change. The mounted terrain system registers itself here.
 */
import type { LodFocus } from './lod';

/** What the terrain system offers a sensor's render. */
export interface TerrainFocusTarget {
  beginFocus(focus: LodFocus): boolean;
  endFocus(): void;
}

let target: TerrainFocusTarget | null = null;

/** The terrain system a sensor's picture draws with (TerrainSystem registers itself). */
export function setTerrainFocusTarget(next: TerrainFocusTarget | null): void {
  target = next;
}

export function getTerrainFocusTarget(): TerrainFocusTarget | null {
  return target;
}

/** Draw the tiles of a sensor's picture (true) until `endTerrainFocus`. */
export function beginTerrainFocus(focus: LodFocus): boolean {
  return target !== null && target.beginFocus(focus);
}

/** Draw the outside view's tiles again (harmless when nothing began). */
export function endTerrainFocus(): void {
  target?.endFocus();
}
