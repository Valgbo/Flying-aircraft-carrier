/**
 * Sensor view (SENSOR-VIEW module, wave 2): the GPU-free parts of the targeting pod's and the
 * Maverick's pictures — the cameras from the sensor state, the frame-rate scheduler, the scene
 * state a sensor render changes and restores, the validity rules, the automatic gain control,
 * and the radiometry that keeps the picture consistent with the seekers' contrast model.
 */
import {
  Color,
  FogExp2,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector3,
} from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { quaternionFromAttitude } from '../../../src/a10/core/frames';
import type { MaverickSeekerState } from '../../../src/a10/core/sensors/types';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { CONTRAST, MAVERICK, TGP } from '../../../src/a10/data/sensors';
import { a10Env } from '../../../src/a10/view/environment/env';
import {
  AGC_BINS,
  agcFromStats,
  createAgc,
  irDisplay,
  stepAgc,
  STATS_IR_OFFSET,
  STATS_IR_RANGE,
  STATS_TV_LOG_MIN,
  STATS_TV_LOG_RANGE,
  tvDisplay,
  tvExposureRange,
} from '../../../src/a10/view/sensors/agc';
import { getSensorPicture } from '../../../src/a10/view/sensors/pictures';
import {
  apparentKelvin,
  hazeDensity,
  hazeFactor,
  kelvinToLevel,
  levelToKelvin,
  skyKelvin,
  skyLevelKelvin,
  sunElevationSine,
  tvLight,
  VEHICLE_THERMAL_GAIN,
  VEHICLE_THERMAL_LEVEL,
} from '../../../src/a10/view/sensors/radiometry';
import {
  createSavedSceneState,
  enterSensorScene,
  exitSensorScene,
  hiddenInInfrared,
  type SensorSceneSettings,
} from '../../../src/a10/view/sensors/sceneState';
import {
  createSensorSchedule,
  nextSensorFrame,
  type SensorId,
} from '../../../src/a10/view/sensors/schedule';
import {
  createSensorCameraPose,
  maverickCameraPose,
  maverickFov,
  maverickPicture,
  mountBody,
  nearPlaneFor,
  pictureEffectivePixels,
  podStation,
  tgpCameraPose,
} from '../../../src/a10/view/sensors/sensorPose';
import { SENSOR_AGC, SENSOR_MOUNTS, SENSOR_OPTICS } from '../../../src/a10/view/sensors/sensorViewData';
import {
  maverickPictureStatus,
  tgpPictureStatus,
} from '../../../src/a10/view/sensors/validity';
import { createTerrainMaterial, terrainUniforms } from '../../../src/a10/view/terrain/terrainMaterial';
import {
  getThermalMode,
  setThermalLevelGain,
  setThermalMode,
  thermalUniforms,
} from '../../../src/a10/view/vehicles/thermal';

const DEG = Math.PI / 180;

function newSim(): Sim {
  const sim = createSim({ seed: 1, terrain: createFlatTerrain(0), scenario: 'empty' });
  const ac = sim.aircraft;
  ac.position.set(0, 2400, 0);
  ac.velocity.set(0, 0, -130);
  quaternionFromAttitude(0, 0, 0, ac.orientation);
  return sim;
}

/** A camera built from a pose, as the renderer builds it. */
function cameraOf(pose: ReturnType<typeof createSensorCameraPose>): PerspectiveCamera {
  const cam = new PerspectiveCamera(pose.fov / DEG, 1, pose.near, pose.far);
  cam.position.copy(pose.position);
  cam.quaternion.copy(pose.quaternion);
  cam.updateMatrixWorld();
  return cam;
}

function ndc(cam: PerspectiveCamera, p: Vector3): Vector3 {
  return p.clone().project(cam);
}

/** A Maverick seeker as the sensors module keeps one (fields the picture reads). */
function seeker(station: number, fov: 'WIDE' | 'NARROW', los: Vector3): MaverickSeekerState {
  return {
    station,
    powered: true,
    align: 0,
    los: los.clone().normalize(),
    fov,
    locked: false,
    lockedVehicle: -1,
    lockPoint: new Vector3(),
    inZone: false,
    gimbalAz: 0,
    gimbalEl: 0,
    contrast: 0,
  } as MaverickSeekerState;
}

