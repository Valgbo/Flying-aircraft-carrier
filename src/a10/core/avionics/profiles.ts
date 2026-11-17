/**
 * Weapon profiles, master modes and the stores page (PLAN_A10.md §6.5, §6.8, §7).
 *
 * Profiles. One default profile per weapon store type loaded (PROFILE_DEFAULTS: delivery mode,
 * single / pairs / ripple, quantity, spacing, fuze, minimum altitude, arming time). The selected
 * ("active") profile is the weapon of the CCIP and CCRP master modes; DMS left/right with the HUD
 * as SOI or the 'profile' command step through the profiles whose store is still loaded. In
 * CCIP or CCRP the master mode follows the delivery mode of the newly selected profile (the
 * A-10C behaviour), and the master-mode button sets the delivery for the profile in use.
 *
 * Master modes ('next' cycles NAV → GUNS → CCIP → CCRP → NAV, skipping those not available):
 *   NAV, GUNS  always;
 *   CCIP       a CCIP-capable profile is loaded (it is selected), or the gun has rounds: with no
 *              CCIP store the gun is the CCIP weapon and the HUD keeps the gun reticle (wave 2
 *              replaces it with the store's CCIP pipper when a store is selected);
 *   CCRP       a valid SPI and a CCRP-capable profile.
 *
 * The weapon sight (`avionics.sight`) the HUD draws follows from the mode and the profile.
 */
import type { Sim } from '../types';
import { HIGH_DRAG_STORES, PROFILE_DEFAULTS, PROFILE_EDIT, RELEASE } from '../../data/avionics';
import { STORES } from '../../data/munitions';
import type { StoreType } from '../weapons/types';
import { notify, switched } from './notify';
import { onStation, storeRemaining } from './stations';
import type {
  AvionicsState,
  DeliveryMode,
  DsmsProfileView,
  DsmsStationView,
  DsmsView,
  FuzeOption,
  MasterMode,
  ReleaseMode,
  WeaponProfile,
} from './types';

const NO_MODES: readonly DeliveryMode[] = [];
const CCIP_ONLY: readonly DeliveryMode[] = ['CCIP'];
const CCRP_ONLY: readonly DeliveryMode[] = ['CCRP'];

/** Stores of a type still on the stations. */
export function storeCount(sim: Sim, store: string): number {
  let n = 0;
  const stations = sim.stores.stations;
  for (let i = 0; i < stations.length; i++) {
    const list = stations[i].stores;
    for (let j = 0; j < list.length; j++) if (list[j] === store) n++;
  }
  return n;
}

