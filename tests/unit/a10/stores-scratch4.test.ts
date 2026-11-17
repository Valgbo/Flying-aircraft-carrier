// SCRATCH probe 4: which per-step piece allocates.
import { Quaternion, Vector3 } from 'three';
import { it } from 'vitest';
import { SIM_DT } from '../../../src/a10/core/constants';
import { integrateRound, integrateStore, RoundType, storeModel } from '../../../src/a10/core/weapons';
import { createGunTestbed } from '../../../src/a10/core/weapons/testbed';
import { createFlatTerrain, windAt } from '../../../src/a10/core/world';

function measure(name: string, fn: () => void) {
  for (let k = 0; k < 20000; k++) fn();
  const out: string[] = [];
  for (let w = 0; w < 4; w++) {
    const h0 = process.memoryUsage().heapUsed;
    for (let k = 0; k < 20000; k++) fn();
    out.push(((process.memoryUsage().heapUsed - h0) / 20000).toFixed(1));
  }
  console.log(name.padEnd(20), 'bytes/call', out.join(' '));
}

it('probe4', () => {
  const sim = createGunTestbed({ terrain: createFlatTerrain(0), altitude: 5000 });
  const p = new Vector3(0, 5000, 0);
  const v = new Vector3(0, -100, -200);
  const w = new Vector3(3, 0, 1);
  const spec = storeModel('MK-82')!.spec;
  const rspec = storeModel('LAU-131-M151')!.spec;
  measure('windAt', () => windAt(sim.world, p, w));
  measure('integrate bomb', () => {
    p.set(0, 5000, 0);
    v.set(0, -100, -200);
    integrateStore(spec, p, v, w, SIM_DT, 3);
  });
  measure('integrate rocket', () => {
    p.set(0, 5000, 0);
    v.set(0, -100, -200);
    integrateStore(rspec, p, v, w, SIM_DT, 0.3);
  });
  const q = new Quaternion();
  const a = new Vector3(0, 0, -1);
  const b = new Vector3(0.1, -0.2, -1).normalize();
  const t = new Quaternion();
  const id = new Quaternion();
  const part = new Quaternion();
  measure('quaternion ops', () => {
    a.set(0, 0, -1).applyQuaternion(q);
    t.setFromUnitVectors(a, b);
    part.slerpQuaternions(id, t, 0.1);
    q.premultiply(part).normalize();
  });
  measure('integrateRound', () => {
    p.set(0, 5000, 0);
    v.set(0, -100, -900);
    integrateRound(RoundType.API, p, v, w, SIM_DT, 0);
  });
  measure('heightAt', () => sim.world.terrain.heightAt(p.x, p.z));
  measure('nothing', () => {});
});
