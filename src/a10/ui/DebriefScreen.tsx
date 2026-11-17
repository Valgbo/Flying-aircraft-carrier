/**
 * Debrief (store screen 'debrief', reached through flow.finishFlight()): the pass-by-pass
 * debrief of PLAN_A10.md §11.4 for the flight that just ended (DebriefView). The flight stays
 * readable (getSim()) until the next one starts.
 */
import { IconArrowLeft } from '../../engine';
import { exitToMenu, restartFlight } from '../state/flow';
import { getSim } from '../state/runtime';
import { useA10Store } from '../state/store';
import DebriefView from './DebriefView';
import { formatClock } from './format';
import { IconRestart } from './icons';
import { scenarioName } from './names';

export default function DebriefScreen() {
  const scenario = useA10Store((s) => s.scenario);
  const sim = getSim();

  if (!sim) {
    return (
      <div className="a10-page a10-debrief" data-testid="a10-debrief">
        <header className="a10-page__head">
          <div className="a10-page__title">
            <h1>Debrief</h1>
          </div>
        </header>
        <div className="a10-page__body">
          <p className="a10-note">There is no flight to debrief.</p>
          <button type="button" className="fac-btn" onClick={exitToMenu}>
            Menu
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="a10-page a10-debrief" data-testid="a10-debrief">
      <header className="a10-page__head">
        <button
          type="button"
          className="fac-btn fac-btn--ghost a10-page__back"
          data-testid="a10-debrief-menu"
          onClick={exitToMenu}
        >
          <IconArrowLeft size={18} />
          <span>Menu</span>
        </button>
        <div className="a10-page__title">
          <p className="fac-label">
            {scenarioName(scenario)} · {formatClock(sim.time)}
          </p>
          <h1>Debrief</h1>
        </div>
        <button
          type="button"
          className="fac-btn fac-btn--primary a10-page__action"
          data-testid="a10-debrief-again"
          onClick={() => void restartFlight()}
        >
          <IconRestart size={18} />
          <span>Fly again</span>
        </button>
      </header>

      <div className="a10-page__body a10-debrief__body">
        <DebriefView sim={sim} />
      </div>
    </div>
  );
}
