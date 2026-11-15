/** Hull — PLACEHOLDER: a box. The real hull also draws the four outrigger pylons. */
import { DECK, HULL } from '../config/layout';

export default function Hull() {
  const height = DECK.y - DECK.thickness - HULL.keelY;
  return (
    <mesh position={[0, HULL.keelY + height / 2, 0]} castShadow receiveShadow>
      <boxGeometry args={[HULL.beam, height, HULL.length]} />
      <meshStandardMaterial color="#5c6770" roughness={0.7} metalness={0.4} />
    </mesh>
  );
}
