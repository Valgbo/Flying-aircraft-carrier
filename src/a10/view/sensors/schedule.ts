/**
 * When each sensor picture is rendered (PLAN_A10.md §14: "512 × 512 at 30 Hz on High, 256 × 256
 * at 15 Hz on Low; pod and Maverick update on alternate frames"). Pure and allocation-free, so
 * the frame loop and the tests use the very same code.
 *
 * Each sensor has a clock of real seconds since its last picture. A sensor is due when its clock
 * reaches its period (1 / rate) and a display shows it. At most ONE sensor renders per frame: when
 * both are due, the one more overdue (relative to its period) goes first and the other follows
 * on the next frame. The clock keeps the remainder of the period (the average rate stays exact
 * at any frame rate); a sensor more than a whole period late starts afresh instead, so a frame
 * drop never causes a burst of catch-up renders. A sensor nobody shows keeps its clock running,
 * so it renders at once when a display asks for it again.
 */

export type SensorId = 'TGP' | 'MAV';

export interface SensorSchedule {
  /** Real seconds since each sensor's last picture. */
  tgp: number;
  mav: number;
  /** The sensor rendered on the previous frame (null: none). */
  last: SensorId | null;
}

export interface SensorDemand {
  /** A display shows the sensor's page (or a sandbox forces it). */
  tgp: boolean;
  mav: boolean;
}

/** Clocks are capped here, s: a sensor shown again after a long time is due at once. */
const CLOCK_CAP = 10;
/** Tolerance on the period test (floating-point sums of frame times). */
const EPS = 1e-6;

/** Clock after a picture: the remainder of the period, or 0 when it was a period late or more. */
function rest(clock: number, period: number): number {
  const r = clock - period;
  return r >= period - EPS || r < 0 ? 0 : r;
}

export function createSensorSchedule(): SensorSchedule {
  return { tgp: CLOCK_CAP, mav: CLOCK_CAP, last: null };
}

/** Restart both clocks so that both sensors are due at once (new flight, new quality). */
export function resetSensorSchedule(s: SensorSchedule): void {
  s.tgp = CLOCK_CAP;
  s.mav = CLOCK_CAP;
  s.last = null;
}

/**
 * Advance the clocks by `dt` real seconds and choose the sensor to render this frame, or null.
 * `rateTgp` / `rateMav` are picture rates in Hz (≤ 0: never).
 */
export function nextSensorFrame(
  s: SensorSchedule,
  dt: number,
  want: SensorDemand,
  rateTgp: number,
  rateMav: number,
): SensorId | null {
  const step = dt > 0 && Number.isFinite(dt) ? dt : 0;
  s.tgp = Math.min(CLOCK_CAP, s.tgp + step);
  s.mav = Math.min(CLOCK_CAP, s.mav + step);
  const periodT = rateTgp > 0 ? 1 / rateTgp : Infinity;
  const periodM = rateMav > 0 ? 1 / rateMav : Infinity;
  const dueT = want.tgp && s.tgp >= periodT - EPS;
  const dueM = want.mav && s.mav >= periodM - EPS;
  let pick: SensorId | null = null;
  if (dueT && dueM) {
    const lateT = s.tgp / periodT;
    const lateM = s.mav / periodM;
    if (Math.abs(lateT - lateM) < 1e-9) pick = s.last === 'TGP' ? 'MAV' : 'TGP';
    else pick = lateT > lateM ? 'TGP' : 'MAV';
  } else if (dueT) {
    pick = 'TGP';
  } else if (dueM) {
    pick = 'MAV';
  }
  if (pick === 'TGP') s.tgp = rest(s.tgp, periodT);
  else if (pick === 'MAV') s.mav = rest(s.mav, periodM);
  s.last = pick;
  return pick;
}
