import { describe, expect, it } from 'vitest';
import {
  checklistKeys,
  DEFAULT_CHECKLIST_KEYS,
  findKeyLabel,
  nextChecklistStep,
  renderTemplate,
  weaponKind,
  type ChecklistState,
} from '../../../src/a10/ui/checklist';
import type { ControlsReferenceRow } from '../../../src/a10/input/controlsReference';

const keys = DEFAULT_CHECKLIST_KEYS;

function state(patch: Partial<ChecklistState> = {}): ChecklistState {
  return {
    crashed: false,
    masterArm: 'SAFE',
    gunPac: 'SAFE',
    laserArm: 'SAFE',
    masterMode: 'NAV',
    weapon: 'GUN',
    profileMode: '',
    trigger: 0,
    twoStageTrigger: true,
    unlimitedAmmo: false,
    rounds: 1150,
    storesLeft: 0,
    releaseBelowGlass: false,
    releaseBelowMinimum: false,
    spiValid: false,
    spiSource: 'STPT',
    soi: 'HUD',
    tgpPageShown: false,
    mavPageShown: false,
    tgpPowered: false,
    tgpReady: false,
    tgpTracking: false,
    lasing: false,
    maverickPowered: true,
    maverickAligned: false,
    maverickLocked: false,
    maverickInZone: false,
    ...patch,
  };
}

describe('checklist strip: the gun', () => {
  it('walks Master Arm, GUN/PAC, master mode, then the trigger', () => {
    const s = state();
    expect(nextChecklistStep(s, keys)?.text).toBe('Master Arm → ARM [1]');
    s.masterArm = 'ARM';
    expect(nextChecklistStep(s, keys)?.text).toBe('GUN/PAC → ARM [2]');
    s.gunPac = 'ARM';
    expect(nextChecklistStep(s, keys)?.text).toBe('Master mode → GUNS [M]');
    s.masterMode = 'GUNS';
    const last = nextChecklistStep(s, keys)!;
    expect(last.text).toBe('Trigger: first detent for PAC [Left Shift], fire [Space]');
    expect(last.index).toBe(3);
    expect(last.count).toBe(4);
    expect(last.tone).toBe('act');
    expect(last.weapon).toBe('GAU-8/A');
  });

  it('TRAIN is not ARM, and GUNARM arms the gun without PAC', () => {
    expect(nextChecklistStep(state({ masterArm: 'TRAIN' }), keys)?.id).toBe('gun.masterArm');
    const s = state({ masterArm: 'ARM', gunPac: 'GUNARM', masterMode: 'GUNS', trigger: 1 });
    expect(nextChecklistStep(s, keys)?.text).toBe('First detent: fire [Space]');
    s.gunPac = 'ARM';
    expect(nextChecklistStep(s, keys)?.text).toBe('PAC holds the pipper: fire [Space]');
  });

  it('says when it is firing, and when the drum is empty', () => {
    const ready = { masterArm: 'ARM', gunPac: 'ARM', masterMode: 'GUNS' } as const;
    expect(nextChecklistStep(state({ ...ready, trigger: 2 }), keys)?.tone).toBe('active');
    const empty = nextChecklistStep(state({ ...ready, rounds: 0 }), keys)!;
    expect(empty.id).toBe('gun.empty');
    expect(empty.tone).toBe('warn');
    expect(empty.text).toContain('[Esc]');
    // unlimited ammunition never runs dry
    expect(nextChecklistStep(state({ ...ready, rounds: 0, unlimitedAmmo: true }), keys)?.id).toBe(
      'gun.trigger',
    );
  });

  it('one-stage trigger (Relaxed): just fire', () => {
    const s = state({
      masterArm: 'ARM',
      gunPac: 'ARM',
      masterMode: 'GUNS',
      twoStageTrigger: false,
    });
    expect(nextChecklistStep(s, keys)?.text).toBe('Trigger: fire [Space]');
    s.trigger = 1;
    expect(nextChecklistStep(s, keys)?.id).toBe('gun.firing');
  });

  it('shows nothing after a crash', () => {
    expect(nextChecklistStep(state({ crashed: true }), keys)).toBeNull();
  });
});

