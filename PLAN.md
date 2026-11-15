# Flying Aircraft Carrier — Web App Build Plan

An interactive 3D web app where the user can view, fly, and operate an original
flying aircraft carrier lifted by four jet turbines. It runs in the browser,
needs no install, and works on desktop and mobile.

---

## 1. Goals

| Goal | What "done" looks like |
|---|---|
| **Showcase** | A detailed 3D carrier with four spinning, glowing, tiltable turbines, shown in an orbit-camera "hangar" view |
| **Fly it** | The player can take off from the ocean, hover, climb, yaw, and move forward using the turbines |
| **Operate it** | The player sets each turbine's throttle and tilt, and launches and recovers jets from the deck |
| **Feel alive** | Sky, ocean, clouds, exhaust heat shimmer, particles, engine audio, camera shake |
| **Run everywhere** | 60 fps on a mid-range laptop, 30+ fps on a recent phone, with touch controls |

**Out of scope for v1:** multiplayer, combat or damage, user accounts, and a backend.

---

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Build | **Vite** + **TypeScript** | Fast dev server, simple static build |
| UI shell | **React 18** | Menus, HUD, and the settings panel |
| 3D | **Three.js** with **@react-three/fiber** and **@react-three/drei** | Declarative scene graph and ready-made helpers (Sky, Environment, OrbitControls) |
| Physics | **@react-three/rapier** (Rapier WASM) | Rigid bodies, forces, and colliders for the carrier and jets |
| Post-processing | **@react-three/postprocessing** | Bloom on the turbine glow, vignette, tone mapping |
| State | **Zustand** | Shared game state between the HUD and the 3D loop with few re-renders |
| Audio | **Howler.js** (or the Web Audio API directly) | Looping engine sounds with pitch tied to throttle |
| UI controls | **Leva** (dev only) | Live tuning of physics constants |
| Testing | **Vitest** (unit), **Playwright** (end-to-end and screenshots) | |
| Lint/format | ESLint + Prettier | |
| Hosting | GitHub Pages or Vercel (static) | No server needed |

---

## 3. Project Structure

```
flying-aircraft-carrier/
├── public/
│   ├── models/        # carrier.glb, jet.glb (Draco-compressed)
│   ├── textures/      # deck, hull, ocean normals
│   └── audio/         # turbine_loop.ogg, wind.ogg, launch.ogg
├── src/
│   ├── main.tsx
│   ├── App.tsx                 # routes between Hangar, Flight, and Settings
│   ├── state/
│   │   └── useGameStore.ts     # Zustand: throttle, tilt, mode, telemetry
│   ├── scene/
│   │   ├── World.tsx           # Sky, lighting, fog, ocean, clouds
│   │   ├── Ocean.tsx           # shader water (Gerstner waves)
│   │   ├── Clouds.tsx
│   │   └── CameraRig.tsx       # orbit / chase / deck / turbine cams
│   ├── carrier/
│   │   ├── Carrier.tsx         # hull, deck, island, rigid body
│   │   ├── Turbine.tsx         # nacelle, fan blades, tilt pivot, glow
│   │   ├── TurbineExhaust.tsx  # particles and heat-shimmer shader
│   │   ├── Deck.tsx            # runway markings, lights, elevators
│   │   └── carrierPhysics.ts   # thrust → force/torque math
│   ├── aircraft/
│   │   ├── Jet.tsx
│   │   ├── LaunchSystem.ts     # catapult launch on the deck
│   │   └── RecoverySystem.ts   # landing approach and arrestor
│   ├── controls/
│   │   ├── keyboard.ts
│   │   ├── gamepad.ts
│   │   └── TouchControls.tsx   # virtual sticks and throttle slider
│   ├── ui/
│   │   ├── HUD.tsx             # altitude, speed, heading, turbine gauges
│   │   ├── TurbinePanel.tsx    # per-turbine throttle and tilt
│   │   ├── MainMenu.tsx
│   │   └── Settings.tsx        # graphics quality, audio, controls
│   ├── audio/
│   │   └── engineAudio.ts
│   └── utils/
│       └── math.ts
├── tests/
│   ├── unit/carrierPhysics.test.ts
│   └── e2e/smoke.spec.ts
├── index.html
├── vite.config.ts
└── package.json
```

