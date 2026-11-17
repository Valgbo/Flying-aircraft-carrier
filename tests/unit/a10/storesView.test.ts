/**
 * Stores in flight (STORES-VIEW module, wave 2; ARCHITECTURE §12.2, §12.7): every store body is
 * drawn with its model from the frame its store leaves the pylon until its detonation; at its pose
 * interpolated between the last two steps; the Mk 82 AIR ballute opens on its copy; a burning motor
 * leaves its flame and smoke trail; a launch makes its cloud. The weapons module is a stand-in
 * during wave 2, so the bodies and events are built here as it will make them.
 */
import { PerspectiveCamera, Quaternion, Vector3, type Group } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { A10Meta } from '../../../src/a10/assets';
import { createPlaceholderTemplates } from '../../../src/a10/assets/placeholders';
import { SIM_DT } from '../../../src/a10/core/constants';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import type { StoreBody, StoreBodyKind, StoreType } from '../../../src/a10/core/weapons/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { acquireFx, releaseFx, updateFx, type Fx } from '../../../src/a10/view/effects/fx';
import { setViewSimSource } from '../../../src/a10/view/effects/simSource';
import { frameInfo } from '../../../src/a10/view/frame';
import { HANDOFF_BLEND } from '../../../src/a10/view/stores/look';
import { bodyDrawPose } from '../../../src/a10/view/stores/presenter';

const metaFiles = import.meta.glob('../../../public/a10/models/a10-meta.json', {
  eager: true,
  import: 'default',
});
const META = Object.values(metaFiles)[0] as A10Meta;
const FRAME = 1 / 60;

let sim: Sim;
let fx: Fx;
const camera = new PerspectiveCamera(50, 1.6, 0.5, 90000);

beforeEach(() => {
  sim = createSim({
    seed: 2,
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    loadoutId: 'rangeTraining',
  });
  sim.aircraft.position.set(0, 1500, 0);
  sim.aircraft.prevPosition.copy(sim.aircraft.position);
  sim.aircraft.velocity.set(0, 0, -150);
  setViewSimSource(() => sim);
  fx = acquireFx();
  fx.stores.templates = createPlaceholderTemplates(META);
  camera.position.set(60, 1520, 40);
  camera.lookAt(0, 1500, 0);
  camera.updateMatrixWorld();
  frameInfo.alpha = 1;
});

afterEach(() => {
  releaseFx();
  setViewSimSource(null);
  frameInfo.alpha = 0;
});

/** A body as the weapons module makes one (contract fields only, §12.2). */
function makeBody(station: number, type: StoreType, kind: StoreBodyKind): StoreBody {
  const fields = {
    id: sim.projectiles.nextBodyId++,
    type,
    kind,
    alive: true,
    station,
    releaseTime: sim.time,
    position: sim.aircraft.position.clone().add(new Vector3(-3.6, -0.9, 0)),
    velocity: sim.aircraft.velocity.clone().add(new Vector3(0, -1.5, 0)),
    orientation: new Quaternion(),
    motorTime: kind === 'rocket' ? 1.07 : kind === 'missile' ? 4 : 0,
    armed: false,
    data: {},
    delivery: kind === 'rocket' ? 'ROCKET' : kind === 'missile' ? 'MAV' : 'CCIP',
    aim: new Vector3(),
    aimValid: false,
    highDrag: false,
    armingTime: 0,
    laserCode: 1688,
    guidance: { mode: 'NONE', vehicleId: -1, point: new Vector3(), valid: false },
    record: -1,
  } satisfies Partial<StoreBody>;
  return fields as unknown as StoreBody;
}

/** One frame as SimDriver and EffectsView run it: steps, events, then the visual update. */
function frame(events: SimEvent[] = [], steps = 2): void {
  for (let k = 0; k < steps; k++) {
    sim.time += SIM_DT;
    sim.aircraft.prevPosition.copy(sim.aircraft.position);
    sim.aircraft.position.addScaledVector(sim.aircraft.velocity, SIM_DT);
    for (const b of sim.projectiles.bodies) {
      if (!b.alive || b.releaseTime > sim.time) continue;
      const v = b.velocity;
      const dt = Math.min(SIM_DT, sim.time - b.releaseTime);
      v.y -= 9.81 * dt;
      b.position.addScaledVector(v, dt);
      if (b.motorTime > 0) b.motorTime = Math.max(0, b.motorTime - dt);
    }
  }
  fx.onSimFrame(events, sim, { steps, alpha: frameInfo.alpha, realDt: FRAME, simDt: steps * SIM_DT });
  updateFx(fx, steps * SIM_DT, camera, 20000);
}

