/**
 * Keyboard core — pure and DOM-free, so it can be unit-tested.
 *
 * It remembers which KeyboardEvent.code values are physically held and derives everything
 * else from the CURRENT bindings each time it is asked: the four flight axes, and which
 * actions a key-down fires. Because nothing but the held set is stored, rebinding a key while
 * it is held can never leave an axis stuck — the old key simply stops counting.
 */
import { ACTION_NAMES, type ActionName } from '../state/actions';
import type { BindingId, KeyBindings } from '../state/bindings';

/** The axes the keyboard drives (a subset of InputAxes; the look axes stay with the mouse). */
export interface KeyAxes {
  collective: number;
  tilt: number;
  yaw: number;
  strafe: number;
}

const NO_ACTIONS: readonly ActionName[] = Object.freeze([]);

export class KeyboardCore {
  private bindings: KeyBindings;
  private readonly held = new Set<string>();
  private readonly actionsByCode = new Map<string, readonly ActionName[]>();
  private readonly boundCodes = new Set<string>();

  constructor(bindings: KeyBindings) {
    this.bindings = bindings;
    this.index();
  }

  /** Swap the bindings. Held keys stay held; what they mean follows the new map at once. */
  setBindings(bindings: KeyBindings): void {
    this.bindings = bindings;
    this.index();
  }

  /**
   * Register a key-down. Returns the actions bound to that key — none for auto-repeat, so an
   * action fires once per physical press. The returned array is shared: read it, do not keep it.
   */
  keyDown(code: string, repeat = false): readonly ActionName[] {
    if (code === '') return NO_ACTIONS;
    this.held.add(code);
    if (repeat) return NO_ACTIONS;
    return this.actionsByCode.get(code) ?? NO_ACTIONS;
  }

  keyUp(code: string): void {
    this.held.delete(code);
  }

  /** Forget every held key (window blur, tab hidden, unmount). */
  clear(): void {
    this.held.clear();
  }

  /** True if any binding (axis or action) uses this key. */
  isBound(code: string): boolean {
    return this.boundCodes.has(code);
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  /** Write the four axes into `out`. Opposite keys cancel; releasing one restores the other. */
  readAxes<T extends KeyAxes>(out: T): T {
    out.collective = this.axis('throttleUp', 'throttleDown');
    out.tilt = this.axis('tiltForward', 'tiltBack');
    out.yaw = this.axis('yawRight', 'yawLeft');
    out.strafe = this.axis('strafeRight', 'strafeLeft');
    return out;
  }

  private axis(positive: BindingId, negative: BindingId): number {
    return (
      (this.held.has(this.bindings[positive]) ? 1 : 0) -
      (this.held.has(this.bindings[negative]) ? 1 : 0)
    );
  }

  private index(): void {
    this.actionsByCode.clear();
    this.boundCodes.clear();
    for (const code of Object.values(this.bindings)) if (code !== '') this.boundCodes.add(code);
    for (const action of ACTION_NAMES) {
      const code = this.bindings[action];
      if (code === '') continue;
      const list = this.actionsByCode.get(code);
      this.actionsByCode.set(code, list ? [...list, action] : [action]);
    }
  }
}
