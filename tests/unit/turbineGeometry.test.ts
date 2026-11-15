import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { buildParticleGeometry, buildPlumeGeometry } from '../../src/carrier/turbine/exhaust';
import {
  buildBladeGeometry,
  buildBlurDiscGeometry,
  buildDecalGeometry,
  buildGlowGeometry,
  buildNacelleGeometry,
  buildRotorGeometry,
} from '../../src/carrier/turbine/geometry';
import {
  DUCT_HALF_HEIGHT,
  sprayParticleCount,
  turbineDetail,
} from '../../src/carrier/turbine/model';
import { TURBINE } from '../../src/config/layout';
import { QUALITY_PRESETS } from '../../src/config/quality';

function triangles(geometry: BufferGeometry): number {
  const count = geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
  return count / 3;
}

function trianglesPerTurbine(level: 'low' | 'medium' | 'high'): number {
  const preset = QUALITY_PRESETS[level];
  const d = turbineDetail(preset.detail);
  const solid = [
    buildNacelleGeometry(d),
    buildRotorGeometry(d),
    buildBladeGeometry(d),
    buildGlowGeometry(d),
    buildBlurDiscGeometry(d),
    buildDecalGeometry(0, d),
    buildPlumeGeometry(d),
  ];
  const quads = preset.exhaustParticles + sprayParticleCount(preset.exhaustParticles);
  return solid.reduce((sum, g) => sum + triangles(g), 0) + quads * 2;
}

describe('turbine geometry', () => {
  it('keeps four turbines within the triangle budget and scales down with quality', () => {
    const high = 4 * trianglesPerTurbine('high');
    const medium = 4 * trianglesPerTurbine('medium');
    const low = 4 * trianglesPerTurbine('low');
    expect(high).toBeLessThan(80000);
    expect(medium).toBeLessThan(high);
    expect(low).toBeLessThan(medium * 0.6);
  });

  it('builds a nacelle that spans the duct and reaches the pylon cap but not beyond it', () => {
    const nacelle = buildNacelleGeometry(turbineDetail(2));
    const box = nacelle.boundingBox;
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.max.y).toBeCloseTo(DUCT_HALF_HEIGHT, 3);
    // the tail cone pokes out below the nozzle exit plane
    expect(box.min.y).toBeLessThan(-DUCT_HALF_HEIGHT);
    expect(box.min.y).toBeGreaterThan(-DUCT_HALF_HEIGHT - 4);
    // the stub axles enter the bearing cap, whose face sits at the duct's outer radius
    expect(box.max.x).toBeGreaterThanOrEqual(TURBINE.ductOuterRadius);
    expect(box.max.x).toBeLessThan(TURBINE.ductOuterRadius + 1.5);
    expect(box.min.x).toBeCloseTo(-box.max.x, 3);
    expect(Math.abs(box.max.z)).toBeLessThanOrEqual(TURBINE.ductOuterRadius + 1e-3);
  });

  it('keeps the fan inside the throat', () => {
    const blades = buildBladeGeometry(turbineDetail(2));
    const pos = blades.getAttribute('position');
    let reach = 0;
    for (let i = 0; i < pos.count; i++) {
      reach = Math.max(reach, Math.hypot(pos.getX(i), pos.getZ(i)));
    }
    expect(reach).toBeCloseTo(TURBINE.fanRadius, 1);
  });

  it('puts the number decal on the outboard side of each turbine', () => {
    for (const index of [0, 1, 2, 3]) {
      const decal = buildDecalGeometry(index, turbineDetail(2));
      const pos = decal.getAttribute('position');
      const outboard = index % 2 === 0 ? -1 : 1;
      for (let i = 0; i < pos.count; i++) expect(Math.sign(pos.getX(i))).toBe(outboard);
    }
  });

  it('gives every particle four seeds', () => {
    const particles = buildParticleGeometry(500, 1);
    expect(particles.instanceCount).toBe(500);
    expect(particles.getAttribute('aSeed').count).toBe(500);
  });
});
