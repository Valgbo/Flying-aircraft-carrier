/** Inline SVG icons of the HUD and the turbine panel. 24 × 24 grid, drawn with currentColor. */
import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="hud-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PauseIcon() {
  return (
    <Icon>
      <path d="M8.5 5v14M15.5 5v14" strokeWidth="2.6" />
    </Icon>
  );
}

/** A ducted fan seen along its axis: duct ring, hub and four blades. */
export function TurbineIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="1.8" />
      <path d="M12 10.2V4.6M13.8 12h5.6M12 13.8v5.6M10.2 12H4.6" />
    </Icon>
  );
}

export function CameraIcon() {
  return (
    <Icon>
      <path d="M3.5 8.5h3.2l1.6-2.5h7.4l1.6 2.5h3.2v10h-17z" />
      <circle cx="12" cy="13.2" r="3.2" />
    </Icon>
  );
}

/** Flight assist: a levelled deck line held inside a gimbal ring. */
export function AssistIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M5.5 12h4l2.5 3 2.5-3h4" />
      <path d="M12 3.5v2.4" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

export function KeyboardIcon() {
  return (
    <Icon>
      <rect x="2.8" y="6.5" width="18.4" height="11" rx="2" />
      <path d="M6.5 10.2h.01M10 10.2h.01M13.5 10.2h.01M17 10.2h.01M7.5 14h9" />
    </Icon>
  );
}

export function EyeIcon() {
  return (
    <Icon>
      <path d="M2.5 12s3.6-6 9.5-6 9.5 6 9.5 6-3.6 6-9.5 6-9.5-6-9.5-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </Icon>
  );
}
