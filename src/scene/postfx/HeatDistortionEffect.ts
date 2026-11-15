/**
 * HeatDistortionEffect — shimmer in the hot exhaust below the turbines.
 *
 * Every frame (in `update`, which the EffectPass calls just before it renders) the plume of
 * each turbine — the segment from the nozzle exit along the exhaust direction, longer with
 * throttle — is clipped against the near plane and projected with the camera on the CPU.
 * The shader (heatShader.ts) receives screen-space endpoints, perspective-correct radii,
 * depths for occlusion and a strength per plume. When every strength is zero the shader
 * skips all work and the effect is an exact no-op.
 */
import { Effect, EffectAttribute } from 'postprocessing';
import { Uniform, Vector3, Vector4, type PerspectiveCamera } from 'three';
import { TURBINE } from '../../config/layout';
import { sim } from '../../state/sim';
import { getTurbineExhaust } from '../../state/simHelpers';
import { clamp01, lerp, smoothstep } from '../../utils/math';
import { HEAT_PLUME_COUNT, heatFragmentShader } from './heatShader';

/** Plume length at zero and at full throttle, m. */
const PLUME_LENGTH_MIN = 30;
const PLUME_LENGTH_MAX = 120;
/** Plume radius at the nozzle, m, and how fast it widens (m per m of length). */
const PLUME_RADIUS = TURBINE.fanRadius * 0.85;
const PLUME_SPREAD = 0.2;
/** Camera distance over which the shimmer fades out, m. */
const FADE_START = 1300;
const FADE_END = 2100;
/** Largest UV displacement, as a fraction of the screen height. */
const MAX_OFFSET = 0.02;
/** Projected radii are capped (fraction of screen height) when the camera is almost inside a plume. */
const MAX_SCREEN_RADIUS = 1.5;
/** Plume points closer to the camera plane than this are clipped away, m. */
const CLIP_MARGIN = 2;

const _a = new Vector3();
const _b = new Vector3();
const _dir = new Vector3();

export class HeatDistortionEffect extends Effect {
  private readonly viewCamera: PerspectiveCamera;
  private readonly segments: Vector4[];
  private readonly radii: Vector4[];
  private readonly shape: Vector4[];
  private readonly timeUniform: Uniform<number>;
  private readonly activeUniform: Uniform<number>;

  constructor(camera: PerspectiveCamera) {
    const plumes = Array.from({ length: HEAT_PLUME_COUNT }, (_, i) => i);
    const segments = plumes.map(() => new Vector4());
    const radii = plumes.map(() => new Vector4(0, 0, 1, 1));
    // a different noise seed per plume so the four never shimmer in step
    const shape = plumes.map((i) => new Vector4(0, 1, 2, i * 17.31));
    const timeUniform = new Uniform(0);
    const activeUniform = new Uniform(0);
    super('HeatDistortionEffect', heatFragmentShader, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['heatSegments', new Uniform(segments)],
        ['heatRadii', new Uniform(radii)],
        ['heatShape', new Uniform(shape)],
        ['heatTime', timeUniform],
        ['heatActive', activeUniform],
        ['heatMaxOffset', new Uniform(MAX_OFFSET)],
        ['heatSpread', new Uniform(PLUME_SPREAD)],
      ]),
    });
    this.viewCamera = camera;
    this.segments = segments;
    this.radii = radii;
    this.shape = shape;
    this.timeUniform = timeUniform;
    this.activeUniform = activeUniform;
  }

  /** True when at least one plume distorts the image this frame. */
  get active(): boolean {
    return this.activeUniform.value > 0.5;
  }

  /** Project the four plumes for this frame. Called by the EffectPass before rendering. */
  override update(): void {
    const camera = this.viewCamera;
    // the camera rig has already moved the camera; make sure the matrices match its pose
    camera.updateMatrixWorld();
    const projection = camera.projectionMatrix.elements;
    const clipZ = -(camera.near + CLIP_MARGIN);
    let anyActive = false;

    for (let i = 0; i < HEAT_PLUME_COUNT; i++) {
      const shape = this.shape[i];
      const throttle = clamp01(sim.turbines[i].throttle);
      shape.x = 0;
      if (throttle <= 0) continue;

      getTurbineExhaust(i, _a, _dir);
      const length = lerp(PLUME_LENGTH_MIN, PLUME_LENGTH_MAX, throttle);
      _b.copy(_a).addScaledVector(_dir, length);
      _a.applyMatrix4(camera.matrixWorldInverse);
      _b.applyMatrix4(camera.matrixWorldInverse);
      // view space looks down -Z: a plume entirely behind the camera plane contributes nothing
      if (_a.z > clipZ && _b.z > clipZ) continue;

      let radiusA = PLUME_RADIUS;
      let radiusB = PLUME_RADIUS + length * PLUME_SPREAD;
      if (_a.z > clipZ) {
        const s = (clipZ - _a.z) / (_b.z - _a.z);
        _a.lerp(_b, s);
        radiusA = lerp(radiusA, radiusB, s);
      } else if (_b.z > clipZ) {
        const s = (clipZ - _b.z) / (_a.z - _b.z);
        _b.lerp(_a, s);
        radiusB = lerp(radiusB, radiusA, s);
      }

      const distance = Math.min(_a.length(), _b.length());
      const strength = throttle * (1 - smoothstep(FADE_START, FADE_END, distance));
      if (strength <= 0) continue;

      const depthA = -_a.z;
      const depthB = -_b.z;
      // perspective projection written out (includes the off-centre terms of a view offset)
      this.segments[i].set(
        ((projection[0] * _a.x + projection[8] * _a.z) / depthA) * 0.5 + 0.5,
        ((projection[5] * _a.y + projection[9] * _a.z) / depthA) * 0.5 + 0.5,
        ((projection[0] * _b.x + projection[8] * _b.z) / depthB) * 0.5 + 0.5,
        ((projection[5] * _b.y + projection[9] * _b.z) / depthB) * 0.5 + 0.5,
      );
      const radiusScale = projection[5] * 0.5;
      this.radii[i].set(
        Math.min(MAX_SCREEN_RADIUS, (radiusA * radiusScale) / depthA),
        Math.min(MAX_SCREEN_RADIUS, (radiusB * radiusScale) / depthB),
        1 / depthA,
        1 / depthB,
      );
      shape.x = strength;
      shape.y = radiusA;
      shape.z = radiusB;
      anyActive = true;
    }

    this.timeUniform.value = sim.time;
    this.activeUniform.value = anyActive ? 1 : 0;
  }
}
