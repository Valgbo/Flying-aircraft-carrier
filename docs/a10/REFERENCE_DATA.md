# A-10 Simulator — Reference Data

Where the simulator's numbers come from, how sure we are, and how public figures were turned
into model constants. The constants themselves live in `src/a10/data/*.ts`, each with a
`*_NOTES` entry naming its source and confidence; this file explains them. PLAN_A10.md §19 lists
the figures as first collected.

Confidence: **confirmed** (sources agree) · **approximate** (sources differ or are vague;
tunable) · **estimate** (our own value, or fitted to make public figures consistent).

All figures come from public sources: manufacturer brochures, official fact sheets,
encyclopaedias, the GPL FlightGear A-10 package, and hobbyist simulator documentation. No
restricted documents are used.

---

## 1. Sources

The list with URLs is `src/a10/data/sources.ts`. The main ones:

| Id | Source |
|---|---|
| `gdotsGau8` | General Dynamics OTS, 30mm GAU-8/A Gatling gun brochure (2025) |
| `wikiGau8`, `fasGau8` | Wikipedia and FAS pages on the GAU-8/A |
| `aerospaceweb`, `aerocorner`, `wikiA10` | A-10 specifications |
| `flightgearA10`, `flightgearFdm` | The FlightGear A-10 package (GPL v2) and its wiki: geometry, starting coefficients, model, sounds |
| `wikiAgm65`, `designationSystems`, `afAgm65` | AGM-65 Maverick |
| `gdotsHydra`, `wikiHydra` | Hydra 70 rockets |
| `wikiCbu97` | CBU-97 Sensor Fuzed Weapon |
| `wikiLitening` | AN/AAQ-28 Litening targeting pod |
| `wikiTf34`, `geTf34` | TF34 engine |
| `tankograd`, `warThunderT72` | T-72 armour estimates |
| `hoggitHud`, `dcsForumPac`, `dcsForumGunLine`, `dcsMaverick` | Hobbyist simulator documentation of HUD symbology, PAC, gun line, Maverick procedure |

---

## 2. Interpretation decisions

These are fixed in `docs/a10/ARCHITECTURE.md` §5 because several modules depend on them.

### 2.1 Penetration of the 30 mm API round

Public figures: about 69 mm of steel at 500 m and 38 mm at 1,000 m. Read literally as a
function of range, they cannot be reproduced by any physical penetration law with the drag of a
30 mm projectile (the round loses too little speed between 500 and 1,000 m). We therefore fit
`P(v) = P_REF · (v / V_REF)^n` to the IMPACT SPEED, with both points taken as rounds fired from
an aircraft at 300 kn, 1,000 m above sea level (ISA), along the line of fire. `V_REF` and `n`
are computed from the simulator's own ballistic model by a unit test, so the fit stays
consistent if the drag law changes.

Consequences: the plan's attack table (PLAN §6.3) holds for 300 kn attacks; a faster attack
penetrates a little more, a slower one a little less, as physics says.

### 2.2 Dispersion

The maker states "5 mil, 80 %" as a circle DIAMETER. With a circular normal distribution,
80 % inside radius R means R² / (2σ²) = ln 5, so σ = 2.5 mrad / √(2 ln 5) ≈ 1.393 mrad per axis.
The aircraft's own motion during a burst adds to it and is not faked.

### 2.3 Spin-up

"About 50 rounds in the first second" with a linear rate ramp to 65 rounds/s gives a ramp of
≈0.46 s (65 · (1 − T/2) = 50).

### 2.4 Recoil

44.5 kN average at full rate is an impulse of ≈684 N·s per round (projectile momentum
≈400 N·s plus propellant gas). The recoil force is applied along the gun line in proportion to
the instantaneous rate.

---

### 2.5 Conflicts found in the FlightGear package

Analysis of the FlightGear A-10 package (commit 72da115) against the plan's figures:

