/**
 * SENSORS module public API (ARCHITECTURE §12.5; PLAN_A10.md §6.4, §6.6, §7, §8, §10): the
 * AN/AAQ-28 Litening targeting pod with its laser designator and ranger, the AGM-65 Maverick
 * seekers before launch, and the contrast model the seekers and the sensor pictures share.
 *
 *   createSensorsState()              the state at the air start (pod on and cool, seekers aligned)
 *   stepSensors(sim, dt)              step 8: requests, slew, tracks, locks, laser (after the
 *                                     vehicles moved, before fire control reads the SPI source)
 *   targetContrast(sim, id, band, from)  0..1 contrast of a vehicle in 'IR' or 'TV'
 *
 * Inputs (all public state): avionics `sensorRequests` (HOTAS and OSB actions of this step),
 * `slaveRequest`, `tgpPower`, `laserArm`, `soi` and `mfd` (the TGP or MAV page as the sensor of
 * interest takes the slew), `spi`, and the cockpit switch states the avionics keeps for the pages
 * (`laserLatch`, `laserCode`, `mavPower`, `selectedStation`; see tgp.ts `cockpitSwitches`);
 * `input.slewX/Y`, `input.laser`; the stores on the stations; the vehicles; the terrain (line of
 * sight with trees, raycast), the time of day and the visibility. Outputs: `sim.sensors` and the
 * events `laser {on}` and `lock {sensor: 'TGP' | 'MAV', on}`. Deterministic: no random draws.
 * Module files: tgp.ts (pod and laser), maverick.ts (seekers), track.ts (what a tracker can hold),
 * contrast.ts (the shared contrast model), geometry.ts, mask.ts (the airframe mask).
 */
import { Vector3 } from 'three';
import { LASER, TGP } from '../../data/sensors';
import type { Sim } from '../types';
import { syncLoads } from './loads';
import { stepMavericks, slaveMaverickToSpi } from './maverick';
import { MASK_CAPACITY } from './mask';
import { slaveTgpToSpi, stepTgp } from './tgp';
import type { SensorsState } from './types';

export type * from './types';
export {
  createContrastDetail,
  createSunState,
  createZoneHeat,
  groundLevelAt,
  groundThermalLevel,
  hazeDensity,
  hazeFactor,
  irApparentK,
  irContrast,
  kelvinToLevel,
  levelToKelvin,
  simSun,
  smokeBetween,
  sunStateAt,
  targetContrast,
  thermalSignatureK,
  tvApparentContrast,
  tvContrast,
  vehicleContrast,
  vehicleLuminance,
  vehicleZoneHeat,
  type ContrastDetail,
  type SunState,
  type ZoneHeat,
} from './contrast';
export {
  angularSize,
  podHeadBody,
  projectedArea,
  seekerHeadBody,
  stationPoint,
  storeAxisBody,
  vehicleCentre,
  vehicleCentreHeight,
} from './geometry';
export { airframeMasked } from './mask';
export {
  isMaverickType,
  maverickBreak,
  maverickLock,
  setMaverickFov,
  setMaverickPower,
  slaveMaverickToSpi,
  toggleMaverickPicture,
} from './maverick';
export {
  cockpitSwitches,
  podStation,
  setTgpFov,
  setTgpPicture,
  setTgpTrack,
  slaveTgpToSpi,
  stepTgpZoom,
  tgpFov,
  validLaserCode,
  type CockpitSwitches,
} from './tgp';

export function createSensorsState(): SensorsState {
  return {
    tgp: {
      powered: true,
      warmup: 0,
      los: new Vector3(0, -1, 0),
      point: new Vector3(),
      pointValid: false,
      mode: 'INR',
      trackedVehicle: -1,
      picture: 'WHOT',
      fov: TGP.fovWide,
      fovSetting: 'WIDE',
      zoom: 1,
      masked: false,
      lasing: false,
      laserCode: LASER.defaultCode,
      laserRange: 0,
      gimbalAz: 0,
      gimbalEl: -Math.PI / 2,
      latched: false,
      spot: new Vector3(),
      spotValid: false,
      station: 0,
      ready: true,
      head: new Vector3(),
      maskReason: 'NONE',
      pointRange: 0,
      coasting: false,
      slewing: false,
      laserRangeTime: -1,
      spotVehicle: -1,
      internal: {
        aim: new Vector3(),
        aimValid: false,
        aimDir: new Vector3(0, -1, 0),
        lastSeen: new Vector3(),
        lastVelocity: new Vector3(),
        coastLeft: 0,
        coastToInr: false,
        slewHeld: 0,
        pulseCountdown: 0,
        checkCountdown: 0,
        wasReady: false,
      },
    },
    mavericks: [],
    selectedMaverick: -1,
    mavPower: true,
    initialized: false,
    internal: {
      nextSeekerId: 1,
      stationKeys: new Int32Array(12),
      maskStation: -1,
      maskDirty: true,
      maskLoads: new Int32Array(12),
      loadInitial: new Int32Array(12),
      loadCount: new Int32Array(12),
      loadCode: new Int32Array(12),
      maskBoxes: new Float64Array(MASK_CAPACITY * 6),
      maskCount: 0,
      lastSelectedStation: 0,
      lastSelectedType: null,
      slaveHandled: -1,
      byStation: Array.from({ length: 12 }, () => []),
    },
  };
}

/**
 * The avionics' last "slave to SPI" (China hat long), acted on once even when its sensor request
 * was not seen (a command applied outside the step clears the list before step 8 reads it).
 */
function slaveFallback(sim: Sim): void {
  const internal = sim.sensors.internal;
  const sr = sim.avionics.slaveRequest;
  if (!(sr.time > internal.slaveHandled)) return;
  internal.slaveHandled = sr.time;
  const reqs = sim.avionics.sensorRequests;
  for (let i = 0; i < reqs.length; i++) if (reqs[i].action === 'slaveSpi') return;
  if (sim.sensors.tgp.ready) slaveTgpToSpi(sim);
  if (sr.sensors === 'ALL') slaveMaverickToSpi(sim);
}

/** Step 8: the targeting pod, its laser and the Maverick seekers. */
export function stepSensors(sim: Sim, dt: number): void {
  syncLoads(sim);
  slaveFallback(sim);
  stepTgp(sim, dt);
  stepMavericks(sim, dt);
  sim.sensors.initialized = true;
}
