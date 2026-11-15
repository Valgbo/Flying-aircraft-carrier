import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CATAPULTS,
  DECK,
  ELEVATOR,
  HULL,
  ISLAND,
  LANDING_STRIP,
  TURBINE,
  TURBINE_MOUNTS,
  WATERLINE_Y,
} from '../../src/config/layout';
import {
  buildDeckSlabGeometry,
  buildDeckStructureGeometry,
  buildDeckSurfaceGeometry,
  buildElevatorGeometry,
} from '../../src/carrier/hull/deckGeometry';
import {
  arrestorWires,
  deckLightBrightness,
  deckLightLayout,
  deckUv,
  navigationLights,
} from '../../src/carrier/hull/deckLayout';
import {
  ELEVATOR_CYCLE,
  elevatorHeightAt,
  elevatorLoweredFraction,
} from '../../src/carrier/hull/elevator';
import { buildHullGeometry, buildHullShellGeometry } from '../../src/carrier/hull/hullGeometry';
import {
  HULL_TOP_Y,
  LEVEL,
  STRIP,
  deckEdgeX,
  deckOutlineWithNotch,
  hullProfile,
  hullStations,
  pointOnDeck,
  pointOnElevator,
  pylonTipX,
  stripPoint,
} from '../../src/carrier/hull/hullShape';
import { RADAR_PIVOT, buildIslandGeometry } from '../../src/carrier/hull/islandGeometry';
import { BRIDGE_VIEW } from '../../src/scene/camera/framing';

type Tri = [number[], number[], number[]];

function triangles(geometry: BufferGeometry): Tri[] {
  const p = geometry.getAttribute('position');
  const out: Tri[] = [];
  for (let i = 0; i < p.count; i += 3) {
    out.push([
      [p.getX(i), p.getY(i), p.getZ(i)],
      [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)],
      [p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)],
    ]);
  }
  return out;
}

