/**
 * Fills an `AudioFrame` from the live simulation: where every source is relative to the
 * listener (the active camera), how hard the turbines run, how fast the air moves past the
 * ship. Also keeps the jet -> voice assignment stable from frame to frame so a voice follows
 * one aircraft (needed for its Doppler shift). Allocation-free.
 */
import { Quaternion, Vector3 } from 'three';
import { TURBINE_MOUNTS } from '../config/layout';
import { sim } from '../state/sim';
import {
  carrierLocalToWorld,
  getDownwash,
  turbineRpmFraction,
  type Downwash,
} from '../state/simHelpers';
import { clamp } from '../utils/math';
import { MAX_JET_VOICES, distanceGain, offsetToPan, type AudioFrame } from './engineAudio';

/** Radial speeds beyond this are camera cuts, not motion, m/s. */
const MAX_RADIAL_SPEED = 250;
/** Smoothing rate of the radial velocity estimate, 1/s. */
const RADIAL_SMOOTHING = 8;

export class SimFrameReader {
  /** Result of the last `locate` / `locateJet` / `locateTurbine`: stereo position and distance gain. */
  pan = 0;
  gain = 1;

  private readonly listenerInverse = new Quaternion();
  private readonly offset = new Vector3();
  private readonly downwash: Downwash = { x: 0, z: 0, distance: 0, strength: 0 };
  /** Jet id each voice follows, -1 = free. */
  private readonly voiceJet = new Int32Array(MAX_JET_VOICES).fill(-1);
  private readonly voiceSeen = new Uint8Array(MAX_JET_VOICES);
  /** Distance of each voice's jet in the previous frame, -1 = unknown. */
  private readonly voiceDistance = new Float32Array(MAX_JET_VOICES).fill(-1);

  /** `windScale` (0..1) subdues the airflow in the idle scenes. */
  read(frame: AudioFrame, windScale: number): void {
    const camera = sim.camera;
    const carrier = sim.carrier;
    this.listenerInverse.copy(camera.quaternion).invert();

    for (let i = 0; i < 4; i++) {
      const turbine = sim.turbines[i];
      const out = frame.turbines[i];
      this.toListener(carrierLocalToWorld(TURBINE_MOUNTS[i], this.offset));
      out.x = this.offset.x;
      out.y = this.offset.y;
      out.z = this.offset.z;
      out.rpm = turbineRpmFraction(turbine);
      out.throttle = turbine.throttle;
    }

    const wind = sim.env.wind;
    frame.airspeed = Math.hypot(
      carrier.velocity.x - wind.x,
      carrier.velocity.y - wind.y,
      carrier.velocity.z - wind.z,
    );
    frame.gLoad = carrier.gLoad;
    frame.windScale = windScale;
    frame.cameraHeight = camera.position.y;
    frame.shipDistance = camera.position.distanceTo(carrier.position);
    let strongest = 0;
    for (let i = 0; i < 4; i++) {
      strongest = Math.max(strongest, getDownwash(i, this.downwash).strength);
    }
    frame.downwash = strongest;

    this.readJets(frame);
  }

  /** Stereo position and distance gain of a world point, into `pan` / `gain`. */
  locate(world: Vector3): void {
    this.listenerInverse.copy(sim.camera.quaternion).invert();
    this.toListener(this.offset.copy(world));
    this.pan = offsetToPan(this.offset.x, this.offset.y, this.offset.z);
    this.gain = distanceGain(this.offset.length());
  }

  /** As `locate`, for the jet with this id (the ship's position if it is not in `sim.jets`). */
  locateJet(jetId: number): void {
    for (let i = 0; i < sim.jets.length; i++) {
      if (sim.jets[i].id === jetId) {
        this.locate(sim.jets[i].position);
        return;
      }
    }
    this.locate(sim.carrier.position);
  }

  /** As `locate`, for turbine `index`. */
  locateTurbine(index: number): void {
    const mount = TURBINE_MOUNTS[index];
    if (!mount) {
      this.locate(sim.carrier.position);
      return;
    }
    this.listenerInverse.copy(sim.camera.quaternion).invert();
    this.toListener(carrierLocalToWorld(mount, this.offset));
    this.pan = offsetToPan(this.offset.x, this.offset.y, this.offset.z);
    this.gain = distanceGain(this.offset.length());
  }

  /** World position in `offset` -> offset from the listener in camera space. */
  private toListener(world: Vector3): void {
    world.sub(sim.camera.position).applyQuaternion(this.listenerInverse);
  }

  private readJets(frame: AudioFrame): void {
    const { voiceJet, voiceSeen, voiceDistance } = this;
    voiceSeen.fill(0);
    const jets = sim.jets;
    for (let j = 0; j < jets.length; j++) {
      const jet = jets[j];
      if (jet.phase === 'parked') continue;
      // keep the voice this jet already has, otherwise take a free one
      let voice = -1;
      for (let v = 0; v < MAX_JET_VOICES; v++) {
        if (voiceJet[v] === jet.id) {
          voice = v;
          break;
        }
      }
      if (voice < 0) {
        for (let v = 0; v < MAX_JET_VOICES; v++) {
          if (voiceJet[v] < 0 && !voiceSeen[v]) {
            voice = v;
            voiceJet[v] = jet.id;
            voiceDistance[v] = -1;
            break;
          }
        }
      }
      if (voice < 0) continue; // more jets in the air than voices
      voiceSeen[voice] = 1;

      const out = frame.jets[voice];
      this.toListener(this.offset.copy(jet.position));
      out.x = this.offset.x;
      out.y = this.offset.y;
      out.z = this.offset.z;
      out.active = true;
      out.power = jet.power;
      const distance = this.offset.length();
      if (voiceDistance[voice] < 0) {
        out.radialVelocity = 0;
      } else if (sim.dt > 1e-4) {
        const raw = (distance - voiceDistance[voice]) / sim.dt;
        const blend = Math.min(1, sim.dt * RADIAL_SMOOTHING);
        // a jump faster than any aircraft is the camera changing view: ignore it
        if (Math.abs(raw) <= MAX_RADIAL_SPEED) {
          out.radialVelocity += (raw - out.radialVelocity) * blend;
        }
        out.radialVelocity = clamp(out.radialVelocity, -MAX_RADIAL_SPEED, MAX_RADIAL_SPEED);
      }
      if (sim.dt > 1e-4 || voiceDistance[voice] < 0) voiceDistance[voice] = distance;
    }
    for (let v = 0; v < MAX_JET_VOICES; v++) {
      if (voiceSeen[v]) continue;
      voiceJet[v] = -1;
      voiceDistance[v] = -1;
      frame.jets[v].active = false;
      frame.jets[v].radialVelocity = 0;
    }
  }
}
