# A-10 Warthog Simulator — Build Plan

A flight simulator of the A-10C for the browser. You fly over a large training range and
destroy armoured vehicles. Weapon behaviour is the centre of the project: every 30 mm round,
bomb, rocket and missile is a simulated body, and the sight cues on the head-up display (HUD)
are computed from the same physics. What works and what fails in the real aircraft should work
and fail here, for the same reasons.

It is an original simulator of a real aircraft, with its own terrain, scenarios, interface,
art and sound. It does not copy any existing game.

Abbreviations are explained in the glossary (section 20).

---

## 1. Goals

| Goal | What "done" looks like |
|---|---|
| **Real weapons** | Each weapon reproduces its published numbers within the tolerances of section 16 and is used with the real procedure: master arm, HUD mode, weapon profile, sensor, release |
| **The gun, done properly** | The GAU-8/A fires 65 individually simulated rounds per second with the real spin-up, dispersion, recoil, smoke and sound, and the pipper shows where they will land |
| **Tank killing that obeys physics** | Armour thickness, impact angle and range decide every result. A frontal gun pass on a main battle tank fails, a steep pass onto the roof or engine deck works, a Maverick kills outright |
| **The real sight picture** | A collimated HUD with A-10C symbology, and two multifunction displays with stores, targeting-pod, Maverick and map pages |
| **Flies like a Hog** | Slow, tight-turning and slow to regain speed. It meets the public performance figures of section 5 |
| **Just fly** | Thirty seconds after loading you are airborne near targets with weapons loaded. No start-up procedure, and in version 1 nothing shoots back |
| **Runs in a browser** | 60 fps on a mid-range laptop at Medium quality, with keyboard and mouse, a gamepad, or a real stick and throttle |

**Out of scope for version 1:** enemy fire, countermeasures and damage to your aircraft (other
than flying into the ground), engine start and system failures, radios and navigation aids,
air-to-air combat, wingmen, multiplayer, night flying, and people on the ground. The only
targets are vehicles. Section 15 lists what can follow.

---

## 2. What "as close as possible to the real thing" means

| Area | Level | What that means |
|---|---|---|
| Ballistics, guidance, fuzing, fire control | Highest | Physically simulated and checked by numeric tests |
| HUD symbology and weapon switch logic | High | The real logic and the real symbols. Inputs are laid out so that a keyboard can do it, but no step is skipped unless you switch an aid on |
| Targeting pod and Maverick seeker | High | A rendered sensor picture with the real limits: field of view, gimbal travel, contrast, range, line of sight. Tracking is computed from geometry, not by image processing |
| Target damage | High | Armour plates and internal components for each vehicle |
| Flight model | Medium-high | Six degrees of freedom, tuned to public performance data. No failures |
| Everything else in the aircraft | Low | Only what weapon delivery needs |

**Data.** Only public sources are used: manufacturer brochures, official fact sheets,
encyclopaedias and hobbyist documentation. Restricted manuals are not. Some real values are
not public at all (seeker lock ranges, armour protection, penetration tables), so those are
estimates. Every constant lives in one data module with its source and a confidence mark, so
a better number is a one-line change. Section 19 lists the figures collected so far.

**Realism presets.** *Authentic* is the default.

| Aid | Authentic | Standard | Relaxed |
|---|---|---|---|
| Finding targets | Your eyes, the pod, smoke and dust | Target areas marked on the map display | Boxes on the HUD |
| Sensor lock | Manual slew and track | Manual, with a larger capture gate | Snaps to the nearest vehicle |
| Gun trigger | Two stages, PAC on the first | Two stages, PAC on the first | One stage, PAC always on |
| Trim | Manual | Automatic | Automatic |
| Ammunition and stores | Real load | Real load | Unlimited |
| Fuze arming, duds, fragment warnings | On | On | Off |
| Flying into the ground | Ends the flight | Ends the flight | The aircraft bounces off |

In every preset an optional checklist strip names the next real step ("Master Arm to ARM",
"Master mode to GUNS"), so the procedure can be learned in the air.

---

## 3. Where it lives and what it is built with

A second, self-contained app in this repository, served at `/a10/` beside the carrier app.
The carrier app keeps its behaviour and its tests must stay green.

| Layer | Choice | Why |
|---|---|---|
| Build, UI, 3D | The carrier app's pinned stack: Vite, TypeScript, React 18, three.js through React Three Fiber, `postprocessing`, Zustand | Proven here, with CI, tests and screenshot tooling in place |
| Simulation | Own fixed-step core in plain TypeScript. **No Rapier** | An aircraft and its weapons need their own equations, not a general rigid-body engine. Plain functions can be tested without a browser |
| Terrain building | Web Worker | Keeps tile generation off the frame |
| Sensor pictures | three.js render targets | Targeting-pod and Maverick video |
| Audio | Web Audio API, synthesised | Same approach as the carrier, structured so that a recorded sample can replace a voice later |
| Art | Generated in code | No licensing questions and no downloads |
| New dependencies | None | |

What the carrier app already provides:

| | Modules |
|---|---|
| **Reused** | Sky dome, time of day, sun and haze; cloud layer; post-processing chain (bloom, tone mapping, vignette, heat shimmer); quality presets and automatic downgrade; action and event buses; key capture and rebinding; settings storage; menu, pause, settings, toast and loading components with the CSS tokens; error boundary; URL debug flags; `scripts/shot.mjs`; Vitest, Playwright and the CI workflow |
| **Extended** | Input layer (new axes: pitch, roll, rudder, throttle, slew, look, and about 40 switch actions); gamepad layer (any stick or throttle the browser reports); audio building blocks (noise sources, smoothed parameters, one-shots) |
| **New** | Flight model, terrain, cockpit, HUD and displays, weapons, fire control, sensors, targets, damage, effects, debrief |
| **Not used** | Rapier, the ocean, the carrier and its flight computer |

The reused modules have few or no references to the carrier today. Milestone M0 gives them a
small shared slice of the simulation state to read (time, environment, camera) and adds a lint
rule that stops A-10 code and carrier code from importing each other. No carrier file moves.

