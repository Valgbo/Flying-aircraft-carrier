/**
 * The checklist strip (PLAN_A10.md §2): one line naming the next real step toward employing the
 * current weapon, derived from the simulation state. Pure functions: the bridge (bridge.ts)
 * snapshots the sim with checklistStateFromSim() once per frame and the strip re-renders only
 * when the resulting line changes. Covered by tests/unit/a10/ui-checklist.test.ts.
 *
 * Step text is a small template: `{masterArm}` stands for the key bound to that action, so the
 * same step renders as key caps in the strip and as `[1]` in plain text.
 */
import type { Sim } from '../core/types';
import type { ControlsReferenceRow } from '../input/controlsReference';

/** The actions a checklist step can name a key for. */
export type ChecklistKeyId =
  | 'masterArm'
  | 'gunPac'
  | 'laserArm'
  | 'tgpPower'
  | 'masterMode'
  | 'firstDetent'
  | 'fire'
  | 'release'
  | 'profile'
  | 'tmsUp'
  | 'laser'
  | 'slew'
  | 'pause';

export type ChecklistKeys = Record<ChecklistKeyId, string>;

/** The default keyboard layout of PLAN_A10.md §12, used when the reference has no row for one. */
export const DEFAULT_CHECKLIST_KEYS: ChecklistKeys = {
  masterArm: '1',
  gunPac: '2',
  laserArm: '3',
  tgpPower: '4',
  masterMode: 'M',
  firstDetent: 'Left Shift',
  fire: 'Space',
  release: 'Enter',
  profile: '[ / ]',
  tmsUp: 'T',
  laser: 'L',
  slew: 'W A S D',
  pause: 'Esc',
};

/** The controls reference's stable row id for each action. */
const ROW_IDS: Record<ChecklistKeyId, string> = {
  masterArm: 'masterArm',
  gunPac: 'gunPac',
  laserArm: 'laserArm',
  tgpPower: 'tgpPower',
  masterMode: 'masterMode',
  firstDetent: 'trigger1',
  fire: 'trigger2',
  release: 'weaponRelease',
  profile: 'profile',
  tmsUp: 'tmsUp',
  laser: 'laser',
  slew: 'slew',
  pause: 'pause',
};

/** Rows without an id are recognised by their wording (PLAN §12). */
const KEY_MATCHERS: Record<ChecklistKeyId, RegExp> = {
  masterArm: /\bmaster arm\b/i,
  gunPac: /\bgun\s*\/\s*pac\b/i,
  laserArm: /\blaser arm\b/i,
  tgpPower: /\b(?:pod power|tgp power|targeting pod power)\b/i,
  masterMode: /\bmaster mode\b/i,
  firstDetent: /\bfirst detent\b|\bpac-1\b/i,
  fire: /\bsecond detent\b|\btrigger:?\s*fire\b/i,
  release: /\bweapon release\b|\bpickle\b/i,
  profile: /\bweapon profile\b/i,
  tmsUp: /\btarget management up\b|\btms up\b/i,
  laser: /\bfire the laser\b|\blaser fire\b/i,
  slew: /\bslew\b/i,
  pause: /\bpause\b/i,
};

/** A keyboard column that names no key ('', '—'). */
export function isNoKey(label: string): boolean {
  return /^[\s\u2014\u2013-]*$/.test(label);
}