describe('targeting-pod camera from the sensor state', () => {
  it('sits at the pod head on its station and centres the tracked point, with the pod fov', () => {
    const sim = newSim();
    const station = podStation(sim);
    expect(station).toBe(10);
    const tgp = sim.sensors.tgp;
    tgp.point.set(1500, 0, -4500);
    tgp.pointValid = true;
    tgp.fov = TGP.fovNarrow / 2;
    const pose = createSensorCameraPose();
    expect(tgpCameraPose(sim, pose)).toBe(true);
    // the head of a pod under station 10, carried by the aircraft (identity attitude here)
    const head = mountBody(station, SENSOR_MOUNTS.podHead, new Vector3())!;
    expect(pose.position.distanceTo(head.add(sim.aircraft.position))).toBeLessThan(1e-9);
    expect(head.x).toBeCloseTo(A10_GEOMETRY.stations[10]!.x, 6);
    expect(pose.fov).toBeCloseTo(TGP.fovNarrow / 2, 12);
    const cam = cameraOf(pose);
    const c = ndc(cam, tgp.point);
    expect(Math.abs(c.x)).toBeLessThan(1e-6);
    expect(Math.abs(c.y)).toBeLessThan(1e-6);
    // the camera's field matches: a point half a field to the side sits on the picture's edge
    const right = new Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
    const dist = pose.position.distanceTo(tgp.point);
    const edge = tgp.point.clone().addScaledVector(right, dist * Math.tan(pose.fov / 2));
    expect(ndc(cam, edge).x).toBeCloseTo(1, 3);
  });

  it('looks along the line of sight when there is no ground point', () => {
    const sim = newSim();
    const tgp = sim.sensors.tgp;
    tgp.pointValid = false;
    tgp.los.set(0.3, -0.5, -0.8).normalize();
    const pose = createSensorCameraPose();
    tgpCameraPose(sim, pose);
    expect(pose.direction.distanceTo(tgp.los)).toBeLessThan(1e-12);
    const fwd = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    expect(fwd.distanceTo(tgp.los)).toBeLessThan(1e-9);
  });

  it('uses the head position the sensors module sets, when it is on the aircraft', () => {
    const sim = newSim();
    const tgp = sim.sensors.tgp as typeof sim.sensors.tgp & { head?: Vector3 };
    tgp.head = new Vector3(4.9, 2399.3, -1.1);
    tgp.pointValid = true;
    tgp.point.set(0, 0, -5000);
    const pose = createSensorCameraPose();
    tgpCameraPose(sim, pose);
    expect(pose.position.distanceTo(tgp.head)).toBeLessThan(1e-12);
    // an unset head (the origin, far from the aircraft) is ignored
    tgp.head.set(0, 0, 0);
    tgpCameraPose(sim, pose);
    expect(pose.position.y).toBeGreaterThan(2398);
  });

  it('keeps the picture level when the aircraft banks (derotated), far side up', () => {
    const sim = newSim();
    const tgp = sim.sensors.tgp;
    tgp.pointValid = true;
    tgp.point.set(0, 0, -5000);
    tgp.fov = 4 * DEG;
    quaternionFromAttitude(0, 0, 60 * DEG, sim.aircraft.orientation);
    const pose = createSensorCameraPose();
    tgpCameraPose(sim, pose);
    const cam = cameraOf(pose);
    // level: the picture's horizontal axis is horizontal in the world, whatever the bank
    const across = new Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
    expect(Math.abs(across.y)).toBeLessThan(1e-9);
    const left = ndc(cam, new Vector3(-100, 0, -5000));
    const right = ndc(cam, new Vector3(100, 0, -5000));
    expect(Math.abs(left.y - right.y)).toBeLessThan(1e-3);
    expect(left.x).toBeLessThan(0);
    // looking to the side, the picture stays level too (no heading blend away from nadir)
    tgp.point.set(-4000, 0, -500);
    tgpCameraPose(sim, pose);
    expect(Math.abs(new Vector3(1, 0, 0).applyQuaternion(pose.quaternion).y)).toBeLessThan(1e-9);
    tgp.point.set(0, 0, -5000);
    tgpCameraPose(sim, pose);
    // the farther ground is at the top of the picture
    expect(ndc(cam, new Vector3(0, 0, -5200)).y).toBeGreaterThan(0);
  });

  it('shows the aircraft heading up when looking straight down', () => {
    const sim = newSim();
    quaternionFromAttitude(Math.PI / 2, 0, 0, sim.aircraft.orientation); // heading east
    const tgp = sim.sensors.tgp;
    tgp.pointValid = false;
    tgp.los.set(0, -1, 0);
    const pose = createSensorCameraPose();
    tgpCameraPose(sim, pose);
    const cam = cameraOf(pose);
    const ahead = ndc(cam, pose.position.clone().add(new Vector3(50, -2400, 0)));
    expect(ahead.y).toBeGreaterThan(0);
    expect(Math.abs(ahead.x)).toBeLessThan(1e-6);
  });

  it('has no camera without a pod; the near plane keeps the airframe out', () => {
    const sim = newSim();
    for (const st of sim.stores.stations) {
      st.stores = st.stores.filter((s) => s !== 'AN/AAQ-28');
      if (st.rack === 'AN/AAQ-28') st.rack = null;
    }
    expect(podStation(sim)).toBe(-1);
    expect(tgpCameraPose(sim, createSensorCameraPose())).toBe(false);
    expect(nearPlaneFor(30)).toBeGreaterThanOrEqual(20);
    expect(nearPlaneFor(2400)).toBe(300);
    expect(A10_GEOMETRY.wingTipX * 2).toBeLessThan(nearPlaneFor(0) + 1);
  });
});

