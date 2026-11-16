/**
 * HUD sandbox — /a10/?sandbox=hud (dev server). The collimated HUD over a fake cockpit view:
 * a sky gradient, a ground of fields and roads, a glare shield and HUD frame in a sandbox
 * cockpit pass, and the real HUD pass drawing a fake flight state set by the controls.
 *
 * Move the head (offset, yaw, pitch) and watch collimation: the glass window slides over
 * symbology that stays fixed to the world. The red ring on the ground is the predicted gun
 * impact point (avionics fire control on a flat world); the pipper must sit on it.
 *
 * URL (all optional): preset=cruise|dive|shallow|turn|pullup|ccip|ccrp|night  head=x,y,z (cm)
 *   look=yaw,pitch (deg)  fov=<deg>  mode=NAV|GUNS|CCIP|CCRP  clip=stencil|analytic  ui=0
 *   stpt=<name>             steerpoint name (any text: checks the stroke font)
 *   post=stencil|nostencil  draw through an offscreen HDR target with a tone-mapping pass, as
 *                           the High preset's post-processing does (with or without stencil)
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  BackSide,
  BoxGeometry,
  Color,
  DoubleSide,
  Euler,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  HalfFloatType,
  OrthographicCamera,
  WebGLRenderTarget,
} from 'three';
import { stepFireControl } from '../../core/avionics';
import {
  bodyDirFromHudAngles,
  hudAnglesFromBodyDir,
  quaternionFromAttitude,
  worldToBody,
} from '../../core/frames';
import { createSim } from '../../core/sim';
import type { Sim } from '../../core/types';
import { DEG, FT, KT } from '../../core/units';
import type { GunPacSwitch, MasterArm, MasterMode } from '../../core/avionics/types';
import { createFlatTerrain } from '../../core/world';
import { tasFromCas } from '../../core/world/atmosphere';
import { A10_GEOMETRY } from '../../data/geometry';
import { a10Flags } from '../../state/debugFlags';
import { cockpitCamera, cockpitViewState } from '../../view/cockpit/cockpitCamera';
import { a10Env } from '../../view/environment/env';
import { A10_PRIORITY } from '../../view/frame';
import { registerRenderPass } from '../../view/pipeline';
import RenderPipeline from '../../view/RenderPipeline';
import { belowGlass } from '../../view/hud/hudMath';
import { HUD_GLASS } from '../../view/hud/hudLayout';
import { hudHandle, useHudPass } from '../../view/hud/HudView';

// ---------------------------------------------------------------------------------------------
// Parameters (mutated by the panel, read every frame)
// ---------------------------------------------------------------------------------------------

interface Params {
  headingDeg: number;
  pitchDeg: number;
  bankDeg: number;
  alphaDeg: number;
  driftDeg: number;
  iasKt: number;
  altFt: number;
  g: number;
  maxG: number;
  mode: MasterMode;
  arm: MasterArm;
  gunPac: GunPacSwitch;
  pacStage: 0 | 1 | 2;
  pipperAuto: boolean;
  pipperAzMil: number;
  pipperElMil: number;
  rangeM: number;
  gunValid: boolean;
  tooClose: boolean;
  tooFar: boolean;
  pullUp: boolean;
  altAlert: boolean;
  headX: number;
  headY: number;
  headZ: number;
  headYaw: number;
  headPitch: number;
  fov: number;
  rounds: number;
  daylight: number;
  analyticClip: boolean;
}

const DEFAULTS: Params = {
  headingDeg: 35,
  pitchDeg: 3,
  bankDeg: 0,
  alphaDeg: 4,
  driftDeg: 0,
  iasKt: 250,
  altFt: 8000,
  g: 1,
  maxG: 1,
  mode: 'NAV',
  arm: 'SAFE',
  gunPac: 'ARM',
  pacStage: 0,
  pipperAuto: true,
  pipperAzMil: 0,
  pipperElMil: -120,
  rangeM: 1200,
  gunValid: true,
  tooClose: false,
  tooFar: false,
  pullUp: false,
  altAlert: false,
  headX: 0,
  headY: 0,
  headZ: 0,
  headYaw: 0,
  headPitch: 0,
  fov: 62,
  rounds: 1150,
  daylight: 1,
  analyticClip: false,
};

const PRESETS: Record<string, Partial<Params>> = {
  cruise: {},
  dive: {
    mode: 'GUNS',
    arm: 'ARM',
    pitchDeg: -30,
    alphaDeg: 2.5,
    iasKt: 300,
    altFt: 2300,
    headingDeg: 35,
    maxG: 3.4,
    rounds: 1088,
  },
  shallow: {
    mode: 'GUNS',
    arm: 'ARM',
    pitchDeg: -8,
    alphaDeg: 3,
    iasKt: 320,
    altFt: 650,
    maxG: 2.8,
  },
  turn: { bankDeg: 50, pitchDeg: 6, alphaDeg: 9, g: 3.6, maxG: 4.1, iasKt: 280, altFt: 6500 },
  pullup: {
    mode: 'GUNS',
    arm: 'ARM',
    pitchDeg: -24,
    alphaDeg: 2,
    iasKt: 340,
    altFt: 700,
    pullUp: true,
    altAlert: true,
  },
  ccip: { mode: 'CCIP', arm: 'ARM', pitchDeg: -30, alphaDeg: 2.5, iasKt: 300, altFt: 4500 },
  ccrp: { mode: 'CCRP', arm: 'ARM', pitchDeg: 2, alphaDeg: 4, iasKt: 300, altFt: 6000 },
  night: { daylight: 0.05 },
};

function initialParams(): Params {
  const p: Params = { ...DEFAULTS };
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  Object.assign(p, PRESETS[q.get('preset') ?? 'cruise'] ?? {});
  const head = q.get('head')?.split(',').map(Number);
  if (head && head.length === 3 && head.every(Number.isFinite)) [p.headX, p.headY, p.headZ] = head;
  const look = q.get('look')?.split(',').map(Number);
  if (look && look.length === 2 && look.every(Number.isFinite)) [p.headYaw, p.headPitch] = look;
  const fov = Number(q.get('fov'));
  if (Number.isFinite(fov) && fov >= 5 && fov <= 100) p.fov = fov;
  const mode = q.get('mode');
  if (mode === 'NAV' || mode === 'GUNS' || mode === 'CCIP' || mode === 'CCRP') p.mode = mode;
  if (q.get('clip') === 'analytic') p.analyticClip = true;
  return p;
}

const P: Params = initialParams();

// ---------------------------------------------------------------------------------------------
// The fake flight
// ---------------------------------------------------------------------------------------------

const TERRAIN = createFlatTerrain(0);
let fakeSim: Sim | null = null;
function getFakeSim(): Sim | null {
  return fakeSim;
}

const _dir = new Vector3();
const _rel = new Vector3();
const _eyeW = new Vector3();
const _headQ = new Quaternion();
const _euler = new Euler(0, 0, 0, 'YXZ');
const _ang = { az: 0, el: 0 };

function createFakeSim(): Sim {
  const sim = createSim({
    terrain: TERRAIN,
    scenario: 'empty',
    seed: 7,
    start: { x: 0, z: 0, agl: 2400, heading: 0, speed: 130 },
  });
  const sp = sim.avionics.steerpoints;
  sp.length = 0;
  const name = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get(
    'stpt',
  );
  sp.push({ id: 1, name: name ?? 'TGT1', position: new Vector3(0, 0, 0) });
  sp.push({ id: 2, name: 'IP', position: new Vector3(0, 0, 0) });
  sim.avionics.activeSteerpoint = 0;
  sim.avionics.profiles.length = 0;
  sim.avionics.profiles.push({
    id: 'mk82-ccip',
    store: 'MK-82',
    mode: 'CCIP',
    release: 'SGL',
    rippleQty: 1,
    rippleSpacing: 0,
    fuze: 'NOSE',
    minAltitude: 300,
    armingTime: 4,
  });
  sim.avionics.selectedProfile = 'mk82-ccip';
  return sim;
}

/** Write the panel's state into the fake simulation (no stepping: the HUD only reads it). */
function applyParams(sim: Sim, time: number): void {
  const ac = sim.aircraft;
  const av = sim.avionics;
  sim.time = time;
  const alt = P.altFt * FT;
  ac.position.set(0, alt, 0);
  quaternionFromAttitude(P.headingDeg * DEG, P.pitchDeg * DEG, P.bankDeg * DEG, ac.orientation);
  ac.heading = (((P.headingDeg % 360) + 360) % 360) * DEG;
  ac.pitch = P.pitchDeg * DEG;
  ac.bank = P.bankDeg * DEG;
  const tas = tasFromCas(P.iasKt * KT, alt);
  // The velocity vector sits alpha below the nose and `drift` to the side.
  bodyDirFromHudAngles(P.driftDeg * DEG, -P.alphaDeg * DEG, _dir).applyQuaternion(ac.orientation);
  ac.velocity.copy(_dir).multiplyScalar(tas);
  ac.tas = tas;
  ac.ias = P.iasKt * KT;
  ac.alpha = P.alphaDeg * DEG;
  ac.altitude = alt;
  ac.agl = alt - TERRAIN.heightAt(0, 0);
  ac.verticalSpeed = ac.velocity.y;
  ac.groundSpeed = Math.hypot(ac.velocity.x, ac.velocity.z);
  ac.gLoad = P.g;
  ac.maxG = Math.max(P.g, P.maxG);
  ac.warnings.pullUp = P.pullUp;
  ac.warnings.altitude = P.altAlert;
  ac.pac.stage = P.pacStage;
  ac.pac.active = P.gunPac === 'ARM' && P.pacStage > 0;
  av.masterMode = P.mode;
  av.masterArm = P.arm;
  av.gunPac = P.gunPac;
  sim.gun.rounds = P.rounds;

  // Gun solution: the fire-control computer on the flat world, or the manual sliders.
  const g = av.gun;
  if (P.pipperAuto) {
    stepFireControl(sim, 1 / 120);
    if (!P.gunValid) g.valid = false;
  } else {
    g.valid = P.gunValid;
    g.pipperAz = (P.pipperAzMil / 1000) * 1;
    g.pipperEl = P.pipperElMil / 1000;
    g.slantRange = P.rangeM;
    g.tooClose = P.tooClose;
    g.tooFar = P.tooFar;
  }
  if (P.tooClose) g.tooClose = true;
  if (P.tooFar) g.tooFar = true;

  // A simple bomb solution for the CCIP/CCRP symbology (sandbox only: vacuum drop).
  const rel = av.release;
  const vy = ac.velocity.y;
  const tFall = (vy + Math.sqrt(vy * vy + 2 * 9.81 * Math.max(1, ac.agl))) / 9.81;
  const cockpitEye = A10_GEOMETRY.eye;
  _eyeW
    .set(cockpitEye.x, cockpitEye.y, cockpitEye.z)
    .applyQuaternion(ac.orientation)
    .add(ac.position);
  if (P.mode === 'CCIP') {
    rel.impact.set(ac.position.x + ac.velocity.x * tFall, 0, ac.position.z + ac.velocity.z * tFall);
    _rel.subVectors(rel.impact, _eyeW);
    worldToBody(ac.orientation, _rel, _rel);
    hudAnglesFromBodyDir(_rel, _ang);
    rel.az = _ang.az;
    rel.el = _ang.el;
    rel.valid = true;
    rel.timeOfFall = tFall;
    rel.timeToRelease = 0;
    rel.belowMinimum = ac.agl < 300;
    rel.belowGlass = belowGlass(A10_GEOMETRY.eye, _rel, HUD_GLASS);
  } else if (P.mode === 'CCRP') {
    const tgt = av.steerpoints[0].position;
    rel.impact.copy(tgt);
    _rel.subVectors(tgt, _eyeW);
    worldToBody(ac.orientation, _rel, _rel);
    hudAnglesFromBodyDir(_rel, _ang);
    rel.az = _ang.az;
    rel.el = _ang.el;
    rel.valid = true;
    const dist = Math.hypot(tgt.x - ac.position.x, tgt.z - ac.position.z);
    rel.timeOfFall = tFall;
    rel.timeToRelease = Math.max(0, (dist - ac.groundSpeed * tFall) / Math.max(1, ac.groundSpeed));
  }
}

