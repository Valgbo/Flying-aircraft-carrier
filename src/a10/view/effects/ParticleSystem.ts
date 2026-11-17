/**
 * Pooled particle system: every smoke puff, dust cloud, spark, flash and debris chunk in the
 * world is one particle here, drawn in ONE instanced draw call.
 *
 * - Structure-of-arrays pool, densely packed (slots 0..count-1 are live), fixed capacity, no
 *   allocation per frame. The live cap follows the quality preset (`budget`); when full, a new
 *   particle replaces the most faded of a few sampled ones, so fresh effects always show.
 * - Simulated on the CPU in simulated time (`dt` = frameInfo.simDt, so pause freezes it), with
 *   wind that grows with height like `windAt` (power law from the surface wind).
 * - Sorted back to front with a bucket sort on log depth every frame (premultiplied blending
 *   needs it for dark smoke over bright fire), written into instance attributes relative to a
 *   render origin near the camera (float precision), uploaded with update ranges.
 * - A particle may be born late (negative age): events and sub-frame emitters use that to place
 *   particles at their exact time inside the frame.
 */
import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Vector2,
  Vector3,
  type Camera,
  type ShaderMaterial,
} from 'three';
import { a10Env } from '../environment/env';
import { getParticleAtlas } from './atlas';
import { createParticleMaterial, type ParticleUniforms } from './particleMaterial';
import { fireRampColor, PARTICLE_KINDS } from './particleKinds';
import { fxRandom } from './noise';

const G = 9.80665;
const BUCKETS = 1024;
const BUCKETS_PER_OCTAVE = 48;
const NO_GROUND = -1e9;
const UPRIGHT = 1000;

const _fwd = new Vector3();
const _size = new Vector2();

export interface ParticleStats {
  live: number;
  drawn: number;
  spawned: number;
  replaced: number;
  dropped: number;
}

export class ParticleSystem {
  readonly capacity: number;
  /** Live particles (dense). */
  count = 0;
  /** Live cap (the quality preset's `particles`). */
  budget: number;
  /** Surface wind (world m/s, the direction the air moves); grows with height above the ground. */
  readonly wind = new Vector3();
  /** Accumulated simulated time (flicker). */
  time = 0;
  readonly stats: ParticleStats = { live: 0, drawn: 0, spawned: 0, replaced: 0, dropped: 0 };

  /** Spawn context: ground height under new particles, and their birth delay (s). */
  groundY = NO_GROUND;
  delay = 0;

  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly geometry: InstancedBufferGeometry;

  // ---- state (structure of arrays) ----
  private readonly kind: Uint8Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly cr: Float32Array;
  private readonly cg: Float32Array;
  private readonly cb: Float32Array;
  private readonly ca: Float32Array;
  private readonly ce: Float32Array;
  private readonly gy: Float32Array;
  private readonly seed: Float32Array;
  private readonly trailRate: Float32Array;
  private readonly trailAcc: Float32Array;
  private readonly size: Float32Array;

  // ---- sort scratch ----
  private readonly keys: Uint16Array;
  private readonly visible: Uint32Array;
  private readonly order: Uint32Array;
  private readonly bucket = new Uint32Array(BUCKETS);

  // ---- GPU ----
  private readonly aPos: InstancedBufferAttribute;
  private readonly aCol: InstancedBufferAttribute;
  private readonly aEmi: InstancedBufferAttribute;
  private readonly aMisc: InstancedBufferAttribute;
  private readonly aVel: InstancedBufferAttribute;
  private readonly attrs: readonly InstancedBufferAttribute[];
  private readonly ramp = new Float32Array(3);
  private updating = false;
  private readonly kdrag = new Float32Array(64);