---

## 4. Architecture

```
controls (keyboard, mouse, gamepad, stick and throttle, touch)
        │  stick, rudder and throttle axes + switch actions
        ▼
SIMULATION CORE: plain TypeScript, fixed 120 Hz step, deterministic
  flight model → gun and stores → rounds, bombs, rockets, missiles → impacts → damage
  fire control (predicts with the same weapon models)     sensors (pod, seekers, laser, SPI)
        │  state + events (roundImpact, storeReleased, detonation, vehicleKilled …)
        ▼
VIEW (three.js)           AUDIO               DEBRIEF RECORDER
world, cockpit, HUD,      gun, engines,       every release and impact,
displays, effects         tones, blasts       for scoring and replay
```

- **One truth.** The view, the audio and the HUD never decide an outcome. They read the
  simulation state and its events.
- **Fixed step.** 120 steps per second, several per frame when needed and never more than
  five, so a slow frame slows the simulation instead of breaking it. Rounds leave at their
  exact times inside a step, so their spacing on the ground is right.
- **Deterministic.** Random numbers are seeded and the same inputs give the same flight. That
  is what makes numeric tests and replays possible.
- **Units.** SI inside the core. The cockpit shows what the real one shows: knots, feet,
  nautical miles and milliradians.
- **Axes.** The repository convention: Y up, north = −Z, east = +X. Aircraft body axes: +X
  right wing, +Y up, −Z nose.
- **Precision.** Positions are 64-bit in the core. The rendered scene is re-centred on the
  aircraft so the cockpit does not shake 30 km from the origin, and world and cockpit are drawn
  in two depth passes (2 m to 100 km, then 5 cm to 10 m).
- **No allocation per frame.** Rounds, particles and decals live in fixed pools.
- **Contract.** `docs/a10/ARCHITECTURE.md`, written in M0, defines the state layout, step
  order, events and file ownership, so modules can be built in parallel as the carrier's were.

```
a10/index.html              # second page of the Vite build, served at /a10/
src/engine/index.ts         # re-exports the shared, carrier-free modules
src/a10/
├── data/          # every real-world constant, with source and confidence
├── core/          # the simulation: plain TypeScript, no three.js, no React
│   ├── flight/        # aerodynamics, engines, flight controls, PAC, autopilot, mass
│   ├── weapons/       # gun, ballistics, bombs, rockets, Maverick, laser bomb, fuzes, stores
│   ├── firecontrol/   # CCIP, CCRP, gun sight, launch constraints
│   ├── sensors/       # targeting pod, seekers, laser, SPI
│   ├── targets/       # vehicles, armour, damage, behaviour, scenario generator
│   ├── world/         # terrain height function, atmosphere, wind, line of sight
│   └── debrief/       # recorder and scoring
├── view/          # three.js: terrain, aircraft, cockpit, HUD, displays, sensor video, effects, cameras
├── audio/         # gun, engines, tones, world sounds with propagation delay
├── input/         # bindings, stick and throttle devices, mouse stick, touch
└── ui/            # menu, loadout, checklist strip, debrief, settings
tests/unit/a10/    # numeric acceptance tests (section 16)
tests/e2e/a10/     # browser tests
docs/a10/          # ARCHITECTURE.md (contracts), REFERENCE_DATA.md (sources)
```

---

## 5. The aircraft and its flight model

The A-10C has a big straight wing, two slow-spooling turbofans and no afterburner. It turns
tightly and flies slowly, and every dive is paid for with a slow climb back. The flight model
has to produce that, because it sets the rhythm of every attack.

- **Model.** A rigid body with six degrees of freedom. Lift, drag, side force and moments come
  from coefficient tables against angle of attack, sideslip, control deflection, flap, speed
  brake and stores drag, including the stall and what follows it. Integrated at 120 Hz.
- **Engines.** Two TF34-GE-100A with spool lag, thrust that falls with altitude and speed, and
  fuel burn.
- **Mass.** Empty weight plus fuel, ammunition and each store at its station. Centre of
  gravity and inertia change as fuel burns and stores leave, and an asymmetric load rolls the
  aircraft.
- **Flight controls the aircraft really has.** Pitch and yaw stability augmentation, manual
  trim, flaps (up, 7° manoeuvre, 20° down), speed brakes (the split ailerons, to 80°), the
  low-altitude autopilot (PATH, ALT/HDG, ALT) for heads-down sensor work, and Precision
  Attitude Control for the gun (section 6.2).
- **Air.** Standard atmosphere, wind that changes with height, low-level turbulence.
- **Warnings.** Steady and chopped stall tones, over-g tone, altitude alert, and the "PULL UP"
  ground-collision warning with the HUD break-X.
- **Ground.** Flying into terrain ends the flight. Take-off and landing are in "later".

| Check | Target (public data) |
|---|---|
| Maximum level speed, clean, sea level | 381 kn ± 3 % |
| Stall speed, clean, 13,600 kg | 120 kn ± 5 % |
| Initial climb rate, clean | about 6,000 ft/min ± 10 % |
| Load limit | +7.33 g / −3 g clean, lower with stores, with the over-g tone |
| Never-exceed speed | 450 kn, with buffet and a warning above it |
| Engines | 2 × 40.3 kN static thrust; idle to full thrust in several seconds (figure to confirm) |
| Dive recovery | A 4 g pull-out from a 30° dive at 300 kn loses about 105 m, as the closed-form answer says |

You start in the air: 8,000 ft, 250 kn, 12 km from the first target area, weapons loaded,
sensors aligned, Master Arm at SAFE.

---

## 6. Weapons

### 6.1 Rules for every weapon

1. **Everything that leaves the aircraft is a simulated body** with mass, drag, gravity and
   wind, stepped at 120 Hz and swept against the terrain and the armour plates of targets.
   Nothing is decided at the moment the trigger is pulled.
2. **The fire-control computer uses the same model.** The gun pipper, the bomb reticle and
   the release cue are predictions made by flying the weapon's own model forward from the
   current aircraft state. The computer has the limits of the real one: it knows the wind at
   the aircraft, not on the ground, and it ranges to the terrain it has data for.
