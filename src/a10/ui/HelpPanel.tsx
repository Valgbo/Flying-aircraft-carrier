/**
 * Help panel (store.helpOpen, toggled by the input module's Help binding or closed here): the
 * controls reference beside the view. It does not pause or take the keyboard: the flight goes
 * on behind it. Escape closes it (UIRoot).
 */
import { IconClose } from '../../engine';
import { useA10Store } from '../state/store';
import ControlsReference from './ControlsReference';

export default function HelpPanel() {
  const setHelpOpen = useA10Store((s) => s.setHelpOpen);
  return (
    <aside className="a10-help fac-panel" data-testid="a10-help" aria-labelledby="a10-help-title">
      <header className="a10-help__head">
        <h2 className="a10-help__title" id="a10-help-title">
          Controls
        </h2>
        <button
          type="button"
          className="settings-close fac-focusable"
          aria-label="Close the controls"
          data-testid="a10-help-close"
          onClick={() => setHelpOpen(false)}
        >
          <IconClose size={18} />
        </button>
      </header>
      <div className="a10-help__body">
        <ControlsReference />
      </div>
    </aside>
  );
}
