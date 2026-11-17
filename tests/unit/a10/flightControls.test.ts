/**
 * Flight controls: Precision Attitude Control, the low-altitude autopilot, trim and auto-trim,
 * speed brakes, flaps and gear. The flight module is stepped alone (core/flight/testbed.ts);
 * where PAC needs a gun solution the test computes a simple one itself (no-drag round along the
 * gun line onto flat ground), so the tests do not depend on the avionics module.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { A10, A10_AERO, A10_FCS } from '../../../src/a10/data/aircraft';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { G0, SIM_DT } from '../../../src/a10/core/constants';
import { hudAnglesFromBodyDir, pitchRate, worldToBody } from '../../../src/a10/core/frames';
import {
  autopilotCommand,
  setFlapHandle,
  setGear,
  stepFlight,
  stepFlightControls,
  stepWarnings,
} from '../../../src/a10/core/flight';
import { createTestbed, runFlightOnly } from '../../../src/a10/core/flight/testbed';
import type { Sim } from '../../../src/a10/core/types';

/** Generous timeout for flights of a minute or more (the CI machine may be loaded). */
const LONG = 60_000;
const KT = 0.514444;
const DEG = Math.PI / 180;
const GUN_DEPRESSION = 2 * DEG;
const MUZZLE_SPEED = 1010;

const _m = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _a = { az: 0, el: 0 };

/** Fake fire control: a drag-free round along the gun line onto the flat ground. */
function fakeGunSolution(sim: Sim): void {
  const ac = sim.aircraft;
  const gun = sim.avionics.gun;
  const m = A10_GEOMETRY.muzzle;
  _m.set(m.x, m.y, m.z).applyQuaternion(ac.orientation).add(ac.position);
  _d.set(0, -Math.sin(GUN_DEPRESSION), -Math.cos(GUN_DEPRESSION)).applyQuaternion(ac.orientation);
  const vx = ac.velocity.x + MUZZLE_SPEED * _d.x;
  const vy = ac.velocity.y + MUZZLE_SPEED * _d.y;
  const vz = ac.velocity.z + MUZZLE_SPEED * _d.z;
  const h = _m.y - sim.world.terrain.heightAt(_m.x, _m.z);
  // h + vy t − g t²/2 = 0
  const t = (vy + Math.sqrt(vy * vy + 2 * G0 * h)) / G0;
  gun.valid = h > 0 && t > 0;
  gun.impact.set(_m.x + vx * t, _m.y + vy * t - 0.5 * G0 * t * t, _m.z + vz * t);
  eyePosition(sim, _e);
  worldToBody(ac.orientation, _d.subVectors(gun.impact, _e), _d);
  hudAnglesFromBodyDir(_d, _a);
  gun.pipperAz = _a.az;
  gun.pipperEl = _a.el;
  gun.slantRange = _d.length();
}

function eyePosition(sim: Sim, out: Vector3): Vector3 {
  const e = A10_GEOMETRY.eye;
  return out
    .set(e.x, e.y, e.z)
    .applyQuaternion(sim.aircraft.orientation)
    .add(sim.aircraft.position);
}

/** Flight step with the fake fire control in its place (after the flight step). */
function step(sim: Sim): void {
  stepFlightControls(sim, SIM_DT);
  stepFlight(sim, SIM_DT);
  fakeGunSolution(sim);
  stepWarnings(sim, SIM_DT);
  sim.time += SIM_DT;
  sim.stepCount++;
}

/** HUD angles of a world point from the eye. */
function hudOf(sim: Sim, p: Vector3) {
  eyePosition(sim, _e);
  worldToBody(sim.aircraft.orientation, _d.subVectors(p, _e), _d);
  return hudAnglesFromBodyDir(_d, { az: 0, el: 0 });
}