describe('Maverick camera', () => {
  it('looks along the seeker line of sight with its field of view, rolling with the aircraft', () => {
    const sim = newSim();
    quaternionFromAttitude(0, 0, 30 * DEG, sim.aircraft.orientation);
    const los = new Vector3(0, -0.45, -1).normalize();
    sim.sensors.mavericks = [seeker(3, 'NARROW', los)];
    sim.sensors.selectedMaverick = 0;
    const pose = createSensorCameraPose();
    expect(maverickCameraPose(sim, pose)).toBe(true);
    expect(pose.fov).toBeCloseTo(MAVERICK.fovNarrow, 12);
    expect(maverickFov('WIDE')).toBeCloseTo(MAVERICK.fovWide, 12);
    const fwd = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    expect(fwd.distanceTo(los)).toBeLessThan(1e-9);
    // the picture's up is the aircraft's up: the horizon is tilted by the bank
    const up = new Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
    const bodyUp = new Vector3(0, 1, 0).applyQuaternion(sim.aircraft.orientation);
    const right = new Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
    expect(Math.abs(right.y)).toBeGreaterThan(0.3);
    expect(up.dot(bodyUp)).toBeGreaterThan(0.85);
  });

  it('aims at the lock point while locked, and takes the seeker fov and picture it reports', () => {
    const sim = newSim();
    const s = seeker(9, 'WIDE', new Vector3(0, -1, -1)) as MaverickSeekerState & {
      fovAngle?: number;
      band?: string;
      picture?: string;
    };
    s.locked = true;
    s.lockPoint.set(200, 0, -6000);
    s.fovAngle = 2 * DEG;
    s.band = 'IR';
    s.picture = 'BHOT';
    sim.sensors.mavericks = [s];
    sim.sensors.selectedMaverick = 0;
    const pose = createSensorCameraPose();
    maverickCameraPose(sim, pose);
    const c = ndc(cameraOf(pose), s.lockPoint);
    expect(Math.abs(c.x)).toBeLessThan(1e-6);
    expect(Math.abs(c.y)).toBeLessThan(1e-6);
    expect(pose.fov).toBeCloseTo(2 * DEG, 12);
    expect(maverickPicture(sim, 0)).toBe('BHOT');
    s.band = 'TV';
    expect(maverickPicture(sim, 0)).toBe('CCD');
  });

  it('has no camera when no missile is selected', () => {
    const sim = newSim();
    sim.sensors.mavericks = [];
    sim.sensors.selectedMaverick = -1;
    expect(maverickCameraPose(sim, createSensorCameraPose())).toBe(false);
  });
});

