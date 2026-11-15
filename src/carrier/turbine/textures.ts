/**
 * Procedural textures of the turbines (canvas / data textures — no image assets):
 *
 *   paint atlas  — one tile of the duct's outer skin (hazard band on the intake lip, accent
 *                  lines, panel seams, nozzle petals), one tile of the inner liner, and a plain
 *                  white band that the vertex-coloured parts sample. Repeats around the duct.
 *   number atlas — the four turbine numbers, stencilled.
 *   blur streaks — density / brightness of the motion-blurred fan disc.
 */
import {
  CanvasTexture,
  DataTexture,
  LinearFilter,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { TURBINE } from '../../config/layout';
import { PALETTE } from '../../config/palette';
import { mulberry32 } from '../../utils/math';
import {
  ATLAS_LINER_ROWS,
  ATLAS_SKIN_ROWS,
  DUCT_OUTER_PROFILE,
  profileArcFractions,
} from './model';

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return [canvas, ctx];
}

export function createPaintAtlas(size: number): CanvasTexture {
  const [canvas, ctx] = makeCanvas(size, size);
  const rand = mulberry32(7);
  const skinH = size * ATLAS_SKIN_ROWS;
  const linerH = size * ATLAS_LINER_ROWS;
  const px = size / 512;

  // skin rows follow the outer profile from the lip crest (top) to the inner exit edge
  const f = profileArcFractions(DUCT_OUTER_PROFILE, true);
  const row = (fraction: number) => fraction * skinH;
  const crestEnd = row(f[6]);
  const lipEnd = row(f[4]);
  const midEnd = row(f[3]);
  const taperEnd = row(f[2]);
  const exitLip = row(f[1]);

  ctx.fillStyle = PALETTE.machinery;
  ctx.fillRect(0, 0, size, skinH);

  // heat-stained nozzle: darker toward the exit
  const heat = ctx.createLinearGradient(0, midEnd, 0, exitLip);
  heat.addColorStop(0, 'rgba(34,39,44,0.15)');
  heat.addColorStop(0.45, 'rgba(34,39,44,0.55)');
  heat.addColorStop(1, 'rgba(26,22,20,0.95)');
  ctx.fillStyle = heat;
  ctx.fillRect(0, midEnd, size, exitLip - midEnd);
  ctx.fillStyle = '#17191b';
  ctx.fillRect(0, exitLip, size, skinH - exitLip);

  // wear speckle
  for (let i = 0; i < 900; i++) {
    const shade = rand() < 0.5 ? '0,0,0' : '255,255,255';
    ctx.fillStyle = `rgba(${shade},${0.03 + rand() * 0.05})`;
    ctx.fillRect(rand() * size, rand() * exitLip, (1 + rand() * 5) * px, (1 + rand() * 9) * px);
  }

  // bare-metal leading edge on the crest of the lip
  ctx.fillStyle = '#7d8790';
  ctx.fillRect(0, 0, size, crestEnd);

  // hazard band around the intake lip: yellow with dark diagonals that wrap seamlessly
  const bandTop = crestEnd + 2 * px;
  const bandH = lipEnd - bandTop - 3 * px;
  ctx.fillStyle = PALETTE.markingYellow;
  ctx.fillRect(0, bandTop, size, bandH);
  ctx.fillStyle = '#1b1d1f';
  const stripe = size / 8;
  for (let i = -1; i < 8; i++) {
    const x = i * stripe;
    ctx.beginPath();
    ctx.moveTo(x, bandTop + bandH);
    ctx.lineTo(x + stripe * 0.5, bandTop + bandH);
    ctx.lineTo(x + stripe * 0.5 + bandH, bandTop);
    ctx.lineTo(x + bandH, bandTop);
    ctx.closePath();
    ctx.fill();
  }

  // thin accent lines framing the mid-section
  ctx.fillStyle = PALETTE.glowCool;
  ctx.fillRect(0, lipEnd + 7 * px, size, 3 * px);
  ctx.fillStyle = PALETTE.markingWhite;
  ctx.fillRect(0, midEnd - 9 * px, size, 2 * px);

  // panel seams: one bay per tile with a centre seam, horizontal breaks at the section changes
  ctx.fillStyle = 'rgba(12,14,16,0.75)';
  const seam = Math.max(1, 2 * px);
  ctx.fillRect(0, lipEnd + 14 * px, seam, exitLip - lipEnd);
  ctx.fillRect(size - seam, lipEnd + 14 * px, seam, exitLip - lipEnd);
  ctx.fillRect(size / 2 - seam / 2, lipEnd + 14 * px, seam, midEnd - lipEnd - 28 * px);
  ctx.fillRect(0, midEnd, size, seam);
  ctx.fillRect(0, taperEnd, size, seam);
  // nozzle petals
  for (let i = 1; i < 6; i++) {
    ctx.fillRect((i * size) / 6 - seam / 2, taperEnd, seam, exitLip - taperEnd);
  }
  // access hatch and fasteners
  ctx.strokeStyle = 'rgba(12,14,16,0.7)';
  ctx.lineWidth = seam;
  ctx.strokeRect(size * 0.74, lipEnd + 30 * px, size * 0.2, (midEnd - lipEnd) * 0.34);
  ctx.fillStyle = 'rgba(200,208,214,0.5)';
  for (let i = 0; i < 12; i++) {
    const x = ((i + 0.5) * size) / 12;
    ctx.fillRect(x, midEnd + 6 * px, 2 * px, 2 * px);
    ctx.fillRect(x, lipEnd + 18 * px, 2 * px, 2 * px);
  }

  // inner liner: dark acoustic lining with ring joints, bright bellmouth, burnt nozzle
  const linerTop = skinH;
  const liner = ctx.createLinearGradient(0, linerTop, 0, linerTop + linerH);
  liner.addColorStop(0, '#59626a');
  liner.addColorStop(0.22, '#2c3238');
  liner.addColorStop(0.6, PALETTE.machineryDark);
  liner.addColorStop(1, '#141516');
  ctx.fillStyle = liner;
  ctx.fillRect(0, linerTop, size, linerH);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  for (const fraction of [0.24, 0.5, 0.74]) {
    ctx.fillRect(0, linerTop + linerH * fraction, size, Math.max(1, px));
  }
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  for (let i = 0; i < 16; i++) {
    ctx.fillRect(((i + 0.5) * size) / 16, linerTop + linerH * 0.28, px, linerH * 0.2);
  }

  // plain white for the vertex-coloured parts
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, linerTop + linerH, size, size - linerTop - linerH);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** Four square cells in a row, one stencilled number each (cell i = turbine i). */
export function createNumberAtlas(cellSize: number): CanvasTexture {
  const [canvas, ctx] = makeCanvas(cellSize * 4, cellSize);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 4; i++) {
    const cx = (i + 0.5) * cellSize;
    const cy = cellSize / 2;
    ctx.fillStyle = PALETTE.markingWhite;
    ctx.font = `bold ${Math.round(cellSize * 0.78)}px "Arial Narrow", Arial, Helvetica, sans-serif`;
    ctx.fillText(String(i + 1), cx - cellSize * 0.1, cy + cellSize * 0.03);
    // stencil bridges cut through the numeral
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillRect(i * cellSize, cy - cellSize * 0.035, cellSize, cellSize * 0.05);
    ctx.globalCompositeOperation = 'source-over';
    // unit bar and corner ticks in the accent colour
    ctx.fillStyle = PALETTE.glowCool;
    ctx.fillRect(cx + cellSize * 0.24, cy - cellSize * 0.3, cellSize * 0.07, cellSize * 0.6);
    ctx.fillStyle = PALETTE.markingWhite;
    const tick = cellSize * 0.12;
    const edge = cellSize * 0.06;
    const far = (i + 1) * cellSize - edge;
    const near = i * cellSize + edge;
    const w = Math.max(2, cellSize * 0.025);
    ctx.fillRect(near, edge, tick, w);
    ctx.fillRect(near, edge, w, tick);
    ctx.fillRect(far - tick, cellSize - edge - w, tick, w);
    ctx.fillRect(far - w, cellSize - edge - tick, w, tick);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Motion-blur streaks of the spinning fan, u = once around, v = hub → tip. A blurred fan
 * smears along the direction of travel, so the streaks are concentric; a faint lobe per blade
 * survives the blur and gives the stroboscopic shimmer of a real fan.
 *   r = brightness variation, a = density (opacity).
 */
export function createBlurStreakTexture(): DataTexture {
  const width = 256;
  const height = 64;
  const data = new Uint8Array(width * height * 4);
  const rand = mulberry32(19);
  const ringDensity: number[] = [];
  const ringBrightness: number[] = [];
  for (let y = 0; y < height; y++) {
    ringDensity.push(rand());
    ringBrightness.push(rand());
  }
  const smooth = (values: number[], y: number) =>
    (values[Math.max(0, y - 1)] + 2 * values[y] + values[Math.min(height - 1, y + 1)]) / 4;
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    // denser toward the hub (blades overlap there), a bright rim at the tips
    const radial = 0.92 - 0.3 * v + 0.25 * Math.pow(v, 6);
    const streak = 0.75 + 0.5 * smooth(ringDensity, y);
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const lobe = 0.5 + 0.5 * Math.cos(u * Math.PI * 2 * TURBINE.bladeCount - v * 2.4);
      const density = Math.min(1, radial * streak * (0.8 + 0.2 * lobe));
      const brightness = 0.35 + 0.4 * smooth(ringBrightness, y) + 0.25 * lobe;
      const o = (y * width + x) * 4;
      data[o] = Math.round(255 * Math.min(1, brightness));
      data[o + 1] = data[o];
      data[o + 2] = data[o];
      data[o + 3] = Math.round(255 * density);
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
