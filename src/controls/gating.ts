/**
 * When pilot input counts. Shared by the keyboard, gamepad and touch layers so that all three
 * agree: axes are live only while a flying screen is up, the game is running and no settings
 * dialog is open; the same goes for every action except `togglePause`, which is always passed
 * on (src/state/coreActions.ts decides what it means on each screen).
 */
import { emitAction, type ActionName } from '../state/actions';
import { isFlyingScreen, useGameStore, type GameState } from '../state/useGameStore';

export type PilotGateState = Pick<GameState, 'screen' | 'paused' | 'settingsOpen'>;

export function pilotInputLive(state: PilotGateState): boolean {
  return isFlyingScreen(state.screen) && !state.paused && !state.settingsOpen;
}

export function actionAllowed(action: ActionName, state: PilotGateState): boolean {
  return action === 'togglePause' || pilotInputLive(state);
}

/**
 * Emit the actions a key or button press produced, each checked against the store as it is at
 * that moment (an earlier action in the same press may have paused the game).
 */
export function emitPilotActions(actions: readonly ActionName[]): void {
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (actionAllowed(action, useGameStore.getState())) emitAction(action);
  }
}
