/**
 * Line icons of the A-10 overlay (24-unit grid, drawn in currentColor, decorative). Generic ones
 * (chevrons, close, sliders) come from the shared shell through src/engine.
 */
import type { ReactNode } from 'react';
import type { IconProps } from '../../engine';

function Icon({ size = 20, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Fly now: the aircraft from above, nose up. */
export function IconJet(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.5v19M2.5 11.2l9.5-1.3 9.5 1.3v1.6l-9.5-.5-9.5.5zM7.5 19.2l4.5-.7 4.5.7" />
      <path d="M9.2 15.3h1.4M13.4 15.3h1.4" />
    </Icon>
  );
}

/** Strafe pit: a gun reticle. */
export function IconReticle(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Icon>
  );
}

/** Bombing circle: concentric rings with a mark. */
export function IconRings(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M15.7 7.3l2.6-2.6M17.4 4.7h1.9v1.9" />
    </Icon>
  );
}

/** Tactical lane: a road with a column on it. */
export function IconLane(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 21.5L10.2 2.5M16 21.5L13.8 2.5" />
      <rect x="10.4" y="13.5" width="3.2" height="3.6" rx=".6" />
      <rect x="10.9" y="6.8" width="2.4" height="2.8" rx=".5" />
    </Icon>
  );
}

/** Loadout: a wing with stores under the pylons. */
export function IconPylons(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 7h19" />
      <path d="M6 7v2.5M12 7v2.5M18 7v2.5" />
      <rect x="4.6" y="9.5" width="2.8" height="9" rx="1.4" />
      <rect x="10.6" y="9.5" width="2.8" height="11.5" rx="1.4" />
      <rect x="16.6" y="9.5" width="2.8" height="9" rx="1.4" />
    </Icon>
  );
}

/** Credits: an open book. */
export function IconBook(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 6.5C10 5 6.5 4.6 3 5.2v13.3c3.5-.6 7-.2 9 1.3 2-1.5 5.5-1.9 9-1.3V5.2c-3.5-.6-7-.2-9 1.3z" />
      <path d="M12 6.5v13.3" />
    </Icon>
  );
}

/** Rearm: a round. */
export function IconRound(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 21V10.5c0-3 1.3-6.3 3-8 1.7 1.7 3 5 3 8V21z" />
      <path d="M9 16h6" />
    </Icon>
  );
}

/** Restart: a circular arrow. */
export function IconRestart(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.3-5.4" />
      <path d="M4.5 3.8v3.6h3.6" />
    </Icon>
  );
}

/** Controls reference: a keyboard. */
export function IconKeyboard(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M9.3 10h.01M12.6 10h.01M15.9 10h.01M6 13.5h.01M18 10h.01M8.5 14.2h7" />
    </Icon>
  );
}

/** Debrief: a page with a chart line. */
export function IconDebrief(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M7.5 15.5l3-3.5 2.5 2 3.5-4.5" />
    </Icon>
  );
}

/** Exit: an arrow leaving a frame. */
export function IconExit(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14" />
      <path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5" />
    </Icon>
  );
}

/** Resume: a play triangle. */
export function IconPlay(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 5.5v13l10.5-6.5z" />
    </Icon>
  );
}
