/**
 * Pilot commands (docs/a10/ARCHITECTURE.md §3): applied at the start of each step, before any
 * system reads the switches. Every Command variant is handled with the values the input layer,
 * the cockpit and the UI queue. Commands that belong to another module's state go through that
 * module's setter: flight (flaps, gear, autopilot, altitude alert) and weapons (rearm, jettison).
 */
import * as flight from '../flight';
import {
  autopilotCommand,
  setAltitudeAlert,
  setFlapHandle,
  setGear,
  updateMassProperties,
} from '../flight';
import type { Command, Sim } from '../types';
import { FT } from '../units';
import * as weapons from '../weapons';
import {
  handleChinaHat,
  handleCoolie,
  handleDms,
  handleTms,
  requestSensor,
  sensorOfInterest,
} from './hotas';
import { initAvionics, refreshStores } from './init';
import { pressOsb, selectMfdSoi, setMfdPage } from './mfd';
import { cycleSteerpoint } from './navigation';
import { notify, switched } from './notify';
import {
  cycleProfile,
  enterMasterMode,
  modeAvailable,
  nextMasterMode,
  previousMasterMode,
} from './profiles';
import type { AltSource, GunPacSwitch, LaserArm, MasterArm } from './types';

/**
 * Order a 'cycle' command steps through each three-position switch. GUN/PAC goes to ARM (gun
 * and PAC) first, the usual setting for a strafing pass.
 */
const MASTER_ARM_CYCLE: readonly MasterArm[] = ['SAFE', 'ARM', 'TRAIN'];
const GUN_PAC_CYCLE: readonly GunPacSwitch[] = ['SAFE', 'ARM', 'GUNARM'];
const LASER_ARM_CYCLE: readonly LaserArm[] = ['SAFE', 'ARM', 'TRAIN'];
const ALT_SOURCE_CYCLE: readonly AltSource[] = ['DELTA', 'RADAR', 'BARO'];
const FLAP_NAMES = ['UP', 'MVR', 'DN'] as const;

function cycle<T>(list: readonly T[], current: T): T {
  return list[(list.indexOf(current) + 1) % list.length];
}

/** Apply the queued commands (switches, modes, HOTAS) at the start of a step. */
export function applyCommands(sim: Sim): void {
  const av = sim.avionics;
  av.sensorRequests.length = 0;
  if (!av.initialized) initAvionics(sim);
  const list = sim.commands;
  for (let i = 0; i < list.length; i++) applyCommand(sim, list[i]);
  list.length = 0;
}

