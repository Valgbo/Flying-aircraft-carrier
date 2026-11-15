/**
 * Info-card content for the hangar hotspots. The prose is ours; every number in it is read
 * from the ship layout and the physics config, so the cards stay true when the ship is
 * re-tuned. Pure data — covered by tests/unit/shell.test.ts.
 */
import {
  CATAPULTS,
  ELEVATOR,
  HOTSPOTS,
  ISLAND,
  LANDING_STRIP,
  TURBINE,
  TURBINE_LABELS,
  TURBINE_MOUNTS,
  TURBINE_NAMES,
  type HotspotId,
} from '../../config/layout';
import { PHYS } from '../../config/physicsConfig';
import { RAD2DEG } from '../../utils/math';
import { formatMeganewtons, formatMeters, formatSignedDeg } from './format';

/** What a hotspot marks — selects the icon of its pin. */
export type HotspotKind = 'turbine' | 'island' | 'catapult' | 'arrestor' | 'elevator';

export interface HotspotSpec {
  label: string;
  value: string;
}

export interface HotspotContent {
  id: HotspotId;
  kind: HotspotKind;
  /** Short category line shown above the title. */
  kicker: string;
  title: string;
  /** Two or three sentences. */
  description: string;
  specs: readonly HotspotSpec[];
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];

/** Small counts read better as words ("four arrestor wires"). */
function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