3. **Real arming logic.** Nothing fires unless Master Arm, the mode and, where needed, laser
   arm, seeker state and fuze arming are right.
4. **Every constant has a source** in `src/a10/data/` and a test in section 16.

### 6.2 GAU-8/A Avenger, 30 mm

| | The real gun | In the simulator |
|---|---|---|
| Rate of fire | 3,900 rounds per minute, fixed in the A-10: 65 per second | Each round leaves at its own exact time. At 300 kn the aircraft moves 2.4 m between rounds, so a burst is a line of separate impacts |
| Spin-up | About half a second to full rate; roughly 50 rounds leave in the first second | The rate ramps the same way, and the drive whine rises and falls with it |
| Ammunition | The drum holds 1,174 and 1,150 is the usual load. Combat mix: five armour-piercing incendiary (PGU-14/B, depleted-uranium core) to one high-explosive incendiary (PGU-13/B) | 1,150 rounds in that order, each keeping its type. All-HEI and target-practice loads can be chosen. A full load is about 18 s of fire |
| Ballistics | About 1,010 m/s at the muzzle; projectile ≈395 g (API), ≈378 g (HEI) | A point mass with Mach-dependent drag, gravity and wind, starting with muzzle velocity plus the aircraft's own velocity |
| Dispersion | "5 mil, 80 %": four rounds in five inside a 5-milliradian circle | A random angular error per round, drawn to match. The aircraft's own movement during the burst spreads the pattern further, as it really does, and that part is not faked |
| Mounting | The firing barrel is on the aircraft centreline and the gun line points about 2° below the fuselage line | Same geometry, so recoil hardly yaws the aircraft and the gun cross sits low in the HUD |
| Recoil | About 45 kN on average at full rate, more than one engine's thrust | Applied along the gun line in proportion to the firing rate. A two-second burst costs about 8 kn |
| Precision Attitude Control | First trigger detent: the flight controls hold pitch and yaw to steady the pipper (PAC-1). Second detent: the gun fires and recoil is countered too (PAC-2) | A two-stage trigger on analogue triggers and sticks, and a separate first-detent key on a keyboard. Its authority is limited, as in the aircraft: it steadies, it does not aim |
| Gun gas | The engine igniters run while the trigger is held so that gun gas cannot flame an engine out. Smoke streams back from the nose | Smoke plume from the nose while firing |
| Tracers | None | None. You see smoke, and about a second later the impacts |
| Cases | Returned to the drum, not ejected | Only projectile and propellant mass leave the aircraft |
| Burst length | One to two seconds by habit, to save ammunition and barrels. There is no limiter | No artificial limit. The debrief records burst length |

**The sight.** In GUNS mode the HUD shows the CCIP gun reticle: a pipper inside a circle with
a range bar around it, a slant-range readout, a minimum-range cue, the gun cross and the rounds
counter. The pipper is the predicted impact point of a round fired now. The other sights the
aircraft offers (fixed-range reticles for when ranging is unavailable, a lead cross for moving
targets, the manually depressed pipper as a backup) follow in M10.

**What you should notice.**

- The pipper settles only if you fly smoothly, and squeezing to the first detent steadies it.
- The airframe shakes at 65 Hz, the airspeed drops, and smoke pours past the canopy.
- From 1,200 m the impacts arrive a little over a second after you fire: white sparkle on
  armour, dust on dirt, small explosions from the HEI rounds.
- From a camera at the target you hear the impacts first and the gun's growl afterwards,
  because the rounds are supersonic.
- Pull out late and you hit the ground. The altitude alert and "PULL UP" are the real safety
  net, and they are yours too.

### 6.3 What a 30 mm round does when it lands

Each impact is resolved against the plate it hits, from the impact speed, the angle and the
plate's thickness.

- **API** penetrates if its penetration at that speed exceeds the plate's thickness along
  the line of flight. The curve is fitted to the two public points: about 69 mm of steel at
  500 m and 38 mm at 1,000 m.
- **HEI** bursts on contact. It does not go through armour, but it destroys trucks and
  damages what is outside a tank: optics, tracks, external fuel.
- **Behind the armour** the round carries on inside the vehicle and may reach the engine,
  the fuel, the ammunition, the gun or the crew compartment. That decides between a mobility
  kill, a firepower kill, a fire and a catastrophic explosion.
- **Ricochets** happen beyond about 70° from the plate's normal, and rounds skip off hard
  ground in shallow passes. Both are drawn, and a skipping round can still hit something.

What this does to your flying, using the public estimates for a T-72-class tank:

| Attack | Plate hit | Steel along the line of flight | Result |
|---|---|---|---|
| 45° dive, firing at 1,200 m | Roof or engine deck, 20 mm | ≈28 mm | Just penetrates |
| 30° dive, firing at 1,200 m | Roof or engine deck, 20 mm | ≈40 mm | Fails. Works inside about 950 m |
| 10° strafe from behind | Rear plate, 40 mm | ≈41 mm | Penetrates inside about 950 m: engine hits, mobility kill |
| From the front or the side, beyond 400 m | Glacis, turret front, side: 80 mm and more | ≥80 mm | No penetration, only external damage |

Light armour (infantry fighting vehicles, personnel carriers) is penetrated from any
direction, and trucks by everything.

### 6.4 AGM-65 Maverick

