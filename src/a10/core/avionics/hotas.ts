/**
 * HOTAS switches routed by the sensor of interest (PLAN_A10.md §7 "SOI and SPI", §12). The input
 * layer resolves short and long presses (long = held ≥ 0.4 s) before it queues the command.
 *
 * Whatever the SOI (A-10C):
 *   TMS forward long     make the SOI the SPI generator (HUD: the pipper's ground point, else the
 *                        steerpoint; pod: its point; Maverick: its lock point)
 *   TMS aft long         return the SPI to the steerpoint
 *   China hat fwd long   slave all sensors to the SPI (an intent for the sensors module)
 *   China hat aft long   slave the targeting pod to the SPI
 *   Coolie up            HUD as SOI
 *   Coolie left / right  long: that display as SOI (only a sensor page: TAD, TGP, MAV);
 *                        short: that display's next page
 * With the HUD as SOI:
 *   DMS left / right     GUNS: previous / next gun sight; NAV, CCIP, CCRP: previous / next profile
 *   DMS up / down        next / previous steerpoint
 * With the TGP or MAV page as SOI every other press becomes a SensorRequest for the sensors
 * module, which gives them the A-10C meanings: TMS forward short = point track (MAV: lock), aft
 * short = area / INR (MAV: break lock); China hat forward short = the field of view (WIDE ↔
 * NARROW; with the HUD as SOI it goes to the pod); DMS up / down = zoom, left / right = the
 * picture (polarity). The display pages' OSBs push the same requests (mfd.ts), so a button and
 * its HOTAS press do the same thing. The per-SOI tables below are where the TAD cursor and the
 * HUD designation cursor would go.
 */
import type { HatDir, Sim } from '../types';
import { cyclePage, selectMfdSoi, type Display } from './mfd';
import { activeSteerpoint, cycleSteerpoint, setSpi, spiToSteerpoint } from './navigation';
import { switched } from './notify';
import { cycleProfile } from './profiles';
import type { AvionicsState, GunSightMode, SensorRequest, SoiTarget } from './types';

/** What the sensor of interest is: the HUD, or the page on the SOI display. */
export function soiTarget(av: AvionicsState): SoiTarget {
  if (av.soi === 'LMFD') return av.mfd.left;
  if (av.soi === 'RMFD') return av.mfd.right;
  return 'HUD';
}

/** The sensor a picture or zoom press acts on: the SOI's sensor, else the pod. */
export function sensorOfInterest(av: AvionicsState): 'TGP' | 'MAV' {
  return soiTarget(av) === 'MAV' ? 'MAV' : 'TGP';
}

export function requestSensor(
  sim: Sim,
  sensor: SensorRequest['sensor'],
  action: SensorRequest['action'],
  dir: SensorRequest['dir'],
  long: boolean,
  value = 0,
): void {
  sim.avionics.sensorRequests.push({ sensor, action, dir, long, value, t: sim.time });
}

/** The gun sights DMS left/right steps through in GUNS (wave 3 adds the others). */
export const GUN_SIGHTS: readonly GunSightMode[] = ['CCIP'];

function cycleGunSight(sim: Sim, dir: 1 | -1): void {
  const av = sim.avionics;
  const n = GUN_SIGHTS.length;
  const cur = Math.max(0, GUN_SIGHTS.indexOf(av.gunSight));
  const next = GUN_SIGHTS[(((cur + dir) % n) + n) % n];
  if (next !== av.gunSight) {
    av.gunSight = next;
    switched(sim, 'gunSight', next);
  }
}

/**
 * Make the sensor of interest the SPI generator (TMS forward long). Returns false when the SOI
 * has no point to give.
 */
