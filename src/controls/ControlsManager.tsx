/**
 * ControlsManager — mounts the keyboard and gamepad listeners. Renders nothing.
 * PLACEHOLDER: bare-bones keyboard handling with the default bindings.
 */
import { useEffect } from 'react';
import { emitAction, type ActionName } from '../state/actions';
import { useGameStore } from '../state/useGameStore';
import { clearInput, inputSources } from './input';

const ACTIONS: readonly ActionName[] = [
  'toggleAssist',
  'cycleCamera',
  'launchJet',
  'toggleTurbinePanel',
  'togglePause',
  'resetFlight',
];

export default function ControlsManager() {
  useEffect(() => {
    const down = new Set<string>();
    const update = () => {
      const b = useGameStore.getState().settings.keyBindings;
      const k = inputSources.keyboard;
      const axis = (pos: string, neg: string) => (down.has(pos) ? 1 : 0) - (down.has(neg) ? 1 : 0);
      k.collective = axis(b.throttleUp, b.throttleDown);
      k.tilt = axis(b.tiltForward, b.tiltBack);
      k.yaw = axis(b.yawRight, b.yawLeft);
      k.strafe = axis(b.strafeRight, b.strafeLeft);
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const b = useGameStore.getState().settings.keyBindings;
      down.add(e.code);
      update();
      for (const a of ACTIONS) if (b[a] === e.code) emitAction(a);
    };
    const onUp = (e: KeyboardEvent) => {
      down.delete(e.code);
      update();
    };
    const onBlur = () => {
      down.clear();
      clearInput('keyboard');
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
      clearInput('keyboard');
    };
  }, []);
  return null;
}