describe('checklist strip: stores', () => {
  it('CCIP bombs: arm, mode, then release (consent release below the glass)', () => {
    const s = state({ weapon: 'MK-82', profileMode: 'CCIP', masterMode: 'NAV', storesLeft: 2 });
    expect(nextChecklistStep(s, keys)?.id).toBe('bomb.masterArm');
    s.masterArm = 'ARM';
    expect(nextChecklistStep(s, keys)?.text).toBe('Master mode → CCIP [M]');
    s.masterMode = 'CCIP';
    expect(nextChecklistStep(s, keys)?.text).toBe('Pipper on the target, press release [Enter]');
    s.releaseBelowGlass = true;
    expect(nextChecklistStep(s, keys)?.id).toBe('bomb.consent');
    s.releaseBelowMinimum = true;
    expect(nextChecklistStep(s, keys)?.tone).toBe('warn');
  });

  it('CCRP needs the SPI first (the master mode is not available without one)', () => {
    const s = state({
      weapon: 'MK-82',
      profileMode: 'CCRP',
      masterMode: 'NAV',
      masterArm: 'ARM',
      storesLeft: 1,
    });
    expect(nextChecklistStep(s, keys)?.id).toBe('bomb.spi');
    s.spiValid = true;
    expect(nextChecklistStep(s, keys)?.text).toBe('Master mode → CCRP [M]');
    s.masterMode = 'CCRP';
    // the steerpoint is the SPI until a sensor makes one: CCRP onto it is said so
    expect(nextChecklistStep(s, keys)?.text).toBe(
      'CCRP onto the steerpoint: steer onto the azimuth line, hold release [Enter]',
    );
    s.spiSource = 'TGP';
    expect(nextChecklistStep(s, keys)?.text).toBe(
      'Steer onto the azimuth line and hold release [Enter] through the cue',
    );
  });

  it('GBU-12: laser arm, pod power, warm-up, TGP page as SOI, track, SPI, CCRP, release and lase', () => {
    const s = state({ weapon: 'GBU-12', masterArm: 'ARM', masterMode: 'NAV', storesLeft: 2 });
    const ids: string[] = [];
    const advance: (() => void)[] = [
      () => (s.laserArm = 'ARM'),
      () => (s.tgpPowered = true),
      () => (s.tgpReady = true),
      () => (s.tgpPageShown = true),
      () => (s.soi = 'TGP'),
      () => (s.tgpTracking = true),
      () => {
        s.spiSource = 'TGP';
        s.spiValid = true;
      },
      () => (s.masterMode = 'CCRP'),
    ];
    for (const next of advance) {
      ids.push(nextChecklistStep(s, keys)!.id);
      next();
    }
    ids.push(nextChecklistStep(s, keys)!.id);
    expect(ids).toEqual([
      'laserBomb.laserArm',
      'laserBomb.tgpPower',
      'laserBomb.tgpWarmup',
      'laserBomb.tgpPage',
      'laserBomb.tgpSoi',
      'laserBomb.track',
      'laserBomb.spi',
      'laserBomb.masterMode',
      'laserBomb.release',
    ]);
    // back to the HUD as SOI while the pod keeps its track: still ready to release
    s.soi = 'HUD';
    expect(nextChecklistStep(s, keys)?.id).toBe('laserBomb.release');
    s.lasing = true;
    expect(nextChecklistStep(s, keys)?.tone).toBe('active');
  });

  it('Maverick: power, alignment, MAV page as SOI, lock, zone, launch', () => {
    const s = state({ weapon: 'AGM-65D', masterArm: 'ARM', masterMode: 'NAV', storesLeft: 2 });
    s.maverickPowered = false;
    expect(nextChecklistStep(s, keys)?.id).toBe('maverick.power');
    s.maverickPowered = true;
    expect(nextChecklistStep(s, keys)?.id).toBe('maverick.align');
    s.maverickAligned = true;
    expect(nextChecklistStep(s, keys)?.id).toBe('maverick.mavPage');
    s.mavPageShown = true;
    expect(nextChecklistStep(s, keys)?.text).toBe('MAV page as sensor of interest [, / .]');
    s.soi = 'MAV';
    expect(nextChecklistStep(s, keys)?.text).toBe(
      'Slew the seeker onto the target [W A S D], lock [T]',
    );
    s.maverickLocked = true;
    expect(nextChecklistStep(s, keys)?.id).toBe('maverick.zone');
    s.maverickInZone = true;
    expect(nextChecklistStep(s, keys)?.id).toBe('maverick.release');
    // the lock holds when the HUD becomes the SOI again
    s.soi = 'HUD';
    expect(nextChecklistStep(s, keys)?.id).toBe('maverick.release');
  });

  it('a profile with nothing left says so', () => {
    const s = state({ weapon: 'MK-82', masterMode: 'CCIP', masterArm: 'ARM', storesLeft: 0 });
    const step = nextChecklistStep(s, keys)!;
    expect(step.tone).toBe('warn');
    expect(step.text).toContain('No Mk-82 left');
  });

  it('CCIP without a profile points back to the gun', () => {
    const s = state({ weapon: '', masterMode: 'CCIP', masterArm: 'ARM' });
    expect(nextChecklistStep(s, keys)?.id).toBe('none.profile');
  });

  it('classifies weapons', () => {
    expect(weaponKind('GUN')).toBe('gun');
    expect(weaponKind('AGM-65H')).toBe('maverick');
    expect(weaponKind('LAU-131-M156')).toBe('rocket');
    expect(weaponKind('MK-82AIR')).toBe('bomb');
    expect(weaponKind('CBU-97')).toBe('bomb');
    expect(weaponKind('GBU-12')).toBe('laserBomb');
    expect(weaponKind('AN/AAQ-28')).toBe('none');
  });
});

