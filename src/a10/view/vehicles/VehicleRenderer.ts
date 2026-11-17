/**
 * Draws `sim.targets.vehicles` every frame with one InstancedMesh per kind and level of detail
 * (detailed models within ~800 m at the normal field of view, simple ones beyond; nothing past
 * the haze), plus contact shadows, and emits their dust and exhaust. Damage states, thrown
 * turrets and thrown tracks are per-instance data for the vehicle material (material.ts).
 *
 * Per-vehicle view state (distance driven for the wheels and tracks, the latest heavy hit, the
 * estimated health of each track, which decides a thrown track) lives in a map keyed by vehicle
 * id, created when a vehicle first appears.
 */
import {
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Camera,
  type PerspectiveCamera,
} from 'three';
import { quaternionFromAttitude } from '../../core/frames';
import type { Vehicle, VehicleKind } from '../../core/targets/types';
import type { Sim, SimEvent } from '../../core/types';
import { KILL_RULES, VEHICLE_MODELS, VEHICLE_SHAPES } from '../../data/vehicles';
import type { ParticleSystem } from '../effects/ParticleSystem';
import type { A10Quality } from '../quality';
import { createEmitterState, emitVehicle, type EmitterState } from './emitters';
import { GroundShadows } from './groundShadows';
import {
  createVehicleDepthMaterial,
  createVehicleMaterial,
  FLAG,
  vehicleUniforms,
} from './material';
import { buildVehicleGeometry, VEHICLE_KINDS } from './models';

/** Detailed models within this distance at the default 62° field of view (m). */
export const LOD_DISTANCE = 800;
/** Vehicles further than this (at the default field of view) are below a pixel: not drawn. */
const DRAW_DISTANCE = 16000;
const TAN_DEFAULT_HALF_FOV = Math.tan((31 * Math.PI) / 180);

interface Batch {
  kind: VehicleKind;
  lod: 0 | 1;
  geometry: BufferGeometry;
  mesh: InstancedMesh;
  capacity: number;
  n: number;
  anim: InstancedBufferAttribute;
  state: InstancedBufferAttribute;
  heat: InstancedBufferAttribute;
  spot: InstancedBufferAttribute;
  wear: InstancedBufferAttribute;
  attrs: InstancedBufferAttribute[];
}

interface ViewState {
  stamp: number;
  distance: number;
  lod: 0 | 1;
  seed: number;
  spot: Vector3;
  spotR: number;
  /**
   * Tracked vehicles: estimated health of the left and right track (1 intact … 0), kept from
   * the public running-gear health (the weighted mean of the two track boxes) and the side of
   * the hits that lowered it (see `trackEstimate`).
   */
  trackL: number;
  trackR: number;
  /** `components.runningGear` when last seen. */
  runningSeen: number;
  /** This frame's hits weighted by their nearness to each track (attribution of a drop). */
  hitL: number;
  hitR: number;
  emit: EmitterState;
}

/** The two track boxes of a tracked class (hull frame) and their weights in the running gear. */
interface TrackBoxes {
  left: { min: readonly number[]; max: readonly number[]; weight: number };
  right: { min: readonly number[]; max: readonly number[]; weight: number };
}

/**
 * Track boxes per class, from the targets data (VEHICLE_MODELS): only classes whose running gear
 * is exactly a left and a right track, so `components.runningGear` is their weighted mean.
 */
const TRACK_BOXES = new Map<VehicleKind, TrackBoxes>();
for (const kind of Object.keys(VEHICLE_MODELS) as VehicleKind[]) {
  const boxes = VEHICLE_MODELS[kind].components.filter((c) => c.id === 'runningGear');
  const left = boxes.find((c) => c.name === 'left track');
  const right = boxes.find((c) => c.name === 'right track');
  if (boxes.length === 2 && left && right) {
    TRACK_BOXES.set(kind, {
      left: { min: left.min, max: left.max, weight: left.weight },
      right: { min: right.min, max: right.max, weight: right.weight },
    });
  }
}

/** Distance from a hull-frame point to a box, m. */
function boxDistance(p: Vector3, min: readonly number[], max: readonly number[]): number {
  const dx = Math.max(min[0] - p.x, 0, p.x - max[0]);
  const dy = Math.max(min[1] - p.y, 0, p.y - max[1]);
  const dz = Math.max(min[2] - p.z, 0, p.z - max[2]);
  return Math.hypot(dx, dy, dz);
}

/**
 * How strongly a hit or burst at hull-frame point `p` bears on a track: 1/(d + 0.25 m)², the
 * inverse-square fall-off of blast and fragments with distance d to the track box.
 */
