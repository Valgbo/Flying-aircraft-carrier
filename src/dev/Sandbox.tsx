/**
 * Dev-only sandbox loader. `/?sandbox=<name>` renders the default export of
 * `src/dev/sandboxes/<name>.tsx` on its own page, so a module can be developed and
 * screenshotted in isolation while other modules are still in flux.
 */
import { Suspense, lazy, useMemo, type ComponentType } from 'react';

const modules = import.meta.glob<{ default: ComponentType }>('./sandboxes/*.tsx');

export default function Sandbox({ name }: { name: string }) {
  const loader = modules[`./sandboxes/${name}.tsx`];
  const Component = useMemo(() => (loader ? lazy(loader) : null), [loader]);
  if (!Component) {
    const names = Object.keys(modules).map((p) =>
      p.replace('./sandboxes/', '').replace('.tsx', ''),
    );
    return (
      <pre style={{ padding: 24, color: '#fff', userSelect: 'text' }}>
        Unknown sandbox "{name}". Available: {names.join(', ') || '(none)'}
      </pre>
    );
  }
  return (
    <Suspense fallback={null}>
      <Component />
    </Suspense>
  );
}