describe('checklist keys from the controls reference', () => {
  const row = (action: string, keyboard: string, group = 'Stick'): ControlsReferenceRow => ({
    group,
    action,
    keyboard,
    gamepad: '',
  });

  it('reads one action per row', () => {
    const rows = [
      row('Master Arm', 'Q'),
      row('Trigger: first detent (PAC-1)', 'Right Ctrl'),
      row('Trigger: fire (second detent)', 'Space'),
      row('Master mode', 'M'),
    ];
    const k = checklistKeys(rows);
    expect(k.masterArm).toBe('Q');
    expect(k.firstDetent).toBe('Right Ctrl');
    expect(k.fire).toBe('Space');
    expect(k.masterMode).toBe('M');
    // not in the reference: the default layout
    expect(k.gunPac).toBe('2');
  });

  it('reads the matching position of a list row', () => {
    const rows = [
      row('Armament panel: Master Arm, GUN/PAC, laser arm, pod power', '1, 2, 3, 4, or click'),
      row('Trigger: first detent (PAC-1), second detent (fire)', 'Left Shift, Space'),
    ];
    expect(findKeyLabel(rows, 'masterArm')).toBe('1');
    expect(findKeyLabel(rows, 'gunPac')).toBe('2');
    expect(findKeyLabel(rows, 'laserArm')).toBe('3');
    expect(findKeyLabel(rows, 'tgpPower')).toBe('4');
    expect(findKeyLabel(rows, 'firstDetent')).toBe('Left Shift');
    expect(findKeyLabel(rows, 'fire')).toBe('Space');
  });

  it('a single-action row wins over a list row, and rows without a key are skipped', () => {
    const rows = [
      row('Armament panel: Master Arm, GUN/PAC', '1, 2'),
      row('Master Arm', ''),
      row('Master Arm switch', 'F12'),
    ];
    expect(findKeyLabel(rows, 'masterArm')).toBe('F12');
    expect(findKeyLabel([row('Previous / next weapon profile', '[ / ]')], 'profile')).toBe('[ / ]');
  });

  it('prefers the reference rows’ stable ids, and falls back when nothing is bound', () => {
    const rows: ControlsReferenceRow[] = [
      {
        id: 'masterMode',
        group: 'HUD',
        action: 'Master mode: NAV, GUNS, CCIP, CCRP',
        keyboard: 'N',
        gamepad: 'X',
      },
      {
        id: 'trigger1',
        group: 'Stick',
        action: 'Trigger: first detent (PAC-1)',
        keyboard: 'Left Shift',
        gamepad: 'RT half',
      },
      {
        id: 'trigger2',
        group: 'Stick',
        action: 'Trigger: second detent (fire)',
        keyboard: 'Space',
        gamepad: 'RT full',
      },
      { id: 'gunPac', group: 'Armament panel', action: 'GUN/PAC', keyboard: '—', gamepad: '—' },
    ];
    expect(findKeyLabel(rows, 'masterMode')).toBe('N');
    expect(findKeyLabel(rows, 'firstDetent')).toBe('Left Shift');
    expect(findKeyLabel(rows, 'fire')).toBe('Space');
    expect(findKeyLabel(rows, 'gunPac')).toBe(DEFAULT_CHECKLIST_KEYS.gunPac);
  });

  it('works with the input module’s live reference', async () => {
    const { getControlsReference } = await import('../../../src/a10/input/controlsReference');
    const k = checklistKeys(getControlsReference());
    for (const label of Object.values(k)) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe('—');
    }
    // the two display keys of the SOI row (HUD, left display, right display)
    expect(k.soiDisplay).toBe('comma / full stop');
  });

  it('a display step names the two display keys of the SOI row', () => {
    const soi: ControlsReferenceRow = {
      id: 'soi',
      group: 'HUD and displays',
      action: 'Sensor of interest: HUD, left display, right display',
      keyboard: 'H, J, K',
      gamepad: '',
    };
    expect(findKeyLabel([soi], 'soiDisplay')).toBe('J / K');
    expect(findKeyLabel([{ ...soi, keyboard: 'H / comma / full stop' }], 'soiDisplay')).toBe(
      'comma / full stop',
    );
    expect(findKeyLabel([{ ...soi, keyboard: 'H' }], 'soiDisplay')).toBe(
      DEFAULT_CHECKLIST_KEYS.soiDisplay,
    );
    expect(findKeyLabel([], 'soiDisplay')).toBe(DEFAULT_CHECKLIST_KEYS.soiDisplay);
  });

  it('renders templates into text and key caps', () => {
    const r = renderTemplate('Master Arm → ARM {masterArm}', keys);
    expect(r.text).toBe('Master Arm → ARM [1]');
    expect(r.parts).toEqual([{ text: 'Master Arm → ARM ' }, { key: '1' }]);
    const unknown = renderTemplate('a {nope} b', keys);
    expect(unknown.text).toBe('a {nope} b');
    expect(unknown.parts).toEqual([{ text: 'a {nope} b' }]);
  });
});

