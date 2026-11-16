/**
 * Credits shown on the credits screen. OWNED BY THE UI MODULE.
 *
 * This list MUST MIRROR CREDITS.md (PLAN_A10.md §3.1): every third-party source credited there
 * appears here with the same authors, source and licence. tests/unit/a10/ui-credits.test.ts
 * checks the authors and source URLs against CREDITS.md whenever that file exists.
 */

export interface CreditSource {
  label: string;
  url: string;
}

export interface CreditEntry {
  /** What it is, e.g. 'FlightGear A-10'. */
  title: string;
  /** What this project uses from it. */
  used: string;
  authors: readonly string[];
  licence: string;
  source: CreditSource;
  /** How it was taken and changed. */
  note?: string;
}

export const PROJECT_LICENCE = {
  copyright: 'Copyright the Flying Aircraft Carrier and A-10 simulator contributors.',
  spdx: 'GPL-2.0-or-later',
  name: 'GNU General Public License, version 2 or (at your option) any later version',
  summary:
    'Anyone may use, change and share this simulator, and must pass their changes on under the same licence.',
  noWarranty: 'It comes with no warranty of any kind.',
  text: {
    label: 'GPL version 2 on gnu.org',
    url: 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html',
  },
} as const;

export const THIRD_PARTY: readonly CreditEntry[] = [
  {
    title: 'FlightGear A-10',
    used: 'Aircraft exterior, cockpit, pilot, weapons and pods, and the aircraft sounds',
    authors: [
      'Lee Elliott',
      'Alexis Bory',
      'David Bastien',
      'Pinto',
      'Rudolf',
      'JMaverick16',
      'Zorka',
      'SammySkycrafts',
    ],
    licence: 'GNU GPL version 2 (some files "or later")',
    source: { label: 'github.com/l0k1/A-10', url: 'https://github.com/l0k1/A-10' },
    note: 'Taken at commit 72da115 (15 November 2026) and converted to glTF by scripts/a10/convert-ac3d.mjs, without editing by hand; a few parts the package lacks (the LAU-117 launcher, the GBU-12 guidance kit, the altimeter) are built in code by this project. The original files are kept unchanged under third_party/flightgear-a10/.',
  },
];

/** Libraries the simulator runs on, with their licences (all compatible with the GPL). */
export const SOFTWARE: readonly { name: string; licence: string; url: string }[] = [
  { name: 'React', licence: 'MIT', url: 'https://react.dev' },
  { name: 'three.js', licence: 'MIT', url: 'https://threejs.org' },
  { name: 'React Three Fiber', licence: 'MIT', url: 'https://github.com/pmndrs/react-three-fiber' },
  { name: 'postprocessing', licence: 'Zlib', url: 'https://github.com/pmndrs/postprocessing' },
  { name: 'Zustand', licence: 'MIT', url: 'https://github.com/pmndrs/zustand' },
];

export const ORIGINAL_WORK =
  'The simulation, terrain, vehicles, effects, display pages and this interface are original work of this project. Nothing is taken from a commercial game.';
