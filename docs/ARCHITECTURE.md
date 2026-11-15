# Architecture & Contracts

This is the working contract for everyone (human or agent) building the Flying Aircraft
Carrier web app. `PLAN.md` says **what** we are building; this file says **how the pieces
fit together**. If code and this file disagree, fix one of them — do not leave it.

The app: an interactive 3D scene of an original flying aircraft carrier ("ALBATROSS", hull
number 07) lifted by four tilting ducted-fan jet turbines. Screens: main menu, hangar
(inspect), free flight, flight ops.

---

## 1. Stack (pinned — do not add, remove or upgrade dependencies)

| Package | Version | Notes |
|---|---|---|
| react / react-dom | 18.3.1 | function components + hooks |
| three | 0.172.0 | `import { … } from 'three'` |
| @react-three/fiber | 8.18.0 | R3F v8 API |
| @react-three/drei | 9.122.0 | helpers |
| @react-three/rapier | 1.5.0 | Rapier 0.14 WASM (flying screens only, lazy chunk) |
| @react-three/postprocessing | 2.19.1 | with `postprocessing` 6.36.7 |
| zustand | 5.0.3 | store |
| leva | 0.10.1 | dev-only tuning panels |
| vite 8 · typescript 5.9 · vitest 5 · @playwright/test 1.63 · eslint 10 · prettier 3 | | tooling |

No binary assets: geometry, textures (canvas / data textures) and audio (Web Audio synthesis)
are all generated in code. No network requests at runtime.

Commands: `npm run dev` · `npm run build` (typecheck + bundle) · `npm run typecheck` ·
`npm run lint` · `npm test` (Vitest) · `npm run e2e` (Playwright) · `npm run format`.

---

## 2. Conventions

### Frames and units

- World: **Y up**, metres, seconds. Mean sea level is `y = 0`. North is world `-Z`, east is `+X`.
- **Carrier-local frame** (rigid-body frame, origin = centre of mass):
  `+X` starboard (right), `-X` port (left), `+Y` up, **`-Z` forward (bow)**, `+Z` aft.
- All ship geometry comes from `src/config/layout.ts`. Never hard-code a ship coordinate that
  the layout already defines.
- Physics units: mass in **tonnes**, force in **kN** (so `a = F / m` is m/s²). See
  `src/config/physicsConfig.ts`.
- Angles are **radians** in code and in `sim`; degrees only in names ending `Deg` and in UI.

### Sign conventions (covered by `tests/unit/foundation.test.ts`)

- `headingDeg`: compass heading of the bow, 0..360, 0 = north (`-Z`), 90 = east (`+X`).
  A positive rotation about world `+Y` turns the bow to **port**.
- `pitch` > 0 = bow up. `roll` > 0 = starboard side down.
- Turbine `tilt`: 0 = thrust straight up. **Positive tilt leans the thrust vector toward the
  bow**, pushing the ship forward. Local thrust axis = `(0, cos tilt, -sin tilt)`; the exhaust
  leaves in the opposite direction. Visually the duct rotates by `-tilt` about its local X axis.
- Turbine index order everywhere: `0 = FL` (forward port), `1 = FR` (forward starboard),
  `2 = RL` (aft port), `3 = RR` (aft starboard).
- Input axes (`src/controls/input.ts`): `collective` +1 = up, `tilt` +1 = toward the bow,
  `yaw` +1 = turn to starboard, `strafe` +1 = to starboard.

### Time

- `sim.time` = simulated seconds since the scene was (re)started; `sim.dt` = simulated seconds
  advanced this frame (0 while paused or frozen). **Animate with these, never with wall-clock
  time or the raw frame delta** — that is what makes pause and deterministic screenshots work.
  (UI-only effects such as CSS transitions are exempt.)

### Frame order (`src/config/frame.ts`)

R3F runs `useFrame` callbacks in ascending priority. Negative priorities run before the
default and do not disable auto-rendering.

| Priority | Who |
|---|---|
| `FRAME_PRIORITY.physics` (-100) | Rapier world step (`<Physics updatePriority>`) |
| `FRAME_PRIORITY.driver` (-90) | active driver → writes `sim`, calls `updateDerived`, `publishTelemetry` |
| `FRAME_PRIORITY.systems` (-50) | gameplay systems that need the fresh ship state (flight ops) |
| `FRAME_PRIORITY.camera` (-20) | camera rig |
| 0 (default) | all visuals: read `sim`, update meshes / uniforms |
| 1 | post-processing composer renders the frame |

