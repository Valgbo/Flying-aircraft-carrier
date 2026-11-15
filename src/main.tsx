import { StrictMode, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { debugFlags } from './config/debugFlags';
import { installDebugHook } from './dev/debugHook';
import { applyDebugFlags } from './state/applyDebugFlags';
import { bindCoreActions } from './state/coreActions';
import ErrorBoundary from './state/ErrorBoundary';
import './styles/global.css';

bindCoreActions();
applyDebugFlags();
installDebugHook();

const root = createRoot(document.getElementById('root')!);

const FATAL_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 16,
  padding: 24,
  textAlign: 'center',
  background: 'var(--fac-bg)',
  color: 'var(--fac-text)',
  font: '16px/1.5 var(--fac-font)',
};

function hasWebGL2(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

/** Shown instead of the app when it cannot start or has crashed: say why, offer a reload. */
function FatalError() {
  const webgl = hasWebGL2();
  return (
    <div role="alert" data-testid="fatal-error" style={FATAL_STYLE}>
      <h1 style={{ margin: 0, fontSize: 22 }}>
        {webgl ? 'Something went wrong' : '3D graphics are not available'}
      </h1>
      <p style={{ margin: 0, maxWidth: 520, color: 'var(--fac-text-dim)' }}>
        {webgl
          ? 'Flying Aircraft Carrier ran into a problem and had to stop. Check your connection and reload the page to start again.'
          : 'Flying Aircraft Carrier needs WebGL 2, which this browser or device does not provide right now. Switch on hardware acceleration or try another browser, then reload the page.'}
      </p>
      <button type="button" className="fac-btn fac-btn--primary" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}

if (import.meta.env.DEV && debugFlags.sandbox) {
  // Dev-only component sandboxes: /?sandbox=<name> renders src/dev/sandboxes/<name>.tsx
  void import('./dev/Sandbox').then(({ default: Sandbox }) => {
    root.render(
      <StrictMode>
        <Sandbox name={debugFlags.sandbox!} />
      </StrictMode>,
    );
  });
} else {
  // Loaded lazily so a sandbox page never depends on the whole app graph compiling.
  import('./App').then(
    ({ default: App }) => {
      root.render(
        <StrictMode>
          <ErrorBoundary fallback={<FatalError />}>
            <App />
          </ErrorBoundary>
        </StrictMode>,
      );
    },
    () => root.render(<FatalError />),
  );
}
