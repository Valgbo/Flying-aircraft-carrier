/**
 * The controls reference (pause menu, help panel): every control the input module lists,
 * grouped as in the aircraft (stick, throttle, armament panel …), with the keyboard keys as key
 * caps and the gamepad control beside them. Built from useControlsReference(), so it follows a
 * rebinding (or the mouse-stick setting) while it is open.
 */
import { useMemo } from 'react';
import { useControlsReference, type ControlsReferenceRow } from '../input/controlsReference';

/** Rows grouped by `group`, groups in order of first appearance. */
export function groupControls(
  rows: readonly ControlsReferenceRow[],
): { group: string; rows: ControlsReferenceRow[] }[] {
  const groups = new Map<string, ControlsReferenceRow[]>();
  for (const row of rows) {
    const g = row.group || 'Other';
    const list = groups.get(g) ?? [];
    list.push(row);
    groups.set(g, list);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, rows: list }));
}

/** "Page Up / Page Down" → ["Page Up", "Page Down"]; "Ctrl + arrow keys" stays one cap. */
export function keyCaps(label: string): string[] {
  if (/^[\s\u2014\u2013-]*$/.test(label)) return [];
  return label
    .split(/\s+\/\s+|,\s*/)
    .map((s) => s.trim().replace(/^or\s+/i, ''))
    .filter((s) => s.length > 0);
}

/** "Trigger: first detent (PAC-1)": never break a line inside "PAC-1" (non-breaking hyphen). */
export function keepDesignators(text: string): string {
  return text.replace(/\b([A-Z]+)-(?=\d)/g, '$1\u2011');
}

export default function ControlsReference() {
  const rows = useControlsReference();
  const groups = useMemo(() => groupControls(rows), [rows]);
  if (groups.length === 0)
    return <p className="a10-note">The controls reference is not available.</p>;
  return (
    <div className="a10-keys" data-testid="a10-controls-reference">
      {groups.map((g) => (
        <section key={g.group} className="a10-keys__group" aria-label={g.group}>
          <h3 className="a10-keys__title fac-label">{g.group}</h3>
          <dl className="a10-keys__list">
            {g.rows.map((row, i) => (
              <div key={`${row.action}-${i}`} className="a10-keys__row">
                <dt className="a10-keys__action">{keepDesignators(row.action)}</dt>
                <dd className="a10-keys__keys">
                  {keyCaps(row.keyboard).length > 0 ? (
                    keyCaps(row.keyboard).map((k, j) => (
                      <kbd key={`${k}-${j}`} className="shell-key">
                        {k}
                      </kbd>
                    ))
                  ) : (
                    <span className="a10-keys__none">—</span>
                  )}
                  {keyCaps(row.gamepad).length > 0 && (
                    <span className="a10-keys__pad">{row.gamepad}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