export function applyCommand(sim: Sim, c: Command): void {
  const av = sim.avionics;
  switch (c.type) {
    case 'masterArm': {
      const v = c.value === 'cycle' ? cycle(MASTER_ARM_CYCLE, av.masterArm) : c.value;
      if (v !== av.masterArm) {
        av.masterArm = v;
        switched(sim, 'masterArm', v);
      }
      break;
    }
    case 'gunPac': {
      const v = c.value === 'cycle' ? cycle(GUN_PAC_CYCLE, av.gunPac) : c.value;
      if (v !== av.gunPac) {
        av.gunPac = v;
        switched(sim, 'gunPac', v);
      }
      break;
    }
    case 'laserArm': {
      const v = c.value === 'cycle' ? cycle(LASER_ARM_CYCLE, av.laserArm) : c.value;
      if (v !== av.laserArm) {
        av.laserArm = v;
        switched(sim, 'laserArm', v);
      }
      break;
    }
    case 'tgpPower': {
      const v = c.value === 'toggle' ? !av.tgpPower : c.value;
      if (v !== av.tgpPower) {
        av.tgpPower = v;
        switched(sim, 'tgpPower', v ? 'ON' : 'OFF');
      }
      break;
    }
    case 'altSource': {
      const v = c.value === 'cycle' ? cycle(ALT_SOURCE_CYCLE, av.altSource) : c.value;
      if (v !== av.altSource) {
        av.altSource = v;
        switched(sim, 'altSource', v);
      }
      break;
    }
    case 'masterMode': {
      const mode =
        c.value === 'next'
          ? nextMasterMode(sim)
          : c.value === 'previous'
            ? previousMasterMode(sim)
            : c.value;
      if (modeAvailable(sim, mode)) enterMasterMode(sim, mode);
      else notify(sim, `${mode} NOT AVAILABLE`, 'info');
      break;
    }
    case 'profile':
      cycleProfile(sim, c.dir);
      break;
    case 'soi':
      if (c.value === 'HUD') {
        if (av.soi !== 'HUD') {
          av.soi = 'HUD';
          switched(sim, 'soi', 'HUD');
        }
      } else selectMfdSoi(sim, c.value === 'LMFD' ? 'L' : 'R');
      break;
    case 'mfdPage':
      setMfdPage(sim, c.display, c.page);
      break;
    case 'osb':
      pressOsb(sim, c.display, c.button);
      break;
    case 'tms':
      handleTms(sim, c.dir, c.long);
      break;
    case 'dms':
      handleDms(sim, c.dir, c.long);
      break;
    case 'chinaHat':
      handleChinaHat(sim, c.dir, c.long);
      break;
    case 'coolie':
      handleCoolie(sim, c.dir, c.long);
      break;
    case 'sensorPicture':
      requestSensor(sim, sensorOfInterest(av), 'picture', '', false);
      break;
    case 'sensorZoom':
      requestSensor(sim, sensorOfInterest(av), 'zoom', '', false, c.dir);
      break;
    case 'flaps': {
      const h = sim.aircraft.flapHandle;
      const v =
        c.value === 'up' ? Math.max(0, h - 1) : c.value === 'down' ? Math.min(2, h + 1) : c.value;
      const handle = Math.min(2, Math.max(0, Math.round(v))) as 0 | 1 | 2;
      if (handle !== h) {
        setFlapHandle(sim, handle);
        switched(sim, 'flaps', FLAP_NAMES[handle]);
      }
      break;
    }
    case 'gear': {
      const down = c.value === 'toggle' ? !sim.aircraft.gearDown : c.value;
      if (down !== sim.aircraft.gearDown) {
        setGear(sim, down);
        switched(sim, 'gear', down ? 'DOWN' : 'UP');
      }
      break;
    }
    case 'autopilot': {
      autopilotCommand(sim, c.action);
      const ap = sim.aircraft.autopilot;
      switched(sim, 'autopilot', c.action === 'mode' ? ap.mode : ap.engaged ? 'ENGAGED' : 'OFF');
      break;
    }
    case 'altitudeAlert': {
      if (!Number.isFinite(c.value)) break;
      setAltitudeAlert(sim, c.value);
      const m = sim.aircraft.altitudeAlert;
      switched(sim, 'altitudeAlert', m > 0 ? `${Math.round(m / FT)} FT` : 'OFF');
      break;
    }
    case 'jettison':
      jettison(sim, c.stations);
      switched(sim, 'jettison', c.stations === 'all' ? 'ALL' : c.stations.join(','));
      refreshStores(sim);
      break;
    case 'rearm':
      rearm(sim);
      refreshStores(sim);
      break;
    case 'steerpoint':
      cycleSteerpoint(sim, c.dir);
      break;
    default: {
      const unhandled: never = c;
      void unhandled;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Other modules' setters (rearm and jettison change the weapons' and the flight's state).
// ---------------------------------------------------------------------------------------------

/** Reload the gun and restore the loadout (weapons.rearm), and refuel (flight.refuel). */
export function rearm(sim: Sim): void {
  weapons.rearm(sim);
  flight.refuel(sim);
  updateMassProperties(sim);
}

/** Jettison the stores of some stations, or all (weapons.jettisonStores). */
export function jettison(sim: Sim, stations: number[] | 'all'): void {
  weapons.jettisonStores(sim, stations);
  updateMassProperties(sim);
}
