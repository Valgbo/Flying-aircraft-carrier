/**
 * Ground contact (PLAN §5 "Ground"): hull points tested against the one terrain height
 * function. Any contact ends the flight with a 'crash' event, unless the realism flag
 * `invulnerable` is set, in which case the aircraft bounces off and flies on. The aircraft
 * always starts airborne; take-off and landing are out of scope, so the gear only adds its
 * wheels as contact points when it is down.
 */
import { Vector3 } from 'three';
import { A10_CONTACT as K } from '../../data/aircraft';
import { A10_GEOMETRY as GEO } from '../../data/geometry';
import type { Sim } from '../types';

type P = { readonly x: number; readonly y: number; readonly z: number };
const v = (p: P): Vector3 => new Vector3(p.x, p.y, p.z);
/** A measured point (data/geometry.ts `hull`, right side) and, off the centreline, its mirror. */
const both = (p: P): Vector3[] => (p.x === 0 ? [v(p)] : [v(p), new Vector3(-p.x, p.y, p.z)]);
const H = GEO.hull;

/** Hull points with the gear up (body frame), measured on the model. */
const HULL: readonly Vector3[] = [
  v(GEO.muzzle),
  ...both(H.noseTip),
  v(H.pavePenny), // right side only
  ...both(H.belly),
  ...both(H.aftBelly),
  ...both(H.tailTip),
  ...both(H.wingTip.leading),
  ...both(H.wingTip.trailing),
  ...both({ x: H.fin.x, y: H.fin.top.y, z: H.fin.top.z }),
  ...both({ x: H.fin.x, y: H.fin.bottom.y, z: H.fin.bottom.z }),
];
/** Gear up: the retracted main wheels stand out below their pods; the pods' ends. */
const PODS: readonly Vector3[] = [
  ...both(H.gearPod.tyre),
  ...both(H.gearPod.front),
  ...both(H.gearPod.rear),
];
/** Gear down: tyre contacts, struts uncompressed (the nose wheel is right of the centreline). */
const WHEELS: readonly Vector3[] = [
  GEO.gearContacts.nose,
  GEO.gearContacts.left,
  GEO.gearContacts.right,
].map(v);

/** Distance from the origin to the farthest hull point, m: no test needed above it. */
const REACH = Math.max(...[...HULL, ...WHEELS].map((p) => p.length())) + 1;

const _p = new Vector3();
const _n = new Vector3();
const _contact = new Vector3();
const _hit = { found: false, depth: 0 };

/** Deepest penetration of a list of hull points into the ground (fills _hit and _contact). */
function testPoints(sim: Sim, list: readonly Vector3[]): void {
  const ac = sim.aircraft;
  const terrain = sim.world.terrain;
  for (let i = 0; i < list.length; i++) {
    _p.copy(list[i]).applyQuaternion(ac.orientation).add(ac.position);
    const d = terrain.heightAt(_p.x, _p.z) - _p.y;
    if (d >= 0 && (!_hit.found || d > _hit.depth)) {
      _hit.depth = d;
      _hit.found = true;
      _contact.copy(_p);
    }
  }
}

/** Test the hull against the terrain; crash or bounce. Returns true on contact. */
export function checkGroundContact(sim: Sim): boolean {
  const ac = sim.aircraft;
  const terrain = sim.world.terrain;
  // Quick reject: well clear of the ground under the aircraft and of any slope within reach.
  if (ac.agl > REACH * 2 + 5) {
    ac.fcs.inContact = false;
    return false;
  }
  _hit.found = false;
  _hit.depth = 0;
  testPoints(sim, HULL);
  testPoints(sim, ac.gearPosition > 0.5 ? WHEELS : PODS);
  if (!_hit.found) {
    ac.fcs.inContact = false;
    return false;
  }
  const depth = _hit.depth;

  if (!sim.options.realism.invulnerable) {
    ac.crashed = true;
    const surface = terrain.surfaceAt(_contact.x, _contact.z);
    sim.events.push({
      type: 'crash',
      t: sim.time,
      position: { x: _contact.x, y: _contact.y, z: _contact.z },
      reason: surface === 'water' ? 'water' : 'terrain',
    });
    ac.velocity.set(0, 0, 0);
    ac.angularVelocity.set(0, 0, 0);
    return true;
  }

  // Invulnerable: lift the aircraft out of the ground and reflect the velocity off the surface.
  terrain.normalAt(_contact.x, _contact.z, _n);
  ac.position.addScaledVector(_n, depth / Math.max(0.2, _n.y) + 0.05);
  const vn = ac.velocity.dot(_n);
  if (vn < 0) {
    ac.velocity.addScaledVector(_n, -(1 + K.bounceRestitution) * vn);
    // Scrape: lose some speed along the ground.
    ac.velocity.multiplyScalar(0.95);
  }
  if (ac.velocity.dot(_n) < 2) ac.velocity.addScaledVector(_n, 2 - ac.velocity.dot(_n));
  ac.angularVelocity.multiplyScalar(0.5);
  if (!ac.fcs.inContact) {
    sim.events.push({ type: 'message', t: sim.time, text: 'GROUND CONTACT', level: 'warn' });
  }
  ac.fcs.inContact = true;
  return true;
}
