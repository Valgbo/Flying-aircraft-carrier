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

// Shell UI pieces shared with the A-10 overlay (src/a10/ui): store-free form controls, settings
// rows, focus handling, formatting, the FPS readout and generic icons, with the two stylesheets
// they need (prefix-scoped: shell-, settings-).
import '../ui/shell/shell.css';
import '../ui/shell/settings.css';
export { KeyCap, KeyReference, PresetChips, Slider, Switch } from '../ui/shell/controls';
export type { Preset, PresetChipsProps, SliderProps, SwitchProps } from '../ui/shell/controls';
export { SelectRow, SettingsSection, SliderRow, ToggleRow } from '../ui/shell/settingsRows';
export type { SelectRowProps, SliderRowProps, ToggleRowProps } from '../ui/shell/settingsRows';
export { focusTrapTarget, gridStep, isArrowKey, type ArrowKey } from '../ui/shell/focusOrder';
export { tabbableElements, useModalFocus, type ModalFocusOptions } from '../ui/shell/useModalFocus';
export {
  COARSE_POINTER_QUERY,
  COMPACT_QUERY,
  SHORT_QUERY,
  matchesMedia,
  useMediaQuery,
} from '../ui/shell/useMediaQuery';
export {
  TIME_SLIDER_MAX,
  TIME_SLIDER_STEP,
  formatDeg,
  formatMeters,
  formatPercent,
  formatRatio,
  formatSignedDeg,
  formatTimeOfDay,
  rangeFraction,
  snapToStep,
} from '../ui/shell/format';
export { default as FpsCounter } from '../ui/shell/FpsCounter';
export {
  IconArrowLeft,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconSliders,
  IconWarning,
  type IconProps,
} from '../ui/shell/icons';

// ---- Sky, clouds, post-processing and adaptive quality (environment module) ----
// The carrier's World / Clouds / PostFX / AdaptiveQuality are zero-prop wrappers around these
// carrier-free components; tests/unit/engineBoundary.test.ts proves nothing here reaches the
// carrier's sim or store.
export { default as SkyWorld, type SkyLights, type SkyWorldProps } from '../scene/sky/SkyWorld';
export { default as CloudLayer, type CloudLayerProps } from '../scene/sky/CloudLayer';
export { default as PostFXView, type PostFXViewProps } from '../scene/postfx/PostFXView';
export { createPostChain, type PostChain, type PostChainOptions } from '../scene/postfx/chain';
export {
  default as AdaptiveQualityMonitor,
  type AdaptiveQualityMonitorProps,
} from '../scene/AdaptiveQualityMonitor';
export { createSkyEnv, type SkyClock, type SkyEnv } from '../scene/sky/skyEnv';
export {
  CLEAR_FOG_DENSITY,
  CLEAR_VISIBILITY,
  CLOUD_FOG_DENSITY,
  CLOUD_VISIBILITY,
  fogDensityFor,
  fogDensityForVisibility,
  skyWhiteout,
  visibilityForFogDensity,
} from '../scene/sky/atmosphere';
export {
  CLOUD_SEED,
  DEFAULT_CLOUD_SHAPE,
  cloudCoverAt,
  createCloudLayout,
  type CloudLayout,
  type CloudShape,
} from '../scene/sky/cloudLayout';
export { getSkyState } from '../scene/sky/currentSky';
export {
  computeSkyState,
  createSkyState,
  daylightAt,
  luminance,
  moonDirectionAt,
  sunDirectionAt,
  wrapHours,
  type SkyState,
} from '../scene/sky/timeOfDay';
export { acesFilmicToneMap } from '../scene/sky/toneMap';
export { FRAME_PRIORITY } from '../config/frame';
export { QUALITY_ORDER, lowerQuality } from '../config/quality';
export type { QualityLevel } from '../state/types';
