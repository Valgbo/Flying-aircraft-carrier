/**
 * Development sandboxes: /a10/?sandbox=<name> renders src/a10/dev/sandboxes/<name>.tsx alone.
 * FOUNDATION-OWNED; each module adds its own sandbox files.
 */
import { Suspense, lazy, useMemo } from 'react';

const modules = import.meta.glob('./sandboxes/*.tsx');

export default function Sandbox({ name }: { name: string }) {
  const Comp = useMemo(() => {
    const loader = modules[`./sandboxes/${name}.tsx`];
    if (!loader) return null;
    return lazy(loader as () => Promise<{ default: React.ComponentType }>);
  }, [name]);
  if (!Comp) {
    return (
      <div style={{ padding: 24, color: '#ddd', fontFamily: 'system-ui' }}>
        No sandbox "{name}". Available:{' '}
        {Object.keys(modules)
          .map((k) => k.slice(12, -4))
          .join(', ')}
      </div>
    );
  }
  return (
    <Suspense fallback={null}>
      <Comp />
    </Suspense>
  );
}