function ordinalWord(index: number): string {
  return ORDINAL_WORDS[index] ?? `no. ${index + 1}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function turbineContent(index: 0 | 1 | 2 | 3): HotspotContent {
  const [x, , z] = TURBINE_MOUNTS[index];
  const side = x < 0 ? 'port' : 'starboard';
  const otherSide = x < 0 ? 'starboard' : 'port';
  const end = z < 0 ? 'bow' : 'stern';
  const station = TURBINE_LABELS[index].toLowerCase();
  const fanDiameter = formatMeters(TURBINE.fanRadius * 2);
  const maxThrust = formatMeganewtons(PHYS.maxThrust);
  return {
    id: `turbine-${index}`,
    kind: 'turbine',
    kicker: `Propulsion · ${TURBINE_NAMES[index]}`,
    title: `${TURBINE_LABELS[index]} turbine`,
    description:
      `A ${fanDiameter} ducted fan on the ${station} outrigger, good for ${maxThrust} at full power. ` +
      `In a hover it carries a quarter of the ship and trims the deck: more power here lifts the ${end} and the ${side} side. ` +
      `Tilting toward the bow turns lift into forward push; for a turn to ${otherSide} it leans forward while the ${otherSide} pair leans back.`,
    specs: [
      { label: 'Fan diameter', value: fanDiameter },
      { label: 'Max thrust', value: maxThrust },
      {
        label: 'Tilt range',
        value: `${formatSignedDeg(TURBINE.tiltMinDeg)} to ${formatSignedDeg(TURBINE.tiltMaxDeg)}`,
      },
      {
        label: 'Mount',
        value: `${formatMeters(Math.abs(x))} to ${side}, ${formatMeters(Math.abs(z))} ${z < 0 ? 'forward' : 'aft'}`,
      },
    ],
  };
}

function islandContent(): HotspotContent {
  const side = ISLAND.centerX < 0 ? 'port' : 'starboard';
  return {
    id: 'island',
    kind: 'island',
    kicker: 'Command',
    title: 'Command island',
    description:
      `The superstructure stands off to ${side} so the landing strip and both catapults stay clear. ` +
      'It houses the navigation bridge and flight control, with the sensor mast on top. ' +
      'The bridge camera looks out from here.',
    specs: [
      { label: 'Height above deck', value: formatMeters(ISLAND.height) },
      { label: 'Mast top', value: `${formatMeters(ISLAND.mastHeight)} above deck` },
      {
        label: 'Footprint',
        value: `${ISLAND.length} × ${formatMeters(ISLAND.width)}`,
      },
      {
        label: 'Offset',
        value: `${formatMeters(Math.abs(ISLAND.centerX))} to ${side} of the centreline`,
      },
    ],
  };
}

function catapultContent(): HotspotContent {
  const first = CATAPULTS[0];
  const stroke = Math.hypot(
    first.end[0] - first.start[0],
    first.end[1] - first.start[1],
    first.end[2] - first.start[2],
  );
  const spacing = Math.abs(CATAPULTS[CATAPULTS.length - 1].start[0] - first.start[0]);
  return {
    id: 'catapults',
    kind: 'catapult',
    kicker: 'Flight deck',
    title: 'Bow catapults',
    description:
      `${capitalise(numberWord(CATAPULTS.length))} catapult tracks run side by side to the bow. ` +
      `Each one drives a jet down a ${formatMeters(stroke)} stroke and off the deck edge. ` +
      'In Flight ops, every launch starts here.',
    specs: [
      { label: 'Tracks', value: String(CATAPULTS.length) },
      { label: 'Stroke', value: formatMeters(stroke) },
      { label: 'Track spacing', value: formatMeters(spacing) },
    ],
  };
}

function arrestorContent(): HotspotContent {
  const dx = LANDING_STRIP.end[0] - LANDING_STRIP.threshold[0];
  const dz = LANDING_STRIP.end[2] - LANDING_STRIP.threshold[2];
  const length = Math.hypot(dx, dz);
  const angle = `${(Math.atan2(Math.abs(dx), Math.abs(dz)) * RAD2DEG).toFixed(1)}°`;
  const side = dx < 0 ? 'port' : 'starboard';
  const wires = LANDING_STRIP.wireDistances;
  const wireSpacing = wires.length > 1 ? wires[1] - wires[0] : 0;
  return {
    id: 'arrestor',
    kind: 'arrestor',
    kicker: 'Flight deck',
    title: 'Angled landing strip',
    description:
      `Returning jets land on a strip angled ${angle} to ${side}, so one that misses the wires flies clear of the catapults and climbs away. ` +
      `${capitalise(numberWord(wires.length))} arrestor wires cross the strip and pilots aim for the ${ordinalWord(LANDING_STRIP.targetWire)}. ` +
      'The steadier the deck, the better a recovery scores.',
    specs: [
      {
        label: 'Strip',
        value: `${Math.round(length)} × ${formatMeters(LANDING_STRIP.width)}`,
      },
      { label: 'Angle', value: `${angle} to ${side}` },
      {
        label: 'Arrestor wires',
        value: `${wires.length}, ${formatMeters(wireSpacing)} apart`,
      },
      { label: 'Target wire', value: `No. ${LANDING_STRIP.targetWire + 1}` },
    ],
  };
}

function elevatorContent(): HotspotContent {
  const width = ELEVATOR.maxX - ELEVATOR.minX;
  const length = ELEVATOR.maxZ - ELEVATOR.minZ;
  const travel = ELEVATOR.topY - ELEVATOR.bottomY;
  const side = (ELEVATOR.minX + ELEVATOR.maxX) / 2 < 0 ? 'port' : 'starboard';
  return {
    id: 'elevator',
    kind: 'elevator',
    kicker: 'Flight deck',
    title: 'Aircraft elevator',
    description:
      'A deck-edge platform forward of the island that carries aircraft between the hangar deck and the flight deck. ' +
      'Raised, it sits flush and becomes part of the deck. ' +
      `It travels ${formatMeters(travel)} between the two levels.`,
    specs: [
      { label: 'Platform', value: `${width} × ${formatMeters(length)}` },
      { label: 'Travel', value: formatMeters(travel) },
      { label: 'Location', value: `${capitalise(side)} deck edge` },
    ],
  };
}

export const HOTSPOT_CONTENT: Readonly<Record<HotspotId, HotspotContent>> = {
  'turbine-0': turbineContent(0),
  'turbine-1': turbineContent(1),
  'turbine-2': turbineContent(2),
  'turbine-3': turbineContent(3),
  island: islandContent(),
  catapults: catapultContent(),
  arrestor: arrestorContent(),
  elevator: elevatorContent(),
};

export function getHotspotContent(id: HotspotId): HotspotContent {
  return HOTSPOT_CONTENT[id];
}

/** Index of a hotspot in HOTSPOTS (the order the projector and the pins share), or -1. */
export function hotspotIndex(id: HotspotId | null): number {
  return id === null ? -1 : HOTSPOTS.findIndex((h) => h.id === id);
}
