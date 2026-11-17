/**
 * Everything in the cockpit that can be clicked, the command each click queues and the hover
 * label. OWNED BY THE COCKPIT MODULE. Pure (no scene, no DOM): unit-tested in
 * tests/unit/a10/cockpitPanel.test.ts.
 *
 *   controls     the switches of switches.ts (COCKPIT_CONTROLS): AHCP, stick, UFC STEER and
 *                ALT ALRT, flaps, gear, the LASTE panel's autopilot button and mode switch,
 *                g-meter
 *   OSBs         'osb:L:1' … 'osb:R:20': each queues { type: 'osb', display, button }; the hover
 *                label is the avionics' label for the page the display shows (OSB_TABLE, read
 *                through osbBinding), with its live value when the binding has one
 *   UFC keys     'ufc:<key>' for the keys without a simulation command yet (digits, ENT, CLR…):
 *                they move, queue nothing
 *   AHCP decor   'ahcp:<switch>' for the decorative switches (HUD DAY/NIGHT, NORM/STBY, CICU,
 *                JTRS, IFFCC): they move, queue nothing
 */
import { osbBinding } from '../../core/avionics';
import type { MfdPage } from '../../core/avionics/types';
import type { Command, Sim } from '../../core/types';
import {
  AHCP_SWITCHES,
  ahcpSwitch,
  type AhcpDecorId,
  type AhcpDecorState,
  type AhcpLiveId,
} from './ahcp';
import { OSB_COUNT, type MfcdSide } from './mfcd';
import {
  COCKPIT_CONTROLS,
  commandForControl,
  controlStateText,
  type CockpitControlId,
  type CockpitSwitchState,
} from './switches';
import { UFC_KEYS, ufcKey, type UfcKeyId } from './ufc';

export type OsbClickId = `osb:${MfcdSide}:${number}`;
export type UfcClickId = `ufc:${UfcKeyId}`;
export type DecorClickId = `ahcp:${AhcpDecorId}`;
export type ClickId = CockpitControlId | OsbClickId | UfcClickId | DecorClickId;

export function osbClickId(side: MfcdSide, button: number): OsbClickId {
  return `osb:${side}:${button}`;
}

/** The display and button of an OSB click id, or null. */
export function parseOsb(id: string): { display: MfcdSide; button: number } | null {
  if (!id.startsWith('osb:')) return null;
  const display = id.charAt(4);
  const button = Number(id.slice(6));
  if ((display !== 'L' && display !== 'R') || !Number.isInteger(button)) return null;
  if (button < 1 || button > OSB_COUNT) return null;
  return { display, button };
}

/** Every OSB of both displays: 'osb:L:1' … 'osb:R:20'. */
export function allOsbClickIds(): OsbClickId[] {
  const out: OsbClickId[] = [];
  for (const side of ['L', 'R'] as const)
    for (let b = 1; b <= OSB_COUNT; b++) out.push(osbClickId(side, b));
  return out;
}

/** The UFC keys that are controls of switches.ts (they queue commands): key → control. */
const UFC_CONTROL = new Map<UfcKeyId, CockpitControlId>();
for (const c of COCKPIT_CONTROLS) if (c.target.kind === 'ufc') UFC_CONTROL.set(c.target.key, c.id);

/** The click id of a UFC key: its control if it has one, else 'ufc:<key>'. */
export function ufcClickId(key: UfcKeyId): CockpitControlId | UfcClickId {
  return UFC_CONTROL.get(key) ?? `ufc:${key}`;
}

/** The UFC key a click id presses (for the key's animation), or null. */
export function ufcKeyOf(id: ClickId): UfcKeyId | null {
  if (id.startsWith('ufc:')) return id.slice(4) as UfcKeyId;
  const c = COCKPIT_CONTROLS.find((x) => x.id === id);
  return c && c.target.kind === 'ufc' ? c.target.key : null;
}

/** Every UFC key's click id (controls for STEER and ALT ALRT, 'ufc:<key>' for the rest). */
export function allUfcClickIds(): (CockpitControlId | UfcClickId)[] {
  return UFC_KEYS.map((k) => ufcClickId(k.id));
}

/** The AHCP switches' click ids: the live ones are controls, the decorative 'ahcp:<id>'. */
export function ahcpClickId(id: AhcpLiveId | AhcpDecorId): CockpitControlId | DecorClickId {
  return ahcpSwitch(id).live ? (id as CockpitControlId) : (`ahcp:${id}` as DecorClickId);
}

export function allAhcpClickIds(): (CockpitControlId | DecorClickId)[] {
  return AHCP_SWITCHES.map((s) => ahcpClickId(s.id));
}

function isControl(id: string): id is CockpitControlId {
  return COCKPIT_CONTROLS.some((c) => c.id === id);
}

/**
 * The command a click queues (null: nothing — a decorative switch, a UFC key without a command
 * yet, the g-meter reset). `button`: 0 left, 2 right.
 */
export function clickCommand(id: ClickId, button: number, s: CockpitSwitchState): Command | null {
  if (isControl(id)) return commandForControl(id, button, s);
  const osb = parseOsb(id);
  if (osb) return { type: 'osb', display: osb.display, button: osb.button };
  return null;
}

type ValueBinding = { value?: (sim: Sim, display: MfcdSide) => string };

/** The page a display shows. */
function pageOf(sim: Sim, side: MfcdSide): MfdPage {
  return side === 'L' ? sim.avionics.mfd.left : sim.avionics.mfd.right;
}

/**
 * An OSB's label for the page its display shows (avionics' OSB table): '' when the button has
 * no function on that page.
 */
export function osbHoverLabel(sim: Sim, side: MfcdSide, button: number): string {
  const b = osbBinding(pageOf(sim, side), button);
  if (!b) return '';
  const value = (b as ValueBinding).value?.(sim, side) ?? '';
  return value ? `${b.label} ${value}` : b.label;
}

/** The hover label of anything clickable ("MASTER ARM  SAFE", "LEFT MFCD OSB 6  PROF+"). */
export function clickHoverText(
  id: ClickId,
  sim: Sim,
  s: CockpitSwitchState,
  decor: AhcpDecorState,
): string {
  if (isControl(id)) {
    const c = COCKPIT_CONTROLS.find((x) => x.id === id);
    const label = c ? c.label : id;
    const state = controlStateText(id, s);
    return state ? `${label}  ${state}` : label;
  }
  const osb = parseOsb(id);
  if (osb) {
    const name = `${osb.display === 'L' ? 'LEFT' : 'RIGHT'} MFCD OSB ${osb.button}`;
    const label = osbHoverLabel(sim, osb.display, osb.button);
    return label ? `${name}  ${label}` : name;
  }
  if (id.startsWith('ufc:')) return `UFC ${ufcKey(id.slice(4) as UfcKeyId).name}`;
  if (id.startsWith('ahcp:')) {
    const def = ahcpSwitch(id.slice(5) as AhcpDecorId);
    const pos =
      def.positions[Math.max(0, Math.min(def.positions.length - 1, decor[def.id as AhcpDecorId]))];
    return `${def.label.replace('\n', ' ')}  ${pos}`;
  }
  return id;
}
