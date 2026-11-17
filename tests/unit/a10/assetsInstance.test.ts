/**
 * The drawn aircraft and its stores (STORES-VIEW module, wave 2).
 *
 * FC-4 (wave-1 review): the exterior aircraft is drawn at the pose interpolated between the last
 * two simulation steps (view/frame.ts drawPose, ARCHITECTURE §6 "Interpolation"), not at the last
 * step's pose, so it does not judder when a frame takes 0 or 2 steps.
 */
import { Group, Mesh, Quaternion, Vector3, type BufferGeometry, type Object3D } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAircraftInstance,
  podRocketMount,
  podTubesOf,
  storeMount,
  updateAircraftInstance,
  type A10Meta,
  type AircraftInstance,
  type AircraftTemplates,
} from '../../../src/a10/assets';
import { createPlaceholderTemplates } from '../../../src/a10/assets/placeholders';
import { SIM_DT } from '../../../src/a10/core/constants';
import { quaternionFromAttitude } from '../../../src/a10/core/frames';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import type { StoreBody, StoreBodyKind, StoreType } from '../../../src/a10/core/weapons/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { HYDRA70 } from '../../../src/a10/data/munitions';
import { frameInfo } from '../../../src/a10/view/frame';
import { placeAircraft } from '../../../src/a10/view/aircraft/pose';

const metaFiles = import.meta.glob('../../../public/a10/models/a10-meta.json', {
  eager: true,
  import: 'default',
});
const META = Object.values(metaFiles)[0] as A10Meta;

const DEG = Math.PI / 180;

afterEach(() => {
  frameInfo.alpha = 0;
});

