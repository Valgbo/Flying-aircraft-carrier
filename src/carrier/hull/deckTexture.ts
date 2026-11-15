/**
 * The flight-deck texture: dark non-skid with wear, and every painted marking, drawn on one
 * canvas in DECK COORDINATES (metres, straight from src/config/layout.ts). The canvas shows
 * the deck as seen from above with the bow at the top — canvas x = ship x (starboard to the
 * right), canvas y = ship z (aft downward) — which is the mapping `deckUv` applies, so
 * lettering painted upright here reads correctly on the ship.
 */
import { CanvasTexture, SRGBColorSpace, type Texture } from 'three';
import {
  CATAPULTS,
  ELEVATOR,
  ISLAND,
  JET,
  LANDING_STRIP,
  PARKING_SPOTS,
} from '../../config/layout';
import { PALETTE, SHIP } from '../../config/palette';
import { DEG2RAD } from '../../utils/math';
import { DECK_TEX, DECK_TEX_STRUCTURE_PATCH } from './deckLayout';
import { STRIP, deckOutlineWithNotch } from './hullShape';
import { fillTextInBox, makeCanvas, mulberry32 } from './shipTextures';

type Ctx = CanvasRenderingContext2D;

const WHITE = PALETTE.markingWhite;
const YELLOW = PALETTE.markingYellow;
const RED = PALETTE.markingRed;
const BLACK = '#131517';
const TRACK_STEEL = '#4b5258';

/** Distance from a catapult's start position back to its jet-blast deflector. */
const JBD_OFFSET = 13;
const JBD_DEPTH = 4.6;

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Diagonal yellow / black warning stripes filling the current clip region within a box. */
function hazardStripes(ctx: Ctx, x: number, z: number, w: number, h: number, pitch: number): void {
  ctx.fillStyle = YELLOW;
  ctx.fillRect(x, z, w, h);
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = pitch * 0.7;
  const reach = w + h;
  for (let d = -reach; d < reach; d += pitch * 2) {
    ctx.beginPath();
    ctx.moveTo(x + d, z + h);
    ctx.lineTo(x + d + h, z);
    ctx.stroke();
  }
}

