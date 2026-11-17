/**
 * Ground contact (PLAN §5 "Ground"): hull points tested against the one terrain height function
 * and the tree canopy on it (heightAt + canopyAt). The canopy is a solid volume for line of sight
 * and for the PULL UP prediction, so it is one for the hull as well: flying through the trees is
 * flying into the ground (review FC-7). Any contact ends the flight with a 'crash' event, unless
 * the realism flag `invulnerable` is set (Relaxed): then the aircraft bounces off and is put back
 * into flight (review FC-2): it leaves along the surface, climbing gently away from it with most
 * of its speed (never less than a safe flying speed), wings level and its nose on the new path
 * at the angle of attack that holds 1 g. A plain reflection of the velocity left a steep impact
 * pointing its nose into the ground, with no airspeed, bouncing for good.
 *
 * The aircraft always starts airborne; take-off and landing are out of scope, so the gear only
 * adds its wheels as contact points when it is down.
 */
import { Vector3 } from 'three';
import { A10, A10_AERO, A10_CONTACT as K } from '../../data/aircraft';
import { A10_GEOMETRY as GEO } from '../../data/geometry';
import { G0 } from '../constants';
import { quaternionFromAttitude } from '../frames';
import type { Sim } from '../types';
import { densityAt } from '../world';
import { clamp } from './util';

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
/** Tallest tree canopy allowed for, m (generated forests are 12–20 m tall). */
const MAX_CANOPY = 40;

const _p = new Vector3();
const _n = new Vector3();
const _t = new Vector3();
const _contact = new Vector3();
const _hit = { found: false, depth: 0, trees: false };

/**
 * Deepest penetration of a list of hull points into the ground or the tree canopy (fills _hit and
 * _contact). The canopy is only looked up for points within its reach of the ground.
 */
function testPoints(sim: Sim, list: readonly Vector3[]): void {
  const ac = sim.aircraft;
  const terrain = sim.world.terrain;
  for (let i = 0; i < list.length; i++) {
    _p.copy(list[i]).applyQuaternion(ac.orientation).add(ac.position);
    const ground = terrain.heightAt(_p.x, _p.z);
    let top = ground;
    if (_p.y - ground < MAX_CANOPY) top += terrain.canopyAt(_p.x, _p.z);
    const d = top - _p.y;
    if (d >= 0 && (!_hit.found || d > _hit.depth)) {
      _hit.depth = d;
      _hit.found = true;
      _hit.trees = top > ground;
      _contact.copy(_p);
    }
  }
}

function testHull(sim: Sim): void {
  _hit.found = false;
  _hit.depth = 0;
  _hit.trees = false;
  testPoints(sim, HULL);
  testPoints(sim, sim.aircraft.gearPosition > 0.5 ? WHEELS : PODS);
}

/** Test the hull against the terrain and the trees; crash or bounce. Returns true on contact. */
export function checkGroundContact(sim: Sim): boolean {
  const ac = sim.aircraft;
  const terrain = sim.world.terrain;
  // Quick reject: well clear of the ground and trees under the aircraft and of any slope within
  // reach.
  if (ac.agl > REACH * 2 + 5 + MAX_CANOPY) {
    ac.fcs.inContact = false;
    return false;
  }
  testHull(sim);
  if (!_hit.found) {
    ac.fcs.inContact = false;
    return false;
  }

  if (!sim.options.realism.invulnerable) {
    ac.crashed = true;
    const surface = terrain.surfaceAt(_contact.x, _contact.z);
    sim.events.push({
      type: 'crash',
      t: sim.time,
      position: { x: _contact.x, y: _contact.y, z: _contact.z },
      reason: surface === 'water' && !_hit.trees ? 'water' : 'terrain',
    });
    ac.velocity.set(0, 0, 0);
    ac.angularVelocity.set(0, 0, 0);
    return true;
  }

  bounce(sim);
  const f = ac.fcs;
  if (!f.inContact && sim.time - f.contactMessageTime >= K.contactMessageInterval) {
    sim.events.push({ type: 'message', t: sim.time, text: 'GROUND CONTACT', level: 'warn' });
    f.contactMessageTime = sim.time;
  }
  f.inContact = true;
  return true;
}

/** Invulnerable bounce: back into flight away from the surface (see the file comment). */
function bounce(sim: Sim): void {
  const ac = sim.aircraft;
  const terrain = sim.world.terrain;
  // The surface hit: the ground's normal, or level for the canopy top.
  if (_hit.trees) _n.set(0, 1, 0);
  else terrain.normalAt(_contact.x, _contact.z, _n);

  // Leave along the surface in the direction of travel (or of the nose, after a head-on impact).
  const speed = ac.velocity.length();
  _t.copy(ac.velocity).addScaledVector(_n, -ac.velocity.dot(_n));
  if (_t.x * _t.x + _t.z * _t.z < 1) {
    _t.set(0, 0, -1).applyQuaternion(ac.orientation);
    _t.addScaledVector(_n, -_t.dot(_n));
    if (_t.x * _t.x + _t.z * _t.z < 1e-6) _t.set(Math.sin(ac.heading), 0, -Math.cos(ac.heading));
  }
  const heading = Math.atan2(_t.x, -_t.z);
  const dx = Math.sin(heading);
  const dz = -Math.cos(heading);
  // Rise of the surface along that heading, then climb away from it.
  const slope = Math.atan2(-(_n.x * dx + _n.z * dz), Math.max(0.2, _n.y));
  const gamma = Math.max(0, slope) + K.bounceClimbAngle;
  const newSpeed = Math.max(K.bounceMinSpeed, K.bounceSpeedKept * speed);
  ac.velocity.set(
    dx * Math.cos(gamma) * newSpeed,
    Math.sin(gamma) * newSpeed,
    dz * Math.cos(gamma) * newSpeed,
  );

  // Wings level, the nose on the path plus the angle of attack for 1 g at the new speed.
  const qbar = 0.5 * densityAt(ac.position.y, sim.world.isaDeviation) * newSpeed * newSpeed;
  const cl = (ac.mass * G0) / Math.max(1, qbar * A10.wingArea);
  const alpha = clamp((cl - A10_AERO.cl0) / A10_AERO.clAlpha, 0, K.bounceMaxAlpha);
  quaternionFromAttitude(heading, gamma + alpha, 0, ac.orientation);
  ac.angularVelocity.set(0, 0, 0);
  ac.fcs.flowAttachment = 1;
  ac.fcs.alphaRate = 0;
  // The surfaces and trim still hold the dive: the next control step trims for 1 g on this path
  // (controls.ts), so the aircraft flies away hands off.
  ac.fcs.bounceTrimPending = true;

  // Out of the ground and the trees: no hull point below the surface in the new attitude.
  for (let i = 0; i < 4; i++) {
    testHull(sim);
    if (!_hit.found) break;
    ac.position.y += _hit.depth + K.bounceClearance;
  }
}