/** Split "a, b, or c" into its items (commas only: "Previous / next" stays one item). */
function listItems(text: string): string[] {
  return text
    .split(/,\s*(?:or\s+)?/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The keyboard label for one action from the controls reference: the row with the action's
 * stable id, else a row recognised by its wording. A row may name one action ("Master Arm" ·
 * "1") or a list ("Armament panel: Master Arm, GUN/PAC, laser arm, pod power" · "1, 2, 3, 4,
 * or click"); in a list the key is taken from the same position. Without a bound key the
 * default layout of PLAN §12 is shown.
 */
export function findKeyLabel(rows: readonly ControlsReferenceRow[], id: ChecklistKeyId): string {
  const byId = rows.find((r) => r.id === ROW_IDS[id]);
  if (byId) return isNoKey(byId.keyboard) ? DEFAULT_CHECKLIST_KEYS[id] : byId.keyboard.trim();
  const match = KEY_MATCHERS[id];
  let fromList: string | null = null;
  for (const row of rows) {
    const keyboard = row.keyboard.trim();
    if (isNoKey(keyboard) || !match.test(row.action)) continue;
    const actions = listItems(row.action);
    if (actions.length <= 1) return keyboard;
    if (fromList !== null) continue;
    const keys = listItems(keyboard);
    const index = actions.findIndex((a) => match.test(a));
    if (index >= 0 && keys.length >= actions.length) fromList = keys[index];
  }
  return fromList ?? DEFAULT_CHECKLIST_KEYS[id];
}

/** Every checklist key resolved against the current controls reference. */
export function checklistKeys(rows: readonly ControlsReferenceRow[]): ChecklistKeys {
  const out = { ...DEFAULT_CHECKLIST_KEYS };
  for (const id of Object.keys(out) as ChecklistKeyId[]) out[id] = findKeyLabel(rows, id);
  return out;
}

// ---------------------------------------------------------------------------------------------

/** What the checklist needs to know about the aircraft, in plain values. */
export interface ChecklistState {
  crashed: boolean;
  masterArm: string;
  gunPac: string;
  laserArm: string;
  masterMode: string;
  /** 'GUN', or the store type of the selected weapon profile ('' when none is selected). */
  weapon: string;
  /** Delivery mode of the selected profile ('CCIP' / 'CCRP'), '' for none. */
  profileMode: string;
  trigger: 0 | 1 | 2;
  twoStageTrigger: boolean;
  unlimitedAmmo: boolean;
  rounds: number;
  /** Stores of the selected type still on the stations. */
  storesLeft: number;
  releaseBelowGlass: boolean;
  releaseBelowMinimum: boolean;
  spiValid: boolean;
  tgpPowered: boolean;
  tgpReady: boolean;
  tgpTracking: boolean;
  lasing: boolean;
  maverickAligned: boolean;
  maverickLocked: boolean;
  maverickInZone: boolean;
}

export type ChecklistTone = 'todo' | 'act' | 'active' | 'warn';

export interface ChecklistPart {
  text?: string;
  key?: string;
}

export interface ChecklistStep {
  /** Stable id of the step (tests, React keys), e.g. 'gun.masterArm'. */
  id: string;
  /** The weapon the procedure is for, as the strip labels it. */
  weapon: string;
  /** Position of this step in the procedure (0-based) and the number of steps. */
  index: number;
  count: number;
  /** todo: a switch to set · act: the weapon is ready, do it · active: doing it · warn: blocked. */
  tone: ChecklistTone;
  parts: ChecklistPart[];
  /** The line as plain text with keys in brackets, e.g. 'Master Arm → ARM [1]'. */
  text: string;
}

interface StepDef {
  id: string;
  template: string;
  tone?: ChecklistTone;
}

/** One step of a procedure: done steps are skipped; the first one not done is the next step. */
interface ProcedureStep {
  done: boolean;
  step: StepDef;
}

const KEY_TOKEN = /\{(\w+)\}/g;

/** Turn a template into text and key-cap parts. Unknown tokens are kept as text. */
export function renderTemplate(
  template: string,
  keys: ChecklistKeys,
): { parts: ChecklistPart[]; text: string } {
  const parts: ChecklistPart[] = [];
  let text = '';
  let last = 0;
  for (const m of template.matchAll(KEY_TOKEN)) {
    const id = m[1] as ChecklistKeyId;
    const before = template.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    if (!(id in keys)) {
      parts.push({ text: before + m[0] });
      text += before + m[0];
      continue;
    }
    if (before) parts.push({ text: before });
    parts.push({ key: keys[id] });
    text += `${before}[${keys[id]}]`;
  }
  const rest = template.slice(last);
  if (rest) parts.push({ text: rest });
  text += rest;
  // merge neighbouring text parts (an unknown token next to text)
  const merged: ChecklistPart[] = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if (p.text !== undefined && prev?.text !== undefined) prev.text += p.text;
    else merged.push({ ...p });
  }
  return { parts: merged, text };
}

type WeaponKind = 'gun' | 'bomb' | 'laserBomb' | 'rocket' | 'maverick' | 'none';

export function weaponKind(weapon: string): WeaponKind {
  if (weapon === 'GUN') return 'gun';
  if (weapon.startsWith('AGM-65')) return 'maverick';
  if (weapon === 'GBU-12') return 'laserBomb';
  if (weapon.startsWith('LAU-131') || weapon.startsWith('LAU-68')) return 'rocket';
  if (weapon.startsWith('MK-82') || weapon.startsWith('CBU-')) return 'bomb';
  return 'none';
}

/** How the strip names a weapon. */
export function weaponLabel(weapon: string): string {
  switch (weaponKind(weapon)) {
    case 'gun':
      return 'GAU-8/A';
    case 'rocket':
      return 'Rockets';
    case 'none':
      return weapon || 'No weapon';
    default:
      return weapon.replace('MK-', 'Mk-').replace('AIR', ' AIR');
  }
}

const ARM: ProcedureStep['step'] = { id: 'masterArm', template: 'Master Arm → ARM {masterArm}' };

function gunProcedure(s: ChecklistState): ProcedureStep[] {
  let fire: StepDef;
  if (s.rounds <= 0 && !s.unlimitedAmmo) {
    fire = {
      id: 'empty',
      template: 'Gun empty: rearm and refuel from the pause menu {pause}',
      tone: 'warn',
    };
  } else if (s.trigger === 2 || (!s.twoStageTrigger && s.trigger === 1)) {
    fire = {
      id: 'firing',
      template: 'Firing: release after a one- to two-second burst',
      tone: 'active',
    };
  } else if (!s.twoStageTrigger) {
    fire = { id: 'trigger', template: 'Trigger: fire {fire}', tone: 'act' };
  } else if (s.trigger === 1) {
    fire =
      s.gunPac === 'ARM'
        ? { id: 'pac', template: 'PAC holds the pipper: fire {fire}', tone: 'active' }
        : { id: 'detent', template: 'First detent: fire {fire}', tone: 'active' };
  } else {
    fire = {
      id: 'trigger',
      template: 'Trigger: first detent for PAC {firstDetent}, fire {fire}',
      tone: 'act',
    };
  }
  return [
    { done: s.masterArm === 'ARM', step: ARM },
    { done: s.gunPac !== 'SAFE', step: { id: 'gunPac', template: 'GUN/PAC → ARM {gunPac}' } },
    {
      done: s.masterMode === 'GUNS',
      step: { id: 'masterMode', template: 'Master mode → GUNS {masterMode}' },
    },
    { done: false, step: fire },
  ];
}

function modeStep(mode: string): ProcedureStep['step'] {
  return { id: 'masterMode', template: `Master mode → ${mode} {masterMode}` };
}

function bombProcedure(s: ChecklistState): ProcedureStep[] {
  const ccrp = s.profileMode === 'CCRP' || (s.profileMode === '' && s.masterMode === 'CCRP');
  const mode = ccrp ? 'CCRP' : 'CCIP';
  const steps: ProcedureStep[] = [
    { done: s.masterArm === 'ARM', step: ARM },
    { done: s.masterMode === mode, step: modeStep(mode) },
  ];
  if (ccrp) {
    steps.push({
      done: s.spiValid,
      step: { id: 'spi', template: 'Set the SPI: point track with the pod, hold {tmsUp}' },
    });
    steps.push({
      done: false,
      step: {
        id: 'release',
        template: 'Steer onto the azimuth line and hold release {release} through the cue',
        tone: 'act',
      },
    });
  } else {
    let release: StepDef;
    if (s.releaseBelowMinimum)
      release = {
        id: 'low',
        template: 'Below the fuze arming height: release higher',
        tone: 'warn',
      };
    else if (s.releaseBelowGlass)
      release = {
        id: 'consent',
        template: 'Hold release {release} and fly the pipper through the target',
        tone: 'act',
      };
    else
      release = {
        id: 'release',
        template: 'Pipper on the target, press release {release}',
        tone: 'act',
      };
    steps.push({ done: false, step: release });
  }
  return steps;
}

function rocketProcedure(s: ChecklistState): ProcedureStep[] {
  return [
    { done: s.masterArm === 'ARM', step: ARM },
    { done: s.masterMode === 'CCIP', step: modeStep('CCIP') },
    {
      done: false,
      step: {
        id: 'release',
        template: 'Rocket pipper on the target, press release {release}',
        tone: 'act',
      },
    },
  ];
}

function laserBombProcedure(s: ChecklistState): ProcedureStep[] {
  return [
    { done: s.masterArm === 'ARM', step: ARM },
    {
      done: s.laserArm === 'ARM',
      step: { id: 'laserArm', template: 'Laser arm → ARM {laserArm}' },
    },
    {
      done: s.tgpPowered,
      step: { id: 'tgpPower', template: 'Targeting pod power → ON {tgpPower}' },
    },
    {
      done: s.tgpReady,
      step: { id: 'tgpWarmup', template: 'Targeting pod warming up', tone: 'warn' },
    },
    {
      done: s.tgpTracking,
      step: { id: 'track', template: 'Slew the pod onto the target {slew}, track {tmsUp}' },
    },
    { done: s.masterMode === 'CCRP', step: modeStep('CCRP') },
    {
      done: false,
      step: s.lasing
        ? {
            id: 'lasing',
            template: 'Lasing: hold the spot on the target until impact',
            tone: 'active',
          }
        : {
            id: 'release',
            template: 'Hold release {release} at the cue, lase {laser} for the last 10 s',
            tone: 'act',
          },
    },
  ];
}

function maverickProcedure(s: ChecklistState): ProcedureStep[] {
  return [
    { done: s.masterArm === 'ARM', step: ARM },
    {
      done: s.maverickAligned,
      step: { id: 'align', template: 'Maverick seeker aligning: no video yet', tone: 'warn' },
    },
    {
      done: s.maverickLocked,
      step: { id: 'lock', template: 'Slew the seeker onto the target {slew}, lock {tmsUp}' },
    },
    {
      done: s.maverickInZone,
      step: { id: 'zone', template: 'Locked: close in until the launch zone is met' },
    },
    {
      done: false,
      step: {
        id: 'release',
        template: 'Hold release {release} for a second to launch',
        tone: 'act',
      },
    },
  ];
}

/**
 * The next real step toward employing the current weapon, or null when there is nothing to
 * show (crashed). In NAV and GUNS the current weapon is the gun; in CCIP and CCRP it is the
 * selected profile's store.
 */
export function nextChecklistStep(s: ChecklistState, keys: ChecklistKeys): ChecklistStep | null {
  if (s.crashed) return null;
  const kind = weaponKind(s.weapon);
  let procedure: ProcedureStep[];
  if (kind === 'gun') procedure = gunProcedure(s);
  else if (kind === 'none') {
    procedure = [
      { done: s.masterArm === 'ARM', step: ARM },
      {
        done: false,
        step: {
          id: 'profile',
          template: `No weapon profile in ${s.masterMode}: select one {profile} or Master mode → GUNS {masterMode}`,
          tone: 'warn',
        },
      },
    ];
  } else if (s.storesLeft <= 0 && !s.unlimitedAmmo) {
    procedure = [
      {
        done: false,
        step: {
          id: 'empty',
          template: `No ${weaponLabel(s.weapon)} left: next profile {profile} or rearm {pause}`,
          tone: 'warn',
        },
      },
    ];
  } else if (kind === 'bomb') procedure = bombProcedure(s);
  else if (kind === 'rocket') procedure = rocketProcedure(s);
  else if (kind === 'laserBomb') procedure = laserBombProcedure(s);
  else procedure = maverickProcedure(s);

  const index = procedure.findIndex((p) => !p.done);
  const at = index < 0 ? procedure.length - 1 : index;
  const def = procedure[at].step;
  const { parts, text } = renderTemplate(def.template, keys);
  return {
    id: `${kind}.${def.id}`,
    weapon: weaponLabel(s.weapon),
    index: at,
    count: procedure.length,
    tone: def.tone ?? 'todo',
    parts,
    text,
  };
}

// ---------------------------------------------------------------------------------------------

/** Snapshot the sim for the checklist (the selected weapon follows the master mode). */
export function checklistStateFromSim(sim: Sim): ChecklistState {
  const av = sim.avionics;
  const gunMode = av.masterMode === 'NAV' || av.masterMode === 'GUNS';
  const profile = gunMode ? undefined : av.profiles.find((p) => p.id === av.selectedProfile);
  const weapon = gunMode ? 'GUN' : (profile?.store ?? '');
  let storesLeft = 0;
  if (profile) {
    for (const st of sim.stores.stations) for (const s of st.stores) if (s === weapon) storesLeft++;
  }
  const tgp = sim.sensors.tgp;
  const mav =
    sim.sensors.selectedMaverick >= 0 ? sim.sensors.mavericks[sim.sensors.selectedMaverick] : null;
  return {
    crashed: sim.aircraft.crashed,
    masterArm: av.masterArm,
    gunPac: av.gunPac,
    laserArm: av.laserArm,
    masterMode: av.masterMode,
    weapon,
    profileMode: profile?.mode ?? '',
    trigger: sim.input.trigger,
    twoStageTrigger: sim.options.realism.twoStageTrigger,
    unlimitedAmmo: sim.options.realism.unlimitedAmmo,
    rounds: sim.gun.rounds,
    storesLeft,
    releaseBelowGlass: av.release.belowGlass,
    releaseBelowMinimum: av.release.belowMinimum,
    spiValid: av.spi.valid,
    tgpPowered: av.tgpPower && tgp.powered,
    tgpReady: tgp.warmup <= 0,
    tgpTracking: tgp.mode === 'POINT' || tgp.mode === 'AREA',
    lasing: tgp.lasing,
    maverickAligned: mav ? mav.align <= 0 : false,
    maverickLocked: mav?.locked ?? false,
    maverickInZone: mav?.inZone ?? false,
  };
}
