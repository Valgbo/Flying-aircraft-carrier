/**
 * When a sensor delivers a picture (ARCHITECTURE §12.7 `SensorPictureInfo.valid`), pure.
 *
 * TARGETING POD: carried on a station (else there is no TGP picture at all: null); powered
 * (the AHCP's TGP switch and the pod's own power state); warmed up (`tgp.warmup` = 0: the
 * pod shows no video while its FLIR cooler and gyros come up); not masked (`tgp.masked`: the
 * line of sight is blocked by the aircraft's own wing, pylons or fuselage, or beyond the gimbal
 * limits). MAVERICK: a missile selected (else null); its seeker powered and aligned
 * (`align` = 0: about three minutes after power-on, PLAN §6.4).
 *
 * What the picture shows when it is not valid (decided here, drawn by SensorRenderer):
 *   OFF, WARMUP, ALIGN  no video: black;
 *   MASKED              the pod's window looks at its own aircraft's skin a few metres away, far
 *                       out of focus (the optics are focused at infinity): a featureless field at
 *                       the skin's temperature (infrared) or a dim grey (CCD), whose noise the
 *                       automatic gain control brings up within a second — not the scene behind
 *                       the wing. The display page adds its MASK cue.
 */
import type { Sim } from '../../core/types';
import { podStation } from './sensorPose';

export type SensorPictureStatus = 'OK' | 'OFF' | 'WARMUP' | 'ALIGN' | 'MASKED';

/** The targeting pod's picture status, or null when no pod is carried. */
export function tgpPictureStatus(sim: Sim): SensorPictureStatus | null {
  if (podStation(sim) < 0) return null;
  const tgp = sim.sensors.tgp;
  if (!tgp.powered || !sim.avionics.tgpPower) return 'OFF';
  if (tgp.warmup > 0) return 'WARMUP';
  if (tgp.masked) return 'MASKED';
  return 'OK';
}

/** The selected Maverick's picture status, or null when no missile is selected. */
export function maverickPictureStatus(sim: Sim): SensorPictureStatus | null {
  const seeker = sim.sensors.mavericks[sim.sensors.selectedMaverick];
  if (!seeker) return null;
  if (!seeker.powered) return 'OFF';
  if (seeker.align > 0) return 'ALIGN';
  return 'OK';
}

/** A status that shows the scene (live video). */
export function showsScene(status: SensorPictureStatus | null): boolean {
  return status === 'OK';
}

/** A status with any video at all (the masked field included). */
export function hasVideo(status: SensorPictureStatus | null): boolean {
  return status === 'OK' || status === 'MASKED';
}
