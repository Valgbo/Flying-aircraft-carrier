/**
 * What a display page is drawn from: the simulation, which display and page, whether it is the
 * sensor of interest, the sensor picture, the stores page's data and the message log. The page
 * settings the avionics keeps (TAD range and centre, selective jettison, laser-code cursors, MSG
 * clear time) are read from `sim.avionics.pages`.
 */
import type { Display } from '../../core/avionics';
import type { DsmsView, MfdPage } from '../../core/avionics/types';
import type { Sim, SimEvent } from '../../core/types';
import type { SensorPictureInfo } from '../sensors/pictures';

/** The two displays, as the avionics names them ('L' left, 'R' right). */
export type MfdDisplay = Display;

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
