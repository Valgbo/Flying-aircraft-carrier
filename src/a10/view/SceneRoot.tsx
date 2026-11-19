/**
 * SceneRoot — everything inside the <Canvas>, in a fixed order. FOUNDATION-OWNED: modules own
 * the component files mounted here (docs/a10/ARCHITECTURE.md §6, ownership table) and never
 * edit this list. The cockpit and HUD draw their own scenes in their own render passes.
 */
import AircraftView from './aircraft/AircraftView';
import CameraRig from './cockpit/CameraRig';
import CockpitView from './cockpit/CockpitView';
import EffectsView from './effects/EffectsView';
import Environment from './environment/Environment';
import HudView from './hud/HudView';
import MfdView from './mfd/MfdView';
import RenderPipeline from './RenderPipeline';
import SensorsView from './sensors/SensorsView';
import SimDriver from './SimDriver';
import TerrainView from './terrain/TerrainView';
import VehiclesView from './vehicles/VehiclesView';

export default function SceneRoot() {
  return (
    <>
      <SimDriver />
      <Environment />
      <TerrainView />
      <VehiclesView />
      <EffectsView />
      <AircraftView />
      <CameraRig />
      <CockpitView />
      <HudView />
      <MfdView />
      <SensorsView />
      <RenderPipeline />
    </>
  );
}
