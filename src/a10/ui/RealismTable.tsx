/**
 * What each realism preset changes (PLAN_A10.md §2), as a table with the chosen preset's column
 * highlighted. The rows come from realismRows(), i.e. from the flags the simulation runs with.
 */
import { useMemo } from 'react';
import type { RealismPreset } from '../core/types';
import { REALISM_INFO, REALISM_PRESETS, realismRows } from './realism';
import TableWrap from './TableWrap';

export default function RealismTable({ selected }: { selected: RealismPreset }) {
  const rows = useMemo(() => realismRows(), []);
  return (
    <TableWrap>
      <table className="a10-table a10-realism" data-testid="a10-realism-table">
        <caption className="fac-visually-hidden">What each realism preset changes</caption>
        <thead>
          <tr>
            <th scope="col">Aid</th>
            {REALISM_PRESETS.map((p) => (
              <th key={p} scope="col" data-selected={p === selected || undefined}>
                {REALISM_INFO[p].label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.aid}>
              <th scope="row">{row.aid}</th>
              {REALISM_PRESETS.map((p) => (
                <td key={p} data-selected={p === selected || undefined}>
                  {row.values[p]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
