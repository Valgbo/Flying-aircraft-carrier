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
| Muzzle velocity (API) | 3,250 ft/s = 991 m/s | ≈1,010 m/s | 1,010 m/s | The package's HEI comment gives 1,044 m/s |
| Projectile mass | API 425 g, HEI 360 g | API ≈395 g, HEI ≈378 g | plan | Moves the 1,500 m time of flight by up to 3 % |
| Engine thrust | YASim 18,000 lbf (tuned with its own drag) | 2 × 9,065 lbf | plan | The YASim value is not a real thrust |
| Gun line | 0° (HUD gun cross = boresight); modelled barrel axis 3.0° down | ≈2° down | 2° | The 3-D model's barrel points 3° down |
| Dispersion | ±0.13° uniform (≈4.6 mrad 80 % circle) | 5 mrad diameter, 80 % | plan | Agrees with the diameter reading |
| AGM-65 motor | 5.34 kN × 40 s, marked "guess" | ≈1,150 km/h, > 22 km | plan | The package missile is ≈10 % too fast |

## 3. Measured model values

Filled in from the modules' acceptance tests at each integration (see `tests/unit/a10/`).

| Quantity | Target (plan) | Model | Test |
|---|---|---|---|
| Max level speed, clean, sea level | 381 kn ± 3 % | 380.5 kn (14,947 kg) | flight |
| Stall speed, clean, 13,600 kg | 120 kn ± 5 % | 117.8 kn (C<sub>L max</sub> 1.249; V at C<sub>L max</sub>/√n) | flight |
| Initial climb rate | ≈6,000 ft/min ± 10 % | 5,706 ft/min at 220 KIAS (≈15,200 kg) | flight |
| Gun rate | 65 ± 1 rds/s; 47–52 in the first second | — | gun |
| Dispersion | 80 ± 1.5 % inside 5 mrad | — | gun |
| Recoil, 2 s burst at 18,000 kg | 3.8–4.8 m/s | 4.80 m/s for ∓44.5 kN along the gun line (flight); the gun's own burst: — | gun / flight |
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
