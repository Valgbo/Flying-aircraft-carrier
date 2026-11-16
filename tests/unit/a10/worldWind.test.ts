/**
 * World module: the standard atmosphere, the wind profile and the turbulence field.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  ISA,
  WIND,
  casFromTas,
  createFlatTerrain,
  createWorldState,
  densityAt,
  gustAt,
  gustScales,
  pressureAt,
  speedOfSoundAt,
  tasFromCas,
  temperatureAt,
  windAt,
  type GustScales,
} from '../../../src/a10/core/world';

describe('standard atmosphere', () => {
  it('matches the ISA table', () => {
    expect(temperatureAt(0)).toBeCloseTo(288.15, 6);
    expect(pressureAt(0)).toBeCloseTo(101325, 3);
    expect(densityAt(0)).toBeCloseTo(1.225, 3);
    expect(speedOfSoundAt(0)).toBeCloseTo(340.294, 2);
    // Geometric 11,019 m = geopotential 11,000 m (the tropopause).
    expect(temperatureAt(11019.1)).toBeCloseTo(216.65, 2);
    expect(pressureAt(11019.1)).toBeCloseTo(22632, -1);
    // 3,000 m (geometric): 268.66 K, 70,121 Pa, 0.9093 kg/m³ (US Standard Atmosphere 1976).
    expect(temperatureAt(3000)).toBeCloseTo(268.659, 2);
    expect(pressureAt(3000) / 70121).toBeCloseTo(1, 3);
    expect(densityAt(3000) / 0.90925).toBeCloseTo(1, 3);
    // Lower stratosphere: constant temperature.
    expect(temperatureAt(15000)).toBeCloseTo(216.65, 6);
  });

  it('a hot day thins the air at the same height', () => {
    expect(densityAt(1000, 15)).toBeLessThan(densityAt(1000));
    expect(temperatureAt(1000, 15)).toBeCloseTo(temperatureAt(1000) + 15, 9);
    // Sea level pressure is the standard one either way.
    expect(pressureAt(0, 20)).toBeCloseTo(ISA.seaLevelPressure, 6);
  });

  it('CAS and TAS agree at sea level, TAS exceeds CAS aloft, and they round-trip', () => {
    expect(casFromTas(128.6, 0)).toBeCloseTo(128.6, 6);
    const tas = 150;
    const cas = casFromTas(tas, 2438);
    expect(cas).toBeLessThan(tas);
    // ≈ 12 % less at 8,000 ft.
    expect(cas / tas).toBeGreaterThan(0.86);
    expect(cas / tas).toBeLessThan(0.9);
    expect(tasFromCas(cas, 2438)).toBeCloseTo(tas, 6);
    expect(tasFromCas(casFromTas(210, 5000, 10), 5000, 10)).toBeCloseTo(210, 6);
  });
});

describe('wind', () => {
  const terrain = createFlatTerrain(100);
  const world = createWorldState(terrain);
  world.surfaceWind.set(5, 0, 0); // 5 m/s toward the east
  world.windVeer = 0;
  const out = new Vector3();

  it('is the 10 m wind at 10 m and grows with height above the ground', () => {
    windAt(world, new Vector3(0, 110, 0), out);
    expect(out.x).toBeCloseTo(5, 6);
    let prev = 0;
    for (const agl of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) {
      windAt(world, new Vector3(0, 100 + agl, 0), out);
      expect(out.length()).toBeGreaterThan(prev);
      prev = out.length();
    }
    // Log law near the ground: half the 10 m wind at about 0.6 m over open ground.
    windAt(world, new Vector3(0, 100.6, 0), out);
    expect(out.x / 5).toBeCloseTo(Math.log(0.6 / WIND.roughnessOpen) / Math.log(10 / WIND.roughnessOpen), 6);
    // At the top of the boundary layer, about twice the surface wind; constant above.
    windAt(world, new Vector3(0, 100 + 1000, 0), out);
    expect(out.x / 5).toBeGreaterThan(1.7);
    expect(out.x / 5).toBeLessThan(2.2);
    const top = out.x;
    windAt(world, new Vector3(0, 100 + 3000, 0), out);
    expect(out.x).toBeCloseTo(top, 9);
    // Below the ground: still air.
    windAt(world, new Vector3(0, 90, 0), out);
    expect(out.length()).toBe(0);
  });

  it('veers clockwise with height (northern hemisphere)', () => {
    const w = createWorldState(terrain);
    w.surfaceWind.set(0, 0, -5); // toward the north
    windAt(w, new Vector3(0, 100 + 10, 0), out);
    expect(out.x).toBeCloseTo(0, 9);
    windAt(w, new Vector3(0, 100 + 1000, 0), out);
    // Turned clockwise (toward the east) by the default veer.
    expect(Math.atan2(out.x, -out.z)).toBeCloseTo(WIND.veer, 6);
  });
});

describe('turbulence', () => {
  it('follows the Dryden low-altitude intensities and length scales', () => {
    const w = createWorldState(createFlatTerrain(0));
    w.turbulence = 0;
    const s: GustScales = { sigmaU: 0, sigmaW: 0, lengthU: 0, lengthW: 0 };
    gustScales(w, 100 * 0.3048, 10, s);
    // σw = 0.1·W20; σu/σw = 1/(0.177 + 0.000823·h)^0.4 at h = 100 ft.
    const w20 = 10 * (Math.log(6.096 / WIND.roughnessOpen) / Math.log(10 / WIND.roughnessOpen));
    expect(s.sigmaW).toBeCloseTo(0.1 * w20, 6);
    expect(s.sigmaU / s.sigmaW).toBeCloseTo(1 / Math.pow(0.177 + 0.0823, 0.4), 6);
    expect(s.lengthW).toBeCloseTo(30.48, 6);
    // Aloft: isotropic, L = 1,750 ft.
    gustScales(w, 3000, 10, s);
    expect(s.lengthU).toBeCloseTo(533.4, 6);
    expect(s.lengthW).toBeCloseTo(533.4, 6);
  });

  it('is zero-mean, about σ in RMS, smooth, deterministic and stronger near the ground', () => {
    const w = createWorldState(createFlatTerrain(0));
    w.surfaceWind.set(8, 0, 0);
    w.turbulence = 0.5;
    const g = new Vector3();
    const s: GustScales = { sigmaU: 0, sigmaW: 0, lengthU: 0, lengthW: 0 };
    const stats = (agl: number) => {
      let mu = 0;
      let mw = 0;
      let su = 0;
      let sw = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) {
        gustAt(w, new Vector3(i * 37.3, agl, (i % 97) * 51.7), i * 0.11, g);
        mu += g.x;
        mw += g.y;
        su += g.x * g.x;
        sw += g.y * g.y;
      }
      return { mu: mu / n, mw: mw / n, ru: Math.sqrt(su / n), rw: Math.sqrt(sw / n) };
    };
    const low = stats(50);
    gustScales(w, 50, 8, s);
    expect(Math.abs(low.mu)).toBeLessThan(0.25 * s.sigmaU);
    expect(Math.abs(low.mw)).toBeLessThan(0.25 * s.sigmaW);
    expect(low.ru / s.sigmaU).toBeGreaterThan(0.6);
    expect(low.ru / s.sigmaU).toBeLessThan(1.5);
    const high = stats(2500);
    expect(high.ru).toBeLessThan(low.ru);
    // Smooth: 1 m apart at the same time differs by much less than σ.
    const a = new Vector3();
    const b = new Vector3();
    gustAt(w, new Vector3(1000, 60, 2000), 3, a);
    gustAt(w, new Vector3(1001, 60, 2000), 3, b);
    expect(a.distanceTo(b)).toBeLessThan(0.3 * s.sigmaU);
    // Deterministic.
    gustAt(w, new Vector3(1000, 60, 2000), 3, b);
    expect(b.toArray()).toEqual(a.toArray());
    // Still air and no turbulence setting: no gusts.
    const calm = createWorldState(createFlatTerrain(0));
    calm.turbulence = 0;
    gustAt(calm, new Vector3(0, 100, 0), 1, g);
    expect(g.length()).toBe(0);
  });
});
