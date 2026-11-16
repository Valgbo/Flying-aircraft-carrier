/**
 * Credits: the project's licence (GPL-2.0-or-later) and the third-party material it uses
 * (PLAN_A10.md §3.1). The list lives in credits.ts, which mirrors CREDITS.md.
 */
import { IconArrowLeft } from '../../engine';
import { useA10Store } from '../state/store';
import A10Mark from './A10Mark';
import { ORIGINAL_WORK, PROJECT_LICENCE, SOFTWARE, THIRD_PARTY } from './credits';

function Link({ href, children }: { href: string; children: string }) {
  return (
    <a className="a10-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export default function CreditsScreen() {
  const setScreen = useA10Store((s) => s.setScreen);
  return (
    <div className="a10-page a10-credits" data-testid="a10-credits-screen">
      <header className="a10-page__head">
        <button
          type="button"
          className="fac-btn fac-btn--ghost a10-page__back"
          data-testid="a10-credits-back"
          autoFocus
          onClick={() => setScreen('menu')}
        >
          <IconArrowLeft size={18} />
          <span>Menu</span>
        </button>
        <div className="a10-page__title">
          <p className="fac-label">A-10C Warthog</p>
          <h1>Credits</h1>
        </div>
      </header>

      <div className="a10-page__body">
        <div className="a10-credits__column">
          <section className="a10-card" aria-labelledby="a10-licence-title">
            <div className="a10-credits__lead">
              <A10Mark size={64} />
              <div>
                <h2 className="a10-section-title" id="a10-licence-title">
                  Licence
                </h2>
                <p className="a10-credits__licence">
                  <span className="a10-badge fac-readout" data-testid="a10-licence">
                    {PROJECT_LICENCE.spdx}
                  </span>{' '}
                  {PROJECT_LICENCE.name}.
                </p>
              </div>
            </div>
            <p>
              {PROJECT_LICENCE.copyright} {PROJECT_LICENCE.summary} {PROJECT_LICENCE.noWarranty}{' '}
              <Link href={PROJECT_LICENCE.text.url}>{PROJECT_LICENCE.text.label}</Link>.
            </p>
            <p className="a10-credits__dim">{ORIGINAL_WORK}</p>
          </section>

          {THIRD_PARTY.map((c) => (
            <section key={c.title} className="a10-card" aria-label={c.title}>
              <h2 className="a10-section-title">{c.title}</h2>
              <p>{c.used}.</p>
              <dl className="a10-credits__facts">
                <div>
                  <dt>By</dt>
                  <dd>
                    <ul className="a10-credits__names">
                      {c.authors.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
                <div>
                  <dt>Licence</dt>
                  <dd>{c.licence}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    <Link href={c.source.url}>{c.source.label}</Link>
                  </dd>
                </div>
              </dl>
              {c.note && <p className="a10-credits__dim">{c.note}</p>}
            </section>
          ))}

          <section className="a10-card" aria-labelledby="a10-software-title">
            <h2 className="a10-section-title" id="a10-software-title">
              Built with
            </h2>
            <ul className="a10-credits__software">
              {SOFTWARE.map((s) => (
                <li key={s.name}>
                  <Link href={s.url}>{s.name}</Link>
                  <span className="a10-credits__dim"> · {s.licence}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