| | The real missile | In the simulator |
|---|---|---|
| Variants | D and G: imaging infrared. H and K: television (CCD). D and H carry a 57 kg shaped charge, G and K a 136 kg penetrating warhead | D and H in version 1. G and K follow as data |
| Launchers | LAU-117 (one missile) or LAU-88 (up to three) | Both, with their weight and drag |
| Getting video | Seeker power on, then about three minutes of alignment before there is a picture | Aligned at an air start. The wait applies after a rearm or if you switch the power off |
| Finding the target | The seeker picture shows on a cockpit display. You slew the seeker, or slave it to the point the targeting pod is tracking, and switch to the narrow field of view | A gimballed camera rendered to the MAV page, with the missile's gimbal limits |
| Locking | You command track. The seeker locks onto a contrasting object, and the pointing cross shows whether the launch geometry is good | Lock needs enough angular size inside the tracking gate, enough contrast (thermal for D, visual and daylight for H), line of sight and atmosphere. A tank-sized target locks at roughly 3 to 7 nautical miles (tunable) |
| Launch | Hold the weapon-release button for about a second. The missile is on its own after that | The same. The next missile is selected and can be slaved to the same line of sight |
| Flight | Rail launch, boost and sustain motor, about 1,150 km/h, aerodynamic range beyond 22 km | Thrust profile fitted to those figures; proportional navigation with g and gimbal limits; impact fuze |
| Effect | A shaped charge that defeats any tank | A hit destroys any vehicle. G and K add a large blast |

It can go wrong, and it should: the lock breaks when terrain, trees or smoke come between; an
infrared seeker can be captured by a burning wreck beside the live tank; a television seeker
finds nothing in haze or low light; a launch outside the gimbal limits is refused. A weapon
camera follows the missile to impact.

### 6.5 Mk-82 unguided bombs (low-drag and AIR high-drag)

- **Profile.** Set on the stores page: CCIP or CCRP, single or pairs, ripple quantity and
  spacing, nose or tail fuze, minimum altitude.
- **CCIP.** A line runs from the velocity vector down to the reticle. You fly the pipper onto
  the target and press the release button. If the impact point is below the HUD glass, which
  is normal in shallow dives, you hold the button and fly through the cue, and the computer
  releases (consent release).
- **CCRP.** You steer onto the azimuth line toward the SPI, hold the button, and the
  computer releases at the solution. The HUD counts down to release and then to impact.
- **Physics.** Ejection speed, drag by type (low-drag fins or the AIR ballute), wind, ripple
  spacing.
- **Fuze.** It arms a set time after release, so a bomb dropped too low is a dud. The HUD
  shows the minimum-range cue, and the debrief flags a release inside the fragment envelope.
- **Effect.** Blast by scaled distance, plus a statistical fragment model. A tank needs a hit
  within a few metres. Trucks die much further out. That is why unguided bombs are a poor
  anti-tank weapon, and here too.

### 6.6 GBU-12 Paveway II laser-guided bomb

- **Laser.** The targeting pod must be tracking, the laser armed, and the laser fired with
  its button (latched or held). Bomb and pod codes must match (1688 by default).
- **Bomb.** Ballistic until its seeker sees the spot. Then the canards steer at full
  deflection, one way or the other, which costs energy. Lase from release at long range and
  it falls short. Lase for about the last ten seconds and it hits. Lose the spot and it falls
  as a plain bomb.
- **Release.** CCRP onto the SPI, with the time-to-impact countdown to time the laser.

### 6.7 Hydra 70 rockets

- Seven-tube LAU-131/A or LAU-68 pods. Mk 66 motor: about 1.07 s burn, about 6 kN, about
  739 m/s at burn-out from a static launch.
- Warheads: M151 high explosive (about 4 kg) and M156 white phosphorus, whose smoke marks a
  target for the next pass. M257 illumination comes with night flying.
- Unguided: launch dispersion, turning into the wind during the burn, single or ripple fire,
  a CCIP rocket pipper.

### 6.8 Stores management

- Eleven stations. What may hang where, and each store's weight and drag, follow public
  loading diagrams. Weight and drag change performance, and asymmetry needs trim.
- The stores page (DSMS) shows the inventory, the weapon profiles and the selected station,
  and offers selective jettison.
- The loadout screen has presets and free choice, and shows total weight and drag before you
  fly. The default "tank hunter": gun with 1,150 rounds of combat mix, four Mavericks (two
  infrared, two television), two GBU-12, two Mk-82, one rocket pod with smoke warheads, and
  the targeting pod.

### 6.9 Later weapons

CBU-97 sensor-fuzed weapon (ten submunitions, each throwing four infrared-seeking warheads
that fire a penetrator down at a vehicle: the purpose-built tank killer), CBU-87 cluster bomb,
GBU-38 JDAM, laser-guided rockets, Mk-84, LUU-2 illumination flares.

---

## 7. Fire control, HUD and cockpit

**The HUD is collimated.** The real one is focused at infinity: move your head and each symbol
stays on the same piece of ground, and you only see the part of the symbology that is inside
the glass. The simulator draws the symbols in angle space around the pilot's eye and clips them
to the combiner glass, so it behaves the same way. That is what makes dive geometry come out
right, including the pipper that sits below the glass.

| HUD element | Notes |
|---|---|
| Flight symbology | Airspeed and altitude readouts, heading tape, pitch ladder, total velocity vector, radar altitude, g, steerpoint block |
| Weapon block | Master Arm state, master mode, selected profile, rounds remaining |
| Master modes | NAV, GUNS, CCIP, CCRP, cycled with the master-mode button. The air-to-air mode is left out |
| Gun | Section 6.2 |
| Bombs and rockets | Impact line, reticle and pipper, minimum-range cue, release cue, azimuth steering line, time to release and to impact |
| Sensors | SPI marker, targeting-pod line of sight, Maverick seeker line of sight |
| Warnings | Break-X, "CCIP INVALID", altitude alert |

**Fire-control inputs.** Wind as measured at the aircraft. Height above the target from the
terrain database (default), the radar altimeter or the barometric altimeter, chosen with the
altitude-source switch. The last two are less accurate over hills, as in the aircraft.

**Cockpit.** The front panel as the pilot sees it: HUD, up-front controller, the armament
panel (Master Arm, GUN/PAC arm, laser arm, targeting-pod power, altitude source), two
multifunction displays with twenty edge buttons each, standby attitude, airspeed and altitude,
basic engine gauges, the canopy frame. Switches and display buttons can be clicked.

**Display pages.** DSMS (stores), TGP (targeting pod), MAV (Maverick), TAD (moving map with
your aircraft, steerpoints and the SPI).