/** Directed edges that have no opposite partner: empty for a closed, consistently wound surface. */
function unmatchedEdges(tris: Tri[]): number {
  const key = (v: number[]): string => v.map((c) => Math.round(c * 1000)).join(',');
  const edges = new Map<string, number>();
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      const k = `${key(t[i])}>${key(t[(i + 1) % 3])}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [k, n] of edges) {
    const [a, b] = k.split('>');
    if ((edges.get(`${b}>${a}`) ?? 0) !== n) bad++;
  }
  return bad;
}

/** Signed volume: positive when the triangles face outward. */
function volume(tris: Tri[]): number {
  let v = 0;
  for (const [a, b, c] of tris) {
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return v;
}

function polygonArea(points: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

describe('elevator schedule', () => {
  it('is flush with the deck at t = 0 and reaches the hangar deck once per cycle', () => {
    expect(elevatorHeightAt(0)).toBe(ELEVATOR.topY);
    const down = ELEVATOR_CYCLE.holdUp + ELEVATOR_CYCLE.travel + ELEVATOR_CYCLE.holdDown / 2;
    expect(elevatorHeightAt(down)).toBe(ELEVATOR.bottomY);
    expect(ELEVATOR_CYCLE.holdUp + 2 * ELEVATOR_CYCLE.travel + ELEVATOR_CYCLE.holdDown).toBe(
      ELEVATOR_CYCLE.period,
    );
  });

  it('is periodic, bounded, continuous and mostly up', () => {
    let up = 0;
    let previous = elevatorHeightAt(0);
    const step = 0.05;
    for (let t = 0; t <= ELEVATOR_CYCLE.period * 2; t += step) {
      const y = elevatorHeightAt(t);
      expect(y).toBeGreaterThanOrEqual(ELEVATOR.bottomY);
      expect(y).toBeLessThanOrEqual(ELEVATOR.topY);
      expect(Math.abs(y - previous)).toBeLessThan(0.3);
      expect(elevatorHeightAt(t + ELEVATOR_CYCLE.period)).toBeCloseTo(y, 6);
      if (y === ELEVATOR.topY) up++;
      previous = y;
    }
    expect(up * step).toBeGreaterThan(ELEVATOR_CYCLE.period * 2 * 0.55);
  });

  it('handles negative and non-finite times', () => {
    expect(elevatorHeightAt(-ELEVATOR_CYCLE.period)).toBe(ELEVATOR.topY);
    expect(elevatorLoweredFraction(-10)).toBeCloseTo(elevatorLoweredFraction(50), 9);
    expect(elevatorHeightAt(Number.NaN)).toBe(ELEVATOR.topY);
  });
});

describe('hull form', () => {
  it('has the layout beam at the waterline, the keel at keelY and meets the deck underside', () => {
    for (const side of [1, -1] as const) {
      const p = hullProfile(side, 20);
      expect(p[LEVEL.waterline][0]).toBeCloseTo((side * HULL.beam) / 2, 9);
      expect(p[LEVEL.waterline][1]).toBe(WATERLINE_Y);
      expect(p[LEVEL.keel][1]).toBe(HULL.keelY);
      expect(p[LEVEL.top][1]).toBe(HULL_TOP_Y);
      expect(Math.abs(p[LEVEL.top][0])).toBeLessThan(Math.abs(deckEdgeX(side, 20)));
    }
  });

  it('never dips below the keel or widens downward, at any station', () => {
    for (const z of hullStations()) {
      for (const side of [1, -1] as const) {
        const p = hullProfile(side, z);
        for (let i = 1; i < p.length; i++) {
          expect(p[i][1]).toBeGreaterThanOrEqual(p[i - 1][1] - 1e-9);
          expect(Math.abs(p[i][0])).toBeGreaterThanOrEqual(Math.abs(p[i - 1][0]) - 1e-9);
        }
        expect(p[0][1]).toBeGreaterThanOrEqual(HULL.keelY);
      }
    }
  });

  it('builds a closed, outward-facing shell spanning the full length', () => {
    const shell = buildHullShellGeometry();
    const tris = triangles(shell);
    expect(unmatchedEdges(tris)).toBe(0);
    expect(volume(tris)).toBeGreaterThan(200_000);
    const box = shell.boundingBox!;
    expect(box.min.z).toBeCloseTo(-HULL.length / 2, 6);
    expect(box.max.z).toBeCloseTo(HULL.length / 2, 6);
    expect(box.min.y).toBeCloseTo(HULL.keelY, 6);
    expect(box.max.y).toBeCloseTo(HULL_TOP_Y, 6);
  });
});

describe('flight deck', () => {
  it('cuts exactly the elevator rectangle out of the outline', () => {
    const notch = (ELEVATOR.maxX - ELEVATOR.minX) * (ELEVATOR.maxZ - ELEVATOR.minZ);
    expect(polygonArea(deckOutlineWithNotch())).toBeCloseTo(polygonArea(DECK.outline) - notch, 6);
  });

  it('puts the whole surface at DECK.y, facing up, covering the outline minus the notch', () => {
    const tris = triangles(buildDeckSurfaceGeometry());
    let area = 0;
    for (const [a, b, c] of tris) {
      for (const v of [a, b, c]) expect(v[1]).toBe(DECK.y);
      const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      expect(ny).toBeGreaterThan(0);
      area += ny / 2;
    }
    expect(area).toBeCloseTo(polygonArea(deckOutlineWithNotch()), 3);
  });

  it('closes the slab together with the surface', () => {
    const tris = [...triangles(buildDeckSurfaceGeometry()), ...triangles(buildDeckSlabGeometry())];
    expect(unmatchedEdges(tris)).toBe(0);
    expect(volume(tris)).toBeCloseTo(polygonArea(deckOutlineWithNotch()) * DECK.thickness, 2);
  });

  it('maps deck coordinates to the texture without mirroring', () => {
    const [u0, v0] = deckUv(0, 0);
    expect(deckUv(10, 0)[0]).toBeGreaterThan(u0); // starboard is to the right
    expect(deckUv(0, -10)[1]).toBeGreaterThan(v0); // the bow is up
    for (const p of DECK.outline) {
      const [u, v] = deckUv(p[0], p[1]);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the elevator platform inside its notch, flush with the deck', () => {
    const geometry = buildElevatorGeometry();
    geometry.computeBoundingBox();
    const b = geometry.boundingBox!;
    expect(b.max.y).toBe(ELEVATOR.topY);
    expect(b.min.x).toBeGreaterThan(ELEVATOR.minX);
    expect(b.max.x).toBeLessThan(ELEVATOR.maxX);
    expect(b.min.z).toBeGreaterThan(ELEVATOR.minZ);
    expect(b.max.z).toBeLessThan(ELEVATOR.maxZ);
  });

  it('lays the arrestor wires across the strip at the layout distances', () => {
    const wires = arrestorWires();
    expect(wires).toHaveLength(LANDING_STRIP.wireDistances.length);
    wires.forEach((w, i) => {
      const dx = w.stbd[0] - w.port[0];
      const dz = w.stbd[2] - w.port[2];
      expect(dx * STRIP.dirX + dz * STRIP.dirZ).toBeCloseTo(0, 9);
      expect(dx).toBeGreaterThan(0);
      const mx = (w.port[0] + w.stbd[0]) / 2 - LANDING_STRIP.threshold[0];
      const mz = (w.port[2] + w.stbd[2]) / 2 - LANDING_STRIP.threshold[2];
      expect(mx * STRIP.dirX + mz * STRIP.dirZ).toBeCloseTo(LANDING_STRIP.wireDistances[i], 9);
      expect(w.port[1]).toBeGreaterThan(DECK.y);
      expect(w.port[1]).toBeLessThan(DECK.y + 0.15);
      expect(pointOnDeck(w.port[0], w.port[2])).toBe(true);
      expect(pointOnDeck(w.stbd[0], w.stbd[2])).toBe(true);
    });
    const end = stripPoint(STRIP.length, 0);
    expect(end[0]).toBeCloseTo(LANDING_STRIP.end[0], 9);
    expect(end[1]).toBeCloseTo(LANDING_STRIP.end[2], 9);
  });

  it('places deck lights on the deck, off the elevator, within the budget', () => {
    for (const count of [60, 140, 220]) {
      const lights = deckLightLayout(count);
      expect(lights.length).toBeLessThanOrEqual(count);
      expect(lights.length).toBeGreaterThan(count * 0.85);
      for (const l of lights) {
        expect(pointOnDeck(l.position[0], l.position[2])).toBe(true);
        expect(pointOnElevator(l.position[0], l.position[2])).toBe(false);
      }
      const catLights = lights.filter((l) =>
        CATAPULTS.some(
          (c) => Math.abs(l.position[0] - c.start[0]) < 2 && l.position[2] < c.start[2],
        ),
      );
      expect(catLights.length).toBeGreaterThanOrEqual(4);
    }
    const nav = navigationLights();
    expect(nav.map((l) => l.color)).toEqual(['red', 'green', 'white']);
    expect(nav[0].position[0]).toBeLessThan(0);
    expect(nav[1].position[0]).toBeGreaterThan(0);
    expect(nav[2].position[2]).toBeGreaterThan(HULL.length / 2 - 2);
  });

  it('brightens the lights as daylight falls', () => {
    expect(deckLightBrightness(0)).toBeGreaterThan(3);
    expect(deckLightBrightness(1)).toBeGreaterThan(1);
    expect(deckLightBrightness(1)).toBeLessThan(1.5);
    for (let d = 0; d < 1; d += 0.05) {
      expect(deckLightBrightness(d)).toBeGreaterThanOrEqual(deckLightBrightness(d + 0.05));
    }
  });
});

describe('clearances and budgets', () => {
  const tipX = pylonTipX(0);
  const parts: [string, BufferGeometry][] = [
    ['hull', buildHullGeometry(2)],
    ['deck', buildDeckStructureGeometry(2)],
    ['island', buildIslandGeometry(2).structure],
  ];

  it('ends every pylon at the inboard edge of its duct', () => {
    TURBINE_MOUNTS.forEach((m, i) => {
      expect(pylonTipX(i)).toBe(Math.abs(m[0]) - TURBINE.ductOuterRadius);
    });
    const box = parts[0][1].boundingBox!;
    expect(box.max.x).toBeCloseTo(tipX, 6);
    expect(box.min.x).toBeCloseTo(-tipX, 6);
  });

  it('keeps everything out of the swept volume of the ducts', () => {
    // the ducts sweep |x| >= tipX; only the bearing caps, on the tilt axes, may touch that plane
    for (const [, geometry] of parts) {
      for (const tri of triangles(geometry)) {
        for (const v of tri) {
          expect(Math.abs(v[0])).toBeLessThanOrEqual(tipX + 1e-6);
          if (Math.abs(v[0]) > tipX - 0.5) {
            const nearAxis = TURBINE_MOUNTS.some(
              (m) =>
                Math.hypot(v[1] - m[1], v[2] - m[2]) < 4 && Math.sign(m[0]) === Math.sign(v[0]),
            );
            expect(nearAxis).toBe(true);
          }
        }
      }
    }
  });

  it('stays inside the hull length and above the keel', () => {
    for (const [, geometry] of parts) {
      const box = geometry.boundingBox!;
      expect(box.min.y).toBeGreaterThanOrEqual(HULL.keelY - 1e-6);
      expect(box.min.z).toBeGreaterThanOrEqual(-HULL.length / 2 - 0.5);
      expect(box.max.z).toBeLessThanOrEqual(HULL.length / 2 + 0.5);
    }
  });

  it('tops the mast at ISLAND.mastHeight and keeps the bridge eye clear', () => {
    const island = buildIslandGeometry(2);
    expect(island.structure.boundingBox!.max.y).toBeLessThanOrEqual(DECK.y + ISLAND.mastHeight);
    expect(island.structure.boundingBox!.max.y).toBeGreaterThan(DECK.y + ISLAND.mastHeight - 1.5);
    expect(RADAR_PIVOT[1]).toBeGreaterThan(ISLAND.bridgeEye[1]);
    const [ex, ey, ez] = ISLAND.bridgeEye;
    for (const geometry of [island.structure, island.glass]) {
      for (const tri of triangles(geometry)) {
        for (const v of tri) {
          expect(Math.hypot(v[0] - ex, v[1] - ey, v[2] - ez)).toBeGreaterThan(1.05);
        }
      }
    }
  });

  it('keeps window posts well clear of the default sight line of the bridge camera', () => {
    const [ex, ey, ez] = ISLAND.bridgeEye;
    // carrier-local direction of the view: yaw turns from the bow (-Z) toward port (-X)
    const sightX = -Math.sin(BRIDGE_VIEW.yaw);
    const sightZ = -Math.cos(BRIDGE_VIEW.yaw);
    for (const detail of [0, 1, 2]) {
      let nearest = Infinity;
      let posts = 0;
      for (const tri of triangles(buildIslandGeometry(detail).structure)) {
        for (let k = 0; k < 3; k++) {
          // where the structure crosses eye height near the eye there are only window posts
          const [ax, ay, az] = tri[k];
          const [bx, by, bz] = tri[(k + 1) % 3];
          if ((ay - ey) * (by - ey) >= 0) continue;
          const t = (ey - ay) / (by - ay);
          const dx = ax + (bx - ax) * t - ex;
          const dz = az + (bz - az) * t - ez;
          const range = Math.hypot(dx, dz);
          const along = dx * sightX + dz * sightZ;
          if (range > 9 || along <= 0) continue;
          posts++;
          nearest = Math.min(nearest, Math.acos(along / range));
        }
      }
      expect(posts).toBeGreaterThan(0);
      // a pane, not a post, fills the middle of the frame: 35° is most of its half-width
      expect(nearest).toBeGreaterThan((35 * Math.PI) / 180);
    }
  });

  it('fits the triangle budget on High and Low', () => {
    const count = (detail: number): number => {
      const island = buildIslandGeometry(detail);
      return (
        triangles(buildHullGeometry(detail)).length +
        triangles(buildDeckStructureGeometry(detail)).length +
        triangles(buildDeckSurfaceGeometry()).length +
        triangles(buildElevatorGeometry()).length +
        triangles(island.structure).length +
        triangles(island.glass).length
      );
    };
    expect(count(2)).toBeLessThan(70_000);
    expect(count(0)).toBeLessThan(30_000);
  });
});
