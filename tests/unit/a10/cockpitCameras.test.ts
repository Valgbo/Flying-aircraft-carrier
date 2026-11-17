/**
 * The outside views (src/a10/view/cockpit/outsideViews.ts): chase behind and above, fly-by ahead
 * of the flight path and re-placed once passed, orbit around the aircraft, the weapon camera on
 * the newest store in flight (else chase), and the camera at the last vehicle hit or attacked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { quaternionFromAttitude } from '../../../src/a10/core/frames';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import type { StoreBody } from '../../../src/a10/core/weapons/types';
import type { Vehicle } from '../../../src/a10/core/targets/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { frameInfo } from '../../../src/a10/view/frame';
import {
  OUTSIDE,
  OutsideCameras,
  type CameraPose,
  type OutsideInput,
} from '../../../src/a10/view/cockpit/outsideViews';

// These tests place the aircraft directly, without simulation steps: draw the current state
// (alpha = 1; the interpolation between steps is tested in cockpitInterpolation.test.ts).
beforeEach(() => {
  frameInfo.alpha = 1;
});
afterEach(() => {
  frameInfo.alpha = 0;
});

const ground = () => 0;
/** A frame of a running simulation: simulated time advances with the real time (unless patched). */
const input = (patch: Partial<OutsideInput> = {}): OutsideInput => ({
  dt: patch.dt ?? 1 / 60,
  simDt: patch.dt ?? 1 / 60,
  lookDX: 0,
  lookDY: 0,
  lookRateX: 0,
  lookRateY: 0,
  zoomSteps: 0,
  ...patch,
});
const pose = (): CameraPose => ({ position: new Vector3(), quaternion: new Quaternion(), fov: 50 });

function sim(): Sim {
  const s = createSim({
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    seed: 5,
    start: { x: 0, z: 0, agl: 1500, heading: 0, speed: 130 },
  });
  // heading north, level, 130 m/s
  quaternionFromAttitude(0, 0, 0, s.aircraft.orientation);
  s.aircraft.heading = 0;
  s.aircraft.position.set(0, 1500, 0);
  s.aircraft.velocity.set(0, 0, -130);
  return s;
}

function forward(q: Quaternion): Vector3 {
  return new Vector3(0, 0, -1).applyQuaternion(q);
}

function vehicle(id: number, x: number, z: number): Vehicle {
  return {
    id,
    kind: 'mbt',
    position: new Vector3(x, 0, z),
    heading: 0,
    speed: 0,
    turretYaw: 0,
    pitch: 0,
    roll: 0,
    condition: 'intact',
    mobilityKill: false,
    firepowerKill: false,
    fire: 0,
    engineOn: true,
    heat: { engine: 0, exhaust: 0, running: 0, hull: 0 },
    components: {
      engine: 1,
      fuel: 1,
      ammo: 1,
      gun: 1,
      runningGear: 1,
      optics: 1,
      crew: 1,
      cargo: 1,
    },
    groupId: 0,
    conditionTime: 0,
    thrownTurret: null,
  } as unknown as Vehicle;
}

describe('chase', () => {
  it('sits behind and above the aircraft and looks at it', () => {
    const s = sim();
    const cam = new OutsideCameras();
    const p = pose();
    expect(cam.update('chase', s, input(), ground, p)).toBe('chase');
    expect(p.position.z).toBeCloseTo(OUTSIDE.chase.back, 3); // behind = south = +z
    expect(p.position.y).toBeGreaterThan(1500);
    const toAc = new Vector3().subVectors(s.aircraft.position, p.position).normalize();
    expect(forward(p.quaternion).dot(toAc)).toBeGreaterThan(0.98);
  });

  it('follows a turn through a lag, never behind in position', () => {
    const s = sim();
    const cam = new OutsideCameras();
    const p = pose();
    cam.update('chase', s, input(), ground, p);
    quaternionFromAttitude(Math.PI / 2, 0, 0, s.aircraft.orientation); // now heading east
    s.aircraft.position.set(500, 1500, 0);
    cam.update('chase', s, input({ dt: 1 / 60 }), ground, p);
    // still mostly south of the aircraft (the old frame) after one frame…
    expect(p.position.z - s.aircraft.position.z).toBeGreaterThan(10);
    for (let i = 0; i < 300; i++) cam.update('chase', s, input(), ground, p);
    // …and west of it (behind, heading east) once the lag has caught up
    expect(s.aircraft.position.x - p.position.x).toBeCloseTo(OUTSIDE.chase.back, 1);
    expect(p.position.distanceTo(s.aircraft.position)).toBeLessThan(25);
  });
});

