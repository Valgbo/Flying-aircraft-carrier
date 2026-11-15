/**
 * FpsCounter — a small frame-rate readout (shown while `settings.showFps`). It counts
 * animation frames and writes the average to the DOM about twice a second through a ref —
 * no React state, so measuring the frame rate does not cost frames.
 * Styles: loading.css (`loading-fps`).
 */
import { useEffect, useRef } from 'react';

/** How often the number is refreshed, ms. */
const UPDATE_INTERVAL = 500;

export default function FpsCounter() {
  const valueRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frames = 0;
    let since = performance.now();
    let handle = 0;
    const tick = (now: number) => {
      frames++;
      const elapsed = now - since;
      if (elapsed >= UPDATE_INTERVAL) {
        if (valueRef.current) {
          valueRef.current.textContent = String(Math.round((frames * 1000) / elapsed));
        }
        frames = 0;
        since = now;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, []);

  return (
    <div className="loading-fps fac-readout" data-testid="fps-counter" aria-hidden="true">
      <span ref={valueRef}>--</span> FPS
    </div>
  );
}
