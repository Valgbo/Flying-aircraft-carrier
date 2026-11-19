/**
 * The sensor renderer's draw of the world scene (SensorRenderer.ts), with a stand-in for the
 * WebGL renderer that records what the terrain's hooks hold while the world scene is drawn:
 *
 *   - the terrain draws the picture's own tiles (terrainFocus.ts), for the picture's camera and
 *     its magnification over the outside view, and the outside view's afterwards;
 *   - the terrain's close-range detail reaches as far as that magnification carries it, in
 *     infrared as in television (its bump no longer aliases into moiré: terrainMaterial.ts);
 *   - everything is put back for the outside view.
 */
import { Color, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quaternionFromAttitude } from '../../../src/a10/core/frames';
import type { SensorPicture } from '../../../src/a10/core/sensors/types';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { TGP } from '../../../src/a10/data/sensors';
import { useA10Store } from '../../../src/a10/state/store';
import type { RenderPassContext } from '../../../src/a10/view/pipeline';
import {
  SensorRenderer,
  sensorViewOverrides,
  sensorViewStats,
  setSensorViewSim,
} from '../../../src/a10/view/sensors/SensorRenderer';
import {
  createSensorCameraPose,
  pictureLodFocus,
  pictureMagnification,
  tgpCameraPose,
} from '../../../src/a10/view/sensors/sensorPose';
import { SENSOR_RENDER } from '../../../src/a10/view/sensors/sensorViewData';
import { createLodFocus, type LodFocus } from '../../../src/a10/view/terrain/lod';
import {
  getTerrainFocusTarget,
  setTerrainFocusTarget,
  type TerrainFocusTarget,
} from '../../../src/a10/view/terrain/terrainFocus';
import { terrainUniforms } from '../../../src/a10/view/terrain/terrainMaterial';

const DEG = Math.PI / 180;

interface Draw {
  thermal: number;
  detail: number;
  /** The terrain was drawing the picture's own tiles. */
  focused: boolean;
}

/** A WebGLRenderer stand-in: draws nothing, records the hooks at each draw of the world scene. */
function fakeRenderer(world: Scene, focusActive: () => boolean) {
  const draws: Draw[] = [];
  let target: unknown = null;
  const gl = {
    autoClear: true,
    shadowMap: { autoUpdate: true },
    info: { autoReset: true, render: { calls: 0, triangles: 0 } },
    getRenderTarget: () => target,
    setRenderTarget: (t: unknown) => {
      target = t;
    },
    getClearColor: (c: Color) => c.set(0, 0, 0),
    getClearAlpha: () => 1,
    setClearColor: () => {},
    clear: () => {},
    render: (scene: Scene) => {
      if (scene !== world) return;
      draws.push({
        thermal: terrainUniforms.uThermal.value,
        detail: terrainUniforms.uDetailDistance.value,
        focused: focusActive(),
      });
    },
    readRenderTargetPixelsAsync: () => new Promise(() => {}),
    readRenderTargetPixels: () => {},
    getContext: () => ({ bindBuffer: () => {}, PIXEL_PACK_BUFFER: 0 }),
  };
  return { gl: gl as unknown as WebGLRenderer, draws };
}

/** The pod 8 km from its look point (3,000 m up), NARROW ×2, on the left display. */
function podSim(picture: SensorPicture): Sim {
  const sim = createSim({ seed: 1, terrain: createFlatTerrain(0), scenario: 'empty' });
  const ac = sim.aircraft;
  ac.position.set(0, 3000, 0);
  ac.velocity.set(0, 0, -130);
  quaternionFromAttitude(0, 0, 0, ac.orientation);
  const tgp = sim.sensors.tgp;
  tgp.powered = true;
  tgp.warmup = 0;
  tgp.masked = false;
  tgp.picture = picture;
  tgp.fovSetting = 'NARROW';
  tgp.zoom = 2;
  tgp.fov = TGP.fovNarrow / 2;
  tgp.point.set(0, 0, -7420);
  tgp.pointValid = true;
  tgp.los.subVectors(tgp.point, ac.position).normalize();
  sim.avionics.tgpPower = true;
  sim.avionics.mfd = { left: 'TGP', right: 'DSMS' };
  sim.sensors.mavericks = [];
  return sim;
}

