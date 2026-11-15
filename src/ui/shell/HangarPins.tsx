/**
 * HangarPins — the DOM half of the hangar hotspots: one button per HOTSPOTS entry, glued to
 * its anchor on the 3D model. The buttons are rendered once; their positions are written
 * straight to `style.transform` whenever the in-canvas projector publishes a frame
 * (hotspotProjection.ts), i.e. inside the animation frame that draws the canvas — no React
 * re-render and no lag behind the model. Styles: hangar.css (`hangar-pin`).
 */
import { useEffect, useRef } from 'react';
import { HOTSPOTS, type HotspotId } from '../../config/layout';
import { HOTSPOT_CONTENT } from './hotspotContent';
import {
  hotspotFrame,
  hotspotProjections,
  pinScaleForDepth,
  rankByDepth,
  subscribeHotspotFrame,
} from './hotspotProjection';
import { HotspotIcon } from './icons';

export interface HangarPinsProps {
  selected: HotspotId | null;
  /** Select the hotspot, or deselect it when it is the selected one. */
  onToggle: (id: HotspotId) => void;
}

export default function HangarPins({ selected, onToggle }: HangarPinsProps) {
  const pinRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const count = HOTSPOTS.length;
    // what the DOM currently shows, so a frame only touches the styles that changed
    const ranks = new Int8Array(count);
    const shownRank = new Int8Array(count);
    const shownVisible = new Uint8Array(count);
    const shownX = new Float32Array(count).fill(NaN);
    const shownY = new Float32Array(count).fill(NaN);
    const shownScale = new Float32Array(count).fill(NaN);

    const apply = () => {
      rankByDepth(hotspotProjections, ranks);
      for (let i = 0; i < count; i++) {
        const el = pinRefs.current[i];
        if (!el) continue;
        const p = hotspotProjections[i];
        const visible = p.visible ? 1 : 0;
        if (visible !== shownVisible[i]) {
          shownVisible[i] = visible;
          el.style.visibility = visible ? 'visible' : 'hidden';
        }
        if (!visible) continue;
        // Whole pixels: half a pixel off the anchor is invisible on a 32 px marker, the label
        // text stays crisp, and a pin over a slowly bobbing ship holds still between steps
        // (which also saves style writes and lets pointer automation find it at rest).
        const x = Math.round(p.x);
        const y = Math.round(p.y);
        if (x !== shownX[i] || y !== shownY[i]) {
          shownX[i] = x;
          shownY[i] = y;
          el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        }
        const scale = Math.round(pinScaleForDepth(p.depth, hotspotFrame.shipDepth) * 100) / 100;
        if (scale !== shownScale[i]) {
          shownScale[i] = scale;
          el.style.setProperty('--hangar-pin-scale', String(scale));
        }
        if (ranks[i] !== shownRank[i]) {
          shownRank[i] = ranks[i];
          el.style.zIndex = String(ranks[i]);
        }
      }
    };

    // adopt whatever the projector published before this component mounted
    apply();
    return subscribeHotspotFrame(apply);
  }, []);

  return (
    <div className="hangar-pins">
      {HOTSPOTS.map((hotspot, i) => {
        const content = HOTSPOT_CONTENT[hotspot.id];
        const isSelected = hotspot.id === selected;
        return (
          <button
            key={hotspot.id}
            ref={(el) => {
              pinRefs.current[i] = el;
            }}
            type="button"
            className="hangar-pin"
            data-testid={`hotspot-${hotspot.id}`}
            aria-label={content.title}
            aria-pressed={isSelected}
            onClick={() => onToggle(hotspot.id)}
          >
            <span className="hangar-pin__marker">
              <HotspotIcon kind={content.kind} size={17} />
            </span>
            <span className="hangar-pin__label" aria-hidden="true">
              {content.title}
            </span>
          </button>
        );
      })}
    </div>
  );
}
