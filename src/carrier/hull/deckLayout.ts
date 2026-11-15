/**
 * Where things sit on the flight deck, as pure data derived from src/config/layout.ts:
 * the texture mapping of the deck surface, the arrestor wires and the deck / navigation
 * lights. Shared by the geometry builders, the texture painter and the unit tests.
 */
import { CATAPULTS, DECK, HULL, LANDING_STRIP, type Vec2Tuple } from '../../config/layout';
import type { V3 } from './geo';
import { STERN_Z, STRIP, deckEdgeX, pointOnDeck, pointOnElevator, stripPoint } from './hullShape';

/** Rectangle of deck coordinates covered by the deck texture (1 : 4, like the canvas). */
export const DECK_TEX = {
  minX: -40,
  maxX: 40,
  minZ: -HULL.length / 2,
  maxZ: HULL.length / 2,
} as const;

/**
 * Deck [x, z] → texture UV. The canvas is painted as the deck looks from above with the bow
 * at the top, so u grows to starboard and v toward the bow; text painted upright on the
 * canvas therefore reads correctly (not mirrored) from above.
 */
export function deckUv(x: number, z: number): [u: number, v: number] {
  return [
    (x - DECK_TEX.minX) / (DECK_TEX.maxX - DECK_TEX.minX),
    1 - (z - DECK_TEX.minZ) / (DECK_TEX.maxZ - DECK_TEX.minZ),
  ];
}

/**
 * A patch of the texture that lies off the deck and is painted in plain structure colour;
 * faces that share the deck material but are not deck surface (elevator sides) sample it.
 */
export const DECK_TEX_STRUCTURE_PATCH = { minX: -40, maxX: -32, minZ: -160, maxZ: -148 } as const;

/** Height of the arrestor cables' centre above the deck surface. */
export const WIRE_HEIGHT = 0.08;

/** The arrestor wires as end points (port end, starboard end), perpendicular to the strip. */
export function arrestorWires(): { port: V3; stbd: V3 }[] {
  const reach = STRIP.halfWidth + 1;
  const y = DECK.y + WIRE_HEIGHT;
  return LANDING_STRIP.wireDistances.map((d) => {
    const p = stripPoint(d, -reach);
    const s = stripPoint(d, reach);
    return { port: [p[0], y, p[1]] as const, stbd: [s[0], y, s[1]] as const };
  });
}

export type LightColor = 'white' | 'blue' | 'green' | 'red';

export interface DeckLight {
  position: V3;
  color: LightColor;
  /** Size multiplier of the light fitting. */
  scale: number;
  /** Brightness relative to an ordinary deck light. */
  gain: number;
}

const LIGHT_Y = DECK.y + 0.07;

function deckLight(p: Vec2Tuple, color: LightColor): DeckLight {
  return { position: [p[0], LIGHT_Y, p[1]], color, scale: 1, gain: 1 };
}

/** Evenly spaced points along the deck perimeter, pulled `inset` metres inboard. */
function perimeterPoints(count: number, inset: number): Vec2Tuple[] {
  const pts = DECK.outline;
  const lengths = pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  });
  const total = lengths.reduce((sum, l) => sum + l, 0);
  const out: Vec2Tuple[] = [];
  for (let k = 0; k < count; k++) {
    let s = ((k + 0.5) / count) * total;
    let i = 0;
    while (s > lengths[i]) s -= lengths[i++];
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = (b[0] - a[0]) / lengths[i];
    const dz = (b[1] - a[1]) / lengths[i];
    // the outline runs clockwise seen from above, so inboard is (-dz, dx)
    out.push([a[0] + dx * s - dz * inset, a[1] + dz * s + dx * inset]);
  }
  return out;
}

/**
 * Deck lighting plan for a budget of `count` fittings: blue deck-edge lights, white
 * landing-strip centreline and edge lights with a green threshold bar, and green catapult
 * track lights. Fittings that would fall off the deck or onto the elevator are left out, so
 * the result can be slightly shorter than `count`.
 */
export function deckLightLayout(count: number): DeckLight[] {
  const lights: DeckLight[] = [];
  const nThreshold = count >= 100 ? 8 : 4;
  const nEdge = Math.round(count * 0.4);
  const nCentre = Math.round(count * 0.17);
  const nCats = Math.max(4, Math.round(count * 0.16) & ~1);
  const nStripEdge = Math.max(2, (count - nThreshold - nEdge - nCentre - nCats) & ~1);

  for (const p of perimeterPoints(nEdge, 0.7)) {
    if (pointOnElevator(p[0], p[1], 0.6)) continue;
    lights.push(deckLight(p, 'blue'));
  }
  for (let k = 0; k < nCentre; k++) {
    const along = 6 + ((k + 0.5) / nCentre) * (STRIP.length - 10);
    lights.push(deckLight(stripPoint(along, 0), 'white'));
  }
  const perSide = nStripEdge / 2;
  for (const across of [-(STRIP.halfWidth - 0.7), STRIP.halfWidth - 0.7]) {
    for (let k = 0; k < perSide; k++) {
      const p = stripPoint(4 + ((k + 0.5) / perSide) * (STRIP.length - 8), across);
      if (pointOnDeck(p[0], p[1], 0.5)) lights.push(deckLight(p, 'white'));
    }
  }
  for (let k = 0; k < nThreshold; k++) {
    const across = (k / (nThreshold - 1) - 0.5) * 2 * (STRIP.halfWidth - 1.5);
    lights.push(deckLight(stripPoint(0.4, across), 'green'));
  }
  const perCat = nCats / CATAPULTS.length;
  for (const cat of CATAPULTS) {
    const offset = Math.sign(cat.start[0]) * 1.5;
    for (let k = 0; k < perCat; k++) {
      const t = (k + 0.5) / perCat;
      const z = cat.start[2] + (cat.end[2] - cat.start[2]) * t;
      lights.push(deckLight([cat.start[0] + offset, z], 'green'));
    }
  }
  return lights;
}

/** z of the port and starboard side lights (amidships, clear of the elevator and sponsons). */
const SIDE_LIGHT_Z = 12;

/** Navigation lights: red to port, green to starboard at the deck edge amidships, white at the stern. */
export function navigationLights(): DeckLight[] {
  const y = DECK.y + 0.45;
  const sternX = (deckEdgeX(1, STERN_Z) + deckEdgeX(-1, STERN_Z)) / 2;
  return [
    {
      position: [deckEdgeX(-1, SIDE_LIGHT_Z) - 0.25, y, SIDE_LIGHT_Z],
      color: 'red',
      scale: 2.4,
      gain: 1.6,
    },
    {
      position: [deckEdgeX(1, SIDE_LIGHT_Z) + 0.25, y, SIDE_LIGHT_Z],
      color: 'green',
      scale: 2.4,
      gain: 1.6,
    },
    // the stern light stands on the hull lip that projects aft of the deck
    {
      position: [sternX, DECK.y - DECK.thickness + 0.75, STERN_Z - 0.6],
      color: 'white',
      scale: 2.4,
      gain: 1.6,
    },
  ];
}

/**
 * Brightness multiplier of the deck and navigation lights for a given `sim.env.daylight`:
 * just above 1 by day (visible, barely blooming), several times brighter at night.
 */
export function deckLightBrightness(daylight: number): number {
  const t = Math.min(1, Math.max(0, (daylight - 0.1) / 0.6));
  const day = t * t * (3 - 2 * t);
  return 4.2 + (1.1 - 4.2) * day;
}