function paintWear(ctx: Ctx, rnd: () => number): void {
  for (let i = 0; i < 70; i++) {
    const x = (rnd() - 0.5) * 70;
    const z = (rnd() - 0.5) * 310;
    const r = 4 + rnd() * 10;
    ctx.save();
    ctx.translate(x, z);
    ctx.scale(1, 1.5 + rnd() * 2);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    const tone = rnd() < 0.6 ? rgba(PALETTE.deckWorn, 0.5) : 'rgba(20,22,24,0.3)';
    g.addColorStop(0, tone);
    g.addColorStop(1, 'rgba(52,57,62,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
}

/** White line all round the deck, a little inboard of the edge. */
function paintEdgeLine(ctx: Ctx): void {
  const outline = deckOutlineWithNotch();
  ctx.save();
  ctx.beginPath();
  outline.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  ctx.closePath();
  ctx.clip();
  // only the inner half of a stroke survives the clip: paint a wide white band, then cover
  // all but its inner rim with deck colour
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = rgba(WHITE, 0.9);
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = PALETTE.deck;
  ctx.lineWidth = 2.3;
  ctx.stroke();
  ctx.restore();
}

function paintTieDowns(ctx: Ctx): void {
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  for (let x = -34; x <= 34; x += 4) {
    for (let z = -154; z <= 154; z += 4) ctx.fillRect(x - 0.12, z - 0.12, 0.24, 0.24);
  }
}

/** Run `draw` in landing-strip coordinates: x = metres to starboard of the centreline, y = metres past the threshold. */
function inStripFrame(ctx: Ctx, draw: () => void): void {
  ctx.save();
  ctx.transform(
    STRIP.stbdX,
    STRIP.stbdZ,
    STRIP.dirX,
    STRIP.dirZ,
    LANDING_STRIP.threshold[0],
    LANDING_STRIP.threshold[2],
  );
  draw();
  ctx.restore();
}

function paintLandingArea(ctx: Ctx, rnd: () => number): void {
  const hw = STRIP.halfWidth;
  inStripFrame(ctx, () => {
    ctx.fillStyle = 'rgba(255,255,255,0.028)';
    ctx.fillRect(-hw, 0, hw * 2, STRIP.length);
    // tyre rubber laid down around the wires
    for (let i = 0; i < 150; i++) {
      const across = (rnd() + rnd() - 1) * 7;
      const along = 16 + rnd() * 62;
      ctx.fillStyle = `rgba(9,9,10,${0.08 + rnd() * 0.2})`;
      ctx.fillRect(across, along, 0.25 + rnd() * 0.4, 6 + rnd() * 26);
    }
  });
}

function paintLandingStrip(ctx: Ctx): void {
  const hw = STRIP.halfWidth;
  inStripFrame(ctx, () => {
    ctx.fillStyle = rgba(WHITE, 0.92);
    ctx.fillRect(-hw - 0.225, 0, 0.45, STRIP.length);
    ctx.fillRect(hw - 0.225, 0, 0.45, STRIP.length);
    // threshold bars
    const bars = 8;
    for (let k = 0; k < bars; k++) {
      const across = -hw + 2.4 + (k * (hw * 2 - 4.8)) / (bars - 1);
      ctx.fillRect(across - 0.8, 1.5, 1.6, 8.5);
    }
    // centreline: alternating yellow and white dashes
    const dash = 6;
    for (let along = 12, k = 0; along + dash <= STRIP.length; along += dash, k++) {
      ctx.fillStyle = rgba(k % 2 === 0 ? YELLOW : WHITE, 0.92);
      ctx.fillRect(-0.3, along, 0.6, dash);
    }
    // foul lines just outside both edges: nothing parks inboard of them during recovery
    for (const across of [-(hw + 1.6), hw + 1.6]) {
      for (let along = 0, k = 0; along + 3 <= STRIP.length; along += 3, k++) {
        ctx.fillStyle = rgba(k % 2 === 0 ? RED : WHITE, 0.9);
        ctx.fillRect(across - 0.25, along, 0.5, 3);
      }
    }
  });
}

function paintIdentity(ctx: Ctx): void {
  ctx.fillStyle = rgba(WHITE, 0.9);
  fillTextInBox(ctx, SHIP.hullNumber, 0, -131, 15, 22);
  fillTextInBox(ctx, SHIP.name, 5, 155.3, 30, 2.8);
}

function paintIslandLine(ctx: Ctx): void {
  const x = ISLAND.centerX - ISLAND.width / 2 - 2.5;
  const z0 = ISLAND.centerZ - ISLAND.length / 2 - 7;
  const z1 = ISLAND.centerZ + ISLAND.length / 2 + 7;
  ctx.fillStyle = rgba(YELLOW, 0.92);
  ctx.fillRect(x - 0.2, z0, 0.4, z1 - z0);
  // ticks on the island side mark the keep-clear zone
  for (let z = z0; z <= z1; z += 4) ctx.fillRect(x, z - 0.15, 1.2, 0.3);
}

function paintParkingSpots(ctx: Ctx): void {
  const hw = JET.wingspan / 2;
  const hl = JET.length / 2;
  const arm = 2.4;
  const t = 0.25;
  PARKING_SPOTS.forEach((spot, i) => {
    ctx.save();
    ctx.translate(spot.position[0], spot.position[2]);
    // after this rotation the aircraft's nose points toward -y of the local frame
    ctx.rotate(spot.headingDeg * DEG2RAD);
    ctx.fillStyle = rgba(WHITE, 0.85);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const cx = sx * hw;
        const cy = sy * hl;
        ctx.fillRect(Math.min(cx, cx - sx * arm), cy - t / 2, arm, t);
        ctx.fillRect(cx - t / 2, Math.min(cy, cy - sy * arm), t, arm);
      }
    }
    fillTextInBox(ctx, String(i + 1), 0, hl - 2.6, 1.5, 2.4);
    // nose-wheel stop
    ctx.fillStyle = rgba(YELLOW, 0.9);
    ctx.fillRect(-1.1, -5.4, 2.2, 0.3);
    ctx.fillRect(-0.15, -5.4, 0.3, 3.2);
    ctx.restore();
  });
}

function paintCatapults(ctx: Ctx): void {
  for (const cat of CATAPULTS) {
    const x = cat.start[0];
    const zStart = cat.start[2];
    const zEnd = cat.end[2];
    const length = zStart - zEnd;
    // blast scorch between the launch position and the deflector
    const scorch = ctx.createRadialGradient(x, zStart + 8, 0, x, zStart + 8, 8);
    scorch.addColorStop(0, 'rgba(10,10,11,0.4)');
    scorch.addColorStop(1, 'rgba(10,10,11,0)');
    ctx.fillStyle = scorch;
    ctx.fillRect(x - 8, zStart, 16, 16);
    // track plates, the shuttle slot and the plate joints
    ctx.fillStyle = TRACK_STEEL;
    ctx.fillRect(x - 0.8, zEnd, 1.6, length + 2.4);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    for (let z = zEnd; z < zStart + 2.4; z += 6) ctx.fillRect(x - 0.8, z, 1.6, 0.14);
    ctx.fillStyle = '#0d0f11';
    ctx.fillRect(x - 0.15, zEnd + 1, 0.3, length);
    // guide lines either side
    ctx.fillStyle = rgba(WHITE, 0.85);
    ctx.fillRect(x - 2.1, zEnd, 0.22, length);
    ctx.fillRect(x + 1.88, zEnd, 0.22, length);
    // shuttle (launch) position and catapult number
    ctx.strokeStyle = YELLOW;
    ctx.lineWidth = 0.25;
    ctx.strokeRect(x - 1.3, zStart - 1.5, 2.6, 3);
    ctx.fillStyle = rgba(WHITE, 0.9);
    fillTextInBox(ctx, String(cat.id), x + 4, zStart + 2, 1.5, 3);
    // jet-blast deflector: three flush panels behind the launch position
    const z0 = zStart + JBD_OFFSET;
    const panel = 3.6;
    const pitch = 3.75;
    for (let k = 0; k < 3; k++) {
      const px = x - pitch * 1.5 + k * pitch + (pitch - panel) / 2;
      ctx.fillStyle = '#41484e';
      ctx.fillRect(px, z0, panel, JBD_DEPTH);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 0.14;
      ctx.strokeRect(px, z0, panel, JBD_DEPTH);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - pitch * 1.5, z0 - 0.7, pitch * 3, 0.55);
    ctx.clip();
    hazardStripes(ctx, x - pitch * 1.5, z0 - 0.7, pitch * 3, 0.55, 0.5);
    ctx.restore();
  }
}

