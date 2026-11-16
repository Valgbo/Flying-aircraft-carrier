import { describe, expect, it } from 'vitest';
import { A10 } from '../../../src/a10/data/aircraft';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import {
  planformPaths,
  PLANFORM_BOUNDS,
  polygonArea,
  smoothClosedPath,
  wingPolygon,
} from '../../../src/a10/ui/planform';

describe('the loadout schematic is drawn to scale', () => {
  it('span and length match the aircraft data', () => {
    expect(PLANFORM_BOUNDS.maxX - PLANFORM_BOUNDS.minX).toBeCloseTo(A10.span, 6);
    expect(PLANFORM_BOUNDS.maxY - PLANFORM_BOUNDS.minY).toBeCloseTo(A10.length, 6);
  });

  it('the wing has the published area within 3 %', () => {
    const area = polygonArea(wingPolygon());
    expect(Math.abs(area - A10.wingArea) / A10.wingArea).toBeLessThan(0.03);
  });

  it('every station sits under the wing or the fuselage, left to right', () => {
    const xs = A10_GEOMETRY.stations.slice(1).map((s) => s!.x);
    expect(xs).toHaveLength(11);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    for (const x of xs) expect(Math.abs(x)).toBeLessThan(A10.span / 2);
  });

  it('produces closed, finite paths', () => {
    const p = planformPaths();
    for (const d of [p.wing, p.fuselage, p.tailplane, p.nacelles, p.gearPods, p.fins, p.gun]) {
      expect(d.startsWith('M')).toBe(true);
      expect(d).not.toMatch(/NaN|Infinity/);
    }
    expect(
      smoothClosedPath([
        [0, 0],
        [1, 0],
        [1, 1],
      ]).endsWith('Z'),
    ).toBe(true);
  });
});
