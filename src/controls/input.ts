/**
 * Continuous pilot input.
 *
 * Every control source (keyboard, gamepad, touch) writes its own slot in `inputSources`
 * whenever its state changes. Once per frame the active driver calls `combineInput()`,
 * which sums the slots, clamps to [-1, 1] and stores the result in `input`.
 *
 * All axes are MOMENTARY and spring-centred: 0 means "no input".
 *
 *   collective  +1 = throttle up / climb           -1 = throttle down / descend
 *   tilt        +1 = tilt turbines toward the bow  -1 = tilt them back (fly forward / brake)
 *   yaw         +1 = turn to starboard (right)     -1 = turn to port (left)
 *   strafe      +1 = slide / roll to starboard     -1 = to port
 *   lookX/lookY camera orbit rates from a stick (+X = look right, +Y = look up)
 *
 * How an axis is interpreted (rate vs. direct command) is up to the flight model.
 * `invertY` from the settings is applied by the SOURCE to stick-style tilt/look axes,
 * never by the consumer.
 */

export interface InputAxes {
  collective: number;
  tilt: number;
  yaw: number;
  strafe: number;
  lookX: number;
  lookY: number;
}

export type InputSource = 'keyboard' | 'gamepad' | 'touch';

export const AXIS_NAMES = ['collective', 'tilt', 'yaw', 'strafe', 'lookX', 'lookY'] as const;

function zeroAxes(): InputAxes {
  return { collective: 0, tilt: 0, yaw: 0, strafe: 0, lookX: 0, lookY: 0 };
}

export const inputSources: Record<InputSource, InputAxes> = {
  keyboard: zeroAxes(),
  gamepad: zeroAxes(),
  touch: zeroAxes(),
};

/** Combined input for this frame. Read-only for everyone except combineInput(). */
export const input: InputAxes = zeroAxes();

const SOURCES: readonly InputSource[] = ['keyboard', 'gamepad', 'touch'];

/** Sum all sources into `input` (clamped). Call once per frame before reading `input`. */
export function combineInput(): InputAxes {
  for (const axis of AXIS_NAMES) {
    let v = 0;
    for (const s of SOURCES) v += inputSources[s][axis];
    input[axis] = v < -1 ? -1 : v > 1 ? 1 : v;
  }
  return input;
}

/** Zero one source (e.g. on blur / unmount) or all of them. */
export function clearInput(source?: InputSource): void {
  const list = source ? [source] : SOURCES;
  for (const s of list) for (const axis of AXIS_NAMES) inputSources[s][axis] = 0;
  if (!source) for (const axis of AXIS_NAMES) input[axis] = 0;
}