export function profileById(av: AvionicsState, id: string): WeaponProfile | null {
  if (!id) return null;
  const list = av.profiles;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

export function selectedProfile(sim: Sim): WeaponProfile | null {
  return profileById(sim.avionics, sim.avionics.selectedProfile);
}

/** The deliveries a profile's store supports. */
export function profileModes(p: WeaponProfile): readonly DeliveryMode[] {
  const d = PROFILE_DEFAULTS[p.store];
  if (d) return d.modes;
  return p.mode === 'NONE' ? NO_MODES : p.mode === 'CCIP' ? CCIP_ONLY : CCRP_ONLY;
}

export function profileSupports(p: WeaponProfile, mode: DeliveryMode): boolean {
  return profileModes(p).includes(mode);
}

/**
 * The profile's store is still loaded (rocket pods: with rockets left), or the realism preset
 * gives unlimited stores.
 */
export function profileAvailable(sim: Sim, p: WeaponProfile): boolean {
  return sim.options.realism.unlimitedAmmo || storeRemaining(sim, p.store) > 0;
}

export function gunAvailable(sim: Sim): boolean {
  return sim.options.realism.unlimitedAmmo || sim.gun.rounds > 0;
}

/**
 * Create the default profile of every weapon store type on the stations that has none yet
 * (profiles already present are kept with their settings). Selects one if none is selected.
 */
export function buildProfiles(sim: Sim): void {
  const av = sim.avionics;
  for (const st of sim.stores.stations) {
    for (const store of st.stores) {
      const d = PROFILE_DEFAULTS[store];
      if (!d) continue;
      let known = false;
      for (const p of av.profiles) if (p.store === store) known = true;
      if (known) continue;
      const p: WeaponProfile = {
        id: d.name,
        name: d.name,
        store,
        mode: d.modes.length > 0 ? d.modes[0] : 'NONE',
        release: d.release,
        rippleQty: d.rippleQty,
        rippleSpacing: d.rippleSpacing,
        fuze: d.fuze,
        minAltitude: d.minAltitude,
        armingTime: d.armingTime,
        drag: d.drag ?? 'LD',
      };
      if (d.laserCode !== undefined) p.laserCode = d.laserCode;
      av.profiles.push(p);
    }
  }
  if (!profileById(av, av.selectedProfile)) {
    av.selectedProfile = '';
    const first =
      av.profiles.find((p) => profileSupports(p, 'CCIP') && profileAvailable(sim, p)) ??
      av.profiles.find((p) => profileAvailable(sim, p));
    if (first) av.selectedProfile = first.id;
  }
}

/** The profile a delivery mode would use: the selected one if it can, else the first that can. */
export function profileFor(sim: Sim, mode: DeliveryMode): WeaponProfile | null {
  const sel = selectedProfile(sim);
  if (sel && profileSupports(sel, mode) && profileAvailable(sim, sel)) return sel;
  for (const p of sim.avionics.profiles)
    if (profileSupports(p, mode) && profileAvailable(sim, p)) return p;
  return null;
}

export function modeAvailable(sim: Sim, mode: MasterMode): boolean {
  switch (mode) {
    case 'NAV':
    case 'GUNS':
      return true;
    case 'CCIP':
      return profileFor(sim, 'CCIP') !== null || gunAvailable(sim);
    case 'CCRP':
      return sim.avionics.spi.valid && profileFor(sim, 'CCRP') !== null;
  }
}

const MODE_ORDER: readonly MasterMode[] = ['NAV', 'GUNS', 'CCIP', 'CCRP'];

/** The next available master mode after the present one (the master-mode button). */
export function nextMasterMode(sim: Sim): MasterMode {
  return stepMasterMode(sim, 1);
}

/** The available master mode before the present one (a selector turned back). */
export function previousMasterMode(sim: Sim): MasterMode {
  return stepMasterMode(sim, -1);
}

function stepMasterMode(sim: Sim, dir: 1 | -1): MasterMode {
  const n = MODE_ORDER.length;
  const cur = MODE_ORDER.indexOf(sim.avionics.masterMode);
  for (let k = 1; k <= n; k++) {
    const m = MODE_ORDER[(((cur + dir * k) % n) + n) % n];
    if (modeAvailable(sim, m)) return m;
  }
  return 'NAV';
}

/**
 * Enter a master mode (assumed available). CCIP and CCRP select a profile that supports the
 * delivery if the selected one does not, and set that profile's delivery to the mode.
 */
export function enterMasterMode(sim: Sim, mode: MasterMode): void {
  const av = sim.avionics;
  if (mode === 'CCIP' || mode === 'CCRP') {
    const p = profileFor(sim, mode);
    if (p && p.id !== av.selectedProfile) {
      av.selectedProfile = p.id;
      switched(sim, 'profile', p.name ?? p.id);
    }
    if (p) p.mode = mode;
  }
  if (av.masterMode !== mode) {
    av.masterMode = mode;
    switched(sim, 'masterMode', mode);
  }
}

/**
 * Step to the next (dir +1) or previous (-1) profile whose store is loaded. In CCIP / CCRP the
 * master mode follows the new profile's delivery. Returns false when there is nothing to select.
 */
export function cycleProfile(sim: Sim, dir: 1 | -1): boolean {
  const av = sim.avionics;
  const list = av.profiles;
  const n = list.length;
  if (n === 0) return false;
  let cur = -1;
  for (let i = 0; i < n; i++) if (list[i].id === av.selectedProfile) cur = i;
  for (let k = 1; k <= n; k++) {
    const i = (((cur + dir * k) % n) + n) % n;
    const p = list[i];
    if (!profileAvailable(sim, p)) continue;
    if (p.id === av.selectedProfile) return false;
    av.selectedProfile = p.id;
    switched(sim, 'profile', p.name ?? p.id);
    followProfile(sim, p);
    return true;
  }
  return false;
}

/**
 * In CCIP / CCRP the master mode follows the selected profile's delivery (`p.mode`) when that
 * mode is available, and otherwise changes only when the profile cannot do the present mode.
 */
function followProfile(sim: Sim, p: WeaponProfile): void {
  const av = sim.avionics;
  const mode = av.masterMode;
  if (mode !== 'CCIP' && mode !== 'CCRP') return;
  const want = p.mode === 'CCIP' || p.mode === 'CCRP' ? p.mode : null;
  if (want && want !== mode && profileSupports(p, want) && modeAvailable(sim, want)) {
    av.masterMode = want;
    switched(sim, 'masterMode', want);
    return;
  }
  if (profileSupports(p, mode)) return;
  for (const m of profileModes(p)) {
    if (modeAvailable(sim, m)) {
      av.masterMode = m;
      switched(sim, 'masterMode', m);
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Profile settings (the DSMS profile buttons, mfd.ts)
// ---------------------------------------------------------------------------------------------

/** The value after `value` in an ascending list (wrapping); the first one above it if absent. */
export function nextValue(list: readonly number[], value: number): number {
  const n = list.length;
  for (let i = 0; i < n; i++) {
    if (Math.abs(list[i] - value) <= 1e-6 * Math.max(1, Math.abs(value))) return list[(i + 1) % n];
  }
  for (let i = 0; i < n; i++) if (list[i] > value) return list[i];
  return list[0];
}

const RELEASE_CYCLE: readonly ReleaseMode[] = ['SGL', 'PRS', 'RIP_SGL', 'RIP_PRS'];
const FUZE_CYCLE: readonly FuzeOption[] = ['NOSE', 'TAIL', 'N/T'];

/** The text of a release mode on the displays. */
export function releaseLabel(r: ReleaseMode): string {
  return r === 'RIP_SGL' ? 'RIP SGL' : r === 'RIP_PRS' ? 'RIP PRS' : r;
}

/**
 * Set a profile's delivery mode (if its store supports it). For the selected profile in CCIP or
 * CCRP the master mode follows (when the new mode is available). Returns false when refused.
 */
export function setProfileMode(sim: Sim, p: WeaponProfile, mode: DeliveryMode): boolean {
  if (!profileSupports(p, mode)) return false;
  p.mode = mode;
  const av = sim.avionics;
  if (
    p.id === av.selectedProfile &&
    (av.masterMode === 'CCIP' || av.masterMode === 'CCRP') &&
    av.masterMode !== mode
  ) {
    if (modeAvailable(sim, mode)) {
      av.masterMode = mode;
      switched(sim, 'masterMode', mode);
    } else notify(sim, `${mode} NOT AVAILABLE`, 'info');
  }
  return true;
}

/** Step the profile's delivery mode through the ones its store supports. */
export function cycleProfileMode(sim: Sim, p: WeaponProfile): boolean {
  const modes = profileModes(p);
  if (modes.length < 2) return false;
  const i = p.mode === 'NONE' ? -1 : modes.indexOf(p.mode);
  return setProfileMode(sim, p, modes[(i + 1) % modes.length]);
}

export function cycleReleaseMode(p: WeaponProfile): void {
  p.release = RELEASE_CYCLE[(RELEASE_CYCLE.indexOf(p.release) + 1) % RELEASE_CYCLE.length];
}

export function cycleRippleQty(p: WeaponProfile): void {
  p.rippleQty = nextValue(PROFILE_EDIT.rippleQty, p.rippleQty);
}

export function cycleRippleSpacing(p: WeaponProfile): void {
  p.rippleSpacing = nextValue(PROFILE_EDIT.rippleSpacing, p.rippleSpacing);
}

export function cycleFuze(p: WeaponProfile): void {
  p.fuze = FUZE_CYCLE[(FUZE_CYCLE.indexOf(p.fuze) + 1) % FUZE_CYCLE.length];
}

export function cycleArmingTime(p: WeaponProfile): void {
  p.armingTime = nextValue(PROFILE_EDIT.armingTime, p.armingTime);
}

export function cycleMinAltitude(p: WeaponProfile): void {
  p.minAltitude = nextValue(PROFILE_EDIT.minAltitude, p.minAltitude);
}

/** The store can be released high drag (a ballute): HIGH_DRAG_STORES. */
export function highDragCapable(store: string): boolean {
  return HIGH_DRAG_STORES.includes(store);
}

/** Low ↔ high drag; refused (message) for a store without a high-drag configuration. */
export function toggleDrag(sim: Sim, p: WeaponProfile): boolean {
  if (!highDragCapable(p.store)) {
    if ((p.drag ?? 'LD') !== 'LD') p.drag = 'LD';
    notify(sim, `${p.name ?? p.id}: NO HIGH DRAG`, 'info');
    return false;
  }
  p.drag = (p.drag ?? 'LD') === 'LD' ? 'HD' : 'LD';
  return true;
}

/** The store has a laser seeker (its profile carries a laser code). */
export function laserGuided(store: string): boolean {
  return STORES[store as StoreType]?.kind === 'guidedBomb';
}

/**
 * Laser code with one digit stepped (digit 0 = thousands … 3 = units), wrapping within the
 * allowed digits (PROFILE_EDIT: first 1–2, the others 1–8). Digits outside the range snap in.
 */
export function stepLaserDigit(code: number, digit: number): number {
  const d = [
    Math.floor(code / 1000) % 10,
    Math.floor(code / 100) % 10,
    Math.floor(code / 10) % 10,
    code % 10,
  ];
  const k = Math.min(3, Math.max(0, Math.round(digit)));
  const lo = PROFILE_EDIT.laserDigitMin[k];
  const hi = PROFILE_EDIT.laserDigitMax[k];
  d[k] = d[k] + 1 > hi || d[k] + 1 < lo ? lo : d[k] + 1;
  for (let i = 0; i < 4; i++) {
    const a = PROFILE_EDIT.laserDigitMin[i];
    const b = PROFILE_EDIT.laserDigitMax[i];
    if (d[i] < a) d[i] = a;
    else if (d[i] > b) d[i] = b;
  }
  return d[0] * 1000 + d[1] * 100 + d[2] * 10 + d[3];
}

/** A laser-guided profile's code (default RELEASE.laserCode); 0 for other stores. */
export function profileLaserCode(p: WeaponProfile): number {
  return laserGuided(p.store) ? (p.laserCode ?? RELEASE.laserCode) : 0;
}

/** The weapon sight the HUD draws, and the "CCIP INVALID" flag. Run after the solutions. */
export function updateSight(sim: Sim): void {
  const av = sim.avionics;
  const p = selectedProfile(sim);
  switch (av.masterMode) {
    case 'GUNS':
      av.sight = 'GUN';
      break;
    case 'CCIP':
      av.sight = p && profileSupports(p, 'CCIP') && profileAvailable(sim, p) ? 'CCIP' : 'GUN';
      break;
    case 'CCRP':
      av.sight = p && profileSupports(p, 'CCRP') && profileAvailable(sim, p) ? 'CCRP' : 'NONE';
      break;
    default:
      av.sight = 'NONE';
  }
}

// ---------------------------------------------------------------------------------------------
// Stores page (DSMS)
// ---------------------------------------------------------------------------------------------

export function createDsmsView(): DsmsView {
  return {
    stations: [],
    profiles: [],
    gunRounds: 0,
    gunLoaded: 0,
    gunLoad: 'combatMix',
    masterArm: 'SAFE',
    selectedProfile: '',
    selectedStation: 0,
    jettisonStation: 0,
    codeDigit: 0,
  };
}

/** What hangs on a station can be dropped by selective jettison (pods and AIM-9 rails stay). */
export function stationJettisonable(sim: Sim, station: number): boolean {
  const st = sim.stores.stations[station - 1];
  if (!st || st.station !== station) return false;
  const first = st.rack ?? st.stores[0];
  if (!first || !STORES[first]?.jettisonable) return false;
  for (const s of st.stores) if (!STORES[s]?.jettisonable) return false;
  return true;
}

/**
 * Fill the data the stores page shows: the eleven stations, the profiles with the stores left,
 * the gun, the selected and jettison stations. Reuses `out`'s objects (call it at display rate;
 * it allocates only when lists grow).
 */
export function buildDsmsView(sim: Sim, out: DsmsView = createDsmsView()): DsmsView {
  const av = sim.avionics;
  const sel = selectedProfile(sim);
  const stations = sim.stores.stations;
  out.stations.length = stations.length;
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const v: DsmsStationView = out.stations[i] ?? {
      station: 0,
      rack: null,
      store: null,
      count: 0,
      selected: false,
      rockets: -1,
      next: false,
      jettisonable: false,
      jettisonSelected: false,
    };
    v.station = st.station;
    v.rack = st.rack;
    v.store = st.stores.length > 0 ? st.stores[0] : null;
    v.count = st.stores.length;
    v.selected = sel !== null && st.stores.includes(sel.store as (typeof st.stores)[number]);
    const first = st.stores.length > 0 ? st.stores[0] : null;
    v.rockets = first !== null && STORES[first]?.kind === 'rocketPod' ? onStation(st, first) : -1;
    v.next = st.station === av.selectedStation;
    v.jettisonable = stationJettisonable(sim, st.station);
    v.jettisonSelected = st.station === av.pages.jettisonStation;
    out.stations[i] = v;
  }
  out.profiles.length = av.profiles.length;
  for (let i = 0; i < av.profiles.length; i++) {
    const p = av.profiles[i];
    const v: DsmsProfileView = out.profiles[i] ?? {
      id: '',
      name: '',
      store: '',
      mode: 'CCIP',
      release: 'SGL',
      rippleQty: 1,
      rippleSpacing: 0,
      fuze: 'NOSE',
      minAltitude: 0,
      armingTime: 0,
      remaining: 0,
      selected: false,
      drag: 'LD',
      laserCode: 0,
      modes: [],
    };
    v.id = p.id;
    v.name = p.name ?? p.id;
    v.store = p.store;
    v.mode = p.mode;
    v.release = p.release;
    v.rippleQty = p.rippleQty;
    v.rippleSpacing = p.rippleSpacing;
    v.fuze = p.fuze;
    v.minAltitude = p.minAltitude;
    v.armingTime = p.armingTime;
    v.remaining = storeRemaining(sim, p.store);
    v.selected = p.id === av.selectedProfile;
    v.drag = p.drag ?? 'LD';
    v.laserCode = profileLaserCode(p);
    v.modes = profileModes(p);
    out.profiles[i] = v;
  }
  out.gunRounds = sim.gun.rounds;
  out.gunLoaded = sim.gun.roundsLoaded;
  out.gunLoad = sim.gun.load;
  out.masterArm = av.masterArm;
  out.selectedProfile = sel ? (sel.name ?? sel.id) : '';
  out.selectedStation = av.selectedStation;
  out.jettisonStation = av.pages.jettisonStation;
  out.codeDigit = av.pages.dsmsCodeDigit;
  return out;
}
