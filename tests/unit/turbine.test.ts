import { describe, expect, it } from 'vitest';
import { TURBINE } from '../../src/config/layout';
import {
  DUCT_HALF_HEIGHT,
  DUCT_INNER_PROFILE,
  DUCT_OUTER_PROFILE,
  EXIT_INNER_RADIUS,
  EXIT_OUTER_RADIUS,
  IDLE_RPM,
  MAX_SPIN,
  NOZZLE_Y,
  SKIN_TILES,
  THROAT_RADIUS,
  bladeOpacity,
  bladeSection,
  blurOpacity,
  carrierToNacelle,
  compressGlow,
  coreIntensity,
  driveLevel,
  exhaustExposure,
  exhaustSpeed,
  glowIntensity,
  glowWhiteness,
  linerV,
  plumeLength,
  profileArcFractions,
  profileRadiusAt,
  skinV,
  spinDirection,
  sprayParticleCount,
  sprayRadius,
  turbineDetail,
} from '../../src/carrier/turbine/model';
import { thrustAxisLocal } from '../../src/state/simHelpers';
import { Vector3 } from 'three';

describe('turbine duct profile', () => {
  it('fits the layout envelope', () => {
    const all = [...DUCT_OUTER_PROFILE, ...DUCT_INNER_PROFILE];
    expect(Math.max(...all.map((p) => p.r))).toBeCloseTo(TURBINE.ductOuterRadius);
    expect(Math.max(...all.map((p) => p.y))).toBeCloseTo(DUCT_HALF_HEIGHT);
    expect(Math.min(...all.map((p) => p.y))).toBeCloseTo(NOZZLE_Y);
    expect(NOZZLE_Y).toBeCloseTo(-TURBINE.ductHeight / 2);
  });

  it('is a closed ring: both profiles share the lip crest and the exit edge', () => {
    const outerTop = DUCT_OUTER_PROFILE[DUCT_OUTER_PROFILE.length - 1];
    const innerBottom = DUCT_INNER_PROFILE[DUCT_INNER_PROFILE.length - 1];
    expect(DUCT_INNER_PROFILE[0]).toEqual(outerTop);
    expect(DUCT_OUTER_PROFILE[0]).toEqual(innerBottom);
  });

  it('keeps the throat clear of the fan and narrows toward the exit', () => {
    for (const p of DUCT_INNER_PROFILE) {
      if (p.y > -1 && p.y < 3) expect(p.r).toBeGreaterThan(TURBINE.fanRadius);
    }
    expect(THROAT_RADIUS - TURBINE.fanRadius).toBeLessThan(1);
    expect(EXIT_OUTER_RADIUS).toBeLessThan(TURBINE.ductOuterRadius);
    expect(EXIT_INNER_RADIUS).toBeLessThan(THROAT_RADIUS);
    expect(EXIT_INNER_RADIUS).toBeLessThan(EXIT_OUTER_RADIUS);
  });

  it('interpolates radii along a profile and clamps beyond its ends', () => {
    expect(profileRadiusAt(DUCT_INNER_PROFILE, 1)).toBeCloseTo(THROAT_RADIUS);
    expect(profileRadiusAt(DUCT_INNER_PROFILE, NOZZLE_Y)).toBeCloseTo(EXIT_INNER_RADIUS);
    expect(profileRadiusAt(DUCT_INNER_PROFILE, -50)).toBeCloseTo(EXIT_INNER_RADIUS);
    expect(profileRadiusAt(DUCT_OUTER_PROFILE, 2)).toBeCloseTo(TURBINE.ductOuterRadius);
  });

  it('lays the paint atlas monotonically along the skin and the liner', () => {
    const forward = profileArcFractions(DUCT_INNER_PROFILE);
    const backward = profileArcFractions(DUCT_OUTER_PROFILE, true);
    expect(forward[0]).toBe(0);
    expect(forward[forward.length - 1]).toBeCloseTo(1);
    expect(backward[0]).toBeCloseTo(1);
    expect(backward[backward.length - 1]).toBe(0);
    for (let i = 1; i < forward.length; i++) expect(forward[i]).toBeGreaterThan(forward[i - 1]);
    // skin rows sit above the liner rows, which sit above the plain white band
    expect(skinV(0)).toBeGreaterThan(skinV(1));
    expect(skinV(1)).toBeGreaterThan(linerV(0));
    expect(linerV(0)).toBeGreaterThan(linerV(1));
    expect(linerV(1)).toBeGreaterThan(0);
  });
});

describe('turbine level of detail', () => {
  it('scales down on Low and keeps the duct a whole number of skin tiles', () => {
    const low = turbineDetail(0);
    const high = turbineDetail(2);
    for (const d of [low, turbineDetail(1), high]) {
      expect(d.ductSegments % SKIN_TILES).toBe(0);
    }
    expect(low.ductSegments).toBeLessThan(high.ductSegments);
    expect(low.bladeSpans).toBeLessThan(high.bladeSpans);
    expect(low.plumeRings).toBeLessThan(high.plumeRings);
    expect(low.guideVanes).toBe(0);
  });
});

