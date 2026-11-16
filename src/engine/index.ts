/**
 * The shared engine: carrier-app modules the A-10 app may use. The A-10 app imports code from
 * outside src/a10 ONLY through this file (plus src/styles/global.css), and the carrier app never
 * imports src/a10. Enforced by the `a10/boundaries` lint rule (eslint.config.js).
 * Add a re-export here only for modules that do not read the carrier's `sim` or store.
 */
export { default as ErrorBoundary } from '../state/ErrorBoundary';
export {
  DEG2RAD,
  RAD2DEG,
  TAU,
  clamp,
  clamp01,
  damp,
  deadzone,
  inverseLerp,
  lerp,
  moveToward,
  mulberry32,
  remap,
  smoothstep,
  wrapAngle,
  wrapDeg360,
  deltaDeg,
} from '../utils/math';
export {
  createBrownNoise,
  createWhiteNoise,
  SmoothParam,
  NOISE_SECONDS,
} from '../audio/audioGraph';

// Audio and input helpers (carrier-free; see the input/audio reuse analysis).
export {
  volumeToGain,
  offsetToPan,
  bearingToPan,
  PAN_WIDTH,
  dopplerFactor,
} from '../audio/audioMappings';
export { responseCurve, RESPONSE_SOFTNESS } from '../controls/response';
export { captureNextKey, cancelKeyCapture, isKeyCaptureActive } from '../controls/keyCapture';
export { bindPointerDrag, type PointerDragHandlers } from '../controls/pointerDrag';
export type { GamepadSnapshot, GamepadButtonSnapshot, GamepadCandidate } from '../controls/gamepad';
export { keyLabel } from '../state/bindings';
