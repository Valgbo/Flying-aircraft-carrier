/**
 * Loading screen: shown while flow.beginFlight() generates the world, runs the registered
 * loaders (models, sounds) and starts the flight. It shows store.loading (progress 0..1 and
 * the step's label), the event being loaded and one tip. Sits above everything but the FPS
 * readout.
 */
import { useState } from 'react';
import { useA10Store } from '../state/store';
import A10Mark from './A10Mark';
import { humanizeId, loadoutPresets } from './loadout';
import { scenarioName } from './names';

const TIPS: readonly string[] = [
  'Nothing leaves the aircraft until Master Arm is at ARM. The checklist strip names the next step.',
  'Squeeze to the first detent before you fire: PAC holds the pipper steady.',
  'From the front, a T-72 shrugs off the gun. Dive steeply onto the roof and engine deck.',
  'Keep bursts to one or two seconds: the impacts arrive a second after you fire.',
  'A frontal pass beyond 400 m only scratches the paint. Attack from above or behind.',
  'Pull out early. The altitude alert and PULL UP are the only safety net.',
  'Rearm and refuel from the pause menu whenever the drum runs dry.',
];

export default function LoadingScreen() {
  const loading = useA10Store((s) => s.loading);
  const scenario = useA10Store((s) => s.scenario);
  const loadoutId = useA10Store((s) => s.loadoutId);
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  const pct = Math.round(Math.min(1, Math.max(0, loading.progress)) * 100);
  const loadout = loadoutPresets().find((p) => p.id === loadoutId)?.name ?? humanizeId(loadoutId);

  return (
    <div
      className="a10-loading"
      data-testid="a10-loading"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="a10-loading__box">
        <A10Mark size={92} className="a10-loading__mark" />
        <p className="a10-loading__title">A-10C Warthog</p>
        <p className="a10-loading__event fac-label">
          {scenarioName(scenario)} · {loadout}
        </p>
        <div
          className="a10-progress"
          role="progressbar"
          aria-label="Loading"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span className="a10-progress__fill" style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
        <p className="a10-loading__label">
          <span>{loading.label || 'Preparing'}</span>
          <span className="fac-readout">{pct}%</span>
        </p>
      </div>
      <p className="a10-loading__tip">{tip}</p>
    </div>
  );
}