/**
 * Place the steerpoints: the target where the gun would hit now (so a gun preset starts with
 * the pipper on it), or 4 km ahead and 15° right when there is no gun solution; the IP behind.
 */
function placeTargets(sim: Sim): void {
  applyParams(sim, 0);
  const sp = sim.avionics.steerpoints;
  const g = sim.avionics.gun;
  const brg = (P.headingDeg + 15) * DEG;
  if (g.valid && P.mode === 'GUNS') sp[0].position.copy(g.impact).setY(0);
  else sp[0].position.set(Math.sin(brg) * 4000, 0, -Math.cos(brg) * 4000);
  sp[1].position.set(-Math.sin(brg) * 9000, 0, Math.cos(brg) * 9000);
}

// ---------------------------------------------------------------------------------------------
// Scene pieces
// ---------------------------------------------------------------------------------------------

const SKY_VS = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SKY_FS = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uGround;
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld - cameraPosition);
  vec3 c = d.y >= 0.0 ? mix(uHorizon, uZenith, pow(clamp(d.y, 0.0, 1.0), 0.45)) : uGround;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const GROUND_FS = /* glsl */ `
uniform vec3 uHaze;
uniform float uDensity;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 cell = floor(vWorld.xz / 320.0);
  float h = hash(cell);
  vec3 c = mix(vec3(0.07, 0.11, 0.035), vec3(0.20, 0.17, 0.08), h);
  c = mix(c, vec3(0.13, 0.15, 0.05), step(0.82, hash(cell + 7.0)));
  vec2 g = abs(fract(vWorld.xz / 1600.0 + 0.5) - 0.5) * 1600.0;
  float road = 1.0 - smoothstep(3.0, 6.0, min(g.x, g.y));
  c = mix(c, vec3(0.30, 0.28, 0.24), road);
  float d = length(vWorld - cameraPosition);
  float fog = 1.0 - exp(-pow(d * uDensity, 2.0));
  c = mix(c, uHaze, fog);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function SandboxWorld() {
  const sky = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: SKY_VS,
        fragmentShader: SKY_FS,
        uniforms: {
          uHorizon: { value: new Color() },
          uZenith: { value: new Color() },
          uGround: { value: new Color() },
        },
        side: BackSide,
        depthWrite: false,
      }),
    [],
  );
  const ground = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: SKY_VS,
        fragmentShader: GROUND_FS,
        uniforms: { uHaze: { value: new Color() }, uDensity: { value: 4.5e-5 } },
      }),
    [],
  );
  const skyGeo = useMemo(() => new SphereGeometry(80000, 32, 16), []);
  const groundGeo = useMemo(() => new PlaneGeometry(160000, 160000).rotateX(-Math.PI / 2), []);
  const ringGeo = useMemo(() => new RingGeometry(7, 11, 40).rotateX(-Math.PI / 2), []);
  const ringMat = useMemo(() => new MeshBasicMaterial({ color: '#ff3b2f', side: DoubleSide }), []);
  const tankGeo = useMemo(() => new BoxGeometry(3.6, 2.4, 7), []);
  const tankMat = useMemo(() => new MeshBasicMaterial({ color: '#2a2d22' }), []);
  useEffect(
    () => () => {
      for (const d of [sky, ground, skyGeo, groundGeo, ringGeo, ringMat, tankGeo, tankMat])
        d.dispose();
    },
    [sky, ground, skyGeo, groundGeo, ringGeo, ringMat, tankGeo, tankMat],
  );
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const tanks = useRef<Group>(null);
  const [ring] = useState(() => new Mesh(ringGeo, ringMat));
  const [skyMesh] = useState(() => new Mesh(skyGeo, sky));
  useEffect(() => {
    skyMesh.renderOrder = -1000;
    skyMesh.frustumCulled = false;
    scene.add(skyMesh, ring);
    return () => void scene.remove(skyMesh, ring);
  }, [scene, skyMesh, ring]);
  useFrame(() => {
    const day = P.daylight;
    a10Env.daylight = day;
    const u = sky.uniforms;
    (u.uHorizon.value as Color).setRGB(0.62, 0.72, 0.82).multiplyScalar(0.08 + 0.92 * day);
    (u.uZenith.value as Color).setRGB(0.18, 0.36, 0.72).multiplyScalar(0.05 + 0.95 * day);
    (u.uGround.value as Color).setRGB(0.5, 0.55, 0.55).multiplyScalar(0.06 + 0.94 * day);
    (ground.uniforms.uHaze.value as Color).copy(u.uHorizon.value as Color);
    skyMesh.position.copy(camera.position);
    const sim = fakeSim;
    ring.visible = !!sim && sim.avionics.gun.valid && P.mode === 'GUNS';
    if (sim) ring.position.copy(sim.avionics.gun.impact).setY(sim.avionics.gun.impact.y + 0.3);
    if (sim && tanks.current) tanks.current.position.copy(sim.avionics.steerpoints[0].position);
  });
  return (
    <>
      <mesh geometry={groundGeo} material={ground} />
      <group ref={tanks}>
        {[0, 1, 2, 3].map((i) => (
          <mesh
            key={i}
            geometry={tankGeo}
            material={tankMat}
            position={[(i - 1.5) * 22, 1.2, (i % 2) * 15 - 7]}
            rotation={[0, i * 0.7, 0]}
          />
        ))}
      </group>
    </>
  );
}

/**
 * A stand-in cockpit (sandbox only): glare shield, HUD frame posts and a faint combiner tint,
 * drawn in its own pass at order 200 with the cockpit camera, like the cockpit module's pass.
 */
function SandboxCockpit() {
  useEffect(() => {
    const scene = new Scene();
    const dark = new MeshBasicMaterial({ color: '#15171a' });
    const frame = new MeshBasicMaterial({ color: '#25282c' });
    const tint = new MeshBasicMaterial({
      color: '#b6c99a',
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
      side: DoubleSide,
    });
    const geos: BoxGeometry[] = [];
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, m = dark) => {
      const g = new BoxGeometry(w, h, d);
      geos.push(g);
      const mesh = new Mesh(g, m);
      mesh.position.set(x, y, z);
      scene.add(mesh);
      return mesh;
    };
    // Glare shield and instrument panel top, just below the HUD glass (bottom edge y 0.92).
    box(1.3, 0.05, 0.42, 0, 0.865, -5.36);
    box(1.3, 0.5, 0.06, 0, 0.6, -5.18);
    // HUD frame: side posts along the glass edges, and the base.
    const c = A10_GEOMETRY.hudCorners;
    for (const side of [-1, 1]) {
      const post = box(0.018, 0.34, 0.03, side * (Math.abs(c[0].x) + 0.012), 1.077, -5.459, frame);
      post.rotation.x = 0.3375;
    }
    box(0.27, 0.035, 0.07, 0, 0.905, -5.52, frame);
    // Combiner tint.
    const tintGeo = new PlaneGeometry(0.2375, 0.3302);
    const glass = new Mesh(tintGeo, tint);
    glass.position.set(0, 1.0776, -5.4589 - 0.002);
    glass.rotation.x = 0.3375;
    scene.add(glass);
    const unregister = registerRenderPass({
      id: 'cockpit',
      order: 200,
      enabled: () => cockpitViewState.active,
      render(ctx) {
        ctx.gl.setRenderTarget(ctx.target);
        ctx.gl.clear(false, true, false);
        ctx.gl.render(scene, cockpitCamera);
      },
    });
    return () => {
      unregister();
      for (const g of geos) g.dispose();
      tintGeo.dispose();
      dark.dispose();
      frame.dispose();
      tint.dispose();
    };
  }, []);
  return null;
}

/** Writes the fake flight and places the world and cockpit cameras (priority camera). */
function SandboxDriver() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  useFrame((state) => {
    const sim = fakeSim;
    if (!sim) return;
    applyParams(sim, state.clock.elapsedTime);
    hudHandleClip();
    const ac = sim.aircraft;
    const e = A10_GEOMETRY.eye;
    // Head: offset (cm) and yaw/pitch relative to the body axes.
    cockpitCamera.position.set(e.x + P.headX / 100, e.y + P.headY / 100, e.z + P.headZ / 100);
    _euler.set(P.headPitch * DEG, -P.headYaw * DEG, 0, 'YXZ');
    _headQ.setFromEuler(_euler);
    cockpitCamera.quaternion.copy(_headQ);
    if (cockpitCamera.fov !== P.fov || cockpitCamera.aspect !== camera.aspect) {
      cockpitCamera.fov = P.fov;
      cockpitCamera.aspect = camera.aspect;
      cockpitCamera.updateProjectionMatrix();
    }
    cockpitCamera.updateMatrixWorld();
    cockpitViewState.active = true;
    // World camera = aircraft pose ∘ head pose.
    camera.position.copy(cockpitCamera.position).applyQuaternion(ac.orientation).add(ac.position);
    camera.quaternion.copy(ac.orientation).multiply(_headQ);
    if (camera.fov !== P.fov) {
      camera.fov = P.fov;
      camera.updateProjectionMatrix();
    }
  }, A10_PRIORITY.camera);
  return null;
}

function hudHandleClip(): void {
  const hud = hudHandle.current;
  if (hud) hud.stencilAvailable = !P.analyticClip;
}

const POST_MODE = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get(
  'post',
);

const POST_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const POST_FS = /* glsl */ `
uniform sampler2D tScene;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tScene, vUv);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * A minimal post-processing pass (sandbox only): the earlier passes draw into an offscreen
 * linear HDR target, which this pass tone-maps to the screen — the path the HUD takes on the
 * High preset. `post=nostencil` gives the target no stencil buffer (the HUD's analytic clip).
 */
function SandboxPost({ stencil }: { stencil: boolean }) {
  useEffect(() => {
    const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, stencilBuffer: stencil });
    const quad = new Mesh(
      new PlaneGeometry(2, 2),
      new ShaderMaterial({
        vertexShader: POST_VS,
        fragmentShader: POST_FS,
        uniforms: { tScene: { value: rt.texture } },
        depthTest: false,
        depthWrite: false,
      }),
    );
    quad.frustumCulled = false;
    const scene = new Scene();
    scene.add(quad);
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const unregister = registerRenderPass({
      id: 'post',
      order: 900,
      prepareTarget(ctx) {
        if (rt.width !== ctx.width || rt.height !== ctx.height) rt.setSize(ctx.width, ctx.height);
        return rt;
      },
      render(ctx) {
        ctx.gl.setRenderTarget(null);
        ctx.gl.render(scene, cam);
      },
    });
    return () => {
      unregister();
      rt.dispose();
      quad.geometry.dispose();
      (quad.material as ShaderMaterial).dispose();
    };
  }, [stencil]);
  return null;
}

