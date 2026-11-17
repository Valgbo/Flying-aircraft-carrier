/**
 * The A-10C front panel's real-world dimensions and layouts (PLAN_A10.md §7: two multifunction
 * colour displays with twenty edge buttons each, the up-front controller and the armament panel
 * built into the FlightGear cockpit). OWNED BY THE COCKPIT MODULE.
 *
 * The cockpit module owns no file in src/a10/data, so its real-world constants live here, in the
 * same form (`as const` values plus a `*_NOTES` record with a source id from data/sources.ts and
 * a confidence). Where a public figure exists only in a source not yet in data/sources.ts, the
 * note names it and uses the closest listed source (see the module report). Where the panel
 * meets the FlightGear A-10A cockpit (positions of the panels on its instrument panel), the
 * values are fitted to the converted model and marked `estimate` with source flightgearA10.
 */
import type { SourceNote } from '../../data/sources';

const IN = 0.0254;

/**
 * Multifunction colour display (MFCD), one each side of the flight instruments. Face frame of a
 * display: origin at the screen centre on the bezel's front face, +X right, +Y up, +Z toward the
 * pilot; metres.
 */
export const MFCD = {
  /** Active screen area, square, m (4.90 in; nominal "5 × 5 inch"). */
  screen: 4.9 * IN,
  /** Outer bezel, square, m. */
  bezel: 0.171,
  /** How far the housing stands proud of the instrument panel, m. */
  depth: 0.024,
  /** The screen glass sits this far behind the bezel's front face, m. */
  recess: 0.0035,
  /** Option-select buttons: 5 per side, centre-to-centre pitch along the screen edge, m. */
  osbPitch: 0.0235,
  osbPerSide: 5,
  /** Button cap: width along the edge, height across it, and how far it stands out, m. */
  osbCap: { along: 0.0128, across: 0.0105, height: 0.0055 },
  /** A press pushes the cap in this far, m, for this long (s), then it springs back. */
  osbTravel: 0.0028,
  osbPressTime: 0.16,
} as const;

export const MFCD_NOTES: Record<keyof typeof MFCD, SourceNote> = {
  screen: {
    source: 'plan',
    confidence: 'approximate',
    note: 'Two 5 x 5 inch MFCDs (Defense Industry Daily "A Higher-Tech Hog"; Warthog News, "Identifying the upgraded A-10C"); an article quoted on the DCS forum gives 4.90 x 4.90 in of active area',
  },
  bezel: {
    source: 'plan',
    confidence: 'approximate',
    note: 'About 171 mm square: a home-cockpit builder measured 178 mm on the DCS model and found it about 4 % oversize (DCS forum, "A-10C cockpit model size")',
  },
  depth: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: 'fitted to clear the A-10A instruments it covers',
  },
  recess: { source: 'plan', confidence: 'estimate' },
  osbPitch: {
    source: 'dcsA10Manual',
    confidence: 'estimate',
    note: '20 OSBs, five per side, numbered 1-20 clockwise from the top left; pitch fitted to the 4.90 in screen edge',
  },
  osbPerSide: { source: 'dcsA10Manual', confidence: 'confirmed' },
  osbCap: { source: 'plan', confidence: 'estimate' },
  osbTravel: { source: 'plan', confidence: 'estimate' },
  osbPressTime: { source: 'plan', confidence: 'estimate' },
};

/**
 * Where the two MFCDs sit on the FlightGear A-10A instrument panel (BODY frame, m): the right
 * one over the A-10A's television monitor, the left one at its mirror image left of the airspeed
 * indicator — over the A-10A's standby attitude indicator, angle-of-attack gauge, clock and HUD
 * control panel, which the A-10C does not have there. Both lean back by the panel's 5° slope.
 */
export const MFCD_MOUNT = {
  /** Screen centre, x (± for right / left), y and the bezel face's z at the centre. */
  x: 0.24,
  y: 0.868,
  z: -5.226,
  /** The panel's slope: the top of each display leans toward the nose, rad. */
  tilt: (5 * Math.PI) / 180,
} as const;

export const MFCD_MOUNT_NOTES: Record<keyof typeof MFCD_MOUNT, SourceNote> = {
  x: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: 'clear of the altimeter (right) and the airspeed indicator (left); covers the standby ADI fully',
  },
  y: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: 'clear of the engine gauges below; covers the A-10A master caution lamp, as the A-10C moved it to the UFC',
  },
  z: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: 'proud of the instrument bezels it covers',
  },
  tilt: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: "the instruments' p = -5° mounting",
  },
};

/**
 * Armament HUD control panel (AHCP): ten toggle switches in two rows on the front panel below
 * the left MFCD, where the A-10A's armament control panel was. Face frame as the MFCD's.
 */
export const AHCP = {
  /** Plate size, m (it covers the A-10A armament control panel's face). */
  width: 0.226,
  height: 0.17,
  /** Housing depth proud of the panel, m (the A-10A release knob under it stands 2 cm out). */
  depth: 0.024,
  /** Centre of the plate (BODY) and its slope (top toward the nose), m / rad. */
  centre: { x: -0.19, y: 0.6923, z: -5.21 },
  tilt: (5 * Math.PI) / 180,
  /** Switch rows: centre heights on the plate, m; the five columns' pitch, m. */
  rowY: [0.046, -0.012] as readonly number[],
  columnPitch: 0.04,
  /** Toggle lever throw from the centre position, rad. */
  leverThrow: (26 * Math.PI) / 180,
} as const;