function release(b: StoreBody): SimEvent[] {
  sim.projectiles.bodies.push(b);
  const events: SimEvent[] = [
    { type: 'storeReleased', t: b.releaseTime, station: b.station, store: b.type, bodyId: b.id },
  ];
  if (b.kind === 'rocket' || b.kind === 'missile')
    events.push({ type: 'motorIgnition', t: b.releaseTime, bodyId: b.id });
  return events;
}

function visible(o: Group | null): boolean {
  return !!o && o.visible;
}

describe('stores in flight', () => {
  it('a body appears on its release and disappears on its detonation', () => {
    frame();
    // a Mk-82 leaves station 3 (the weapons module removes it from the station)
    sim.stores.stations[2].stores.shift();
    const b = makeBody(3, 'MK-82', 'bomb');
    frame(release(b));
    expect(fx.stores.count).toBe(1);
    const model = fx.stores.modelOf(b.id);
    expect(visible(model)).toBe(true);
    expect(model!.name).toBe('store-mk82');
    frame();
    expect(visible(fx.stores.modelOf(b.id))).toBe(true);
    // it bursts: drawn no more from that frame, forgotten when the body is gone
    const det: SimEvent = {
      type: 'detonation',
      t: sim.time,
      position: { x: b.position.x, y: 0, z: b.position.z },
      charge: 96,
      kind: 'bomb',
      vehicleId: 0,
      surface: 'dirt',
      bodyId: b.id,
    };
    b.alive = false;
    sim.projectiles.bodies.length = 0;
    frame([det]);
    expect(fx.stores.count).toBe(0);
    expect(model!.visible).toBe(false);
  });

  it('a body still in the air when its detonation arrives is hidden at once', () => {
    frame();
    const b = makeBody(5, 'MK-82', 'bomb');
    frame(release(b));
    const model = fx.stores.modelOf(b.id)!;
    expect(model.visible).toBe(true);
    // the event arrives in the step the weapons module still lists the body (removed next step)
    fx.onSimFrame(
      [
        {
          type: 'detonation',
          t: sim.time,
          position: { x: 0, y: 0, z: 0 },
          charge: 96,
          kind: 'bomb',
          vehicleId: 0,
          surface: 'dirt',
          bodyId: b.id,
        },
      ],
      sim,
      { steps: 0, alpha: 1, realDt: FRAME, simDt: 0 },
    );
    updateFx(fx, 0, camera, 20000);
    expect(model.visible).toBe(false);
  });

  it('the Mk 82 AIR ballute shows on its copy when the body turns high drag', () => {
    frame();
    const b = makeBody(4, 'MK-82AIR', 'bomb');
    frame(release(b));
    const model = fx.stores.modelOf(b.id)!;
    const chute = model.getObjectByName('MK-82AIR_Chute')!;
    expect(chute).toBeTruthy();
    expect(chute.visible).toBe(false);
    b.highDrag = true;
    frame();
    expect(chute.visible).toBe(true);
    const early = chute.scale.x;
    for (let i = 0; i < 20; i++) frame();
    // it fills out within a fraction of a second
    expect(chute.scale.x).toBeGreaterThan(early);
    // the template's own ballute stays hidden (only the released copy shows it)
    const tpl = fx.stores.templates!.stores.get('mk82air')!;
    expect(tpl.getObjectByName('MK-82AIR_Chute')!.visible).toBe(false);
    // a low-drag release of the same bomb never shows it
    const ld = makeBody(8, 'MK-82AIR', 'bomb');
    frame(release(ld));
    frame();
    expect(fx.stores.modelOf(ld.id)!.getObjectByName('MK-82AIR_Chute')!.visible).toBe(false);
  });

  it('a rocket burns with a flame and leaves a smoke trail, and stops when the motor burns out', () => {
    frame();
    const before = fx.stores.stats.puffs;
    const b = makeBody(2, 'LAU-131-M156', 'rocket');
    b.velocity.set(0, 0, -450);
    frame(release(b));
    expect(fx.stores.modelOf(b.id)!.name).toBe('store-hydra70');
    // the launch cloud
    const afterLaunch = fx.stores.stats.puffs;
    expect(afterLaunch).toBeGreaterThan(before);
    for (let i = 0; i < 20; i++) frame();
    const trail = fx.stores.stats.puffs - afterLaunch;
    // ≈300 m flown: a puff every 1.4 m near the camera, fewer farther away
    expect(trail).toBeGreaterThan(40);
    b.motorTime = 0;
    const burnt = fx.stores.stats.puffs;
    for (let i = 0; i < 10; i++) frame();
    expect(fx.stores.stats.puffs).toBe(burnt);
  });

  it('a missile launch makes a cloud at its rail and a flame while the motor burns', () => {
    frame();
    const b = makeBody(3, 'AGM-65D', 'missile');
    const live = fx.ps.count;
    frame(release(b));
    expect(fx.ps.count).toBeGreaterThan(live + 5);
    expect(fx.stores.modelOf(b.id)!.name).toBe('store-agm65');
  });

  it('a jettisoned rack is drawn with the stores it still carries', () => {
    frame();
    const st = sim.stores.stations[2];
    st.rack = null;
    st.stores.length = 0;
    const b = makeBody(3, 'TER-9A', 'bomb');
    (b as StoreBody & { carried: StoreType[] }).carried = ['MK-82', 'MK-82'];
    frame(release(b));
    const model = fx.stores.modelOf(b.id)!;
    expect(model.name).toBe('rack-ter9a');
    let bombs = 0;
    model.traverse((o) => {
      if (o.name === 'mk82') bombs++;
    });
    expect(bombs).toBe(2);
  });
});

