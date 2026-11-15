/**
 * Shared colours for 3D materials so the ship, its aircraft and effects read as one design.
 * (UI colours live in src/styles/global.css as CSS custom properties.)
 */
export const PALETTE = {
  /** Hull sides and superstructure — naval haze grey. */
  hull: '#7c8791',
  hullDark: '#59636d',
  /** Underside / below the waterline. */
  hullBottom: '#3b2f2f',
  /** Flight-deck non-skid surface. */
  deck: '#34393e',
  deckWorn: '#3e4449',
  /** Deck markings. */
  markingWhite: '#e8e8e2',
  markingYellow: '#e6b422',
  markingRed: '#c8372d',
  /** Superstructure windows. */
  glass: '#0e1a24',
  /** Turbine ducts and machinery. */
  machinery: '#4a525a',
  machineryDark: '#22272c',
  /** Turbine intake glow (matches the UI accent) and hot exhaust. */
  glowCool: '#39c6ff',
  glowHot: '#ffb469',
  /** Navigation / deck lights. */
  lightGreen: '#35ff8a',
  lightRed: '#ff3b3b',
  lightWhite: '#fff4d6',
  lightBlue: '#4aa8ff',
  /** Air-wing aircraft. */
  jet: '#8d98a3',
  jetDark: '#5d6670',
} as const;

/** Ship identity (original design — no borrowed names or insignia). */
export const SHIP = {
  name: 'ALBATROSS',
  hullNumber: '07',
  className: 'Albatross-class aerial carrier',
} as const;
