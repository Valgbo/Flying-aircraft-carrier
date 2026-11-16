/**
 * URLs of files under public/a10/. FOUNDATION-OWNED (docs/a10/ARCHITECTURE.md §9).
 *
 * The literal `new URL('/a10/assets.json', import.meta.url)` is the one anchor Vite rewrites
 * correctly in dev (/a10/assets.json) and in the build (relative to the chunk), at any deploy
 * path. Every other asset URL is resolved against it. Never build asset URLs from
 * import.meta.env.BASE_URL or from template literals inside new URL(...): both break silently.
 */
export const A10_PUBLIC = new URL('/a10/assets.json', import.meta.url);

/** URL of a file under public/a10/, e.g. a10Asset('models/a10-exterior.glb'). */
export function a10Asset(path: string): string {
  return new URL(path, A10_PUBLIC).href;
}