**SOI and SPI.** One display or the HUD is the sensor of interest (SOI): the slew and
target-management controls act on it. One point on the ground is the sensor point of interest
(SPI): the pod, the Mavericks, CCRP bombing and the map can all be slaved to it. That is how a
target found in the pod is handed to a Maverick, as in the aircraft.

---

## 8. Sensors

**Targeting pod (Litening).**

- Television and infrared pictures, white-hot or black-hot, wide and narrow fields of view
  with electronic zoom (exact angles to confirm).
- Gimbal limits, and masking by the aircraft's own wing and fuselage.
- Inertial, area and point track. Point track holds a moving vehicle.
- Laser designator and range finder. The lased range sharpens the fire-control solution.

**How the picture is made.** A second camera at the pod renders the world to a small texture,
which the display page shows with its symbology on top. The infrared picture comes from a
thermal model, not from a colour filter:

- vehicles have hot engine decks, exhausts and tracks when running, and cool after they stop
- the ground warms in the sun and cools in shade and toward evening; trees stay cooler
- fires and wrecks are very hot; the sky is cold
- the picture has gain control, noise and a slower frame rate than the outside view

The infrared Maverick seeker uses the same thermal model, so what the pod shows as hot is what
the missile can lock.

**Seeing with your eyes.** A 7 m tank at 5 km is one or two pixels at a normal field of view.
That is true to life, and a monitor has less resolution than an eye, so the simulator gives
the usual aids: a zoom view (hold to narrow the field of view), a look-at-SPI key, dust trails
behind moving vehicles, exhaust smoke, white-phosphorus marks and the smoke of burning wrecks.

---

## 9. Targets and damage

The setting is a fictional live-fire range with remotely driven target vehicles in a plain
grey-green scheme, without real markings. That also explains why nothing shoots back.

| Vehicle | Armour (public estimates) | Notes |
|---|---|---|
| Main battle tank, T-72 class | Front immune to the gun; side ≈80 mm; rear ≈40 mm; roof and engine deck ≈20 mm | Ammunition under the turret: a penetrating hit there is catastrophic |
| Infantry fighting vehicle, BMP class | Thin, about 6 to 25 mm | Penetrated from any direction |
| Wheeled personnel carrier, BTR class | Very thin, about 7 to 10 mm | |
| Trucks: cargo, fuel, ammunition | None | Fuel and ammunition trucks give large secondary explosions |
| Hulks and scoring panels | | Range targets |

- **Structure.** Each vehicle is about a dozen armour plates with thickness and angle, and a
  set of internal components: engine, fuel, ammunition, gun, running gear, optics, crew
  compartment.
- **States.** Intact → damaged (immobilised, or gun out of action) → destroyed and burning →
  catastrophic (ammunition explodes and the turret is thrown off).
- **Behaviour.** Groups parked in the open, dug in, along tree lines, and columns driving on
  roads at 30 to 40 km/h. A column under attack stops or scatters off the road.
- **Signature.** Heat for the sensors (section 8), dust and exhaust for the eye.
- **Record.** Every hit is logged with the plate, angle, speed and result, for the debrief.

---

## 10. The world

- **Size.** A fictional range of about 64 × 64 km, generated from a seed: a farmed valley with
  roads, ridges to about 900 m, forests, a river, an airbase and several target areas. At
  300 kn that is about seven minutes from edge to edge.
- **One height function.** The simulation (collision, ranging, line of sight, vehicle
  placement) and the renderer read the same function, as the carrier's sea does.
- **Rendering.** Terrain tiles at several levels of detail, built in a worker; ground
  textures from slope, height and moisture; roads and field patterns; instanced trees near
  the aircraft and a forest canopy further out; haze from the existing atmosphere code; the
  existing cloud layer.
- **What has to look right from 3,000 m.** Scale (roads, fields, tree lines), haze, and the
  smoke columns and dust that lead you to targets.
- **Conditions.** Day only in version 1, clear or hazy, with a wind you can set. Haze
  shortens what the eye, the pod's television camera and the television Maverick can see.

---

## 11. Modes and screens

1. **Fly now (free hunt).** Air start near a target area. Six to ten vehicle groups are
   spread over the range, and new groups appear elsewhere as you destroy them. No time limit.
   Rearm and refuel from the pause menu.
2. **Weapons range.** Scored events for learning each weapon:
   - strafe pit: hits out of rounds fired on a panel, open-fire and cease-fire range, and a
     foul for pressing inside the foul line or below the minimum altitude
   - bombing circle: miss distance and clock direction of each bomb, and the average over
     the session
   - tactical lane: hulks and a moving column for Mavericks, laser bombs and rockets
3. **Loadout.** The aircraft with its eleven stations, presets, weight and drag.
4. **Debrief.** After each pass and at the end of the flight: the weapon, the release
   conditions (dive angle, speed, slant range, height, g), an overhead plot of the impacts
   against the target, and what each hit did.
5. **Settings.** Graphics, sound, realism preset, controls.

Views: cockpit with head look and zoom, look-at-SPI, external chase, fly-by, weapon camera
and a camera at the target.

---

## 12. Controls

The real aircraft is flown hands-on-throttle-and-stick. The simulator keeps those functions
and their names. Every binding can be changed, and any stick, throttle or pedals that the
browser reports can be bound, axis by axis and button by button.

