/**
 * FlightOps — the air wing in the scene. Always mounted (keyed by `resetNonce`, so a restart
 * remounts it): with `active` false the jets sit on their parking spots and ride with the
 * ship (menu, hangar, free flight); with `active` true (flight-ops screen) the ops game
 * runs — catapult launches on the `launchJet` action, the landing pattern, recoveries and
 * scoring.
 *
 * This is the thin layer between the pure logic (FlightOpsSim) and the app: it steps the
 * logic with the fresh ship state at FRAME_PRIORITY.systems, exposes the jets as `sim.jets`,
 * turns the logic's callbacks into game events / toasts / camera shake, and publishes score
 * and status to the store at a low rate.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { FRAME_PRIORITY } from '../config/frame';
import { onAction } from '../state/actions';
import { emitEvent } from '../state/events';
import { addCameraShake, sim } from '../state/sim';
import type { OpsState } from '../state/types';
import { useGameStore } from '../state/useGameStore';
import Jet from './Jet';
import { FlightOpsSim, type OpsHooks } from './opsSim';

const HOOKS: OpsHooks = {
  catapult: (jetId, catapult) => emitEvent('jetCatapult', { jetId, catapult }),
  launch: (jetId, catapult) => emitEvent('jetLaunch', { jetId, catapult }),
  trap: (result) =>
    emitEvent('jetTrap', { jetId: result.jetId, points: result.points, grade: result.grade }),
  waveOff: (jetId) => emitEvent('jetWaveOff', { jetId }),
  toast: (text, level) => useGameStore.getState().pushMessage(text, level, 3500),
  shake: addCameraShake,
};

/** Shortest interval between two publications of the live deck steadiness, in sim seconds. */
const LIVE_INTERVAL = 0.2;

interface Published {
  revision: number;
  steadiness: number;
  time: number;
}

/** Make `sim.jets` the air wing's own jet objects (the sim reset empties the array). */
function attachJets(ops: FlightOpsSim): void {
  if (sim.jets.length === ops.jets.length && sim.jets[0] === ops.jets[0].out) return;
  sim.jets.length = 0;
  for (const jet of ops.jets) sim.jets.push(jet.out);
}

/**
 * Copy score and status to the store: at once when something discrete changed, and the live
 * steadiness at most five times per second.
 */
function publish(ops: FlightOpsSim, last: Published): void {
  const changed = ops.revision !== last.revision;
  const elapsed = sim.time - last.time;
  const liveDue =
    (elapsed >= LIVE_INTERVAL || elapsed < 0) && Math.abs(ops.steadiness - last.steadiness) > 0.004;
  if (!changed && !liveDue) return;
  const patch: Partial<OpsState> = { deckStability: Math.round(ops.steadiness * 1000) / 1000 };
  if (changed) {
    patch.score = ops.score;
    patch.launches = ops.launches;
    patch.recoveries = ops.recoveries;
    patch.waveOffs = ops.waveOffs;
    patch.status = ops.status;
    patch.lastRecovery = ops.lastRecovery;
    patch.jets = ops.jets.map((jet) => ({ id: jet.id, phase: jet.out.phase }));
  }
  last.revision = ops.revision;
  last.steadiness = ops.steadiness;
  last.time = sim.time;
  useGameStore.getState().setOps(patch);
}

export default function FlightOps({ active }: { active: boolean }) {
  const ops = useMemo(() => new FlightOpsSim(HOOKS), []);
  const published = useRef<Published>({ revision: -1, steadiness: -1, time: 0 });

  // (Re)start whenever the mode changes: leaving the ops screen mid-sortie parks everything.
  useEffect(() => {
    ops.reset(active);
    ops.step(0, sim.carrier);
    attachJets(ops);
    publish(ops, published.current);
    return () => {
      if (sim.jets[0] === ops.jets[0].out) sim.jets.length = 0;
    };
  }, [ops, active]);

  useEffect(
    () =>
      onAction('launchJet', () => {
        if (!useGameStore.getState().paused) ops.requestLaunch();
      }),
    [ops],
  );

  useFrame(() => {
    ops.step(sim.dt, sim.carrier);
    attachJets(ops);
    publish(ops, published.current);
  }, FRAME_PRIORITY.systems);

  return <Jet />;
}