| Quantity | Package | Plan | Used | Note |
|---|---|---|---|---|
| Combat mix | 4 API : 1 HEI (comment) | 5 API : 1 HEI | 5 : 1 | Both ratios are quoted publicly; settle when a primary source is reachable |
| Muzzle velocity (API) | 3,250 ft/s = 991 m/s | ≈1,010 m/s | 1,013 m/s (3,324 ft/s) | The package's HEI comment gives 1,044 m/s |
| Projectile mass | API 425 g, HEI 360 g | API ≈395 g, HEI ≈378 g | plan | Moves the 1,500 m time of flight by up to 3 % |
| Engine thrust | YASim 18,000 lbf (tuned with its own drag) | 2 × 9,065 lbf | plan | The YASim value is not a real thrust |
| Gun line | 0° (HUD gun cross = boresight); modelled barrel axis 3.0° down | ≈2° down | 2° | The 3-D model's barrel points 3° down |
| Dispersion | ±0.13° uniform (≈4.6 mrad 80 % circle) | 5 mrad diameter, 80 % | plan | Agrees with the diameter reading |
| AGM-65 motor | 5.34 kN × 40 s, marked "guess" | ≈1,150 km/h, > 22 km | plan | The package missile is ≈10 % too fast |

### 2.6 GAU-8/A trajectory (model output, frozen; `data/gun.ts` `GAU8_TRAJECTORY_TABLE`)

Static gun, sea level, ISA, still air, fired level; range = straight-line distance from the
muzzle. Drag = form factor (API and TP 1.0, HEI 1.1) × the G7 standard drag function. The
ballistics test holds the model within 2 % of this table (PLAN §16); its failure message prints
the model's values if the table must be regenerated after a deliberate change.

| Range | API time of flight | API speed | HEI time of flight | HEI speed |
|---|---|---|---|---|
| 500 m | 0.529 s | 881 m/s | 0.522 s | 884 m/s |
| 1,000 m | 1.141 s | 758 m/s | 1.140 s | 743 m/s |
| 1,500 m | 1.856 s | 645 m/s | 1.880 s | 615 m/s |

1,220 m (4,000 ft): 1.44 s. Penetration fit (§2.1): `V_REF` = 1,042.84 m/s (the impact speed
at 500 m), exponent 4.8603, for 300 kn, 1,000 m above sea level, ISA.

### 2.7 Light armour and trucks (`data/vehicles.ts`)

Millimetres of rolled homogeneous armour (RHA) or its steel equivalent; slopes come from the
vehicle shapes the renderer draws.

| Vehicle | Front | Side | Rear | Roof | Turret front / side |
|---|---|---|---|---|---|
| T-72 class | glacis ≈200 equivalent (composite), lower front 85 | 80 (70 over the engine) | 40 | 20 (engine deck 20) | ≈350 / 130 |
| BMP class | 7 upper glacis at ≈80°, 19 lower | 16 upper, 18 lower | 16 | 6 | 23 / 15 |
| BTR class | 10 | 7 upper, 9 lower | 7 | 7 | 10 / 7 |
| Trucks | sheet metal 1–3 mm; canvas 0.3; tanker shell 3; stacked ammunition crates ≈2.5 | | | | |

### 2.8 Blast and fragments (`data/vehicles.ts` `BLAST`, `BLAST_THRESHOLDS`, `FRAGMENTS`)

Blast damage uses the scaled distance Z = R / W^(1/3) (R in m to the vehicle's nearest
surface, W in kg TNT equivalent) and, at each level, a minimum impulse at the vehicle's
centre, so that a small charge (a 30 mm HEI round, a rocket) only hurts nearby parts. The
impulse follows a power law fitted to the hemispherical surface-burst curves of UFC 3-340-02
(Kingery–Bulmash). A dug-in vehicle feels the blast as if 1.5 × farther away.

| Vehicle | Catastrophic | Destroyed | Heavy | Light |
|---|---|---|---|---|
| Tank | Z ≤ 0.45 | Z ≤ 0.9 | Z ≤ 1.6 | Z ≤ 3.0 |
| IFV | Z ≤ 0.7 | Z ≤ 2.2 | Z ≤ 3.2 | Z ≤ 5.0 |
| APC | Z ≤ 0.6 | Z ≤ 2.4 | Z ≤ 3.5 | Z ≤ 5.5 |
| Trucks | fuel and ammunition trucks Z ≤ 1.2 | Z ≤ 7.0 | Z ≤ 9.5 | Z ≤ 14 |

For a Mk-82 (87 kg Tritonal ≈ 96 kg TNT, W^(1/3) ≈ 4.6) this gives: a tank destroyed within
about 4 m, a mobility kill at 6 m, nothing at 16 m; an IFV or APC destroyed within about 10 m;
a truck destroyed within 30 m and only lightly damaged at 60 m.

