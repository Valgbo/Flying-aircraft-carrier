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
import { createSim, runSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { CONTRAST, MAVERICK, TGP } from '../../../src/a10/data/sensors';
import { a10Env } from '../../../src/a10/view/environment/env';
import {
  AGC_BINS,
  agcFromStats,
  createAgc,
  equalize,
  irDisplay,
  irMinSpanForNoise,
  LUT_SIZE,
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
  picturePsfPixels,
  podStation,
  tgpCameraPose,
} from '../../../src/a10/view/sensors/sensorPose';
import {
  SENSOR_AGC,
  SENSOR_MOUNTS,
  SENSOR_OPTICS,
} from '../../../src/a10/view/sensors/sensorViewData';
import { maverickPictureStatus, tgpPictureStatus } from '../../../src/a10/view/sensors/validity';
import {
  createTerrainMaterial,
  terrainUniforms,
} from '../../../src/a10/view/terrain/terrainMaterial';
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
    shadow = new Mesh(
      plane,
      new ShaderMaterial({ transparent: true, uniforms: { uColor: { value: new Color() } } }),
    );
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
    expect([sky.visible, clouds.visible, shadow.visible, bomb.visible]).toEqual([
      false,
      false,
      false,
      false,
    ]);
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
    expect([sky.visible, clouds.visible, shadow.visible, bomb.visible]).toEqual([
      true,
      true,
      true,
      true,
    ]);
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
  const counts = new Float32Array(LUT_SIZE);
  const N = 4096;

  /** A field from 0 to +20 K (uniform), plus a hot spot (a fire, 0.5 % of the picture) at +60 K. */
  function fieldWithFire(): number[] {
    const values: number[] = [];
    for (let i = 0; i < N; i++) values.push(i < 20 ? 60 : (20 * (i % 1000)) / 999);
    return values;
  }

  it('infrared: the range spans the 99.8th percentile, centred on the median, and snaps on the first statistics', () => {
    const agc = createAgc('IR');
    agcFromStats(agc, statsBytes(fieldWithFire(), 'IR'), N, hist, counts);
    expect(agc.hasTarget).toBe(true);
    // 0.5 % of the picture is more than the top 0.2 %: the fire is inside the range
    expect(agc.hi).toBeGreaterThan(59.8);
    expect(agc.hi).toBeLessThan(60.1);
    // the level control: the median (10 K) mid-range, so the low end goes down to −40 K
    expect(agc.lo).toBeCloseTo(2 * 10 - agc.hi, 0);
    expect(agc.lut).toEqual(agc.targetLut);
  });

  it('infrared: plateau equalization gives the field its grey levels, the fire stays on top', () => {
    const agc = createAgc('IR');
    agcFromStats(agc, statsBytes(fieldWithFire(), 'IR'), N, hist, counts);
    // white-hot is monotonic: hotter is never darker
    let prev = -1;
    for (let k = -45; k <= 65; k += 0.25) {
      const g = irDisplay(agc, k);
      expect(g).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = g;
    }
    // the fire at the top of the display, the field's middle in the mid-greys
    expect(irDisplay(agc, 60)).toBeCloseTo(SENSOR_AGC.displayHigh, 2);
    expect(Math.abs(irDisplay(agc, 10) - 0.5)).toBeLessThan(0.1);
    // a straight line over the range would leave the 20 K field a fifth of the grey levels;
    // equalized, it takes most of them, and equal steps of the uniform field look equal
    const field = irDisplay(agc, 20) - irDisplay(agc, 0);
    expect(field).toBeGreaterThan(0.6);
    expect(field).toBeLessThan(SENSOR_AGC.displayHigh - SENSOR_AGC.displayLow);
    const step1 = irDisplay(agc, 6) - irDisplay(agc, 2);
    const step2 = irDisplay(agc, 16) - irDisplay(agc, 12);
    expect(Math.abs(step1 - step2)).toBeLessThan(0.1 * step1);
  });

  it('infrared: the level control keeps the bulk mid-grey with the outliers on one side', () => {
    // a warm field (19 K) with a hot road in a corner (3 %, 25 K) and a small cold hull (0.1 %)
    const values: number[] = [];
    for (let i = 0; i < N; i++) values.push(i < 4 ? 8 : i < 0.03 * N ? 25 : 18.8 + (i % 7) * 0.07);
    const agc = createAgc('IR', 1.5);
    agcFromStats(agc, statsBytes(values, 'IR'), N, hist, counts);
    const field = irDisplay(agc, 19);
    expect(field).toBeGreaterThan(0.35);
    expect(field).toBeLessThan(0.65);
    // the cold hull below the range is black, the road white: both stand out from the field
    expect(irDisplay(agc, 8)).toBeLessThan(SENSOR_AGC.displayLow + 0.02);
    expect(irDisplay(agc, 25)).toBeGreaterThan(field + 0.25);
    // and the other way round: cold ground (1 K) with hot engines (2 %, 30 K)
    const dawn: number[] = [];
    for (let i = 0; i < N; i++) dawn.push(i < 0.02 * N ? 30 : 0.7 + (i % 9) * 0.07);
    const cold = createAgc('IR', 1.5);
    agcFromStats(cold, statsBytes(dawn, 'IR'), N, hist, counts);
    const ground = irDisplay(cold, 1);
    expect(ground).toBeGreaterThan(0.3);
    expect(ground).toBeLessThan(0.65);
    expect(irDisplay(cold, 30)).toBeGreaterThan(0.85);
  });

  it('infrared: the plateau keeps a large uniform background from taking all the levels', () => {
    // 90 % of the picture at one temperature (a field), 10 % spread over 2…12 K (vehicles, trees)
    const values: number[] = [];
    for (let i = 0; i < N; i++) values.push(i < 0.9 * N ? 0 : 2 + (10 * (i % 410)) / 409);
    const agc = createAgc('IR');
    agcFromStats(agc, statsBytes(values, 'IR'), N, hist, counts);
    // plain equalization would give the spread part 10 % of the levels (and the background 90 %)
    const spread = irDisplay(agc, 12) - irDisplay(agc, 2);
    expect(spread).toBeGreaterThan(0.5);
    // the curve is the plateau-clipped cumulative histogram mixed with a straight line
    const lut = new Float32Array(LUT_SIZE);
    equalize(statsBytes(values, 'IR'), N, agc.lo, agc.hi, agc.minSpan, counts, lut);
    expect(Array.from(lut)).toEqual(Array.from(agc.targetLut));
    for (let i = 1; i < LUT_SIZE; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    expect(lut[0]).toBeGreaterThan(0);
    expect(lut[LUT_SIZE - 1]).toBeLessThan(1);
  });

  it('infrared: the curve is never steeper than the maximum gain (contrast limit)', () => {
    // a uniform field with the detector's noise (0.16 K rms) fills the picture, a cold hull 2 %
    const minSpan = irMinSpanForNoise(0.16);
    expect(minSpan).toBeCloseTo(SENSOR_AGC.irNoiseSpan * 0.16, 9);
    let r = 7;
    const gauss = () => {
      // a deterministic normal deviate (Box–Muller on an LCG)
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      const u1 = Math.max(1e-9, r / 0x7fffffff);
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos((2 * Math.PI * r) / 0x7fffffff);
    };
    const values: number[] = [];
    for (let i = 0; i < N; i++) values.push(i < 0.02 * N ? 6 : 19 + 0.16 * gauss());
    const agc = createAgc('IR', minSpan);
    agcFromStats(agc, statsBytes(values, 'IR'), N, hist, counts);
    const maxGain = (SENSOR_AGC.displayHigh - SENSOR_AGC.displayLow) / minSpan;
    const span = agc.hi - agc.lo;
    for (let k = agc.lo; k < agc.hi; k += span / 400) {
      const slope = (irDisplay(agc, k + span / 400) - irDisplay(agc, k)) / (span / 400);
      expect(slope).toBeLessThanOrEqual(maxGain * 1.0001);
    }
    // so the field's noise shows at most 1/irNoiseSpan of the display range (rms)
    const noise = 0.16 * maxGain;
    expect(noise).toBeLessThanOrEqual(
      (SENSOR_AGC.displayHigh - SENSOR_AGC.displayLow) / SENSOR_AGC.irNoiseSpan + 1e-9,
    );
    // the cold hull still stands out against the field
    expect(irDisplay(agc, 19) - irDisplay(agc, 6)).toBeGreaterThan(0.4);
    // the shares still sum to the whole display range: the last entry is the centre of the last
    // bin, whose share is at most the cap
    const cap = span / LUT_SIZE / minSpan;
    expect(agc.targetLut[LUT_SIZE - 1]).toBeLessThan(1);
    expect(1 - agc.targetLut[LUT_SIZE - 1]).toBeLessThanOrEqual(0.5 * cap + 1e-6);
  });

  it('infrared: a uniform scene gets the maximum gain; a very wide one the minimum', () => {
    const agc = createAgc('IR');
    agcFromStats(agc, statsBytes(new Array(N).fill(3), 'IR'), N, hist, counts);
    expect(agc.hi - agc.lo).toBeCloseTo(SENSOR_AGC.irMinSpan, 2);
    expect(agc.lo).toBeLessThan(3);
    expect(agc.hi).toBeGreaterThan(3);
    const wide = createAgc('IR');
    const v: number[] = [];
    for (let i = 0; i < N; i++) v.push(-100 + (i / (N - 1)) * 220);
    agcFromStats(wide, statsBytes(v, 'IR'), v.length, hist, counts);
    expect(wide.hi - wide.lo).toBeCloseTo(SENSOR_AGC.irMaxSpan, 2);
    // the hot end is kept (fires and engines are what the pilot looks for)
    expect(wide.hi).toBeGreaterThan(119);
  });

  it('settles with its time constant after a change', () => {
    const agc = createAgc('IR');
    agcFromStats(
      agc,
      statsBytes(
        new Array(N).fill(0).map((_, i) => (i % 100) / 10),
        'IR',
      ),
      N,
      hist,
      counts,
    );
    const lo0 = agc.lo;
    const v = new Array(N).fill(0).map((_, i) => 20 + (i % 100) / 10);
    agcFromStats(agc, statsBytes(v, 'IR'), N, hist, counts);
    expect(agc.lo).toBeCloseTo(lo0, 6); // no snap after the first statistics
    stepAgc(agc, SENSOR_AGC.timeConstant);
    expect((agc.lo - lo0) / (agc.targetLo - lo0)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(agc.settled).toBe(false);
    for (let i = 0; i < 60; i++) stepAgc(agc, 0.1);
    expect(agc.settled).toBe(true);
  });

  it('television: average metering puts the median mid-grey, the pedestal takes part of the dark end', () => {
    const agc = createAgc('TV');
    // daylit ground, 0.02 … 0.10 (median 0.06)
    const v: number[] = [];
    for (let i = 0; i < N; i++) v.push(0.02 + (0.08 * (i % 512)) / 511);
    agcFromStats(agc, statsBytes(v, 'TV'), v.length, hist, counts);
    expect((agc.exposure * 0.06) / SENSOR_AGC.tvMidLevel).toBeCloseTo(1, 1);
    const lo = 0.02 + 0.08 * SENSOR_AGC.tvLowQuantile;
    expect(agc.black / (SENSOR_AGC.tvBlackStretch * lo * agc.exposure)).toBeCloseTo(1, 1);
    const mid = tvDisplay(agc, 0.06);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.65);
    // darker things stay darker: a vehicle at half the ground's luminance is dark grey, not black
    const vehicle = tvDisplay(agc, 0.03);
    expect(vehicle).toBeLessThan(mid - 0.1);
    expect(vehicle).toBeGreaterThan(0.1);
  });

  it('television: a bright patch (sky, concrete) limits the exposure; a dark scene meets the gain limit', () => {
    const bright = createAgc('TV');
    // 95 % ground at 0.06, 5 % sky at 0.6: the 98th percentile is the sky, held at full scale
    const v: number[] = [];
    for (let i = 0; i < N; i++) v.push(i < 0.95 * N ? 0.06 : 0.6);
    agcFromStats(bright, statsBytes(v, 'TV'), N, hist, counts);
    expect(bright.exposure * 0.6).toBeCloseTo(1, 1);
    expect(tvDisplay(bright, 0.6)).toBeGreaterThan(0.95);
    expect(tvDisplay(bright, 0.06)).toBeLessThan(0.45);
    const dark = createAgc('TV');
    agcFromStats(dark, statsBytes(new Array(N).fill(1e-5), 'TV'), N, hist, counts);
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
      const sun = (
        m.createSunState as unknown as () => { sinElevation: number; tvLight: number }
      )();
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
      pictureEffectivePixels(
        size,
        fov / zoom,
        zoom,
        TGP.imagePixels,
        SENSOR_OPTICS.podFlirWavelengthUm,
        SENSOR_OPTICS.podApertureM,
      );
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
    const tv = pictureEffectivePixels(
      size,
      TGP.fovNarrow / 8,
      8,
      TGP.imagePixels,
      SENSOR_OPTICS.ccdWavelengthUm,
      SENSOR_OPTICS.podApertureM,
    );
    expect(tv).toBeGreaterThan(z8);
  });
});

