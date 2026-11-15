/**
 * Rows of the keyboard legend, built from the live key bindings. Opposite controls share one
 * row ("W S  Altitude") to keep the legend compact; single actions use the shared labels.
 */
import { BINDING_LABELS, keyLabel, type BindingId, type KeyBindings } from '../../state/bindings';
import type { Screen } from '../../state/types';

export interface KeyHint {
  /** Stable key for React. */
  id: string;
  /** Key caps, in the order positive / negative for paired controls. */
  keys: string[];
  label: string;
}

interface PairedHint {
  id: string;
  bindings: readonly [BindingId, BindingId];
  /** What the pair does with flight assist on / off (the collective changes meaning). */
  assistLabel: string;
  manualLabel: string;
}

const PAIRS: readonly PairedHint[] = [
  {
    id: 'collective',
    bindings: ['throttleUp', 'throttleDown'],
    assistLabel: 'Climb / descend',
    manualLabel: 'Throttle up / down',
  },
  {
    id: 'tilt',
    bindings: ['tiltForward', 'tiltBack'],
    assistLabel: 'Tilt forward / back',
    manualLabel: 'Tilt forward / back',
  },
  {
    id: 'yaw',
    bindings: ['yawLeft', 'yawRight'],
    assistLabel: 'Yaw left / right',
    manualLabel: 'Yaw left / right',
  },
  {
    id: 'strafe',
    bindings: ['strafeLeft', 'strafeRight'],
    assistLabel: 'Strafe left / right',
    manualLabel: 'Roll left / right',
  },
];

const SINGLES: readonly BindingId[] = [
  'toggleAssist',
  'cycleCamera',
  'toggleTurbinePanel',
  'launchJet',
  'resetFlight',
  'togglePause',
];

/** Legend rows for the current bindings, screen and control mode. */
export function buildKeyHints(
  bindings: KeyBindings,
  screen: Screen,
  assistEnabled: boolean,
): KeyHint[] {
  const hints: KeyHint[] = PAIRS.map((pair) => ({
    id: pair.id,
    keys: pair.bindings.map((b) => keyLabel(bindings[b])),
    label: assistEnabled ? pair.assistLabel : pair.manualLabel,
  }));
  for (const id of SINGLES) {
    // jets are only launched in flight ops
    if (id === 'launchJet' && screen !== 'ops') continue;
    hints.push({ id, keys: [keyLabel(bindings[id])], label: BINDING_LABELS[id] });
  }
  return hints;
}
