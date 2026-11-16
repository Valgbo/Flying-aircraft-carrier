/**
 * Arrow-key navigation between the main menu's entries by where they are on screen, so the same
 * code serves the desktop list and the phone sheet with its rows of tiles. Pure geometry;
 * covered by tests/unit/a10/ui-nav.test.ts.
 */
export type NavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export interface NavRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const cx = (r: NavRect) => r.left + r.width / 2;
const cy = (r: NavRect) => r.top + r.height / 2;

/** Two rects share a row when their vertical centres are within half the smaller height. */
function sameRow(a: NavRect, b: NavRect): boolean {
  return Math.abs(cy(a) - cy(b)) < Math.min(a.height, b.height) / 2;
}

/**
 * The index to focus after pressing `key` on item `current` (-1 = none focused: a forward key
 * lands on the first item, a backward key on the last).
 *  - Up / Down: the nearest row above / below, then the item there closest horizontally;
 *    past the last row it wraps to the first (and the other way round).
 *  - Left / Right: the nearest item in the same row on that side; at the end of a row it moves
 *    to the previous / next item in reading order, wrapping around.
 */
export function spatialStep(rects: readonly NavRect[], current: number, key: NavKey): number {
  const n = rects.length;
  if (n === 0) return -1;
  const forward = key === 'ArrowDown' || key === 'ArrowRight';
  if (current < 0 || current >= n) return forward ? 0 : n - 1;
  const here = rects[current];

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (i === current || !sameRow(here, rects[i])) continue;
      const d = (cx(rects[i]) - cx(here)) * (forward ? 1 : -1);
      if (d > 0 && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) return best;
    return (current + (forward ? 1 : -1) + n) % n;
  }

  // Up / Down: candidates on the other side, nearest row first, then nearest horizontally.
  const dir = forward ? 1 : -1;
  const pick = (candidates: number[]): number => {
    let best = -1;
    let bestRow = Infinity;
    for (const i of candidates) bestRow = Math.min(bestRow, Math.abs(cy(rects[i]) - cy(here)));
    let bestDx = Infinity;
    for (const i of candidates) {
      const rowD = Math.abs(cy(rects[i]) - cy(here));
      if (rowD > bestRow + rects[i].height / 2) continue;
      const dx = Math.abs(cx(rects[i]) - cx(here));
      if (dx < bestDx) {
        bestDx = dx;
        best = i;
      }
    }
    return best;
  };
  const ahead: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === current || sameRow(here, rects[i])) continue;
    if ((cy(rects[i]) - cy(here)) * dir > 0) ahead.push(i);
  }
  if (ahead.length > 0) return pick(ahead);
  // wrap: the row at the far end (topmost going down, bottommost going up)
  let edge = Infinity;
  for (let i = 0; i < n; i++) edge = Math.min(edge, cy(rects[i]) * dir);
  const far: number[] = [];
  for (let i = 0; i < n; i++)
    if (Math.abs(cy(rects[i]) * dir - edge) < rects[i].height / 2) far.push(i);
  const wrapped = pick(far);
  return wrapped >= 0 ? wrapped : current;
}