describe('stores in flight: drawing between steps', () => {
  it('draws a body between prevPosition and position by the frame alpha', () => {
    const b = makeBody(3, 'MK-82', 'bomb') as StoreBody & {
      prevPosition: Vector3;
      prevOrientation: Quaternion;
    };
    b.releaseTime = 10 - 0.5;
    b.prevPosition = new Vector3(0, 1000, 0);
    b.position.set(0, 999, -1.25);
    b.prevOrientation = new Quaternion();
    b.orientation.setFromAxisAngle(new Vector3(1, 0, 0), -0.02);
    const p = new Vector3();
    const q = new Quaternion();
    const simTime = 10;
    expect(bodyDrawPose(b, simTime, simTime - 0.5 * SIM_DT, p, q)).toBe(true);
    expect(p.distanceTo(new Vector3(0, 999.5, -0.625))).toBeLessThan(1e-9);
    expect(q.angleTo(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.01))).toBeLessThan(
      1e-6,
    );
    // without prev* (an older weapons module): back along its velocity
    const c = makeBody(3, 'MK-82', 'bomb');
    c.releaseTime = 9;
    c.position.set(0, 999, 0);
    c.velocity.set(0, -60, -150);
    expect(bodyDrawPose(c, simTime, simTime - 0.25 * SIM_DT, p, q)).toBe(true);
    expect(p.distanceTo(new Vector3(0, 999 + 60 * 0.25 * SIM_DT, 150 * 0.25 * SIM_DT))).toBeLessThan(
      1e-9,
    );
  });

  it('draws nothing before the draw time reaches the release, and starts at the release point', () => {
    const b = makeBody(3, 'MK-82', 'bomb') as StoreBody & {
      prevPosition: Vector3;
      prevOrientation: Quaternion;
    };
    const p = new Vector3();
    const q = new Quaternion();
    // released 3 ms before the end of the last step
    b.releaseTime = 10 - 0.003;
    b.prevPosition = new Vector3(5, 500, 5);
    b.prevOrientation = new Quaternion();
    b.position.set(5, 499.99, 4.55);
    expect(bodyDrawPose(b, 10, 10 - 0.005, p, q)).toBe(false);
    expect(bodyDrawPose(b, 10, 10 - 0.003, p, q)).toBe(true);
    expect(p.distanceTo(b.prevPosition)).toBeLessThan(1e-9);
  });

  it('blends a released store from where it hung into its own path', () => {
    frame();
    sim.stores.stations[8].stores.shift();
    // the weapons module releases it from the pylon's suspension point, not from the TER mount
    const b = makeBody(9, 'MK-82', 'bomb');
    b.position.copy(sim.aircraft.position).add(new Vector3(3.6, -0.7, -0.05));
    b.velocity.copy(sim.aircraft.velocity);
    frame(release(b));
    const model = fx.stores.modelOf(b.id)!;
    const first = model.position.clone();
    const path = new Vector3();
    bodyDrawPose(b, sim.time, sim.time, path, new Quaternion());
    // first frame: where the station drew it, about half a metre from the body's own point
    const gap = first.distanceTo(path);
    expect(gap).toBeGreaterThan(0.2);
    expect(gap).toBeLessThan(1.5);
    // a quarter of a second later it is on its own path
    for (let i = 0; i < Math.ceil(HANDOFF_BLEND / (2 * SIM_DT)) + 2; i++) frame();
    bodyDrawPose(b, sim.time, sim.time, path, new Quaternion());
    expect(model.position.distanceTo(path)).toBeLessThan(1e-6);
  });
});
