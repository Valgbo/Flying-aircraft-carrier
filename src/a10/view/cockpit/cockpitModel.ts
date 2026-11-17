/**
 * Everything the cockpit pass draws, in BODY coordinates: the FlightGear cockpit with its
 * instruments driven by the simulation, the pilot's own airframe seen from the seat (canopy bow,
 * nose, wings, engines, tail), the ejection seat, the cockpit lighting and shadows, the glass,
 * the display surfaces, the A-10C box of hotspot switches and the pick highlight.
 * OWNED BY THE COCKPIT MODULE. Built once when the aircraft models have loaded; CockpitView
 * updates it every frame and draws `cockpitScene` in the cockpit render pass.
 *
 * Materials of the cockpit file are cloned for this instance (instrument drums move their own
 * texture offsets; the instrument glow at dusk changes emissive colours) — the templates stay
 * untouched for the outside views.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Box3,
  Color,
  Group,
  Mesh,
  Object3D,
  Quaternion,
  Ray,
  Vector3,
  type Material,
  type MeshStandardMaterial,
  type PerspectiveCamera,
  type Scene,
  type ShaderMaterial,
  type Texture,
} from 'three';
import {
  createAircraftInstance,
  createCockpitModel,
  disposeAircraftInstance,
  updateAircraftInstance,
  type AircraftInstance,
  type AircraftTemplates,
} from '../../assets';
import type { Sim } from '../../core/types';
import { a10Env } from '../environment/env';
import { a10Lights } from '../environment/envState';
import { createDisplaySurfaces, disposeDisplaySurfaces, type DisplaySurface } from './displays';
import { createCanopyGlass, createCombinerGlass, updateGlass } from './glass';
import { HotspotBox } from './hotspots';
import { createInstrumentDriver, resetGMeter, type InstrumentDriver } from './instruments';
import { CockpitLights } from './lighting';
import { boundsInFrame, pickTarget, PickHighlight, rayFromCamera, type PickTarget } from './picking';
import {
  COCKPIT_CONTROLS,
  controlStateText,
  createSwitchState,
  readSwitchState,
  type CockpitControlId,
} from './switches';

/** Nodes of the cockpit file never drawn: FlightGear's HUD canvas quad and 3-D gun cross, the TV's own screen (a display surface replaces it). */
const HIDDEN_NODES = ['hud-screen', 'gun-cross', 'CPT-video-screen'];
/** Textures that do not glow at dusk (floor, structure). */
const NO_GLOW = new Set(['cpt-floor', 'cpt-floor-rivets', 'panel-grey-central-struct']);
/** Instrument glow colour at full night (× the texture: white markings glow, black faces do not). */
const GLOW = new Color(0.62, 0.5, 0.34);
/** Airframe parts invisible from the seat (drawing them would only cost). */
const AIRFRAME_HIDDEN = ['Cannon__spin', 'L-Wing-Slat__slat'];
/** The box (BODY, m) whose airframe triangles cast shadows into the cockpit. */
const SHADOW_BOX = new Box3(new Vector3(-1.5, -0.3, -7.4), new Vector3(1.5, 2.7, -2.4));

export interface CockpitFrameInput {
  sim: Sim;
  /** Simulated seconds this frame (0 while paused). */
  simDt: number;
  /** Shadow map on (Medium, High) and its size. */
  shadows: boolean;
  shadowMapSize: number;
}

const _sunBody = new Vector3();
const _q = new Quaternion();
const _interior = new Color();
const _ray = new Ray();

export class CockpitModel {
  readonly root: Group;
  readonly airframe: AircraftInstance;
  readonly seat: Object3D | null;
  readonly driver: InstrumentDriver;
  readonly lights: CockpitLights;
  readonly box: HotspotBox;
  readonly highlight: PickHighlight;
  readonly targets: PickTarget[] = [];
  readonly displays: { left: DisplaySurface; right: DisplaySurface };
  readonly switchState = createSwitchState();
  /** The control under the free cursor (null when none). */
  hovered: PickTarget | null = null;
  private readonly canopyGlass: ShaderMaterial;
  private readonly combinerGlass: ShaderMaterial;
  private readonly ownMaterials: Material[] = [];
  private readonly ownTextures: Texture[] = [];
  private readonly glow: MeshStandardMaterial[] = [];
  private readonly airframeHidden: Object3D[] = [];
  private readonly receivers: Mesh[] = [];
  private receiving = false;
  private lastNight = -1;

