/**
 * HangarCard — the info card of the selected hangar hotspot: what the part is, a short
 * description and a small spec table. Styles: hangar.css (`hangar-card`).
 */
import type { HotspotContent } from './hotspotContent';
import { HotspotIcon, IconClose } from './icons';

export interface HangarCardProps {
  content: HotspotContent;
  onClose: () => void;
}

export default function HangarCard({ content, onClose }: HangarCardProps) {
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
    </section>
  );
}
