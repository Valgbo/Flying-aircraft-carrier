/** A-10 simulator entry (served at /a10/). FOUNDATION-OWNED; see docs/a10/ARCHITECTURE.md. */
import { StrictMode, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../engine';
import '../styles/global.css';
import './a10.css';
import { a10Flags } from './state/debugFlags';
import { installA10TestHook } from './state/testHook';

installA10TestHook();

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

function FatalError() {
  const webgl = hasWebGL2();
  return (
    <div role="alert" data-testid="fatal-error" style={FATAL_STYLE}>
      <h1 style={{ margin: 0, fontSize: 22 }}>
        {webgl ? 'Something went wrong' : '3D graphics are not available'}
      </h1>
      <p style={{ margin: 0, maxWidth: 520, color: 'var(--fac-text-dim)' }}>
        {webgl
          ? 'The A-10 simulator ran into a problem and had to stop. Reload the page to start again.'
          : 'The A-10 simulator needs WebGL 2, which this browser or device does not provide right now. Switch on hardware acceleration or try another browser, then reload.'}
      </p>
      <button type="button" className="fac-btn fac-btn--primary" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}

if (import.meta.env.DEV && a10Flags.sandbox) {
  void import('./dev/Sandbox').then(({ default: Sandbox }) => {
    root.render(
      <StrictMode>
        <Sandbox name={a10Flags.sandbox!} />
      </StrictMode>,
    );
  });
} else {
  import('./App').then(
    ({ default: A10App }) => {
      root.render(
        <StrictMode>
          <ErrorBoundary fallback={<FatalError />}>
            <A10App />
          </ErrorBoundary>
        </StrictMode>,
      );
    },
    () => root.render(<FatalError />),
  );
}
