/**
 * The A-10 model assets: loading, templates, aircraft instances and stores.
 * OWNED BY THE AIRCRAFT (ASSETS) MODULE (urls.ts is the foundation's).
 */
export * from './meta';
export {
  canardPivotsOf,
  createCockpitModel,
  createStoreInstance,
  getA10Meta,
  getAircraftTemplates,
  getStoreTemplate,
  loadAircraftModels,
  loadStoreModel,
  onAircraftTemplates,
  podTubesOf,
  prepareCanards,
  prepareRocketPod,
  setCanardsLive,
  storeModelId,
  type AircraftTemplates,
  type PodTubes,
} from './models';
export {
  GEAR_TRAVEL_TIME,
  INTERIOR_MIN_PIXELS_PER_METRE,
  applyAircraftVisualState,
  createAircraftInstance,
  createLoadedRack,
  createVisualState,
  disposeAircraftInstance,
  getAircraftLivery,
  podRocketMount,
  setAircraftLivery,
  setAircraftShadows,
  storeMount,
  updateAircraftDetail,
  updateAircraftInstance,
  type AircraftInstance,
  type AircraftInstanceOptions,
  type AircraftVisualState,
} from './aircraft';