describe('frame-rate scheduler', () => {
  function run(
    seconds: number,
    fps: number,
    rate: number,
    want: { tgp: boolean; mav: boolean },
    jitter = 0,
  ): { tgp: number; mav: number; both: number; seq: (SensorId | null)[] } {
    const s = createSensorSchedule();
    const out = { tgp: 0, mav: 0, both: 0, seq: [] as (SensorId | null)[] };
    const frames = Math.round(seconds * fps);
    let r = 12345;
    for (let i = 0; i < frames; i++) {
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      const dt = (1 / fps) * (1 + jitter * ((r / 0x7fffffff) * 2 - 1));
      const pick = nextSensorFrame(s, dt, want, rate, rate);
      out.seq.push(pick);
      if (pick === 'TGP') out.tgp++;
      if (pick === 'MAV') out.mav++;
    }
    return out;
  }

  it('renders each picture at its rate, on alternate frames (Low: 15 Hz, Medium: 20 Hz)', () => {
    for (const rate of [15, 20]) {
      const r = run(10, 60, rate, { tgp: true, mav: true });
      expect(Math.abs(r.tgp - rate * 10)).toBeLessThanOrEqual(2);
      expect(Math.abs(r.mav - rate * 10)).toBeLessThanOrEqual(2);
      // never the same sensor twice in a row while both are due, never both in a frame (by type)
      const picks = r.seq.filter((p) => p !== null);
      let repeats = 0;
      for (let i = 1; i < picks.length; i++) if (picks[i] === picks[i - 1]) repeats++;
      expect(repeats).toBeLessThanOrEqual(2);
    }
  });

  it('High (30 Hz each) at 60 fps alternates every frame', () => {
    const r = run(4, 60, 30, { tgp: true, mav: true });
    const steady = r.seq.slice(10);
    for (let i = 1; i < steady.length; i++) {
      expect(steady[i]).not.toBeNull();
      expect(steady[i]).not.toBe(steady[i - 1]);
    }
  });

  it('keeps the average rate with jittery frames, without catch-up bursts', () => {
    const r = run(20, 60, 15, { tgp: true, mav: false }, 0.5);
    expect(Math.abs(r.tgp - 300)).toBeLessThanOrEqual(6);
    // a slow display (20 fps): at most one picture per frame, shared
    const slow = run(10, 20, 15, { tgp: true, mav: true });
    expect(slow.tgp + slow.mav).toBeLessThanOrEqual(200);
    expect(Math.abs(slow.tgp - slow.mav)).toBeLessThanOrEqual(2);
  });

  it('renders nothing nobody shows, and a newly shown picture at once', () => {
    const s = createSensorSchedule();
    for (let i = 0; i < 300; i++)
      expect(nextSensorFrame(s, 1 / 60, { tgp: false, mav: false }, 15, 15)).toBeNull();
    expect(nextSensorFrame(s, 1 / 60, { tgp: false, mav: true }, 15, 15)).toBe('MAV');
    expect(nextSensorFrame(s, 1 / 60, { tgp: false, mav: true }, 15, 15)).toBeNull();
  });
});