Fragments: a statistical model. Masses follow Mott's distribution N(>m) = N₀·exp(−√(m/μ))
(μ ≈ 3.5 g for the Mk-82's case, scaling with √(case mass)); launch speed from the Gurney
equation (√(2E) = 2.44 km/s for TNT), slowed by drag. The number reaching a vehicle is
N × presented area / 4πR² (half go into the ground), drawn from a Poisson distribution; each is
traced to the plate facing the burst and compared with that plate's effective thickness
(4.2 mm of RHA for a 1 g fragment at 1,000 m/s, growing with v^1.5).

## 3. Measured model values

Filled in from the modules' acceptance tests at each integration (see `tests/unit/a10/`).

| Quantity | Target (plan) | Model | Test |
|---|---|---|---|
| Max level speed, clean, sea level | 381 kn ± 3 % | 380.5 kn (14,947 kg) | flight |
| Stall speed, clean, 13,600 kg | 120 kn ± 5 % | 117.8 kn (C<sub>L max</sub> 1.249; V at C<sub>L max</sub>/√n) | flight |
| Initial climb rate | ≈6,000 ft/min ± 10 % | 5,706 ft/min at 220 KIAS (≈15,200 kg) | flight |
| Gun rate | 65 ± 1 rds/s; 47–52 in the first second | 64–65 rds/s; 50 in the first second; 1,150 rounds in 17.9 s | gun |
| Dispersion | 80 ± 1.5 % inside 5 mrad | 80.46 % of 10,000 rounds | gun |
| Recoil, 2 s burst at 18,000 kg | 3.8–4.8 m/s | 4.37 m/s from the gun's summed recoil (115 rounds, 78.7 kN·s); 4.10 m/s flown with the flight model | gun / flight |
| Gun sight agreement | burst centre within 1.5 mrad of the pipper | — | avionics |
| Full aft stick, 300 kn, sea level | ≥ +7.33 g at 13,600 kg | 7.76 g at 13,600 kg; 7.22 g at 15,206 kg | flight |
| Roll rate, 300 kn, full stick | ≈90–140 °/s | 124 °/s | flight |
| Sustained level turn, 300 kn, sea level, MAX | plausible | 10.3 °/s (71° bank, 3.06 g) | flight |
| Engine spool, idle → 95 % thrust | 4–8 s | 6.51 s | flight |
| Static thrust per engine | 40.3 kN | 40.32 kN | flight |
| Overspeed (Vne 450 kn) | warning and buffet above | warning on at 460 kn, off at 440 kn | flight |
| Dive recovery from 300 kn, 30°, 4 g once reached | ≈105 m (closed form) | 82.6 m vs 84.8 m closed form from the same state; 143.7 m including the g onset | flight |
| PAC-1, 30° dive, 300 kn, turbulence 0.6 | large reduction of pipper motion | RMS pipper rate 18.4 → 2.2 mrad/s | flight |
| Trimmed straight and level, hands off 60 s | ± 30 m | 5.8 m | flight |
| Time of flight to 1,220 m, static gun, sea level | 1.3–1.5 s | 1.44 s (707 m/s left) | ballistics |
| Trajectory vs the frozen table (§2.6) | within 2 % | < 0.1 % | ballistics |
| Gun-line predictor vs a live round | same model | < 1 cm, < 1 ms | ballistics |
| T-72 roof (20 mm), 45° dive, 1,000 m | penetrated | 37.5 mm against 28.2 mm effective | armour |
| T-72 roof, 30° dive | fails at 1,200 m, works inside ≈950 m | crossover 958 m | armour |
| T-72 rear (40 mm), 10° pass | penetrated inside ≈950 m | crossover 943 m | armour |
| T-72 side (80 mm) | never beyond 400 m | crossover 369 m | armour |
| T-72 front | never | 0 of 120 rounds at 200–400 m | armour |
| IFV and APC at 1,500 m | penetrated from any side | ≥ 90 % on the hull plates | armour |
| Mk-82 blast against a tank / truck | a few metres / 30 m | destroyed within ≈4 m, nothing at 16 m / destroyed within 30 m | damage |
| Strafing pass on a tank, flight model and real gun | the target's state changes | 46 of 50 rounds on the tank, 26 API penetrations, catastrophic | targets |
