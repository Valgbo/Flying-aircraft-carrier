/**
 * Per-frame painting of the HUD graphics. The instrument components register their moving
 * SVG elements in a `HudLive` record; `paintHud` reads `sim` and writes transforms / dash
 * lengths straight to those elements. Values are quantised and cached so an attribute is
 * only touched when the picture would actually change.
 */
import { sim } from '../../state/sim';
import type { Quad } from '../../state/types';
import { RAD2DEG } from '../../utils/math';
import {
  HORIZON_CENTER,
  arcAngleDeg,
  arcLength,
  horizonRotationDeg,
  horizonShift,
  vsiFraction,
} from './attitude';
import { tapeOffset } from './compass';

/** Geometry shared by the gauge component (static parts) and the painter (moving parts). */
export const GAUGE_DIAL = { size: 48, center: 24, radius: 19 } as const;
export const TILT_DIAL = { width: 28, height: 20, pivotX: 14, pivotY: 17, needle: 13 } as const;
/** Travel of the vertical-speed needle either side of zero, user units of its 14 × 80 view box. */
export const VSI_DIAL = { width: 14, height: 80, center: 40, travel: 34 } as const;

export interface HudLive {
  /** Rotates with roll: horizon, ladder and roll scale. */
  horizonRoll: SVGGElement | null;
  /** Slides with pitch inside the rolled frame. */
  horizonPitch: SVGGElement | null;
  compassStrip: SVGGElement | null;
  vsiNeedle: SVGGElement | null;
  throttleArcs: Quad<SVGCircleElement | null>;
  commandTicks: Quad<SVGLineElement | null>;
  tiltNeedles: Quad<SVGLineElement | null>;
}

export function createHudLive(): HudLive {
  return {
    horizonRoll: null,
    horizonPitch: null,
    compassStrip: null,
    vsiNeedle: null,
    throttleArcs: [null, null, null, null],
    commandTicks: [null, null, null, null],
    tiltNeedles: [null, null, null, null],
  };
}

interface PaintCache {
  roll: number;
  pitch: number;
  tape: number;
  vsi: number;
  arc: Quad<number>;
  command: Quad<number>;
  tilt: Quad<number>;
}

function createCache(): PaintCache {
  return {
    roll: NaN,
    pitch: NaN,
    tape: NaN,
    vsi: NaN,
    arc: [NaN, NaN, NaN, NaN],
    command: [NaN, NaN, NaN, NaN],
    tilt: [NaN, NaN, NaN, NaN],
  };
}

/** Round to 1/100 of a unit: finer than a pixel on every instrument. */
function quantise(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Build the painter for one mounted HUD. The returned function is what the frame loop calls;
 * its cache lives in the closure so a remounted HUD repaints everything once.
 */
export function createHudPainter(live: HudLive): () => void {
  const cache = createCache();
  const arcFull = arcLength(1, GAUGE_DIAL.radius);
  const circumference = 2 * Math.PI * GAUGE_DIAL.radius;

  return function paintHud(): void {
    const c = sim.carrier;

    const roll = quantise(horizonRotationDeg(c.roll * RAD2DEG));
    if (live.horizonRoll && roll !== cache.roll) {
      cache.roll = roll;
      live.horizonRoll.setAttribute(
        'transform',
        `rotate(${roll} ${HORIZON_CENTER} ${HORIZON_CENTER})`,
      );
    }
    const pitch = quantise(horizonShift(c.pitch * RAD2DEG));
    if (live.horizonPitch && pitch !== cache.pitch) {
      cache.pitch = pitch;
      live.horizonPitch.setAttribute('transform', `translate(0 ${pitch})`);
    }

    const tape = quantise(tapeOffset(c.headingDeg));
    if (live.compassStrip && tape !== cache.tape) {
      cache.tape = tape;
      live.compassStrip.setAttribute('transform', `translate(${tape} 0)`);
    }

    // climbing moves the needle UP the instrument (-y)
    const vsi = quantise(-vsiFraction(c.verticalSpeed) * VSI_DIAL.travel);
    if (live.vsiNeedle && vsi !== cache.vsi) {
      cache.vsi = vsi;
      live.vsiNeedle.setAttribute('transform', `translate(0 ${vsi})`);
    }

    for (let i = 0; i < 4; i++) {
      const t = sim.turbines[i];

      const arc = quantise(arcLength(t.throttle, GAUGE_DIAL.radius));
      const arcEl = live.throttleArcs[i];
      if (arcEl && arc !== cache.arc[i]) {
        cache.arc[i] = arc;
        arcEl.setAttribute('stroke-dasharray', `${Math.min(arc, arcFull)} ${circumference}`);
      }

      const command = quantise(arcAngleDeg(t.enabled ? t.throttleCmd : 0));
      const tickEl = live.commandTicks[i];
      if (tickEl && command !== cache.command[i]) {
        cache.command[i] = command;
        tickEl.setAttribute(
          'transform',
          `rotate(${command} ${GAUGE_DIAL.center} ${GAUGE_DIAL.center})`,
        );
      }

      // positive tilt (thrust toward the bow) swings the needle clockwise
      const tilt = quantise(t.tilt * RAD2DEG);
      const needleEl = live.tiltNeedles[i];
      if (needleEl && tilt !== cache.tilt[i]) {
        cache.tilt[i] = tilt;
        needleEl.setAttribute(
          'transform',
          `rotate(${tilt} ${TILT_DIAL.pivotX} ${TILT_DIAL.pivotY})`,
        );
      }
    }
  };
}