---

## 4. The Carrier Design (original)

The design is **original**. It does not copy any film, comic, or game vehicle.

- **Hull:** an angular, stealth-style hull about 300 m long (rendered at scene
  scale), with a flat flight deck and an offset command island.
- **Turbines:** four ducted-fan nacelles on outrigger pylons, two fore and two
  aft. Each one has:
  - a fan rotor whose spin speed follows throttle
  - a **tilt pivot** from 0° (pointing down, for hover) to 60° (forward
    thrust)
  - an emissive inner ring that brightens with throttle and feeds the bloom
  - an exhaust cone of particles plus a refraction shader for heat shimmer
- **Deck:** runway markings, edge lights, two catapult tracks, an arrestor zone,
  and one animated aircraft elevator.

**Modeling path:**
1. **Prototype:** build the carrier from Three.js primitives (boxes, cylinders,
   and lathe geometry) so gameplay is never blocked on art.
2. **Final:** model it in Blender, export as glTF/GLB, compress with Draco or
   Meshopt, and swap it in by changing only `Carrier.tsx` and `Turbine.tsx`.

---

## 5. Flight Physics Model

The carrier is a single Rapier rigid body. Each turbine applies a force at its
own mount point, so pitch and roll come out of the physics naturally.

```
for each turbine i:
  thrustMag  = maxThrust * throttle_i * efficiency(altitude)
  thrustDir  = rotate(UP, tiltAngle_i around carrier's lateral axis)
  worldForce = carrierRotation * thrustDir * thrustMag
  body.addForceAtPoint(worldForce, worldMountPoint_i)

drag    = -k_lin * v * |v|            (linear)
angDrag = -k_ang * ω                  (angular damping)
buoyancy (only when hull below sea level) = ρ * submergedVolume * g
```

**Flight assist (on by default):** a PID controller that:
- holds a target altitude by adjusting collective throttle
- levels pitch and roll by balancing fore/aft and left/right throttle
- turns yaw input into differential tilt (the left pair tilts forward and the
  right pair tilts back)

**Manual mode:** the player controls each turbine directly. This is harder and
more fun.

**Tuning:** expose `maxThrust`, mass, the drag coefficients, and the PID gains
in Leva during development. Unit-test the force math.

---

## 6. Controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Collective throttle up/down | W / S | RT / LT | Right slider |
| Forward tilt (all turbines) | ↑ / ↓ | Right stick Y | Right stick |
| Yaw | A / D | Left stick X | Left stick X |
| Strafe / roll trim | Q / E | Bumpers | Left stick Y |
| Toggle flight assist | F | Y | Button |
| Cycle camera | C | Select | Button |
| Launch jet | Space | A | Button |
| Open turbine panel | T | X | Button |

---

## 7. Game Modes / Screens

1. **Main menu:** the carrier idles above the ocean behind a slow orbit camera.
2. **Hangar / Inspect:** an orbit camera with clickable hotspots on each
   turbine, the island, and the catapults. Each hotspot shows an info card.
   Includes "spin up turbines" and "tilt" demo buttons.
3. **Free flight:** take off from the water, then fly around with a HUD.
4. **Flight ops:** keep the carrier steady while jets launch and land. Each
   recovery scores higher when the deck is level and stable.
5. **Settings:** graphics preset (Low/Med/High), audio volumes, control
   remapping, and invert-Y.

---

## 8. Visuals & Audio

- **Sky:** drei `<Sky>` with a time-of-day slider, plus a matching directional
  light and shadows (cascaded shadows on High only).
- **Ocean:** a Gerstner-wave vertex shader with a fresnel term and foam near the
  hull. A "downwash" ring ripples the water under the turbines when altitude is
  below 50 m.