function paintElevator(ctx: Ctx): void {
  const { minX, maxX, minZ, maxZ } = ELEVATOR;
  const band = 1.3;
  // hazard band on the deck around the notch
  ctx.save();
  ctx.beginPath();
  ctx.rect(minX - band, minZ - band, maxX - minX + band, maxZ - minZ + band * 2);
  ctx.rect(minX, minZ, maxX - minX, maxZ - minZ);
  ctx.clip('evenodd');
  hazardStripes(ctx, minX - band, minZ - band, maxX - minX + band, maxZ - minZ + band * 2, 0.9);
  ctx.restore();
  // the platform itself: slightly lighter non-skid, a yellow border and its label
  ctx.fillStyle = rgba(PALETTE.deckWorn, 0.7);
  ctx.fillRect(minX, minZ, maxX - minX, maxZ - minZ);
  ctx.strokeStyle = rgba(YELLOW, 0.9);
  ctx.lineWidth = 0.35;
  ctx.strokeRect(minX + 0.9, minZ + 0.9, maxX - minX - 1.8, maxZ - minZ - 1.8);
  ctx.fillStyle = rgba(YELLOW, 0.85);
  fillTextInBox(ctx, 'EL 1', (minX + maxX) / 2, (minZ + maxZ) / 2, 7, 2.6);
}

/** Fine non-skid grain plus a coarser mottle, laid over deck and paint alike so the paint looks worn. */
function paintGrain(ctx: Ctx, width: number, height: number, rnd: () => number): void {
  const size = 128;
  const { canvas, ctx: nctx } = makeCanvas(size, size);
  const image = nctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = rnd() < 0.5 ? 0 : 255;
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = Math.floor(rnd() * 26);
  }
  nctx.putImageData(image, 0, 0);
  const pattern = ctx.createPattern(canvas, 'repeat');
  if (!pattern) return;
  ctx.fillStyle = pattern;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(7, 0, 0, 7, 0, 0);
  ctx.globalAlpha = 0.8;
  ctx.fillRect(0, 0, width / 7, height / 7);
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * Paint the deck texture at `pixelsPerMetre` (12.8 → 1024 × 4096, 6.4 → 512 × 2048; both
 * power-of-two so they mip-map).
 */
export function createDeckTexture(pixelsPerMetre: number, anisotropy: number): Texture {
  const width = Math.round((DECK_TEX.maxX - DECK_TEX.minX) * pixelsPerMetre);
  const height = Math.round((DECK_TEX.maxZ - DECK_TEX.minZ) * pixelsPerMetre);
  const { canvas, ctx } = makeCanvas(width, height);
  const rnd = mulberry32(20240707);
  ctx.fillStyle = PALETTE.deck;
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(
    pixelsPerMetre,
    0,
    0,
    pixelsPerMetre,
    -DECK_TEX.minX * pixelsPerMetre,
    -DECK_TEX.minZ * pixelsPerMetre,
  );
  paintWear(ctx, rnd);
  paintEdgeLine(ctx);
  paintTieDowns(ctx);
  paintLandingArea(ctx, rnd);
  paintIdentity(ctx);
  paintLandingStrip(ctx);
  paintIslandLine(ctx);
  paintParkingSpots(ctx);
  paintCatapults(ctx);
  paintElevator(ctx);
  const patch = DECK_TEX_STRUCTURE_PATCH;
  ctx.fillStyle = PALETTE.hullDark;
  ctx.fillRect(patch.minX, patch.minZ, patch.maxX - patch.minX, patch.maxZ - patch.minZ);
  paintGrain(ctx, width, height, rnd);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}