export function makeSpi(sim: Sim): boolean {
  const av = sim.avionics;
  const target = soiTarget(av);
  let ok = false;
  if (target === 'HUD') {
    if (av.sight === 'GUN' && av.gun.valid) {
      setSpi(sim, 'HUD', av.gun.impact);
      ok = true;
    } else if (av.sight === 'CCIP' && av.release.valid) {
      setSpi(sim, 'HUD', av.release.impact);
      ok = true;
    } else if (activeSteerpoint(sim)) {
      spiToSteerpoint(sim);
      ok = true;
    }
  } else if (target === 'TGP') {
    const tgp = sim.sensors.tgp;
    if (tgp.pointValid) {
      setSpi(sim, 'TGP', tgp.point);
      ok = true;
    }
  } else if (target === 'MAV') {
    const i = sim.sensors.selectedMaverick;
    const mav = i >= 0 ? sim.sensors.mavericks[i] : undefined;
    if (mav && mav.locked) {
      setSpi(sim, 'MAV', mav.lockPoint);
      ok = true;
    }
  }
  if (ok) switched(sim, 'spi', av.spi.source);
  return ok;
}

/** Return the SPI to the steerpoint (TMS aft long). */
export function resetSpi(sim: Sim): void {
  spiToSteerpoint(sim);
  switched(sim, 'spi', 'STPT');
}

interface HotasHandlers {
  tms?(sim: Sim, dir: HatDir, long: boolean): boolean;
  dms?(sim: Sim, dir: HatDir, long: boolean): boolean;
  chinaHat?(sim: Sim, dir: 'fwd' | 'aft', long: boolean): boolean;
}

/** Per-SOI handlers for the presses that are not universal. */
export const HOTAS_TABLE: Partial<Record<SoiTarget, HotasHandlers>> = {
  HUD: {
    dms(sim, dir, long) {
      if (long) return false;
      if (dir === 'left' || dir === 'right') {
        const d = dir === 'right' ? 1 : -1;
        if (sim.avionics.masterMode === 'GUNS') cycleGunSight(sim, d);
        else cycleProfile(sim, d);
        return true;
      }
      cycleSteerpoint(sim, dir === 'up' ? 1 : -1);
      return true;
    },
  },
  TAD: {},
};

function isSensorPage(target: SoiTarget): target is 'TGP' | 'MAV' {
  return target === 'TGP' || target === 'MAV';
}

export function handleTms(sim: Sim, dir: HatDir, long: boolean): void {
  if (long && dir === 'up') {
    makeSpi(sim);
    return;
  }
  if (long && dir === 'down') {
    resetSpi(sim);
    return;
  }
  const target = soiTarget(sim.avionics);
  if (HOTAS_TABLE[target]?.tms?.(sim, dir, long)) return;
  if (isSensorPage(target)) requestSensor(sim, target, 'tms', dir, long);
}

export function handleDms(sim: Sim, dir: HatDir, long: boolean): void {
  const target = soiTarget(sim.avionics);
  if (HOTAS_TABLE[target]?.dms?.(sim, dir, long)) return;
  if (isSensorPage(target)) requestSensor(sim, target, 'dms', dir, long);
}

export function handleChinaHat(sim: Sim, dir: 'fwd' | 'aft', long: boolean): void {
  const av = sim.avionics;
  if (long) {
    const sensors = dir === 'fwd' ? 'ALL' : 'TGP';
    av.slaveRequest.sensors = sensors;
    av.slaveRequest.time = sim.time;
    requestSensor(sim, sensors, 'slaveSpi', dir, true);
    switched(sim, 'slave', sensors);
    return;
  }
  const target = soiTarget(av);
  if (HOTAS_TABLE[target]?.chinaHat?.(sim, dir, long)) return;
  // Short presses act on the SOI sensor (field of view and the like), or the pod.
  requestSensor(sim, isSensorPage(target) ? target : 'TGP', 'chinaHat', dir, false);
}

export function handleCoolie(sim: Sim, dir: HatDir, long: boolean): void {
  const av = sim.avionics;
  if (dir === 'up') {
    if (av.soi !== 'HUD') {
      av.soi = 'HUD';
      switched(sim, 'soi', 'HUD');
    }
    return;
  }
  if (dir === 'down') return;
  const display: Display = dir === 'left' ? 'L' : 'R';
  if (long) selectMfdSoi(sim, display);
  else cyclePage(sim, display);
}