| Function (real control) | Keyboard and mouse | Gamepad |
|---|---|---|
| Stick: pitch and roll | Arrow keys, or mouse-stick mode | Left stick |
| Rudder | Z / X | LB / RB |
| Throttles | Page Up / Page Down | D-pad ↑ / ↓ |
| Speed brake | B | B |
| Flaps, gear | F, G | — |
| Trim | Ctrl + arrow keys | LT + D-pad |
| Trigger: first detent (PAC-1), second detent (fire) | Left Shift, Space | RT half, RT full |
| Weapon release | Enter | A |
| Master mode: NAV, GUNS, CCIP, CCRP | M | X |
| Previous / next weapon profile | [ / ] | Y |
| Sensor of interest: HUD, left display, right display | H, comma, full stop | D-pad ← / → |
| Slew the sensor or cursor | W A S D | LT + right stick |
| Target management up: track; hold to set the SPI | T | LT + A |
| Target management down: break track; hold to reset the SPI | R | LT + B |
| Field of view; hold to slave all sensors to the SPI | V | LT + X |
| Picture: white-hot, black-hot, television | C | — |
| Sensor zoom in / out | E / Q | — |
| Fire the laser | L | LT + Y |
| Armament panel: Master Arm, GUN/PAC, laser arm, pod power | 1, 2, 3, 4, or click | Click |
| Autopilot engage / mode | P / O | — |
| Look around, zoom view | Mouse, wheel | Right stick, click |
| Look at the SPI | N | — |
| Free the cursor to click the cockpit | Left Alt | — |
| Views | F1 to F5 | Back |
| Pause | Esc | Start |

Touch gets a reduced layout late in the project: a stick, a throttle slider, gun, release,
mode and profile buttons, and tap-to-designate on an enlarged display.

---

## 13. Sound and effects

**Sound.** Synthesised, as in the carrier app.

- **Gun, in the cockpit.** A 65 Hz pulse train through the resonances of the airframe, a low
  rumble, and the hydraulic drive's whine rising over the first half-second and falling after.
- **Gun, from outside.** Sharper, with the crack of supersonic rounds.
- **Distance.** Every sound in the world arrives late by its distance at the speed of sound
  and loses its high frequencies with range. A bomb flashes, then booms. At the target the
  impacts come before the gun.
- **Engines.** The high-bypass fan whine of the TF34 and a core rumble, following the spool.
- **Airframe.** Wind with speed, buffet near the stall, speed-brake rumble.
- **Weapons.** The clunk of a bomb leaving, the whoosh of a Maverick or a rocket ripple.
- **Cockpit.** Stall tones, over-g, master caution, altitude alert, and the voice warnings
  "ALTITUDE" and "PULL UP".

**Effects.**

- Gun smoke at the nose; impact flashes, sparks and dust by surface; ricochets.
- Explosions sized by warhead, with a pressure ring, falling debris and a crater decal.
- Vehicle fires, secondary explosions, a thrown turret, and smoke columns that last and can
  be seen from across the range.
- Dust trails, white-phosphorus smoke, engine heat shimmer.
- Cockpit shake while firing, head movement under g, grey-out at sustained high g.

---

## 14. Performance budget

| Item | Budget |
|---|---|
| Frame rate | 60 fps on a mid-range laptop at Medium, 30 fps or more at Low on older hardware |
| Simulation | Under 4 ms per frame for all 120 Hz steps |
| Live rounds | Pool of 1,024 (65 per second, lifetime capped at 8 s) |
| Vehicles | Up to 80 alive |
| Draw calls | Under 300 |
| Triangles | Under 1.2 million on High, under 350,000 on Low |
| Sensor pictures | 512 × 512 at 30 Hz on High, 256 × 256 at 15 Hz on Low; pod and Maverick update on alternate frames |
| Particles | 20,000 on High, 4,000 on Low |
| JavaScript | Under 1.2 MB gzipped (no Rapier) |

The existing automatic downgrade applies: one quality step down when the frame rate stays
under 45 fps for three seconds.

---

## 15. Milestones

| # | Milestone | Deliverables | Est. |
|---|---|---|---|
| **M0** | Foundation | `/a10/` page; shared-engine exports with the carrier's tests green; fixed-step loop, seeded random numbers, state pools; data module and `REFERENCE_DATA.md`; `docs/a10/ARCHITECTURE.md`; test and sandbox harness | 2 days |
| **M1** | Flight model | Aerodynamics, engines, flight controls, trim, flaps, speed brakes, atmosphere and wind, autopilot, warning logic; the checks of section 5 | 4–5 days |
| **M2** | World | Height function, terrain tiles and textures, forests, roads, airbase, haze; terrain collision and line of sight; re-centring | 4–5 days |
| **M3** | Cockpit and HUD | Cockpit, head look and zoom, collimated HUD with flight symbology, armament panel, display frames and page system, map page | 4–5 days |
| **M4** | The gun | Gun mechanics, per-round ballistics, gun sight, PAC, recoil, smoke, impact effects, gun and impact sound; strafe pit with scoring | 5 days |
| **M5** | Targets and damage | Vehicles, armour and component damage, kill states, fire and explosion effects, groups and columns, free hunt, hit log | 5 days |
| | **Core loop complete: fly, find, strafe, destroy** | | **≈5 weeks** |
| **M6** | Stores and unguided weapons | Loadout screen, stores page, weight and drag effects, Mk-82 in CCIP and CCRP, fuzing, blast and fragments, rockets and smoke marks | 5 days |
| **M7** | Targeting pod | Sensor rendering (television and infrared), thermal model, track modes, SOI and SPI logic, laser | 4–5 days |
| **M8** | Guided weapons | Maverick (video, lock logic, guidance), GBU-12, weapon and target cameras | 5–6 days |
| **M9** | Range and debrief | Scored events for every weapon, pass-by-pass debrief with impact plots, scenario options, rearm | 3–4 days |
| **M10** | Feel pass | Sound mix, shake and g effects, warning tones and voice, effects and exterior polish, the remaining gun sights, fly-by camera | 4 days |
| **M11** | Controls and onboarding | Binding screen for sticks and throttles, response curves, realism presets, checklist strip, reduced touch layout | 4 days |
| **M12** | QA and release | Performance pass, browser tests, other browsers, README, deployment | 2 days |

**Total:** about 11 weeks for one developer. M1, M2 and M3 do not depend on each other once
M0's contract exists, and neither do M6, M7 and M8 once M4 and M5 exist, so parallel work
shortens the calendar considerably.

**Later, in rough order of value:** CBU-97 and CBU-87; GBU-38 and laser-guided rockets; runway
take-off, landing and rearming on the ground; night flying with infrared and illumination
flares; threats (anti-aircraft guns and shoulder-launched missiles) with a warning receiver,
flares and damage to your own aircraft; forward-air-controller tasking with smoke marks;
recorded replays.

