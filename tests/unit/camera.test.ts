import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  DECK,
  HULL,
  ISLAND,
  LANDING_STRIP,
  TURBINE,
  TURBINE_MOUNTS,
} from '../../src/config/layout';
import {
  blendPose,
  easeInOutCubic,
  makeSpring,
  portraitFit,
  sphericalOffset,
  springAngleTo,
  springTo,
  yawBehind,
} from '../../src/scene/camera/cameraMath';
import {
  BRIDGE_VIEW,
  CHASE,
  DECK_VIEW,
  HANGAR,
  HOTSPOT_FRAMING,
  TURBINE_VIEW,
  turbineView,
} from '../../src/scene/camera/framing';
import { decayTrauma, shakeNoise, smoothNoise, traumaLevel } from '../../src/scene/camera/noise';
import {
  SHIP_BOXES,
  SHIP_CLEARANCE,
  clearOrbitDistance,
  pushOutOfShip,
} from '../../src/scene/camera/shipVolumes';
import { isExteriorView, resolveView, sharesOrbit } from '../../src/scene/camera/views';

const DEG = Math.PI / 180;

function insideAnyBox(p: Vector3, margin: number): boolean {
  return SHIP_BOXES.some(
    (b) =>
      p.x > b.minX - margin &&
      p.x < b.maxX + margin &&
      p.y > b.minY - margin &&
      p.y < b.maxY + margin &&
      p.z > b.minZ - margin &&
      p.z < b.maxZ + margin,
  );
}

describe('sphericalOffset', () => {
  it('follows the documented yaw / pitch convention', () => {
    const v = new Vector3();
    sphericalOffset(0, 0, 10, v);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(0);
    expect(v.z).toBeCloseTo(10);
    sphericalOffset(Math.PI / 2, 0, 10, v);
    expect(v.x).toBeCloseTo(10);
    expect(v.z).toBeCloseTo(0);
    sphericalOffset(0.3, Math.PI / 6, 10, v);
    expect(v.y).toBeCloseTo(5);
    sphericalOffset(1.1, -0.4, 10, v);
    expect(v.y).toBeLessThan(0);
  });

  it('keeps the requested distance at any angle', () => {
    const v = new Vector3();
    for (let yaw = -4; yaw <= 4; yaw += 0.7) {
      for (let pitch = -1.4; pitch <= 1.4; pitch += 0.35) {
        expect(sphericalOffset(yaw, pitch, 480, v).length()).toBeCloseTo(480, 6);
      }
    }
  });
});

describe('yawBehind', () => {
  it('puts the camera astern of the ship for any heading', () => {
    const offset = new Vector3();
    for (const [fx, fz] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
      [0.6, -0.8],
    ]) {
      sphericalOffset(yawBehind(fx, fz), 0, 1, offset);
      expect(offset.x).toBeCloseTo(-fx);
      expect(offset.z).toBeCloseTo(-fz);
    }
  });
});

describe('springTo (critically damped)', () => {
  it('converges on the target without overshoot from rest', () => {
    const s = makeSpring(0);
    let max = 0;
    for (let i = 0; i < 600; i++) {
      springTo(s, 10, 0.5, 1 / 60);
      max = Math.max(max, s.value);
    }
    expect(max).toBeLessThanOrEqual(10 + 1e-9);
    expect(s.value).toBeCloseTo(10, 4);
    expect(s.velocity).toBeCloseTo(0, 3);
  });

  it('is frame-rate independent', () => {
    const fine = makeSpring(0);
    const coarse = makeSpring(0);
    for (let i = 0; i < 120; i++) springTo(fine, 5, 0.6, 1 / 120);
    for (let i = 0; i < 10; i++) springTo(coarse, 5, 0.6, 1 / 10);
    expect(coarse.value).toBeCloseTo(fine.value, 6);
    expect(coarse.velocity).toBeCloseTo(fine.velocity, 6);
  });

  it('stays stable for huge steps and does nothing for dt = 0', () => {
    const s = makeSpring(3);
    s.velocity = 40;
    expect(springTo(s, -7, 0.4, 0)).toBe(3);
    expect(s.velocity).toBe(40);
    springTo(s, -7, 0.4, 30);
    expect(s.value).toBeCloseTo(-7, 6);
    expect(Number.isFinite(s.velocity)).toBe(true);
  });

  it('starts gently: the first step from rest is small (ease-in)', () => {
    const s = makeSpring(0);
    springTo(s, 1, 0.6, 1 / 60);
    expect(s.value).toBeGreaterThan(0);
    expect(s.value).toBeLessThan(0.01);
  });

  it('snaps when the smoothing time is zero', () => {
    const s = makeSpring(1);
    s.velocity = 5;
    expect(springTo(s, 9, 0, 0.016)).toBe(9);
    expect(s.velocity).toBe(0);
  });
});

