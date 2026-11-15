/**
 * Per-frame painting of the turbine panel's live bars (actual versus commanded throttle and
 * tilt). Same approach as the HUD painter: elements are registered in a record, values are
 * quantised and only written when they change.
 */
import { PHYS } from '../../config/physicsConfig';
import { sim } from '../../state/sim';
import type { Quad } from '../../state/types';
import { barFraction } from './attitude';

export interface PanelLive {
  throttleFill: Quad<HTMLElement | null>;
  throttleCommand: Quad<HTMLElement | null>;
  tiltFill: Quad<HTMLElement | null>;
  tiltCommand: Quad<HTMLElement | null>;
}

export function createPanelLive(): PanelLive {
  return {
    throttleFill: [null, null, null, null],
    throttleCommand: [null, null, null, null],
    tiltFill: [null, null, null, null],
    tiltCommand: [null, null, null, null],
  };
}

/** Where upright (0°) sits on the tilt bar, 0..1. */
export const TILT_ZERO_FRACTION = barFraction(0, PHYS.tiltMin, PHYS.tiltMax);

/** Percent with one decimal: a tenth of a percent of a 150 px bar is well below a pixel. */
function percent(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

export function createPanelPainter(live: PanelLive): () => void {
  const cache = {
    throttle: [NaN, NaN, NaN, NaN],
    throttleCommand: [NaN, NaN, NaN, NaN],
    tilt: [NaN, NaN, NaN, NaN],
    tiltCommand: [NaN, NaN, NaN, NaN],
  };
  const zero = percent(TILT_ZERO_FRACTION);

  return function paintPanel(): void {
    for (let i = 0; i < 4; i++) {
      const t = sim.turbines[i];

      const throttle = percent(barFraction(t.throttle, 0, 1));
      const fill = live.throttleFill[i];
      if (fill && throttle !== cache.throttle[i]) {
        cache.throttle[i] = throttle;
        fill.style.width = `${throttle}%`;
      }

      const throttleCommand = percent(barFraction(t.enabled ? t.throttleCmd : 0, 0, 1));
      const commandMark = live.throttleCommand[i];
      if (commandMark && throttleCommand !== cache.throttleCommand[i]) {
        cache.throttleCommand[i] = throttleCommand;
        commandMark.style.left = `${throttleCommand}%`;
      }

      // the tilt bar fills from upright toward the actual angle, either way
      const tilt = percent(barFraction(t.tilt, PHYS.tiltMin, PHYS.tiltMax));
      const tiltFill = live.tiltFill[i];
      if (tiltFill && tilt !== cache.tilt[i]) {
        cache.tilt[i] = tilt;
        tiltFill.style.left = `${Math.min(zero, tilt)}%`;
        tiltFill.style.width = `${Math.abs(tilt - zero)}%`;
      }

      const tiltCommand = percent(barFraction(t.tiltCmd, PHYS.tiltMin, PHYS.tiltMax));
      const tiltMark = live.tiltCommand[i];
      if (tiltMark && tiltCommand !== cache.tiltCommand[i]) {
        cache.tiltCommand[i] = tiltCommand;
        tiltMark.style.left = `${tiltCommand}%`;
      }
    }
  };
}
