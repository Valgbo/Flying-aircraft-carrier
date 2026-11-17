/**
 * Drawing primitives of the display pages, in page units (mfdLayout.ts), onto a stroke sink with
 * a colour register: the HUD's GPU line batch (view/hud/lineBatch.ts) in the cockpit, a
 * recorder in tests. Text uses the HUD's stroke font. Nothing here allocates per call.
 */
import { TextBuf } from '../hud/hudMath';
import { ALIGN_CENTER, drawText, textWidth, type SegmentSink } from '../hud/strokeFont';

/** A stroke sink with a colour register (palette index, mfdLayout.ts MFD_COLOR). */
export interface ColorSink extends SegmentSink {
  color: number;
}

/** Optional record of every text drawn (tests; allocates). */
export type PageTextLog = (text: string, x: number, y: number, color: number) => void;

const CIRCLE_N = 40;
const COS = new Float64Array(CIRCLE_N + 1);
const SIN = new Float64Array(CIRCLE_N + 1);
for (let i = 0; i <= CIRCLE_N; i++) {
  COS[i] = Math.cos((i / CIRCLE_N) * Math.PI * 2);
  SIN[i] = Math.sin((i / CIRCLE_N) * Math.PI * 2);
}

export class MfdPainter {
  readonly buf = new TextBuf(64);
  /** Strokes written since `reset`. */
  count = 0;
  log: PageTextLog | undefined;
  private sink: ColorSink;

  /** Counts the strokes the stroke font writes. */
  private readonly counting: SegmentSink = {
    seg: (x0, y0, x1, y1, w, i) => {
      this.sink.seg(x0, y0, x1, y1, w, i);
      this.count++;
    },
  };

  constructor(sink: ColorSink) {
    this.sink = sink;
  }

  /** Start a page on `sink` (the batch's frame, or a test recorder). */
  reset(sink: ColorSink, log?: PageTextLog): void {
    this.sink = sink;
    this.log = log;
    this.count = 0;
  }

  color(index: number): this {
    this.sink.color = index;
    return this;
  }

  get currentColor(): number {
    return this.sink.color;
  }

  seg(x0: number, y0: number, x1: number, y1: number, w = 1, i = 1): void {
    this.sink.seg(x0, y0, x1, y1, w, i);
    this.count++;
  }

  /** Draw the text buffer with its anchor at (x, y): vertical middle of the capitals. */
  text(x: number, y: number, size: number, align = ALIGN_CENTER, w = 1): void {
    const b = this.buf;
    if (b.len === 0) return;
    drawText(this.counting, b.codes, b.len, x, y, size, align, w, 1);
    if (this.log) this.log(b.toString(), x, y, this.sink.color);
  }

  /** Draw a string (constant labels; no allocation). */
  str(s: string, x: number, y: number, size: number, align = ALIGN_CENTER, w = 1): void {
    this.buf.clear().str(s);
    this.text(x, y, size, align, w);
  }

  /** Draw characters [start, end) of a string (no allocation). */
  strRange(
    s: string,
    start: number,
    end: number,
    x: number,
    y: number,
    size: number,
    align = ALIGN_CENTER,
  ): void {
    const b = this.buf.clear();
    for (let i = start; i < end && i < s.length; i++) {
      const c = s.charCodeAt(i);
      b.ch(c < 256 ? c : 63);
    }
    this.text(x, y, size, align);
  }

  /** Width of the text buffer at a cap height. */
  width(size: number): number {
    return textWidth(this.buf.len, size);
  }

  /** Axis-aligned rectangle; dashed with `n` dashes per side when n > 0. */
  box(x0: number, y0: number, x1: number, y1: number, w = 1, n = 0): void {
    if (n > 0) {
      this.dashes(x0, y0, x1, y0, n, w);
      this.dashes(x1, y0, x1, y1, n, w);
      this.dashes(x1, y1, x0, y1, n, w);
      this.dashes(x0, y1, x0, y0, n, w);
      return;
    }
    this.seg(x0, y0, x1, y0, w);
    this.seg(x1, y0, x1, y1, w);
    this.seg(x1, y1, x0, y1, w);
    this.seg(x0, y1, x0, y0, w);
  }

  /** A box around the text buffer drawn at (x, y) with `align` (the inverse-video highlight). */
  boxText(x: number, y: number, size: number, align: number, w = 1): void {
    const tw = this.width(size);
    const pad = size * 0.32;
    const x0 = x - align * tw - pad;
    this.box(x0, y - size / 2 - pad, x0 + tw + 2 * pad, y + size / 2 + pad, w);
  }

  /** Dashed line with `n` dashes. */
  dashes(x0: number, y0: number, x1: number, y1: number, n: number, w = 1): void {
    const m = n * 2 - 1;
    for (let d = 0; d < m; d += 2) {
      const t0 = d / m;
      const t1 = (d + 1) / m;
      this.seg(
        x0 + (x1 - x0) * t0,
        y0 + (y1 - y0) * t0,
        x0 + (x1 - x0) * t1,
        y0 + (y1 - y0) * t1,
        w,
      );
    }
  }

  /** Circle; every other segment left out when dashed. */
  circle(cx: number, cy: number, r: number, dashed = false, w = 1): void {
    for (let k = 0; k < CIRCLE_N; k++) {
      if (dashed && k % 2 === 1) continue;
      this.seg(cx + r * COS[k], cy + r * SIN[k], cx + r * COS[k + 1], cy + r * SIN[k + 1], w);
    }
  }

  /** Diamond, half-diagonal h. */
  diamond(x: number, y: number, h: number, w = 1): void {
    this.seg(x, y + h, x + h, y, w);
    this.seg(x + h, y, x, y - h, w);
    this.seg(x, y - h, x - h, y, w);
    this.seg(x - h, y, x, y + h, w);
  }

  /** Corner brackets of a square (half-size h, arm length a): the area-track gate. */
  brackets(x: number, y: number, h: number, a: number, w = 1): void {
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        const cx = x + sx * h;
        const cy = y + sy * h;
        this.seg(cx, cy, cx - sx * a, cy, w);
        this.seg(cx, cy, cx, cy - sy * a, w);
      }
    }
  }
}
