/**
 * Focus management for the modal surfaces of the shell (settings dialog, pause menu):
 *   - when the surface becomes active, focus moves into it — to its `[data-autofocus]`
 *     element if it has one, otherwise to the container itself;
 *   - Tab / Shift+Tab cycle inside it, and focus that lands anywhere else is pulled back;
 *   - optionally, focus returns to whatever had it before once the surface goes away.
 * The index arithmetic is in focusOrder.ts (unit-tested); this file is the DOM side.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { focusTrapTarget } from './focusOrder';

const TABBABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
].join(',');

/** The elements Tab can reach inside `container` right now, in document order. */
export function tabbableElements(container: HTMLElement): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (const el of container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)) {
    if (el.tabIndex < 0) continue;
    // no boxes = display: none on the element or an ancestor
    if (el.getClientRects().length === 0) continue;
    if (getComputedStyle(el).visibility !== 'visible') continue;
    result.push(el);
  }
  return result;
}

export interface ModalFocusOptions {
  /** The trap only runs while this is true (e.g. the pause menu steps aside for the settings). */
  active: boolean;
  /** Give focus back to the previously focused element when the surface deactivates. */
  restoreFocus?: boolean;
}

export function useModalFocus(
  ref: RefObject<HTMLElement>,
  { active, restoreFocus = false }: ModalFocusOptions,
): void {
  const opener = useRef<HTMLElement | null>(null);

  // Layout effect: runs before the browser can move focus off an opener that this very
  // render has hidden (the pause menu hides itself behind the settings dialog).
  useLayoutEffect(() => {
    const container = ref.current;
    if (!active || !container) return;
    const current = document.activeElement;
    if (current instanceof HTMLElement && !container.contains(current)) opener.current = current;
    const target = container.querySelector<HTMLElement>('[data-autofocus]') ?? container;
    target.focus({ preventScroll: true });
  }, [ref, active]);

  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return;

    const initial = document.activeElement;
    let lastFocused: HTMLElement | null =
      initial instanceof HTMLElement && initial !== container && container.contains(initial)
        ? initial
        : null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
      const items = tabbableElements(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const focused = document.activeElement;
      const activeIndex = focused instanceof HTMLElement ? items.indexOf(focused) : -1;
      const resumeIndex = lastFocused ? items.indexOf(lastFocused) : -1;
      const target = focusTrapTarget(items.length, activeIndex, resumeIndex, e.shiftKey);
      if (target === null) return;
      e.preventDefault();
      items[target].focus();
    };

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && container.contains(target)) {
        if (target !== container) lastFocused = target;
        return;
      }
      // focus arrived from outside (tabbing back in from the browser chrome, a script)
      const fallback = lastFocused && lastFocused.isConnected ? lastFocused : container;
      fallback.focus({ preventScroll: true });
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      // Passive cleanup, not layout: by now a surface that was hidden behind this one is
      // visible again, so its button can take the focus back.
      const target = opener.current;
      if (restoreFocus && target && target.isConnected) target.focus({ preventScroll: true });
    };
  }, [ref, active, restoreFocus]);
}