describe('springAngleTo', () => {
  it('takes the short way round the circle', () => {
    const s = makeSpring(170 * DEG);
    let previous = s.value;
    for (let i = 0; i < 400; i++) {
      springAngleTo(s, -170 * DEG, 0.4, 1 / 60);
      expect(s.value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = s.value;
    }
    // 190° is the same direction as -170°
    expect(s.value).toBeCloseTo(190 * DEG, 3);
  });
});

describe('easeInOutCubic', () => {
  it('is clamped, symmetric and monotonic', () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(2)).toBe(1);
    let previous = 0;
    for (let t = 0; t <= 1; t += 0.02) {
      const e = easeInOutCubic(t);
      expect(e).toBeGreaterThanOrEqual(previous);
      expect(e + easeInOutCubic(1 - t)).toBeCloseTo(1);
      previous = e;
    }
  });
});

describe('blendPose', () => {
  const fromP = new Vector3(0, 0, 0);
  const toP = new Vector3(10, 20, -30);
  const fromQ = new Quaternion();
  const toQ = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 120 * DEG);

  it('returns the end poses at t = 0 and t = 1', () => {
    const p = new Vector3();
    const q = new Quaternion();
    blendPose(fromP, fromQ, toP, toQ, 0, p, q);
    expect(p.distanceTo(fromP)).toBeCloseTo(0);
    expect(q.angleTo(fromQ)).toBeCloseTo(0);
    blendPose(fromP, fromQ, toP, toQ, 1, p, q);
    expect(p.distanceTo(toP)).toBeCloseTo(0);
    expect(q.angleTo(toQ)).toBeCloseTo(0);
  });

  it('slerps: halfway is half the angle, and stays a unit quaternion', () => {
    const p = new Vector3();
    const q = new Quaternion();
    blendPose(fromP, fromQ, toP, toQ, 0.5, p, q);
    expect(p.x).toBeCloseTo(5);
    expect(q.angleTo(fromQ)).toBeCloseTo(60 * DEG);
    expect(q.length()).toBeCloseTo(1);
  });

  it('may write into its `to` arguments', () => {
    const p = toP.clone();
    const q = toQ.clone();
    blendPose(fromP, fromQ, p, q, 0.25, p, q);
    expect(p.y).toBeCloseTo(5);
    expect(q.angleTo(fromQ)).toBeCloseTo(30 * DEG);
  });
});

describe('portraitFit', () => {
  it('leaves wide screens alone and backs off on narrow ones', () => {
    expect(portraitFit(16 / 9)).toBe(1);
    expect(portraitFit(1.3)).toBe(1);
    expect(portraitFit(9 / 16)).toBeGreaterThan(2);
    expect(portraitFit(0.1)).toBe(2.4);
    expect(portraitFit(0)).toBe(1);
  });
});

describe('shake noise and trauma', () => {
  it('is deterministic, bounded and continuous', () => {
    expect(smoothNoise(12.34, 3)).toBe(smoothNoise(12.34, 3));
    let previous = shakeNoise(0, 1);
    for (let x = 0; x < 40; x += 0.001) {
      const v = shakeNoise(x, 1);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(v - previous)).toBeLessThan(0.02);
      previous = v;
    }
  });

  it('varies over time and differs between channels', () => {
    let min = Infinity;
    let max = -Infinity;
    let differs = false;
    for (let x = 0; x < 200; x += 0.37) {
      const v = smoothNoise(x, 5);
      min = Math.min(min, v);
      max = Math.max(max, v);
      if (Math.abs(v - smoothNoise(x, 6)) > 0.2) differs = true;
    }
    expect(min).toBeLessThan(-0.5);
    expect(max).toBeGreaterThan(0.5);
    expect(differs).toBe(true);
  });

  it('decays linearly to zero and responds quadratically', () => {
    expect(decayTrauma(1, 1.5, 0.2)).toBeCloseTo(0.7);
    expect(decayTrauma(0.1, 1.5, 1)).toBe(0);
    expect(decayTrauma(0.6, 1.5, 0)).toBe(0.6);
    expect(traumaLevel(0.5)).toBeCloseTo(0.25);
    expect(traumaLevel(1.5)).toBe(1);
    expect(traumaLevel(-1)).toBe(0);
  });
});

