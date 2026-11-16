/** How the overlay names the scenarios (PLAN_A10.md §11). */
import type { ScenarioKind } from '../core/types';

export const SCENARIO_NAMES: Record<ScenarioKind, string> = {
  freeHunt: 'Free hunt',
  strafePit: 'Strafe pit',
  bombCircle: 'Bombing circle',
  tacticalLane: 'Tactical lane',
  empty: 'Empty range',
};

export function scenarioName(kind: string): string {
  return SCENARIO_NAMES[kind as ScenarioKind] ?? kind;
}
