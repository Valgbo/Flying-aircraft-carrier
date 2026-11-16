/**
 * World — everything above the water that is not a cloud: the sky dome, the sun / moon
 * directional light with its ship-following shadow frustum, hemisphere + ambient fill, and
 * the scene fog. All of it is driven by `settings.timeOfDay` through the time-of-day model in
 * `./sky/timeOfDay`.
 *
 * The work is done by the carrier-free `SkyWorld` (shared with the A-10 app through
 * src/engine); this wrapper hands it the carrier's state: `sim.env` (written every frame:
 * sunDirection, daylight, sunColor, horizonColor, zenithColor), the sim clock, the time-of-day
 * setting, the ship as shadow focus and the quality preset's shadow settings.
 */
import { CARRIER_BOUNDING_RADIUS } from '../config/layout';
import { sim } from '../state/sim';
import { useGameStore } from '../state/useGameStore';
import { useQuality } from '../state/useQuality';
import { getSkyState } from './sky/currentSky';
import SkyWorld from './sky/SkyWorld';

/** The sky for the time-of-day setting, read every frame (non-reactive). */
const getCarrierSky = () => getSkyState(useGameStore.getState().settings.timeOfDay);

export default function World() {
  const quality = useQuality();
  return (
    <SkyWorld
      env={sim.env}
      clock={sim}
      getSky={getCarrierSky}
      shadowFocus={sim.carrier.position}
      shadowRadius={CARRIER_BOUNDING_RADIUS}
      castShadow={quality.shadows}
      shadowMapSize={quality.shadowMapSize}
    />
  );
}
