/**
 * Avionics state: construction and the start-of-flight set-up (steerpoints, SPI, profiles).
 */
import { Vector3 } from 'three';
import { RELEASE, TAD_RANGES_NM } from '../../data/avionics';
import type { Sim } from '../types';
import { cancelDelivery, createDeliveryState, updateSelectedStation } from './delivery';
import { createGunSolution } from './gunsight';
import { buildSteerpoints, spiToSteerpoint } from './navigation';
import { buildProfiles } from './profiles';
import { createReleaseSolution } from './release';
import type { AvionicsState } from './types';

/**
 * The avionics at the air start (PLAN_A10.md §5): Master Arm SAFE, GUN/PAC SAFE, laser SAFE, pod
 * on, altitude source DELTA (the terrain database, the plan's default), NAV, HUD as SOI, the
 * Mavericks powered and aligned, the laser code 1688.
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
    fc: {
      prevTimeOfFlight: 0,
      steps: 0,
      groundTests: 0,
      storePredictions: 0,
      solveTau: 0,
      solveSlope: 0,
      solveValid: false,
      solveTarget: new Vector3(),
      loftGain: 0,
      loftAge: 0,
    },
    selectedStation: 0,
    laserLatch: false,
    laserCode: RELEASE.laserCode,
    mavPower: true,
    pages: {
      tadRange: TAD_RANGES_NM[2],
      tadCenter: 'OWN',
      jettisonStation: 0,
      dsmsCodeDigit: 0,
      tgpCodeDigit: 0,
      msgClearTime: -1,
    },
    delivery: createDeliveryState(),
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
  updateSelectedStation(sim);
  av.initialized = true;
}

/**
 * After a rearm or jettison: profiles for new stores, a valid selection; a release in progress
 * ends (its stations changed under it).
 */
export function refreshStores(sim: Sim): void {
  buildProfiles(sim);
  cancelDelivery(sim.avionics.delivery);
  updateSelectedStation(sim);
}
