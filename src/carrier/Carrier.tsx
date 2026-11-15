/**
 * Carrier — root group of the ship. Follows `sim.carrier` every frame and composes the parts.
 * Children are positioned in the CARRIER-LOCAL frame (see src/config/layout.ts).
 */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group } from 'three';
import { TURBINE_MOUNTS } from '../config/layout';
import { sim } from '../state/sim';
import type { TurbineIndex } from '../state/types';
import Deck from './Deck';
import Hull from './Hull';
import Island from './Island';
import Turbine from './Turbine';

export default function Carrier() {
  const group = useRef<Group>(null);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.position.copy(sim.carrier.position);
    g.quaternion.copy(sim.carrier.quaternion);
  });
  return (
    <group ref={group} name="carrier">
      <Hull />
      <Deck />
      <Island />
      {TURBINE_MOUNTS.map((mount, i) => (
        <group key={i} position={[mount[0], mount[1], mount[2]]}>
          <Turbine index={i as TurbineIndex} />
        </group>
      ))}
    </group>
  );
}
