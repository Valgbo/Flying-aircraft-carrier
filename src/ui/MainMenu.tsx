/**
 * MainMenu — the front door: title block, the four entries and a compact controls reference.
 * The 3D scene is the backdrop and the camera frames the ship right of centre, so the panel
 * keeps to the left third on desktop and becomes a bottom sheet on phones. Styles: shell/menu.css.
 */
import { useEffect, useRef, type ComponentType, type KeyboardEvent } from 'react';
import { SHIP } from '../config/palette';
import { PHYS } from '../config/physicsConfig';
import type { Screen } from '../state/types';
import { useGameStore } from '../state/useGameStore';
import BrandMark from './shell/BrandMark';
import ControlsCheatSheet from './shell/ControlsCheatSheet';
import { gridStep, isArrowKey } from './shell/focusOrder';
import {
  IconChevronRight,
  IconFlight,
  IconHangar,
  IconOps,
  IconSliders,
  type IconProps,
} from './shell/icons';
import { COMPACT_QUERY, useMediaQuery } from './shell/useMediaQuery';
import './shell/shell.css';
import './shell/menu.css';

interface MenuEntry {
  testId: string;
  title: string;
  description: string;
  Icon: ComponentType<IconProps>;
  /** The screen the entry opens, or 'settings' for the settings dialog. */
  target: Screen | 'settings';
}

const ENTRIES: readonly MenuEntry[] = [
  {
    testId: 'menu-free-flight',
    title: 'Free flight',
    description: 'Lift off from the sea and fly her anywhere.',
    Icon: IconFlight,
    target: 'flight',
  },
  {
    testId: 'menu-flight-ops',
    title: 'Flight ops',
    description: 'Hold the deck steady while jets launch and land.',
    Icon: IconOps,
    target: 'ops',
  },
  {
    testId: 'menu-hangar',
    title: 'Hangar',
    description: 'Walk around the ship and run up the turbines.',
    Icon: IconHangar,
    target: 'hangar',
  },
  {
    testId: 'menu-settings',
    title: 'Settings',
    description: 'Graphics, audio and controls.',
    Icon: IconSliders,
    target: 'settings',
  },
];

const PITCH = `Lift a ${PHYS.mass.toLocaleString('en-US')}-tonne carrier off the sea on four tilting turbines.`;

/** How many entries share the first row — 1 in the desktop list, 2 or 4 in the phone sheets. */
function columnCount(buttons: readonly HTMLButtonElement[]): number {
  if (buttons.length === 0) return 1;
  const firstRowTop = buttons[0].offsetTop;
  return buttons.filter((b) => b.offsetTop === firstRowTop).length;
}

export default function MainMenu() {
  const setScreen = useGameStore((s) => s.setScreen);
  const setSettingsOpen = useGameStore((s) => s.setSettingsOpen);
  const compact = useMediaQuery(COMPACT_QUERY);
  const entryRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Keyboard-first: the menu is usable the moment it appears (unless a dialog owns the focus).
  useEffect(() => {
    if (useGameStore.getState().settingsOpen) return;
    entryRefs.current[0]?.focus({ preventScroll: true });
  }, []);

  const activate = (entry: MenuEntry) => {
    if (entry.target === 'settings') setSettingsOpen(true);
    else setScreen(entry.target);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // A key that is still held from the previous screen must not pick an entry by auto-repeat.
    if (e.key === 'Enter' && e.repeat) {
      e.preventDefault();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const buttons = entryRefs.current.filter((b): b is HTMLButtonElement => b !== null);
    const current = buttons.findIndex((b) => b === document.activeElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (isArrowKey(e.key)) next = gridStep(current, e.key, buttons.length, columnCount(buttons));
    else return;
    e.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div className="menu" data-testid="main-menu">
      <div className="menu-panel fac-panel">
        <header className="menu-title">
          <BrandMark height={54} className="menu-title__mark" />
          <div className="menu-title__text">
            <h1 className="menu-title__name">
              <span>FLYING</span> <span>AIRCRAFT CARRIER</span>
            </h1>
            <p className="menu-title__ship">
              <span className="menu-title__ship-name">
                {SHIP.name} · {SHIP.hullNumber}
              </span>
              <span className="menu-title__ship-class">{SHIP.className}</span>
            </p>
          </div>
        </header>

        <p className="menu-pitch">{PITCH}</p>

        <nav className="menu-entries" aria-label="Main menu" onKeyDown={onKeyDown}>
          {ENTRIES.map((entry, i) => (
            <button
              key={entry.testId}
              ref={(el) => {
                entryRefs.current[i] = el;
              }}
              type="button"
              className="menu-entry"
              data-testid={entry.testId}
              style={{ animationDelay: `${140 + i * 55}ms` }}
              onClick={() => activate(entry)}
              // one highlight for mouse and keyboard: hovering an entry moves the focus to it
              onPointerMove={(e) => {
                if (e.pointerType === 'mouse' && document.activeElement !== e.currentTarget) {
                  e.currentTarget.focus({ preventScroll: true });
                }
              }}
            >
              <span className="menu-entry__icon">
                <entry.Icon size={22} />
              </span>
              <span className="menu-entry__text">
                <span className="menu-entry__title">{entry.title}</span>
                <span className="menu-entry__desc">{entry.description}</span>
              </span>
              <IconChevronRight size={16} className="menu-entry__chevron" />
            </button>
          ))}
        </nav>

        <ControlsCheatSheet collapsible={compact} />
      </div>
    </div>
  );
}