describe('scene state around a sensor render', () => {
  const gl = { shadowMap: { autoUpdate: true } };
  let scene: Scene;
  let tile: Mesh;
  let sky: Mesh;
  let clouds: Mesh;
  let shadow: Mesh;
  let bomb: Mesh;
  let vehicle: Mesh;
  let hiddenBefore: Mesh;

  function settings(band: 'IR' | 'TV'): SensorSceneSettings {
    return { band, pixelAngle: 6e-5, near: 120, detailDistance: 9000, hazeDensity: 3e-5 };
  }

  function snapshot() {
    const u = terrainUniforms;
    return {
      thermal: u.uThermal.value,
      params: u.uThermalParams.value.toArray(),
      haze: u.uHazeDensity.value,
      pixel: u.uPixelAngle.value,
      bias: u.uDepthBias.value.toArray(),
      detail: u.uDetailDistance.value,
      mode: getThermalMode(),
      level: thermalUniforms.uThermalLevel.value,
      gain: thermalUniforms.uThermalGain.value,
      fog: (scene.fog as FogExp2).color.getHex(),
      density: (scene.fog as FogExp2).density,
      shadows: gl.shadowMap.autoUpdate,
      visible: [tile, sky, clouds, shadow, bomb, vehicle, hiddenBefore].map((m) => m.visible),
    };
  }

  beforeEach(() => {
    const plane = new PlaneGeometry(1, 1);
    scene = new Scene();
    scene.fog = new FogExp2(0xa0b0c0, 4.5e-5);
    tile = new Mesh(plane, createTerrainMaterial());
    sky = new Mesh(plane, new ShaderMaterial({ depthTest: false }));
    sky.renderOrder = -1000;
    clouds = new Mesh(plane, new ShaderMaterial({ transparent: true }));
    clouds.renderOrder = -10;
    shadow = new Mesh(plane, new ShaderMaterial({ transparent: true, uniforms: { uColor: { value: new Color() } } }));
    bomb = new Mesh(plane, new MeshStandardMaterial());
    const vm = new MeshStandardMaterial();
    vm.onBeforeCompile = () => {};
    vehicle = new Mesh(plane, vm);
    hiddenBefore = new Mesh(plane, new MeshBasicMaterial());
    hiddenBefore.visible = false;
    const group = new Group();
    group.add(tile, vehicle, bomb);
    scene.add(sky, clouds, group, shadow, hiddenBefore);
    // the world as the other modules leave it before the sensor pass
    const u = terrainUniforms;
    u.uThermal.value = 0;
    u.uThermalParams.value.set(0.8, 0.5, 1.2, 0);
    u.uHazeDensity.value = 5e-5;
    u.uPixelAngle.value = 0.0015;
    u.uDepthBias.value.set(0.25, 2.4e-7);
    u.uDetailDistance.value = 1600;
    setThermalMode(0);
    setThermalLevelGain(0.3, 1 / 75);
    gl.shadowMap.autoUpdate = true;
  });

  it('switches the terrain and vehicles to their thermal output for infrared, then restores all', () => {
    const before = snapshot();
    const saved = createSavedSceneState();
    enterSensorScene(scene, gl, settings('IR'), saved);
    expect(terrainUniforms.uThermal.value).toBe(1);
    expect(terrainUniforms.uThermalParams.value.z).toBe(1);
    expect(terrainUniforms.uThermalParams.value.x).toBe(0.8); // the time of day stays
    expect(terrainUniforms.uHazeDensity.value).toBe(0);
    expect(terrainUniforms.uPixelAngle.value).toBe(6e-5);
    expect(terrainUniforms.uDetailDistance.value).toBe(9000);
    expect(getThermalMode()).toBe(1);
    expect(thermalUniforms.uThermalLevel.value).toBe(CONTRAST.ambientLevel);
    expect(thermalUniforms.uThermalGain.value).toBeCloseTo(1 / CONTRAST.kelvinPerLevel, 15);
    expect(gl.shadowMap.autoUpdate).toBe(false);
    // the sky, the clouds and what has no thermal output are left out; the rest stays
    expect([sky.visible, clouds.visible, shadow.visible, bomb.visible]).toEqual([false, false, false, false]);
    expect([tile.visible, vehicle.visible]).toEqual([true, true]);
    exitSensorScene(scene, gl, saved);
    expect(snapshot()).toEqual(before);
  });

  it('draws the visible scene for television with the linear haze colour and the sensor haze', () => {
    setThermalMode(2); // e.g. a sandbox showing the black-hot world
    terrainUniforms.uThermal.value = 2;
    const before = snapshot();
    const saved = createSavedSceneState();
    enterSensorScene(scene, gl, settings('TV'), saved);
    expect(getThermalMode()).toBe(0);
    expect(terrainUniforms.uThermal.value).toBe(0);
    expect(terrainUniforms.uHazeDensity.value).toBe(3e-5);
    expect((scene.fog as FogExp2).density).toBe(3e-5);
    expect((scene.fog as FogExp2).color.equals(a10Env.horizonColor)).toBe(true);
    expect([sky.visible, clouds.visible, shadow.visible, bomb.visible]).toEqual([true, true, true, true]);
    exitSensorScene(scene, gl, saved);
    expect(snapshot()).toEqual(before);
    expect(getThermalMode()).toBe(2);
  });

  it('enters twice safely and classifies materials by their thermal hook', () => {
    const before = snapshot();
    const saved = createSavedSceneState();
    enterSensorScene(scene, gl, settings('IR'), saved);
    enterSensorScene(scene, gl, settings('TV'), saved);
    exitSensorScene(scene, gl, saved);
    exitSensorScene(scene, gl, saved);
    expect(snapshot()).toEqual(before);
    expect(hiddenInInfrared(tile)).toBe(false);
    expect(hiddenInInfrared(vehicle)).toBe(false);
    expect(hiddenInInfrared(bomb)).toBe(true);
    expect(hiddenInInfrared(new Group())).toBe(false);
  });
});

