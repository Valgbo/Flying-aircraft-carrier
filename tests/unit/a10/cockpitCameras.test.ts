/**
 * The outside views (src/a10/view/cockpit/outsideViews.ts): chase behind and above, fly-by ahead
 * of the flight path and re-placed once passed, orbit around the aircraft, the weapon camera on
 * the newest store in flight (else chase), and the camera at the last vehicle hit or attacked.
 */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { quaternionFromAttitude } from '../../../src/a10/core/frames';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import type { StoreBody } from '../../../src/a10/core/weapons/types';
import type { Vehicle } from '../../../src/a10/core/targets/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import {
  OUTSIDE,
  OutsideCameras,
  type CameraPose,
  type OutsideInput,
} from '../../../src/a10/view/cockpit/outsideViews';

const ground = () => 0;
const input = (patch: Partial<OutsideInput> = {}): OutsideInput => ({
  dt: 1 / 60,
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