describe('fly-by', () => {
  it('waits ahead of the flight path and is re-placed once passed', () => {
    const s = sim();
    const cam = new OutsideCameras();
    const p = pose();
    cam.update('flyby', s, input(), ground, p);
    const first = p.position.clone();
    expect(first.z).toBeLessThan(-400); // ahead (north)
    // fly past it
    for (let t = 0; t < 8; t += 1 / 30) {
      s.aircraft.position.z -= 130 / 30;
      cam.update('flyby', s, input({ dt: 1 / 30 }), ground, p);
      const toAc = new Vector3().subVectors(s.aircraft.position, p.position).normalize();
      expect(forward(p.quaternion).dot(toAc)).toBeGreaterThan(0.99);
    }
    expect(p.position.z).toBeLessThan(first.z - 300);
    expect(p.fov).toBeGreaterThanOrEqual(8);
    expect(p.fov).toBeLessThanOrEqual(OUTSIDE.flyby.fov);
  });
});

describe('orbit', () => {
  it('drags around the aircraft and zooms its distance', () => {
    const s = sim();
    const cam = new OutsideCameras();
    const p = pose();
    cam.update('orbit', s, input(), ground, p);
    const d0 = p.position.distanceTo(s.aircraft.position);
    expect(d0).toBeCloseTo(OUTSIDE.orbit.distance, 3);
    cam.update('orbit', s, input({ lookDX: Math.PI / 2 / OUTSIDE.orbit.radPerPx }), ground, p);
    // a quarter turn: from behind (south) to the side
    expect(Math.abs(p.position.x - s.aircraft.position.x)).toBeGreaterThan(20);
    cam.update('orbit', s, input({ zoomSteps: 3 }), ground, p);
    expect(p.position.distanceTo(s.aircraft.position)).toBeLessThan(d0);
    const toAc = new Vector3().subVectors(s.aircraft.position, p.position).normalize();
    expect(forward(p.quaternion).dot(toAc)).toBeGreaterThan(0.999);
  });
});

describe('weapon camera', () => {
  it('follows the newest store in flight, watches its impact, then falls back to chase', () => {
    const s = sim();
    const cam = new OutsideCameras();
    const p = pose();
    expect(cam.update('weapon', s, input(), ground, p)).toBe('chase');
    const body = {
      id: 7,
      type: 'MK-82',
      kind: 'bomb',
      alive: true,
      station: 4,
      releaseTime: 0,
      position: new Vector3(0, 1400, -200),
      velocity: new Vector3(0, -20, -120),
      orientation: new Quaternion(),
      motorTime: 0,
      armed: true,
      data: {},
    } as StoreBody;
    s.projectiles.bodies.push(body);
    expect(cam.update('weapon', s, input(), ground, p)).toBe('weapon');
    const toBody = new Vector3().subVectors(body.position, p.position);
    expect(toBody.length()).toBeLessThan(15);
    expect(toBody.dot(body.velocity)).toBeGreaterThan(0); // behind it
    body.alive = false;
    expect(cam.update('weapon', s, input({ dt: 1 }), ground, p)).toBe('weapon');
    expect(cam.update('weapon', s, input({ dt: 3 }), ground, p)).toBe('weapon');
    expect(cam.update('weapon', s, input({ dt: 1 }), ground, p)).toBe('chase');
  });
});

