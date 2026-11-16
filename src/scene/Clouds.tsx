/**
 * Clouds — an endless layer of scattered cumulus the ship can fly under, through and above.
 *
 * The work is done by the carrier-free `CloudLayer` (shared with the A-10 app through
 * src/engine); this wrapper hands it the carrier's state: `sim.env` (it writes `cloudCover`,
 * how deep the camera is inside cloud, which thickens the fog), the sim clock, the time-of-day
 * setting and the quality preset's cloud count. The layer keeps its default shape (the sea
 * deck at 900–2400 m) and constant wind.
 */
import { sim } from '../state/sim';
import { useGameStore } from '../state/useGameStore';
import { useQuality } from '../state/useQuality';
import CloudLayer from './sky/CloudLayer';
import { getSkyState } from './sky/currentSky';

/** The sky for the time-of-day setting, read every frame (non-reactive). */
const getCarrierSky = () => getSkyState(useGameStore.getState().settings.timeOfDay);

export default function Clouds() {
  const cloudCount = useQuality().cloudCount;
  return <CloudLayer env={sim.env} clock={sim} getSky={getCarrierSky} cloudCount={cloudCount} />;
}