describe('ship keep-out volumes', () => {
  it('cover the hull, the island and every duct', () => {
    expect(insideAnyBox(new Vector3(0, 0, 0), 0)).toBe(true);
    expect(insideAnyBox(new Vector3(0, HULL.keelY + 1, HULL.length / 2 - 1), 0)).toBe(true);
    expect(
      insideAnyBox(new Vector3(ISLAND.centerX, DECK.y + ISLAND.height, ISLAND.centerZ), 0),
    ).toBe(true);
    for (const m of TURBINE_MOUNTS) {
      expect(insideAnyBox(new Vector3(m[0], m[1], m[2]), 0)).toBe(true);
      expect(insideAnyBox(new Vector3(m[0], m[1], m[2] + TURBINE.ductOuterRadius - 1), 0)).toBe(
        true,
      );
    }
    expect(insideAnyBox(new Vector3(0, DECK.y + 20, -100), 0)).toBe(false);
  });

  it('clearOrbitDistance leaves a clear camera alone', () => {
    const d = clearOrbitDistance(new Vector3(0, 4, 0), new Vector3(1, 0, 0), 430);
    expect(d).toBe(430);
  });

  it('clearOrbitDistance pushes a camera out of the ship along its line of sight', () => {
    const origin = new Vector3(0, 4, 0);
    const dirs = [
      new Vector3(0, 0, 1),
      new Vector3(0, 0, -1),
      new Vector3(1, 0, 0),
      new Vector3(0.6, 0.2, -0.77).normalize(),
      new Vector3(-0.57, 0, 0.82).normalize(),
      new Vector3(0.3, 0.9, 0.3).normalize(),
    ];
    for (const dir of dirs) {
      const d = clearOrbitDistance(origin, dir, HANGAR.minDistance);
      expect(d).toBeGreaterThanOrEqual(HANGAR.minDistance);
      const p = origin.clone().addScaledVector(dir, d);
      expect(insideAnyBox(p, SHIP_CLEARANCE - 1e-6)).toBe(false);
    }
    // along the keel line the minimum orbit distance is inside the hull: pushed past the stern
    expect(clearOrbitDistance(origin, new Vector3(0, 0, 1), 110)).toBeCloseTo(
      HULL.length / 2 + SHIP_CLEARANCE,
    );
  });

  it('pushOutOfShip moves interior points to the surface and leaves exterior ones', () => {
    const outside = new Vector3(200, 50, 0);
    expect(pushOutOfShip(outside)).toBe(false);
    expect(outside.x).toBe(200);

    const inside = new Vector3(5, DECK.y - 3, 20);
    expect(pushOutOfShip(inside)).toBe(true);
    expect(insideAnyBox(inside, SHIP_CLEARANCE - 1e-6)).toBe(false);
    // the nearest way out of the deck is up
    expect(inside.y).toBeCloseTo(DECK.y + SHIP_CLEARANCE);

    const inDuct = new Vector3(
      TURBINE_MOUNTS[1][0] + 15,
      TURBINE_MOUNTS[1][1],
      TURBINE_MOUNTS[1][2],
    );
    expect(pushOutOfShip(inDuct)).toBe(true);
    expect(insideAnyBox(inDuct, SHIP_CLEARANCE - 1e-6)).toBe(false);
  });
});

