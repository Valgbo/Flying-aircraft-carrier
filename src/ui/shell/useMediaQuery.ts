/** Reactive CSS media queries for the few layout decisions that CSS alone cannot make. */
import { useCallback, useSyncExternalStore } from 'react';

/**
 * Phone-sized viewports, portrait or landscape: panels turn into bottom sheets.
 * Keep in sync with the `@media (max-width: 720px), (max-height: 500px)` blocks in the
 * shell stylesheets.
 */
export const COMPACT_QUERY = '(max-width: 720px), (max-height: 500px)';

/** Short viewports (a phone held sideways): vertical room is the scarce resource. */
export const SHORT_QUERY = '(max-height: 500px)';

/** Touch-first devices — used for wording ("pinch" instead of "scroll"). */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** One-off, non-reactive evaluation. False where matchMedia does not exist. */
export function matchesMedia(query: string): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** True while `query` matches; re-renders when that changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof matchMedia !== 'function') return () => {};
      const list = matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => matchesMedia(query),
    () => false,
  );
}
