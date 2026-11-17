/**
 * Where the sensor cameras are and where they look (pure, allocation-free, GPU-free).
 *
 * TARGETING POD. The camera sits at the pod's optical head: `tgp.head` when the sensors module
 * sets it (the very origin its line of sight and masking use), else the pod's station from
 * `sim.stores`, the pylon point and slope (data/geometry.ts) and the head offset
 * (sensorViewData.ts), carried by the aircraft's current pose. It looks at `tgp.point` while the
 * pod has a ground point (`pointValid`), else along `tgp.los`: aiming at the point keeps the
 * tracked point on the picture's centre pixel whatever small difference in origin there is (at
 * the narrowest field, 1 m of parallax at 5 km would be a dozen pixels). The full field of view
 * is `tgp.fov` (electronic zoom included). The picture is DEROTATED like the real pod's: the
 * horizon stays level and the far side of the scene is at the top; within about 14° of straight
 * down, where "far" loses its meaning, the aircraft's heading takes over as up (so the picture
 * turns smoothly — and turns over, as the real one does — when the aircraft passes overhead).
 *
 * MAVERICK. The camera sits at the selected missile's seeker window (`seeker.head`, else its
 * station) and looks along the seeker's line of sight (at the lock point while locked). The
 * seeker picture is NOT derotated: it rolls with the aircraft, as the missile's own video does.
 * Field of view: the seeker's `fovAngle`, else WIDE / NARROW from data/sensors.ts.
 *
 * The near plane is a share of the height above the ground (20–300 m): the aircraft's own
 * structure (17.5 m span) never shows, and the depth buffer keeps centimetre precision at the
 * target (the sensors module's `masked` decides when the airframe blocks the line of sight).
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { MaverickSeekerState, SensorPicture, TgpState } from '../../core/sensors/types';
import type { Sim } from '../../core/types';
import type { StoreType } from '../../core/weapons/types';
import { A10_GEOMETRY } from '../../data/geometry';
import { MAVERICK } from '../../data/sensors';
import { SENSOR_MOUNTS, SENSOR_OPTICS, SENSOR_RENDER } from './sensorViewData';

export interface SensorCameraPose {
  /** Camera position, world, m. */
  position: Vector3;
  /** Camera orientation (a three.js camera looks along its −Z with +Y up). */
  quaternion: Quaternion;
  /** Unit direction the camera looks along, world. */
  direction: Vector3;
  /** Full field of view of the (square) picture, rad. */
  fov: number;
  near: number;
  far: number;
  /** Height of the camera above the ground under it, m. */
  agl: number;
}

export function createSensorCameraPose(): SensorCameraPose {
  return {
    position: new Vector3(),
    quaternion: new Quaternion(),
    direction: new Vector3(0, 0, -1),
    fov: 0.07,
    near: SENSOR_RENDER.nearMin,
    far: SENSOR_RENDER.far,
    agl: 0,
  };
}

/** The pod's store type. */
export const POD_STORE: StoreType = 'AN/AAQ-28';

/** Looking down more steeply than these (−los.y), the heading blends into the picture's up. */
const NADIR_BLEND_START = Math.cos(14 * (Math.PI / 180));
const NADIR_BLEND_END = Math.cos(2 * (Math.PI / 180));
const MIN_FOV = 1e-4;
const MAX_FOV = 1.2;
/** A head position farther than this from the aircraft is not trusted (unset state), m. */
const HEAD_RANGE = 40;

/** Fields the sensors module adds to its state (read when present). */
type TgpExtra = TgpState & { head?: Vector3 };
type SeekerExtra = MaverickSeekerState & {
  head?: Vector3;
  fovAngle?: number;
  type?: unknown;
  band?: unknown;
  picture?: unknown;
};

const _offset = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _back = new Vector3();
const _fwd = new Vector3();
const _ref = new Vector3();
const _basis = new Matrix4();
const WORLD_UP = new Vector3(0, 1, 0);

/** Station (1..11) carrying the targeting pod, or −1. */
export function podStation(sim: Sim): number {
  const stations = sim.stores.stations;
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    if (st.rack === POD_STORE) return st.station;
    for (let k = 0; k < st.stores.length; k++) if (st.stores[k] === POD_STORE) return st.station;
  }
  return -1;
}

/**
 * Body-frame position of a window mounted `mount` (store frame) under `station`'s pylon point,
 * tilted with the pylon's slope. Returns `out`, or null for a station that does not exist.
 */