---

## 16. Testing and validation

The numeric tests are what "close to the real thing" is held to. They run in Vitest without a
browser, against the simulation core.

| Test | Passes when |
|---|---|
| Gun rate | 65 ± 1 rounds in any second at full rate; 47 to 52 in the first second; 1,150 rounds gone in 17.5 to 18.5 s |
| Gun dispersion | 10,000 rounds from a fixed mount: 80 ± 1.5 % inside a 5 mrad circle |
| Trajectory | Without drag, within 0.1 m of the closed-form parabola at 2,000 m. With drag, time of flight and remaining speed at 500, 1,000 and 1,500 m within 2 % of the table frozen in `REFERENCE_DATA.md` |
| Gun sight | Steady 30° dive, 300 kn, 1,220 m slant range, 10 kn crosswind: the centre of the burst is within 1.5 mrad of the pipper |
| Recoil | A two-second burst at 18,000 kg slows the aircraft 3.8 to 4.8 m/s compared with not firing |
| Armour | Roof plate (20 mm): penetrated from a 45° dive at 1,000 m, not from a 10° dive. Side plate (80 mm): never beyond 400 m |
| Bomb CCIP | Mk-82, 30° dive, 300 kn, released 1,500 m above the target: impact within 5 m of the point under the pipper in still air, within 10 m in a 15 kn crosswind |
| Bomb CCRP | Level at 5,000 ft above the target, 300 kn: miss under 10 m |
| Fuze | Released below the arming height: dud. Above it: detonation |
| Blast | Results follow the scaled-distance table in the data module (initial values: a tank needs a hit within a few metres, a truck is destroyed at 30 m) |
| Laser bomb | Laser on for the last 10 s: miss under 3 m. Laser off: it falls as an unguided bomb. Lased from release at maximum range: it falls short |
| Maverick | No lock without line of sight or below the contrast threshold. Stationary tank at 5 nmi: miss under 1 m. Tank crossing at 40 km/h: under 2 m. A launch outside the gimbal limits is refused |
| Rockets | Burn-out speed 739 m/s ± 3 % from a static launch; burn time 1.05 to 1.10 s |
| Flight | The checks of section 5 |
| Determinism | Same seed and input log: identical state after 60 s |

**Browser tests (Playwright).** The page loads and draws. A scripted pilot flies a strafing
pass and the target's state changes. Master Arm at SAFE blocks every release. The display
pages switch. Screenshot comparison of the HUD symbology at fixed states is opt-in, as it is
for the carrier.

**By hand.** Each milestone ends with a short flying checklist that you fly. M10 is a
dedicated session comparing sight, sound and motion with cockpit video of the real aircraft.

---

## 17. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A study-level simulator has no bottom: scope grows without end | The fidelity levels of section 2 and the scope of section 1. The gun and the tanks come first and are complete before anything else starts |
| Public data is thin or contradictory | One data module with sources and confidence marks; tests tied to those numbers; no restricted documents |
| Terrain plus two sensor pictures is heavy for a browser | Quality presets, low sensor resolution and rate, automatic downgrade, the budget of section 14 measured at each milestone |
| A collimated, clipped HUD is technically awkward | Prototype it in a sandbox at the start of M3, before the cockpit is built around it |
| Flight-model tuning eats time | Tune to the short list of section 5 and stop |
| A synthesised GAU-8 does not sound right | Time reserved in M10; the audio layer accepts a recorded sample if one is licensed later |
| The real switch logic is too much for a keyboard | The layout of section 12, mouse-stick mode, the checklist strip and the presets |
| Code-generated aircraft looks crude | The cockpit comes first, because that is where you sit. The exterior is seen in outside views only and can be replaced by a licensed model |
| Targets are too hard to see on a monitor | Zoom view, dust and smoke, map markers by preset, the pod |
| The A-10 work breaks the carrier app | No carrier file moves; a lint rule separates the two; the carrier's tests run in the same CI |

---

## 18. Decisions to confirm

The plan assumes the left column. Each can be changed before M0 at little cost.

| Decision | The plan assumes | Alternative |
|---|---|---|
| Where it lives | A second app in this repository at `/a10/`, sharing the carrier's foundation | Its own repository, taking `src/engine` and `src/a10` along. About one extra day |
| Variant | A-10C: digital cockpit, targeting pod, laser-guided bombs | A-10A: gun, Mavericks on a television monitor, unguided bombs. Drops M7 and half of M8 |
| Enemy fire | None in version 1 | Threats added after M12 |
| Art and sound | Generated in code | A licensed aircraft model and recorded gun audio: more convincing, but they need sourcing and a licence check |
| Devices | Desktop first, a reduced touch layout late | No touch at all, which saves about two days |

---

## 19. Reference data and sources

✓ = the sources agree. ~ = approximate, or the sources differ; treat it as tunable.

These figures were collected through web search summaries. The source pages themselves could
not be opened from the build environment, so M0 checks each one against its page and records
it in `docs/a10/REFERENCE_DATA.md`.

**Aircraft (A-10C)**

| Item | Value | |
|---|---|---|
| Length, span, wing area | 16.26 m, 17.53 m, 47.0 m² | ✓ |
| Empty weight | 11,321 kg (24,959 lb) | ✓ |
| Maximum take-off weight | 22,700 to 23,100 kg (50,000 to 51,000 lb) | ~ |
| Internal fuel | About 4,990 kg (11,000 lb) | ✓ |
| Engines | 2 × TF34-GE-100A, 40.3 kN (9,065 lbf) each | ✓ |
| Maximum speed, clean, sea level | 381 kn (706 km/h) | ✓ |
| Never-exceed speed | 450 kn | ~ |
| Stall speed | About 120 kn at 13,600 kg | ~ |
| Climb rate | About 6,000 ft/min | ~ |
| Load limit | +7.33 g / −3 g clean | ~ |
| External stores | 11 stations, 7,260 kg (16,000 lb) | ✓ |

**GAU-8/A**

