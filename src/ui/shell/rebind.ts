/**
 * Key-rebinding rules for the settings dialog. Pure functions over `KeyBindings` — the dialog
 * decides how to store the result; covered by tests/unit/shell.test.ts.
 */
import { BINDING_ORDER, type BindingId, type KeyBindings } from '../../state/bindings';

export interface RebindResult {
  /** The bindings after the change (a new object; the input is never mutated). */
  bindings: KeyBindings;
  /** False when `code` was already the key of `id` — nothing to store. */
  changed: boolean;
  /** The binding that gave up `code` and received the old key of `id` in exchange, if any. */
  swappedWith: BindingId | null;
}

/** The first binding other than `except` that uses `code`, in table order. */
export function findBindingByCode(
  bindings: KeyBindings,
  code: string,
  except?: BindingId,
): BindingId | null {
  for (const id of BINDING_ORDER) {
    if (id !== except && bindings[id] === code) return id;
  }
  return null;
}

/**
 * Assign `code` to `id`. If another binding already uses that key the two trade keys, so a
 * duplicate-free table stays duplicate-free and no action is ever left without a key.
 */
export function rebind(bindings: KeyBindings, id: BindingId, code: string): RebindResult {
  const previous = bindings[id];
  if (previous === code) return { bindings, changed: false, swappedWith: null };
  const other = findBindingByCode(bindings, code, id);
  const next: KeyBindings = { ...bindings, [id]: code };
  if (other) next[other] = previous;
  return { bindings: next, changed: true, swappedWith: other };
}

/**
 * Bindings that share their key with at least one other binding. A table edited only through
 * `rebind` never has any, but settings saved by an older build can (a binding added later may
 * default to a key the pilot had already given to something else) — the dialog flags them.
 */
export function findDuplicateBindings(bindings: KeyBindings): Set<BindingId> {
  const firstByCode = new Map<string, BindingId>();
  const duplicates = new Set<BindingId>();
  for (const id of BINDING_ORDER) {
    const code = bindings[id];
    const first = firstByCode.get(code);
    if (first === undefined) {
      firstByCode.set(code, id);
    } else {
      duplicates.add(first);
      duplicates.add(id);
    }
  }
  return duplicates;
}
