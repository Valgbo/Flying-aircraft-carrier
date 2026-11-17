import { Vector3 } from 'three';
import { it } from 'vitest';
import { bodyDirFromHudAngles } from '../../../src/a10/core/frames';
import { createSensorTestbed, stepSensorTestbed } from '../../../src/a10/core/sensors/testbed';
import { DEG } from '../../../src/a10/core/units';

it('mask map', () => {
  const sim = createSensorTestbed({ altitude: 3000, speed: 0 });
  stepSensorTestbed(sim);
  const t = sim.sensors.tgp;
  const rows: string[] = [];
  let up = 0, upMasked = 0;
  for (let el = 80; el >= -80; el -= 10) {
    let row = `${String(el).padStart(4)} `;
    for (let az = -180; az < 180; az += 15) {
      const d = bodyDirFromHudAngles(az * DEG, el * DEG, new Vector3()).applyQuaternion(sim.aircraft.orientation);
      t.mode = 'INR';
      t.internal.aimValid = false;
      t.internal.aimDir.copy(d);
      stepSensorTestbed(sim);
      const c = t.maskReason === 'NONE' ? '.' : t.maskReason === 'GIMBAL' ? 'G' : '#';
      row += c;
      if (el >= 20) { up++; if (c !== '.') upMasked++; }
    }
    rows.push(row);
  }
  console.log('az -180 .. 165 step 15 (left to right), el rows\n' + rows.join('\n'));
  console.log('upper hemisphere (el>=20) masked fraction', upMasked / up);
  console.log('head', t.head.toArray());
});
