/**
 * SceneRoot — everything inside the <Canvas>. Composition only; each child owns its own logic
 * and reads the shared `sim` state. The driver is mounted first so `sim` is fresh for the frame.
 */
import { useFrame } from '@react-three/fiber';
import { Suspense, lazy, useEffect, useRef } from 'react';
import FlightOps from '../aircraft/FlightOps';
import Carrier from '../carrier/Carrier';
import IdleDriver from '../sim/IdleDriver';
import { isFlyingScreen, useGameStore } from '../state/useGameStore';
import AdaptiveQuality from './AdaptiveQuality';
import CameraRig from './CameraRig';
import Clouds from './Clouds';
import HangarHotspots from './HangarHotspots';
import Ocean from './Ocean';
import PostFX from './PostFX';
import World from './World';

const PhysicsDriver = lazy(() => import('../physics/PhysicsDriver'));

function PhysicsLoadingSignal() {
  useEffect(() => {
    useGameStore.getState().setPhysicsLoading(true);
    return () => useGameStore.getState().setPhysicsLoading(false);
  }, []);
  return null;
}

function SceneReadySignal() {
  const frames = useRef(0);
  useFrame(() => {
    if (frames.current < 0) return;
    if (++frames.current >= 2) {
      frames.current = -1;
      useGameStore.getState().setSceneReady(true);
    }
  });
  return null;
}

export default function SceneRoot() {
  const screen = useGameStore((s) => s.screen);
  const resetNonce = useGameStore((s) => s.resetNonce);
  const flying = isFlyingScreen(screen);
  return (
    <>
      {flying ? (
        <Suspense fallback={<PhysicsLoadingSignal />}>
          <PhysicsDriver key={resetNonce} />
        </Suspense>
      ) : (
        <IdleDriver />
      )}
      <World />
      <Clouds />
      <Ocean />
      <Carrier />
      <FlightOps key={resetNonce} active={screen === 'ops'} />
      <CameraRig />
      {screen === 'hangar' && <HangarHotspots />}
      <PostFX />
      <AdaptiveQuality />
      <SceneReadySignal />
    </>
  );
}
