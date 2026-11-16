/**
 * src/engine/index.ts is the A-10 app's only door into carrier code, and it must stay
 * carrier-free (docs/a10/ARCHITECTURE.md §1): importing the carrier's sim or store from the A-10
 * page would run the carrier's simulation and read (and could overwrite) its saved settings.
 *
 * ESLint checks each file's direct imports only, so a chain like chain.ts → HeatDistortionEffect
 * → state/sim would slip through. This test walks every static RUNTIME import reachable from
 * src/engine/index.ts (type-only imports are erased by the compiler and skipped) and fails on
 * any carrier-state module.
 */
import { describe, expect, it } from 'vitest';

/** Every source file of the app as text, keyed '/src/…' (Vite raw glob: no Node APIs needed). */
const SOURCES = import.meta.glob<string>('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const ENTRY = '/src/engine/index.ts';

/** Modules that hold or read the carrier's simulation, store or ship layout. */
const FORBIDDEN_FILES = [
  '/src/state/sim.ts',
  '/src/state/useGameStore.ts',
  '/src/state/useQuality.ts',
  '/src/state/simHelpers.ts',
  '/src/state/actions.ts',
  '/src/state/coreActions.ts',
  '/src/state/applyDebugFlags.ts',
  '/src/state/telemetry.ts',
  '/src/state/telemetrySnapshot.ts',
  '/src/config/layout.ts',
  '/src/config/physicsConfig.ts',
  '/src/config/waves.ts',
  '/src/config/debugFlags.ts',
];
/**
 * Whole carrier-simulation folders (and the A-10 app, which engine must never import). Generic,
 * store-free UI and input helpers under src/ui and src/controls may be shared; if one of them
 * reaches the store, the walk finds the store module itself.
 */
const FORBIDDEN_DIRS = [
  '/src/carrier/',
  '/src/aircraft/',
  '/src/physics/',
  '/src/sim/',
  '/src/a10/',
];

/** Runtime module specifiers of a TypeScript source (static imports and re-exports). */
function runtimeImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  // import x from '…', import { a, type b } from '…', export { … } from '…', export * from '…'
  const re = /\b(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[2]) continue; // `import type …` / `export type …`
    const clause = m[3].trim();
    const braces = /^\{([\s\S]*)\}$/.exec(clause);
    if (braces) {
      const names = braces[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // `{ type A, type B }` only: erased
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    }
    out.push(m[4]);
  }
  // side-effect imports: import '…'
  const bare = /\bimport\s+['"]([^'"]+)['"]/g;
  for (let m = bare.exec(code); m; m = bare.exec(code)) out.push(m[1]);
  return out;
}

/** POSIX join of a directory and a relative specifier ('..' and '.' resolved). */
function join(dir: string, spec: string): string {
  const parts = dir.split('/').filter(Boolean);
  for (const p of spec.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.' && p !== '') parts.push(p);
  }
  return '/' + parts.join('/');
}

function resolveModule(from: string, spec: string): string | null {
  const base = join(from.slice(0, from.lastIndexOf('/')), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (c in SOURCES) return c;
  }
  return null;
}

/** Every source file reachable from `entry` through runtime imports, with the path that reached it. */
function walk(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of runtimeImports(SOURCES[file])) {
      if (!spec.startsWith('.')) continue; // packages (three, react, postprocessing…)
      if (/\.(css|json|glsl)$/.test(spec)) continue;
      const target = resolveModule(file, spec);
      if (!target) throw new Error(`unresolved import '${spec}' in ${file}`);
      if (seen.has(target)) continue;
      seen.set(target, [...seen.get(file)!, target]);
      queue.push(target);
    }
  }
  return seen;
}

function isForbidden(file: string): boolean {
  return FORBIDDEN_FILES.includes(file) || FORBIDDEN_DIRS.some((d) => file.startsWith(d));
}

describe('src/engine stays carrier-free', () => {
  it('parses runtime imports and skips type-only ones', () => {
    const src = [
      "import type { A } from './a';",
      "import { type B, type C } from './b';",
      "import { type D, e } from './c';",
      "export { f } from './d';",
      "export type { G } from './e';",
      "export * from './f';",
      "import './g';",
      "import h from 'three';",
      "// import { x } from './commented';",
    ].join('\n');
    expect(runtimeImports(src).sort()).toEqual(['./c', './d', './f', './g', 'three'].sort());
  });

  it('reaches no carrier sim, store, layout or app module through runtime imports', () => {
    expect(ENTRY in SOURCES).toBe(true);
    const reached = walk(ENTRY);
    // the shared sky and post-processing pieces really are behind the door
    expect(reached.has('/src/scene/sky/SkyWorld.tsx')).toBe(true);
    expect(reached.has('/src/scene/sky/CloudLayer.tsx')).toBe(true);
    expect(reached.has('/src/scene/postfx/chain.ts')).toBe(true);
    const bad = [...reached.entries()]
      .filter(([file]) => isForbidden(file))
      .map(([, path]) => path.join(' → '));
    expect(bad).toEqual([]);
  });

  it('would catch a carrier import hidden behind another module', () => {
    // the carrier's own wrappers DO reach the store: the walker must see it
    const reached = walk('/src/scene/World.tsx');
    expect([...reached.keys()].some(isForbidden)).toBe(true);
    // and the old chain → heat effect → sim path is gone from the shared chain
    expect([...walk('/src/scene/postfx/chain.ts').keys()].some(isForbidden)).toBe(false);
  });
});
