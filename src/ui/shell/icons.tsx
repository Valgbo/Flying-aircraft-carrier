/**
 * Inline SVG icons for the shell UI. Line icons on a 24-unit grid, drawn in `currentColor`
 * so they follow the text colour of whatever they sit in. Decorative by default
 * (aria-hidden) — the control that holds an icon carries the accessible name.
 */
import type { ReactNode } from 'react';
import type { HotspotKind } from './hotspotContent';

export interface IconProps {
  /** Rendered width and height in px. */
  size?: number;
  className?: string;
}

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

export function IconChevronRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 5l7 7-7 7" />
    </Icon>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 9l7 7 7-7" />
    </Icon>
  );
}

export function IconArrowLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

/** Settings: three sliders. */
export function IconSliders(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h9M19 7h1M4 12h3M13 12h7M4 17h9M19 17h1" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="10" cy="12" r="2.2" />
      <circle cx="16" cy="17" r="2.2" />
    </Icon>
  );
}

/** Free flight: rising off the water. */
export function IconFlight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" />
      <path d="M3 20c1.5-1.4 3-1.4 4.5 0s3 1.4 4.5 0 3-1.4 4.5 0 3 1.4 4.5 0" />
    </Icon>
  );
}

/** Flight ops: a jet seen from above. */
export function IconOps(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.5l1.6 7.2 7.4 5.1v1.9l-7.2-1.8-.5 3.9 2.2 1.7v1.5L12 21l-3.5 1v-1.5l2.2-1.7-.5-3.9L3 16.7v-1.9l7.4-5.1L12 2.5z" />
    </Icon>
  );
}

/** Hangar: the ship as an object to walk around. */
export function IconHangar(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </Icon>
  );
}

export function IconWarning(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4l9 15.5H3L12 4z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </Icon>
  );
}

function IconTurbine(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="1.9" />
      <path d="M12 10.1V5.2M13.65 12.95l4.25 2.45M10.35 12.95L6.1 15.4" />
    </Icon>
  );
}

function IconIsland(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20h16M7 20v-9h7v9M14 14h3.5v6M10.5 11V4.5M8.5 6.5h4" />
    </Icon>
  );
}

function IconCatapult(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 20V5M5 8l3-3 3 3M16 20V5M13 8l3-3 3 3" />
    </Icon>
  );
}

function IconArrestor(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 13h16M4 17h16M4 21h16" />
      <path d="M18.5 3.5L10 9.5M10 5.4v4.1h4.4" />
    </Icon>
  );
}

function IconElevator(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20h16M7 16.5h10" />
      <path d="M9 12.5V4M6.4 6.6L9 4l2.6 2.6M15 4v8.5M12.4 9.9L15 12.5l2.6-2.6" />
    </Icon>
  );
}

/** The icon of a hangar pin, by what the hotspot marks. */
export function HotspotIcon({ kind, ...props }: IconProps & { kind: HotspotKind }) {
  switch (kind) {
    case 'turbine':
      return <IconTurbine {...props} />;
    case 'island':
      return <IconIsland {...props} />;
    case 'catapult':
      return <IconCatapult {...props} />;
    case 'arrestor':
      return <IconArrestor {...props} />;
    case 'elevator':
      return <IconElevator {...props} />;
  }
}