describe('Precision Attitude Control', () => {
  /**
   * A 30° strafing dive at 300 kn through turbulence; returns the RMS pipper rate (rad/s).
   * `pitchRateAtSqueeze` (rad/s) starts the nose moving as PAC engages (review GFC-3); the RMS is
   * then taken from `rmsFrom` seconds on.
   */
  function strafe(pac: boolean, seconds = 3, pitchRateAtSqueeze = 0, rmsFrom = 0) {
    const sim = createTestbed({
      altitude: 900,
      groundHeight: 0,
      tas: 300 * KT,
      gamma: -30 * DEG,
      throttle: 0.4,
      turbulence: 0.6,
      seed: 11,
    });
    sim.avionics.masterArm = 'ARM';
    sim.avionics.gunPac = 'ARM';
    sim.aircraft.angularVelocity.x = pitchRateAtSqueeze;
    fakeGunSolution(sim);
    const target = sim.avionics.gun.impact.clone();
    sim.input.trigger = pac ? 1 : 0;
    let prev = { az: 0, el: 0 };
    let sum = 0;
    let n = 0;
    let lastErr = 0;
    for (let i = 0; i < seconds / SIM_DT; i++) {
      step(sim);
      const t = hudOf(sim, target);
      const err = { az: t.az - sim.avionics.gun.pipperAz, el: t.el - sim.avionics.gun.pipperEl };
      if (i > 0 && sim.time > rmsFrom) {
        const rate = Math.hypot(err.az - prev.az, err.el - prev.el) / SIM_DT;
        sum += rate * rate;
        n++;
      }
      prev = err;
      lastErr = Math.hypot(err.az, err.el);
    }
    return { rms: Math.sqrt(sum / n), lastErr, sim };
  }

  it(
    'PAC-1 holds the pipper on its ground point: pipper motion drops by a large factor',
    () => {
      const off = strafe(false);
      const on = strafe(true);
      console.log(
        `[flight] PAC-1 RMS pipper rate: off ${(off.rms * 1000).toFixed(2)} mrad/s, on ${(on.rms * 1000).toFixed(2)} mrad/s (×${(off.rms / on.rms).toFixed(1)}); final error off ${(off.lastErr * 1000).toFixed(1)} mrad, on ${(on.lastErr * 1000).toFixed(1)} mrad`,
      );
      expect(on.sim.aircraft.pac.active).toBe(true);
      expect(on.sim.aircraft.pac.stage).toBe(1);
      expect(on.rms).toBeLessThan(off.rms / 3);
      expect(on.lastErr).toBeLessThan(3e-3);
    },
    LONG,
  );

  it(
    'PAC-1 engaged while the nose is still moving (1 and 3 °/s) settles on the point without a limit cycle',
    () => {
      for (const q of [1 * DEG, 3 * DEG]) {
        const off = strafe(false, 4, q, 2);
        const on = strafe(true, 4, q, 2);
        console.log(
          `[flight] PAC-1 engaged at q ${(q / DEG).toFixed(0)}°/s: RMS pipper rate in the last 2 s off ${(off.rms * 1000).toFixed(2)}, on ${(on.rms * 1000).toFixed(2)} mrad/s; final error on ${(on.lastErr * 1000).toFixed(2)} mrad`,
        );
        expect(on.rms).toBeLessThan(off.rms / 3);
        expect(on.lastErr).toBeLessThan(1e-3);
        expect(Math.abs(pitchRate(on.sim.aircraft.angularVelocity))).toBeLessThan(1 * DEG);
      }
    },
    LONG,
  );

  it(
    'PAC needs GUN/PAC ARM and Master Arm ARM; its authority is limited',
    () => {
      const sim = createTestbed({
        altitude: 900,
        groundHeight: 0,
        tas: 300 * KT,
        gamma: -30 * DEG,
        throttle: 0.4,
      });
      sim.avionics.masterArm = 'ARM';
      sim.avionics.gunPac = 'GUNARM';
      sim.input.trigger = 1;
      fakeGunSolution(sim);
      for (let i = 0; i < 60; i++) step(sim);
      expect(sim.aircraft.pac.active).toBe(false);
      sim.avionics.gunPac = 'ARM';
      sim.avionics.masterArm = 'SAFE';
      for (let i = 0; i < 60; i++) step(sim);
      expect(sim.aircraft.pac.active).toBe(false);
      sim.avionics.masterArm = 'ARM';
      // A point far off the pipper: PAC saturates at its authority, it does not aim.
      for (let i = 0; i < 2; i++) step(sim);
      sim.aircraft.pac.aimPoint.x += 400;
      let maxRudder = 0;
      for (let i = 0; i < 120; i++) {
        step(sim);
        maxRudder = Math.max(maxRudder, Math.abs(sim.aircraft.fcs.rudderCmd));
      }
      expect(sim.aircraft.pac.active).toBe(true);
      expect(Math.abs(sim.aircraft.pac.yawCmd)).toBeLessThanOrEqual(1);
      // PAC's share of the rudder plus the yaw SAS stays well short of full pedal.
      expect(maxRudder).toBeLessThan(A10_FCS.pacYawAuthority + A10_FCS.yawSasAuthority + 1e-9);
    },
    LONG,
  );

  it(
    'a one-stage trigger (relaxed preset) counts any press as PAC-2',
    () => {
      const sim = createTestbed({
        altitude: 900,
        groundHeight: 0,
        tas: 300 * KT,
        gamma: -30 * DEG,
        throttle: 0.4,
        realism: 'relaxed',
      });
      sim.avionics.masterArm = 'ARM';
      sim.avionics.gunPac = 'ARM';
      sim.input.trigger = 1;
      fakeGunSolution(sim);
      step(sim);
      expect(sim.aircraft.pac.stage).toBe(2);
    },
    LONG,
  );

  it(
    'PAC-2 feeds forward against the recoil pitching moment',
    () => {
      /**
       * PAC off (GUNARM), PAC-2 with the gun firing, and PAC-2 with the same recoil but the
       * feed-forward branch not taken (gun.firing false): PAC-1's pipper loop and damping alone.
       */
      const run = (pac: boolean, feedForward = true) => {
        const sim = createTestbed({
          altitude: 900,
          groundHeight: 0,
          tas: 300 * KT,
          gamma: -30 * DEG,
          throttle: 0.4,
        });
        sim.avionics.masterArm = 'ARM';
        sim.avionics.gunPac = pac ? 'ARM' : 'GUNARM';
        sim.input.trigger = 2;
        fakeGunSolution(sim);
        const pitch0 = sim.aircraft.pitch;
        let maxQ = 0;
        let firstCmd = 0;
        let firstQbar = 0;
        for (let i = 0; i < 1.5 / SIM_DT; i++) {
          // A firing gun: recoil force aft along the gun line and a nose-down moment.
          sim.gun.firing = feedForward;
          sim.aircraft.externalForceBody.set(
            0,
            44500 * Math.sin(GUN_DEPRESSION),
            44500 * Math.cos(GUN_DEPRESSION),
          );
          sim.aircraft.externalMomentBody.set(-20000, 0, 0);
          if (i === 0) firstQbar = sim.aircraft.dynamicPressure;
          step(sim);
          if (i === 0) firstCmd = sim.aircraft.pac.pitchCmd;
          maxQ = Math.max(maxQ, Math.abs(pitchRate(sim.aircraft.angularVelocity)));
        }
        return { maxQ, dPitch: Math.abs(sim.aircraft.pitch - pitch0), firstCmd, firstQbar };
      };
      const off = run(false);
      const on = run(true);
      const noFeedForward = run(true, false);
      console.log(
        `[flight] PAC-2 recoil: peak pitch rate off ${(off.maxQ / DEG).toFixed(2)} °/s, on ${(on.maxQ / DEG).toFixed(2)} °/s, without the feed-forward ${(noFeedForward.maxQ / DEG).toFixed(2)} °/s`,
      );
      expect(on.maxQ).toBeLessThan(off.maxQ / 2);
      // The feed-forward itself (review GFC-3): in the first step of the burst PAC-2 commands
      // exactly the elevator that cancels the recoil moment at the present elevator power…
      const pitchPower =
        on.firstQbar * A10.wingArea * A10.mac * A10_AERO.cmElevator * A10_AERO.elevatorMax;
      const expected = 20000 / pitchPower / A10_FCS.pacPitchAuthority;
      expect(on.firstCmd - noFeedForward.firstCmd).toBeCloseTo(expected, 6);
      // …and without it the recoil pitches the nose more than twice as fast.
      expect(on.maxQ).toBeLessThan(noFeedForward.maxQ / 2);
    },
    LONG,
  );
});