  constructor(scene: Scene, templates: AircraftTemplates) {
    const meta = templates.meta;
    const root = createCockpitModel();
    if (!root) throw new Error('CockpitModel: the aircraft models are not loaded');
    this.root = root;
    root.name = 'a10-cockpit';
    for (const n of HIDDEN_NODES) {
      const o = root.getObjectByName(n);
      if (o) o.visible = false;
    }

    // own materials (and own textures for the drums)
    this.combinerGlass = createCombinerGlass();
    this.canopyGlass = createCanopyGlass();
    this.ownMaterials.push(this.combinerGlass, this.canopyGlass);
    const clones = new Map<Material, Material>();
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const swap = (m: Material): Material => {
        if (m.userData.glass) return this.combinerGlass;
        let c = clones.get(m);
        if (!c) {
          c = m.clone();
          clones.set(m, c);
          this.ownMaterials.push(c);
          const sm = c as MeshStandardMaterial;
          if (c.userData.uvAnim && sm.map) {
            sm.map = sm.map.clone();
            this.ownTextures.push(sm.map);
            if (sm.emissiveMap) sm.emissiveMap = sm.map;
          }
          const tex = c.userData.texture as string | undefined;
          if (sm.isMeshStandardMaterial && sm.map && tex && !NO_GLOW.has(tex)) {
            if (sm.emissive.r + sm.emissive.g + sm.emissive.b === 0 && !sm.emissiveMap) {
              sm.emissiveMap = sm.map;
              this.glow.push(sm);
            }
          }
        }
        return c;
      };
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(swap)
        : swap(mesh.material);
      this.receivers.push(mesh);
    });
    scene.add(root);
    root.updateMatrixWorld(true);
    this.driver = createInstrumentDriver(root, meta);

    // the pilot's own airframe, from the inside (no stores: they hang below the wing)
    this.airframe = createAircraftInstance({ forCockpit: true, stores: false, templates });
    this.airframe.root.name = 'cockpit-airframe';
    for (const n of AIRFRAME_HIDDEN) {
      const o = this.airframe.root.getObjectByName(n);
      if (o) this.airframeHidden.push(o);
    }
    this.airframe.root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as Material;
      if (!Array.isArray(mesh.material) && m.userData.glass) mesh.material = this.canopyGlass;
      else this.receivers.push(mesh);
    });
    scene.add(this.airframe.root);

    // the ejection seat (the pilot file without the pilot)
    const seat = templates.pilot.clone(true);
    const pilot = seat.getObjectByName('Pilot');
    if (pilot) pilot.visible = false;
    seat.name = 'cockpit-seat';
    scene.add(seat);
    this.seat = seat;
    seat.traverse((o) => {
      if ((o as Mesh).isMesh) this.receivers.push(o as Mesh);
    });

    this.lights = new CockpitLights(scene);
    this.airframe.root.updateMatrixWorld(true);
    this.lights.setProxy(buildShadowProxy(root, this.airframe.root, seat));

    this.displays = createDisplaySurfaces(scene, meta.displays.tv?.corners);

    this.box = new HotspotBox();
    scene.add(this.box.group);
    this.box.group.updateMatrixWorld(true);

    // click targets
    for (const c of COCKPIT_CONTROLS) {
      const t = c.target;
      if (t.kind === 'pick') {
        const p = meta.pick.find((x) => x.file === 'cockpit' && x.node === t.node);
        const frame = p ? (p.frame === root.name ? root : root.getObjectByName(p.frame)) : null;
        if (!p || !frame) continue;
        this.targets.push({
          id: c.id,
          label: c.label,
          frame,
          box: new Box3(new Vector3(...p.box.min), new Vector3(...p.box.max)),
        });
      } else if (t.kind === 'mesh') {
        const frame = root.getObjectByName(t.node);
        if (!frame) continue;
        const box = boundsInFrame(frame, new Box3());
        if (!box.isEmpty()) this.targets.push({ id: c.id, label: c.label, frame, box });
      } else {
        const h = this.box.targets.find((x) => x.id === c.id);
        if (h)
          this.targets.push({
            id: c.id,
            label: c.label,
            frame: this.box.group,
            box: new Box3(h.min.clone(), h.max.clone()),
          });
      }
    }
    this.highlight = new PickHighlight(scene);
  }

  /** Read the simulation into everything (call once per frame before drawing). */
  update(f: CockpitFrameInput): void {
    const sim = f.sim;
    const ac = sim.aircraft;
    readSwitchState(sim, this.switchState);
    this.driver.update(sim, f.simDt);

    this.lights.update({
      orientation: ac.orientation,
      env: a10Env,
      hemiSky: a10Lights.hemiSky,
      hemiGround: a10Lights.hemiGround,
      ambient: a10Lights.ambient,
      shadows: f.shadows,
      shadowMapSize: f.shadowMapSize,
    });
    if (this.receiving !== this.lights.shadows) {
      this.receiving = this.lights.shadows;
      for (const m of this.receivers) m.receiveShadow = this.receiving;
    }

    // glass: the sun in the body frame; the glass reflects a dim cockpit lit by the sky
    _q.copy(ac.orientation).invert();
    _sunBody.copy(a10Env.sunDirection).applyQuaternion(_q).normalize();
    _interior.copy(a10Lights.hemiSky).multiplyScalar(0.035);
    updateGlass(this.canopyGlass, _sunBody, a10Env.sunColor, _interior);
    updateGlass(this.combinerGlass, _sunBody, a10Env.sunColor, _interior);

    // instrument glow toward dusk
    const night = this.lights.night;
    if (Math.abs(night - this.lastNight) > 1e-3) {
      this.lastNight = night;
      for (const m of this.glow)
        m.emissive.setRGB(GLOW.r * night, GLOW.g * night, GLOW.b * night);
    }

    updateAircraftInstance(this.airframe, sim, a10Env.daylight);
    // the gear, its doors and the gun are below the cockpit floor: never drawn from the seat
    this.airframe.gearUp.visible = false;
    for (const g of this.airframe.gearPivots) g.visible = false;
    for (const t of this.airframe.toggles) t.obj.visible = false;
    for (const o of this.airframeHidden) o.visible = false;

    this.box.update(this.switchState, night);
  }

  /** The control under a pointer (NDC), or null. */
  pick(camera: PerspectiveCamera, x: number, y: number): PickTarget | null {
    rayFromCamera(camera, x, y, _ray);
    return pickTarget(this.targets, _ray);
  }

  /** Hover highlight for the free cursor (null pointer hides it). */
  hover(camera: PerspectiveCamera, pointer: { x: number; y: number } | null, screenHeight: number): void {
    const t = pointer ? this.pick(camera, pointer.x, pointer.y) : null;
    this.hovered = t;
    if (!t) {
      this.highlight.show(null, '', camera, screenHeight);
      return;
    }
    const state = controlStateText(t.id, this.switchState);
    this.highlight.show(t, state ? `${t.label}  ${state}` : t.label, camera, screenHeight);
  }

  /** Cockpit-only actions of a control (no simulation command). Returns true if handled. */
  localAction(id: CockpitControlId, sim: Sim): boolean {
    if (id === 'gMeterReset') {
      resetGMeter(this.driver.memory, sim.aircraft.gLoad);
      return true;
    }
    return false;
  }

  /** Render the cockpit shadow map (inside the cockpit pass, before the scene). */
  renderShadows(gl: Parameters<CockpitLights['renderShadows']>[0], halfRate: boolean): void {
    this.lights.renderShadows(gl, halfRate);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.seat?.removeFromParent();
    disposeAircraftInstance(this.airframe);
    this.lights.dispose();
    this.box.dispose();
    this.highlight.dispose();
    disposeDisplaySurfaces();
    for (const m of this.ownMaterials) m.dispose();
    for (const t of this.ownTextures) t.dispose();
  }
}