  constructor(capacity = 20000) {
    this.capacity = capacity;
    this.budget = capacity;
    const f = () => new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.age = f();
    this.life = f();
    this.s0 = f();
    this.s1 = f();
    this.rot = f();
    this.spin = f();
    this.cr = f();
    this.cg = f();
    this.cb = f();
    this.ca = f();
    this.ce = f();
    this.gy = f();
    this.seed = f();
    this.trailRate = f();
    this.trailAcc = f();
    this.size = f();
    this.keys = new Uint16Array(capacity);
    this.visible = new Uint32Array(capacity);
    this.order = new Uint32Array(capacity);

    const g = new InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const inst = (name: string) => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      a.setUsage(DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    };
    this.aPos = inst('iPos');
    this.aCol = inst('iCol');
    this.aEmi = inst('iEmi');
    this.aMisc = inst('iMisc');
    this.aVel = inst('iVel');
    this.attrs = [this.aPos, this.aCol, this.aEmi, this.aMisc, this.aVel];
    g.instanceCount = 0;
    this.geometry = g;
    this.material = createParticleMaterial(getParticleAtlas());
    this.mesh = new Mesh(g, this.material);
    this.mesh.name = 'a10-particles';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    const u = this.material.uniforms as ParticleUniforms;
    // per pass: the target's height (minimum pixel size) and the sun in this camera's view space
    this.mesh.onBeforeRender = (renderer, _scene, cam) => {
      const rt = renderer.getRenderTarget();
      u.uScreenH.value = rt ? rt.height : renderer.getDrawingBufferSize(_size).y;
      u.uSunView.value.copy(a10Env.sunDirection).transformDirection(cam.matrixWorldInverse);
    };
  }

  /** Copy the current lighting and haze from the environment (call once per frame). */
  syncEnvironment(): void {
    const u = this.material.uniforms as ParticleUniforms;
    u.uSunColor.value.copy(a10Env.sunColor);
    u.uAmbient.value.copy(a10Env.ambientColor);
    u.uHaze.value.copy(a10Env.horizonColor);
    u.uHazeDensity.value = a10Env.hazeDensity;
  }

  /**
   * Spawn one particle of `kind` (PK) at a world position with a world velocity, growing from
   * size s0 to s1 (m) over `life` seconds. Uses the current spawn context (groundY, delay).
   * Returns the slot (valid only until the next update) or -1 when it could not be placed.
   */
  spawn(
    kind: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    s0: number,
    s1: number,
    life: number,
  ): number {
    let i: number;
    const cap = Math.min(this.budget, this.capacity);
    if (this.count < cap) {
      i = this.count++;
    } else {
      if (this.updating || cap <= 0) {
        this.stats.dropped++;
        return -1;
      }
      // replace the most faded of a few sampled particles
      i = -1;
      let worst = -1;
      for (let n = 0; n < 8; n++) {
        const j = Math.floor(fxRandom.next() * this.count);
        const f = this.age[j] / this.life[j];
        if (f > worst) {
          worst = f;
          i = j;
        }
      }
      if (i < 0 || worst < 0.15) {
        this.stats.dropped++;
        return -1;
      }
      this.stats.replaced++;
    }
    const k = PARTICLE_KINDS[kind];
    this.kind[i] = kind;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.age[i] = -this.delay;
    this.life[i] = Math.max(0.01, life);
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.size[i] = s0;
    this.rot[i] = fxRandom.next() * Math.PI * 2;
    this.spin[i] = fxRandom.signed(k.spin);
    this.cr[i] = k.color[0];
    this.cg[i] = k.color[1];
    this.cb[i] = k.color[2];
    this.ca[i] = 1;
    this.ce[i] = 1;
    this.gy[i] = this.groundY;
    this.seed[i] = fxRandom.next();
    this.trailRate[i] = k.trailRate;
    this.trailAcc[i] = fxRandom.next();
    this.stats.spawned++;
    return i;
  }

  /** Albedo (linear) and opacity scale of a freshly spawned particle. */
  color(i: number, r: number, g: number, b: number, a = 1): void {
    if (i < 0) return;
    this.cr[i] = r;
    this.cg[i] = g;
    this.cb[i] = b;
    this.ca[i] = a;
  }

  /** Opacity scale only. */
  opacity(i: number, a: number): void {
    if (i >= 0) this.ca[i] = a;
  }

  /** Emissive scale (× the kind's emissive). */
  emissive(i: number, e: number): void {
    if (i >= 0) this.ce[i] = e;
  }

  /** Trail puffs per second (kinds with a trail). */
  trail(i: number, rate: number): void {
    if (i >= 0) this.trailRate[i] = rate;
  }

  /** Spin rate, rad/s. */
  setSpin(i: number, spin: number): void {
    if (i >= 0) this.spin[i] = spin;
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
  }

  /**
   * Advance every particle by dt simulated seconds, then sort and upload for `camera`.
   */
  update(dt: number, camera: Camera): void {
    this.time += dt;
    this.syncEnvironment();
    if (dt > 0) this.simulate(dt);
    this.upload(camera);
    this.stats.live = this.count;
  }

