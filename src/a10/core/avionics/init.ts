/**
 * Avionics state: construction and the start-of-flight set-up (steerpoints, SPI, profiles).
 */
import { Vector3 } from 'three';
import type { Sim } from '../types';
import { createGunSolution } from './gunsight';
import { buildSteerpoints, spiToSteerpoint } from './navigation';
import { buildProfiles } from './profiles';
import { createReleaseSolution } from './release';
import type { AvionicsState } from './types';

/**
 * The avionics at the air start (PLAN_A10.md §5): Master Arm SAFE, GUN/PAC SAFE, laser SAFE, pod
 * on, altitude source DELTA (the terrain database, the plan's default), NAV, HUD as SOI.
 */
export function createAvionicsState(): AvionicsState {
  return {
    masterArm: 'SAFE',
    gunPac: 'SAFE',
    laserArm: 'SAFE',
    tgpPower: true,
    altSource: 'DELTA',
    masterMode: 'NAV',
    soi: 'HUD',
    selectedProfile: '',
    profiles: [],
    gun: createGunSolution(),
    release: createReleaseSolution(),
    spi: { valid: false, position: new Vector3(), source: 'STPT' },
    steerpoints: [],
    activeSteerpoint: 0,
    mfd: { left: 'TAD', right: 'DSMS' },
    lastSwitch: { name: '', time: -1 },
    ccipInvalid: false,
    sight: 'NONE',
    gunSight: 'CCIP',
    lastSwitchValue: '',
    sensorRequests: [],
    slaveRequest: { sensors: 'ALL', time: -1 },
    initialized: false,
    fc: { prevTimeOfFlight: 0, steps: 0, groundTests: 0 },
  };
}

/**
 * Start-of-flight set-up from the terrain and the loadout: steerpoints (unless already set),
 * the SPI on the active steerpoint, and a profile for every weapon store. Idempotent; runs by
 * itself at the first step, and createSim may call it so the steerpoints exist before stepping.
 */
export function initAvionics(sim: Sim): void {
  const av = sim.avionics;
  buildSteerpoints(sim);
  if (av.spi.source === 'STPT') spiToSteerpoint(sim);
  buildProfiles(sim);
  av.initialized = true;
}

/** After a rearm or jettison: profiles for new stores, a valid selection. */
export function refreshStores(sim: Sim): void {
  buildProfiles(sim);
}
