/**
 * Keyboard-focus arithmetic for the shell UI: where Tab goes inside a modal focus trap and
 * where the arrow keys go in a menu grid. Pure index math — the DOM side lives in
 * useModalFocus.ts and MainMenu.tsx; covered by tests/unit/shell.test.ts.
 */

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export function isArrowKey(key: string): key is ArrowKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';
}

function wrap(index: number, count: number): number {
  return ((index % count) + count) % count;
}

/**
 * Where Tab (or Shift+Tab when `backwards`) should move focus inside a trap that holds
 * `count` tabbable elements.
 *
 *   activeIndex — position of the focused element in the trap's tab order, -1 when focus is
 *                 on the container itself or outside the trap
 *   resumeIndex — position of the element that last held focus inside the trap, -1 if none.
 *                 Sliders give focus up when the pointer is released; Tab then continues
 *                 from the slider instead of jumping back to the top of the dialog.
 *
 * Returns the index to focus, or null when the browser's own Tab handling already does the
 * right thing (moving between two elements inside the trap).
 */
export function focusTrapTarget(
  count: number,
  activeIndex: number,
  resumeIndex: number,
  backwards: boolean,
): number | null {
  if (count <= 0) return null;
  const step = backwards ? -1 : 1;
  if (activeIndex < 0 || activeIndex >= count) {
    if (resumeIndex >= 0 && resumeIndex < count) return wrap(resumeIndex + step, count);
    return backwards ? count - 1 : 0;
  }
  if (!backwards && activeIndex === count - 1) return 0;
  if (backwards && activeIndex === 0) return count - 1;
  return null;
}

/**
 * Arrow-key navigation over `count` items laid out row by row in `columns` columns
 * (1 = a vertical list, `count` or more = a single row).
 *
 * Left / Right walk the items in reading order and wrap around. Up / Down do the same in a
 * list or a single row, and stay inside their column in a real grid (wrapping top ↔ bottom,
 * skipping the gap of a ragged last row). With nothing focused (`current` = -1) a forward key
 * lands on the first item and a backward key on the last.
 */
export function gridStep(current: number, key: ArrowKey, count: number, columns: number): number {
  if (count <= 0) return -1;
  const forward = key === 'ArrowDown' || key === 'ArrowRight';
  if (current < 0 || current >= count) return forward ? 0 : count - 1;

  const cols = Math.max(1, Math.min(Math.floor(columns), count));
  const rows = Math.ceil(count / cols);
  const vertical = key === 'ArrowUp' || key === 'ArrowDown';
  if (!vertical || cols === 1 || rows === 1) return wrap(current + (forward ? 1 : -1), count);

  const column = current % cols;
  let row = wrap(Math.floor(current / cols) + (forward ? 1 : -1), rows);
  // the last row may be short: step over the hole to the next real item in this column
  if (row * cols + column >= count) row = forward ? 0 : rows - 2;
  return row * cols + column;
}
