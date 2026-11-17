/**
 * What a display page is drawn from: the simulation, which display and page, whether it is the
 * sensor of interest, the sensor picture, the stores page's data and the message log. Plus
 * defensive readers of the page settings the avionics module adds in wave 2 (TAD range and
 * centre, laser latch and code, selective jettison…): a field it has not added (yet) reads as
 * its default, so the displays work with the avionics as it is at any time.
 */
import type { DsmsView, MfdPage } from '../../core/avionics/types';
import type { Sim, SimEvent } from '../../core/types';
import type { SensorPictureInfo } from '../sensors/pictures';
import { TAD } from './mfdLayout';

/** The two displays, as the avionics names them ('L' left, 'R' right). */
export type MfdDisplay = 'L' | 'R';

export interface PageContext {
  sim: Sim;
  display: MfdDisplay;
  page: MfdPage;
  /** This display is the sensor of interest. */
  soi: boolean;
  /** Sim time, s (flashing elements; pause freezes them). */
  time: number;
  /** The page's sensor picture (TGP, MAV), or null when there is none. */
  picture: SensorPictureInfo | null;
  /** The stores page's data (avionics' buildDsmsView), refreshed when the DSMS is drawn. */
  dsms: DsmsView;
  messages: MessageLog;
}

/** The page settings the avionics module keeps (wave 2; `AvionicsState.pages`). */
export interface PageSettings {
  tadRange: number;
  tadCenter: 'OWN' | 'SPI';
  jettisonStation: number;
  dsmsCodeDigit: number;
  tgpCodeDigit: number;
  msgClearTime: number;
}

const DEFAULT_PAGES: PageSettings = {
  tadRange: TAD.defaultRange,
  tadCenter: 'OWN',
  jettisonStation: 0,
  dsmsCodeDigit: -1,
  tgpCodeDigit: -1,
  msgClearTime: -1,
};

type Partially<T> = { [K in keyof T]?: T[K] };

/** The avionics' page settings, field by field, with defaults for what it does not keep. */
export function pageSettings(sim: Sim, out: PageSettings): PageSettings {
  const p = (sim.avionics as unknown as { pages?: Partially<PageSettings> }).pages;
  out.tadRange = p?.tadRange ?? DEFAULT_PAGES.tadRange;
  out.tadCenter = p?.tadCenter ?? DEFAULT_PAGES.tadCenter;
  out.jettisonStation = p?.jettisonStation ?? DEFAULT_PAGES.jettisonStation;
  out.dsmsCodeDigit = p?.dsmsCodeDigit ?? DEFAULT_PAGES.dsmsCodeDigit;
  out.tgpCodeDigit = p?.tgpCodeDigit ?? DEFAULT_PAGES.tgpCodeDigit;
  out.msgClearTime = p?.msgClearTime ?? DEFAULT_PAGES.msgClearTime;
  return out;
}

export function createPageSettings(): PageSettings {
  return { ...DEFAULT_PAGES };
}

/** Avionics switches added in wave 2 (laser latch and code, Maverick power, next station). */
export interface AvionicsExtras {
  laserLatch?: boolean;
  laserCode?: number;
  mavPower?: boolean;
  selectedStation?: number;
}

export function avionicsExtras(sim: Sim): AvionicsExtras {
  return sim.avionics as unknown as AvionicsExtras;
}

/** Wave-2 fields of the DSMS rows (avionics' buildDsmsView). */
export interface DsmsStationExtras {
  rockets?: number;
  next?: boolean;
  jettisonable?: boolean;
  jettisonSelected?: boolean;
}
export interface DsmsProfileExtras {
  drag?: 'LD' | 'HD';
  laserCode?: number;
}

/** Maverick seeker fields the sensors module adds (variant and band). */
export interface SeekerExtras {
  type?: string;
  band?: string;
}

// ---------------------------------------------------------------------------------------------
// Messages (MSG page)
// ---------------------------------------------------------------------------------------------

export interface LoggedMessage {
  t: number;
  text: string;
  level: 'info' | 'warn' | 'alert';
}

/**
 * The cockpit messages of the flight (`message` events), newest last, in a fixed ring: the MSG
 * page shows them. Adding keeps the event's own string (no copy).
 */
export class MessageLog {
  readonly capacity: number;
  private readonly items: LoggedMessage[];
  private start = 0;
  /** Messages held (≤ capacity). */
  size = 0;
  /** Bumped on every change (the MSG page's redraw signature). */
  version = 0;

  constructor(capacity = 32) {
    this.capacity = capacity;
    this.items = Array.from({ length: capacity }, () => ({ t: 0, text: '', level: 'info' }));
  }

  add(t: number, text: string, level: LoggedMessage['level']): void {
    const i = (this.start + this.size) % this.capacity;
    const m = this.items[i];
    m.t = t;
    m.text = text;
    m.level = level;
    if (this.size < this.capacity) this.size++;
    else this.start = (this.start + 1) % this.capacity;
    this.version++;
  }

  /** Take the messages of a frame's events. */
  addEvents(events: readonly SimEvent[]): void {
    for (let k = 0; k < events.length; k++) {
      const e = events[k];
      if (e.type === 'message') this.add(e.t, e.text, e.level);
    }
  }

  /** The k-th newest message (0 = newest), or null. */
  newest(k: number): LoggedMessage | null {
    if (k < 0 || k >= this.size) return null;
    return this.items[(this.start + this.size - 1 - k) % this.capacity];
  }

  clear(): void {
    this.start = 0;
    this.size = 0;
    this.version++;
  }
}
