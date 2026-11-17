/**
 * Sideways scrollers with a visible hint. On a phone the wide debrief and realism tables (and
 * the settings section links) scroll sideways; the edge where content is hidden fades out
 * (ui.css `[data-more]` rules) so the scroll is visible before anyone tries it. Nothing changes
 * where the content fits.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

/** Which edges hide content: 'left', 'right', 'both', or '' when it all fits. */
export function hiddenEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): string {
  // scrollLeft is fractional on zoomed pages: allow a pixel of slack at both ends
  const left = scrollLeft > 1;
  const right = scrollLeft + clientWidth < scrollWidth - 1;
  return left && right ? 'both' : left ? 'left' : right ? 'right' : '';
}

/** Keep `data-more` on the element up to date while it scrolls or resizes. */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const more = hiddenEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
      if (more) el.dataset.more = more;
      else delete el.dataset.more;
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // the box resizes with the window, its content with the rows
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [ref]);
}

/** A table's horizontal scroller. */
export default function TableWrap({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollEdges(ref);
  return (
    <div ref={ref} className="a10-table-wrap">
      {children}
    </div>
  );
}
