import { Vector3 } from 'three';
import { it } from 'vitest';
import { createSim } from '../../../src/a10/core/sim';
import { createVehicle, resolveRoundHit, segmentHitVehicle, VEHICLE_MODELS, type VehicleHit, type RoundHitResult } from '../../../src/a10/core/targets';
import { RoundType } from '../../../src/a10/core/weapons';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { VEHICLE_SHAPES } from '../../../src/a10/data/vehicles';

it('scratch: sight HEI', () => {
  const sim = createSim({ seed: 6, terrain: createFlatTerrain(0), scenario: 'empty' });
  const mbt = VEHICLE_SHAPES.mbt;
  const TOP = mbt.hullClearance + mbt.hullHeight;
  const TZ = mbt.turret!.offsetZ;
  for (let i = 0; i < 3; i++) {
    const v = createVehicle(sim, 'mbt', 60 * i, 0, Math.PI, 1);
    const vel = new Vector3(0, -400, 800);
    const dir = vel.clone().normalize();
    const aim = [-0.42, TOP + mbt.turret!.height, TZ - 0.5];
    const h = v.heading;
    const p = new Vector3(v.position.x + aim[0] * Math.cos(h) - aim[2] * Math.sin(h), aim[1], v.position.z + aim[0] * Math.sin(h) + aim[2] * Math.cos(h));
    const hit: VehicleHit = { vehicleId: 0, t: 0, point: new Vector3(), normal: new Vector3(), thicknessMm: 0, part: 'hull', face: 'front', plate: 0 };
    const res: RoundHitResult = { outcome: 'stopped', obliquity: 0, effectiveThicknessMm: 0, penetrationMm: 0, damaged: [], ricochetVelocity: new Vector3() };
    const ok = segmentHitVehicle(sim, p.clone().addScaledVector(dir, -30), p.clone().addScaledVector(dir, 1), hit);
    if (ok) resolveRoundHit(sim, hit, RoundType.HEI, vel, res);
    console.log(i, ok, ok ? VEHICLE_MODELS.mbt.plates[hit.plate].name : '', res.outcome, res.damaged.join('+'), 'pt', hit.point.toArray().map((q) => q.toFixed(2)).join(','), 'pos', v.position.toArray().join(','));
  }
});
