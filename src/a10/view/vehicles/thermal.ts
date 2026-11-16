/**
 * THERMAL RENDERING HOOK for the sensors module (targeting pod and infrared Maverick pictures,
 * PLAN_A10.md §8). Every vehicle material and the effects' particle material share these uniform
 * objects, so one switch changes how they draw:
 *
 *   uThermal 0 = visible (normal colours, the default)
 *            1 = white-hot: output = heat as a grey level, hot = white
 *            2 = black-hot: the same, inverted
 *
 * In thermal modes the materials write a LINEAR grey level (no lighting, no scene fog), meant to
 * be drawn into the sensor's render target; the sensor page applies its own gain, noise and tone
 * mapping. Heat comes from `vehicle.heat` (engine deck, exhaust, running gear, hull: kelvin above
 * ambient, mapped onto the parts of the model that carry it) plus `vehicle.fire`; particles carry
 * their own heat (fire and flashes hot, fresh smoke warm, dust cold).
 *
 * Usage from a sensor pass:
 *   setThermalMode(1); gl.render(scene, sensorCamera); setThermalMode(0);
 */
export const THERMAL_VISIBLE = 0;
export const THERMAL_WHITE_HOT = 1;
export const THERMAL_BLACK_HOT = 2;
export type ThermalMode = 0 | 1 | 2;

export const thermalUniforms = {
  /** 0 visible, 1 white-hot, 2 black-hot. */
  uThermal: { value: 0 as number },
  /** Grey level (0..1) of a surface at ambient temperature. */
  uThermalLevel: { value: 0.3 },
  /** Grey levels per kelvin above ambient. */
  uThermalGain: { value: 1 / 75 },
};

export function setThermalMode(mode: ThermalMode): void {
  thermalUniforms.uThermal.value = mode;
}

export function getThermalMode(): ThermalMode {
  return thermalUniforms.uThermal.value as ThermalMode;
}

/** Ambient grey level and gain of the thermal picture (the sensor's level and gain controls). */
export function setThermalLevelGain(level: number, gainPerKelvin: number): void {
  thermalUniforms.uThermalLevel.value = level;
  thermalUniforms.uThermalGain.value = gainPerKelvin;
}