describe('target camera', () => {
  it('stands near the vehicle last hit and looks toward the aircraft', () => {
    const s = sim();
    s.targets.vehicles.push(vehicle(3, 100, -3000), vehicle(4, -900, -2500));
    const cam = new OutsideCameras();
    const p = pose();
    cam.noteEvents(
      [
        {
          type: 'roundImpact',
          t: 1,
          round: 0,
          position: { x: -900, y: 0, z: -2500 },
          velocity: { x: 0, y: -100, z: -900 },
          normal: { x: 0, y: 1, z: 0 },
          target: { kind: 'vehicle', vehicleId: 4, part: 'hull' },
          outcome: 'penetrated',
        } as never,
      ],
      s,
    );
    expect(cam.targetVehicle).toBe(4);
    expect(cam.update('target', s, input(), ground, p)).toBe('target');
    const v = s.targets.vehicles[1].position;
    expect(p.position.distanceTo(v)).toBeLessThan(40);
    expect(p.position.y).toBeGreaterThanOrEqual(OUTSIDE.groundClearance);
    const toAc = new Vector3().subVectors(s.aircraft.position, p.position).normalize();
    expect(forward(p.quaternion).dot(toAc)).toBeGreaterThan(0.9);
    // the camera is on the far side of the vehicle from the aircraft
    expect(p.position.distanceTo(s.aircraft.position)).toBeGreaterThan(
      v.distanceTo(s.aircraft.position),
    );
  });

  it('takes the vehicle a burst was aimed at, and falls back to chase with no vehicles', () => {
    const s = sim();
    const cam = new OutsideCameras();
    const p = pose();
    expect(cam.update('target', s, input(), ground, p)).toBe('chase');
    s.targets.vehicles.push(vehicle(9, 50, -1200));
    s.avionics.gun.valid = true;
    s.avionics.gun.impact.set(60, 0, -1180);
    cam.noteEvents([{ type: 'gunStart', t: 2 }], s);
    expect(cam.targetVehicle).toBe(9);
    expect(cam.update('target', s, input(), ground, p)).toBe('target');
  });
});

describe('ground', () => {
  it('never puts an outside camera under the ground', () => {
    const s = sim();
    s.aircraft.position.set(0, 3, 0);
    const cam = new OutsideCameras();
    const p = pose();
    cam.update('orbit', s, input({ lookDY: 1e4 }), () => 50, p);
    expect(p.position.y).toBeGreaterThanOrEqual(50 + OUTSIDE.groundClearance - 1e-9);
  });
});

describe('weapon camera (wave 2)', () => {
  function body(id: number, pos: Vector3, vel: Vector3): StoreBody {
    return {
      id,
      type: 'MK-82',
      kind: 'bomb',
      alive: true,
      station: 4,
      releaseTime: 0,
      position: pos,
      velocity: vel,
      orientation: new Quaternion(),
      motorTime: 0,
      armed: true,
      data: {},
    } as unknown as StoreBody;
  }

  it('follows the newest store from behind and holds on its detonation point', () => {
    const s = sim();
    const cam = new OutsideCameras();
    const p = pose();
    const first = body(7, new Vector3(0, 1400, -200), new Vector3(0, -20, -120));
    s.projectiles.bodies.push(first);
    expect(cam.update('weapon', s, input(), ground, p)).toBe('weapon');
    expect(cam.weaponId).toBe(7);
    // a second store leaves (a pair or the next pass): the camera takes the newest
    const second = body(8, new Vector3(5, 1450, -100), new Vector3(0, -10, -125));
    s.projectiles.bodies.push(second);
    cam.update('weapon', s, input(), ground, p);
    expect(cam.weaponId).toBe(8);
    const toBody = new Vector3().subVectors(second.position, p.position);
    expect(toBody.length()).toBeLessThan(OUTSIDE.weapon.back + OUTSIDE.weapon.up + 1);
    expect(toBody.dot(second.velocity)).toBeGreaterThan(0);

    // both hit the ground; the newest one's detonation gives the impact point
    const impact = new Vector3(8, 2, -1900);
    cam.noteEvents(
      [
        {
          type: 'detonation',
          t: 20,
          position: { x: impact.x, y: impact.y, z: impact.z },
          charge: 96,
          kind: 'bomb',
          vehicleId: -1,
          surface: 'grass',
          bodyId: 8,
        } as never,
      ],
      s,
    );
    s.projectiles.bodies.length = 0; // removed in the step they detonate (§12.2)
    let shown = cam.update('weapon', s, input({ dt: 0.05 }), ground, p);
    expect(shown).toBe('weapon');
    const look = forward(p.quaternion);
    let toImpact = new Vector3().subVectors(impact, p.position).normalize();
    expect(look.dot(toImpact)).toBeGreaterThan(0.999);
    // it backs off to a vantage point above the impact and keeps watching it
    let t = 0.05;
    while (t < OUTSIDE.weapon.hold - 0.2) {
      shown = cam.update('weapon', s, input({ dt: 0.1 }), ground, p);
      t += 0.1;
      expect(shown).toBe('weapon');
    }
    toImpact = new Vector3().subVectors(impact, p.position);
    expect(forward(p.quaternion).dot(toImpact.clone().normalize())).toBeGreaterThan(0.999);
    const vantage = Math.hypot(OUTSIDE.weapon.holdBack, OUTSIDE.weapon.holdUp);
    expect(toImpact.length()).toBeGreaterThan(0.8 * vantage);
    expect(toImpact.length()).toBeLessThan(1.2 * vantage);
    expect(p.position.y).toBeGreaterThan(impact.y + 0.5 * OUTSIDE.weapon.holdUp);
    // then back to chase
    cam.update('weapon', s, input({ dt: 0.5 }), ground, p);
    expect(cam.update('weapon', s, input({ dt: 0.1 }), ground, p)).toBe('chase');
  });

  it('keeps watching the impact while the simulation is paused, for its simulated seconds', () => {
    const s = sim();
    const cam = new OutsideCameras();
    const p = pose();
    s.projectiles.bodies.push(body(9, new Vector3(0, 300, -200), new Vector3(0, -60, -150)));
    expect(cam.update('weapon', s, input(), ground, p)).toBe('weapon');
    s.projectiles.bodies.length = 0; // it detonated
    // paused: real frames go by, simulated time does not — the camera stays on the impact
    for (let i = 0; i < 300; i++)
      expect(cam.update('weapon', s, input({ dt: 0.1, simDt: 0 }), ground, p)).toBe('weapon');
    // running again: `hold` simulated seconds later it is back on the aircraft
    let t = 0;
    while (t < OUTSIDE.weapon.hold - 0.15) {
      expect(cam.update('weapon', s, input({ dt: 0.1, simDt: 0.1 }), ground, p)).toBe('weapon');
      t += 0.1;
    }
    cam.update('weapon', s, input({ dt: 0.1, simDt: 0.2 }), ground, p);
    expect(cam.update('weapon', s, input({ dt: 0.1, simDt: 0.1 }), ground, p)).toBe('chase');
  });
});