describe('low-altitude autopilot', () => {
  it(
    'ALT/HDG holds altitude and heading through turbulence',
    () => {
      const sim = createTestbed({
        altitude: 800,
        groundHeight: 0,
        ias: 250 * KT,
        heading: 1,
        turbulence: 0.4,
        seed: 3,
      });
      autopilotCommand(sim, 'mode'); // PATH → ALT/HDG
      expect(sim.aircraft.autopilot.mode).toBe('ALT_HDG');
      autopilotCommand(sim, 'toggle');
      expect(sim.aircraft.autopilot.engaged).toBe(true);
      let dh = 0;
      let dpsi = 0;
      runFlightOnly(sim, 60, (s) => {
        dh = Math.max(dh, Math.abs(s.aircraft.altitude - 800));
        dpsi = Math.max(dpsi, Math.abs(s.aircraft.heading - 1));
      });
      console.log(
        `[flight] ALT/HDG 60 s in turbulence: ±${dh.toFixed(1)} m, ±${(dpsi / DEG).toFixed(2)}°`,
      );
      expect(sim.aircraft.autopilot.engaged).toBe(true);
      expect(dh).toBeLessThan(15);
      expect(dpsi).toBeLessThan(1.5 * DEG);
    },
    LONG,
  );

  it(
    'PATH holds the flight-path angle; ALT holds the bank and altitude',
    () => {
      const sim = createTestbed({ altitude: 1500, ias: 250 * KT, gamma: 4 * DEG });
      autopilotCommand(sim, 'toggle');
      let dg = 0;
      runFlightOnly(sim, 30, (s) => {
        dg = Math.max(dg, Math.abs(s.aircraft.flightPathAngle - 4 * DEG));
      });
      expect(sim.aircraft.autopilot.mode).toBe('PATH');
      expect(dg).toBeLessThan(0.7 * DEG);

      const turn = createTestbed({ altitude: 1500, ias: 250 * KT });
      runFlightOnly(turn, 3, (s) => {
        s.input.roll = s.aircraft.bank < 30 * DEG ? 0.3 : 0;
        if (s.aircraft.bank >= 30 * DEG) s.input.pitch = 0.05;
      });
      turn.input.roll = 0;
      turn.input.pitch = 0;
      autopilotCommand(turn, 'mode');
      autopilotCommand(turn, 'mode');
      expect(turn.aircraft.autopilot.mode).toBe('ALT');
      autopilotCommand(turn, 'toggle');
      expect(turn.aircraft.autopilot.engaged).toBe(true);
      const bank0 = turn.aircraft.autopilot.refBank;
      const h0 = turn.aircraft.autopilot.refAltitude;
      let db = 0;
      let dh = 0;
      runFlightOnly(turn, 30, (s) => {
        if (s.time > 8) {
          db = Math.max(db, Math.abs(s.aircraft.bank - bank0));
          dh = Math.max(dh, Math.abs(s.aircraft.altitude - h0));
        }
      });
      console.log(
        `[flight] ALT mode at ${(bank0 / DEG).toFixed(0)}° bank: ±${(db / DEG).toFixed(1)}°, ±${dh.toFixed(1)} m`,
      );
      expect(bank0).toBeGreaterThan(20 * DEG);
      expect(db).toBeLessThan(3 * DEG);
      expect(dh).toBeLessThan(30);
    },
    LONG,
  );

  it(
    'PATH and ALT/HDG refuse to engage above 10° of bank; a firm stick input disengages',
    () => {
      const sim = createTestbed({ altitude: 1500, ias: 250 * KT });
      runFlightOnly(sim, 2, (s) => {
        s.input.roll = s.aircraft.bank < 20 * DEG ? 0.4 : 0;
      });
      sim.input.roll = 0;
      autopilotCommand(sim, 'toggle');
      expect(sim.aircraft.autopilot.engaged).toBe(false);
      expect(sim.events.some((e) => e.type === 'message' && /BANK/.test(e.text))).toBe(true);

      const level = createTestbed({ altitude: 1500, ias: 250 * KT });
      autopilotCommand(level, 'toggle');
      expect(level.aircraft.autopilot.engaged).toBe(true);
      level.input.pitch = 0.5;
      runFlightOnly(level, 0.1);
      expect(level.aircraft.autopilot.engaged).toBe(false);
      expect(level.events.some((e) => e.type === 'message' && /DISENGAGED/.test(e.text))).toBe(
        true,
      );
      autopilotCommand(level, 'toggle');
      autopilotCommand(level, 'disengage');
      expect(level.aircraft.autopilot.engaged).toBe(false);
    },
    LONG,
  );
});

