/** Deck — PLACEHOLDER: a slab. The real deck has markings, lights, catapults, wires and the elevator. */
import { DECK, HULL } from '../config/layout';

export default function Deck() {
  return (
    <mesh position={[0, DECK.y - DECK.thickness / 2, 0]} castShadow receiveShadow>
      <boxGeometry args={[DECK.halfWidth * 2, DECK.thickness, HULL.length - 4]} />
      <meshStandardMaterial color="#3a4046" roughness={0.9} metalness={0.1} />
    </mesh>
  );
}
