/**
 * AVIONICS module public API (docs/a10/ARCHITECTURE.md §4): armament switches, master modes,
 * sensor of interest and SPI, HOTAS routing, weapon profiles, and the fire-control computer.
 *
 *  commands.ts   applyCommands: every Command; flight and weapons setters
 *  hotas.ts      TMS / DMS / China hat / coolie routed by the sensor of interest
 *  mfd.ts        display pages, SOI-capable pages, OSB tables
 *  profiles.ts   weapon profiles, master-mode availability, the HUD's sight, the DSMS data
 *  navigation.ts steerpoints and the SPI
 *  ground.ts     the computer's ground model (altitude-source switch: DELTA, RADAR, BARO)
 *  predict.ts    the ballistic predictor shared by the gun and the stores
 *  gunsight.ts   the CCIP gun sight
 *  release.ts    store CCIP / CCRP (wave 1: structure, predictStoreImpact)
 *  data.ts       fire-control constants and default profiles, with sources
 */
import type { Sim } from '../types';
import { createFireControlGround, updateFireControlGround } from './ground';
import { computeGunSolution } from './gunsight';
import { initAvionics } from './init';
import { updateSpi } from './navigation';
import { updateSight } from './profiles';
import { computeReleaseSolution } from './release';

export type * from './types';
export { applyCommands, applyCommand, rearm, jettison } from './commands';
export { createAvionicsState, initAvionics } from './init';
export { FIRE_CONTROL, FIRE_CONTROL_NOTES, PROFILE_DEFAULTS, PROFILE_DEFAULTS_NOTES } from './data';
export {
  computeGunSolution,
  eyeWorld,
  gunPredictorStep,
  hudAnglesOfPoint,
  roundModel,
  sightRoundType,
  type RoundModel,
} from './gunsight';
export {
  createFireControlGround,
  groundSegmentHit,
  updateFireControlGround,
  type FireControlGround,
} from './ground';
export {
  calibrateStep,
  createImpactPrediction,
  predictImpact,
  stepError,
  type BallisticModel,
  type CalibrationShot,
  type ImpactPrediction,
} from './predict';
export {
  belowGlass,
  predictStoreImpact,
  registerStoreBallistics,
  storeBallistics,
  type StoreBallistics,
} from './release';
export {
  buildDsmsView,
  createDsmsView,
  cycleProfile,
  modeAvailable,
  nextMasterMode,
  previousMasterMode,
  profileModes,
  storeCount,
} from './profiles';
export { activeSteerpoint, cycleSteerpoint, spiToSteerpoint } from './navigation';
export {
  OSB_TABLE,
  PAGE_CYCLE,
  PAGE_SELECT_OSB,
  SOI_PAGES,
  osbBinding,
  type OsbBinding,
} from './mfd';
export { GUN_SIGHTS, HOTAS_TABLE, makeSpi, soiTarget } from './hotas';

const _ground = createFireControlGround();

/**
 * Fire control, every step after the sensors (step 9): the SPI follows its source, the HUD's
 * sight is chosen, the gun solution and the store solution are computed from the new aircraft
 * state against the altitude source's ground model.
 */
export function stepFireControl(sim: Sim, _dt: number): void {
  const av = sim.avionics;
  if (!av.initialized) initAvionics(sim);
  updateSpi(sim);
  updateSight(sim);
  updateFireControlGround(sim, av.altSource, _ground);
  computeGunSolution(sim, _ground);
  computeReleaseSolution(sim, _ground);
  av.ccipInvalid =
    av.masterMode === 'CCIP' && (av.sight === 'GUN' ? !av.gun.valid : !av.release.valid);
}
