/**
 * Layout of the A-10C multifunction colour displays (MFCDs) (PLAN_A10.md §7 "Display pages",
 * §12; ARCHITECTURE §12.7), in PAGE units: x, y ∈ [−1, 1] over the square screen, x right, y up.
 * The twenty option-select buttons (OSBs) surround the screen: 1–5 along the top (left to
 * right), 6–10 down the right side, 11–15 along the bottom (right to left), 16–20 up the left
 * side; each button's label sits on the screen next to it. The cockpit module places its
 * clickable bezel buttons at `OSB_ANCHORS` (page units × half the screen size).
 */
import { Color } from 'three';
import type { StoreType } from '../../core/weapons/types';
import type { SourceNote } from '../../data/sources';

/** Render-target size of one display page, pixels (PLAN §14: the sensor pictures are 256–512). */
export const MFD_RESOLUTION = 512;

/** Stroke width at MFD_RESOLUTION, pixels. */
export const MFD_LINE_WIDTH = 1.7;

/** Palette indices (the line batch's palette; 0 is reserved for its style colour). */
export const MFD_COLOR = {
  green: 1,
  white: 2,
  cyan: 3,
  yellow: 4,
  red: 5,
  grey: 6,
  blue: 7,
} as const;

/** The display colours (sRGB hex; three converts them to linear). */
export const MFD_COLORS: Readonly<Record<keyof typeof MFD_COLOR, Color>> = {
  green: new Color(0x3cff58),
  white: new Color(0xe6efe6),
  cyan: new Color(0x52e4ff),
  yellow: new Color(0xffdf3c),
  red: new Color(0xff4a3a),
  grey: new Color(0x8c9585),
  blue: new Color(0x3d8bff),
};

/** Text sizes (cap height), page units. */
export const MFD_TEXT = {
  label: 0.052,
  body: 0.05,
  small: 0.04,
  large: 0.085,
} as const;

/** Where an OSB's label sits: anchor point and horizontal alignment (0 left … 1 right). */
export interface OsbAnchor {
  x: number;
  y: number;
  align: number;
  /** A side button (6–10, 16–20): two-line labels stack vertically. */
  side: boolean;
}

const SPACING = 0.32;
const EDGE = 0.975;
const ROW = 0.905;

/** Label anchors of OSBs 1–20 (index 0 unused). */
export const OSB_ANCHORS: readonly OsbAnchor[] = (() => {
  const a: OsbAnchor[] = [{ x: 0, y: 0, align: 0.5, side: false }];
  for (let n = 1; n <= 20; n++) {
    if (n <= 5) a.push({ x: -2 * SPACING + (n - 1) * SPACING, y: ROW, align: 0.5, side: false });
    else if (n <= 10) a.push({ x: EDGE, y: 2 * SPACING - (n - 6) * SPACING, align: 1, side: true });
    else if (n <= 15)
      a.push({ x: 2 * SPACING - (n - 11) * SPACING, y: -ROW, align: 0.5, side: false });
    else a.push({ x: -EDGE, y: -2 * SPACING + (n - 16) * SPACING, align: 0, side: true });
  }
  return a;
})();

/** The content area the pages draw in, clear of the OSB labels (page units). */
export const MFD_CONTENT = { left: -0.66, right: 0.66, bottom: -0.78, top: 0.8 } as const;

/** The sensor-of-interest box just inside the screen edge (page units). */
export const SOI_BOX = 0.985;

/**
 * How often each page is drawn again, Hz. Sensor pages follow the picture (the quality preset's
 * sensor rate); the map moves continuously; the text pages only redraw when what they show
 * changes (at most `text` Hz), and at least every `keepAlive` seconds.
 */
export const MFD_RATES = {
  tad: 15,
  text: 10,
  keepAlive: 1,
} as const;

/** Moving map (TAD). */
export const TAD = {
  /** Map ranges, nm (from the anchor to the top of the screen); the avionics' TAD_RANGES_NM. */
  ranges: [5, 10, 20, 40, 80, 160] as readonly number[],
  /** Default range, nm. */
  defaultRange: 20,
  /** Own aircraft (centred on own ship) or the SPI (centred on the SPI): page y of the anchor. */
  ownAnchorY: -0.45,
  /** The map is clipped to this square, page units. */
  clip: 0.97,
  /** A map line vertex is kept once it is this far (page units ≈ 1.5 px) from the last kept one. */
  decimate: 0.006,
} as const;

/**
 * Maverick seeker display: the pointing cross moves ±`gimbalScale` rad of seeker look angle
 * across ±0.85 of the screen.
 */
export const MAV_PAGE = {
  gimbalScale: (35 * Math.PI) / 180,
  /** Track gate half-size, page units, wide and narrow field of view. */
  gateWide: 0.11,
  gateNarrow: 0.07,
} as const;

/** Short names of the stores on the DSMS station row (≤ 4 characters). */
export const STORE_SHORT: Readonly<Record<StoreType, string>> = {
  'AGM-65D': '65D',
  'AGM-65H': '65H',
  'AGM-65G': '65G',
  'AGM-65K': '65K',
  'MK-82': 'M82',
  'MK-82AIR': '82A',
  'GBU-12': 'G12',
  'LAU-131-M151': 'M151',
  'LAU-131-M156': 'M156',
  'LAU-68-M151': 'M151',
  'LAU-68-M156': 'M156',
  'CBU-97': 'C97',
  'AN/AAQ-28': 'TGP',
  'AN/ALQ-184': 'ECM',
  'AIM-9M': '9M',
  'TER-9A': 'TER',
  'LAU-117': '117',
  'LAU-88': '88',
  'LAU-114': '114',
};

/** Where the page behaviours come from (ARCHITECTURE §5: sources). */
export const MFD_NOTES: Record<string, SourceNote> = {
  osbNumbering: {
    source: 'hoggitHud',
    confidence: 'approximate',
    note: 'OSB 1–20 clockwise from the top left (A-10C MFCD), labels beside the buttons',
  },
  soi: {
    source: 'hoggitHud',
    confidence: 'approximate',
    note: 'the SOI display has a green box round the page; sensor-capable pages that are not SOI say NOT SOI',
  },
  tgp: {
    source: 'wikiLitening',
    confidence: 'approximate',
    note: 'TGP page: track mode, field of view and zoom, picture mode; "T"/"L" with the range at the lower left ("L" while lasing), LTCH, laser code; M / MASK when masked; NOT TIMED OUT while warming up',
  },
  mav: {
    source: 'dcsMaverick',
    confidence: 'approximate',
    note: 'MAV page: the pointing cross shows the seeker line of sight relative to the boresight and flashes when tracking; track gate; IN RNG; NOT TIMED OUT during the ≈3 min alignment',
  },
  mavGimbalScale: {
    source: 'plan',
    confidence: 'estimate',
    note: 'display scale only (the seeker limits are the sensors module’s)',
  },
  tad: {
    source: 'hoggitHud',
    confidence: 'approximate',
    note: 'TAD: heading-up moving map, own ship depressed or centred on the SPI, ranges 5–160 nm; target areas only with the realism aid (PLAN §2)',
  },
  rates: {
    source: 'plan',
    confidence: 'estimate',
    note: 'PLAN §14: sensor pictures 15–30 Hz; the text pages redraw only on change',
  },
};
