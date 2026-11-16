/**
 * The HUD's stroke font: every character is a few straight strokes, as a HUD's
 * stroke-written display draws them, so text stays sharp at any resolution and zoom.
 *
 * Glyphs live on a 4 × 6 grid (x right, y up, baseline at 0, cap height 6). Points and colons
 * are tiny closed squares, so they grow with the text when zoomed; a stroke with a single point
 * would be a round dot. Upper case, digits and the punctuation the HUD needs; lower case draws
 * as upper case and unknown characters as '?'.
 */

/** Anything that accepts line segments in HUD-plane coordinates (the GPU line batch, tests). */
export interface SegmentSink {
  /**
   * One stroke from (x0, y0) to (x1, y1) in HUD-plane units. `width` scales the HUD line width
   * (a zero-length stroke is a round dot of that width); `intensity` scales the brightness.
   */
  seg(x0: number, y0: number, x1: number, y1: number, width: number, intensity: number): void;
}

/** Glyph cell: strokes are drawn inside 0..GLYPH_W × 0..GLYPH_H. */
export const GLYPH_W = 4;
export const GLYPH_H = 6;
/** Distance from one character to the next, glyph units. */
export const GLYPH_ADVANCE = 5.3;

/** Dots (single-point strokes) are drawn this much wider than strokes. */
const DOT_WIDTH = 1.7;

const SOURCE: Record<string, string> = {
  '0': '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0',
  '1': '1,5 2,6 2,0|1,0 3,0',
  '2': '0,5 1,6 3,6 4,5 4,3.8 0,0 4,0',
  '3': '0,5 1,6 3,6 4,5 4,4 3,3 4,2 4,1 3,0 1,0 0,1|1.4,3 3,3',
  '4': '3,0 3,6 0,2 4,2',
  '5': '4,6 0,6 0,3.4 3,3.4 4,2.4 4,1 3,0 1,0 0,1',
  '6': '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,2.4 3,3.4 0,3.4',
  '7': '0,6 4,6 4,5 1.5,0',
  '8': '1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3',
  '9': '0,1 1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,3.6 1,2.6 4,2.6',
  A: '0,0 0,4.5 1.5,6 2.5,6 4,4.5 4,0|0,2.6 4,2.6',
  B: '0,0 0,6 3,6 4,5 4,4 3,3 0,3|3,3 4,2 4,1 3,0 0,0',
  C: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1',
  D: '0,0 0,6 2.6,6 4,4.6 4,1.4 2.6,0 0,0',
  E: '4,6 0,6 0,0 4,0|0,3 3,3',
  F: '4,6 0,6 0,0|0,3 3,3',
  G: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,2.8 2.2,2.8',
  H: '0,0 0,6|4,0 4,6|0,3 4,3',
  I: '1,6 3,6|2,6 2,0|1,0 3,0',
  J: '4,6 4,1 3,0 1,0 0,1',
  K: '0,0 0,6|4,6 0,2|1.4,3.4 4,0',
  L: '0,6 0,0 4,0',
  M: '0,0 0,6 2,3 4,6 4,0',
  N: '0,0 0,6 4,0 4,6',
  O: '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0',
  P: '0,0 0,6 3,6 4,5 4,4 3,3 0,3',
  Q: '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|2.5,1.5 4,0',
  R: '0,0 0,6 3,6 4,5 4,4 3,3 0,3|2,3 4,0',
  S: '4,5 3,6 1,6 0,5 0,4 1,3 3,3 4,2 4,1 3,0 1,0 0,1',
  T: '0,6 4,6|2,6 2,0',
  U: '0,6 0,1 1,0 3,0 4,1 4,6',
  V: '0,6 2,0 4,6',
  W: '0,6 1,0 2,3.5 3,0 4,6',
  X: '0,0 4,6|0,6 4,0',
  Y: '0,6 2,3 4,6|2,3 2,0',
  Z: '0,6 4,6 0,0 4,0',
  '.': '1.65,0 2.35,0 2.35,0.7 1.65,0.7 1.65,0',
  ':': '1.65,1 2.35,1 2.35,1.7 1.65,1.7 1.65,1|1.65,4 2.35,4 2.35,4.7 1.65,4.7 1.65,4',
  '/': '0,0 4,6',
  '-': '0.6,3 3.4,3',
  '+': '0.6,3 3.4,3|2,1.6 2,4.4',
  ',': '2.2,0.4 1.4,-1',
  '*': '2,1.5 2,4.5|0.7,2.25 3.3,3.75|0.7,3.75 3.3,2.25',
  '<': '3.5,5 0.5,3 3.5,1',
  '>': '0.5,5 3.5,3 0.5,1',
  '(': '2.8,6.5 1.6,5 1.6,1 2.8,-0.5',
  ')': '1.2,6.5 2.4,5 2.4,1 1.2,-0.5',
  '^': '0.6,3.6 2,6 3.4,3.6',
  _: '0,-0.6 4,-0.6',
  '=': '0.6,2 3.4,2|0.6,4 3.4,4',
  "'": '2,6 2,4.6',
  '#': '1.2,0 1.6,6|2.4,0 2.8,6|0.3,2 3.9,2|0.1,4 3.7,4',
  '?': '0,5 1,6 3,6 4,5 4,4 2,2.6 2,1.6|1.65,0 2.35,0 2.35,0.7 1.65,0.7 1.65,0',
  '!': '2,6 2,1.8|1.65,0 2.35,0 2.35,0.7 1.65,0.7 1.65,0',
  '°': '1.5,6 2.5,6 3,5.5 3,4.5 2.5,4 1.5,4 1,4.5 1,5.5 1.5,6',
};

