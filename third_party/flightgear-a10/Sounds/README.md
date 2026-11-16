# FlightGear A-10 sounds (originals, unchanged)

These are the original sound files of the FlightGear A-10, copied byte for byte from

- repository: <https://github.com/l0k1/A-10>, folder `Sounds/`
- commit: `72da115` (15 November 2026)
- licence: GNU General Public License version 2 (the package's `COPYING`; the sound files carry
  no notice of their own). Authors: the FlightGear A-10 contributors, as the package README
  credits them: Lee Elliott, Alexis Bory, David Bastien, Pinto, Rudolf, JMaverick16, Zorka and
  SammySkycrafts.

They are kept here because the GPL asks for the editable form to stay available, and so that
the conversion is repeatable. `scripts/a10/sounds.mjs` checks each file against its SHA-256 and
turns them into the web-ready files in `public/a10/sounds/` (what was changed is listed per
file in `scripts/a10/sounds-credits.json` and in `CREDITS.md`).

| Original | Used for |
|---|---|
| `gau-8.wav` | the GAU-8/A firing loop (`gun-loop.wav`) |
| `fan2.wav` | TF34 fan, outside (`engine-fan.wav`) |
| `fan3.wav` | TF34 fan heard in the cockpit (`engine-fan-inside.wav`) |
| `whine.wav` | TF34 high whine (`engine-whine.wav`) |
| `whine2.wav` | TF34 core whine (`engine-whine-low.wav`) |
| `jet.wav` | TF34 exhaust roar (`engine-jet.wav`) |
| `wind.wav` | airflow over the canopy (`wind.wav`) |
| `stall-600-continue.wav` | steady stall tone (`stall-steady.wav`) |
| `stall-600-chopped.wav` | chopped stall tone (`stall-chopped.wav`) |
| `altitude.wav` | "ALTITUDE, ALTITUDE" voice (`altitude.wav`) |
| `bomb_release.wav` | store release clunk (`bomb-release.wav`) |
| `click.wav`, `click2.wav` | cockpit switches (`click.wav`, `click2.wav`) |

To refresh them from a FlightGear checkout: `node scripts/a10/sounds.mjs --from <checkout>`.
