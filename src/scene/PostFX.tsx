/**
 * PostFX — the post-processing chain, gated by the quality preset:
 *
 *   heat distortion (quality.heatDistortion) → bloom (quality.bloom) → vignette → ACES tone mapping
 *
 * The work is done by the carrier-free `PostFXView` (shared with the A-10 app through
 * src/engine); this wrapper hands it the carrier's quality preset, its sim clock and the
 * turbine heat distortion, which is the carrier's own effect.
 *
 * Tone-mapping ownership (docs/ARCHITECTURE.md, rendering rules): while the chain is
 * mounted the renderer uses NoToneMapping and the chain tone-maps; while it is not (Low
 * preset) the renderer tone-maps with ACES itself. Exposure is 1 in both paths.
 */
import type { PerspectiveCamera } from 'three';
import { sim } from '../state/sim';
import { useQuality } from '../state/useQuality';
import { HeatDistortionEffect } from './postfx/HeatDistortionEffect';
import PostFXView from './postfx/PostFXView';

/** MSAA samples of the scene buffer when the preset has anti-aliasing. */
const MSAA_SAMPLES = 4;

const getSimDt = () => sim.dt;
const carrierHeat = (camera: PerspectiveCamera) => [new HeatDistortionEffect(camera)];

export default function PostFX() {
  const quality = useQuality();
  return (
    <PostFXView
      enabled={quality.postprocessing}
      bloom={quality.bloom}
      multisampling={quality.antialias ? MSAA_SAMPLES : 0}
      getDelta={getSimDt}
      createPreEffects={quality.heatDistortion ? carrierHeat : null}
    />
  );
}
