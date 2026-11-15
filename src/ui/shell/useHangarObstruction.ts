/**
 * Tells the hotspot projector which parts of the hangar view the DOM panels cover
 * (hotspotProjection.ts `hangarObstruction`): the rectangles no pin may hide under, and the
 * edge strips the ship should be framed clear of. Measured whenever the panels change.
 */
import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { clearHangarObstruction, setHangarObstruction, type ScreenRect } from './hotspotProjection';

/** Everything that takes pointer events above the pin layer. */
const PANEL_SELECTOR = '.hangar-card, .hangar-demo, .hangar-back, .hangar-settings';

function rectOf(el: Element | null): ScreenRect | null {
  if (!el) return null;
  const { left, top, right, bottom } = el.getBoundingClientRect();
  return { left, top, right, bottom };
}

/**
 * @param rootRef   the overlay root (covers the canvas)
 * @param compact   phone layout: the card and the demo panel are bottom sheets
 * @param layoutKey changes whenever a panel is mounted or unmounted
 */
export function useHangarObstruction(
  rootRef: RefObject<HTMLElement>,
  compact: boolean,
  layoutKey: string,
): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const measure = () => {
      const view = root.getBoundingClientRect();
      const panels: ScreenRect[] = [];
      root
        .querySelectorAll(PANEL_SELECTOR)
        .forEach((el) => panels.push(el.getBoundingClientRect()));
      const card = rectOf(root.querySelector('.hangar-card'));
      const insets = { top: 0, right: 0, bottom: 0, left: 0 };
      if (compact) {
        // a bottom sheet (only one shows at a time) under the title bar
        const sheet = card ?? rectOf(root.querySelector('.hangar-demo'));
        const bar = rectOf(root.querySelector('.hangar-top'));
        if (bar) insets.top = bar.bottom - view.top;
        if (sheet) insets.bottom = view.bottom - sheet.top;
      } else if (card) {
        // the card is a column on the right
        insets.right = view.right - card.left;
      }
      setHangarObstruction(panels, insets);
    };

    measure();
    // a panel that folds, grows with its content or follows the window
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (observer) {
      observer.observe(root);
      root.querySelectorAll(PANEL_SELECTOR).forEach((el) => observer.observe(el));
    }
    // the card slides in: take its resting place once the entrance has played
    root.addEventListener('animationend', measure);
    return () => {
      observer?.disconnect();
      root.removeEventListener('animationend', measure);
    };
  }, [rootRef, compact, layoutKey]);

  useEffect(() => clearHangarObstruction, []);
}
