/**
 * Main menu (PLAN_A10.md §11): Fly now, the three weapons-range events (with their conditions
 * and the Range options dialog: wind, turbulence, the lane column's speed), Loadout, Settings
 * and Credits, each with a line saying what it is. Arrow keys move between the entries by where
 * they are on screen (a list on desktop, rows of tiles on a phone), Enter or a click opens one;
 * hovering an entry moves the focus to it so mouse and keyboard share one highlight. The 3D
 * scene keeps rendering behind the panel.
 */
import { useEffect, useRef, type ComponentType, type KeyboardEvent } from 'react';
import { IconChevronRight, IconSliders, type IconProps } from '../../engine';
import type { ScenarioKind } from '../core/types';
import { beginFlight } from '../state/flow';
import { useA10Store } from '../state/store';
import A10Mark from './A10Mark';
import { IconBook, IconJet, IconLane, IconPylons, IconReticle, IconRings } from './icons';
import { CUSTOM_ID, CUSTOM_NAME } from './customLoadout';
import { humanizeId, loadoutPresets } from './loadout';
import { describeRangeOptions } from './rangeOptions';
import { REALISM_INFO } from './realism';
import { spatialStep, type NavKey } from './spatialNav';
import { useA10Ui } from './uiStore';

type Target = { scenario: ScenarioKind } | 'loadout' | 'settings' | 'credits';

interface Entry {
  testId: string;
  title: string;
  line: string;
  Icon: ComponentType<IconProps>;
  target: Target;
  variant?: 'primary' | 'range';
}

const FLY: Entry = {
  testId: 'a10-fly',
  title: 'Fly now',
  line: 'Free hunt: an air start near armour, weapons loaded, no time limit.',
  Icon: IconJet,
  target: { scenario: 'freeHunt' },
  variant: 'primary',
};

const RANGE: readonly Entry[] = [
  {
    testId: 'a10-range-strafe',
    title: 'Strafe pit',
    line: 'Gun passes on scoring panels, with fouls.',
    Icon: IconReticle,
    target: { scenario: 'strafePit' },
    variant: 'range',
  },
  {
    testId: 'a10-range-bomb',
    title: 'Bombing circle',
    line: 'Miss distance and clock of every bomb.',
    Icon: IconRings,
    target: { scenario: 'bombCircle' },
    variant: 'range',
  },
  {
    testId: 'a10-range-lane',
    title: 'Tactical lane',
    line: 'Hulks and a column for guided weapons.',
    Icon: IconLane,
    target: { scenario: 'tacticalLane' },
    variant: 'range',
  },
];

const MORE: readonly Entry[] = [
  {
    testId: 'a10-loadout',
    title: 'Loadout',
    line: 'Eleven stations, presets, weight and drag.',
    Icon: IconPylons,
    target: 'loadout',
  },
  {
    testId: 'a10-settings',
    title: 'Settings',
    line: 'Graphics, sound, realism and controls.',
    Icon: IconSliders,
    target: 'settings',
  },
  {
    testId: 'a10-credits',
    title: 'Credits',
    line: 'The licence and the FlightGear A-10.',
    Icon: IconBook,
    target: 'credits',
  },
];

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function activate(target: Target): void {
  const store = useA10Store.getState();
  if (target === 'settings') store.setSettingsOpen(true);
  else if (target === 'loadout' || target === 'credits') store.setScreen(target);
  else {
    store.setScenario(target.scenario);
    void beginFlight();
  }
}