describe('drawn aircraft pose (FC-4)', () => {
  it('is interpolated between the start and the end of the last step by frameInfo.alpha', () => {
    const sim = createSim({ seed: 1, terrain: createFlatTerrain(0), scenario: 'empty' });
    const ac = sim.aircraft;
    // the last step moved the aircraft 1.07 m north (250 kn) and rolled it 2° right
    ac.prevPosition.set(100, 2000, -300);
    ac.position.set(100, 2000, -301.07);
    quaternionFromAttitude(0, 0, 10 * DEG, ac.prevOrientation);
    quaternionFromAttitude(0, 0, 12 * DEG, ac.orientation);
    const root = new Group();
    for (const alpha of [0, 0.25, 0.5, 1]) {
      frameInfo.alpha = alpha;
      placeAircraft(root, sim);
      const want = new Vector3().lerpVectors(ac.prevPosition, ac.position, alpha);
      expect(root.position.distanceTo(want)).toBeLessThan(1e-9);
      const q = new Quaternion().slerpQuaternions(ac.prevOrientation, ac.orientation, alpha);
      expect(root.quaternion.angleTo(q)).toBeLessThan(1e-6);
    }
    // half-way through the step: half-way along the path and 11° of bank
    frameInfo.alpha = 0.5;
    placeAircraft(root, sim);
    expect(root.position.z).toBeCloseTo(-300.535, 6);
    const bank = new Quaternion();
    quaternionFromAttitude(0, 0, 11 * DEG, bank);
    expect(root.quaternion.angleTo(bank)).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------------------------
// stores on the pylons follow sim.stores
// ---------------------------------------------------------------------------------------------

/**
 * A store body as the weapons module makes one on a release: the contract's fields (§12.2), all
 * the views read; the weapons module's own additions are left out.
 */
function body(sim: Sim, station: number, type: StoreType, kind: StoreBodyKind, t: number): StoreBody {
  const fields = {
    id: sim.projectiles.nextBodyId++,
    type,
    kind,
    alive: true,
    station,
    releaseTime: t,
    position: new Vector3(),
    velocity: new Vector3(),
    orientation: new Quaternion(),
    motorTime: kind === 'rocket' ? 1.07 : 0,
    armed: false,
    data: {},
    delivery: 'CCIP',
    aim: new Vector3(),
    aimValid: false,
    highDrag: false,
    armingTime: 0,
    laserCode: 1688,
    guidance: { mode: 'NONE', vehicleId: -1, point: new Vector3(), valid: false },
    record: -1,
  } satisfies Partial<StoreBody>;
  const b = fields as unknown as StoreBody;
  sim.projectiles.bodies.push(b);
  return b;
}

function station(inst: AircraftInstance, s: number): Group {
  return inst.storesGroup.children[s - 1] as Group;
}

/** Visible stores on a station: those its rack carries, or the store on the bare pylon. */
function shown(inst: AircraftInstance, s: number): number {
  const top = station(inst, s).children[0];
  if (!top) return 0;
  // the stores a rack carries are clones of store templates, named by their model id
  const carried = top.children.filter((c) => c.name in META.stores);
  if (carried.length) return carried.filter((c) => c.visible).length;
  return top.visible ? 1 : 0;
}

function rocketsShown(inst: AircraftInstance, s: number): { fired: number; visible: boolean } {
  let found: Mesh | null = null;
  station(inst, s).traverse((o) => {
    if ((o as Mesh).isMesh && podTubesOf(o as Mesh)) found = o as Mesh;
  });
  const m = found as Mesh | null;
  if (!m) return { fired: -1, visible: false };
  const tubes = podTubesOf(m)!;
  return { fired: tubes.stages.indexOf(m.geometry as BufferGeometry), visible: m.visible };
}

function newFlight(loadoutId: string): { sim: Sim; t: AircraftTemplates; inst: AircraftInstance } {
  const sim = createSim({ seed: 1, terrain: createFlatTerrain(0), scenario: 'empty', loadoutId });
  const t = createPlaceholderTemplates(META);
  const inst = createAircraftInstance({ forCockpit: false, templates: t });
  frameInfo.alpha = 0.5;
  updateAircraftInstance(inst, sim);
  return { sim, t, inst };
}

/** A step in which the weapons module released `store` from `s` at `t` (sim time then: tEnd). */
function stepTo(sim: Sim, tEnd: number): void {
  sim.time = tEnd;
}

describe('stores on the pylons (sim.stores)', () => {
  it('a store stays on its rack until the draw time reaches its release, then leaves', () => {
    const { sim, inst } = newFlight('rangeTraining');
    // station 3: a TER-9A with two Mk-82
    expect(shown(inst, 3)).toBe(2);
    // the weapons module releases the first Mk-82 6 ms into the next step
    const tRelease = sim.time + 0.006;
    stepTo(sim, sim.time + SIM_DT);
    sim.stores.stations[2].stores.shift();
    body(sim, 3, 'MK-82', 'bomb', tRelease);
    // drawn 8.3 ms behind the sim: alpha 0.5 → 4.2 ms after the step's start: still on the rack
    frameInfo.alpha = 0.5;
    updateAircraftInstance(inst, sim);
    expect(shown(inst, 3)).toBe(2);
    // a frame later the draw time has passed the release: one Mk-82 left, the rack stays
    frameInfo.alpha = 0.9;
    updateAircraftInstance(inst, sim);
    expect(shown(inst, 3)).toBe(1);
    expect(station(inst, 3).children.length).toBe(1);
    // the second one: gone at once when its body is already past the draw time
    stepTo(sim, sim.time + 0.1);
    sim.stores.stations[2].stores.shift();
    body(sim, 3, 'MK-82', 'bomb', sim.time - 0.05);
    updateAircraftInstance(inst, sim);
    expect(shown(inst, 3)).toBe(0);
    expect(station(inst, 3).children.length).toBe(1); // the empty TER stays
  });

  it('rockets leave the pod one by one in a ripple; the empty pod stays', () => {
    const { sim, inst } = newFlight('rangeTraining');
    // station 2: an LAU-131 with seven M156 (smoke) rockets
    const st = sim.stores.stations[1];
    expect(st.rockets).toBe(HYDRA70.podTubes);
    expect(rocketsShown(inst, 2)).toEqual({ fired: 0, visible: true });
    for (let k = 1; k <= HYDRA70.podTubes; k++) {
      const t = sim.time + 0.004;
      stepTo(sim, sim.time + SIM_DT);
      st.rockets = HYDRA70.podTubes - k;
      body(sim, 2, 'LAU-131-M156', 'rocket', t);
      // drawn before the release: the rocket is still in its tube
      frameInfo.alpha = 0;
      updateAircraftInstance(inst, sim);
      expect(rocketsShown(inst, 2).fired).toBe(k - 1);
      frameInfo.alpha = 1;
      updateAircraftInstance(inst, sim);
      expect(rocketsShown(inst, 2).fired).toBe(k);
    }
    expect(rocketsShown(inst, 2)).toEqual({ fired: HYDRA70.podTubes, visible: false });
    // the pod itself is still on the pylon
    expect(station(inst, 2).children[0].visible).toBe(true);
    expect(st.stores).toEqual(['LAU-131-M156']);
  });

  it('a jettisoned rack leaves with its stores', () => {
    const { sim, inst } = newFlight('rangeTraining');
    expect(station(inst, 9).children.length).toBe(1);
    const t = sim.time + 0.002;
    stepTo(sim, sim.time + SIM_DT);
    const s9 = sim.stores.stations[8];
    s9.rack = null;
    s9.stores.length = 0;
    body(sim, 9, 'TER-9A', 'bomb', t);
    body(sim, 9, 'MK-82', 'bomb', t);
    body(sim, 9, 'MK-82', 'bomb', t);
    frameInfo.alpha = 0;
    updateAircraftInstance(inst, sim);
    expect(station(inst, 9).children.length).toBe(1);
    expect(shown(inst, 9)).toBe(2);
    frameInfo.alpha = 1;
    updateAircraftInstance(inst, sim);
    expect(station(inst, 9).children.length).toBe(0);
    // without bodies (a jettison that makes none) the station empties at once
    const s3 = sim.stores.stations[2];
    s3.rack = null;
    s3.stores.length = 0;
    updateAircraftInstance(inst, sim);
    expect(station(inst, 3).children.length).toBe(0);
  });

  it('a rearm puts the load back on the pylons', () => {
    const { sim, inst } = newFlight('rangeTraining');
    sim.stores.stations[2].stores.length = 0;
    sim.stores.stations[1].rockets = 0;
    updateAircraftInstance(inst, sim);
    expect(shown(inst, 3)).toBe(0);
    expect(rocketsShown(inst, 2).visible).toBe(false);
    sim.stores.stations[2].stores.push('MK-82', 'MK-82');
    sim.stores.stations[1].rockets = HYDRA70.podTubes;
    updateAircraftInstance(inst, sim);
    expect(shown(inst, 3)).toBe(2);
    expect(rocketsShown(inst, 2)).toEqual({ fired: 0, visible: true });
  });

  it("the cockpit's own airframe follows the stores the same way", () => {
    const sim = createSim({ seed: 1, terrain: createFlatTerrain(0), scenario: 'empty' });
    const t = createPlaceholderTemplates(META);
    const inst = createAircraftInstance({ forCockpit: true, templates: t });
    frameInfo.alpha = 1;
    updateAircraftInstance(inst, sim);
    // tank hunter: two Mavericks on the LAU-88 of station 3
    expect(shown(inst, 3)).toBe(2);
    sim.stores.stations[2].stores.shift();
    updateAircraftInstance(inst, sim);
    expect(shown(inst, 3)).toBe(1);
  });

  it('storeMount and podRocketMount give where the stations draw each store', () => {
    const { sim, t, inst } = newFlight('rangeTraining');
    inst.root.updateMatrixWorld(true);
    const p = new Vector3();
    const q = new Quaternion();
    // the second Mk-82 of station 9's TER (index 1: the right mount)
    const ter = station(inst, 9).children[0];
    const mk = ter.children.filter((c) => c.name in META.stores)[1] as Object3D;
    expect(storeMount(t, 9, 'TER-9A', ['MK-82', 'MK-82'], 1, p, q, 'lugs')).toBe(true);
    const drawn = new Vector3().setFromMatrixPosition(mk.matrixWorld);
    expect(p.distanceTo(drawn)).toBeLessThan(1e-6);
    const dq = new Quaternion().setFromRotationMatrix(mk.matrixWorld);
    expect(q.angleTo(dq)).toBeLessThan(1e-6);
    // its centre: meta.stores.mk82.centre below and behind the lugs
    expect(storeMount(t, 9, 'TER-9A', ['MK-82', 'MK-82'], 1, p, q)).toBe(true);
    const c = META.stores.mk82.centre;
    const local = new Vector3(c[0], c[1], c[2]).applyQuaternion(dq).add(drawn);
    expect(p.distanceTo(local)).toBeLessThan(1e-6);
    // the first rocket of station 2's pod: on its tube axis, under the wing
    expect(podRocketMount(t, 2, 'LAU-131-M156', 0, p, q)).toBe(true);
    const lugs = new Vector3();
    storeMount(t, 2, null, ['LAU-131-M156'], 0, lugs, q, 'lugs');
    expect(p.distanceTo(lugs)).toBeGreaterThan(0.05);
    expect(p.distanceTo(lugs)).toBeLessThan(0.4);
    expect(p.x).toBeLessThan(0); // station 2 is on the left wing
    void sim;
  });
});