describe('picture point-spread function', () => {
  it('is at least the pixel area, grows with diffraction and blur, and with magnification', () => {
    // a perfect, steady lens: only the detector pixel's own area (a box: σ = 1/√12)
    expect(picturePsfPixels(0.01, 256, 1e-9, 10, 0)).toBeCloseTo(1 / Math.sqrt(12), 6);
    const pod = (fov: number, n = 256) =>
      picturePsfPixels(
        fov,
        n,
        SENSOR_OPTICS.podFlirWavelengthUm,
        SENSOR_OPTICS.podApertureM,
        SENSOR_OPTICS.podBlurRad,
      );
    // the narrow field: mostly the pixel; zoomed ×2: the optics and the jitter show
    const x1 = pod(TGP.fovNarrow);
    const x2 = pod(TGP.fovNarrow / 2);
    expect(x1).toBeGreaterThan(0.29);
    expect(x1).toBeLessThan(0.45);
    expect(x2).toBeGreaterThan(x1);
    expect(x2).toBeLessThan(0.8);
    // the long-wave Maverick through its smaller window is softer than the pod at the same field
    const mav = picturePsfPixels(
      MAVERICK.fovNarrow,
      192,
      SENSOR_OPTICS.maverickIrWavelengthUm,
      SENSOR_OPTICS.maverickApertureM,
      SENSOR_OPTICS.maverickBlurRad,
    );
    expect(mav).toBeGreaterThan(pod(MAVERICK.fovNarrow, 192));
  });
});