### Per-frame code

- No allocations inside `useFrame` (reuse module-level `Vector3`/`Quaternion`/`Matrix4` scratch
  objects). No `setState` / store writes per frame except the throttled telemetry publisher.
- Dispose what you create imperatively (geometries, materials, textures, render targets).
- Anything repeated more than ~10 times is instanced (`InstancedMesh`) or merged.

---

## 3. State

### `sim` — live simulation state (`src/state/sim.ts`, types in `src/state/types.ts`)

A plain mutable singleton. Visuals read it inside `useFrame`; nothing re-renders.

| Field | Written by | Read by |
|---|---|---|
| `sim.time`, `sim.dt` | active driver | everyone |
| `sim.carrier` (pose, velocities, derived) | active driver (+ `updateDerived`) | everyone |
| `sim.turbines[i]` (`throttle`, `tilt`, `thrust`, commands) | active driver | turbine visuals, HUD, audio, effects |
| `sim.turbines[i].enabled` | turbine panel (engine switches) | driver honours it |
| `sim.controls` (`targetAltitude`, `tiltLever`, `manualThrottle`, `manualTilt`) | driver; turbine panel edits the manual arrays | driver, HUD |
| `sim.env` (`sunDirection`, `daylight`, `sunColor`, `horizonColor`, `zenithColor`, `cloudCover`) | world / clouds | ocean, ship lights, effects |
| `sim.env.wind` | driver / flight ops | physics, particles |
| `sim.jets[]` (world-space pose per aircraft) | flight ops | jet visuals, audio, cameras |
| `sim.camera.position`, `sim.camera.quaternion` | camera rig | audio, clouds, ocean |
| `sim.camera.shake` | anyone via `addCameraShake(amount)` | camera rig (consumes + decays) |

Drivers (exactly one is mounted at a time, first child of `SceneRoot`):

- `src/sim/IdleDriver.tsx` — menu, hangar, sandboxes. Kinematic hover at `IDLE_ALTITUDE`
  with a gentle bob; turbines follow the hangar demo sliders.
- `src/physics/PhysicsDriver.tsx` — free flight and flight ops. Rapier rigid body driven by the
  pure force model in `src/carrier/carrierPhysics.ts`. Lazy-loaded.

