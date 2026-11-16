/**
 * URL flags for tests, screenshots and development (docs/a10/ARCHITECTURE.md §9). All optional.
 *
 *   ?screen=menu|flight|loadout|credits   start on a screen (flight starts immediately)
 *   ?scenario=freeHunt|strafePit|bombCircle|tacticalLane|empty
 *   ?quality=low|medium|high              force a preset for this visit (adaptive off)
 *   ?realism=authentic|standard|relaxed
 *   ?seed=<n>                             world seed for this visit
 *   ?time=<hours>                         time of day for this visit
 *   ?view=cockpit|chase|flyby|orbit       initial view
 *   ?start=<x>,<z>,<aglM>,<headingDeg>,<speedKias>[,<pathDeg>]   air start (path angle
 *                                         + climb / − dive, default level)
 *   ?arm=1                                start with Master Arm ARM and GUNS mode
 *   ?paused=1                             start paused
 *   ?mute=1  ?ui=0  ?fps=1
 *   ?sandbox=<name>                       dev only: render src/a10/dev/sandboxes/<name>.tsx
 */

export interface A10DebugFlags {
  screen?: string;
  scenario?: string;
  quality?: string;
  realism?: string;
  seed?: number;
  time?: number;
  view?: string;
  /** Air start: heading and path angle in degrees, speed in knots INDICATED. */
  start?: { x: number; z: number; agl: number; heading: number; speedKt: number; pathDeg: number };
  arm: boolean;
  paused: boolean;
  mute: boolean;
  ui: boolean;
  fps: boolean;
  sandbox?: string;
}

function parse(search: string): A10DebugFlags {
  const p = new URLSearchParams(search);
  const num = (k: string) => {
    const v = p.get(k);
    if (v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  let start: A10DebugFlags['start'];
  const s = p.get('start');
  if (s) {
    const [x, z, agl, heading, speedKt, pathDeg = 0] = s.split(',').map(Number);
    if ([x, z, agl, heading, speedKt, pathDeg].every(Number.isFinite))
      start = { x, z, agl, heading, speedKt, pathDeg };
  }
  return {
    screen: p.get('screen') ?? undefined,
    scenario: p.get('scenario') ?? undefined,
    quality: p.get('quality') ?? undefined,
    realism: p.get('realism') ?? undefined,
    seed: num('seed'),
    time: num('time'),
    view: p.get('view') ?? undefined,
    start,
    arm: p.get('arm') === '1',
    paused: p.get('paused') === '1',
    mute: p.get('mute') === '1',
    ui: p.get('ui') !== '0',
    fps: p.get('fps') === '1',
    sandbox: p.get('sandbox') ?? undefined,
  };
}

export const a10Flags: A10DebugFlags = parse(
  typeof location === 'undefined' ? '' : location.search,
);