describe('picture validity', () => {
  it('pod: carried, powered, warmed up, not masked', () => {
    const sim = newSim();
    const tgp = sim.sensors.tgp;
    tgp.powered = true;
    tgp.warmup = 0;
    tgp.masked = false;
    sim.avionics.tgpPower = true;
    expect(tgpPictureStatus(sim)).toBe('OK');
    tgp.masked = true;
    expect(tgpPictureStatus(sim)).toBe('MASKED');
    tgp.warmup = 30;
    expect(tgpPictureStatus(sim)).toBe('WARMUP');
    sim.avionics.tgpPower = false;
    expect(tgpPictureStatus(sim)).toBe('OFF');
    sim.avionics.tgpPower = true;
    tgp.powered = false;
    expect(tgpPictureStatus(sim)).toBe('OFF');
    for (const st of sim.stores.stations) st.stores = st.stores.filter((s) => s !== 'AN/AAQ-28');
    expect(tgpPictureStatus(sim)).toBeNull();
  });

  it('Maverick: selected, powered, aligned', () => {
    const sim = newSim();
    sim.sensors.mavericks = [];
    sim.sensors.selectedMaverick = -1;
    expect(maverickPictureStatus(sim)).toBeNull();
    const s = seeker(3, 'WIDE', new Vector3(0, -1, -2));
    sim.sensors.mavericks = [s];
    sim.sensors.selectedMaverick = 0;
    expect(maverickPictureStatus(sim)).toBe('OK');
    s.align = 120;
    expect(maverickPictureStatus(sim)).toBe('ALIGN');
    s.powered = false;
    expect(maverickPictureStatus(sim)).toBe('OFF');
  });

  it('publishes no picture before a sensor view runs', () => {
    expect(getSensorPicture('TGP')).toBeNull();
    expect(getSensorPicture('MAV')).toBeNull();
  });
});

/** Statistics bytes as the stats shader writes them, for a list of signal values. */
function statsBytes(values: number[], band: 'IR' | 'TV'): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  values.forEach((s, i) => {
    const v =
      band === 'IR'
        ? (s + STATS_IR_OFFSET) / STATS_IR_RANGE
        : (Math.log2(Math.max(s, 1e-7)) - STATS_TV_LOG_MIN) / STATS_TV_LOG_RANGE;
    const q = Math.floor(Math.min(1, Math.max(0, v)) * 65535 + 0.5);
    bytes[i * 4] = Math.floor(q / 256);
    bytes[i * 4 + 1] = q % 256;
  });
  return bytes;
}