describe('target camera (wave 2)', () => {
  it('watches the vehicle under the SPI or the last one attacked, whichever is more recent', () => {
    const s = sim();
    s.targets.vehicles.push(vehicle(3, 100, -3000), vehicle(4, -900, -2500));
    const cam = new OutsideCameras();
    const p = pose();
    // the SPI somewhere empty: nothing under it
    s.avionics.spi.valid = true;
    s.avionics.spi.position.set(3000, 0, -3000);
    s.time = 10;
    cam.noteEvents([], s);
    expect(cam.spiVehicle).toBe(-1);
    // a burst on vehicle 4
    s.time = 11;
    cam.noteEvents(
      [
        {
          type: 'roundImpact',
          t: 11,
          round: 0,
          position: { x: -900, y: 0, z: -2500 },
          velocity: { x: 0, y: -100, z: -900 },
          normal: { x: 0, y: 1, z: 0 },
          target: { kind: 'vehicle', vehicleId: 4, part: 'hull' },
          outcome: 'penetrated',
        } as never,
      ],
      s,
    );
    expect(cam.watchedVehicle()).toBe(4);
    // later the pod puts the SPI on vehicle 3: the camera goes there
    s.time = 15;
    s.avionics.spi.position.set(105, 0, -2995);
    cam.noteEvents([], s);
    expect(cam.spiVehicle).toBe(3);
    expect(cam.watchedVehicle()).toBe(3);
    expect(cam.update('target', s, input(), ground, p)).toBe('target');
    expect(p.position.distanceTo(s.targets.vehicles[0].position)).toBeLessThan(40);
    // then vehicle 4 is attacked again: back to it
    s.time = 20;
    cam.noteEvents(
      [
        {
          type: 'vehicleDamaged',
          t: 20,
          vehicleId: 4,
          vehicleKind: 'mbt',
          condition: 'damaged',
          component: 'engine',
        } as never,
      ],
      s,
    );
    expect(cam.watchedVehicle()).toBe(4);
    cam.update('target', s, input(), ground, p);
    expect(p.position.distanceTo(s.targets.vehicles[1].position)).toBeLessThan(40);
  });
});
