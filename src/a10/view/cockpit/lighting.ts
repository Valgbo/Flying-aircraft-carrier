/**
 * Cockpit lighting in the BODY frame: the sun (a10Env.sunDirection rotated into the body, so the
 * light and the shadows move across the panel as the aircraft manoeuvres), the sky and ground
 * fill (the environment's own hemisphere and ambient, scaled for the canopy's view of the sky),
 * a panel flood light and instrument glow toward dusk, and a shadow map inside the cockpit on
 * the Medium and High presets (canopy bow, HUD frame and glare shield shadows on the panel).
 * OWNED BY THE COCKPIT MODULE.
 *
 * Shadow casters: rendering ≈200 cockpit and airframe meshes into a shadow map would double the
 * cockpit's draw calls, so the casters are ONE merged position-only mesh (the "proxy": every
 * static cockpit mesh, plus the airframe triangles around the cockpit). It lives in its own
 * `shadowScene` with a twin of the sun that shares the same LightShadow; that scene is rendered
 * with a camera that sees nothing, which makes three.js draw only its shadow map (one draw
 * call). The cockpit scene is then drawn with shadow-map updates off, sampling that map.
 */
import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PCFSoftShadowMap,
  PointLight,
  Quaternion,
  Scene,
  Vector3,
  type ShadowMapType,
  type WebGLRenderer,
} from 'three';
import type { A10Environment } from '../environment/env';

/** Fraction of the outside sky and ground fill that reaches the cockpit through the canopy. */
export const COCKPIT_FILL = 0.62;
/** Without a shadow map (Low) the sun is dimmed: the glare shield and tub would shade most of it. */
export const SUN_WITHOUT_SHADOWS = 0.45;
/** Where the shadow camera looks (the middle of the cockpit, BODY) and its half size, m. */
const SHADOW_CENTRE = new Vector3(0, 0.95, -4.95);
const SHADOW_HALF = 1.25;
const SHADOW_DISTANCE = 4;

const _q = new Quaternion();
const _sun = new Vector3();
const _up = new Vector3();

export interface CockpitLightingInput {
  /** Body → world rotation of the aircraft. */
  orientation: Quaternion;
  env: Readonly<A10Environment>;
  /** Sky (hemisphere) and ground colour × intensity and the ambient, as the world uses them. */
  hemiSky: Color;
  hemiGround: Color;
  ambient: Color;
  /** Shadow map on (Medium/High) and its size. */
  shadows: boolean;
  shadowMapSize: number;
}

export class CockpitLights {
  readonly sun = new DirectionalLight(0xffffff, 1);
  /** The sun's twin in the shadow scene (same pose, same LightShadow object). */
  readonly shadowSun = new DirectionalLight(0xffffff, 1);
  readonly hemi = new HemisphereLight(0xffffff, 0x444444, 1);
  readonly ambient = new AmbientLight(0xffffff, 0);
  /** A flood light under the glare shield, for dusk. */
  readonly flood = new PointLight(0xffe2bf, 0, 0, 2);
  readonly shadowScene = new Scene();
  /** Sees nothing: rendering the shadow scene with it draws only the shadow map. */
  readonly nullCamera = new OrthographicCamera(-1, 1, 1, -1, 1, 2);
  /** Night factor 0 (day) … 1 (dark), for the instrument glow. */
  night = 0;
  private proxy: Mesh | null = null;
  private readonly proxyMaterial = new MeshBasicMaterial({ name: 'cockpit-shadow-proxy' });
  private readonly target = new Object3D();
  private shadowsOn = false;
  private frame = 0;

  constructor(scene: Scene) {
    this.sun.name = 'cockpit-sun';
    this.shadowSun.name = 'cockpit-sun-shadow';
    this.hemi.name = 'cockpit-sky';
    this.ambient.name = 'cockpit-ambient';
    this.flood.name = 'cockpit-flood';
    this.target.name = 'cockpit-sun-target';
    this.target.position.copy(SHADOW_CENTRE);
    this.target.updateMatrixWorld();
    this.sun.target = this.target;
    this.shadowSun.target = this.target;
    // one LightShadow for both: the shadow scene renders it, the cockpit samples it
    this.shadowSun.shadow = this.sun.shadow;
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_HALF;
    cam.right = SHADOW_HALF;
    cam.top = SHADOW_HALF;
    cam.bottom = -SHADOW_HALF;
    cam.near = 0.2;
    cam.far = SHADOW_DISTANCE + 2.5;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.006;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.flood.position.set(0, 1.0, -5.12);
    scene.add(this.sun, this.target, this.hemi, this.ambient, this.flood);
    this.shadowScene.name = 'cockpit-shadows';
    this.shadowScene.add(this.shadowSun);
    this.shadowScene.matrixWorldAutoUpdate = true;
    // looking up from far below the world: its frustum holds nothing
    this.nullCamera.position.set(0, -1e5, 0);
    this.nullCamera.lookAt(0, -2e5, 0);
    this.nullCamera.updateMatrixWorld();
  }

