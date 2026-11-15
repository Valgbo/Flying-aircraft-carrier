/**
 * Canvas-generated textures shared by the hull, deck structure and island (plating /
 * weathering map and the decal atlas), plus the small reference-counted cache that lets the
 * three components share one GPU copy and free it when the last of them unmounts.
 */
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';
import { PALETTE, SHIP } from '../../config/palette';
import { DECAL_ATLAS } from './decals';

/** Font stack for all painted lettering (no web fonts: whatever bold sans the system has). */
export const MARKING_FONT = '"Arial Narrow", "Helvetica Neue", Helvetica, Arial, sans-serif';

/** Small deterministic PRNG so every load paints the same wear. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeCanvas(
  width: number,
  height: number,
): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return { canvas, ctx };
}

/**
 * Draw `text` stretched to fill exactly the box of the given size centred on (cx, cy), in
 * the current user units. Uses the measured ink box, so the result does not depend on which
 * fallback font the system picked.
 */
export function fillTextInBox(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.font = `700 100px ${MARKING_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(text);
  const inkWidth = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const inkHeight = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  ctx.translate(cx, cy);
  ctx.scale(width / inkWidth, height / inkHeight);
  ctx.fillText(
    text,
    -inkWidth / 2 + m.actualBoundingBoxLeft,
    inkHeight / 2 - m.actualBoundingBoxDescent,
  );
  ctx.restore();
}

/**
 * Tiling plating map (multiplied over the vertex colours): strakes of slightly varying tone,
 * soft seams and faint streaks running down from them. Contrast is kept low and the seams
 * wide enough to survive mip-mapping, so the hull does not shimmer at distance.
 */
export function createPlatingTexture(anisotropy: number): Texture {
  const size = 1024;
  const { canvas, ctx } = makeCanvas(size, size);
  const rnd = mulberry32(7);
  const rows = 8;
  const rowHeight = size / rows;
  ctx.fillStyle = '#ecedee';
  ctx.fillRect(0, 0, size, size);
  const seams: [number, number][] = [];
  for (let r = 0; r < rows; r++) {
    let x = 0;
    while (x < size) {
      const w = Math.min(size - x, 110 + Math.floor(rnd() * 150));
      const tone = 232 + Math.floor(rnd() * 13);
      ctx.fillStyle = `rgb(${tone},${tone},${tone + 2})`;
      ctx.fillRect(x, r * rowHeight, w, rowHeight);
      seams.push([x, r]);
      x += w;
    }
  }
  // streaks first, so the seams stay crisp on top of them
  for (let i = 0; i < 90; i++) {
    const x = rnd() * size;
    const y = Math.floor(rnd() * rows) * rowHeight;
    const length = 30 + rnd() * 90;
    const g = ctx.createLinearGradient(0, y, 0, y + length);
    g.addColorStop(0, `rgba(36,30,26,${0.05 + rnd() * 0.09})`);
    g.addColorStop(1, 'rgba(36,30,26,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, 2 + rnd() * 5, length);
  }
  ctx.fillStyle = 'rgba(34,40,46,0.3)';
  for (let r = 0; r < rows; r++) ctx.fillRect(0, r * rowHeight, size, 3);
  for (const [x, r] of seams) ctx.fillRect(x, r * rowHeight, 3, rowHeight);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/** Hull number and ship name, white on transparent, laid out as DECAL_ATLAS says. */
export function createDecalAtlas(anisotropy: number): Texture {
  const { canvas, ctx } = makeCanvas(DECAL_ATLAS.width, DECAL_ATLAS.height);
  const paint = (
    text: string,
    rect: { x: number; y: number; w: number; h: number },
    pad: number,
  ): void => {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    // a dark drop edge keeps the white legible against sunlit grey
    ctx.fillStyle = 'rgba(20,24,28,0.55)';
    fillTextInBox(ctx, text, cx + 5, cy + 5, rect.w - pad * 2, rect.h - pad * 2);
    ctx.fillStyle = PALETTE.markingWhite;
    fillTextInBox(ctx, text, cx, cy, rect.w - pad * 2, rect.h - pad * 2);
  };
  paint(SHIP.hullNumber, DECAL_ATLAS.number, 22);
  paint(SHIP.name, DECAL_ATLAS.name, 18);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

const cache = new Map<string, { texture: Texture; refs: number }>();

/**
 * A texture shared by every component that asks for the same key; created on first use and
 * disposed when the last user unmounts.
 */
export function useSharedTexture(key: string, create: (anisotropy: number) => Texture): Texture {
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy());
  const texture = useMemo(() => {
    let entry = cache.get(key);
    if (!entry) {
      entry = { texture: create(Math.min(8, maxAnisotropy)), refs: 0 };
      cache.set(key, entry);
    }
    return entry.texture;
  }, [key, create, maxAnisotropy]);
  useEffect(() => {
    // re-register if a previous cleanup (e.g. a StrictMode remount) already released it
    let entry = cache.get(key);
    if (!entry || entry.texture !== texture) {
      entry = { texture, refs: 0 };
      cache.set(key, entry);
    }
    const held = entry;
    held.refs++;
    return () => {
      held.refs--;
      if (held.refs > 0) return;
      held.texture.dispose();
      if (cache.get(key) === held) cache.delete(key);
    };
  }, [key, texture]);
  return texture;
}

export function usePlatingTexture(): Texture {
  return useSharedTexture('plating', createPlatingTexture);
}

export function useDecalAtlas(): Texture {
  return useSharedTexture('decals', createDecalAtlas);
}
