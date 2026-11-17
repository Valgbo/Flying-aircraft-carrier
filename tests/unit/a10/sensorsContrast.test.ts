/**
 * The shared contrast model (ARCHITECTURE §12.5, PLAN §8 "the infrared Maverick seeker uses the
 * same thermal model, so what the pod shows as hot is what the missile can lock"): the core's
 * mirror of the renderer's sun, haze and thermal laws must stay equal to them. The sky and haze
 * functions are compared directly; the shader constants are read from the shader sources, so a
 * change there fails here until data/sensors.ts follows it.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  createSunState,
  groundThermalLevel,
  hazeDensity,
  hazeFactor,
  irApparentK,
  irContrast,
  kelvinToLevel,
  levelToKelvin,
  smokeBetween,
  sunStateAt,
  targetContrast,
  thermalSignatureK,
  tvApparentContrast,
  tvContrast,
  vehicleZoneHeat,
  createZoneHeat,
} from '../../../src/a10/core/sensors';
import { addVehicle, createSensorTestbed } from '../../../src/a10/core/sensors/testbed';
import { CONTRAST, GROUND_THERMAL, SMOKE } from '../../../src/a10/data/sensors';
import { THERMAL } from '../../../src/a10/data/vehicles';
import { hazeDensityFor, hazeFactor as viewHazeFactor } from '../../../src/a10/view/environment/haze';
import { thermalUniforms } from '../../../src/a10/view/vehicles/thermal';
import { daylightAt, sunDirectionAt } from '../../../src/scene/sky/timeOfDay';

const sources = import.meta.glob(
  [
    '../../../src/a10/view/terrain/terrainMaterial.ts',
    '../../../src/a10/view/terrain/terrainSystem.ts',
    '../../../src/a10/view/vehicles/VehicleRenderer.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

function source(name: string): string {
  const key = Object.keys(sources).find((k) => k.endsWith(name));
  if (!key) throw new Error(`no source ${name}`);
  return sources[key];
}

describe('the contrast model mirrors what the renderer draws', () => {
  it('sun and daylight: the sky module’s arc and daylight factor', () => {
    const sun = createSunState();
    const d = new Vector3();
    for (let h = 0; h < 24; h += 0.25) {
      sunStateAt(h, sun);
      sunDirectionAt(h, d);
      expect(sun.dir.distanceTo(d)).toBeLessThan(1e-12);
      expect(sun.daylight).toBeCloseTo(daylightAt(h), 12);
    }
    sunStateAt(12, sun);
    expect(Math.asin(sun.sinElevation)).toBeCloseTo(CONTRAST.sunCulmination, 9);
    expect(sun.dir.z).toBeGreaterThan(0); // noon sun in the south (+Z)
    sunStateAt(6, sun);
    expect(sun.dir.x).toBeGreaterThan(0.99); // rises in the east
  });

  it('haze: the environment module’s FogExp2 law and its thinning with height', () => {
    for (const v of [3, 8, 20, 40])
      for (const h of [0, 500, 3000]) {
        expect(hazeDensity(v, h)).toBeCloseTo(hazeDensityFor(v, h), 15);
        expect(hazeFactor(hazeDensity(v, h), 7000)).toBeCloseTo(
          viewHazeFactor(hazeDensityFor(v, h), 7000),
          12,
        );
      }
  });

  it('ground temperature: the terrain shader’s formula and class levels', () => {
    const shader = source('terrainMaterial.ts');
    const f = shader.match(
      /temperature \+ \(uThermalParams\.x \* heatUptake \* sun - ([\d.]+)\) \* ([\d.]+) \+ \(uThermalParams\.y - ([\d.]+)\) \* ([\d.]+)/,
    );
    expect(f, 'thermal formula in terrainMaterial.ts').not.toBeNull();
    expect(Number(f?.[1])).toBe(CONTRAST.groundSunOffset);
    expect(Number(f?.[2])).toBe(CONTRAST.groundSunGain);
    expect(Number(f?.[3])).toBe(CONTRAST.groundAmbientRef);
    expect(Number(f?.[4])).toBe(CONTRAST.groundAmbientGain);
    const cls = shader.match(
      /temperature = cls == 3\.0 \? ([\d.]+) : cls == 4\.0 \? ([\d.]+) : cls == 2\.0 \? ([\d.]+) : cls == 5\.0 \? ([\d.]+) : cls == 6\.0 \? ([\d.]+) : ([\d.]+);/,
    );
    expect(cls, 'class levels in terrainMaterial.ts').not.toBeNull();
    expect(Number(cls?.[1])).toBe(GROUND_THERMAL.rock.level);
    expect(Number(cls?.[2])).toBe(GROUND_THERMAL.sand.level);
    expect(Number(cls?.[3])).toBe(GROUND_THERMAL.dirt.level);
    expect(Number(cls?.[4])).toBe(GROUND_THERMAL.forest.level);
    expect(Number(cls?.[5])).toBe(GROUND_THERMAL.concrete.level - 0.01); // class 6 (paved) 0.55, the airbase ribbon 0.56
    expect(Number(cls?.[6])).toBe(GROUND_THERMAL.grass.level);
    expect(shader).toMatch(/cls == 5\.0 \? 0\.25 : cls == 3\.0 \|\| cls == 6\.0 \? 0\.85 : 0\.6/);
    expect(shader).toMatch(/temperature = 0\.58;\s*heatUptake = 0\.95;/); // asphalt roads
    expect(shader).toMatch(/temperature = 0\.2;\s*heatUptake = 0\.1;/); // the river
    expect(shader).toMatch(/float t = mix\(temperature, ([\d.]+), haze \* ([\d.]+)\);/);
    const fade = shader.match(/float t = mix\(temperature, ([\d.]+), haze \* ([\d.]+)\);/);
    expect(Number(fade?.[1])).toBe(CONTRAST.skyLevel);
    expect(Number(fade?.[2])).toBe(CONTRAST.irHazeShare);
    // solar heating and the lagging ambient level by time of day (terrainSystem.ts)
    const sys = source('terrainSystem.ts');
    const solar = sys.match(/Math\.sin\(\(\(h - ([\d.]+)\) \/ ([\d.]+)\) \* Math\.PI\)\) \* a10Env\.daylight/);
    const lag = sys.match(/const lag = Math\.max\(0, Math\.sin\(\(\(h - ([\d.]+)\) \/ ([\d.]+)\) \* Math\.PI\)\)/);
    const amb = sys.match(/uThermalParams\.value\.set\(solar, ([\d.]+) \+ ([\d.]+) \* lag/);
    expect(Number(solar?.[1])).toBe(CONTRAST.solarStartHour);
    expect(Number(solar?.[2])).toBe(CONTRAST.solarSpanHours);
    expect(Number(lag?.[1])).toBe(CONTRAST.ambientStartHour);
    expect(Number(lag?.[2])).toBe(CONTRAST.ambientSpanHours);
    expect(Number(amb?.[1])).toBe(CONTRAST.ambientBase);
    expect(Number(amb?.[2])).toBe(CONTRAST.ambientSwing);
  });

  it('vehicle heat: the vehicles’ thermal hook and the renderer’s fire heat', () => {
    expect(thermalUniforms.uThermalLevel.value).toBe(CONTRAST.ambientLevel);
    expect(thermalUniforms.uThermalGain.value).toBeCloseTo(1 / CONTRAST.kelvinPerLevel, 12);
    const r = source('VehicleRenderer.ts');
    const fire = r.match(
      /h\.engine \+ fire \* (\d+);\s*H\[o \+ 1\] = h\.exhaust \+ fire \* (\d+);\s*H\[o \+ 2\] = h\.running \+ fire \* (\d+);\s*H\[o \+ 3\] = h\.hull \+ fire \* (\d+);/,
    );
    expect(fire, 'fire heat in VehicleRenderer.ts').not.toBeNull();
    expect(Number(fire?.[1])).toBe(CONTRAST.fireEngine);
    expect(Number(fire?.[2])).toBe(CONTRAST.fireExhaust);
    expect(Number(fire?.[3])).toBe(CONTRAST.fireRunning);
    expect(Number(fire?.[4])).toBe(CONTRAST.fireHull);
  });
});

describe('the contrast model', () => {
  it('ground: sunlit fields warm through the day, cool at night; levels map to kelvin', () => {
    const sun = createSunState();
    sunStateAt(13, sun);
    const noon = groundThermalLevel('grass', sun.sinElevation, sun);
    sunStateAt(23, sun);
    const night = groundThermalLevel('grass', 0, sun);
    expect(levelToKelvin(noon)).toBeGreaterThan(15);
    expect(levelToKelvin(night)).toBeLessThan(3);
    expect(kelvinToLevel(levelToKelvin(0.42))).toBeCloseTo(0.42, 12);
    // asphalt runs hotter than grass, a forest cooler, water coldest
    sunStateAt(13, sun);
    const e = sun.sinElevation;
    expect(groundThermalLevel('road', e, sun)).toBeGreaterThan(noon);
    expect(groundThermalLevel('forest', e, sun)).toBeLessThan(noon);
    expect(groundThermalLevel('water', e, sun)).toBeLessThan(groundThermalLevel('forest', e, sun));
  });

  it('IR: the signature is the RMS of the zones against the ground; haze and smoke weaken it', () => {
    const sim = createSensorTestbed();
    const v = addVehicle(sim, 'mbt', 0, -3000, 0, { heat: 'idle' });
    const z = vehicleZoneHeat(v, createZoneHeat());
    const groundK = 18; // an idling tank's mean ≈ a sunlit field: no mean contrast…
    const mean =
      CONTRAST.zoneHull * z.hull +
      CONTRAST.zoneEngine * z.engine +
      CONTRAST.zoneRunning * z.running +
      CONTRAST.zoneExhaust * z.exhaust;
    expect(Math.abs(mean - groundK)).toBeLessThan(3);
    // …but its hot deck and exhaust stand out
    const sig = thermalSignatureK(z, groundK);
    expect(sig).toBeGreaterThan(15);
    expect(irContrast(sig)).toBeGreaterThan(0.75);
    expect(irApparentK(sig, 0.5)).toBeCloseTo(sig * (1 - CONTRAST.irHazeShare * 0.5), 12);
    // a full fire swamps everything
    v.fire = 1;
    expect(thermalSignatureK(vehicleZoneHeat(v, z), groundK)).toBeGreaterThan(200);
    expect(THERMAL.exhaustIdle).toBeGreaterThan(THERMAL.engineIdle);
  });

  it('TV: Koschmieder dilution of the paint contrast, no light no contrast', () => {
    const sun = createSunState();
    sunStateAt(12, sun);
    const c0 = Math.abs(CONTRAST.paintLuminance - 0.15) / 0.15;
    expect(tvApparentContrast(CONTRAST.paintLuminance, 0.15, 0, 0, sun)).toBeCloseTo(c0, 9);
    const f = 0.3;
    const expected = (c0 * (1 - f)) / (1 - f + CONTRAST.skyGroundRatio * f);
    expect(tvApparentContrast(CONTRAST.paintLuminance, 0.15, 0, f, sun)).toBeCloseTo(expected, 9);
    expect(tvApparentContrast(CONTRAST.paintLuminance, 0.15, 0, 1, sun)).toBeCloseTo(0, 6);
    expect(tvContrast(c0)).toBeGreaterThan(0.85);
    sunStateAt(0, sun);
    expect(tvApparentContrast(CONTRAST.paintLuminance, 0.15, 0, 0, sun)).toBe(0);
  });

  it('smoke of a burning vehicle across the line of sight blocks TV and dims IR', () => {
    const sim = createSensorTestbed({ altitude: 1500 });
    sim.world.surfaceWind.set(0, 0, 0);
    const from = new Vector3(0, 1500, 0);
    const target = addVehicle(sim, 'mbt', 0, -6000, Math.PI / 2, { heat: 'idle' });
    const clearTv = targetContrast(sim, target.id, 'TV', from);
    const clearIr = targetContrast(sim, target.id, 'IR', from);
    // a burning wreck 1.5 km short of the target, under the line of sight (it passes ≈375 m
    // above it: inside the column's 150 m height? no) — and one right under the line near the end
    const wreck = addVehicle(sim, 'truckFuel', 0, -5940, 0, { heat: 'cold' });
    wreck.fire = 1;
    expect(smokeBetween(sim, from, target.position.clone().setY(1.5), target.id)).toBe(true);
    expect(targetContrast(sim, target.id, 'TV', from)).toBe(0);
    const smokedIr = targetContrast(sim, target.id, 'IR', from);
    expect(smokedIr).toBeLessThan(clearIr);
    expect(clearTv).toBeGreaterThan(0.5);
    // the column drifts downwind: a strong crosswind blows it off the line
    sim.world.surfaceWind.set(20, 0, 0);
    expect(smokeBetween(sim, from, target.position.clone().setY(1.5), target.id)).toBe(true);
    wreck.position.set(60, 0, -5940);
    expect(smokeBetween(sim, from, target.position.clone().setY(1.5), target.id)).toBe(false);
    expect(SMOKE.irTransmission).toBeLessThan(1);
    expect(targetContrast(sim, 99999, 'IR', from)).toBe(0);
  });
});
