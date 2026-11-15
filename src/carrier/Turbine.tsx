/**
 * Turbine — one tilting ducted fan. Rendered at its tilt pivot (the parent group sits at
 * TURBINE_MOUNTS[index]); axes are the carrier-local axes. The whole nacelle rotates by -tilt
 * about X (positive tilt leans the intake toward the bow), the fan spins from
 * turbineRpmFraction and cross-fades into a motion-blur disc at speed, and the combustion
 * glow below the fan follows the throttle. The exhaust is mounted in the tilting frame.
 *
 * Draw calls per turbine: nacelle, number decal, rotor hub, blades, blur disc, glow
 * (+ plume, particles and spray in TurbineExhaust). Geometry, textures and materials are
 * shared between the four turbines (src/carrier/turbine/assets.ts); only the blade material
 * is cloned, because a built-in material cannot take a per-object opacity.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { Group, Mesh } from 'three';
import { sim } from '../state/sim';
import { turbineRpmFraction } from '../state/simHelpers';
import type { TurbineIndex } from '../state/types';
import { useQuality } from '../state/useQuality';
import { TAU } from '../utils/math';
import TurbineExhaust from './TurbineExhaust';
import { useNacelleAssets } from './turbine/assets';
import { fxEnv, syncTurbineFx } from './turbine/fxState';
import { GLOW_ORIGIN_Y } from './turbine/geometry';
import { FAN_Y, MAX_SPIN, bladeOpacity, blurOpacity, spinDirection } from './turbine/model';

/** The lobes of the blur disc creep round at this fraction of the true fan speed. */
const BLUR_CREEP = 0.035;
/** Share of the combustion glow that lights the blurred fan from below. */
const DISC_GLOW = 0.12;

export default function Turbine({ index }: { index: TurbineIndex }) {
  const quality = useQuality();
  const assets = useNacelleAssets(quality.detail);
  const bladeMaterial = useMemo(() => assets.bladeMaterial.clone(), [assets]);
  useEffect(() => () => bladeMaterial.dispose(), [bladeMaterial]);

  const pivot = useRef<Group>(null);
  const rotor = useRef<Group>(null);
  const blades = useRef<Mesh>(null);
  const disc = useRef<Mesh>(null);
  const glow = useRef<Mesh>(null);
  const fan = useRef({ angle: index * 0.9, creep: 0, blur: 0 });
  const direction = spinDirection(index);

  // The glow and disc materials are shared: each mesh loads its own turbine's values into
  // the uniforms right before it is drawn.
  const beforeRender = useMemo(
    () => ({
      glow() {
        const fx = syncTurbineFx(index, fxEnv.frame);
        const u = assets.glowMaterial.uniforms;
        u.uColor.value.copy(fx.glowColor);
        u.uIntensity.value = fx.glow;
        u.uCore.value = fx.core;
        u.uTime.value = sim.time + index * 5.3;
        assets.glowMaterial.uniformsNeedUpdate = true;
      },
      disc() {
        const fx = syncTurbineFx(index, fxEnv.frame);
        const u = assets.discMaterial.uniforms;
        u.uOpacity.value = fan.current.blur;
        u.uLightAbove.value.copy(fxEnv.light);
        u.uLightBelow.value.copy(fxEnv.light).multiplyScalar(0.3);
        u.uGlow.value.copy(fx.glowColor).multiplyScalar(fx.glow * DISC_GLOW);
        assets.discMaterial.uniformsNeedUpdate = true;
      },
    }),
    [assets, index],
  );

  useFrame((state) => {
    const turbine = sim.turbines[index];
    const fx = syncTurbineFx(index, state.gl.info.render.frame);
    // positive tilt leans the thrust axis (+Y) toward the bow (-Z): a rotation of -tilt about X
    if (pivot.current) pivot.current.rotation.x = -turbine.tilt;

    const rpm = turbineRpmFraction(turbine);
    const f = fan.current;
    const step = direction * rpm * MAX_SPIN * sim.dt;
    f.angle = (f.angle + step) % TAU;
    f.creep = (f.creep + step * BLUR_CREEP) % TAU;
    f.blur = blurOpacity(rpm);
    if (rotor.current) rotor.current.rotation.y = f.angle;

    const opacity = bladeOpacity(rpm);
    bladeMaterial.opacity = opacity;
    if (blades.current) blades.current.castShadow = opacity > 0.5;
    if (disc.current) {
      disc.current.rotation.y = f.creep;
      disc.current.visible = f.blur > 0.004;
    }
    if (glow.current) glow.current.visible = fx.glow > 0.004;
  });

  return (
    <group ref={pivot} dispose={null}>
      <mesh
        geometry={assets.nacelle}
        material={assets.nacelleMaterial}
        castShadow
        receiveShadow
      />
      <mesh geometry={assets.decals[index]} material={assets.decalMaterial} receiveShadow />
      <group ref={rotor} position-y={FAN_Y}>
        <mesh geometry={assets.rotor} material={assets.nacelleMaterial} castShadow receiveShadow />
        <mesh
          ref={blades}
          geometry={assets.blades}
          material={bladeMaterial}
          scale-x={direction}
          castShadow
          receiveShadow
        />
      </group>
      <mesh
        ref={disc}
        geometry={assets.blurDisc}
        material={assets.discMaterial}
        position-y={FAN_Y}
        onBeforeRender={beforeRender.disc}
      />
      <mesh
        ref={glow}
        geometry={assets.glow}
        material={assets.glowMaterial}
        position-y={GLOW_ORIGIN_Y}
        onBeforeRender={beforeRender.glow}
      />
      <TurbineExhaust index={index} />
    </group>
  );
}