function trackWeight(p: Vector3, box: TrackBoxes['left']): number {
  const d = boxDistance(p, box.min, box.max) + 0.25;
  return 1 / (d * d);
}

const _q = new Quaternion();
const _qi = new Quaternion();
const _m = new Matrix4();
const _m2 = new Matrix4();
const _one = new Vector3(1, 1, 1);
const _p = new Vector3();
const _e = new Euler();

function hasTurret(kind: VehicleKind): boolean {
  return VEHICLE_SHAPES[kind].turret !== null;
}

function isTracked(kind: VehicleKind): boolean {
  return VEHICLE_SHAPES[kind].running.type === 'tracks';
}

export interface VehicleRenderStats {
  drawn: number;
  near: number;
  drawCalls: number;
  triangles: number;
}

export class VehicleRenderer {
  readonly root = new Group();
  readonly stats: VehicleRenderStats = { drawn: 0, near: 0, drawCalls: 0, triangles: 0 };
  private readonly material = createVehicleMaterial();
  private readonly depthMaterial = createVehicleDepthMaterial();
  private readonly batches: Batch[] = [];
  private readonly byKey = new Map<string, Batch>();
  private readonly states = new Map<number, ViewState>();
  private readonly shadows = new GroundShadows();
  private detail = -1;
  private frame = 0;
  private cleanupClock = 0;
  private castShadows = false;

  constructor() {
    this.root.name = 'a10-vehicles';
    this.root.add(this.shadows.mesh);
  }

  private batch(kind: VehicleKind, lod: 0 | 1): Batch {
    const key = kind + lod;
    let b = this.byKey.get(key);
    if (!b) {
      const geometry = buildVehicleGeometry(kind, lod, this.detail);
      b = this.makeBatch(kind, lod, geometry, 16);
      this.byKey.set(key, b);
      this.batches.push(b);
    }
    return b;
  }

  private makeBatch(
    kind: VehicleKind,
    lod: 0 | 1,
    geometry: BufferGeometry,
    capacity: number,
  ): Batch {
    const attr = (name: string) => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      a.setUsage(DynamicDrawUsage);
      geometry.setAttribute(name, a);
      return a;
    };
    const anim = attr('iAnim');
    const state = attr('iState');
    const heat = attr('iHeat');
    const spot = attr('iSpot');
    const wear = attr('iWear');
    const mesh = new InstancedMesh(geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.customDepthMaterial = this.depthMaterial;
    mesh.frustumCulled = false;
    mesh.name = `a10-vehicles-${kind}-lod${lod}`;
    mesh.count = 0;
    mesh.castShadow = lod === 0 && this.castShadows;
    mesh.receiveShadow = lod === 0 && this.castShadows;
    this.root.add(mesh);
    return {
      kind,
      lod,
      geometry,
      mesh,
      capacity,
      n: 0,
      anim,
      state,
      heat,
      spot,
      wear,
      attrs: [anim, state, heat, spot, wear],
    };
  }

  /** Double a batch's capacity, keeping what was written this frame. */
  private grow(b: Batch): void {
    const cap = b.capacity * 2;
    const old = b.mesh;
    const oldArrays = b.attrs.map((a) => a.array as Float32Array);
    const oldMatrices = old.instanceMatrix.array as Float32Array;
    this.root.remove(old);
    old.dispose();
    const nb = this.makeBatch(b.kind, b.lod, b.geometry, cap);
    (nb.mesh.instanceMatrix.array as Float32Array).set(oldMatrices);
    nb.attrs.forEach((a, k) => (a.array as Float32Array).set(oldArrays[k]));
    nb.n = b.n;
    Object.assign(b, nb);
  }

  /** Rebuild every model (quality detail changed). */
  private rebuild(detail: number): void {
    this.detail = detail;
    for (const b of this.batches) {
      this.root.remove(b.mesh);
      b.mesh.dispose();
      b.geometry.dispose();
    }
    this.batches.length = 0;
    this.byKey.clear();
  }