describe('sensor renderer: the terrain while a picture is drawn', () => {
  const world = new Scene();
  const camera = new PerspectiveCamera(50, 16 / 9, 1, 90000);
  let begun: LodFocus[];
  let ends: number;
  let active: boolean;
  const target: TerrainFocusTarget = {
    beginFocus(f) {
      begun.push({ ...f });
      active = true;
      return true;
    },
    endFocus() {
      ends++;
      active = false;
    },
  };
  let renderer: SensorRenderer | null = null;
  let previousTarget: TerrainFocusTarget | null = null;
  const quality = useA10Store.getState().settings.quality;

  beforeEach(() => {
    begun = [];
    ends = 0;
    active = false;
    previousTarget = getTerrainFocusTarget();
    setTerrainFocusTarget(target);
    useA10Store.getState().updateSettings({ quality: 'low' });
    terrainUniforms.uThermal.value = 0;
    terrainUniforms.uDetailDistance.value = 1600;
    sensorViewOverrides.terrainFocus = true;
  });

  afterEach(() => {
    renderer?.dispose();
    renderer = null;
    setSensorViewSim(null);
    setTerrainFocusTarget(previousTarget);
    useA10Store.getState().updateSettings({ quality });
    sensorViewOverrides.terrainFocus = true;
  });

  /** One frame of the sensor pass (the pod is due: a 15 Hz picture after 0.1 s). */
  function frame(sim: Sim) {
    const fake = fakeRenderer(world, () => active);
    renderer = new SensorRenderer(fake.gl);
    setSensorViewSim(() => sim);
    const ctx: RenderPassContext = {
      gl: fake.gl,
      scene: world,
      camera,
      width: 1280,
      height: 720,
      target: null,
      dt: 0.1,
    };
    renderer.frame(ctx);
    return fake.draws;
  }

  for (const picture of ['WHOT', 'BHOT', 'CCD'] as const) {
    it(`${picture}: the picture's own tiles and the magnified close detail, then the outside view's`, () => {
      const sim = podSim(picture);
      const draws = frame(sim);
      expect(draws).toHaveLength(1);
      const stats = sensorViewStats.TGP;
      const pose = createSensorCameraPose();
      tgpCameraPose(sim, pose);
      // the picture's magnification over the outside view (≈ 38: NARROW ×2 on Low at 720 lines)
      const magnification = pictureMagnification(50, 720, pose.fov, stats.effectivePixels);
      expect(magnification).toBeGreaterThan(16);
      // infrared as television: the detail reaches as far as the magnification carries it
      // (before: none at all in infrared)
      expect(draws[0].detail).toBeCloseTo(
        1600 * Math.min(sensorViewOverrides.detailScaleMax, magnification),
        6,
      );
      expect(draws[0].thermal).toBe(picture === 'CCD' ? 0 : 1);
      // the terrain drew the picture's own tiles, for its camera and magnification
      expect(draws[0].focused).toBe(true);
      expect(begun).toHaveLength(1);
      const want = pictureLodFocus(pose, magnification, createLodFocus());
      expect(begun[0]).toEqual(want);
      expect(begun[0].scale).toBe(SENSOR_RENDER.lodScaleMax);
      const look = new Vector3(begun[0].dx, begun[0].dy, begun[0].dz);
      expect(look.angleTo(sim.sensors.tgp.point.clone().sub(pose.position))).toBeLessThan(1e-9);
      // ...and the outside view's again afterwards, with its own hooks
      expect(ends).toBe(1);
      expect(active).toBe(false);
      expect(terrainUniforms.uDetailDistance.value).toBe(1600);
      expect(terrainUniforms.uThermal.value).toBe(0);
    });
  }

  it('draws the outside view’s tiles when the focus is switched off (sandbox focus=0)', () => {
    sensorViewOverrides.terrainFocus = false;
    const draws = frame(podSim('WHOT'));
    expect(draws).toHaveLength(1);
    expect(draws[0].focused).toBe(false);
    expect(begun).toHaveLength(0);
    expect(ends).toBe(0);
  });

  it('a picture’s focus: its pyramid, and its magnification up to the cap', () => {
    const pose = createSensorCameraPose();
    tgpCameraPose(podSim('WHOT'), pose);
    const f = pictureLodFocus(pose, 5, createLodFocus());
    expect(f.scale).toBe(5);
    expect(pictureLodFocus(pose, 0.3, createLodFocus()).scale).toBe(1);
    expect(pictureLodFocus(pose, 500, createLodFocus()).scale).toBe(SENSOR_RENDER.lodScaleMax);
    expect(f.tanHalf).toBeCloseTo(Math.tan(pose.fov / 2), 12);
    const d = new Vector3(f.dx, f.dy, f.dz);
    const r = new Vector3(f.rx, f.ry, f.rz);
    const u = new Vector3(f.ux, f.uy, f.uz);
    expect(d.distanceTo(pose.direction)).toBeLessThan(1e-9);
    // an orthonormal frame: right × up = back (a camera looks along −Z)
    expect(Math.abs(d.dot(r)) + Math.abs(d.dot(u)) + Math.abs(r.dot(u))).toBeLessThan(1e-9);
    expect(new Vector3().crossVectors(r, u).distanceTo(d.clone().negate())).toBeLessThan(1e-9);
    // the pod's picture is derotated: its right is level
    expect(Math.abs(r.y)).toBeLessThan(1e-9);
    // magnification: the outside view's pixel over the picture's
    expect(pictureMagnification(50, 720, 1 * DEG, 256)).toBeCloseTo(
      (2 * Math.tan(25 * DEG)) / 720 / (DEG / 256),
      9,
    );
    expect(pictureMagnification(50, 720, 40 * DEG, 16)).toBe(1);
  });
});