Initial conditions come from `resetSimForScreen(screen)`, which the **store** calls when the
screen changes or the flight restarts (it also bumps `resetNonce`, which `SceneRoot` uses as
the driver's React `key`). Components never call it; a driver treats the `sim` it finds on
mount as its initial state.

Helpers (`src/state/simHelpers.ts`, allocation-free): `carrierLocalToWorld`,
`carrierDirToWorld`, `worldToCarrierLocal`, `thrustAxisLocal(tilt)`,
`getTurbineExhaust(index, outPos, outDir)` (world nozzle exit + exhaust direction),
`getDownwash(index, out)` (where/how hard a turbine blasts the sea), `turbineRpmFraction(t)`.

### Store — `useGameStore` (`src/state/useGameStore.ts`, Zustand)

Everything React needs: `screen`, `paused`, `settingsOpen`, `turbinePanelOpen`, `helpOpen`,
`cameraMode`, `cameraTurbine`, `assistEnabled`, `effectiveQuality`, `sceneReady`,
`physicsLoading`, `settings` (persisted to `localStorage` under `fac-settings-v1`),
`telemetry`, `hangar`, `ops`, `messages`, plus actions (`setScreen`, `togglePause`,
`cycleCamera`, `toggleAssist`, `resetFlight`, `updateSettings`, `setKeyBinding`, `setHangar`,
`setOps`, `pushMessage`, …). Outside React: `useGameStore.getState()`.

- `telemetry` is a ≈10 Hz snapshot of `sim` in display units (`publishTelemetry()`); use it for
  React-rendered numbers. For 60 Hz needles, read `sim` in a `requestAnimationFrame` loop and
  write to the DOM through refs.
- `useQuality()` / `getQuality()` (`src/state/useQuality.ts`) return the active
  `QualityPreset` (`src/config/quality.ts`): `shadows`, `shadowMapSize`, `oceanSegments`,
  `exhaustParticles`, `cloudCount`, `postprocessing`, `bloom`, `heatDistortion`, `deckLights`,
  `detail`. Everything expensive must scale with it.
- Toasts: `useGameStore.getState().pushMessage('TEXT', 'info' | 'warn' | 'alert', ttlMs)`.

### Input — `src/controls/input.ts`

Each source writes its slot: `inputSources.keyboard | gamepad | touch` (axes `collective`,
`tilt`, `yaw`, `strafe`, `lookX`, `lookY`, all momentary in [-1, 1], 0 = released). The active
driver calls `combineInput()` once per frame; everyone else reads `input`. `settings.invertY`
is applied by the source (stick-style tilt / look only).

### Actions — `src/state/actions.ts`

`emitAction(name)` / `onAction(name, handler)` for discrete commands: `toggleAssist`,
`cycleCamera`, `launchJet`, `toggleTurbinePanel`, `togglePause`, `resetFlight`. The store-level
ones are wired in `src/state/coreActions.ts`; `launchJet` belongs to flight ops.
Key bindings (`KeyboardEvent.code`) live in `settings.keyBindings` (`src/state/bindings.ts`).

### Game events — `src/state/events.ts`

`emitEvent(name, payload)` / `onEvent(name, handler)` for one-shot OUTCOMES, so systems can
react without importing each other: `liftOff`, `splashdown { sinkRate }`,
`engineToggled { index, enabled }`, `assistChanged { enabled }` (all emitted by the flight
driver), `jetCatapult`, `jetLaunch`, `jetTrap { points, grade }`, `jetWaveOff` (emitted by
flight ops). Audio, camera shake and UI flashes subscribe to these.

### Key capture — `src/controls/keyCapture.ts`

`captureNextKey(): Promise<string | null>` (used by the settings UI to rebind a key),
`cancelKeyCapture()`, `isKeyCaptureActive()` (the keyboard layer stays inert while true).

### What the pilot's axes mean (flight model contract)

| Axis | Flight assist ON (default) | Flight assist OFF (manual) |
|---|---|---|
| `collective` | moves `targetAltitude` up/down (hold); the computer holds altitude | moves all four `manualThrottle[i]` up/down |
| `tilt` | moves `tiltLever` (all nacelles) and leaves it there; the computer compensates lift and keeps the deck level | moves all four `manualTilt[i]` |
| `yaw` | yaw-rate command via differential tilt; heading holds on release | momentary differential tilt (port vs. starboard pair) |
| `strafe` | small commanded bank → sideways slide; levels on release | momentary differential throttle (port vs. starboard pair) |

In manual mode nothing stabilises the ship. The turbine panel edits `manualThrottle[i]`,
`manualTilt[i]` and `turbines[i].enabled` directly. Switching modes must be bumpless (manual
values start from the current commands; `targetAltitude` starts from the current altitude).
Free flight starts afloat with idle engines: hold `collective` up to raise the target altitude
and lift off.

### Debug flags and test hook

URL parameters (`src/config/debugFlags.ts`): `?screen=`, `?quality=`, `?time=`, `?cam=`,
`?assist=0`, `?fixedTime=`, `?ui=0`, `?mute=1`, `?touch=1`, `?tune=1`, `?sandbox=` (dev only).
`window.__FAC__` = `{ store, sim, input, inputSources, clearInput, emitAction }` for e2e tests
and the console.

---

## 4. Scene composition and component contracts

`src/App.tsx` → one persistent `<Canvas>` (`SceneRoot`) + DOM overlay (`UIRoot`) +
`ControlsManager` + `AudioManager`.

`src/scene/SceneRoot.tsx` renders, in order: driver · `World` · `Clouds` · `Ocean` ·
`Carrier` · `FlightOps` · `CameraRig` · `HangarHotspots` (hangar only) · `PostFX` ·
`AdaptiveQuality`.

| Component | Contract |
|---|---|
| `World` | Sky dome, sun/moon directional light (casts shadows; its shadow frustum follows the ship, radius `CARRIER_BOUNDING_RADIUS`), ambient/hemisphere light, scene fog. Driven by `settings.timeOfDay`. Writes `sim.env.{sunDirection, daylight, sunColor, horizonColor, zenithColor}` every frame. Thickens fog with `sim.env.cloudCover`. |
| `Clouds` | Cloud layer scaled by `quality.cloudCount`; writes `sim.env.cloudCover` (0..1, camera inside cloud). |
| `Ocean` | Infinite-looking sea centred under the camera, displaced consistently with `waveHeightAt` (`src/config/waves.ts`), lit from `sim.env`, fading into `horizonColor`. Foam around the hull when afloat; downwash rings from `getDownwash(i)`. |
| `Carrier` | Root group that follows `sim.carrier`. Composes `Hull` (incl. outrigger pylons), `Deck`, `Island` and four `Turbine`s, each inside a group at `TURBINE_MOUNTS[i]`. |
| `Turbine({ index })` | Rendered at its tilt pivot in carrier axes. Applies `-tilt` about X, spins the fan from `turbineRpmFraction`, glows with throttle, mounts `TurbineExhaust` in the tilting frame (exhaust leaves along local `-Y`). |
| `CameraRig` | Owns the default camera for every `cameraMode` (`orbit`, `chase`, `deck`, `bridge`, `turbine`) and screen; pointer/touch drag + wheel/pinch + `input.lookX/lookY`; writes `sim.camera.position`; applies shake when `settings.cameraShake`. In the hangar it eases toward `hangar.selectedHotspot`. |
| `PostFX` | `EffectComposer` chain gated by quality: bloom, ACES tone mapping, vignette, screen-space heat distortion at `getTurbineExhaust(i)`. |
| `FlightOps({ active })` | Air wing in world space; always mounted (keyed by `resetNonce`). `active = false` (menu, hangar, free flight): the jets sit on their `PARKING_SPOTS`, riding with the ship. `active = true` (flight ops): catapult launch on the `launchJet` action, scripted pattern + approach, recovery scoring into `store.ops`. Writes `sim.jets` at `FRAME_PRIORITY.systems`; emits the `jet*` game events. |
| `HangarHotspots` | In-canvas projector for the hangar pins: turns the `HOTSPOTS` anchors into screen positions each frame for the DOM pins rendered by `HangarOverlay`. |
| `AdaptiveQuality` | Lowers `effectiveQuality` one step when the frame rate stays under 45 fps for ≈3 s (if `settings.adaptiveQuality`). |

### Rendering rules shared by all 3D code

- **Tone mapping / colour space.** With post-processing on, the renderer uses
  `NoToneMapping` and the composer tone-maps; with it off, the renderer tone-maps (ACES).
  Therefore every custom `ShaderMaterial` must end its fragment shader with
  `#include <tonemapping_fragment>` and `#include <colorspace_fragment>` so it is correct in
  both paths. Built-in materials already do this.
- **Glow.** Things that should bloom use an emissive / colour above 1.0 with
  `toneMapped={false}`. Bloom thresholds at ≈1, so ordinary lit surfaces never bloom.
- **Shadows.** Ship meshes `castShadow` + `receiveShadow`; nothing else needs to. Shadows are
  off on the Low preset (`quality.shadows`).
- **Depth.** The camera is `near = 1`, `far = 60000`, no logarithmic depth buffer. Keep
  coplanar decals apart with `polygonOffset` (or a few centimetres of real offset).
- **Colours** for ship / aircraft materials come from `src/config/palette.ts`.
- **Originality.** The ship, aircraft, names and markings are our own design. Do not imitate
  any vehicle, logo, name or insignia from a film, comic, game or real navy.

---

## 5. UI overlay

`src/ui/UIRoot.tsx` composes the overlay by screen. `.ui-root` is `pointer-events: none`;
interactive elements opt back in (`.fac-panel` and `.fac-btn` already do), so the canvas keeps
receiving drags. Use the tokens and base classes in `src/styles/global.css` (`--fac-*`,
`.fac-panel`, `.fac-btn`, `.fac-btn--primary`, `.fac-btn--ghost`, `.fac-readout`,
`.fac-label`). Component CSS lives next to the component with a unique class prefix. No CSS
frameworks, no web fonts, no images.

Layout must work from 360×640 (phone portrait) through 844×390 (phone landscape) to desktop,
respect the safe-area insets, and never put a control under another one.

**Reserved touch zones.** When the on-screen touch controls are visible (coarse pointer, or
`settings.touchControls === 'on'`), the bottom-left and bottom-right corners (each
240 px wide × 240 px high, inside the safe area) belong to the touch controls. Other overlay
elements stay out of those corners in that case. Use `useTouchControlsVisible()` from
`src/controls/touchVisibility.ts` to know whether they are shown.

Stable test ids (`data-testid`) — keep them when replacing placeholders:

- Menu: `main-menu`, `menu-free-flight`, `menu-flight-ops`, `menu-hangar`, `menu-settings`
- HUD: `hud`, `hud-altitude`, `hud-speed`, `hud-heading`, `hud-vspeed`, `hud-assist`,
  `hud-camera` (text content = the plain number / label)
- Turbine panel: `turbine-panel`, `turbine-throttle-0..3`, `turbine-tilt-0..3` (range inputs),
  `turbine-enabled-0..3`
- Settings: `settings`, `settings-quality` (the radio group) with `settings-quality-low|medium|high`
  (the options), `settings-close`, `settings-time`, `settings-mute`, `settings-invert-y`,
  `settings-rebind-<bindingId>`
- Pause: `pause-menu`, `pause-resume`, `pause-restart`, `pause-settings`, `pause-exit`
- Hangar: `hangar-overlay`, `hangar-back`, `hotspot-<id>`, `hangar-card`, `hangar-throttle`,
  `hangar-tilt`
- Ops: `ops-hud`, `ops-score`, `ops-status`, `ops-stability`, `ops-launch`
- Touch: `touch-controls`, `touch-stick`, `touch-throttle`, `touch-btn-<actionName>`
- Misc: `loading-screen`, `toasts`, `fps-counter`

---

## 6. Developing and checking a module

### Sandboxes

`/?sandbox=<name>` (dev server only) renders `src/dev/sandboxes/<name>.tsx` by itself.
`src/dev/SandboxStage.tsx` gives 3D modules a canvas with the idle driver, lights and an orbit
camera (`throttle` / `tiltDeg` props drive the turbines; `altitude` / `forwardSpeed` place and
move the ship). Use a sandbox to look at your module
in isolation; other modules may be mid-change.

### Screenshots (headless, software WebGL)

```bash
VITE_CACHE_DIR=node_modules/.vite-<you> npx vite --port <your port> --strictPort &
node scripts/shot.mjs --url "http://127.0.0.1:<port>/?sandbox=<name>&quality=high" --out .shots/<name>.png --wait 4000
```

`scripts/shot.mjs` options: `--width/--height`, `--mobile [--landscape]`, `--wait <ms>`,
`--ready <js>`, `--eval <js>`, `--hold KeyW,ArrowUp`, `--press KeyC`, `--click <selector>`,
`--console`. It prints page errors and exits non-zero if the page threw. Software rendering
is slow (a few fps): wait generously, and force `?quality=` so adaptive quality does not
change what you are looking at. `?fixedTime=12` freezes idle scenes for repeatable frames.
Always **look at** your screenshots (open the PNG) — a clean build says nothing about how
it looks.

### Checks before you call a module done

```bash
npm run typecheck:app              # whole app typechecks (safe to run concurrently; do NOT use `tsc -b` or `npm run build` while others are working)
npx eslint <your files>            # no errors
npx prettier --write <your files>
npx vitest run <your test files>   # if you have tests
```

### Working in parallel with other modules

Several people/agents work in this tree at the same time. To keep that safe:

- Edit **only the files you own** (your brief lists them) and new files in your own folder.
  Shared foundation files are read-only: `src/state/**`, `src/config/**` (except files your
  brief assigns to you), `src/controls/input.ts`, `src/scene/SceneRoot.tsx`, `src/App.tsx`,
  `src/main.tsx`, `src/ui/UIRoot.tsx`, `src/styles/global.css`, `src/dev/Sandbox.tsx`,
  `src/dev/SandboxStage.tsx`, `src/utils/math.ts`, all config files in the repo root.
  If you need a change in one of them, describe it in your final report instead of making it.
- Keep each component's default export and props as specified here.
- `tsc` may report errors in files that someone else is editing right now — ignore errors
  outside your files, fix every error inside them.
- Do not run git commands that change state (`add`, `commit`, `stash`, `checkout`, `reset`…),
  do not install packages, do not run formatters or `--fix` over files you do not own.
- Use your own dev-server port and `VITE_CACHE_DIR`; stop the server when you are done.
  Write screenshots under `.shots/<your module>/` (git-ignored).