export function mountBody(
  station: number,
  mount: { x: number; y: number; z: number },
  out: Vector3,
): Vector3 | null {
  const p = A10_GEOMETRY.stations[station];
  if (!p) return null;
  const a = A10_GEOMETRY.stationPitch[station] ?? 0;
  // rotation about +X by the pylon slope (negative = nose down)
  const c = Math.cos(a);
  const s = Math.sin(a);
  const y = mount.y * c - mount.z * s;
  const z = mount.y * s + mount.z * c;
  return out.set(p.x + mount.x, p.y + y, p.z + z);
}

/** World position of a body-frame point on the aircraft (current simulation pose). */
function bodyToWorld(sim: Sim, body: Vector3, out: Vector3): Vector3 {
  const ac = sim.aircraft;
  return out.copy(body).applyQuaternion(ac.orientation).add(ac.position);
}

/** A head position the sensors module set (finite, on the aircraft). */
function trustedHead(sim: Sim, head: Vector3 | undefined): head is Vector3 {
  return (
    head !== undefined &&
    Number.isFinite(head.x) &&
    Number.isFinite(head.y) &&
    Number.isFinite(head.z) &&
    head.distanceToSquared(sim.aircraft.position) < HEAD_RANGE * HEAD_RANGE
  );
}

/** Near plane for a camera `agl` metres above the ground. */
export function nearPlaneFor(agl: number): number {
  const n = SENSOR_RENDER.nearAglShare * Math.max(0, agl);
  return Math.min(SENSOR_RENDER.nearMax, Math.max(SENSOR_RENDER.nearMin, n));
}

/**
 * Detector pixels across a picture of full field `fov` (rad) under electronic zoom `zoom`: the
 * detector spans the optical field (fov × zoom), and no element can be finer than the optics'
 * diffraction limit (Rayleigh, 1.22 λ / D). Capped at the picture size `size`; fewer pixels than
 * that means the picture is an enlargement of the detector's — the blur of the zoom limits.
 */
export function pictureEffectivePixels(
  size: number,
  fov: number,
  zoom: number,
  detectorPixels: number,
  wavelengthUm: number,
  apertureM: number,
): number {
  const optical = fov * Math.max(1, zoom);
  const diffraction = (SENSOR_OPTICS.rayleigh * wavelengthUm * 1e-6) / apertureM;
  const element = Math.max(optical / Math.max(1, detectorPixels), diffraction);
  return Math.max(16, Math.min(size, Math.round(fov / element)));
}

/**
 * Orient `out.quaternion` to look along `out.direction` with `upRef` as the picture's up (it need
 * not be perpendicular; `fallback` serves when it is parallel to the direction).
 */
function orient(out: SensorCameraPose, upRef: Vector3, fallback: Vector3): void {
  const d = out.direction;
  _up.copy(upRef).addScaledVector(d, -upRef.dot(d));
  if (_up.lengthSq() < 1e-10) _up.copy(fallback).addScaledVector(d, -fallback.dot(d));
  if (_up.lengthSq() < 1e-10) _up.set(0, 0, -1).addScaledVector(d, d.z);
  _right.crossVectors(d, _up).normalize();
  _up.crossVectors(_right, d).normalize();
  _back.copy(d).negate();
  _basis.makeBasis(_right, _up, _back);
  out.quaternion.setFromRotationMatrix(_basis);
}

function finishPose(sim: Sim, out: SensorCameraPose, fov: number): void {
  const ground = sim.world.terrain.heightAt(out.position.x, out.position.z);
  out.agl = out.position.y - ground;
  out.near = nearPlaneFor(out.agl);
  out.far = SENSOR_RENDER.far;
  out.fov = Math.min(MAX_FOV, Math.max(MIN_FOV, Number.isFinite(fov) ? fov : 0.07));
}

/**
 * The targeting pod's camera from the simulation (false when no pod is carried). The picture's
 * centre is `tgp.point` while it is valid, else the line of sight `tgp.los`.
 */
