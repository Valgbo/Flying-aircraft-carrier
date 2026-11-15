/**
 * TurbineExhaust — exhaust of one turbine. Rendered inside the turbine's TILTING frame: the
 * exhaust leaves along local -Y from the bottom of the duct (y = -ductHeight / 2).
 *
 *   plume     — additive hot core below the nozzle, 20 m (idle) to 110 m (full power)
 *   particles — sparks and vapour, GPU-animated (one draw call, no per-frame CPU work),
 *               trailing in the airflow past the ship
 *   spray     — mist where the exhaust hits the sea; lives in WORLD space (portalled into the
 *               scene) at the impact point reported by getDownwash
 *
 * Materials are shared between the four turbines; each mesh loads its own values into the
 * uniforms in onBeforeRender. Nothing is drawn while the engine is shut down.
 *
 * Sorting: none of the three writes depth and all stay at renderOrder 0, so three.js sorts
 * them back to front with the fan, the glow and everybody else's transparent effects — after
 * the opaque ocean and the clouds (renderOrder -10). Plume and particles share one origin; the
 * plume is created first and therefore drawn first, with the vapour laid over it.
 */
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Camera, Mesh } from 'three';
import { waveHeightAt } from '../config/waves';
import { sim } from '../state/sim';
import { getDownwash, type Downwash } from '../state/simHelpers';
import type { TurbineIndex } from '../state/types';
import { getQuality, useQuality } from '../state/useQuality';
import { smoothstep } from '../utils/math';
import { useExhaustAssets } from './turbine/assets';
import { fxEnv, syncTurbineFx } from './turbine/fxState';
import { NOZZLE_Y, exhaustExposure, exhaustSpeed, plumeLength, sprayRadius } from './turbine/model';

/** Below this drive the engine counts as shut down and nothing is drawn. */
const MIN_DRIVE = 0.004;
/** Brightness of the plume core on presets without bloom, relative to the HDR value. */
const NO_BLOOM_EXPOSURE = 0.62;
/** The bent plume core never leans further sideways than this fraction of its length. */
const MAX_PLUME_LEAN = 0.9;

const _downwash: Downwash = { x: 0, z: 0, distance: 0, strength: 0 };

export default function TurbineExhaust({ index }: { index: TurbineIndex }) {
  const quality = useQuality();
  const assets = useExhaustAssets(quality.detail, quality.exhaustParticles);
  const scene = useThree((state) => state.scene);
  const plume = useRef<Mesh>(null);
  const particles = useRef<Mesh>(null);
  const spray = useRef<Mesh>(null);
  const impact = useRef({ strength: 0 });

  const beforeRender = useMemo(
    () => ({
      plume() {
        const fx = syncTurbineFx(index, fxEnv.frame);
        const u = assets.plumeMaterial.uniforms;
        const length = plumeLength(fx.drive);
        // sideways drift of the tip: time of flight along the core × airflow across it
        const lean = Math.min(
          length / exhaustSpeed(fx.drive),
          (MAX_PLUME_LEAN * length) / Math.max(1, Math.hypot(fx.relVel.x, fx.relVel.z)),
        );
        u.uLength.value = length;
        u.uDrift.value.set(-fx.relVel.x * lean, 0, -fx.relVel.z * lean);
        u.uPower.value = fx.drive;
        // without a bloom pass (and its tone mapping) the HDR core would clip to flat white
        const exposure =
          exhaustExposure(sim.env.daylight) * (getQuality().bloom ? 1 : NO_BLOOM_EXPOSURE);
        u.uIntensity.value = exposure * (0.25 + 1.35 * fx.drive) * smoothstep(0, 0.08, fx.drive);
        u.uTime.value = sim.time + index * 3.7;
        assets.plumeMaterial.uniformsNeedUpdate = true;
      },
      particles(_renderer: unknown, _scene: unknown, camera: Camera) {
        const fx = syncTurbineFx(index, fxEnv.frame);
        const u = assets.particleMaterial.uniforms;
        if (particles.current) {
          particles.current.worldToLocal(u.uEye.value.setFromMatrixPosition(camera.matrixWorld));
        }
        u.uTime.value = sim.time + index * 7.31;
        u.uSpeed.value = exhaustSpeed(fx.drive);
        u.uOpacity.value =
          exhaustExposure(sim.env.daylight) *
          smoothstep(0, 0.1, fx.drive) *
          (0.55 + 0.45 * fx.drive);
        u.uRelVel.value.copy(fx.relVel);
        u.uTint.value.copy(fxEnv.mist);
        assets.particleMaterial.uniformsNeedUpdate = true;
      },
      spray() {
        const u = assets.sprayMaterial.uniforms;
        u.uTime.value = sim.time + index * 1.93;
        u.uStrength.value = impact.current.strength;
        u.uRadius.value = sprayRadius(impact.current.strength);
        u.uTint.value.copy(fxEnv.mist);
        assets.sprayMaterial.uniformsNeedUpdate = true;
      },
    }),
    [assets, index],
  );

  useFrame((state) => {
    const fx = syncTurbineFx(index, state.gl.info.render.frame);
    const running = fx.drive > MIN_DRIVE;
    if (plume.current) plume.current.visible = running;
    if (particles.current) particles.current.visible = running;

    // sea spray: follows the impact point of the exhaust column on the water, in world space
    const mist = spray.current;
    if (!mist) return;
    const strength = running ? getDownwash(index, _downwash).strength : 0;
    impact.current.strength = strength;
    mist.visible = strength > 0.01;
    if (mist.visible) {
      mist.position.set(_downwash.x, waveHeightAt(_downwash.x, _downwash.z, sim.time), _downwash.z);
    }
  });

  return (
    <group position-y={NOZZLE_Y} dispose={null}>
      <mesh
        ref={plume}
        geometry={assets.plume}
        material={assets.plumeMaterial}
        frustumCulled={false}
        onBeforeRender={beforeRender.plume}
      />
      <mesh
        ref={particles}
        geometry={assets.particles}
        material={assets.particleMaterial}
        frustumCulled={false}
        onBeforeRender={beforeRender.particles}
      />
      {createPortal(
        <mesh
          ref={spray}
          geometry={assets.spray}
          material={assets.sprayMaterial}
          frustumCulled={false}
          visible={false}
          dispose={null}
          onBeforeRender={beforeRender.spray}
        />,
        scene,
      )}
    </group>
  );
}
