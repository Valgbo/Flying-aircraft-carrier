/**
 * ControlsCheatSheet — the compact controls reference of the main menu: one tab per input
 * device (the keyboard rows come from the live key bindings). On phones it folds away
 * behind a "Controls" toggle so the menu sheet covers as little of the scene as possible.
 * Styles: menu.css (`menu-controls`).
 */
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useGameStore } from '../../state/useGameStore';
import { CHEAT_DEVICES, cheatSheetFor, type CheatDevice } from './cheatSheet';
import { KeyReference } from './controls';
import { IconChevronDown } from './icons';
import { COARSE_POINTER_QUERY, matchesMedia } from './useMediaQuery';

export interface ControlsCheatSheetProps {
  /** Phone layout: start folded and show a toggle. Otherwise the reference is always open. */
  collapsible: boolean;
}

export default function ControlsCheatSheet({ collapsible }: ControlsCheatSheetProps) {
  const bindings = useGameStore((s) => s.settings.keyBindings);
  const [device, setDevice] = useState<CheatDevice>(() =>
    matchesMedia(COARSE_POINTER_QUERY) ? 'touch' : 'keyboard',
  );
  const [open, setOpen] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const expanded = !collapsible || open;

  // Tabs follow the usual pattern: one tab stop, arrow keys move and select.
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const count = CHEAT_DEVICES.length;
    const index = CHEAT_DEVICES.findIndex((d) => d.id === device);
    let next: number;
    if (e.key === 'ArrowRight') next = (index + 1) % count;
    else if (e.key === 'ArrowLeft') next = (index - 1 + count) % count;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    else return;
    e.preventDefault();
    setDevice(CHEAT_DEVICES[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className="menu-controls" aria-label="Controls">
      <div className="menu-controls__head">
        {collapsible ? (
          <button
            type="button"
            className="menu-controls__toggle fac-focusable"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span className="fac-label">Controls</span>
            <IconChevronDown size={14} className="menu-controls__chevron" />
          </button>
        ) : (
          <h2 className="fac-label menu-controls__title">Controls</h2>
        )}
        {expanded && (
          <div
            className="menu-controls__tabs"
            role="tablist"
            aria-label="Input device"
            onKeyDown={onTabKeyDown}
          >
            {CHEAT_DEVICES.map((d, i) => (
              <button
                key={d.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${d.id}`}
                className="menu-controls__tab fac-focusable"
                aria-selected={d.id === device}
                aria-controls={panelId}
                tabIndex={d.id === device ? 0 : -1}
                onClick={() => setDevice(d.id)}
              >
                {d.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {expanded && (
        <div
          className="menu-controls__panel"
          role="tabpanel"
          id={panelId}
          aria-labelledby={`${baseId}-tab-${device}`}
        >
          <KeyReference rows={cheatSheetFor(device, bindings)} />
        </div>
      )}
    </section>
  );
}