describe('automatic gain and level control', () => {
  const hist = new Int32Array(AGC_BINS);

  it('infrared: the window spans the 1st to 99th percentile and snaps on the first statistics', () => {
    const agc = createAgc('IR');
    // a scene from 0 to +20 K, plus a 0.5 % hot spot (a fire) at +60 K
    const values: number[] = [];
    for (let i = 0; i < 4096; i++) values.push(i < 20 ? 60 : (20 * (i % 1000)) / 999);
    agcFromStats(agc, statsBytes(values, 'IR'), values.length, hist);
    expect(agc.hasTarget).toBe(true);
    expect(agc.lo).toBeCloseTo(0.2, 0);
    expect(agc.hi).toBeCloseTo(19.8, 0);
    // the fire saturates white, the scene keeps its contrast
    expect(irDisplay(agc, 60)).toBe(1);
    expect(irDisplay(agc, 10)).toBeCloseTo(0.5, 1);
  });

  it('infrared: a uniform scene gets the maximum gain; a fire-filled one the minimum', () => {
    const agc = createAgc('IR');
    agcFromStats(agc, statsBytes(new Array(4096).fill(3), 'IR'), 4096, hist);
    expect(agc.hi - agc.lo).toBeCloseTo(SENSOR_AGC.irMinSpan, 2);
    const wide = createAgc('IR');
    const v: number[] = [];
    for (let i = 0; i < 4096; i++) v.push(-100 + (i / 4095) * 220);
    agcFromStats(wide, statsBytes(v, 'IR'), v.length, hist);
    expect(wide.hi - wide.lo).toBeCloseTo(SENSOR_AGC.irMaxSpan, 2);
  });

  it('settles with its time constant after a change', () => {
    const agc = createAgc('IR');
    agcFromStats(agc, statsBytes(new Array(4096).fill(0).map((_, i) => (i % 100) / 10), 'IR'), 4096, hist);
    const lo0 = agc.lo;
    const v = new Array(4096).fill(0).map((_, i) => 20 + (i % 100) / 10);
    agcFromStats(agc, statsBytes(v, 'IR'), 4096, hist);
    expect(agc.lo).toBeCloseTo(lo0, 6); // no snap after the first statistics
    stepAgc(agc, SENSOR_AGC.timeConstant);
    expect((agc.lo - lo0) / (agc.targetLo - lo0)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(agc.settled).toBe(false);
    for (let i = 0; i < 60; i++) stepAgc(agc, 0.1);
    expect(agc.settled).toBe(true);
  });

  it('television: exposure puts the bright end at 90 % within the camera range, black level from the dark end', () => {
    const agc = createAgc('TV');
    const v: number[] = [];
    for (let i = 0; i < 4096; i++) v.push(0.02 + (0.08 * (i % 512)) / 511);
    agcFromStats(agc, statsBytes(v, 'TV'), v.length, hist);
    const hi = 0.02 + 0.08 * 0.98;
    expect(agc.exposure * hi).toBeCloseTo(0.9, 1);
    expect(agc.black).toBeGreaterThan(0.1);
    expect(tvDisplay(agc, hi)).toBeGreaterThan(0.9);
    // a dark scene meets the gain limit and stays dark
    const dark = createAgc('TV');
    agcFromStats(dark, statsBytes(new Array(4096).fill(1e-5), 'TV'), 4096, hist);
    expect(dark.exposure).toBeCloseTo(tvExposureRange()[1], 3);
    expect(tvDisplay(dark, 1e-5)).toBeLessThan(0.2);
  });
});

/** The sensors module's contrast model, when it exists (the picture must mirror it). */
const contrastModules = import.meta.glob('../../../src/a10/core/sensors/contrast.ts');

describe('radiometry: what looks hot is what the seekers can lock', () => {
  it('draws vehicles and particles on the contrast model scale', () => {
    expect(VEHICLE_THERMAL_LEVEL).toBe(CONTRAST.ambientLevel);
    expect(VEHICLE_THERMAL_GAIN).toBeCloseTo(1 / CONTRAST.kelvinPerLevel, 15);
    expect(levelToKelvin(kelvinToLevel(37))).toBeCloseTo(37, 10);
    expect(skyLevelKelvin()).toBeCloseTo((CONTRAST.skyLevel - CONTRAST.ambientLevel) * 75, 10);
  });

  it('applies the same haze law as the seekers (and as the terrain shader draws it)', async () => {
    // the terrain shader: t_seen = mix(t, skyLevel, 0.7 f); in kelvin that is apparentKelvin
    for (const f of [0, 0.3, 0.9]) {
      const t = 0.55;
      const seen = t + (CONTRAST.skyLevel - t) * CONTRAST.irHazeShare * f;
      expect(apparentKelvin(levelToKelvin(t), f)).toBeCloseTo(levelToKelvin(seen), 9);
    }
    const loader = contrastModules['../../../src/a10/core/sensors/contrast.ts'];
    if (!loader) return;
    const m = (await loader()) as Record<string, (...a: number[]) => number>;
    for (const [vis, h, d] of [
      [30, 2400, 5000],
      [8, 300, 8000],
      [3, 1000, 2500],
    ]) {
      const rho = hazeDensity(vis, h);
      expect(rho).toBeCloseTo(m.hazeDensity(vis, h), 15);
      const f = hazeFactor(rho, d);
      expect(f).toBeCloseTo(m.hazeFactor(rho, d), 12);
      // a vehicle 25 K above a ground 8 K above ambient: the picture's difference is the seekers'
      const seen = apparentKelvin(25, f) - apparentKelvin(8, f);
      expect(seen).toBeCloseTo(m.irApparentK(17, f), 9);
    }
    for (const h of [6, 7.5, 12, 17.2, 19, 23]) {
      const sun = (m.createSunState as unknown as () => { sinElevation: number; tvLight: number })();
      (m.sunStateAt as unknown as (h: number, o: unknown) => void)(h, sun);
      expect(sunElevationSine(h)).toBeCloseTo(sun.sinElevation, 12);
      expect(tvLight(sunElevationSine(h))).toBeCloseTo(sun.tvLight, 12);
    }
  });

  it('has a cold sky: the hazed horizon level at the horizon, colder toward the zenith', () => {
    const horizon = skyKelvin(0, 30);
    expect(horizon).toBeCloseTo(skyLevelKelvin(), 9);
    let prev = horizon;
    for (const s of [0.05, 0.2, 0.5, 1]) {
      const k = skyKelvin(s, 30);
      expect(k).toBeLessThan(prev);
      prev = k;
    }
    expect(skyKelvin(1, 30)).toBeLessThan(skyKelvin(1, 5)); // a hazy sky is warmer
  });
});

describe('picture sharpness', () => {
  it('blurs at the zoom limits: detector pixels and diffraction across the picture', () => {
    const size = 256;
    const at = (fov: number, zoom: number) =>
      pictureEffectivePixels(size, fov / zoom, zoom, TGP.imagePixels, SENSOR_OPTICS.podFlirWavelengthUm, SENSOR_OPTICS.podApertureM);
    expect(at(TGP.fovWide, 1)).toBe(size);
    expect(at(TGP.fovNarrow, 1)).toBe(size);
    const z8 = at(TGP.fovNarrow, 8);
    expect(z8).toBeLessThan(size / 2);
    expect(z8).toBeGreaterThanOrEqual(16);
    let prev = size + 1;
    for (const z of TGP.zoomLevels) {
      const n = at(TGP.fovNarrow, z);
      expect(n).toBeLessThanOrEqual(prev);
      prev = n;
    }
    // the television channel (shorter wavelength) resolves more than the infrared at max zoom
    const tv = pictureEffectivePixels(size, TGP.fovNarrow / 8, 8, TGP.imagePixels, SENSOR_OPTICS.ccdWavelengthUm, SENSOR_OPTICS.podApertureM);
    expect(tv).toBeGreaterThan(z8);
  });
});

describe('quaternion sanity', () => {
  it('builds proper rotations', () => {
    const sim = newSim();
    sim.sensors.tgp.pointValid = true;
    sim.sensors.tgp.point.set(-3000, 50, 2000);
    const pose = createSensorCameraPose();
    tgpCameraPose(sim, pose);
    expect(Math.abs(pose.quaternion.length() - 1)).toBeLessThan(1e-12);
    expect(pose.quaternion).toBeInstanceOf(Quaternion);
  });
});