describe('view selection', () => {
  it('maps screen + mode to a view', () => {
    expect(resolveView('menu', 'chase')).toBe('menu');
    expect(resolveView('hangar', 'deck')).toBe('hangar');
    expect(resolveView('flight', 'orbit')).toBe('orbit');
    expect(resolveView('ops', 'turbine')).toBe('turbine');
    expect(isExteriorView('chase')).toBe(true);
    expect(isExteriorView('deck')).toBe(false);
    expect(isExteriorView('bridge')).toBe(false);
    expect(sharesOrbit('menu', 'hangar')).toBe(true);
    expect(sharesOrbit('hangar', 'menu')).toBe(true);
    expect(sharesOrbit('chase', 'hangar')).toBe(false);
    expect(sharesOrbit(null, 'menu')).toBe(false);
  });
});

describe('framing derived from the layout', () => {
  it('deck eye stands on the strip centreline near the stern, looking up the strip', () => {
    const [x, y, z] = DECK_VIEW.eye;
    expect(y).toBeCloseTo(DECK.y + 3);
    expect(z).toBeGreaterThan(110);
    expect(z).toBeLessThan(LANDING_STRIP.threshold[2]);
    // on the line threshold → end
    const dx = LANDING_STRIP.end[0] - LANDING_STRIP.threshold[0];
    const dz = LANDING_STRIP.end[2] - LANDING_STRIP.threshold[2];
    const cross = (x - LANDING_STRIP.threshold[0]) * dz - (z - LANDING_STRIP.threshold[2]) * dx;
    expect(cross).toBeCloseTo(0, 6);
    // ship-frame yaw positive = toward port: the strip is angled about 8.8° to port
    expect(DECK_VIEW.yaw / DEG).toBeCloseTo(8.8, 0);
    const lookX = -Math.sin(DECK_VIEW.yaw);
    const lookZ = -Math.cos(DECK_VIEW.yaw);
    expect(lookX * dx + lookZ * dz).toBeCloseTo(Math.hypot(dx, dz), 6);
  });

  it('bridge eye is the layout eye point, looking forward and slightly to port', () => {
    expect(BRIDGE_VIEW.eye).toBe(ISLAND.bridgeEye);
    expect(BRIDGE_VIEW.yaw).toBeGreaterThan(0);
    expect(BRIDGE_VIEW.yaw).toBeLessThan(30 * DEG);
    expect(BRIDGE_VIEW.fov).toBeGreaterThan(50);
    expect(DECK_VIEW.fov).toBeGreaterThan(50);
  });

  it('turbine views sit outboard of and above their turbine, clear of the ship', () => {
    const offset = new Vector3();
    for (let i = 0; i < 4; i++) {
      const m = TURBINE_MOUNTS[i];
      const view = turbineView(i);
      sphericalOffset(view.yaw, view.pitch, TURBINE_VIEW.distance, offset);
      expect(Math.sign(offset.x)).toBe(Math.sign(m[0]));
      expect(Math.sign(offset.z)).toBe(Math.sign(m[2]));
      expect(offset.y).toBeGreaterThan(0);
      const eye = new Vector3(view.focus[0], view.focus[1], view.focus[2]).add(offset);
      expect(insideAnyBox(eye, SHIP_CLEARANCE)).toBe(false);
      expect(view.focus[1]).toBeLessThan(m[1]);
    }
  });

  it('hotspots are framed closer for turbines than for deck features', () => {
    for (let i = 0; i < 4; i++) {
      const f = HOTSPOT_FRAMING[`turbine-${i}` as 'turbine-0'];
      expect(f.distance).toBeLessThan(HOTSPOT_FRAMING.island.distance);
      expect(f.distance).toBeGreaterThanOrEqual(HANGAR.minDistance);
      // seen from the side the turbine is on
      expect(Math.sign(Math.sin(f.yaw))).toBe(Math.sign(TURBINE_MOUNTS[i][0]));
    }
    for (const f of Object.values(HOTSPOT_FRAMING)) {
      expect(f.distance).toBeLessThan(HANGAR.distance);
      expect(f.pitch).toBeGreaterThan(HANGAR.minPitch);
      expect(f.pitch).toBeLessThan(HANGAR.maxPitch);
    }
  });

  it('chase zoom range matches the brief', () => {
    expect(CHASE.minDistance).toBe(250);
    expect(CHASE.maxDistance).toBe(900);
    expect(HANGAR.minDistance).toBe(110);
    expect(HANGAR.maxDistance).toBe(900);
  });
});
