/**
 * AVIONICS module public API: switches, master modes, commands and fire control.
 * FOUNDATION STAND-IN: basic switch handling and a gun solution from the shared ballistics. The
 * avionics module owner replaces the implementation and keeps these exports and their meaning.
 */
import { Vector3 } from 'three';
import { A10_GEOMETRY } from '../../data/geometry';
import { GAU8 } from '../../data/gun';
import { bodyToWorld, hudAnglesFromBodyDir, worldToBody } from '../frames';
import type { Command, Sim } from '../types';
import { predictRoundImpact, RoundType, type RoundPrediction } from '../weapons';
import { windAt } from '../world';
import type { AvionicsState, GunPacSwitch, MasterArm, MasterMode } from './types';

export type * from './types';

export function createAvionicsState(): AvionicsState {
  return {
    masterArm: 'SAFE',
    gunPac: 'ARM',
    laserArm: 'SAFE',
    tgpPower: true,
    altSource: 'DELTA',
    masterMode: 'NAV',
    soi: 'HUD',
    selectedProfile: '',
    profiles: [],
    gun: {
      valid: false,
      impact: new Vector3(),
      pipperAz: 0,
      pipperEl: 0,
      slantRange: 0,
      timeOfFlight: 0,
      tooClose: false,
      tooFar: false,
    },
    release: {
      valid: false,
      impact: new Vector3(),
      az: 0,
      el: 0,
      timeToRelease: 0,
      timeOfFall: 0,
      belowMinimum: false,
      belowGlass: false,
      releaseNow: false,
    },
    spi: { valid: false, position: new Vector3(), source: 'STPT' },
    steerpoints: [],
    activeSteerpoint: 0,
    mfd: { left: 'TAD', right: 'DSMS' },
    lastSwitch: { name: '', time: -1 },
    ccipInvalid: false,
  };
}

const MASTER_ARM: MasterArm[] = ['SAFE', 'TRAIN', 'ARM'];
const GUN_PAC: GunPacSwitch[] = ['SAFE', 'GUNARM', 'ARM'];
const MODES: MasterMode[] = ['NAV', 'GUNS', 'CCIP', 'CCRP'];

function cycle<T>(list: readonly T[], current: T): T {
  return list[(list.indexOf(current) + 1) % list.length];
}

/** Apply the queued commands (switches, modes, HOTAS) at the start of a step. */
export function applyCommands(sim: Sim): void {
  const av = sim.avionics;
  for (const c of sim.commands) applyCommand(sim, av, c);
  sim.commands.length = 0;
}

function applyCommand(sim: Sim, av: AvionicsState, c: Command): void {
  switch (c.type) {
    case 'masterArm':
      av.masterArm = c.value === 'cycle' ? cycle(MASTER_ARM, av.masterArm) : c.value;
      switched(sim, 'masterArm', av.masterArm);
      break;
    case 'gunPac':
      av.gunPac = c.value === 'cycle' ? cycle(GUN_PAC, av.gunPac) : c.value;
      switched(sim, 'gunPac', av.gunPac);
      break;
    case 'masterMode':
      av.masterMode = c.value === 'next' ? cycle(MODES, av.masterMode) : c.value;
      switched(sim, 'masterMode', av.masterMode);
      break;
    case 'flaps': {
      const ac = sim.aircraft;
      const v =
        c.value === 'up'
          ? Math.max(0, ac.flapHandle - 1)
          : c.value === 'down'
            ? Math.min(2, ac.flapHandle + 1)
            : c.value;
      ac.flapHandle = v as 0 | 1 | 2;
      switched(sim, 'flaps', `${v}`);
      break;
    }
    default:
      break;
  }
}

function switched(sim: Sim, name: string, value: string): void {
  sim.avionics.lastSwitch = { name, time: sim.time };
  sim.events.push({ type: 'switch', t: sim.time, name, value });
}

const _muzzle = new Vector3();
const _dir = new Vector3();
const _vel = new Vector3();
const _wind = new Vector3();
const _rel = new Vector3();
const _pred: RoundPrediction = { point: new Vector3(), velocity: new Vector3(), time: 0 };
const _angles = { az: 0, el: 0 };

/** Fire control: gun, CCIP and CCRP solutions every step. Stand-in: the gun solution only. */
export function stepFireControl(sim: Sim, _dt: number): void {
  const ac = sim.aircraft;
  const g = sim.avionics.gun;
  const m = A10_GEOMETRY.muzzle;
  bodyToWorld(ac.orientation, _muzzle.set(m.x, m.y, m.z), _muzzle).add(ac.position);
  _dir.set(0, -Math.sin(GAU8.gunLineDepression), -Math.cos(GAU8.gunLineDepression));
  bodyToWorld(ac.orientation, _dir, _dir);
  _vel.copy(_dir).multiplyScalar(GAU8.muzzleVelocity).add(ac.velocity);
  windAt(sim.world, ac.position, _wind);
  g.valid = predictRoundImpact(
    RoundType.API,
    _muzzle,
    _vel,
    sim.world.terrain,
    _wind,
    4,
    _pred,
    1 / 60,
  );
  if (!g.valid) return;
  g.impact.copy(_pred.point);
  g.timeOfFlight = _pred.time;
  // Pipper direction from the eye (collimated: direction only).
  _rel.subVectors(_pred.point, ac.position);
  g.slantRange = _rel.length();
  worldToBody(ac.orientation, _rel, _rel);
  hudAnglesFromBodyDir(_rel, _angles);
  g.pipperAz = _angles.az;
  g.pipperEl = _angles.el;
  g.tooClose = g.slantRange < 600;
  g.tooFar = g.slantRange > 4000;
}