  private simulate(dt: number): void {
    const kinds = PARTICLE_KINDS;
    for (let k = 0; k < kinds.length; k++) this.kdrag[k] = 1 - Math.exp(-kinds[k].drag * dt);
    const wx = this.wind.x;
    const wy = this.wind.y;
    const wz = this.wind.z;
    const { px, py, pz, vx, vy, vz, age, life, size } = this;
    this.updating = true;
    for (let i = 0; i < this.count; ) {
      const a = age[i] + dt;
      if (a >= life[i]) {
        this.kill(i);
        continue;
      }
      age[i] = a;
      if (a < 0) {
        i++;
        continue;
      }
      const step = a < dt ? a : dt;
      const kid = this.kind[i];
      const k = kinds[kid];
      const kd = step < dt ? 1 - Math.exp(-k.drag * step) : this.kdrag[kid];
      const t = a / life[i];
      const g =
        k.growTau > 0 ? 0.8 * (1 - Math.exp(-a / k.growTau)) + 0.2 * t : 1 - Math.pow(1 - t, k.grow);
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * g;
      size[i] = s;
      const ground = this.gy[i];
      let windF = 0;
      if (k.wind > 0) {
        const agl = ground > NO_GROUND ? py[i] - ground : 30;
        windF = k.wind * Math.min(2.2, Math.pow((agl > 1 ? agl : 1) / 10, 1 / 7));
      }
      const rise = k.rise > 0 ? k.rise * Math.exp(-a / k.riseTau) : 0;
      vx[i] += (wx * windF - vx[i]) * kd;
      vy[i] += (wy * windF + rise - vy[i]) * kd - G * k.gravity * step;
      vz[i] += (wz * windF - vz[i]) * kd;
      px[i] += vx[i] * step;
      py[i] += vy[i] * step;
      pz[i] += vz[i] * step;
      this.rot[i] += this.spin[i] * step;
      if (k.ground !== 0 && ground > NO_GROUND) {
        const floor = ground + (k.ground === 1 ? 0.3 * s : 0.25 * s);
        if (py[i] < floor) {
          py[i] = floor;
          if (k.ground === 2 && vy[i] < -2) {
            vy[i] = -vy[i] * 0.3;
            vx[i] *= 0.55;
            vz[i] *= 0.55;
            this.spin[i] *= 0.5;
          } else {
            if (vy[i] < 0) vy[i] = 0;
            const f = k.ground === 2 ? 0.75 : 0.92;
            vx[i] *= f;
            vz[i] *= f;
            if (k.ground === 2) this.spin[i] *= 0.7;
          }
        }
      }
      if (k.trail >= 0 && this.trailRate[i] > 0) {
        let acc = this.trailAcc[i] + this.trailRate[i] * step;
        if (acc >= 1) {
          const sx = px[i];
          const sy = py[i];
          const sz = pz[i];
          const g0 = this.groundY;
          const d0 = this.delay;
          this.groundY = ground;
          while (acc >= 1) {
            acc -= 1;
            // spread the puffs along this step's path
            const back = fxRandom.next() * step;
            this.delay = 0;
            const j = this.spawn(
              k.trail,
              sx - vx[i] * back,
              sy - vy[i] * back,
              sz - vz[i] * back,
              vx[i] * 0.08 + fxRandom.signed(0.6),
              vy[i] * 0.08 + fxRandom.signed(0.6),
              vz[i] * 0.08 + fxRandom.signed(0.6),
              k.trailS0 * (0.7 + 0.6 * fxRandom.next()),
              k.trailS1 * (0.7 + 0.6 * fxRandom.next()),
              k.trailLife * (0.7 + 0.6 * fxRandom.next()),
            );
            if (j >= 0) this.age[j] = back;
          }
          this.groundY = g0;
          this.delay = d0;
        }
        this.trailAcc[i] = acc;
      }
      i++;
    }
    this.updating = false;
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.kind[i] = this.kind[last];
    this.px[i] = this.px[last];
    this.py[i] = this.py[last];
    this.pz[i] = this.pz[last];
    this.vx[i] = this.vx[last];
    this.vy[i] = this.vy[last];
    this.vz[i] = this.vz[last];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.s0[i] = this.s0[last];
    this.s1[i] = this.s1[last];
    this.rot[i] = this.rot[last];
    this.spin[i] = this.spin[last];
    this.cr[i] = this.cr[last];
    this.cg[i] = this.cg[last];
    this.cb[i] = this.cb[last];
    this.ca[i] = this.ca[last];
    this.ce[i] = this.ce[last];
    this.gy[i] = this.gy[last];
    this.seed[i] = this.seed[last];
    this.trailRate[i] = this.trailRate[last];
    this.trailAcc[i] = this.trailAcc[last];
    this.size[i] = this.size[last];
  }

