/**
 * SandboxStage — a ready-made <Canvas> for 3D sandboxes: runs the idle driver (so `sim` is
 * alive: hovering ship, turbines at hover throttle), adds neutral lighting and an orbit
 * camera aimed at the ship, and renders your children in WORLD space.
 *
 *   export default function MySandbox() {
 *     return (
 *       <SandboxStage camera={[260, 120, 320]}>
 *         <MyThing />
 *       </SandboxStage>
 *     );
 *   }
 *
 * Useful URL params: ?fixedTime=12 (deterministic frame), plus any of your own via
 * `debugFlags.params.get('x')`. Hangar demo sliders can be driven with
 * `useGameStore.getState().setHangar({ demoThrottle: 1, demoTiltDeg: 40 })` after
 * `setScreen('hangar')`, or pass `throttle` / `tiltDeg` props here.
 */
import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useEffect, type ReactNode } from 'react';
import { IDLE_ALTITUDE } from '../config/physicsConfig';
import IdleDriver from '../sim/IdleDriver';
import { useGameStore } from '../state/useGameStore';
import { useQuality } from '../state/useQuality';
import '../styles/global.css';

export interface SandboxStageProps {
  children?: ReactNode;
  /** Camera position relative to the ship's idle position. Default [260, 120, 320]. */
  camera?: [number, number, number];
  /** Orbit target relative to the ship's idle position. Default [0, 0, 0]. */
  target?: [number, number, number];
  fov?: number;
  /** Background colour; pass null to leave the scene background to your own component. */
  background?: string | null;
  /** Add a simple hemisphere + sun light. Default true. */
  lights?: boolean;
  /** Demo throttle 0..1 for all turbines (sets the hangar demo slider). */
  throttle?: number;
  /** Demo tilt in degrees for all turbines. */
  tiltDeg?: number;
  shadows?: boolean;
}

export default function SandboxStage({
  children,
  camera = [260, 120, 320],
  target = [0, 0, 0],
  fov = 50,
  background = '#8fb9dc',
  lights = true,
  throttle,
  tiltDeg,
  shadows = true,
}: SandboxStageProps) {
  const quality = useQuality();
  useEffect(() => {
    if (throttle === undefined && tiltDeg === undefined) return;
    const s = useGameStore.getState();
    s.setScreen('hangar');
    useGameStore.getState().setHangar({
      ...(throttle !== undefined ? { demoThrottle: throttle } : {}),
      ...(tiltDeg !== undefined ? { demoTiltDeg: tiltDeg } : {}),
    });
  }, [throttle, tiltDeg]);
  return (
    <div className="app">
      <Canvas
        shadows={shadows && quality.shadows}
        dpr={quality.dpr}
        gl={{ antialias: quality.antialias }}
        camera={{
          fov,
          near: 1,
          far: 60000,
          position: [camera[0], IDLE_ALTITUDE + camera[1], camera[2]],
        }}
      >
        <IdleDriver />
        {background && <color attach="background" args={[background]} />}
        {lights && (
          <>
            <hemisphereLight args={['#cfe6ff', '#2a3d4f', 0.9]} />
            <directionalLight
              position={[400, IDLE_ALTITUDE + 500, 300]}
              intensity={2.2}
              color="#fff2dd"
              castShadow={shadows && quality.shadows}
              shadow-mapSize={[quality.shadowMapSize, quality.shadowMapSize]}
              shadow-camera-left={-260}
              shadow-camera-right={260}
              shadow-camera-top={260}
              shadow-camera-bottom={-260}
              shadow-camera-near={10}
              shadow-camera-far={1600}
            />
          </>
        )}
        <OrbitControls
          makeDefault
          target={[target[0], IDLE_ALTITUDE + target[1], target[2]]}
          maxDistance={6000}
        />
        {children}
      </Canvas>
    </div>
  );
}