  /**
   * Remember where heavy hits land (scorched patches), and weigh every hit and burst of the frame
   * by how near it is to each track: if the running gear loses health this frame, those weights
   * say which track lost it (`trackEstimate`).
   */
  onEvents(events: readonly SimEvent[], sim: Sim): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'roundImpact' && e.target.kind === 'vehicle') {
        const v = findVehicle(sim, e.target.vehicleId);
        if (!v) continue;
        const st = this.state(v);
        const heavy = e.round === 1 || e.outcome === 'penetrated' || e.outcome === 'burst';
        this.toLocal(v, e.position.x, e.position.y, e.position.z, _p);
        if (heavy || st.spotR === 0) {
          st.spot.copy(_p);
          st.spotR = e.round === 1 ? 0.75 : e.outcome === 'penetrated' ? 0.55 : 0.35;
        }
        const part = e.target.part;
        if (part === 'tracks' || part === 'wheels') {
          // a round on a track run can only have hurt that track (or what is behind it)
          if (_p.x < 0) st.hitL += 1e6;
          else st.hitR += 1e6;
        } else this.weighTrackHit(v, st, _p);
      } else if (e.type === 'detonation') {
        if (e.vehicleId > 0) {
          const v = findVehicle(sim, e.vehicleId);
          if (v) {
            const st = this.state(v);
            this.toLocal(v, e.position.x, e.position.y, e.position.z, st.spot);
            st.spotR = Math.min(2.2, 0.6 + 0.35 * Math.cbrt(Math.max(0.01, e.charge)));
          }
        }
        // blast and fragments reach the running gear of every tracked vehicle around the burst
        const reach = 30 + 25 * Math.cbrt(Math.max(0.01, e.charge));
        const list = sim.targets.vehicles;
        for (let k = 0; k < list.length; k++) {
          const v = list[k];
          if (!TRACK_BOXES.has(v.kind)) continue;
          const p = e.position;
          if (Math.abs(p.x - v.position.x) > reach || Math.abs(p.z - v.position.z) > reach)
            continue;
          this.weighTrackHit(v, this.state(v), this.toLocal(v, p.x, p.y, p.z, _p));
        }
      }
    }
  }

  /** Add a hit or burst at hull-frame point `p` to the frame's attribution weights. */
  private weighTrackHit(v: Vehicle, st: ViewState, p: Vector3): void {
    const boxes = TRACK_BOXES.get(v.kind);
    if (!boxes) return;
    st.hitL += trackWeight(p, boxes.left);
    st.hitR += trackWeight(p, boxes.right);
  }

  /**
   * Keep each track's estimated health. The public running gear of a tracked class is the
   * weighted mean of its two track boxes, so a drop Δ in it is a loss of Δ·(wL + wR)/w on the
   * track(s) that were hit; this frame's hits (weighted by nearness, `onEvents`) say which, and a
   * drop with no hit to explain it is shared evenly (it then throws no track on its own). A box
   * cannot fall below 0, so a loss attributed beyond that goes to the other track.
   */
  private trackEstimate(v: Vehicle, st: ViewState): void {
    const boxes = TRACK_BOXES.get(v.kind);
    const rg = v.components.runningGear;
    if (boxes && Number.isFinite(rg)) {
      const drop = st.runningSeen - rg;
      if (drop > 1e-6) {
        const wl = boxes.left.weight;
        const wr = boxes.right.weight;
        const hits = st.hitL + st.hitR;
        const fL = hits > 0 ? st.hitL / hits : wl / (wl + wr);
        // a loss of dL on the left and dR on the right lowers the mean by (wl·dL + wr·dR)/(wl+wr)
        let lossL = (drop * (wl + wr) * fL) / wl;
        let lossR = (drop * (wl + wr) * (1 - fL)) / wr;
        if (lossL > st.trackL) {
          lossR += ((lossL - st.trackL) * wl) / wr;
          lossL = st.trackL;
        }
        if (lossR > st.trackR) {
          lossL = Math.min(st.trackL, lossL + ((lossR - st.trackR) * wr) / wl);
          lossR = st.trackR;
        }
        st.trackL -= lossL;
        st.trackR -= lossR;
      } else if (drop < -1e-6) {
        // repaired or rearmed: start again from the mean
        st.trackL = rg;
        st.trackR = rg;
      }
      st.runningSeen = rg;
    }
    st.hitL = 0;
    st.hitR = 0;
  }

  private toLocal(v: Vehicle, x: number, y: number, z: number, out: Vector3): Vector3 {
    quaternionFromAttitude(v.heading, v.pitch, v.roll, _qi).invert();
    return out.set(x - v.position.x, y - v.position.y, z - v.position.z).applyQuaternion(_qi);
  }

  private state(v: Vehicle): ViewState {
    let st = this.states.get(v.id);
    if (!st) {
      st = {
        stamp: this.frame,
        distance: 0,
        lod: 1,
        seed: ((v.id * 2654435761) >>> 0) / 4294967296,
        spot: new Vector3(),
        spotR: 0,
        // vehicles start intact: damage the renderer sees later is a drop from 1
        trackL: 1,
        trackR: 1,
        runningSeen: 1,
        hitL: 0,
        hitR: 0,
        emit: createEmitterState(),
      };
      this.states.set(v.id, st);
    }
    return st;
  }

  /**
   * One frame: place every vehicle, choose its level of detail, write its damage state, emit its
   * dust and exhaust. `dt` is simulated seconds (0 while paused).
   */
  update(
    sim: Sim | null,
    dt: number,
    camera: Camera,
    quality: A10Quality,
    ps: ParticleSystem | null,
    detailFx: number,
  ): void {
    this.frame++;
    if (this.detail !== quality.detail) this.rebuild(quality.detail);
    const cast = quality.shadows && quality.level === 'high';
    if (cast !== this.castShadows) {
      this.castShadows = cast;
      for (const b of this.batches) {
        b.mesh.castShadow = b.lod === 0 && cast;
        b.mesh.receiveShadow = b.lod === 0 && cast;
      }
    }
    for (const b of this.batches) b.n = 0;
    this.shadows.begin();
    this.stats.drawn = 0;
    this.stats.near = 0;
    if (!sim) {
      this.finish();
      return;
    }
    vehicleUniforms.uVehicleTime.value = sim.time;
    const fov = (camera as PerspectiveCamera).fov ?? 62;
    const zoom = Math.tan((fov * Math.PI) / 360) / TAN_DEFAULT_HALF_FOV;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const terrain = sim.world.terrain;
    const list = sim.targets.vehicles;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const st = this.state(v);
      st.stamp = this.frame;
      st.distance += v.speed * dt;
      // every vehicle, drawn or not, so no drop in its running gear goes unattributed
      this.trackEstimate(v, st);
      const d = Math.hypot(v.position.x - cx, v.position.y - cy, v.position.z - cz);
      const eff = d * zoom;
      if (ps) emitVehicle(ps, terrain, v, st.emit, dt, d, detailFx);
      if (eff > DRAW_DISTANCE && !v.thrownTurret) continue;
      // hysteresis so a vehicle at the boundary does not flicker between models
      const lod: 0 | 1 = eff < LOD_DISTANCE - 40 ? 0 : eff > LOD_DISTANCE + 40 ? 1 : st.lod;
      st.lod = lod;
      this.place(v, st, lod, sim.time);
      if (lod === 0) this.stats.near++;
      this.stats.drawn++;
      if (eff < 9000) {
        const s = VEHICLE_SHAPES[v.kind];
        const height = s.hullClearance + s.hullHeight + (s.turret ? s.turret.height : 0);
        const opacity = v.kind === 'panel' ? 0.35 : v.condition === 'catastrophic' ? 0.7 : 0.55;
        this.shadows.add(
          v.position.x,
          v.position.y,
          v.position.z,
          v.heading,
          s.hullWidth,
          Math.max(1.2, s.hullLength),
          height,
          opacity,
        );
      }
    }
    this.finish();
    // forget vehicles that have gone (iterating a Map allocates a little: every few seconds only)
    this.cleanupClock += dt;
    if (this.cleanupClock > 4) {
      this.cleanupClock = 0;
      for (const [id, st] of this.states) if (st.stamp !== this.frame) this.states.delete(id);
    }
  }

  /**
   * The damage flags (FLAG) the vehicle is drawn with this frame. A thrown track only for a track
   * that has failed (TE-5): an engine kill, a dead driver or a catastrophic kill leaves both
   * tracks on, and only the side that failed is drawn off.
   */
  damageFlags(v: Vehicle): number {
    const st = this.state(v);
    const kind = v.kind;
    let flags = 0;
    const wrecked = v.condition === 'destroyed' || v.condition === 'catastrophic';
    if (isTracked(kind) && v.mobilityKill && TRACK_BOXES.has(kind)) {
      // a failed track box always immobilises (its effect is 'mobility')
      if (st.trackL <= KILL_RULES.boxDead) flags |= FLAG.trackLeft;
      if (st.trackR <= KILL_RULES.boxDead) flags |= FLAG.trackRight;
    }
    if (kind === 'truckCargo' && wrecked) flags |= FLAG.tarpGone;
    const thrown = v.condition === 'catastrophic' && hasTurret(kind) ? v.thrownTurret : null;
    if (thrown) flags |= FLAG.turretGone;
    else if (v.condition === 'catastrophic') flags |= FLAG.gunBent;
    return flags;
  }

  private place(v: Vehicle, st: ViewState, lod: 0 | 1, time: number): void {
    const kind = v.kind;
    const s = VEHICLE_SHAPES[kind];
    const flags = this.damageFlags(v);
    const wrecked = v.condition === 'destroyed' || v.condition === 'catastrophic';
    const thrown = v.condition === 'catastrophic' && hasTurret(kind) ? v.thrownTurret : null;

    let char = 0;
    let scorch = 0;
    if (v.condition === 'damaged') scorch = 0.45;
    else if (v.condition === 'destroyed')
      char = 0.55 + 0.4 * Math.min(1, Math.max(0, time - v.conditionTime) / 25);
    else if (v.condition === 'catastrophic') char = 1;
    const gunElevation = wrecked ? -0.09 : 0;
    const hulk = kind === 'hulk';
    const rust = hulk ? 0.85 : 0.03 + 0.06 * st.seed;
    const dust = hulk ? 0.25 : 0.3 + 0.35 * st.seed;
    const fade = hulk ? 0.55 : 0.08 + 0.1 * st.seed;
    const f = v.fire;

    quaternionFromAttitude(v.heading, v.pitch, v.roll, _q);
    _m.compose(v.position, _q, _one);
    this.write(
      this.batch(kind, lod),
      _m,
      v.turretYaw,
      gunElevation,
      st.distance,
      flags,
      char,
      scorch,
      f,
      st.seed,
      v,
      st,
      rust,
      dust,
      fade,
    );

    if (thrown) {
      // the thrown turret: its own instance, turret only, gun bent, placed at the turret's pose
      const t = s.turret!;
      const top = s.hullClearance + s.hullHeight;
      _e.set(thrown.angle.x, thrown.angle.y, thrown.angle.z, 'XYZ');
      _q.setFromEuler(_e);
      _m.compose(thrown.position, _q, _one);
      _m2.makeTranslation(0, -(top + t.height * 0.45), -t.offsetZ);
      _m.multiply(_m2);
      this.write(
        this.batch(kind, lod),
        _m,
        0,
        -0.05,
        0,
        FLAG.turretOnly | FLAG.gunBent,
        1,
        0,
        f,
        st.seed,
        v,
        st,
        rust,
        dust,
        fade,
      );
    }
  }

  private write(
    b: Batch,
    m: Matrix4,
    yaw: number,
    elev: number,
    dist: number,
    flags: number,
    char: number,
    scorch: number,
    fire: number,
    seed: number,
    v: Vehicle,
    st: ViewState,
    rust: number,
    dust: number,
    fade: number,
  ): void {
    if (b.n >= b.capacity) this.grow(b);
    const i = b.n++;
    b.mesh.setMatrixAt(i, m);
    const o = i * 4;
    const A = b.anim.array as Float32Array;
    A[o] = yaw;
    A[o + 1] = elev;
    A[o + 2] = dist;
    A[o + 3] = flags;
    const S = b.state.array as Float32Array;
    S[o] = char;
    S[o + 1] = scorch;
    S[o + 2] = fire;
    S[o + 3] = seed;
    const H = b.heat.array as Float32Array;
    const h = v.heat;
    H[o] = h.engine + fire * 320;
    H[o + 1] = h.exhaust + fire * 320;
    H[o + 2] = h.running + fire * 160;
    H[o + 3] = h.hull + fire * 260;
    const P = b.spot.array as Float32Array;
    P[o] = st.spot.x;
    P[o + 1] = st.spot.y;
    P[o + 2] = st.spot.z;
    P[o + 3] = v.condition === 'intact' ? 0 : st.spotR;
    const W = b.wear.array as Float32Array;
    W[o] = rust;
    W[o + 1] = dust;
    W[o + 2] = fade;
    W[o + 3] = 0;
  }

  private finish(): void {
    let calls = 0;
    let tris = 0;
    for (const b of this.batches) {
      const n = b.n;
      b.mesh.count = n;
      if (n === 0) continue;
      calls++;
      tris += (b.geometry.getAttribute('position').count / 3) * n;
      b.mesh.instanceMatrix.clearUpdateRanges();
      b.mesh.instanceMatrix.addUpdateRange(0, n * 16);
      b.mesh.instanceMatrix.needsUpdate = true;
      for (let k = 0; k < b.attrs.length; k++) {
        const a = b.attrs[k];
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * 4);
        a.needsUpdate = true;
      }
    }
    this.shadows.end();
    this.stats.drawCalls = calls + (this.stats.drawn > 0 ? 1 : 0);
    this.stats.triangles = tris;
  }

  dispose(): void {
    for (const b of this.batches) {
      b.mesh.dispose();
      b.geometry.dispose();
    }
    this.batches.length = 0;
    this.byKey.clear();
    this.shadows.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.root.removeFromParent();
  }
}

function findVehicle(sim: Sim, id: number): Vehicle | null {
  const list = sim.targets.vehicles;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

export { VEHICLE_KINDS };
