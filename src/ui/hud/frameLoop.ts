/**
 * The single requestAnimationFrame loop of the instrument overlay. The HUD and the turbine
 * panel register painters here; each painter reads `sim` and writes DOM / SVG attributes
 * through refs, so the fast-moving graphics never cause a React render.
 *
 * The loop only runs while at least one painter is registered.
 */
import { useEffect } from 'react';

type Painter = () => void;

const painters: Painter[] = [];
let frameHandle = 0;

function tick(): void {
  // indexed loop: no iterator allocation per frame
  for (let i = 0; i < painters.length; i++) painters[i]();
  frameHandle = requestAnimationFrame(tick);
}

function addPainter(painter: Painter): () => void {
  painters.push(painter);
  if (painters.length === 1) frameHandle = requestAnimationFrame(tick);
  return () => {
    const index = painters.indexOf(painter);
    if (index >= 0) painters.splice(index, 1);
    if (painters.length === 0) cancelAnimationFrame(frameHandle);
  };
}

/**
 * Run `painter` every animation frame while the component is mounted. Pass a stable function
 * (module-level, or memoised) — it is re-registered whenever its identity changes.
 */
export function useFramePainter(painter: Painter): void {
  useEffect(() => addPainter(painter), [painter]);
}
