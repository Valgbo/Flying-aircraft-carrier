/**
 * The range control officer's calls (PLAN_A10.md §11.2): on a weapons range each score is called
 * as it comes — a strafe pass's hits (or its foul) at the pull-off, each bomb's miss and clock as
 * it lands, a lane pass's kills — and the overlay shows them as messages. Pure: the bridge keeps
 * a CallState per flight and asks for the calls once per frame. Covered by
 * tests/unit/a10/ui-range.test.ts.
 */
import type { DebriefState } from '../core/debrief/types';
import { formatClockDirection, formatInt, formatMiss } from './format';
import { storeLabel } from './loadout';

export interface CallState {
  /** The next pass to call when it has closed. */
  pass: number;
  /** Bomb scores already called. */
  bombs: number;
}

export function createCallState(): CallState {
  return { pass: 0, bombs: 0 };
}

/** The calls due since the last time (empty most frames). Advances `state`. */
export function rangeCalls(d: DebriefState, state: CallState): string[] {
  const calls: string[] = [];
  const s = d.scores;
  if (s.event === 'none') return calls;
  // passes in order, each once it has closed
  while (state.pass < d.passes.length && Number.isFinite(d.passes[state.pass].end)) {
    const index = state.pass++;
    const p = d.passes[index];
    if (s.event === 'strafePit') {
      const score = s.strafe?.passes.find((x) => x.pass === index);
      if (!score) continue;
      const fouls = [score.foulLine && 'FOUL LINE', score.minAltitude && 'MINIMUM ALTITUDE'].filter(
        Boolean,
      );
      calls.push(
        fouls.length > 0
          ? `PASS ${p.number}: FOUL, ${fouls.join(' AND ')} — NO SCORE`
          : `PASS ${p.number}: ${formatInt(score.hits)} HITS OF ${formatInt(score.rounds)}`,
      );
    } else if (s.event === 'tacticalLane') {
      const n = p.kills.length;
      calls.push(`PASS ${p.number}: ${n === 0 ? 'NO KILL' : `${n} ${n === 1 ? 'KILL' : 'KILLS'}`}`);
    }
  }
  // bombs as they land (bombing circle)
  const bombs = s.bombs?.scores ?? [];
  while (state.bombs < bombs.length) {
    const b = bombs[state.bombs++];
    const what = storeLabel(b.store).short.toUpperCase();
    const where =
      b.miss < 0.5
        ? 'SHACK'
        : `${formatMiss(b.miss).toUpperCase()} AT ${formatClockDirection(b.clock).toUpperCase()}`;
    calls.push(`${what} ${state.bombs}: ${b.dud ? 'DUD, ' : ''}${where}`);
  }
  return calls;
}