  private upload(camera: Camera): void {
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const fx = _fwd.x;
    const fy = _fwd.y;
    const fz = _fwd.z;
    const { px, py, pz, age, size, keys, visible, order, bucket } = this;
    bucket.fill(0);
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (age[i] < 0) continue;
      const d = (px[i] - cx) * fx + (py[i] - cy) * fy + (pz[i] - cz) * fz;
      if (d < -size[i] * 2) continue;
      let key = d > 0.25 ? Math.floor((Math.log2(d) + 2) * BUCKETS_PER_OCTAVE) : 0;
      if (key >= BUCKETS) key = BUCKETS - 1;
      keys[n] = key;
      visible[n] = i;
      bucket[key]++;
      n++;
    }
    // far first: start offsets from the deepest bucket down
    let acc = 0;
    for (let b = BUCKETS - 1; b >= 0; b--) {
      const c = bucket[b];
      bucket[b] = acc;
      acc += c;
    }
    for (let v = 0; v < n; v++) order[bucket[keys[v]]++] = visible[v];

    // render origin near the camera keeps float32 vertex data precise
    const ox = Math.round(cx / 256) * 256;
    const oy = Math.round(cy / 256) * 256;
    const oz = Math.round(cz / 256) * 256;
    this.mesh.position.set(ox, oy, oz);

    const P = this.aPos.array as Float32Array;
    const C = this.aCol.array as Float32Array;
    const E = this.aEmi.array as Float32Array;
    const M = this.aMisc.array as Float32Array;
    const V = this.aVel.array as Float32Array;
    const kinds = PARTICLE_KINDS;
    const ramp = this.ramp;
    const time = this.time;
    for (let v = 0; v < n; v++) {
      const i = order[v];
      const k = kinds[this.kind[i]];
      const t = age[i] / this.life[i];
      let env = k.fadeIn > 0 && t < k.fadeIn ? t / k.fadeIn : 1;
      if (t > k.fadeOut) {
        const f = 1 - (t - k.fadeOut) / (1 - k.fadeOut);
        env *= f * f;
      }
      const o = v * 4;
      P[o] = px[i] - ox;
      P[o + 1] = py[i] - oy;
      P[o + 2] = pz[i] - oz;
      P[o + 3] = size[i];
      C[o] = this.cr[i];
      C[o + 1] = this.cg[i];
      C[o + 2] = this.cb[i];
      C[o + 3] = k.alpha * this.ca[i] * env;
      let heat: number;
      if (k.emissive > 0) {
        const el = t / k.emissiveLife;
        let em = 0;
        if (el < 1) {
          const q = 1 - el;
          em = q * q;
          if (k.flicker > 0) {
            const sd = this.seed[i];
            em *= 1 - k.flicker * (0.5 + 0.5 * Math.sin(time * (23 + 17 * sd) + sd * 60));
          }
        }
        const e = k.emissive * this.ce[i] * em * (k.alpha === 0 ? env : 1);
        if (k.fireRamp) {
          fireRampColor(k.rampHeat * (1 - el * 0.85), ramp, 0);
          E[o] = ramp[0] * e;
          E[o + 1] = ramp[1] * e;
          E[o + 2] = ramp[2] * e;
        } else {
          E[o] = this.cr[i] * e;
          E[o + 1] = this.cg[i] * e;
          E[o + 2] = this.cb[i] * e;
        }
        heat = k.thermal * (el < 1 ? 1 - el : 0);
      } else {
        E[o] = 0;
        E[o + 1] = 0;
        E[o + 2] = 0;
        heat = k.thermal * (1 - t);
      }
      E[o + 3] = k.lit;
      M[o] = k.tile + Math.min(k.tiles - 1, Math.floor(this.seed[i] * k.tiles));
      M[o + 1] = k.upright ? UPRIGHT : this.rot[i];
      M[o + 2] = k.stretch;
      M[o + 3] = k.minPx;
      V[o] = this.vx[i];
      V[o + 1] = this.vy[i];
      V[o + 2] = this.vz[i];
      V[o + 3] = heat;
    }
    const len = n * 4;
    for (let ai = 0; ai < this.attrs.length; ai++) {
      const a = this.attrs[ai];
      a.clearUpdateRanges();
      if (len > 0) {
        a.addUpdateRange(0, len);
        a.needsUpdate = true;
      }
    }
    this.geometry.instanceCount = n;
    this.stats.drawn = n;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