export const AHCP_NOTES: Record<keyof typeof AHCP, SourceNote> = {
  width: { source: 'flightgearA10', confidence: 'estimate', note: 'covers the A-10A ACP face' },
  height: { source: 'flightgearA10', confidence: 'estimate', note: 'covers the A-10A ACP face' },
  depth: { source: 'flightgearA10', confidence: 'estimate', note: 'covers the A-10A release knob' },
  centre: {
    source: 'dcsA10Manual',
    confidence: 'approximate',
    note: "the AHCP is on the front dash below the left MFCD, in the A-10A armament panel's place",
  },
  tilt: { source: 'flightgearA10', confidence: 'estimate' },
  rowY: {
    source: 'dcsA10Manual',
    confidence: 'approximate',
    note: 'top row MASTER ARM, GUN/PAC, LASER ARM, TGP, ALT SCE; bottom row HUD DAY/NIGHT, HUD NORM/STBY, CICU, JTRS, IFFCC',
  },
  columnPitch: { source: 'plan', confidence: 'estimate' },
  leverThrow: { source: 'plan', confidence: 'estimate' },
};

/**
 * Up-front controller (UFC): the keypad under the HUD, in place of the A-10A's small altitude-
 * alert panel there. The real unit is larger; here it keeps that panel's footprint so that it
 * hides no more of the HUD glass than the A-10A panel did (its top edge stays at the same angle
 * below the eye, ≈ 11°). Face frame as the MFCD's.
 */
export const UFC = {
  width: 0.226,
  height: 0.044,
  depth: 0.022,
  /** Centre (BODY) and slope: the face leans back toward the pilot's eye, rad. */
  centre: { x: 0, y: 1.028, z: -5.228 },
  tilt: (20.4 * Math.PI) / 180,
  /** Key pitch across and up the face, m; key cap size; travel when pressed. */
  pitchX: 0.0136,
  pitchY: 0.0136,
  key: { w: 0.0112, h: 0.01, height: 0.0045 },
  keyTravel: 0.0022,
} as const;

export const UFC_NOTES: Record<keyof typeof UFC, SourceNote> = {
  width: { source: 'flightgearA10', confidence: 'estimate', note: "the A-10A panel's footprint" },
  height: { source: 'flightgearA10', confidence: 'estimate', note: "the A-10A panel's footprint" },
  depth: { source: 'plan', confidence: 'estimate' },
  centre: {
    source: 'dcsA10Manual',
    confidence: 'approximate',
    note: 'below the HUD, at the top of the front panel; fitted to the FlightGear glareshield',
  },
  tilt: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: "the A-10A panel's face slope (normal 0, 0.348, 0.937)",
  },
  pitchX: { source: 'plan', confidence: 'estimate' },
  pitchY: { source: 'plan', confidence: 'estimate' },
  key: { source: 'plan', confidence: 'estimate' },
  keyTravel: { source: 'plan', confidence: 'estimate' },
};

/**
 * The LASTE control panel on the front of the left console, as the FlightGear cockpit models it:
 * EAC (ARM/OFF, guarded), RDR ALTM (NORM/DIS), the autopilot's ENGAGE/DISENGAGE button and its
 * PATH – ALT/HDG – ALT mode switch. The A-10C's low-altitude autopilot is worked from here, so
 * the cockpit's two autopilot controls are the model's own button and lever (laste.ts). Their
 * parts are merged into the cockpit's static mesh; positions measured on the converted model,
 * BODY frame, m (cockpit.ac objects LASTE_AP_Engage and LASTE_AP_Switch).
 */
export const LASTE = {
  /** The ENGAGE/DISENGAGE button: its axis (x, z), the top of its cap (y), the cap's radius. */
  button: { x: -0.3431, z: -4.8107, top: 0.4185, radius: 0.0031 },
  /**
   * The mode switch's lever: its axis (x, z), the pivot height (the top of the switch's bezel:
   * only what is above it moves), the tip height and the bat's radius.
   */
  lever: { x: -0.3121, z: -4.8104, pivot: 0.416, tip: 0.4298, radius: 0.004 },
  /**
   * Lever throw either side of the centre position, rad. The stencils read from the seat:
   * PATH is the forward position (toward the nose), ALT/HDG the centre, ALT aft.
   */
  leverThrow: (25 * Math.PI) / 180,
  /** A click pushes the button cap in this far, m, for this long, s (as an OSB). */
  buttonTravel: 0.0015,
  buttonPressTime: 0.16,
} as const;

export const LASTE_NOTES: Record<keyof typeof LASTE, SourceNote> = {
  button: {
    source: 'flightgearA10',
    confidence: 'confirmed',
    note: 'measured on Models/Cockpit/cockpit.ac (LASTE_AP_Engage); the panel stencil reads ENGAGE/DISENGAGE under AUTOPILOT',
  },
  lever: {
    source: 'flightgearA10',
    confidence: 'confirmed',
    note: 'measured on Models/Cockpit/cockpit.ac (LASTE_AP_Switch, LASTE_SW_Bases); stencil PATH / ALT/HDG / ALT',
  },
  leverThrow: { source: 'plan', confidence: 'estimate', note: 'as the AHCP toggles' },
  buttonTravel: { source: 'plan', confidence: 'estimate' },
  buttonPressTime: { source: 'plan', confidence: 'estimate' },
};
