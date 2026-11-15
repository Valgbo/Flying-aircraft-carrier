/**
 * URL parameters for testing, screenshots and debugging. All optional.
 *
 *   ?sandbox=<name>      dev only: render src/dev/sandboxes/<name>.tsx instead of the app
 *   ?screen=menu|hangar|flight|ops   start directly on a screen
 *   ?quality=low|medium|high         force a graphics preset and switch adaptive quality off
 *   ?time=<hours>        time of day, 0..24
 *   ?cam=orbit|chase|deck|bridge|turbine   initial camera
 *   ?assist=0            start with flight assist off
 *   ?fixedTime=<sec>     idle scenes (menu / hangar / sandboxes): pin sim.time to this value so
 *                        every frame is identical — for deterministic screenshots
 *   ?ui=0                hide the DOM overlay (clean 3D screenshots)
 *   ?mute=1              start muted
 *   ?touch=1             force the on-screen touch controls on
 */
function read(): URLSearchParams {
  try {
    return new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  } catch {
    return new URLSearchParams();
  }
}

function num(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const params = read();

export const debugFlags = {
  sandbox: params.get('sandbox'),
  screen: params.get('screen'),
  quality: params.get('quality'),
  time: num(params.get('time')),
  cam: params.get('cam'),
  assist: params.get('assist'),
  fixedTime: num(params.get('fixedTime')),
  ui: params.get('ui'),
  mute: params.get('mute'),
  touch: params.get('touch'),
  /** Raw access for module-specific sandbox parameters. */
  params,
} as const;
