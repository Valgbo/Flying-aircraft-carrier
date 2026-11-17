/**
 * The A-10 model assets: loading, templates, aircraft instances and stores.
 * OWNED BY THE AIRCRAFT (ASSETS) MODULE (urls.ts is the foundation's).
 */
export * from './meta';
export {
  createCockpitModel,
  createStoreInstance,
  getA10Meta,
  getAircraftTemplates,
  getStoreTemplate,
  loadAircraftModels,
  loadStoreModel,
  onAircraftTemplates,
  storeModelId,
  type AircraftTemplates,
} from './models';
export {
  GEAR_TRAVEL_TIME,
  INTERIOR_MIN_PIXELS_PER_METRE,
  applyAircraftVisualState,
  createAircraftInstance,
  createVisualState,
  disposeAircraftInstance,
  getAircraftLivery,
  setAircraftLivery,
  setAircraftShadows,
  updateAircraftDetail,
  updateAircraftInstance,
  type AircraftInstance,
  type AircraftInstanceOptions,
  type AircraftVisualState,
} from './aircraft';