describe('trim, speed brakes, flaps and gear', () => {
  it(
    'the trim hat moves the trim at its rate',
    () => {
      const sim = createTestbed({ altitude: 2000, ias: 250 * KT });
      const p0 = sim.aircraft.trim.pitch;
      runFlightOnly(sim, 1, (s) => {
        s.input.trimPitch = 1;
      });
      expect(sim.aircraft.trim.pitch - p0).toBeCloseTo(A10_FCS.pitchTrimRate, 2);
    },
    LONG,
  );

  it(
    'auto-trim (Standard preset) re-trims a mis-trimmed aircraft to hold its flight path',
    () => {
      const fly = (autoTrim: boolean) => {
        const sim = createTestbed({
          altitude: 2000,
          ias: 250 * KT,
          realism: autoTrim ? 'standard' : 'authentic',
        });
        sim.aircraft.trim.pitch += 0.25;
        runFlightOnly(sim, 25);
        const g25 = sim.aircraft.flightPathAngle;
        runFlightOnly(sim, 5);
        return { ac: sim.aircraft, drift: Math.abs(sim.aircraft.flightPathAngle - g25) };
      };
      const manual = fly(false);
      const auto = fly(true);
      console.log(
        `[flight] mis-trim +0.25: manual γ ${(manual.ac.flightPathAngle / DEG).toFixed(1)}° and still moving ${(manual.drift / DEG).toFixed(1)}° in 5 s; auto-trim holds γ ${(auto.ac.flightPathAngle / DEG).toFixed(2)}° (${(auto.drift / DEG).toFixed(2)}° in 5 s)`,
      );
      // Auto-trim stops the flight path rotating (n = cos γ) where manual trim keeps pitching.
      expect(auto.drift).toBeLessThan(0.3 * DEG);
      expect(Math.abs(auto.ac.gLoad - Math.cos(auto.ac.flightPathAngle))).toBeLessThan(0.03);
      expect(manual.drift).toBeGreaterThan(1 * DEG);
    },
    LONG,
  );

  it(
    'speed brakes: the switch extends them in ≈2.5 s, holds, and retracts them',
    () => {
      const sim = createTestbed({ altitude: 2000, ias: 250 * KT });
      let full = -1;
      runFlightOnly(sim, 3.5, (s) => {
        s.input.speedBrake = 1;
        if (full < 0 && s.aircraft.surfaces.speedBrake >= 1) full = s.time;
      });
      expect(full).toBeGreaterThan(2);
      expect(full).toBeLessThan(3);
      runFlightOnly(sim, 1, (s) => {
        s.input.speedBrake = 0;
      });
      expect(sim.aircraft.surfaces.speedBrake).toBe(1);
      runFlightOnly(sim, 1, (s) => {
        s.input.speedBrake = -1;
      });
      expect(sim.aircraft.surfaces.speedBrake).toBeLessThan(0.7);
    },
    LONG,
  );

  it(
    'flaps travel to 20° in ≈7 s and blow back to MVR above their limit speed',
    () => {
      const sim = createTestbed({ altitude: 1500, ias: 160 * KT });
      setFlapHandle(sim, 2);
      let at20 = -1;
      runFlightOnly(sim, 9, (s) => {
        if (at20 < 0 && s.aircraft.surfaces.flaps >= A10.flapAngles[2] - 1e-9) at20 = s.time;
      });
      expect(at20).toBeGreaterThan(6);
      expect(at20).toBeLessThan(8);
      const fast = createTestbed({ altitude: 1500, ias: 250 * KT });
      setFlapHandle(fast, 2);
      runFlightOnly(fast, 8);
      expect(fast.aircraft.flapHandle).toBe(2);
      expect(fast.aircraft.surfaces.flaps).toBeCloseTo(A10.flapAngles[1], 6);
    },
    LONG,
  );

  it(
    'gear takes ≈7 s and adds drag',
    () => {
      const sim = createTestbed({ altitude: 1500, ias: 180 * KT });
      const cd0 = sim.aircraft.dragCoefficient;
      setGear(sim, true);
      let down = -1;
      runFlightOnly(sim, 8, (s) => {
        if (down < 0 && s.aircraft.gearPosition >= 1) down = s.time;
      });
      expect(down).toBeGreaterThan(6.5);
      expect(down).toBeLessThan(7.5);
      expect(sim.aircraft.dragCoefficient).toBeGreaterThan(cd0 + 0.015);
      setGear(sim, false);
      runFlightOnly(sim, 8);
      expect(sim.aircraft.gearPosition).toBe(0);
    },
    LONG,
  );
});
