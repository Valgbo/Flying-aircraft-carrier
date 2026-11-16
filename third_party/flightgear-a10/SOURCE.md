# FlightGear A-10: original files

The files in this folder are unchanged copies of files from the FlightGear A-10 aircraft
package. They are the editable source of the converted models, textures and data under
`public/a10/models/` and `public/a10/textures/`, which the GPL requires to stay available, and
they make the conversion repeatable.

| | |
|---|---|
| Source | <https://github.com/l0k1/A-10> |
| Commit | `72da115` ("Auto-Update Shared Files"), inspected on 2026-11-15 |
| Licence | GNU General Public License version 2 (`COPYING`, from the package). Some files of the package say "version 2 or later". |
| Authors (package README) | Lee Elliott (initial developer), Alexis Bory (weapon systems, models, main developer 2007+), David Bastien (fuel and engine systems), Pinto (OPRF compatibility, multiplayer damage, bug fixes), Rudolf (Emesary damage system), JMaverick16 (tactical systems, updates, liveries), Zorka, SammySkycrafts (main developer 2021+, weapon and tactical system overhaul, 3D work) |
| Package documentation | `README.md`, `A-10-readme.txt`, `COPYING` (copied unchanged) |

## What is here and how it is used

`FILES.txt` lists every file the converter read; each one is copied here byte for byte, at the
same relative path as in the package. `Sounds/` is kept by the audio module (see its own notes).

| Package files | Used for |
|---|---|
| `Models/A10-004-015l3.ac`, `Models/A-10-model.xml` | The exterior: geometry, the animations of every moving part (pivots), the sub-model includes and their offsets |
| `Models/Cockpit/*.xml`, `Models/Cockpit/*.ac`, `Models/Cockpit/RWR/*` | The cockpit: tub (`detail-cpt.ac`), side consoles (`cockpit.ac`), every instrument placed with its offsets, the MPCD (`mpcd.ac`) |
| `Models/pilot.xml`, `Models/pilot.ac` | Pilot and ejection seat |
| `Models/Stores/loads.xml`, `Models/Stores/loads_models.xml`, `Models/Stores/{Weapons,Racks,Ext-Stores}/**` | Weapon, rack and pod models, and where FlightGear hangs each one on each station |
| `Models/*.png`, `Models/Cockpit/*.png`, `Models/Stores/**/*.png`, `Models/Liveries/*` | Textures and three paint schemes |
| `A-10-base.xml` | The cockpit eye point and default view (view 0) |
| `A-10-submodels.xml` | The gun's FlightGear spawn point (for comparison with the modelled muzzle) |

## How it was converted

`node scripts/a10/convert-ac3d.mjs` (run with `--import <checkout>` to refresh these copies from a
checkout of the package). The converter is our own code; nothing from the package is executed
(Nasal scripts and bindings are read as text only). It:

- reads the AC3D files (cumulative `loc`, materials, crease smoothing, ear-clipping of non-convex
  and non-planar polygons) and the model XMLs (sub-model `<offsets>`, every `<animation>`);
- converts to our frame: `X = −z_ac`, `Y = y_ac − 0.30`, `Z = x_ac − 7.65` (metres; +X right
  wing, +Y up, −Z nose; origin 25 % of the model wing's mean aerodynamic chord);
- wraps every animated part in a pivot node on its hinge (`<target>__<channel>`), as FlightGear
  nests its animation transforms; adds a spin pivot for the gun barrels (no FlightGear animation);
- merges static parts per material, freezes the cockpit panels the simulation does not drive,
  simplifies the 56 screw heads and one 5,000-triangle knob of the side consoles, builds the
  altimeter (its model is in FGData, not in the package), the GBU-12 Paveway II kit on the Mk 82
  body and the LAU-117 launcher in code;
- writes glTF binary files with quantized geometry (`KHR_mesh_quantization`), re-encodes the
  textures (JPEG, PNG where alpha is used), packs the cockpit textures into atlas pages, and
  writes `a10-meta.json` (hinges, toggles, eye point, HUD glass, displays, stations and store
  placements, gun, lights, gear contacts, clickable controls).

`CREDITS.md` at the repository root lists every generated file with its sources and changes.

Known data quirks of the package, handled or noted by the converter: the right flaps are driven
by `left-flap-pos-norm`; `UC-Right-DoorLower` is missing from the livery list;
`UC-LeftMainTop-details.001` does not exist; `MXU-648.ac` and `CBU-87.ac` are truncated (fewer kids
than declared); `lights-external.xml` swaps two halo names and writes an offset as "3,075"
(not converted); `pylons.nas` gives station 11 an x of 7.38 m and station 6 a z of 0 (not used:
stations are measured on the pylon geometry).