export function tgpCameraPose(sim: Sim, out: SensorCameraPose): boolean {
  const station = podStation(sim);
  if (station < 0) return false;
  const tgp = sim.sensors.tgp as TgpExtra;
  if (trustedHead(sim, tgp.head)) out.position.copy(tgp.head);
  else if (mountBody(station, SENSOR_MOUNTS.podHead, _offset)) bodyToWorld(sim, _offset, out.position);
  else return false;
  const d = out.direction;
  if (tgp.pointValid) d.subVectors(tgp.point, out.position);
  if (!tgp.pointValid || d.lengthSq() < 1) d.copy(tgp.los);
  if (d.lengthSq() < 1e-12) d.set(0, -1, 0);
  d.normalize();
  // picture up: world up (horizon level, far side up); near nadir the aircraft's heading
  _fwd.set(0, 0, -1).applyQuaternion(sim.aircraft.orientation);
  _fwd.y = 0;
  if (_fwd.lengthSq() > 1e-12) _fwd.normalize();
  const t = Math.min(1, Math.max(0, (-d.y - NADIR_BLEND_START) / (NADIR_BLEND_END - NADIR_BLEND_START)));
  _ref.copy(WORLD_UP).addScaledVector(_fwd, t * t * (3 - 2 * t));
  orient(out, _ref, _fwd);
  finishPose(sim, out, tgp.fov);
  return true;
}

/** The store type of seeker `index` (its missile on the station), default AGM-65D. */
export function maverickType(sim: Sim, index: number): StoreType {
  const seekers = sim.sensors.mavericks;
  const seeker = seekers[index] as SeekerExtra | undefined;
  if (!seeker) return 'AGM-65D';
  if (typeof seeker.type === 'string' && seeker.type.startsWith('AGM-65'))
    return seeker.type as StoreType;
  // the k-th seeker on its station belongs to the k-th missile there
  let k = 0;
  for (let i = 0; i < index; i++) if (seekers[i].station === seeker.station) k++;
  const stations = sim.stores.stations;
  for (let i = 0; i < stations.length; i++) {
    if (stations[i].station !== seeker.station) continue;
    const stores = stations[i].stores;
    let n = 0;
    let first: StoreType | null = null;
    for (let j = 0; j < stores.length; j++) {
      const s = stores[j];
      if (!s.startsWith('AGM-65')) continue;
      if (first === null) first = s;
      if (n === k) return s;
      n++;
    }
    return first ?? 'AGM-65D';
  }
  return 'AGM-65D';
}

/** Picture band of a Maverick variant: imaging infrared (D, G) or television (H, K). */
export function maverickBand(type: StoreType): 'IR' | 'TV' {
  return type === 'AGM-65H' || type === 'AGM-65K' ? 'TV' : 'IR';
}

/** Full field of view of a Maverick seeker by its setting, rad (data/sensors.ts MAVERICK). */
export function maverickFov(setting: 'WIDE' | 'NARROW'): number {
  return setting === 'NARROW' ? MAVERICK.fovNarrow : MAVERICK.fovWide;
}

/** The selected seeker's picture: its own polarity when it has one, else by its band. */
export function maverickPicture(sim: Sim, index: number): SensorPicture {
  const seeker = sim.sensors.mavericks[index] as SeekerExtra | undefined;
  const band =
    seeker && (seeker.band === 'IR' || seeker.band === 'TV')
      ? seeker.band
      : maverickBand(maverickType(sim, index));
  if (band === 'TV') return 'CCD';
  return seeker && seeker.picture === 'BHOT' ? 'BHOT' : 'WHOT';
}

/**
 * The selected Maverick seeker's camera (false when no missile is selected). Looks along the
 * seeker's line of sight, or at the lock point while locked; rolls with the aircraft.
 */
export function maverickCameraPose(sim: Sim, out: SensorCameraPose): boolean {
  const index = sim.sensors.selectedMaverick;
  const seeker = sim.sensors.mavericks[index] as SeekerExtra | undefined;
  if (!seeker) return false;
  if (trustedHead(sim, seeker.head)) out.position.copy(seeker.head);
  else if (mountBody(seeker.station, SENSOR_MOUNTS.maverickSeeker, _offset))
    bodyToWorld(sim, _offset, out.position);
  else return false;
  const d = out.direction;
  if (seeker.locked) d.subVectors(seeker.lockPoint, out.position);
  if (!seeker.locked || d.lengthSq() < 1) d.copy(seeker.los);
  if (d.lengthSq() < 1e-12) d.set(0, 0, -1).applyQuaternion(sim.aircraft.orientation);
  d.normalize();
  _ref.set(0, 1, 0).applyQuaternion(sim.aircraft.orientation);
  _fwd.set(0, 0, -1).applyQuaternion(sim.aircraft.orientation);
  orient(out, _ref, _fwd);
  const fov =
    typeof seeker.fovAngle === 'number' && seeker.fovAngle > 0
      ? seeker.fovAngle
      : maverickFov(seeker.fov);
  finishPose(sim, out, fov);
  return true;
}
