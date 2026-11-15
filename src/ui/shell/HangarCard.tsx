/**
 * HangarCard — the info card of the selected hangar hotspot: what the part is, a short
 * description and a small spec table, plus previous / next buttons that walk through all the
 * hotspots (a pin can be behind the ship, off screen or under this card).
 * Styles: hangar.css (`hangar-card`).
 */
import { useEffect, useRef } from 'react';
import type { HotspotContent } from './hotspotContent';
import { HotspotIcon, IconChevronRight, IconClose } from './icons';

/** One hotspot back or forward in HOTSPOTS order (wraps around). */
export type HangarCardStep = -1 | 1;

export interface HangarCardProps {
  content: HotspotContent;
  /** Position of this hotspot in the list, 0-based, and the length of the list. */
  index: number;
  count: number;
  /** Give the keyboard focus to this step button on mount (the card was opened with it). */
  focusStep: HangarCardStep | null;
  onStep: (step: HangarCardStep) => void;
  onClose: () => void;
}

export default function HangarCard({
  content,
  index,
  count,
  focusStep,
  onStep,
  onClose,
}: HangarCardProps) {
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (focusStep === -1) previousRef.current?.focus();
    else if (focusStep === 1) nextRef.current?.focus();
  }, [focusStep]);

  return (
    <section
      className="hangar-card fac-panel"
      data-testid="hangar-card"
      aria-labelledby="hangar-card-title"
      aria-live="polite"
    >
      <header className="hangar-card__head">
        <span className="hangar-card__icon">
          <HotspotIcon kind={content.kind} size={20} />
        </span>
        <div className="hangar-card__heading">
          <p className="fac-label hangar-card__kicker">{content.kicker}</p>
          <h2 className="hangar-card__title" id="hangar-card-title">
            {content.title}
          </h2>
        </div>
        <button
          type="button"
          className="hangar-icon-btn fac-focusable"
          data-testid="hangar-card-close"
          aria-label="Close"
          onClick={onClose}
        >
          <IconClose size={18} />
        </button>
      </header>
      <div className="hangar-card__body">
        <p className="hangar-card__text">{content.description}</p>
        <dl className="hangar-card__specs">
          {content.specs.map((spec) => (
            <div key={spec.label} className="hangar-card__spec">
              <dt>{spec.label}</dt>
              <dd className="fac-readout">{spec.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <footer className="hangar-card__nav">
        <button
          ref={previousRef}
          type="button"
          className="hangar-icon-btn fac-focusable"
          data-testid="hangar-card-prev"
          aria-label="Previous part"
          onClick={() => onStep(-1)}
        >
          <IconChevronRight size={18} className="hangar-card__back" />
        </button>
        <span className="fac-readout hangar-card__count">
          {index + 1} / {count}
        </span>
        <button
          ref={nextRef}
          type="button"
          className="hangar-icon-btn fac-focusable"
          data-testid="hangar-card-next"
          aria-label="Next part"
          onClick={() => onStep(1)}
        >
          <IconChevronRight size={18} />
        </button>
      </footer>
    </section>
  );
}
