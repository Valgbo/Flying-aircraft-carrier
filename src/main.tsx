import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { debugFlags } from './config/debugFlags';
import { installDebugHook } from './dev/debugHook';
import { applyDebugFlags } from './state/applyDebugFlags';
import { bindCoreActions } from './state/coreActions';
import './styles/global.css';

bindCoreActions();
applyDebugFlags();
installDebugHook();

const root = createRoot(document.getElementById('root')!);

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
  void import('./App').then(({ default: App }) => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
}
