/**
 * The cockpit: model, instruments, clickable switches, display screens, lighting and shadows,
 * drawn in the `cockpit` render pass (order 200), and the vision overlay (order 450) for
 * grey-out, black-out and red-out. OWNED BY THE COCKPIT MODULE (docs/a10/ARCHITECTURE.md §6).
 *
 * Cockpit pass, while the cockpit view is active: clear depth (every frame, even before the
 * model has loaded — the HUD's stencil glass is depth-tested against the cockpit), draw the
 * cockpit shadow map, then `cockpitScene` with `cockpitCamera` into ctx.target.
 *
 * Clicks: while the cursor is free (viewInput.cursorFree) the control under the pointer is
 * highlighted; a click on it queues its Command (switches.ts) with pushCommand and clears
 * viewInput.click. The avionics emit `switch` events, which the audio module clicks on.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { PCFSoftShadowMap, type ShadowMapType } from 'three';
import { onAircraftTemplates } from '../../assets';
import { pushCommand } from '../../core/sim';
import type { Sim } from '../../core/types';
import { viewInput } from '../../input/viewInput';
import { getSim } from '../../state/runtime';
import { frameInfo } from '../frame';
import { registerRenderPass } from '../pipeline';
import { getA10Quality } from '../quality';
import { cockpitCamera, cockpitScene, cockpitViewState } from './cockpitCamera';
import { CockpitModel } from './cockpitModel';
import { commandForControl } from './switches';
import {
  createVisionState,
  resetVision,
  stepVision,
  VisionOverlay,
  type VisionState,
} from './vision';

/** The live cockpit, for the sandbox and debugging (null before the models load). */
export const cockpitHandle: {
  current: CockpitModel | null;
  vision: VisionState | null;
} = { current: null, vision: null };

/**
 * Build the cockpit (once the aircraft models are loaded), register its render passes and drive
 * it from `source` every frame, for as long as the calling component is mounted.
 */
export function useCockpit(source: () => Sim | null): void {
  const size = useThree((s) => s.size);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const state = useMemo(
    () => ({
      model: null as CockpitModel | null,
      vision: createVisionState(),
      overlay: null as VisionOverlay | null,
      lastClick: null as object | null,
      sim: null as Sim | null,
      halfRate: false,
    }),
    [],
  );

  // the model, once the templates exist
  useEffect(() => {
    let model: CockpitModel | null = null;
    const off = onAircraftTemplates((t) => {
      model = new CockpitModel(cockpitScene, t);
      state.model = model;
      cockpitHandle.current = model;
      if (import.meta.env.DEV && typeof window !== 'undefined')
        (window as unknown as { __A10_COCKPIT_VIEW__?: typeof cockpitHandle }).__A10_COCKPIT_VIEW__ =
          cockpitHandle;
    });
    return () => {
      off();
      if (model) {
        model.dispose();
        if (cockpitHandle.current === model) cockpitHandle.current = null;
      }
      state.model = null;
    };
  }, [state]);

  // the cockpit pass and the vision overlay
  useEffect(() => {
    const overlay = new VisionOverlay();
    state.overlay = overlay;
    cockpitHandle.vision = state.vision;
    const offCockpit = registerRenderPass({
      id: 'cockpit',
      order: 200,
      enabled: () => cockpitViewState.active && source() !== null,
      render(ctx) {
        const gl = ctx.gl;
        gl.setRenderTarget(ctx.target);
        const autoClear = gl.autoClear;
        gl.autoClear = false;
        gl.clear(false, true, false);
        const model = state.model;
        if (model) {
          model.renderShadows(gl, state.halfRate);
          gl.setRenderTarget(ctx.target);
          const sm = gl.shadowMap;
          const enabled = sm.enabled;
          const type: ShadowMapType = sm.type;
          const auto = sm.autoUpdate;
          const needs = sm.needsUpdate;
          sm.enabled = model.lights.shadows;
          sm.type = PCFSoftShadowMap;
          // the shadow map was drawn above from the casters' proxy: sample it, do not redraw it
          sm.autoUpdate = false;
          sm.needsUpdate = false;
          gl.render(cockpitScene, cockpitCamera);
          sm.enabled = enabled;
          sm.type = type;
          sm.autoUpdate = auto;
          sm.needsUpdate = needs;
        }
        gl.autoClear = autoClear;
      },
    });
    const offVision = registerRenderPass({
      id: 'vision',
      order: 450,
      enabled: () =>
        cockpitViewState.active && source() !== null && VisionOverlay.visible(state.vision),
      render(ctx) {
        overlay.render(ctx, state.vision);
      },
    });
    return () => {
      offCockpit();
      offVision();
      overlay.dispose();
      state.overlay = null;
      if (cockpitHandle.vision === state.vision) cockpitHandle.vision = null;
    };
  }, [source, state]);

  // every frame, after the camera rig (priority 0): instruments, lights, vision, clicks
  useFrame(() => {
    const sim = source();
    if (!sim) return;
    if (sim !== state.sim) {
      state.sim = sim;
      resetVision(state.vision);
      state.lastClick = null;
    }
    const simDt = frameInfo.simDt;
    stepVision(state.vision, sim.aircraft.gLoad, simDt);
    const model = state.model;
    if (!model || !cockpitViewState.active) {
      model?.highlight.show(null, '', cockpitCamera, 1);
      return;
    }
    const q = getA10Quality();
    state.halfRate = q.level !== 'high';
    model.update({
      sim,
      simDt,
      shadows: q.shadows,
      shadowMapSize: q.level === 'high' ? 2048 : 1024,
    });

    // the free cursor: hover highlight and clicks
    const height = sizeRef.current.height;
    if (viewInput.cursorFree) {
      model.hover(cockpitCamera, { x: viewInput.pointerX, y: viewInput.pointerY }, height);
      const click = viewInput.click;
      if (click && click !== state.lastClick) {
        state.lastClick = click;
        const hit = model.pick(cockpitCamera, click.x, click.y);
        if (hit) {
          if (!model.localAction(hit.id, sim)) {
            const command = commandForControl(hit.id, click.button, model.switchState);
            if (command) pushCommand(sim, command);
          }
          viewInput.click = null;
        }
      }
    } else model.hover(cockpitCamera, null, height);
  });
}

export default function CockpitView() {
  useCockpit(getSim);
  return null;
}