/**
 * One merged position-only geometry of everything that shades the cockpit: the static cockpit
 * meshes (not glass, not displays), the seat, and the airframe triangles in SHADOW_BOX (canopy
 * bow and frame, fuselage sides, the nose behind the panel). BODY coordinates.
 */
export function buildShadowProxy(cockpit: Object3D, airframe: Object3D, seat: Object3D | null): BufferGeometry {
  const out: number[] = [];
  const v = new Vector3();
  const tri = [new Vector3(), new Vector3(), new Vector3()];
  const add = (root: Object3D, clip: boolean) => {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !isDrawn(mesh)) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.some((m) => m.transparent || m.userData.glass || m.userData.display)) return;
      if (/^display-|pick-highlight/.test(mesh.name)) return;
      // moving parts (stick, levers, needles) would leave their shadow behind: skip pivots
      for (let p: Object3D | null = mesh.parent; p && p !== root; p = p.parent)
        if (p.userData.pivot && !/canopy/i.test(p.name)) return;
      const g = mesh.geometry as BufferGeometry;
      const pos = g.getAttribute('position');
      if (!pos) return;
      const idx = g.getIndex();
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i + 2 < n; i += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx.getX(i + k) : i + k;
          tri[k].fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
        }
        if (clip) {
          v.copy(tri[0]).add(tri[1]).add(tri[2]).multiplyScalar(1 / 3);
          if (!SHADOW_BOX.containsPoint(v)) continue;
        }
        for (let k = 0; k < 3; k++) out.push(tri[k].x, tri[k].y, tri[k].z);
      }
    });
  };
  add(cockpit, false);
  add(airframe, true);
  if (seat) add(seat, true);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(out), 3));
  g.computeBoundingSphere();
  return g;
}

function isDrawn(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