describe('checklist strip on a real simulation', () => {
  it('reads the sim: the gun in NAV and GUNS, the profile store in CCIP', async () => {
    const { createSim } = await import('../../../src/a10/core/sim');
    const { createFlatTerrain } = await import('../../../src/a10/core/world');
    const { checklistStateFromSim } = await import('../../../src/a10/ui/checklist');
    const sim = createSim({ terrain: createFlatTerrain() });
    const s = checklistStateFromSim(sim);
    expect(s.weapon).toBe('GUN');
    expect(s.masterArm).toBe(sim.avionics.masterArm);
    expect(s.rounds).toBe(sim.gun.rounds);
    expect(s.twoStageTrigger).toBe(true);
    expect(nextChecklistStep(s, DEFAULT_CHECKLIST_KEYS)?.weapon).toBe('GAU-8/A');
    sim.avionics.masterMode = 'CCIP';
    sim.avionics.selectedProfile = '';
    expect(checklistStateFromSim(sim).weapon).toBe('');
  });

  it('a Maverick profile is the weapon in NAV too (it launches in any master mode), not in GUNS', async () => {
    const { createSim } = await import('../../../src/a10/core/sim');
    const { createFlatTerrain } = await import('../../../src/a10/core/world');
    const { checklistStateFromSim } = await import('../../../src/a10/ui/checklist');
    const sim = createSim({ terrain: createFlatTerrain(), loadoutId: 'tankHunter' });
    const av = sim.avionics;
    const mav = av.profiles.find((p) => p.store === 'AGM-65D')!;
    const bomb = av.profiles.find((p) => p.store === 'MK-82')!;
    expect(mav).toBeDefined();
    av.selectedProfile = mav.id;
    av.masterMode = 'NAV';
    let s = checklistStateFromSim(sim);
    expect(s.weapon).toBe('AGM-65D');
    expect(s.storesLeft).toBe(2);
    expect(s.maverickPowered).toBe(sim.sensors.mavPower);
    // the air start: the SPI at the steerpoint, the HUD as SOI, TAD and DSMS on the displays
    expect(s.spiSource).toBe(av.spi.source);
    expect(s.soi).toBe('HUD');
    expect(s.mavPageShown).toBe(av.mfd.left === 'MAV' || av.mfd.right === 'MAV');
    av.masterMode = 'GUNS';
    expect(checklistStateFromSim(sim).weapon).toBe('GUN');
    // a bomb profile in NAV: the gun (the bomb needs CCIP or CCRP, the gun fires in any mode)
    av.selectedProfile = bomb.id;
    av.masterMode = 'NAV';
    expect(checklistStateFromSim(sim).weapon).toBe('GUN');
    // the SOI follows the display the avionics names
    av.mfd.right = 'MAV';
    av.soi = 'RMFD';
    s = checklistStateFromSim(sim);
    expect(s.soi).toBe('MAV');
    expect(s.mavPageShown).toBe(true);
  });
});