function HudLayer() {
  useHudPass(getFakeSim);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

const PANEL: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  width: 290,
  maxHeight: 'calc(100% - 16px)',
  overflowY: 'auto',
  padding: '8px 10px',
  background: 'rgba(10, 14, 12, 0.82)',
  color: '#d6e2d6',
  font: '12px/1.35 system-ui, sans-serif',
  borderRadius: 6,
};

function Slider(props: {
  label: string;
  k: keyof Params;
  min: number;
  max: number;
  step?: number;
}) {
  const { label, k, min, max, step = 1 } = props;
  const [v, setV] = useState(P[k] as number);
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '92px 1fr 44px', gap: 6 }}>
      <span>{label}</span>
      <input
        type="range"
        style={{ width: '100%', minWidth: 0 }}
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value);
          (P as unknown as Record<string, number>)[k] = n;
          setV(n);
        }}
      />
      <span style={{ textAlign: 'right' }}>{v}</span>
    </label>
  );
}

function Choice<T extends string | number>(props: {
  label: string;
  k: keyof Params;
  options: T[];
}) {
  const { label, k, options } = props;
  const [v, setV] = useState(P[k] as T);
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 6 }}>
      <span>{label}</span>
      <select
        value={String(v)}
        style={{ minWidth: 0 }}
        onChange={(e) => {
          const raw = e.target.value;
          const val = (typeof options[0] === 'number' ? Number(raw) : raw) as T;
          (P as unknown as Record<string, unknown>)[k] = val;
          setV(val);
        }}
      >
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Check(props: { label: string; k: keyof Params }) {
  const [v, setV] = useState(P[props.k] as boolean);
  return (
    <label style={{ display: 'inline-flex', gap: 4, marginRight: 10 }}>
      <input
        type="checkbox"
        checked={v}
        onChange={(e) => {
          (P as unknown as Record<string, boolean>)[props.k] = e.target.checked;
          setV(e.target.checked);
        }}
      />
      {props.label}
    </label>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <fieldset style={{ border: '1px solid #33403a', borderRadius: 4, margin: '6px 0', padding: 6 }}>
      <legend style={{ padding: '0 4px', color: '#9fdca8' }}>{props.title}</legend>
      <div style={{ display: 'grid', gap: 3 }}>{props.children}</div>
    </fieldset>
  );
}

