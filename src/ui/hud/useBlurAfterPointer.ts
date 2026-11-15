/**
 * Keeps keyboard flying intact after the pilot uses the mouse or a finger on the overlay.
 *
 * A clicked button or dragged slider keeps the keyboard focus: a focused range input then
 * swallows the arrow keys (the tilt keys) and a focused button re-fires on Space (launch).
 * This hook blurs whatever inside `root` holds the focus as soon as the pointer is released,
 * wherever on the page that happens (a slider drag often ends outside the slider).
 * Focus reached with the keyboard (Tab) is left alone, so the controls stay keyboard-usable.
 */
import { useEffect, type RefObject } from 'react';

export function useBlurAfterPointer(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;

    const release = (): void => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      // after the click / change handlers of this gesture have run
      window.setTimeout(() => {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && el.contains(focused)) focused.blur();
      }, 0);
    };
    const press = (): void => {
      window.addEventListener('pointerup', release, true);
      window.addEventListener('pointercancel', release, true);
    };

    el.addEventListener('pointerdown', press);
    return () => {
      el.removeEventListener('pointerdown', press);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
  }, [root]);
}