- **Clouds:** instanced billboard sprites or drei `<Clouds>`. Flying through
  them adds fog density.
- **Exhaust:** GPU instanced particles plus a screen-space heat-distortion pass.
- **Post-processing:** Bloom, ACES tone mapping, and a subtle vignette.
- **Audio:** each turbine has a looping sound whose pitch and volume follow its
  throttle, positioned in 3D. Wind noise scales with airspeed. One-shot sounds
  for launches and the elevator.

---

## 9. Performance Budget

| Item | Budget |
|---|---|
| Draw calls | < 150 (instance the deck lights, clouds, and particles) |
| Triangles | < 500k on High, < 150k on Low |
| Textures | KTX2/Basis compressed, ≤ 2048² |
| JS bundle | < 1.5 MB gzipped (lazy-load Rapier and audio) |
| Particles | 2k on Low, 10k on High |

Adaptive quality: watch the frame time and drop to the next lower preset when
FPS stays under 45 for 3 seconds (drei `<PerformanceMonitor>`).

---

## 10. Milestones

| # | Milestone | Deliverables | Est. |
|---|---|---|---|
| **M0** | Scaffold | Vite, React, TS, R3F, ESLint, Prettier, Vitest, CI build on GitHub Actions, deployed to Pages | 0.5 day |
| **M1** | Static scene | Sky, ocean shader, lighting, primitive carrier with 4 turbines, orbit camera | 1–2 days |
| **M2** | Turbine visuals | Spinning fans tied to throttle, tilt pivots, emissive glow, bloom, exhaust particles | 1–2 days |
| **M3** | Physics & flight | Rapier body, per-turbine forces, buoyancy, keyboard controls, chase camera | 2–3 days |
| **M4** | Flight assist & HUD | PID altitude and attitude hold, HUD gauges, turbine panel | 2 days |
| **M5** | Audio & polish | Engine audio, wind, camera shake, downwash ripples, clouds | 1–2 days |
| **M6** | Hangar mode | Hotspots, info cards, demo buttons, main menu | 1 day |
| **M7** | Flight ops | Jet launch from catapults, scripted landing approach, scoring | 2–3 days |
| **M8** | Mobile & settings | Touch controls, quality presets, adaptive performance, gamepad | 1–2 days |
| **M9** | Final art | Blender GLB carrier and jet, compressed textures, swapped in | 3–5 days |
| **M10** | QA & release | Playwright smoke and screenshot tests, Lighthouse pass, README, v1.0 tag | 1 day |

**Total:** about 3–4 weeks for one developer. M0–M4 make a playable MVP in about
one week.

---

## 11. Testing Strategy

- **Unit (Vitest):**
  - thrust vector math for every tilt angle
  - convergence of the PID controller in a simplified simulation
  - buoyancy at different depths
  - the store's reducers
- **End-to-end (Playwright):**
  - the app loads and the canvas renders
  - holding W raises the altitude readout
  - the turbine panel slider changes that turbine's state
  - screenshot diffs of the hangar view at fixed seeds and times
- **Manual:**
  - feel-tuning sessions with Leva
  - device checks on iOS Safari and Android Chrome

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| The physics feels floaty or unstable | Assist mode on by default, clamped forces, constants tunable live in Leva |
| Too slow on mobile | Quality presets, adaptive downgrade, instancing, compressed assets |
| The art pipeline blocks progress | Primitive placeholder model until M9, behind a stable component API |
| Rapier WASM load time | Lazy-load it after the menu and show a loading screen with progress |
| The design looks too much like a well-known film vehicle | Keep the design original: own silhouette, four outrigger ducted fans, no borrowed names or insignia |

---

## 13. Getting Started (M0 commands)

```bash
npm create vite@latest . -- --template react-ts
```

```bash
npm i three @react-three/fiber @react-three/drei @react-three/rapier @react-three/postprocessing zustand howler
```

```bash
npm i -D @types/three leva vitest @playwright/test eslint prettier
```

```bash
npm run dev
```