function Panel() {
  const [version, setVersion] = useState(0);
  const preset = (name: string) => {
    Object.assign(P, DEFAULTS, PRESETS[name]);
    if (fakeSim) placeTargets(fakeSim);
    setVersion((v) => v + 1);
  };
  return (
    <div style={PANEL} key={version}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
        {Object.keys(PRESETS).map((n) => (
          <button key={n} type="button" onClick={() => preset(n)}>
            {n}
          </button>
        ))}
      </div>
      <Section title="Head (collimation)">
        <Slider label="offset x cm" k="headX" min={-25} max={25} />
        <Slider label="offset y cm" k="headY" min={-20} max={20} />
        <Slider label="offset z cm" k="headZ" min={-20} max={30} />
        <Slider label="yaw °" k="headYaw" min={-60} max={60} />
        <Slider label="pitch °" k="headPitch" min={-40} max={30} />
        <Slider label="fov °" k="fov" min={5} max={90} />
        <Check label="analytic clip (no stencil)" k="analyticClip" />
      </Section>
      <Section title="Flight">
        <Slider label="heading °" k="headingDeg" min={0} max={359} />
        <Slider label="pitch °" k="pitchDeg" min={-60} max={40} />
        <Slider label="bank °" k="bankDeg" min={-90} max={90} />
        <Slider label="alpha °" k="alphaDeg" min={-4} max={20} step={0.5} />
        <Slider label="drift °" k="driftDeg" min={-10} max={10} step={0.5} />
        <Slider label="IAS kt" k="iasKt" min={80} max={450} />
        <Slider label="altitude ft" k="altFt" min={100} max={20000} step={50} />
        <Slider label="g" k="g" min={-2} max={7.5} step={0.1} />
        <Slider label="max g" k="maxG" min={1} max={7.5} step={0.1} />
        <Slider label="daylight" k="daylight" min={0} max={1} step={0.05} />
        <div>
          <Check label="PULL UP" k="pullUp" />
          <Check label="alt alert" k="altAlert" />
        </div>
      </Section>
      <Section title="Weapons">
        <Choice label="master mode" k="mode" options={['NAV', 'GUNS', 'CCIP', 'CCRP']} />
        <Choice label="Master Arm" k="arm" options={['SAFE', 'TRAIN', 'ARM']} />
        <Choice label="GUN/PAC" k="gunPac" options={['SAFE', 'GUNARM', 'ARM']} />
        <Choice label="PAC stage" k="pacStage" options={[0, 1, 2]} />
        <Slider label="rounds" k="rounds" min={0} max={1174} />
        <div>
          <Check label="computed pipper" k="pipperAuto" />
          <Check label="valid" k="gunValid" />
        </div>
        <Slider label="pipper az mil" k="pipperAzMil" min={-120} max={120} />
        <Slider label="pipper el mil" k="pipperElMil" min={-300} max={30} />
        <Slider label="slant range m" k="rangeM" min={100} max={4500} step={10} />
        <div>
          <Check label="too close" k="tooClose" />
          <Check label="too far" k="tooFar" />
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export default function HudSandbox() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    fakeSim = createFakeSim();
    placeTargets(fakeSim);
    setReady(true);
    return () => {
      fakeSim = null;
    };
  }, []);
  return (
    <div className="a10-app">
      <Canvas
        dpr={[1, 1.5]}
        gl={{ antialias: true, stencil: true }}
        camera={{ fov: 62, near: 1, far: 90000, position: [0, 3000, 0] }}
      >
        {ready && (
          <>
            <SandboxDriver />
            <SandboxWorld />
            <SandboxCockpit />
            <HudLayer />
            {(POST_MODE === 'stencil' || POST_MODE === 'nostencil') && (
              <SandboxPost stencil={POST_MODE === 'stencil'} />
            )}
          </>
        )}
        <RenderPipeline />
      </Canvas>
      {a10Flags.ui && <Panel />}
    </div>
  );
}