describe('the cameras on the real sensors module (integration)', () => {
  /** A flight over flat ground, the tank hunter loadout, run long enough for the sensors' steps. */
  function flying(): Sim {
    const sim = createSim({
      seed: 3,
      terrain: createFlatTerrain(0),
      scenario: 'empty',
      start: { x: 0, z: 0, agl: 2400, heading: 0, speed: 130 },
    });
    runSim(sim, 0.5);
    return sim;
  }

  it('pod: at the head the sensors module computes, centred on its ground point, with its fov', (ctx) => {
    const sim = flying();
    const tgp = sim.sensors.tgp;
    // the foundation stand-in computes no head and no ground point: skip while it is in place
    if (!tgp.ready || !tgp.pointValid || tgp.head.lengthSq() === 0) ctx.skip();
    const pose = createSensorCameraPose();
    expect(tgpCameraPose(sim, pose)).toBe(true);
    expect(pose.position.distanceTo(tgp.head)).toBeLessThan(1e-9);
    // the sensors module's head is where this module's own mount puts the pod's window
    const mount = mountBody(podStation(sim), SENSOR_MOUNTS.podHead, new Vector3())!
      .applyQuaternion(sim.aircraft.orientation)
      .add(sim.aircraft.position);
    expect(mount.distanceTo(tgp.head)).toBeLessThan(0.5);
    const c = ndc(cameraOf(pose), tgp.point);
    expect(Math.abs(c.x)).toBeLessThan(1e-6);
    expect(Math.abs(c.y)).toBeLessThan(1e-6);
    expect(pose.fov).toBeCloseTo(tgp.fov, 12);
    expect(tgpPictureStatus(sim)).toBe('OK');
  });

  it('Maverick: at the selected seeker head, along its line of sight, with its fov and band', (ctx) => {
    const sim = flying();
    const s = sim.sensors.mavericks[sim.sensors.selectedMaverick];
    if (!s || s.head.lengthSq() === 0 || !(s.fovAngle > 0)) ctx.skip();
    const pose = createSensorCameraPose();
    expect(maverickCameraPose(sim, pose)).toBe(true);
    expect(pose.position.distanceTo(s.head)).toBeLessThan(1e-9);
    if (!s.locked) expect(pose.direction.distanceTo(s.los)).toBeLessThan(1e-9);
    expect(pose.fov).toBeCloseTo(s.fovAngle, 12);
    expect(maverickPicture(sim, sim.sensors.selectedMaverick)).toBe(
      s.band === 'TV' ? 'CCD' : s.picture,
    );
    expect(maverickPictureStatus(sim)).toBe(
      s.powered && s.align <= 0 ? 'OK' : s.powered ? 'ALIGN' : 'OFF',
    );
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
