/**
 * Island — the faceted command superstructure on the ISLAND footprint: base block, flared
 * navigation bridge (ISLAND.bridgeEye sits just inside its forward windows), flight-control
 * gallery to port, sensor mast with a slowly rotating radar and a masthead light, and the
 * hull number on both flanks. Five draw calls. Per frame only the radar angle, the glow of
 * the windows and the brightness of the mast lights change.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { MeshBasicMaterial, MeshStandardMaterial, type Mesh } from 'three';
import { PALETTE } from '../config/palette';
import { sim } from '../state/sim';
import { useQuality } from '../state/useQuality';
import { deckLightBrightness } from './hull/deckLayout';
import {
  RADAR_PIVOT,
  buildIslandDecalGeometry,
  buildIslandGeometry,
  buildIslandLightGeometry,
  buildRadarGeometry,
} from './hull/islandGeometry';
import { useDecalMaterial, usePaintMaterial } from './hull/materials';

/** Radar rotation rate, rad/s (one turn in about eight seconds). */
const RADAR_RATE = 0.8;
const DAY_BRIGHTNESS = deckLightBrightness(1);
const NIGHT_BRIGHTNESS = deckLightBrightness(0);
/** Emissive strength of the windows by day and at night ("faintly lit from inside"). */
const WINDOW_GLOW_DAY = 0.02;
const WINDOW_GLOW_NIGHT = 0.16;

export default function Island() {
  const { detail } = useQuality();
  const { structure, glass } = useMemo(() => buildIslandGeometry(detail), [detail]);
  const radar = useMemo(() => buildRadarGeometry(), []);
  const lamps = useMemo(() => buildIslandLightGeometry(), []);
  const decals = useMemo(() => buildIslandDecalGeometry(), []);
  // single-sided on purpose: from the bridge camera the glass is simply not there
  const glassMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: PALETTE.glass,
        roughness: 0.14,
        metalness: 0.55,
        emissive: '#ffd49a',
        emissiveIntensity: WINDOW_GLOW_DAY,
      }),
    [],
  );
  const lampMaterial = useMemo(
    () => new MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    [],
  );
  const paint = usePaintMaterial();
  const decalMaterial = useDecalMaterial();
  useEffect(() => () => structure.dispose(), [structure]);
  useEffect(() => () => glass.dispose(), [glass]);
  useEffect(() => () => radar.dispose(), [radar]);
  useEffect(() => () => lamps.dispose(), [lamps]);
  useEffect(() => () => decals.dispose(), [decals]);
  useEffect(() => () => glassMaterial.dispose(), [glassMaterial]);
  useEffect(() => () => lampMaterial.dispose(), [lampMaterial]);

  const radarRef = useRef<Mesh>(null);
  const glassRef = useRef<Mesh>(null);
  const lampsRef = useRef<Mesh>(null);

  useFrame(() => {
    if (radarRef.current) radarRef.current.rotation.y = sim.time * RADAR_RATE;
    const brightness = deckLightBrightness(sim.env.daylight);
    // 0 by day … 1 at night, on the same curve as the deck lights
    const night = (brightness - DAY_BRIGHTNESS) / (NIGHT_BRIGHTNESS - DAY_BRIGHTNESS);
    if (glassRef.current) {
      (glassRef.current.material as MeshStandardMaterial).emissiveIntensity =
        WINDOW_GLOW_DAY + (WINDOW_GLOW_NIGHT - WINDOW_GLOW_DAY) * night;
    }
    if (lampsRef.current) {
      (lampsRef.current.material as MeshBasicMaterial).color.setScalar(brightness * 1.3);
    }
  });

  return (
    <group name="island">
      <mesh geometry={structure} material={paint} castShadow receiveShadow />
      <mesh ref={glassRef} geometry={glass} material={glassMaterial} castShadow receiveShadow />
      <mesh
        ref={radarRef}
        name="radar"
        position={[RADAR_PIVOT[0], RADAR_PIVOT[1], RADAR_PIVOT[2]]}
        geometry={radar}
        material={paint}
        castShadow
        receiveShadow
      />
      <mesh ref={lampsRef} name="mast-lights" geometry={lamps} material={lampMaterial} />
      <mesh geometry={decals} material={decalMaterial} receiveShadow />
    </group>
  );
}
