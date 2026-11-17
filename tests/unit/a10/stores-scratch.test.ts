// SCRATCH probe (removed before the end): prints model numbers for fitting.
import { Vector3 } from 'three';
import { it } from 'vitest';
import { storeBallistics, stepError, type CalibrationShot } from '../../../src/a10/core/avionics';
import { SIM_DT } from '../../../src/a10/core/constants';
import { DEG, KT, FT } from '../../../src/a10/core/units';
import {
  fragmentEnvelope,
  integrateStore,
  storeModel,
  motorThrustAt,
} from '../../../src/a10/core/weapons';
import { BLAST } from '../../../src/a10/data/vehicles';

function fly(key: string, p0: Vector3, v0: Vector3, ground: number, dt = SIM_DT, wind = new Vector3()) {
  const m = storeModel(key)!;
  const p = p0.clone();
  const v = v0.clone();
  let t = 0;
  let prev = p.clone();
  let pv = v.clone();
  while (t < 120) {
    prev.copy(p);
    pv.copy(v);
    integrateStore(m.spec, p, v, wind, dt, t);
    t += dt;
    if (p.y <= ground) {
      const f = (prev.y - ground) / (prev.y - p.y);
      const hit = prev.clone().lerp(p, f);
      const vh = pv.clone().lerp(v, f);
      return { t: t - dt + f * dt, p: hit, v: vh };
    }
  }
  return null;
}

it('probe', () => {
  console.log('registered MK-82:', !!storeBallistics('MK-82'), 'HD:', !!storeBallistics('MK-82AIR/HD'));
  const r = storeModel('LAU-131-M151')!;
  console.log('rocket spec', r.spec.mass, r.spec.motorOffset, r.ejection, Array.from(r.spec.breaks));
  console.log('motor', Array.from(r.spec.motor!.thrust), r.spec.motor!.totalImpulse, r.spec.motor!.burnTime);
  // static launch at sea level, horizontal
  const m = r.spec;
  const p = new Vector3(0, 50, 0);
  const v = new Vector3(0, 0, -Math.hypot(r.ejection.y, r.ejection.z));
  let t = 0;
  const burnEnd = m.motor!.burnTime - m.motorOffset;
  while (t < burnEnd - 1e-9) {
    const h = Math.min(SIM_DT, burnEnd - t);
    integrateStore(m, p, v, new Vector3(), h, t);
    t += h;
  }
  console.log('static burnout speed', v.length(), 'at', t + m.motorOffset, 'dist', p.length(), 'drop', 50 - p.y);
  console.log('thrust at 0.5', motorThrustAt(m.motor!, 0.5));

  // Mk-82 30 deg dive 300 kn released 1500 m above target
  const dive = 30 * DEG;
  const V = 300 * KT;
  const p0 = new Vector3(0, 1500, 0);
  const v0 = new Vector3(0, -Math.sin(dive) * V, -Math.cos(dive) * V);
  for (const key of ['MK-82', 'MK-82AIR', 'MK-82AIR/HD', 'GBU-12']) {
    const a = fly(key, p0, v0, 0);
    console.log(key, 'TOF', a!.t.toFixed(3), 'range', (-a!.p.z).toFixed(1), 'impact angle', (Math.atan2(-a!.v.y, Math.hypot(a!.v.x, a!.v.z)) / DEG).toFixed(1), 'speed', a!.v.length().toFixed(1));
  }
  // level 5000 ft 300 kn
  const pl = new Vector3(0, 5000 * FT, 0);
  const vl = new Vector3(0, 0, -V);
  for (const key of ['MK-82', 'MK-82AIR/HD']) {
    const a = fly(key, pl, vl, 0);
    console.log('level 5000ft', key, 'TOF', a!.t.toFixed(3), 'range', (-a!.p.z).toFixed(1));
  }
  // low level 300 ft 450 kn
  const pll = new Vector3(0, 300 * FT, 0);
  const vll = new Vector3(0, 0, -450 * KT);
  for (const key of ['MK-82', 'MK-82AIR/HD']) {
    const a = fly(key, pll, vll, 0);
    console.log('low 300ft 450kn', key, 'TOF', a!.t.toFixed(3), 'range', (-a!.p.z).toFixed(1), 'trail', (450 * KT * a!.t + a!.p.z).toFixed(1), 'angle', (Math.atan2(-a!.v.y, Math.hypot(a!.v.x, a!.v.z)) / DEG).toFixed(1));
  }
  // predictor step errors vs SIM_DT
  for (const key of ['MK-82', 'MK-82AIR/HD', 'LAU-131-M151', 'GBU-12']) {
    const model = storeModel(key)!;
    for (const dt of [1 / 4, 1 / 8, 1 / 10, 1 / 15, 1 / 20, 1 / 30]) {
      const shots: CalibrationShot[] = [
        { origin: { x: 0, y: 1500, z: 0 }, velocity: { x: 0, y: v0.y, z: v0.z }, wind: { x: 7.7, y: 0, z: 0 }, groundHeight: 0 },
        { origin: { x: 0, y: 5000 * FT, z: 0 }, velocity: { x: 0, y: 0, z: -V }, wind: { x: 7.7, y: 0, z: 0 }, groundHeight: 0 },
        { origin: { x: 0, y: 300 * FT, z: 0 }, velocity: { x: 0, y: 0, z: -450 * KT }, wind: { x: 0, y: 0, z: 0 }, groundHeight: 0 },
      ];
      const shotsR: CalibrationShot[] = [
        { origin: { x: 0, y: 600, z: 0 }, velocity: { x: 0, y: -Math.sin(20 * DEG) * V, z: -Math.cos(20 * DEG) * V - 45 }, wind: { x: 7.7, y: 0, z: 0 }, groundHeight: 0 },
      ];
      const err = stepError(model, key.startsWith('LAU') ? shotsR : shots, dt, SIM_DT);
      console.log('stepError', key, dt.toFixed(4), (err * 1000).toFixed(4), 'mrad');
    }
  }
  console.log('envelope Mk82', fragmentEnvelope(BLAST.mk82ChargeKg, BLAST.mk82FragmentKg));
  console.log('envelope M151', fragmentEnvelope(1.15, 2.7));
  console.log('envelope M156', fragmentEnvelope(0.12, 1.0));
  console.log('envelope Mk82 buried', fragmentEnvelope(96 * 0.6, 125 * 0.25));
});