| Item | Value | |
|---|---|---|
| Rate of fire | 3,900 rounds/min in the A-10 | ✓ |
| Spin-up | About 0.5 s; about 50 rounds in the first second | ~ |
| Ammunition | 1,174 capacity, 1,150 typical; combat mix 5 API to 1 HEI | ✓ |
| Muzzle velocity | About 1,010 m/s (sources give 1,010 to 1,036) | ~ |
| Projectile mass | API ≈395 g, HEI ≈378 g | ~ |
| Dispersion | 5 mrad, 80 %. The maker states it as a diameter; another common statement, 12 m at 1,220 m, is twice that | ~ |
| Recoil | About 45 kN (10,000 lbf) average | ✓ |
| API penetration | About 69 mm of steel at 500 m, 38 mm at 1,000 m | ~ |
| Gun line | About 2° below the fuselage line | ~ |

**Other weapons**

| Item | Value | |
|---|---|---|
| AGM-65 size | 2.49 m long, 0.30 m diameter, 210 to 304 kg by variant | ✓ |
| AGM-65 warheads | 57 kg shaped charge (D, H); 136 kg penetrator (G, K) | ✓ |
| AGM-65 speed, range | About 1,150 km/h; more than 22 km | ✓ |
| AGM-65 seeker alignment | About 3 minutes (from hobbyist simulator documentation) | ~ |
| AGM-65 lock range on a tank | About 3 to 7 nmi (from hobbyist simulator reports) | ~ |
| Mk 66 rocket motor | 1.05 to 1.10 s burn; 5.9 to 6.3 kN; 739 m/s at burn-out; 6.2 kg | ✓ |
| M151 warhead | 3.9 to 4.2 kg (without or with fuze) | ✓ |
| CBU-97 | 10 BLU-108 submunitions, 40 warheads, about 420 kg | ✓ |
| Laser code | 1688 by default | ~ |
| TF34 spool time | No published figure found; several seconds, typical of high-bypass engines | ~ |
| Targeting-pod fields of view | Not confirmed | ~ |

**T-72-class armour (public estimates, variants differ)**

| Plate | Thickness | |
|---|---|---|
| Hull roof, engine deck | About 20 mm | ~ |
| Hull rear | About 40 mm | ~ |
| Hull side | About 80 mm (70 mm over the engine) | ~ |
| Turret front | 350 mm and more | ~ |

**Sources**

- GAU-8/A: [Wikipedia](https://en.wikipedia.org/wiki/GAU-8_Avenger),
  [General Dynamics OTS brochure](https://www.gd-ots.com/wp-content/uploads/2025/06/400003355-30mm-GAU-8-A-Gatling-Gun-Product-Brochure-2025-06.pdf),
  [FAS](https://man.fas.org/dod-101/sys/ac/equip/gau-8.htm)
- A-10: [Aerospaceweb](https://aerospaceweb.org/aircraft/attack/a10/),
  [Aerocorner](https://aerocorner.com/aircraft/a-10-warthog/),
  [FlightGear wiki, A-10 flight model](https://wiki.flightgear.org/A-10_Thunderbolt_II_FDM)
- AGM-65: [Wikipedia](https://en.wikipedia.org/wiki/AGM-65_Maverick),
  [Designation-Systems](https://designation-systems.net/dusrm/m-65.html),
  [Air & Space Forces](https://www.airandspaceforces.com/weapons/agm-65/)
- Hydra 70: [General Dynamics OTS brochure](https://gd-ots.com/wp-content/uploads/2024/05/400003512-Hydra-70-Product-Brochure-2024-05.pdf),
  [Wikiwand](https://wikiwand.com/en/articles/Hydra_70)
- CBU-97: [Wikipedia](https://en.wikipedia.org/wiki/CBU-97_Sensor_Fuzed_Weapon)
- Targeting pod: [Wikipedia](https://en.wikipedia.org/wiki/AN/AAQ-28_Litening)
- TF34: [Wikipedia](https://en.wikipedia.org/wiki/General_Electric_TF34),
  [GE datasheet](https://www.geaerospace.com/sites/default/files/datasheet-TF34.pdf)
- T-72 armour: [Tankograd blog](https://thesovietarmourblog.blogspot.be/2017/),
  [War Thunder wiki](https://wiki.warthunder.com/T-72A)
- HUD symbology and switch logic (hobbyist simulator documentation):
  [Hoggit wiki, HUD](https://wiki.hoggitworld.com/view/HUD),
  [PAC](https://forum.dcs.world/topic/131382-how-do-i-know-pac-is-working),
  [depressible pipper](https://forum.dcs.world/topic/50118-depressible-pipper-function/),
  [gun line](https://forum.dcs.world/topic/111192-where-is-the-nose-of-the-a10c-pointing),
  [Maverick procedure](https://wikiwiki.jp/dcsa10c/%E3%83%88%E3%83%AC%E3%83%BC%E3%83%8B%E3%83%B3%E3%82%B0/Training-Maverick)

---

## 20. Glossary

| Term | Meaning |
|---|---|
| API, HEI | Armour-piercing incendiary and high-explosive incendiary: the two 30 mm rounds in the combat mix |
| CCIP | Continuously computed impact point: the HUD shows where the weapon would land if released now |
| CCRP | Continuously computed release point: you designate the target, and the computer releases at the right moment |
| DSMS | Digital stores management system: the display page for weapons and their profiles |
| HUD | Head-up display: the glass in front of the pilot with flight and aiming symbols |
| Master Arm | The switch that makes weapon release possible at all |
| mil, mrad | Milliradian: one metre across at a distance of 1,000 m |
| PAC | Precision Attitude Control: the flight controls steady the aircraft while the gun trigger is squeezed |
| Pipper | The aiming dot |
| SOI | Sensor of interest: the display or HUD that the hands-on controls currently act on |
| SPI | Sensor point of interest: the one ground point that all sensors and weapons can be slaved to |
| Slant range | Straight-line distance from the aircraft to the target |
| TAD | Tactical awareness display: the moving map page |
| TGP | Targeting pod: a stabilised camera and laser carried under the wing |
