/**
 * Vehicle colours (sRGB hex; `Color` converts them to linear). A fictional live-fire range with
 * remotely driven targets in a plain grey-green scheme, no real markings or insignia
 * (PLAN_A10.md §9). Weathering, rust, dust and charring are added in the material.
 */
export const VEHICLE_PALETTE = {
  paint: '#424a35',
  paintDark: '#353b2b',
  rubber: '#1c1c1a',
  trackSteel: '#3b3732',
  bareSteel: '#2e2d2a',
  canvas: '#55573f',
  canvasDark: '#474934',
  glass: '#1d262c',
  wood: '#6a5134',
  woodDark: '#4e3b26',
  drum: '#45493a',
  drumBand: '#30332a',
  grille: '#22221f',
  lens: '#b9b8a6',
  panelWhite: '#e7e5dc',
  crate: '#4a5236',
  fuelTank: '#4b5340',
} as const;