  /** The merged shadow-caster geometry (BODY coordinates). Replaces any previous one. */
  setProxy(geometry: BufferGeometry | null): void {
    if (this.proxy) {
      this.proxy.removeFromParent();
      this.proxy.geometry.dispose();
      this.proxy = null;
    }
    if (!geometry) return;
    const m = new Mesh(geometry, this.proxyMaterial);
    m.name = 'cockpit-shadow-proxy';
    m.castShadow = true;
    m.receiveShadow = false;
    m.matrixAutoUpdate = false;
    m.updateMatrixWorld();
    this.proxy = m;
    this.shadowScene.add(m);
  }

  /** Whether the cockpit is drawn with its shadow map this frame. */
  get shadows(): boolean {
    return this.shadowsOn;
  }

  update(inp: CockpitLightingInput): void {
    const env = inp.env;
    _q.copy(inp.orientation).invert();
    _sun.copy(env.sunDirection).applyQuaternion(_q).normalize();
    _up.set(0, 1, 0).applyQuaternion(_q);
    const sunPos = this.sun.position.copy(SHADOW_CENTRE).addScaledVector(_sun, SHADOW_DISTANCE);
    this.shadowSun.position.copy(sunPos);
    this.sun.updateMatrixWorld();
    this.shadowSun.updateMatrixWorld();

    this.shadowsOn = inp.shadows && this.proxy !== null;
    this.sun.color.copy(env.sunColor);
    this.sun.intensity = this.shadowsOn ? 1 : SUN_WITHOUT_SHADOWS;
    this.sun.castShadow = this.shadowsOn;
    this.shadowSun.castShadow = this.shadowsOn;
    if (this.shadowsOn && this.sun.shadow.mapSize.x !== inp.shadowMapSize) {
      this.sun.shadow.mapSize.set(inp.shadowMapSize, inp.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }

    // sky and ground fill: "up" is the world's up seen from the body
    this.hemi.position.copy(_up);
    this.hemi.updateMatrixWorld();
    this.hemi.color.copy(inp.hemiSky);
    this.hemi.groundColor.copy(inp.hemiGround);
    this.hemi.intensity = COCKPIT_FILL;
    this.ambient.color.copy(inp.ambient);
    this.ambient.intensity = COCKPIT_FILL;

    // dusk: the flood light and the instrument glow come up as the daylight goes
    const day = Math.min(1, Math.max(0, env.daylight));
    const t = Math.min(1, Math.max(0, (0.55 - day) / 0.45));
    this.night = t * t * (3 - 2 * t);
    this.flood.intensity = 0.35 * this.night;
  }

  /**
   * Render the cockpit shadow map (call before drawing the cockpit, inside the cockpit pass).
   * `everyOther`: update at half rate (Medium).
   */
  renderShadows(gl: WebGLRenderer, everyOther: boolean): void {
    if (!this.shadowsOn) return;
    this.frame++;
    const shadow = this.sun.shadow;
    shadow.autoUpdate = false;
    if (everyOther && this.frame % 2 === 1 && shadow.map) return;
    shadow.needsUpdate = true;
    const sm = gl.shadowMap;
    const enabled = sm.enabled;
    const type: ShadowMapType = sm.type;
    const auto = sm.autoUpdate;
    sm.enabled = true;
    sm.type = PCFSoftShadowMap;
    sm.autoUpdate = true;
    gl.render(this.shadowScene, this.nullCamera);
    sm.enabled = enabled;
    sm.type = type;
    sm.autoUpdate = auto;
  }

  dispose(): void {
    this.setProxy(null);
    this.proxyMaterial.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.sun.removeFromParent();
    this.target.removeFromParent();
    this.hemi.removeFromParent();
    this.ambient.removeFromParent();
    this.flood.removeFromParent();
    this.shadowSun.removeFromParent();
  }
}
