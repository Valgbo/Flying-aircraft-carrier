/**
 * HUD sandbox — /a10/?sandbox=hud (dev server). The collimated HUD over a fake cockpit view:
 * a sky gradient, a ground of fields and roads, a glare shield and HUD frame in a sandbox
 * cockpit pass, and the real HUD pass drawing a fake flight state set by the controls.
 *
 * Move the head (offset, yaw, pitch) and watch collimation: the glass window slides over
 * symbology that stays fixed to the world. The red ring on the ground is the predicted gun
 * impact point (avionics fire control on a flat world); the pipper must sit on it.
 *
 * Stores (wave 2): the avionics' own fire control computes the release solution for the
 * selected profile (Mk-82 ballistics, rockets, GBU-12…) against the steerpoint/SPI, and its
 * delivery logic answers the pickle (consent designation, CCRP arming); release requests are
 * dropped (nothing flies here). Presets show each store state: CCIP fall line and minimum-range
 * staple, the delay cue below the glass, the consent designation and steering, rockets, CCRP
 * steering at a chosen time to release (the falling release cue in the last seconds), the time
 * of fall of a bomb in the air, CCRP INVALID, and the SPI, pod and Maverick marks.
 *
 * URL (all optional): preset=cruise|dive|shallow|turn|pullup|ccip|delay|consent|rockets|ccrp|
 *   ccrpcue|tof|passed|invalid|sensors|night  head=x,y,z (cm)  look=yaw,pitch (deg)  fov=<deg>
 *   mode=NAV|GUNS|CCIP|CCRP  clip=stencil|analytic  ui=0
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
import { spiToSteerpoint, stepFireControl } from '../../core/avionics';
import { stepSensors } from '../../core/sensors';
import { bodyDirFromHudAngles, quaternionFromAttitude } from '../../core/frames';
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
  // ---- stores (wave 2) ----
  /** Selected weapon profile (the avionics' profile id). */
  store: string;
  /** The pickle (weapon release) held. */
  pickle: boolean;
  /** Fly along the ground track (the countdowns run); altitude stays at the slider's. */
  fly: boolean;
  /**
   * CCRP target placed for this time to release, s (negative: that long past the release
   * point; 0: the target 4 km ahead, `targetDeg` right).
   */
  ccrpLead: number;
  /** Bearing of the target from the ground track, deg (+ right). */
  targetDeg: number;
  /** A bomb in the air: its time to impact when the preset starts, s (0 none). */
  tof: number;
  /** Targeting pod tracking the target and the SPI; a Maverick locked on another tank. */
  sensors: boolean;
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
  store: 'MK82LD',
  pickle: false,
  fly: false,
  ccrpLead: 0,
  targetDeg: 15,
  tof: 0,
  sensors: false,
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
  // Mk-82 CCIP in a 45° dive: the pipper on the glass, the fall line from the velocity vector
  // through it, the minimum-range staple on it.
  ccip: { mode: 'CCIP', arm: 'ARM', pitchDeg: -45, alphaDeg: 2, iasKt: 350, altFt: 3000 },
  // Shallow: the pipper is below the glass — dashed fall line and the delay cue.
  delay: { mode: 'CCIP', arm: 'ARM', pitchDeg: -5, alphaDeg: 3, iasKt: 300, altFt: 3000 },
  // The same with the pickle held: the designated target, steering and the time to release.
  consent: {
    mode: 'CCIP',
    arm: 'ARM',
    pitchDeg: -5,
    alphaDeg: 3,
    iasKt: 300,
    altFt: 3000,
    pickle: true,
  },
  rockets: {
    mode: 'CCIP',
    arm: 'ARM',
    store: 'M156-131',
    pitchDeg: -15,
    alphaDeg: 2.5,
    iasKt: 300,
    altFt: 2500,
  },
  // CCRP on the SPI: 12 s to release, the target 8° right of the track.
  ccrp: {
    mode: 'CCRP',
    arm: 'ARM',
    pitchDeg: 2,
    alphaDeg: 4,
    iasKt: 300,
    altFt: 6000,
    ccrpLead: 12,
    targetDeg: 8,
  },
  // The last seconds: the solution cue falls to the velocity vector.
  ccrpcue: {
    mode: 'CCRP',
    arm: 'ARM',
    pitchDeg: 2,
    alphaDeg: 4,
    iasKt: 300,
    altFt: 6000,
    ccrpLead: 3,
    targetDeg: 0,
  },
  // A GBU-12 falling: its time of fall counts down (to time the laser).
  tof: {
    mode: 'CCRP',
    arm: 'ARM',
    store: 'GBU12',
    pitchDeg: 2,
    alphaDeg: 4,
    iasKt: 300,
    altFt: 8000,
    ccrpLead: 20,
    targetDeg: 0,
    tof: 24,
    sensors: true,
  },
  // Past the release point: the cue below the velocity vector, no countdown.
  passed: {
    mode: 'CCRP',
    arm: 'ARM',
    pitchDeg: 2,
    alphaDeg: 4,
    iasKt: 300,
    altFt: 6000,
    ccrpLead: -4,
    targetDeg: 0,
  },
  // CCRP with a weapon that has no CCRP (rockets): CCRP INVALID.
  invalid: {
    mode: 'CCRP',
    arm: 'ARM',
    store: 'M156-131',
    pitchDeg: 2,
    alphaDeg: 4,
    iasKt: 300,
    altFt: 6000,
  },
  // The pod tracks the target (SPI generator: diamond with a tail), a Maverick locked nearby.
  sensors: {
    mode: 'NAV',
    pitchDeg: -12,
    alphaDeg: 3,
    iasKt: 280,
    altFt: 5000,
    targetDeg: 4,
    sensors: true,
  },
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
const _headQ = new Quaternion();
const _euler = new Euler(0, 0, 0, 'YXZ');

