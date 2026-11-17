import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  addVehicle,
  aimPodAt,
  createSensorTestbed,
  runSensorTestbed,
} from '../../../src/a10/core/sensors/testbed';

describe('sensors smoke', () => {
  it('steps', () => {
    const sim = createSensorTestbed({ altitude: 2000 });
    const v = addVehicle(sim, 'mbt', 0, -6000, Math.PI / 2, { speed: 0 });
    aimPodAt(sim, new Vector3(0, 0, -6000));
    runSensorTestbed(sim, 1);
    const t = sim.sensors.tgp;
    console.log(t.station, t.mode, t.masked, t.maskReason, t.los.toArray(), t.point.toArray(), t.head.toArray());
    console.log(sim.sensors.mavericks.map((m) => [m.station, m.type, m.rail, m.selected, m.mode, m.align]));
    expect(t.station).toBe(10);
    void v;
  });
});