/**
 * Compiled glyphs, indexed by char code: x0, y0, x1, y1 per stroke, in glyph units
 * (a dot repeats its point). Built once at module load.
 */
const GLYPHS: (Float32Array | null)[] = new Array(256).fill(null);

function compile(): void {
  for (const [ch, src] of Object.entries(SOURCE)) {
    const out: number[] = [];
    for (const stroke of src.split('|')) {
      const pts = stroke
        .trim()
        .split(/\s+/)
        .map((p) => p.split(',').map(Number));
      if (pts.length === 1) out.push(pts[0][0], pts[0][1], pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++)
        out.push(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    GLYPHS[ch.charCodeAt(0)] = new Float32Array(out);
  }
  // Lower case draws as upper case.
  for (let c = 97; c <= 122; c++) GLYPHS[c] = GLYPHS[c - 32];
}
compile();

const QUESTION = 63;
const SPACE = 32;

/** Strokes of a character (null for a space). Unknown characters draw as '?'. */
export function glyph(code: number): Float32Array | null {
  if (code === SPACE) return null;
  return GLYPHS[code & 255] ?? GLYPHS[QUESTION];
}

/** Width of a run of `count` characters at cap height `size` (HUD-plane units). */
export function textWidth(count: number, size: number): number {
  if (count <= 0) return 0;
  return ((count - 1) * GLYPH_ADVANCE + GLYPH_W) * (size / GLYPH_H);
}

/** Horizontal alignment of a text anchor. */
export const ALIGN_LEFT = 0;
export const ALIGN_CENTER = 0.5;
export const ALIGN_RIGHT = 1;

/**
 * Draw characters `codes[0..len)` with cap height `size`. The anchor (x, y) is at the
 * vertical middle of the capitals; `align` 0 = left edge, 0.5 = centre, 1 = right edge.
 * (ux, uy) is the unit direction of the text baseline (default: horizontal), so text can be
 * rotated, e.g. with the pitch ladder.
 */
export function drawText(
  sink: SegmentSink,
  codes: Uint8Array,
  len: number,
  x: number,
  y: number,
  size: number,
  align: number,
  width = 1,
  intensity = 1,
  ux = 1,
  uy = 0,
): void {
  const k = size / GLYPH_H;
  const startX = -align * textWidth(len, size);
  const startY = -size / 2;
  // Text axes: baseline (ux, uy), up (-uy, ux).
  for (let i = 0; i < len; i++) {
    const g = glyph(codes[i]);
    if (!g) continue;
    const ox = startX + i * GLYPH_ADVANCE * k;
    for (let j = 0; j < g.length; j += 4) {
      const ax = ox + g[j] * k;
      const ay = startY + g[j + 1] * k;
      const bx = ox + g[j + 2] * k;
      const by = startY + g[j + 3] * k;
      const dot = g[j] === g[j + 2] && g[j + 1] === g[j + 3];
      sink.seg(
        x + ax * ux - ay * uy,
        y + ax * uy + ay * ux,
        x + bx * ux - by * uy,
        y + bx * uy + by * ux,
        dot ? width * DOT_WIDTH : width,
        intensity,
      );
    }
  }
}