/** Where the sandbox's aircraft has flown (fly on), m. */
const flown = { x: 0, z: 0, tofStart: 0 };
/** The tanks around the target (offsets from the steerpoint, m), as SandboxWorld draws them. */
const TANKS = [0, 1, 2, 3].map((i) => new Vector3((i - 1.5) * 22, 1.2, (i % 2) * 15 - 7));
/** The last error thrown by the avionics' fire control (modules are written in parallel). */
let fireControlError = '';

function createFakeSim(): Sim {
  // The tank hunter's loadout: rockets, GBU-12s, Mk-82s, Mavericks and the pod; the avionics
  // makes one profile per store type (MK82LD, GBU12, M156-131, AGM65D, AGM65H).
  const sim = createSim({
    terrain: TERRAIN,
    scenario: 'empty',
    seed: 7,
    loadoutId: 'tankHunter',
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
  // One step of the sensors module makes the Maverick seekers of the loaded missiles (the
  // sandbox then sets their state by hand; the module is not stepped again).
  try {
    stepSensors(sim, 1 / 120);
  } catch (e) {
    fireControlError = `sensors: ${e instanceof Error ? e.message : String(e)}`;
  }
  return sim;
}

/** Select the profile `id` (its delivery set to the master mode when it can do that). */
function selectProfile(sim: Sim, id: string): void {
  const av = sim.avionics;
  const p = av.profiles.find((q) => q.id === id) ?? av.profiles[0];
  if (!p) return;
  av.selectedProfile = p.id;
  if ((P.mode === 'CCIP' || P.mode === 'CCRP') && p.mode !== 'NONE') {
    const store = p.store;
    // Bombs do both; rockets are CCIP only, laser-guided bombs CCRP only (the avionics knows).
    if (P.mode === 'CCRP' && !store.startsWith('LAU')) p.mode = 'CCRP';
    else if (P.mode === 'CCIP' && store !== 'GBU-12') p.mode = 'CCIP';
  }
}

/**
 * The pod tracking the target (point track, the SPI generator) and the selected Maverick locked
 * on another tank — set by hand (the sensors module is not stepped here), or both off.
 */
function applySensors(sim: Sim): void {
  const av = sim.avionics;
  const tgp = sim.sensors.tgp;
  const target = av.steerpoints[0].position;
  const eye = _dir
    .set(A10_GEOMETRY.eye.x, A10_GEOMETRY.eye.y, A10_GEOMETRY.eye.z)
    .applyQuaternion(sim.aircraft.orientation)
    .add(sim.aircraft.position);
  av.tgpPower = P.sensors;
  tgp.powered = P.sensors;
  tgp.warmup = 0;
  tgp.mode = 'POINT';
  tgp.point.copy(target).add(TANKS[1]);
  tgp.pointValid = P.sensors;
  tgp.los.subVectors(tgp.point, eye).normalize();
  const mav = sim.sensors.mavericks[0];
  if (mav) {
    sim.sensors.selectedMaverick = P.sensors ? 0 : -1;
    mav.powered = P.sensors;
    mav.align = 0;
    mav.locked = P.sensors;
    mav.lockPoint.copy(target).add(TANKS[3]);
    mav.los.subVectors(mav.lockPoint, eye).normalize();
  }
  if (P.sensors) {
    av.spi.valid = true;
    av.spi.source = 'TGP';
    av.spi.position.copy(tgp.point);
  } else spiToSteerpoint(sim);
}

/** Write the panel's state into the fake simulation (no stepping: the HUD only reads it). */
function applyParams(sim: Sim, time: number, dt = 0): void {
  const ac = sim.aircraft;
  const av = sim.avionics;
  sim.time = time;
  const alt = P.altFt * FT;
  quaternionFromAttitude(P.headingDeg * DEG, P.pitchDeg * DEG, P.bankDeg * DEG, ac.orientation);
  ac.heading = (((P.headingDeg % 360) + 360) % 360) * DEG;
  ac.pitch = P.pitchDeg * DEG;
  ac.bank = P.bankDeg * DEG;
  const tas = tasFromCas(P.iasKt * KT, alt);
  // The velocity vector sits alpha below the nose and `drift` to the side.
  bodyDirFromHudAngles(P.driftDeg * DEG, -P.alphaDeg * DEG, _dir).applyQuaternion(ac.orientation);
  ac.velocity.copy(_dir).multiplyScalar(tas);
  if (P.fly) {
    flown.x += ac.velocity.x * dt;
    flown.z += ac.velocity.z * dt;
  }
  ac.position.set(flown.x, alt, flown.z);
  ac.prevPosition.copy(ac.position);
  ac.prevOrientation.copy(ac.orientation);
  ac.prevVelocity.copy(ac.velocity);
  ac.tas = tas;
  ac.ias = P.iasKt * KT;
  ac.alpha = P.alphaDeg * DEG;
  ac.altitude = alt;
  ac.agl = alt - TERRAIN.heightAt(ac.position.x, ac.position.z);
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
  selectProfile(sim, P.store);
  sim.input.weaponRelease = P.pickle;
  applySensors(sim);

  // Fire control: the avionics' own (gun, stores and the pickle), then the manual gun sliders.
  try {
    stepFireControl(sim, 1 / 120);
    fireControlError = '';
  } catch (e) {
    fireControlError = e instanceof Error ? e.message : String(e);
  }
  // Nothing executes releases in the sandbox.
  sim.stores.releaseQueue.length = 0;
  const g = av.gun;
  if (P.pipperAuto) {
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
  // A bomb in the air (the computer's time to impact, counting down from the preset's start).
  if (P.tof > 0) av.release.timeToImpact = Math.max(0, P.tof - (time - flown.tofStart));
}

/**
 * Place the target `lead` seconds of flight before the CCRP release point, `targetDeg` off the
 * ground track: start from a vacuum estimate and correct with the computer's own time to
 * release (a few passes of the real fire control).
 */
function placeCcrpTarget(sim: Sim, lead: number, time: number): void {
  const av = sim.avionics;
  const ac = sim.aircraft;
  const sp = av.steerpoints[0].position;
  const gs = Math.max(1, ac.groundSpeed);
  const track = Math.atan2(ac.velocity.x, -ac.velocity.z);
  const brg = track + P.targetDeg * DEG;
  const fall = Math.sqrt((2 * Math.max(1, ac.agl)) / 9.81);
  let d = gs * (fall + lead);
  for (let k = 0; k < 6; k++) {
    sp.set(ac.position.x + Math.sin(brg) * d, 0, ac.position.z - Math.cos(brg) * d);
    applyParams(sim, time);
    const rel = av.release;
    if (!rel.valid) break;
    // Too long to the release: the target comes closer by the difference flown.
    d -= (rel.timeToRelease - lead) * gs;
  }
}

/**
 * Place the steerpoints: the target where the gun would hit now (so a gun preset starts with
 * the pipper on it), placed for the CCRP lead, or 4 km ahead `targetDeg` right of the track
 * (behind it for 180°); the IP behind.
 */
function placeTargets(sim: Sim, time = 0): void {
  flown.x = 0;
  flown.z = 0;
  flown.tofStart = time;
  applyParams(sim, time);
  const sp = sim.avionics.steerpoints;
  const g = sim.avionics.gun;
  const brg = (P.headingDeg + P.targetDeg) * DEG;
  if (g.valid && P.mode === 'GUNS') sp[0].position.copy(g.impact).setY(0);
  else if (P.mode === 'CCRP' && P.ccrpLead !== 0) placeCcrpTarget(sim, P.ccrpLead, time);
  else sp[0].position.set(Math.sin(brg) * 4000, 0, -Math.cos(brg) * 4000);
  sp[1].position.set(-Math.sin(brg) * 9000, 0, Math.cos(brg) * 9000);
  applyParams(sim, time);
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
  useFrame((state, delta) => {
    const sim = fakeSim;
    if (!sim) return;
    applyParams(sim, state.clock.elapsedTime, Math.min(delta, 0.1));
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

/** The release solution as the avionics computed it (live). */
function ReleaseReadout() {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((v) => v + 1), 250);
    return () => window.clearInterval(id);
  }, []);
  const sim = fakeSim;
  if (!sim) return null;
  const av = sim.avionics;
  const r = av.release;
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
  return (
    <div style={{ font: '11px/1.4 ui-monospace, monospace', color: '#b8c4b8' }}>
      <div>
        sight {av.sight} · {r.valid ? 'valid' : 'invalid'} · {av.delivery.phase}
      </div>
      <div>
        REL {f(r.timeToRelease)} s · fall {f(r.timeOfFall)} s · TTI {f(r.timeToImpact)}
      </div>
      <div>
        {r.belowGlass ? 'below glass · ' : ''}
        {r.delayCueValid ? 'delay cue · ' : ''}
        {r.designatedValid ? 'designated · ' : ''}
        {r.belowMinimum ? 'below min · ' : ''}
        {r.releaseNow ? 'RELEASE' : ''}
      </div>
      {fireControlError && <div style={{ color: '#ff8a7a' }}>{fireControlError}</div>}
    </div>
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
    // A preset sets the flight and weapons; the view (head, field of view, clip) stays.
    const view = {
      headX: P.headX,
      headY: P.headY,
      headZ: P.headZ,
      headYaw: P.headYaw,
      headPitch: P.headPitch,
      fov: P.fov,
      analyticClip: P.analyticClip,
    };
    Object.assign(P, DEFAULTS, PRESETS[name], view);
    if (fakeSim) placeTargets(fakeSim, fakeSim.time);
    setVersion((v) => v + 1);
  };
  const profiles = fakeSim ? fakeSim.avionics.profiles.map((p) => p.id) : [P.store];
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
      <Section title="Stores">
        <Choice label="profile" k="store" options={profiles} />
        <div>
          <Check label="pickle" k="pickle" />
          <Check label="fly" k="fly" />
          <Check label="pod + MAV" k="sensors" />
        </div>
        <Slider label="CCRP lead s" k="ccrpLead" min={-20} max={40} />
        <Slider label="target brg °" k="targetDeg" min={-60} max={180} />
        <Slider label="TOF s" k="tof" min={0} max={40} />
        <button
          type="button"
          onClick={() => {
            if (fakeSim) placeTargets(fakeSim, fakeSim.time);
          }}
        >
          place target
        </button>
        <ReleaseReadout />
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
    // Test hook: the fake flight, the panel's parameters and what the HUD drew last.
    const w = window as unknown as { __HUD_SANDBOX__?: unknown };
    w.__HUD_SANDBOX__ = {
      sim: fakeSim,
      params: P,
      info: () => hudHandle.current?.symbology.info ?? null,
    };
    return () => {
      fakeSim = null;
      delete w.__HUD_SANDBOX__;
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
