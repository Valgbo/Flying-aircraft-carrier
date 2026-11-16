/**
 * Texture analysis and re-encoding for the A-10 model converter.
 *
 * Uses ImageMagick 6 (`identify`, `convert`), run without a shell. Opaque images become JPEG,
 * images whose alpha matters become PNG. Sizes are capped and rounded down to powers of two.
 */
import { execFileSync } from 'node:child_process';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { maxBuffer: 256 * 1024 * 1024, ...opts });
}

/** Width, height and whether the file has an alpha channel. */
export function probeImage(path) {
  const out = run('identify', ['-format', '%w %h %[channels]\n', path]).toString().trim().split('\n')[0];
  const [w, h, ch] = out.split(' ');
  return { width: Number(w), height: Number(h), hasAlpha: /a/.test(ch ?? '') };
}

/** The alpha channel as w×h bytes (row 0 = top of the image), or null when there is none. */
export function readAlpha(path) {
  const info = probeImage(path);
  if (!info.hasAlpha) return { ...info, alpha: null };
  const raw = run('convert', [path, '-alpha', 'extract', '-depth', '8', 'gray:-']);
  return { ...info, alpha: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) };
}

/** Fractions of fully transparent (< 128) and partially transparent (8..247) texels. */
export function alphaStats(img) {
  if (!img.alpha) return { transparent: 0, partial: 0, opaque: 1 };
  let t = 0;
  let p = 0;
  const a = img.alpha;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v < 128) t++;
    if (v > 7 && v < 248) p++;
  }
  return { transparent: t / a.length, partial: p / a.length, opaque: 1 - t / a.length };
}

/** Alpha at a glTF UV (u right, v down from the top), with REPEAT wrapping. */
export function alphaAt(img, u, v) {
  if (!img.alpha) return 255;
  const x = Math.min(img.width - 1, Math.floor((u - Math.floor(u)) * img.width));
  const y = Math.min(img.height - 1, Math.floor((v - Math.floor(v)) * img.height));
  return img.alpha[y * img.width + x];
}

function floorPow2(n) {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/**
 * Re-encode an image.
 * @param {string} src source file
 * @param {string} dst destination (.jpg or .png)
 * @param {{ maxSize: number, quality?: number }} o
 * @returns {{ width: number, height: number }}
 */
export function encodeImage(src, dst, o) {
  const info = probeImage(src);
  let w = floorPow2(Math.min(o.maxSize, info.width));
  let h = floorPow2(Math.min(o.maxSize, info.height));
  // keep the aspect ratio of power-of-two sources
  if (info.width === info.height) w = h = Math.min(w, h);
  const args = [src, '-strip'];
  if (w !== info.width || h !== info.height) args.push('-filter', 'Lanczos', '-resize', `${w}x${h}!`);
  if (dst.endsWith('.jpg')) {
    args.push(
      '-background',
      'black',
      '-alpha',
      'remove',
      '-alpha',
      'off',
      '-sampling-factor',
      '4:2:0',
      '-interlace',
      'none',
      '-quality',
      String(o.quality ?? 85),
      dst,
    );
  } else {
    args.push('-define', 'png:compression-level=9', `PNG32:${dst}`);
  }
  run('convert', args);
  return { width: w, height: h };
}
