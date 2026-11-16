/**
 * The A-10 seen from above as a small mark for titles (menu, loading, pause). Drawn from the
 * same planform as the loadout schematic.
 */
import { planformPaths, PLANFORM_BOUNDS } from './planform';

const PAD = 0.4;
const VIEW = [
  PLANFORM_BOUNDS.minX - PAD,
  PLANFORM_BOUNDS.minY - PAD,
  PLANFORM_BOUNDS.maxX - PLANFORM_BOUNDS.minX + 2 * PAD,
  PLANFORM_BOUNDS.maxY - PLANFORM_BOUNDS.minY + 2 * PAD,
].join(' ');

export default function A10Mark({ size = 48, className }: { size?: number; className?: string }) {
  const p = planformPaths();
  return (
    <svg
      className={`a10-mark${className ? ` ${className}` : ''}`}
      viewBox={VIEW}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path className="a10-mark__wing" d={p.wing} />
      <path className="a10-mark__wing" d={p.tailplane} />
      <path className="a10-mark__body" d={p.gearPods} />
      <path className="a10-mark__body" d={p.fuselage} />
      <path className="a10-mark__body" d={p.gun} />
      <path className="a10-mark__engine" d={p.nacelles} />
      <path className="a10-mark__body" d={p.fins} />
      <ellipse className="a10-mark__canopy" {...p.canopy} />
    </svg>
  );
}
