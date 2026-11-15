/** Island — PLACEHOLDER: a box. The real island has a bridge, mast and rotating radar. */
import { DECK, ISLAND } from '../config/layout';

export default function Island() {
  return (
    <mesh
      position={[ISLAND.centerX, DECK.y + ISLAND.height / 2, ISLAND.centerZ]}
      castShadow
      receiveShadow
    >
      <boxGeometry args={[ISLAND.width, ISLAND.height, ISLAND.length]} />
      <meshStandardMaterial color="#6a7680" roughness={0.6} metalness={0.4} />
    </mesh>
  );
}
