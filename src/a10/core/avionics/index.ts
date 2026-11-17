/**
 * AVIONICS module public API (docs/a10/ARCHITECTURE.md §4, §12): armament switches, master modes,
 * sensor of interest and SPI, HOTAS routing, weapon profiles, the display pages, the fire-control
 * computer and every release decision.
 *
 *  registry.ts   the stores' ballistic models (registerStoreBallistics) — imported FIRST
 *  commands.ts   applyCommands: every Command; flight and weapons setters
 *  hotas.ts      TMS / DMS / China hat / coolie routed by the sensor of interest
 *  mfd.ts        display pages, SOI-capable pages, the OSB tables (labels, values, actions)
 *  profiles.ts   weapon profiles and their settings, master-mode availability, the HUD's sight,
 *                the DSMS data
 *  stations.ts   which station a release leaves from (balance; pairs)
 *  navigation.ts steerpoints and the SPI
 *  ground.ts     the computer's ground model (altitude-source switch: DELTA, RADAR, BARO)
 *  predict.ts    the ballistic predictor shared by the gun and the stores
 *  gunsight.ts   the CCIP gun sight
 *  release.ts    store CCIP (delay cue), CCRP and consent solutions
 *  delivery.ts   the pickle: consent, CCRP, pairs and ripples, rockets, Maverick launch, TRAIN
 *  data/avionics.ts  fire-control and release constants, profile defaults, with sources
 */
// The registry has no runtime imports and must load before anything that pulls in the weapons
// module (which registers its store models at load time): see registry.ts.
import { registerStoreBallistics, storeBallistics, type StoreBallistics } from './registry';
import type { Sim } from '../types';
import { stepDelivery, updateSelectedStation } from './delivery';
import { createFireControlGround, updateFireControlGround } from './ground';
import { computeGunSolution } from './gunsight';
import { initAvionics } from './init';
import { updateSpi } from './navigation';
import { updateSight } from './profiles';
import { computeReleaseSolution } from './release';

export { registerStoreBallistics, storeBallistics, type StoreBallistics };
export type * from './types';
export { applyCommands, applyCommand, rearm, jettison } from './commands';
export { createAvionicsState, initAvionics, refreshStores } from './init';
export {
  FIRE_CONTROL,
  FIRE_CONTROL_NOTES,
  HIGH_DRAG_STORES,
  PROFILE_DEFAULTS,
  PROFILE_DEFAULTS_NOTES,
  PROFILE_EDIT,
  PROFILE_EDIT_NOTES,
  RELEASE,
  RELEASE_NOTES,
  TAD_RANGES_NM,
} from '../../data/avionics';
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
  computeReleaseSolution,
  createReleaseSolution,
  createReleaseTimeSolution,
  fireControlTime,
  flyStore,
  groundRay,
  modelFor,
  modelKey,
  predictReleaseAt,
  predictStoreImpact,
  releaseState,
  releaseStateAt,
  solveReleaseTime,
  type ReleaseTimeSolution,
} from './release';
export {
  cancelDelivery,
  createDeliveryState,
  isMaverick,
  maverickLaunchRefusal,
  selectedSeeker,
  stepDelivery,
  updateSelectedStation,
} from './delivery';
export {
  availableOn,
  isRocketPod,
  nextStation,
  onStation,
  pulseStations,
  releasedMass,
  stationSide,
  storeRemaining,
} from './stations';
export {
  buildDsmsView,
  createDsmsView,
  cycleArmingTime,
  cycleFuze,
  cycleMinAltitude,
  cycleProfile,
  cycleProfileMode,
  cycleReleaseMode,
  cycleRippleQty,
  cycleRippleSpacing,
  highDragCapable,
  laserGuided,
  modeAvailable,
  nextMasterMode,
  nextValue,
  previousMasterMode,
  profileLaserCode,
  profileModes,
  releaseLabel,
  setProfileMode,
  stationJettisonable,
  stepLaserDigit,
  storeCount,
  toggleDrag,
} from './profiles';
export { activeSteerpoint, cycleSteerpoint, spiToSteerpoint } from './navigation';
export {
  OSB_TABLE,
  PAGE_CYCLE,
  PAGE_SELECT_OSB,
  SOI_PAGES,
  cycleJettisonStation,
  intText,
  jettisonSelected,
  osbActive,
  osbBinding,
  osbLabel,
  osbValue,
  pressOsb,
  setMfdPage,
  stationText,
  tenthText,
  type Display,
  type OsbBinding,
} from './mfd';
export { GUN_SIGHTS, HOTAS_TABLE, makeSpi, soiTarget } from './hotas';

const _ground = createFireControlGround();

/**
 * Fire control, every step after the sensors (step 9), from the new aircraft state (its time is
 * sim.time + dt: the clock advances after the step): the SPI follows its source, the HUD's sight
 * and the selected station are chosen, the gun and store solutions are computed against the
 * altitude source's ground model, and the pickle's release decisions push their requests.
 */
export function stepFireControl(sim: Sim, dt: number): void {
  const av = sim.avionics;
  if (!av.initialized) initAvionics(sim);
  updateSpi(sim);
  updateSight(sim);
  updateSelectedStation(sim);
  updateFireControlGround(sim, av.altSource, _ground);
  computeGunSolution(sim, _ground);
  computeReleaseSolution(sim, _ground, dt);
  stepDelivery(sim, _ground, dt);
  av.ccipInvalid =
    av.masterMode === 'CCIP' && (av.sight === 'GUN' ? !av.gun.valid : !av.release.valid);
}