describe('fan', () => {
  it('has blades from inside the hub to the fan radius, twisted and swept', () => {
    const root = bladeSection(0);
    const tip = bladeSection(1);
    expect(root.radius).toBeLessThan(TURBINE.hubRadius);
    expect(tip.radius).toBeCloseTo(TURBINE.fanRadius);
    expect(root.pitch).toBeGreaterThan(tip.pitch);
    expect(tip.sweep).toBeLessThan(root.sweep);
    expect(tip.thickness).toBeLessThan(root.thickness);
    expect(bladeSection(2)).toEqual(tip);
  });

  it('counter-rotates port and starboard', () => {
    expect(spinDirection(0)).toBe(1);
    expect(spinDirection(2)).toBe(1);
    expect(spinDirection(1)).toBe(-1);
    expect(spinDirection(3)).toBe(-1);
    expect(MAX_SPIN / (2 * Math.PI)).toBeCloseTo(2.5);
  });

  it('cross-fades blades into the blur disc as the fan speeds up', () => {
    expect(bladeOpacity(IDLE_RPM)).toBe(1);
    expect(blurOpacity(IDLE_RPM)).toBe(0);
    expect(bladeOpacity(1)).toBeLessThan(0.2);
    expect(blurOpacity(1)).toBeGreaterThan(0.6);
    let blades = 2;
    let blur = -1;
    for (let rpm = 0; rpm <= 1.0001; rpm += 0.05) {
      expect(bladeOpacity(rpm)).toBeLessThanOrEqual(blades);
      expect(blurOpacity(rpm)).toBeGreaterThanOrEqual(blur);
      blades = bladeOpacity(rpm);
      blur = blurOpacity(rpm);
    }
  });
});

describe('glow and exhaust response', () => {
  it('drive follows the throttle with an idle floor that dies with the flame', () => {
    expect(driveLevel(0, 1)).toBeCloseTo(IDLE_RPM);
    expect(driveLevel(0, 0)).toBe(0);
    expect(driveLevel(1, 1)).toBe(1);
    expect(driveLevel(1, 0)).toBe(1);
    expect(driveLevel(0.6, 1)).toBeCloseTo(0.64);
    expect(driveLevel(0.3, 0)).toBeCloseTo(0.3);
  });

  it('glow is dark when off, dim at idle, above the bloom threshold from hover up', () => {
    const idle = glowIntensity(driveLevel(0.05, 1));
    const hover = glowIntensity(driveLevel(0.6, 1));
    const full = glowIntensity(1);
    expect(glowIntensity(0)).toBe(0);
    expect(idle).toBeGreaterThan(0.2);
    expect(idle).toBeLessThan(1);
    expect(hover).toBeGreaterThan(2);
    expect(full).toBeGreaterThan(hover * 1.5);
    expect(glowWhiteness(driveLevel(0.05, 1))).toBe(0);
    expect(glowWhiteness(1)).toBeGreaterThan(glowWhiteness(0.64));
    expect(coreIntensity(0.64)).toBe(0);
    expect(coreIntensity(1)).toBeGreaterThan(4);
  });

  it('compresses HDR glow without changing its order when there is no bloom', () => {
    const values = [0, 0.5, 3.4, 6, 9].map(compressGlow);
    expect(values[0]).toBe(0);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(values[values.length - 1]).toBeLessThan(1.6);
  });

  it('plume runs from 20 m at idle to 110 m at full power and vanishes when shut down', () => {
    expect(plumeLength(0)).toBe(0);
    expect(plumeLength(IDLE_RPM)).toBeCloseTo(20);
    expect(plumeLength(1)).toBeCloseTo(110);
    expect(plumeLength(0.05)).toBeCloseTo(10);
    expect(exhaustSpeed(1)).toBeGreaterThan(exhaustSpeed(0.1));
  });

  it('exhaust is at full brightness at night and turned down, not off, by day', () => {
    expect(exhaustExposure(0)).toBe(1);
    expect(exhaustExposure(1)).toBeLessThan(0.7);
    expect(exhaustExposure(1)).toBeGreaterThan(0.3);
    expect(exhaustExposure(0.5)).toBeLessThan(exhaustExposure(0.2));
    expect(exhaustExposure(2)).toBe(exhaustExposure(1));
    expect(exhaustExposure(-1)).toBe(1);
  });

  it('spray grows with strength and its particle count with the quality budget', () => {
    expect(sprayRadius(1)).toBeGreaterThan(sprayRadius(0.2));
    expect(sprayParticleCount(2500)).toBeGreaterThan(sprayParticleCount(500));
    expect(sprayParticleCount(0)).toBeGreaterThan(0);
  });
});

describe('carrierToNacelle', () => {
  it('maps the thrust axis of a tilted turbine onto nacelle +Y', () => {
    for (const tilt of [-0.35, 0, 0.5, 1.05]) {
      const axis = thrustAxisLocal(tilt, new Vector3());
      const local = carrierToNacelle(axis, tilt, new Vector3());
      expect(local.x).toBeCloseTo(0);
      expect(local.y).toBeCloseTo(1);
      expect(local.z).toBeCloseTo(0);
    }
  });

  it('sees forward flight as airflow from the intake side of a forward-tilted nacelle', () => {
    // ship flying toward the bow (-Z) with the nacelle tilted 60° forward
    const v = carrierToNacelle({ x: 3, y: 0, z: -40 }, Math.PI / 3, new Vector3());
    expect(v.x).toBe(3);
    expect(v.y).toBeCloseTo(40 * Math.sin(Math.PI / 3));
    expect(v.z).toBeCloseTo(-40 * Math.cos(Math.PI / 3));
    expect(v.length()).toBeCloseTo(Math.hypot(3, 40));
  });
});