export default function MainMenu() {
  const loadoutId = useA10Store((s) => s.loadoutId);
  const realism = useA10Store((s) => s.settings.realism);
  const rangeOptions = useA10Ui((s) => s.rangeOptions);
  const navRef = useRef<HTMLElement>(null);
  const loadoutName =
    loadoutId === CUSTOM_ID
      ? CUSTOM_NAME
      : (loadoutPresets().find((p) => p.id === loadoutId)?.name ?? humanizeId(loadoutId));

  // Keyboard first: the menu is usable the moment it appears (unless a dialog has the focus).
  useEffect(() => {
    if (useA10Store.getState().settingsOpen) return;
    navRef.current?.querySelector<HTMLButtonElement>('.a10-entry')?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // a key still held from the previous screen must not pick an entry by auto-repeat
    if (e.key === 'Enter' && e.repeat) {
      e.preventDefault();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const buttons = [...(navRef.current?.querySelectorAll<HTMLButtonElement>('.a10-entry') ?? [])];
    const current = buttons.findIndex((b) => b === document.activeElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (NAV_KEYS.has(e.key))
      next = spatialStep(
        buttons.map((b) => b.getBoundingClientRect()),
        current,
        e.key as NavKey,
      );
    else return;
    e.preventDefault();
    buttons[next]?.focus();
  };

  const entry = (en: Entry, i: number) => (
    <button
      key={en.testId}
      type="button"
      className={`a10-entry${en.variant ? ` a10-entry--${en.variant}` : ''}`}
      data-testid={en.testId}
      style={{ animationDelay: `${120 + i * 45}ms` }}
      onClick={() => activate(en.target)}
      onPointerMove={(e) => {
        if (e.pointerType === 'mouse' && document.activeElement !== e.currentTarget)
          e.currentTarget.focus({ preventScroll: true });
      }}
    >
      <span className="a10-entry__icon">
        <en.Icon size={en.variant === 'primary' ? 24 : 20} />
      </span>
      <span className="a10-entry__text">
        <span className="a10-entry__title">{en.title}</span>
        <span className="a10-entry__line">{en.line}</span>
      </span>
      <IconChevronRight size={16} className="a10-entry__chevron" />
    </button>
  );

  return (
    <div className="a10-menu" data-testid="a10-menu">
      <div className="a10-menu__panel fac-panel">
        <header className="a10-menu__title">
          <A10Mark size={56} className="a10-menu__mark" />
          <div>
            <p className="fac-label a10-menu__kicker">Close air support simulator</p>
            <h1 className="a10-menu__name">A-10C Warthog</h1>
          </div>
        </header>

        <div className="a10-menu__status">
          <button
            type="button"
            className="a10-chip"
            data-testid="a10-menu-loadout-chip"
            onClick={() => activate('loadout')}
          >
            <span className="a10-chip__key">Loadout</span>
            {loadoutName}
          </button>
          <button
            type="button"
            className="a10-chip"
            data-testid="a10-menu-realism-chip"
            onClick={() => {
              useA10Ui.getState().setSettingsSection('a10-set-realism');
              activate('settings');
            }}
          >
            <span className="a10-chip__key">Realism</span>
            {REALISM_INFO[realism].label}
          </button>
        </div>

        <nav
          className="a10-menu__entries"
          aria-label="Main menu"
          ref={navRef}
          onKeyDown={onKeyDown}
        >
          {entry(FLY, 0)}
          <div className="a10-menu__group" role="group" aria-labelledby="a10-range-title">
            <p className="a10-menu__group-title" id="a10-range-title">
              <span>Weapons range</span>
              <span className="a10-menu__group-line">Scored events for learning each weapon</span>
            </p>
            <div className="a10-menu__range">{RANGE.map((en, i) => entry(en, i + 1))}</div>
            <button
              type="button"
              className="a10-menu__conditions"
              data-testid="a10-range-options-open"
              title="Range options: wind, turbulence and the lane column's speed"
              onClick={() => useA10Ui.getState().setRangeOptionsOpen(true)}
            >
              <IconSliders size={14} className="a10-menu__conditions-icon" />
              <span className="a10-menu__conditions-text">
                <span className="a10-menu__conditions-key">Range options</span>{' '}
                <span data-testid="a10-range-conditions">{describeRangeOptions(rangeOptions)}</span>
              </span>
              <IconChevronRight size={14} className="a10-menu__conditions-chevron" />
            </button>
          </div>
          <div className="a10-menu__more">{MORE.map((en, i) => entry(en, i + 4))}</div>
        </nav>

        <p className="a10-menu__hint" aria-hidden="true">
          <kbd className="shell-key">↑</kbd>
          <kbd className="shell-key">↓</kbd> choose <kbd className="shell-key">Enter</kbd> open
        </p>
      </div>
    </div>
  );
}
