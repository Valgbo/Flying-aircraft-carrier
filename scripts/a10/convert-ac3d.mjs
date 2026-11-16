#!/usr/bin/env node
/**
 * AC3D → glTF converter for the FlightGear A-10 (PLAN_A10.md §3.1, docs/a10/ARCHITECTURE.md §9).
 *
 *   node scripts/a10/convert-ac3d.mjs                 convert from third_party/flightgear-a10
 *   node scripts/a10/convert-ac3d.mjs --import <dir>  convert from a checkout of the FlightGear
 *                                                     A-10 package (github.com/l0k1/A-10) and copy
 *                                                     every original file it read, unchanged, into
 *                                                     third_party/flightgear-a10/
 *
 * Writes public/a10/models/{a10-exterior,a10-cockpit,a10-pilot}.glb, models/stores/*.glb,
 * models/a10-meta.json and public/a10/textures/*. Nothing in the package is executed.
 *
 * Requirements: Node 20+, the `three` package (math and ShapeUtils only), and ImageMagick 6
 * (`convert`, `identify`) on the PATH for the textures (JPEG for opaque, PNG where alpha is used).
 *
 * Frames: the AC files use x aft, y up, z left; FlightGear's model frame is x aft, y right, z up;
 * our BODY frame is +X right, +Y up, +Z aft (nose −Z) with its origin at R = FG (7.65, 0, 0.30):
 *   X = −z_ac, Y = y_ac − 0.30, Z = x_ac − 7.65.
 * Stores keep the BODY axes with their origin at the suspension lugs (top of the lugs).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import {
  FG_TO_BODY,
  FG_TO_BODY_AXES,
  applyPoint,
  compose,
  normalize3,
  offsetsTransform,
  rotateAbout,
} from './convert-lib-geom.mjs';
import { buildAltimeter, buildGbu12Kit, buildLau117 } from './convert-lib-build.mjs';
import { planGLB, round3, safeName, writeGLB } from './convert-lib-emit.mjs';
import {
  SourceTree,
  acTreeToNodes,
  appendChild,
  findByName,
  loadAC,
  loadModel,
  makeNode,
  walk,
} from './convert-lib-scene.mjs';
import { alphaStats, encodeImage, readAlpha } from './convert-lib-tex.mjs';
import { atlasPlan, buildPage, slotSize, textureDemand } from './convert-lib-atlas.mjs';
import { all, child, num, parseXml, text } from './convert-lib-xml.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const THIRD = join(REPO, 'third_party/flightgear-a10');
const OUT_MODELS = join(REPO, 'public/a10/models');
const OUT_TEX = join(REPO, 'public/a10/textures');
const GENERATOR = 'scripts/a10/convert-ac3d.mjs (FlightGear A-10 @ 72da115, GPL)';
const SOURCE = {
  repository: 'https://github.com/l0k1/A-10',
  commit: '72da115',
  date: '2026-11-15',
  licence: 'GPL-2.0-or-later (package COPYING: GPL version 2; some files say "or later")',
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
};
const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// command line
// ---------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = { import: null, verbose: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--import') opt.import = resolve(argv[++i]);
  else if (argv[i] === '--verbose') opt.verbose = true;
  else if (argv[i] === '--help') {
    console.log('usage: node scripts/a10/convert-ac3d.mjs [--import <FlightGear A-10 dir>] [--verbose]');
    process.exit(0);
  } else throw new Error(`unknown argument ${argv[i]}`);
}
const SRC_ROOT = opt.import ?? THIRD;
const src = new SourceTree(SRC_ROOT);
const warnings = [];
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------------------------
// what is converted, and how
// ---------------------------------------------------------------------------------------------
const SKIP_MODELS = new Map([
  ['Models/Stores/loads.xml', 'stores: converted one by one (stores/*.glb), placed from loads_models.xml'],
  ['Models/Effects/landing-light.xml', 'light effect, no geometry'],
  ['Models/Effects/taxi-light.xml', 'light effect, no geometry'],
  ['Models/Cockpit/A-10-hud.xml', 'legacy 3-D HUD symbols: the HUD module draws the HUD'],
  ['Models/lights-external.xml', 'light halos: the aircraft view draws its own lights'],
  ['Models/lights-internal.xml', 'cockpit flood-light halos'],
]);

/** Textures replaced at run time (render targets, environment map) or placeholders. */
const DISPLAY_TEXTURES = new Map([
  ['A-10-video-screen.png', 'tv'],
  ['mpcd_canvas.png', 'mpcd'],
  ['hud_canvas.png', 'hud'],
  ['arc-164-canvas.png', 'uhf'],
  ['CMSCcanvas.png', 'cmsc'],
]);

/** Toggles we do not reproduce (ejection, renderer choice). */
const IGNORED_TOGGLE = /A-10\/done|rembrandt/;

const ctx = {
  warn: (m) => warnings.push(m),
  defaultProps: {},
  anims: [],
  skipModel: (rel) => SKIP_MODELS.get(rel) ?? null,
  standIn: (rel) => (rel === 'Models/Cockpit/altimeter.xml' ? buildAltimeter() : null),
  filterObject: () => true,
};

// ---------------------------------------------------------------------------------------------
// assemble the aircraft exactly as FlightGear does
// ---------------------------------------------------------------------------------------------
log(`source: ${SRC_ROOT}`);
const aircraft = loadModel(src, 'Models/A-10-model.xml', FG_TO_BODY, ctx, 'A-10');
for (const n of walk(aircraft)) n.toggles = n.toggles.filter((t) => !IGNORED_TOGGLE.test(t.cond));

let exteriorRoots = aircraft.children.filter((c) => c.kind !== 'model');
const pilotModel = aircraft.children.find((c) => c.kind === 'model' && c.file === 'Models/pilot.xml');
const cockpitModels = aircraft.children.filter((c) => c.kind === 'model' && c.file.startsWith('Models/Cockpit/'));

// inner canopy glass: shown only from the seat (FlightGear draws both and blends twice)
for (const nm of ['FCanopyGlass-int', 'BCanopyGlass-int'])
  for (const n of findByName({ children: exteriorRoots, name: '' }, nm))
    n.toggles.push({ file: 'convert-ac3d.mjs', line: 0, type: 'select', cond: 'insideOnly', default: false });

// ---------------------------------------------------------------------------------------------
// cockpit sub-models whose animations we keep. The others are FROZEN: every pivot is baked at the
// default property value and every toggle at its default visibility, so their geometry joins the
// static mesh (the FlightGear animations stay listed in the meta file under cockpit.frozen).
// To bring one to life, add its XML here and run the converter again.
// ---------------------------------------------------------------------------------------------
const LIVE_COCKPIT = new Set(
  [
    'stick',
    'pedals',
    'A-10-throttle',
    'A-10-asi',
    'altimeter',
    'A-10-vsi-6kfpm',
    'A-10-adi',
    'stdby-adi',
    'A-10-HSI',
    'A-10-AoA-gauge',
    'A-10-accel',
    'A-10-chronometer',
    'mag-compass',
    'A-10-engines-gauges',
    'A-10-fuel-gauges',
    'A-10-armament-panel',
    'A-10-ld-gear-panel',
    'A-10-master-caution',
    'A-10-aoa-indexer',
    'A-10-central-up-warning',
    'A-10-hud-panel',
    'mpcd',
    'A-10-detail-cpt',
  ].map((b) => `Models/Cockpit/${b}.xml`),
);
const frozen = [];
function freezeModel(model) {
  const bake = (n, M) => {
    let M2 = M;
    if (n.kind === 'pivot') {
      const pv = n.pivot;
      const v = fgDrive(pv, 0);
      const T =
        pv.type === 'translate'
          ? { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: pv.axis.map((a) => a * v) }
          : pv.type === 'rotate'
            ? rotateAbout(pv.centre, pv.axis, v)
            : null;
      if (T) M2 = compose(M, T);
      frozen.push({ model: model.file, targets: n.targets, type: pv.fgType, property: pv.property, src: `${pv.file}:${pv.line}` });
    }
    if (n.geom && M2 !== M0) transformGeometry(n.geom, M2);
    for (const c of [...n.children]) bake(c, M2);
  };
  const M0 = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  bake(model, M0);
  for (const n of [...walk(model)]) {
    if (n.kind === 'pivot') {
      const parent = n.parent;
      const i = parent.children.indexOf(n);
      for (const c of [...n.children]) appendChild(parent, c);
      parent.children.splice(parent.children.indexOf(n), 1);
      void i;
    }
  }
  for (const n of walk(model)) {
    if (n.toggles.length) {
      const visible = n.toggles.every((t) => t.default);
      if (!visible) for (const d of walk(n)) d.excluded = true;
      n.toggles = [];
    }
    n.uvAnims = [];
  }
  model.frozen = true;
}
function transformGeometry(g, M) {
  const p = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const grp of g.groups.values()) {
    for (let i = 0; i < grp.pos.length; i += 3) {
      applyPoint(M, grp.pos[i], grp.pos[i + 1], grp.pos[i + 2], p);
      grp.pos[i] = p[0];
      grp.pos[i + 1] = p[1];
      grp.pos[i + 2] = p[2];
      for (let c = 0; c < 3; c++) ((min[c] = Math.min(min[c], p[c])), (max[c] = Math.max(max[c], p[c])));
      const nx = grp.nrm[i];
      const ny = grp.nrm[i + 1];
      const nz = grp.nrm[i + 2];
      grp.nrm[i] = M.R[0] * nx + M.R[1] * ny + M.R[2] * nz;
      grp.nrm[i + 1] = M.R[3] * nx + M.R[4] * ny + M.R[5] * nz;
      grp.nrm[i + 2] = M.R[6] * nx + M.R[7] * ny + M.R[8] * nz;
    }
  }
  if (Number.isFinite(min[0])) g.bbox = { min, max };
  g.centroid = applyPoint(M, ...g.centroid);
}
for (const m of cockpitModels) if (!LIVE_COCKPIT.has(m.file)) freezeModel(m);

// ---------------------------------------------------------------------------------------------
// per-file options
// ---------------------------------------------------------------------------------------------
const LIGHTS = new Map([
  ['L-NavLight', 'navLeft'],
  ['R-NavLight', 'navRight'],
  ['TopLightLens', 'top'],
  ['Aft-StrobeLight-off', 'tail'],
  ['L-StrobeLight-off', 'strobeLeft'],
  ['R-StrobeLight-off', 'strobeRight'],
  ['FuseTailBottom-Formation', 'formation'],
  ['FuseTailTop-Formation', 'formation'],
  ['FuseTop-Formation', 'formation'],
  ['FuseSideL-Formation', 'formation'],
  ['FuseSideR-Formation', 'formation'],
  ['WingL-Formation', 'formation'],
  ['WingR-Formation', 'formation'],
  ['TailEmpL-Formation', 'formation'],
  ['TailEmpR-Formation', 'formation'],
]);
const exteriorOptions = {
  glass: new Set(['FCanopyGlass', 'BCanopyGlass', 'FCanopyGlass-int', 'BCanopyGlass-int']),
  // nose-gear lamp "on" variants: the lamps stay dark (lights are drawn as sprites at night)
  hidePattern: /-light-on$/,
};
for (const n of walk({ children: exteriorRoots, name: '' }))
  if (/-light-(on|off)$/.test(n.name)) n.toggles = [];
const cockpitDisplay = new Map();
const cockpitSimplify = new Map();
for (const m of cockpitModels)
  for (const n of walk(m)) {
    if (n.kind !== 'object' || !n.texture) continue;
    const base = posix.basename(n.texture);
    if (DISPLAY_TEXTURES.has(base)) cockpitDisplay.set(n.name, DISPLAY_TEXTURES.get(base));
  }
for (const m of cockpitModels)
  for (const n of walk(m)) {
    if (n.kind !== 'object' || !n.geom) continue;
    // 56 screw heads of ≈260 triangles each and a 5,000-triangle knob: cluster to ≈2 mm
    if (/screw/i.test(n.name) && n.geom.triangles > 60) cockpitSimplify.set(n.name, 0.0022);
    if (n.name === 'CMSP_KNOB_MODE') cockpitSimplify.set(n.name, 0.0018);
  }
const cockpitOptions = {
  display: cockpitDisplay,
  hide: new Set(['hud-screen']), // FlightGear's HUD canvas quad: our HUD is drawn in its own pass
  simplify: cockpitSimplify,
  glass: new Set(['CPT-hud-screen']),
};

// ---------------------------------------------------------------------------------------------
// channel names for pivots: <target>__<channel>
// ---------------------------------------------------------------------------------------------
function channelOf(n) {
  const pv = n.pivot;
  const prop = pv.property ?? '';
  const t = n.targets[0] ?? '';
  if (/aileron-pos-norm/.test(prop)) return 'aileron';
  if (/spoiler-pos-norm/.test(prop)) return 'speedbrake';
  if (/elevator-pos-norm/.test(prop)) return 'elevator';
  if (/rudder-pos-norm/.test(prop)) return /^UC-Nose/.test(t) ? 'steer' : 'rudder';
  if (/flap-pos-norm/.test(prop) && /Flap/.test(t)) return pv.type === 'translate' ? 'flaptravel' : 'flap';
  if (/alpha-deg/.test(prop) && /Slat/.test(t)) return 'slat';
  if (prop === 'canopy/position-norm') return 'canopy';
  if (/^gear\/gear(\[\d\])?\/position-norm/.test(prop)) return 'retract';
  if (/^gear\/gear(\[\d\])?\/compression-norm/.test(prop)) return 'compress';
  if (/^gear\/gear(\[\d\])?\/rollspeed-ms/.test(prop)) return 'wheel';
  if (/engines\/engine\[\d\]\/n1/.test(prop) && /Fan/.test(t)) return 'fan';
  if (n.custom) return n.custom;
  if (prop) return prop.split('/').pop().replace(/\[(\d+)\]/g, '$1');
  return pv.fgType;
}

// ---------------------------------------------------------------------------------------------
// the gun barrels: FlightGear has no animation for them; add a spin pivot on the cluster axis
// (front clamp ring centre, measured on the model: FG (−0.133, −0.0489, −0.297), axis 3.0° down)
// ---------------------------------------------------------------------------------------------
const GUN = {
  clusterCentre: [-0.0489, -0.597, -7.783],
  axis: normalize3([0, -0.0521, -0.9986]),
};
{
  const cannons = findByName({ children: exteriorRoots, name: '' }, 'Cannon');
  for (const c of cannons) {
    const p = makeNode('pivot', '', {
      pivot: {
        type: 'rotate',
        fgType: 'rotate',
        axis: GUN.axis,
        centre: GUN.clusterCentre,
        property: null,
        gain: 1,
        offsetSI: 0,
        file: 'convert-ac3d.mjs',
        line: 0,
      },
      targets: ['Cannon'],
      custom: 'spin',
    });
    const parent = c.parent;
    appendChild(parent ?? aircraft, p);
    appendChild(p, c);
  }
  exteriorRoots = aircraft.children.filter((c) => c.kind !== 'model');
}

// ---------------------------------------------------------------------------------------------
// textures
// ---------------------------------------------------------------------------------------------
const texInfo = new Map(); // rel → info
const texIds = new Map(); // id → rel
function textureInfo(rel) {
  if (texInfo.has(rel)) return texInfo.get(rel);
  if (rel && DISPLAY_TEXTURES.has(posix.basename(rel))) {
    texInfo.set(rel, null);
    return null;
  }
  if (!rel || !src.exists(rel)) {
    if (rel) warnings.push(`missing texture ${rel}`);
    texInfo.set(rel, null);
    return null;
  }
  const base = posix.basename(rel);
  src.used.add(rel);
  let id = safeName(base.replace(/\.[a-z]+$/i, '').toLowerCase());
  if (texIds.has(id) && texIds.get(id) !== rel) id = safeName(`${posix.basename(posix.dirname(rel))}-${id}`.toLowerCase());
  texIds.set(id, rel);
  const img = readAlpha(src.abs(rel));
  const stats = alphaStats(img);
  const info = { rel, out: id, ...img, stats, blendable: stats.partial > 0.05 };
  texInfo.set(rel, info);
  return info;
}

// ---------------------------------------------------------------------------------------------
// plan the aircraft files
// ---------------------------------------------------------------------------------------------
const plans = [];
const exteriorPlan = planGLB({
  name: 'a10-exterior',
  roots: exteriorRoots,
  channelOf,
  textureInfo,
  options: exteriorOptions,
});
plans.push({ plan: exteriorPlan, file: 'a10-exterior.glb', group: 'aircraft' });
const cockpitPlan = planGLB({
  name: 'a10-cockpit',
  roots: cockpitModels,
  channelOf,
  textureInfo,
  options: cockpitOptions,
});
plans.push({ plan: cockpitPlan, file: 'a10-cockpit.glb', group: 'aircraft' });
const pilotPlan = planGLB({ name: 'a10-pilot', roots: [pilotModel], channelOf, textureInfo, options: {} });
plans.push({ plan: pilotPlan, file: 'a10-pilot.glb', group: 'aircraft' });

// ---------------------------------------------------------------------------------------------
// stores: each in its own frame (BODY axes, origin at the top of the suspension lugs)
// ---------------------------------------------------------------------------------------------
const STORES = [
  { id: 'mk82', label: 'Mk 82 low-drag bomb', ac: 'Models/Stores/Weapons/MK-82/MK-82.ac', xml: 'Models/Stores/Weapons/MK-82/MK-82.xml' },
  { id: 'mk82air', label: 'Mk 82 AIR (BSU-49 ballute) bomb', xml: 'Models/Stores/Weapons/MK-82AIR/MK-82AIR.xml', ac: 'Models/Stores/Weapons/MK-82AIR/MK-82AIR.ac' },
  { id: 'mk84', label: 'Mk 84 bomb', xml: 'Models/Stores/Weapons/MK-84/MK-84.xml', ac: 'Models/Stores/Weapons/MK-84/MK-84.ac' },
  { id: 'agm65', label: 'AGM-65 Maverick', xml: 'Models/Stores/Weapons/AGM-65B/AGM-65B.xml', ac: 'Models/Stores/Weapons/AGM-65B/AGM-65B.ac' },
  { id: 'aim9m_lw', label: 'AIM-9M (left rail)', xml: 'Models/Stores/Weapons/AIM-9M/AIM-9M_LW.xml', ac: 'Models/Stores/Weapons/AIM-9M/AIM-9M_LW.ac' },
  { id: 'aim9m_rw', label: 'AIM-9M (right rail)', xml: 'Models/Stores/Weapons/AIM-9M/AIM-9M_RW.xml', ac: 'Models/Stores/Weapons/AIM-9M/AIM-9M_RW.ac' },
  { id: 'lau68', label: 'LAU-68 rocket pod (also the LAU-131)', acOnly: 'Models/Stores/Weapons/LAU-68/LAU-68.ac' },
  { id: 'hydra70', label: 'Hydra 70 rocket', acOnly: 'Models/Stores/Weapons/LAU-68/Hydra70.ac', noLugs: true },
  { id: 'ter9a', label: 'TER-9A triple ejector rack', xml: 'Models/Stores/Racks/TER-9A/TER-9A.xml', ac: 'Models/Stores/Racks/TER-9A/TER-9A.ac' },
  { id: 'lau88', label: 'LAU-88 triple Maverick launcher (FlightGear trirack_small)', xml: 'Models/Stores/Racks/trirack_small.xml', ac: 'Models/Stores/Racks/trirack_small.ac' },
  { id: 'lau114', label: 'LAU-114 dual AIM-9 adapter', xml: 'Models/Stores/Racks/LAU-114/LAU-114.xml', ac: 'Models/Stores/Racks/LAU-114/LAU-114.ac' },
  { id: 'aaq28', label: 'AN/AAQ-28 Litening targeting pod', xml: 'Models/Stores/Ext-Stores/AN_AAQ-28/AN-AAQ-28.xml', ac: 'Models/Stores/Ext-Stores/AN_AAQ-28/AN-AAQ-28.ac' },
  { id: 'alq131', label: 'AN/ALQ-131 jamming pod', xml: 'Models/Stores/Ext-Stores/AN_ALQ-131/AN_ALQ-131.xml', ac: 'Models/Stores/Ext-Stores/AN_ALQ-131/AN_ALQ-131.ac' },
  { id: 'alq184', label: 'AN/ALQ-184 jamming pod', xml: 'Models/Stores/Ext-Stores/AN_ALQ-184/AN_ALQ-184.xml', ac: 'Models/Stores/Ext-Stores/AN_ALQ-184/AN_ALQ-184.ac' },
  { id: 'mxu648', label: 'MXU-648 cargo pod', xml: 'Models/Stores/Ext-Stores/MXU-648/MXU-648.xml', ac: 'Models/Stores/Ext-Stores/MXU-648/MXU-648.ac' },
  { id: 'cbu87', label: 'CBU-87 dispenser shell (also the CBU-97)', xml: 'Models/Stores/Weapons/CBU-87/CBU-87.xml', ac: 'Models/Stores/Weapons/CBU-87/CBU-87.ac', keep: /^CBU-87/ },
  { id: 'gbu12', label: 'GBU-12 Paveway II (Mk 82 body + kit built in code)', gbu12: true },
  { id: 'lau117', label: 'LAU-117 single-rail Maverick launcher (built in code)', lau117: true },
];

/** Our StoreType → store model id (src/a10/core/weapons/types.ts). */
const STORE_TYPES = {
  'AGM-65D': 'agm65',
  'AGM-65H': 'agm65',
  'AGM-65G': 'agm65',
  'AGM-65K': 'agm65',
  'MK-82': 'mk82',
  'MK-82AIR': 'mk82air',
  'MK-84': 'mk84',
  'GBU-12': 'gbu12',
  'LAU-131-M151': 'lau68',
  'LAU-131-M156': 'lau68',
  'LAU-68-M151': 'lau68',
  'LAU-68-M156': 'lau68',
  'CBU-97': 'cbu87',
  'CBU-87': 'cbu87',
  'AN/AAQ-28': 'aaq28',
  'AN/ALQ-184': 'alq184',
  'AN/ALQ-131': 'alq131',
  'AIM-9M': 'aim9m_lw',
  'TER-9A': 'ter9a',
  'LAU-117': 'lau117',
  'LAU-88': 'lau88',
  'LAU-114': 'lau114',
  'MXU-648': 'mxu648',
};

const storeMeta = {};
const storeRoots = new Map();
for (const s of STORES) {
  let root;
  if (s.gbu12 || s.lau117) {
    root = makeNode('model', s.id, { file: '(built in code)', line: 0 });
    if (s.gbu12) {
      const body = loadModel(src, 'Models/Stores/Weapons/MK-82/MK-82.xml', FG_TO_BODY_AXES, {
        ...ctx,
        filterObject: (_f, name) => !/Detonator|TailFins/.test(name),
      });
      for (const c of [...body.children]) appendChild(root, c);
      root.ac = 'Models/Stores/Weapons/MK-82/MK-82.ac';
    }
    const built = s.gbu12 ? buildGbu12Kit() : buildLau117();
    const world = { type: 'world', name: null, line: 0, kids: built.kids, verts: new Float64Array(0), surfs: [] };
    const nodes = acTreeToNodes({ materials: built.materials, root: world }, `(built in code: ${s.id})`, FG_TO_BODY_AXES, ctx, () => null);
    for (const c of [...nodes.children]) appendChild(root, c);
  } else if (s.acOnly) {
    root = makeNode('model', s.id, { file: s.acOnly, line: 0 });
    const acRoot = loadAC(src, s.acOnly, FG_TO_BODY_AXES, ctx);
    for (const c of [...acRoot.children]) appendChild(root, c);
  } else {
    root = loadModel(src, s.xml, FG_TO_BODY_AXES, {
      ...ctx,
      filterObject: s.keep ? (_f, name) => s.keep.test(name) : () => true,
    });
    root.name = s.id;
  }
  // remove unwanted toggles: MK-82AIR keeps its chute as a hidden part
  for (const n of walk(root)) n.toggles = n.toggles.filter((t) => !IGNORED_TOGGLE.test(t.cond));
  // geometry bounds (BODY axes, FG store origin)
  const lugObj = [...walk(root)].find((n) => n.geom && /mount|hook|lugs/i.test(n.name) && !/Hydra/.test(n.name));
  const bb = boundsOf(root);
  let lug;
  if (s.noLugs) lug = [0, 0, (bb.min[2] + bb.max[2]) / 2];
  else if (lugObj) lug = [0, lugObj.geom.bbox.max[1], (lugObj.geom.bbox.min[2] + lugObj.geom.bbox.max[2]) / 2];
  else lug = [0, bb.max[1], (bb.min[2] + bb.max[2]) / 2];
  storeRoots.set(s.id, root);
  storeMeta[s.id] = {
    label: s.label,
    file: `models/stores/${s.id}.glb`,
    lugFg: [lug[2], lug[0], lug[1]],
    /** The store's own reference point (FlightGear origin: mid-length on the body axis), relative to the lugs. */
    centre: round3([-lug[0], -lug[1], -lug[2]]),
    length: r3(bb.max[2] - bb.min[2]),
    diameter: r3(Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1])),
    bounds: { min: round3(sub3(bb.min, lug)), max: round3(sub3(bb.max, lug)) },
    lugObject: lugObj?.name ?? null,
  };
  const plan = planGLB({ name: s.id, roots: [root], channelOf, textureInfo, options: {}, rootOrigin: lug });
  plans.push({ plan, file: `stores/${s.id}.glb`, group: 'stores', store: s.id });
}

function boundsOf(root) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const n of walk(root)) {
    if (!n.geom || n.excluded || n.geom.triangles === 0) continue;
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], n.geom.bbox.min[c]);
      max[c] = Math.max(max[c], n.geom.bbox.max[c]);
    }
  }
  return { min, max };
}
function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function r3(x) {
  return Math.round(x * 1e4) / 1e4;
}

// ---------------------------------------------------------------------------------------------
// cockpit textures: sized by the texel density their geometry needs, and the opaque ones that do
// not tile packed into atlas pages (ninety textures would mean ninety draw calls)
// ---------------------------------------------------------------------------------------------
const COCKPIT_TEXELS_PER_METRE = 3000;
const ATLAS_PAD = 4;
const cockpitDemand = textureDemand(cockpitPlan);
const texRelOf = (id) => texIds.get(id);
const cockpitSlot = (id) => {
  const info = texInfo.get(texRelOf(id));
  return slotSize(cockpitDemand.get(id), info.width, info.height, { texelsPerMetre: COCKPIT_TEXELS_PER_METRE, maxSlot: 1024 });
};
const atlas = atlasPlan(cockpitPlan, {
  prefix: 'cockpit-atlas',
  page: 2048,
  pad: ATLAS_PAD,
  sizeOf: cockpitSlot,
  eligible: (d) => d.alphaMode === 'OPAQUE' && !d.uvAnim && !d.display,
});
const atlasPages = new Map(atlas.pages.map((p) => [p.id, p]));

// ---------------------------------------------------------------------------------------------
// decide texture formats (a texture needing alpha in any file is PNG), then write everything
// ---------------------------------------------------------------------------------------------
const usedTex = new Map(); // id → Set(plan names)
for (const { plan } of plans)
  for (const fm of plan.merged.values())
    for (const [key, acc] of fm) {
      const d = plan.matKeys.get(key);
      if (!d.map || !acc.idx.length) continue;
      if (!usedTex.has(d.map)) usedTex.set(d.map, new Set());
      usedTex.get(d.map).add(plan.name);
    }
const texFormat = new Map();
for (const { plan } of plans)
  for (const fm of plan.merged.values())
    for (const [key, acc] of fm) {
      const d = plan.matKeys.get(key);
      if (!d.map || !acc.idx.length || atlasPages.has(d.map)) continue;
      const rel = texRelOf(d.map);
      texFormat.set(rel, (texFormat.get(rel) ?? false) || d.alphaMode !== 'OPAQUE');
    }
const texOut = new Map(); // id → { file, uri, bytes }
function texFileOf(id) {
  if (atlasPages.has(id)) return `${id}.jpg`;
  const rel = texIds.get(id);
  const png = texFormat.get(rel) ?? false;
  return `${id}.${png ? 'png' : 'jpg'}`;
}

rmSync(OUT_MODELS, { recursive: true, force: true });
rmSync(OUT_TEX, { recursive: true, force: true });
mkdirSync(join(OUT_MODELS, 'stores'), { recursive: true });
mkdirSync(OUT_TEX, { recursive: true });

const fileStats = {};
for (const { plan, file, group } of plans) {
  const prefix = file.includes('/') ? '../../textures/' : '../textures/';
  const { glb, stats } = writeGLB(
    plan,
    (id) => {
      const f = texFileOf(id);
      return { uri: prefix + f, mimeType: f.endsWith('.png') ? 'image/png' : 'image/jpeg' };
    },
    GENERATOR,
  );
  writeFileSync(join(OUT_MODELS, file), glb);
  fileStats[file] = { bytes: glb.length, group, ...stats };
}

// textures: encode every one referenced by a written file
for (const id of [...usedTex.keys()].sort()) {
  const f = texFileOf(id);
  const page = atlasPages.get(id);
  if (page) {
    buildPage(page, (tex) => src.abs(texRelOf(tex)), join(OUT_TEX, f), { pad: ATLAS_PAD, quality: 85 });
    texOut.set(id, {
      file: f,
      source: page.tiles.map((t) => texRelOf(t.tex)),
      width: page.size,
      height: page.size,
      bytes: statSync(join(OUT_TEX, f)).size,
      atlas: page.tiles.map((t) => ({ source: texRelOf(t.tex), x: t.x, y: t.y, size: t.s })),
    });
    continue;
  }
  const rel = texIds.get(id);
  const users = usedTex.get(id);
  const isStore = rel.startsWith('Models/Stores/');
  const cockpitOnly = users.size === 1 && users.has('a10-cockpit');
  const { width, height } = encodeImage(src.abs(rel), join(OUT_TEX, f), {
    maxSize: isStore ? 512 : cockpitOnly ? cockpitSlot(id) : 1024,
    quality: 85,
  });
  texOut.set(id, { file: f, source: rel, width, height, bytes: statSync(join(OUT_TEX, f)).size });
}

// liveries: extra main textures (detail texture is shared)
const LIVERIES = [
  { id: 'default', xml: 'Models/Liveries/default.xml' },
  { id: 'usaf-low-vis', xml: 'Models/Liveries/USAF.xml' },
  { id: 'acc', xml: 'Models/Liveries/ACC.xml' },
];
const liveryMeta = [];
for (const l of LIVERIES) {
  const x = parseXml(src.text(l.xml), l.xml);
  const name = text(x, 'sim/model/livery/name');
  const mainRel = posix.normalize(posix.join('Models', text(x, 'sim/model/livery/texture-main')));
  let mainId = [...texIds.entries()].find(([, rel]) => rel === mainRel)?.[0];
  if (!mainId) {
    mainId = safeName(`livery-${posix.basename(mainRel).replace(/\.png$/i, '').toLowerCase()}`);
    const f = `${mainId}.jpg`;
    src.used.add(mainRel);
    const { width, height } = encodeImage(src.abs(mainRel), join(OUT_TEX, f), { maxSize: 1024, quality: 85 });
    texOut.set(mainId, { file: f, source: mainRel, width, height, bytes: statSync(join(OUT_TEX, f)).size, livery: l.id });
  }
  liveryMeta.push({
    id: l.id,
    name,
    main: `textures/${texOut.get(mainId).file}`,
    detail: `textures/${texFileOf('a-10-000b')}`,
    source: mainRel,
  });
}

// ---------------------------------------------------------------------------------------------
// measurements for the meta file
// ---------------------------------------------------------------------------------------------
const extNodes = { children: exteriorRoots, name: '' };
const one = (root, name) => findByName(root, name)[0] ?? null;

/** Evaluate a pivot drive (FlightGear units → SI) for a property value. */
function fgDrive(pv, value) {
  let v;
  if (pv.tableSI) v = interp(pv.tableSI, value);
  else v = (pv.gain ?? 0) * value + (pv.offsetSI ?? 0);
  if (pv.minSI !== null && pv.minSI !== undefined) v = Math.max(pv.minSI, v);
  if (pv.maxSI !== null && pv.maxSI !== undefined) v = Math.min(pv.maxSI, v);
  return v;
}
function interp(t, x) {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++)
    if (x <= t[i][0]) {
      const [x0, y0] = t[i - 1];
      const [x1, y1] = t[i];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  return t[t.length - 1][1];
}

/** BODY transform of a node for given property values (pivot chain, outermost first). */
function nodeTransform(node, props) {
  const chain = [];
  for (let p = node; p; p = p.parent) if (p.kind === 'pivot') chain.unshift(p);
  let M = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  for (const p of chain) {
    const pv = p.pivot;
    const value = pv.property ? (props[pv.property] ?? 0) : 0;
    const v = fgDrive(pv, value);
    let T;
    if (pv.type === 'translate') T = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: pv.axis.map((a) => a * v) };
    else if (pv.type === 'rotate') T = rotateAbout(pv.centre, pv.axis, v);
    else T = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
    M = compose(M, T);
  }
  return M;
}

function geomPoints(node) {
  const pts = [];
  for (const n of walk(node))
    if (n.geom) for (const g of n.geom.groups.values()) for (let i = 0; i < g.pos.length; i += 3) pts.push([g.pos[i], g.pos[i + 1], g.pos[i + 2]]);
  return pts;
}

// gear-down contacts
const gearDownProps = {
  'gear/gear[0]/position-norm': 1,
  'gear/gear[1]/position-norm': 1,
  'gear/gear[2]/position-norm': 1,
};
const contacts = {};
for (const [id, tyre] of [
  ['nose', 'UC-NoseTyre'],
  ['left', 'UC-LeftTyre'],
  ['right', 'UC-RightTyre'],
]) {
  const n = one(extNodes, tyre);
  const M = nodeTransform(n, gearDownProps);
  const pts = geomPoints(n).map((p) => applyPoint(M, p[0], p[1], p[2]));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let c = 0; c < 3; c++) ((min[c] = Math.min(min[c], p[c])), (max[c] = Math.max(max[c], p[c])));
  const low = pts.reduce((a, b) => (b[1] < a[1] ? b : a));
  const centre = [0, 1, 2].map((c) => (min[c] + max[c]) / 2);
  contacts[id] = { centre: round3(centre), contact: round3([centre[0], low[1], low[2]]), radius: r3((max[1] - min[1]) / 2) };
}

// fan pivot vs mesh centroid (spin axis must go through the fan)
const fanCheck = {};
for (const nm of ['LEFan', 'REFan']) {
  const n = one(extNodes, nm);
  let p = n.parent;
  while (p && p.kind !== 'pivot') p = p.parent;
  const c = n.geom.centroid;
  const pv = p.pivot;
  // distance from the centroid to the spin axis
  const d = sub3(c, pv.centre);
  const along = d[0] * pv.axis[0] + d[1] * pv.axis[1] + d[2] * pv.axis[2];
  const perp = [d[0] - along * pv.axis[0], d[1] - along * pv.axis[1], d[2] - along * pv.axis[2]];
  fanCheck[nm] = { centroid: round3(c), axisDistance: r3(Math.hypot(...perp)) };
}

// engines: fan hub (spin axis through the fan) and the nozzle exit (aft end of the nacelle)
const engines = ['L', 'R'].map((side) => {
  const fan = one(extNodes, `${side}EFan`);
  const casing = one(extNodes, `${side}EnginePodCasing`);
  let p = fan.parent;
  while (p && p.kind !== 'pivot') p = p.parent;
  const c = p.pivot.centre;
  return {
    side: side === 'L' ? 'left' : 'right',
    fan: round3([c[0], c[1], fan.geom.centroid[2]]),
    exhaust: round3([c[0], c[1], casing.geom.bbox.max[2]]),
  };
});

// quad corners (top-left, top-right, bottom-right, bottom-left as the pilot sees them)
function quadCorners(root, name) {
  const n = one(root, name);
  if (!n?.geom) return null;
  const pts = [];
  for (const p of geomPoints(n)) if (!pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-4)) pts.push(p);
  if (pts.length < 4) return null;
  const sorted = pts.slice().sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 2).sort((a, b) => a[0] - b[0]);
  const bottom = sorted.slice(-2).sort((a, b) => a[0] - b[0]);
  return [top[0], top[1], bottom[1], bottom[0]].map(round3);
}
const cockpitTree = { children: cockpitModels, name: '' };
const hudCorners = quadCorners(cockpitTree, 'hud-screen');
const hudNormal = (() => {
  const [tl, tr, , bl] = hudCorners;
  const a = sub3(tr, tl);
  const b = sub3(bl, tl);
  const n = normalize3([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
  return round3(n[2] > 0 ? n : n.map((x) => -x));
})();
const displays = {
  tv: { node: 'CPT-video-screen', corners: quadCorners(cockpitTree, 'CPT-video-screen'), shownWhen: 'variant A-10A (no MPCD)' },
  mpcd: { node: 'canvas_disp', corners: quadCorners(cockpitTree, 'canvas_disp'), shownWhen: 'variant A-10A+ (MPCD)' },
};

// eye point from A-10-base.xml view 0
const base = parseXml(src.text('A-10-base.xml'), 'A-10-base.xml');
const view0 = all(child(base, 'sim'), 'view').find((v) => (v.attrs.n ?? '0') === '0');
const vc = child(view0, 'config');
const eyeFg = [num(vc, 'z-offset-m', 0), num(vc, 'x-offset-m', 0), num(vc, 'y-offset-m', 0)];
const eye = {
  position: round3(applyPoint(FG_TO_BODY, ...eyeFg)),
  pitch: r3(num(vc, 'pitch-offset-deg', 0) * D2R),
  fovDeg: num(vc, 'default-field-of-view-deg', 65),
  fovAxis: 'wider screen axis (FlightGear)',
  headingLimitDeg: num(vc, 'limits/left/heading-max-deg', 155),
  source: `A-10-base.xml:${view0.line}`,
};

// gun: FlightGear submodel spawn point (legacy feet, x forward, z up)
const subm = parseXml(src.text('A-10-submodels.xml'), 'A-10-submodels.xml');
const gunSub = all(subm, 'submodel').find((m) => /GAU-8/.test(text(m, 'name') ?? '')) ?? all(subm, 'submodel')[0];
const gunFg = [-num(gunSub, 'x-offset', 0) * 0.3048, num(gunSub, 'y-offset', 0) * 0.3048, num(gunSub, 'z-offset', 0) * 0.3048];
const cannon = one(extNodes, 'Cannon');
const cbb = cannon.geom.bbox;
// the firing barrel is the one on the centreline: average the muzzle-face vertices near X = 0
const front = geomPoints(cannon).filter((p) => p[2] < cbb.min[2] + 0.012 && Math.abs(p[0]) < 0.022);
const muzzleY = front.length ? front.reduce((s, p) => s + p[1], 0) / front.length : -0.59;
const gun = {
  muzzle: round3([0, muzzleY, cbb.min[2]]),
  direction: round3(GUN.axis),
  spinPivot: 'Cannon__spin',
  clusterAxisPoint: round3(GUN.clusterCentre),
  fgSpawnPoint: round3(applyPoint(FG_TO_BODY, ...gunFg)),
  fgSpawnSource: `A-10-submodels.xml:${gunSub.line}`,
  cannonBounds: { min: round3(cbb.min), max: round3(cbb.max) },
};

// lights
const lights = [];
for (const [nm, id] of LIGHTS) {
  if (id === 'formation') continue;
  const n = one(extNodes, nm);
  if (!n?.geom) continue;
  const colour = { navLeft: [1, 0.08, 0.05], navRight: [0.1, 1, 0.25] }[id] ?? [1, 1, 1];
  lights.push({ id, node: nm, position: round3(n.geom.centroid), colour, kind: id.startsWith('nav') ? 'steady' : 'strobe' });
}
const skippedLanding = aircraft.skipped?.find((s) => s.path === 'Models/Effects/landing-light.xml');
if (skippedLanding) {
  const o = skippedLanding.offsets;
  lights.push({ id: 'landing', node: null, position: round3(applyPoint(FG_TO_BODY, o.x, o.y, o.z)), colour: [1, 0.97, 0.9], kind: 'landing' });
}

// pylons → stations
const PYLONS = ['L-Wing-Att-4', 'L-Wing-Att-3', 'L-Wing-Att-2', 'L-Wing-Att-1', 'Hull-Att1', 'Hull-Att2', 'Hull-Att3', 'R-Wing-Att-1', 'R-Wing-Att-2', 'R-Wing-Att-3', 'R-Wing-Att-4'];
function pylonBottom(n, z) {
  const pts = [];
  for (const g of n.geom.groups.values())
    for (let t = 0; t < g.idx.length; t += 3)
      for (const [a, b] of [
        [0, 1],
        [1, 2],
        [2, 0],
      ]) {
        const pa = g.idx[t + a] * 3;
        const pb = g.idx[t + b] * 3;
        const za = g.pos[pa + 2] - z;
        const zb = g.pos[pb + 2] - z;
        if ((za < 0 && zb > 0) || (zb < 0 && za > 0)) {
          const u = za / (za - zb);
          pts.push([0, 1, 2].map((c) => g.pos[pa + c] + u * (g.pos[pb + c] - g.pos[pa + c])));
        }
      }
  if (!pts.length) return null;
  // the pylon bottom: the lowest section points (within 6 mm), centred laterally
  const low = Math.min(...pts.map((p) => p[1]));
  const bottom = pts.filter((p) => p[1] < low + 0.006);
  const xs = bottom.map((p) => p[0]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, low, z];
}

// store placements (FlightGear loads_models.xml), resolved through nested XMLs
function resolvePlacements(xmlRel, xf, out, extraTop = null) {
  const x = parseXml(src.text(xmlRel), xmlRel);
  const dir = posix.dirname(xmlRel);
  const top = child(x, 'offsets');
  let xfTop = xf;
  if (top) xfTop = compose(xf, offsetsTransform(readOffsets(top)));
  if (extraTop) xfTop = compose(xfTop, extraTop);
  const p = text(x, 'path');
  if (p) {
    const rel = src.resolve(dir, p);
    if (rel.endsWith('.xml')) resolvePlacements(rel, xfTop, out);
    else out.push({ ac: rel, xf: xfTop, xml: xmlRel });
  }
  for (const m of all(x, 'model')) {
    const name = text(m, 'name');
    const subRel = src.resolve(dir, text(m, 'path'));
    let mxf = compose(xfTop, offsetsTransform(readOffsets(child(m, 'offsets'))));
    // constant rotations applied to this sub-model by its parent (TER-9A shoulder bombs)
    for (const a of all(x, 'animation')) {
      if (text(a, 'type') !== 'rotate' || text(a, 'property')) continue;
      if (!all(a, 'object-name').some((o) => o.text === name)) continue;
      const c = child(a, 'center');
      const ax = child(a, 'axis');
      const ang = (num(a, 'offset-deg', 0) + 0) * D2R;
      const rot = rotateAbout([num(c, 'x-m', 0), num(c, 'y-m', 0), num(c, 'z-m', 0)], normalize3([num(ax, 'x', 0), num(ax, 'y', 0), num(ax, 'z', 0)]), ang);
      mxf = compose(compose(xfTop, rot), offsetsTransform(readOffsets(child(m, 'offsets'))));
    }
    if (subRel.endsWith('.xml')) resolvePlacements(subRel, mxf, out);
    else out.push({ ac: subRel, xf: mxf, xml: xmlRel });
  }
}
function readOffsets(o) {
  return {
    x: num(o, 'x-m', 0),
    y: num(o, 'y-m', 0),
    z: num(o, 'z-m', 0),
    h: num(o, 'heading-deg', 0),
    p: num(o, 'pitch-deg', 0),
    r: num(o, 'roll-deg', 0),
  };
}
const acToStore = new Map();
for (const s of STORES) if (s.ac || s.acOnly) acToStore.set(s.ac ?? s.acOnly, s.id);
acToStore.set('Models/Stores/Weapons/AIM-9M/AIM-9M.ac', 'aim9m_lw');

/** Lug point and orientation of a store whose FG frame maps to BODY through `xf` (FG → BODY). */
function lugPlacement(storeId, xf) {
  const lugFg = storeMeta[storeId].lugFg;
  const pos = applyPoint(xf, ...lugFg);
  // the store file's axes are P(FG) (BODY-aligned); xf maps store FG → aircraft BODY, so the
  // store file → aircraft rotation is xf.R ∘ P⁻¹
  const R = compose({ R: xf.R, t: [0, 0, 0] }, invertAxes(FG_TO_BODY_AXES));
  return { position: round3(pos), quaternion: quatFromMatrix(R.R).map(r6) };
}
function invertAxes(m) {
  const R = m.R;
  return { R: [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]], t: [0, 0, 0] };
}
function r6(x) {
  return Math.round(x * 1e6) / 1e6;
}
function quatFromMatrix(m) {
  const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = m;
  const tr = m11 + m22 + m33;
  let x;
  let y;
  let z;
  let w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s;
    x = (m32 - m23) * s;
    y = (m13 - m31) * s;
    z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s;
    x = 0.25 * s;
    y = (m12 + m21) / s;
    z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s;
    x = (m12 + m21) / s;
    y = 0.25 * s;
    z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s;
    x = (m13 + m31) / s;
    y = (m23 + m32) / s;
    z = 0.25 * s;
  }
  return [x, y, z, w];
}

// FG placements on the aircraft: body-frame xf = FG_TO_BODY ∘ placement
const loadsModels = parseXml(src.text('Models/Stores/loads_models.xml'), 'Models/Stores/loads_models.xml');
src.text('Models/Stores/loads.xml');
const fgPlacements = []; // { fgId, name, items: [{store, xf}] }
for (const m of all(loadsModels, 'model')) {
  const name = text(m, 'name');
  const ids = name.match(/\d+/g);
  const fgId = Number(/^Station(\d+)/.exec(name)?.[1] ?? ids?.[ids.length - 1]);
  const rel = src.resolve('Models/Stores', text(m, 'path'));
  const items = [];
  resolvePlacements(rel, compose(FG_TO_BODY, offsetsTransform(readOffsets(child(m, 'offsets')))), items);
  fgPlacements.push({ fgId, name, line: m.line, items: items.map((it) => ({ store: acToStore.get(it.ac) ?? null, ac: it.ac, xf: it.xf })) });
}

const stations = [];
for (let i = 0; i < 11; i++) {
  const pyl = one(extNodes, PYLONS[i]);
  const susp = pylonBottom(pyl, -0.05);
  const fwd = pylonBottom(pyl, -0.6);
  const aft = pylonBottom(pyl, 0.5);
  const pitch = fwd && aft ? Math.atan2(fwd[1] - aft[1], aft[2] - fwd[2]) : 0;
  const placements = {};
  for (const fp of fgPlacements.filter((f) => f.fgId === i)) {
    const items = fp.items.filter((it) => it.store);
    if (!items.length) continue;
    const racks = items.filter((it) => ['ter9a', 'lau88', 'lau114'].includes(it.store));
    if (racks.length) {
      const r = racks[0];
      if (!placements[r.store]) placements[r.store] = { ...lugPlacement(r.store, r.xf), source: `Models/Stores/loads_models.xml:${fp.line}` };
    } else {
      const it = items[0];
      if (!placements[it.store]) placements[it.store] = { ...lugPlacement(it.store, it.xf), source: `Models/Stores/loads_models.xml:${fp.line}` };
    }
  }
  stations.push({
    station: i + 1,
    fgId: i,
    pylon: PYLONS[i],
    suspension: round3(susp),
    pitch: r3(pitch),
    placements,
  });
}

// rack mounts: where the stores' lugs sit, in the rack's lug frame
function rackMounts(rackId, xmlRel, storeId) {
  const items = [];
  resolvePlacements(xmlRel, FG_TO_BODY_AXES, items);
  const rack = items.find((it) => acToStore.get(it.ac) === rackId);
  const rackLug = applyPoint(rack.xf, ...storeMeta[rackId].lugFg);
  const mounts = [];
  for (const it of items) {
    if (acToStore.get(it.ac) !== storeId && !(storeId === 'aim9m' && /AIM-9M/.test(it.ac))) continue;
    const sid = acToStore.get(it.ac) ?? storeId;
    const pl = lugPlacement(sid, it.xf);
    mounts.push({ position: round3(sub3(pl.position, rackLug)), quaternion: pl.quaternion, model: sid });
  }
  return { mounts, source: xmlRel };
}
const racks = {
  ter9a: rackMounts('ter9a', 'Models/Stores/Weapons/MK-82/ter-9a-2.xml', 'mk82'),
  lau88: rackMounts('lau88', 'Models/Stores/Weapons/AGM-65B/trirack-2.xml', 'agm65'),
  lau114: rackMounts('lau114', 'Models/Stores/Weapons/AIM-9M/LAU-114-0.xml', 'aim9m'),
  lau117: (() => {
    // built in code: the missile's hooks run in the rail under the launcher, the missile a
    // little forward of the launcher's middle
    const rail = one(storeRoots.get('lau117'), 'LAU-117_Rail').geom.bbox;
    const lug = storeMeta.lau117.lugFg; // FG [x, y, z]
    const hookZ = -0.06; // BODY Z of the missile's hook point on the launcher (FG x)
    return {
      mounts: [{ position: round3([0, rail.min[1] - lug[2], hookZ - lug[0]]), quaternion: [0, 0, 0, 1], model: 'agm65' }],
      source: 'convert-lib-build.mjs (LAU-117)',
    };
  })(),
};

// pivots → meta (exterior with our simulation's inputs; cockpit and pilot with FlightGear's)
const EXTERIOR_INPUTS = [
  [/^surface-positions\/left-aileron-pos-norm$/, 'aileron', 1],
  [/^surface-positions\/right-aileron-pos-norm$/, 'aileron', -1],
  [/^surface-positions\/(left|right)-spoiler-pos-norm$/, 'speedBrake', 40 / 60],
  [/^surface-positions\/(left|right)-elevator-pos-norm$/, 'elevator', -1],
  [/^surface-positions\/rudder-pos-norm$/, 'rudder', -1],
  [/^surface-positions\/(left|right)-flap-pos-norm$/, 'flaps', 1 / (30 * D2R)],
  [/^canopy\/position-norm$/, 'canopy', 1],
  [/^gear\/gear\[0\]\/position-norm$/, 'gearNose', 1],
  [/^gear\/gear\[1\]\/position-norm$/, 'gearLeft', 1],
  [/^gear\/gear\[2\]\/position-norm$/, 'gearRight', 1],
  [/^gear\/gear\[0\]\/compression-norm$/, 'compressionNose', 1],
  [/^gear\/gear\[1\]\/compression-norm$/, 'compressionLeft', 1],
  [/^gear\/gear\[2\]\/compression-norm$/, 'compressionRight', 1],
  [/^gear\/gear\/rollspeed-ms$/, 'wheelNose', 1],
  [/^gear\/gear\[1\]\/rollspeed-ms$/, 'wheelLeft', 1],
  [/^gear\/gear\[2\]\/rollspeed-ms$/, 'wheelRight', 1],
  [/engine\[0\]\/n1$/, 'n1Left', 100],
  [/engine\[1\]\/n1$/, 'n1Right', 100],
];
function pivotMeta(plan, n, withInputs) {
  const pv = n.pivot;
  const name = plan.nameOf.get(n);
  const parentPivot = (() => {
    for (let p = n.parent; p; p = p.parent) if (p.kind === 'pivot' && plan.nameOf.has(p)) return plan.nameOf.get(p);
    return null;
  })();
  const e = {
    node: name,
    type: pv.type,
    axis: round3(pv.axis),
    centre: round3(pv.centre),
    targets: n.targets,
    parent: parentPivot,
  };
  const fg = { file: pv.file, line: pv.line, type: pv.fgType };
  if (pv.property) fg.property = pv.property;
  if (pv.table) fg.table = pv.table;
  else {
    fg.factor = pv.factor;
    if (pv.offset) fg.offset = pv.offset;
  }
  if (pv.min !== null && pv.min !== undefined) fg.min = pv.min;
  if (pv.max !== null && pv.max !== undefined) fg.max = pv.max;
  e.fg = fg;
  // drive in SI from the FlightGear property
  const unit = pv.type === 'spin' ? (2 * Math.PI) / 60 : pv.type === 'translate' ? 1 : D2R;
  const drive = { input: pv.property ?? null };
  if (pv.table) drive.table = pv.table.map(([i, d]) => [i, r6(d * unit)]);
  else {
    drive.gain = r6((pv.factor ?? 1) * unit);
    if (pv.offset) drive.offset = r6(pv.offset * unit);
  }
  if (pv.min !== null && pv.min !== undefined) drive.min = r6(pv.min * unit);
  if (pv.max !== null && pv.max !== undefined) drive.max = r6(pv.max * unit);
  if (!pv.property && pv.type !== 'spin' && n.custom !== 'spin') drive.constant = true;
  e.drive = drive;
  if (withInputs) {
    if (n.custom === 'spin') e.drive = { input: 'barrelAngle', gain: 1 };
    else if (/alpha-deg/.test(pv.property ?? '') && /Slat/.test(n.targets[0])) e.drive = { input: 'slats', gain: 0.15 };
    else {
      const map = EXTERIOR_INPUTS.find(([re]) => re.test(pv.property ?? ''));
      if (map) {
        const [, input, s] = map;
        const d = { input };
        if (drive.table) {
          d.table = drive.table.map(([i, v]) => [r6(i / s), v]).sort((a, b) => a[0] - b[0]);
        } else {
          d.gain = r6(drive.gain * s);
          if (drive.offset) d.offset = drive.offset;
        }
        if (drive.min !== undefined) d.min = drive.min;
        if (drive.max !== undefined) d.max = drive.max;
        e.drive = d;
      } else e.drive = { ...drive, input: null, note: `unmapped FlightGear input ${pv.property}` };
    }
  }
  return e;
}
const pivotsOf = (plan, withInputs) => plan.nodes.filter((n) => n.kind === 'pivot').map((n) => pivotMeta(plan, n, withInputs));

const SEMANTIC_TOGGLES = [
  [/^FTank1$/, { station: 6 }],
  [/^FTank2$/, { station: 8 }],
  [/^FTank3$/, { station: 4 }],
  [/^[FB]CanopyGlass$/, { view: 'outside' }],
  [/^[FB]CanopyGlass-int$/, { view: 'inside' }],
  [/^Pilot$/, { view: 'outside' }],
  [/^MPCD$/, { variant: 'A-10A+' }],
  [/^CPT-video$/, { variant: 'A-10A' }],
  [/^UC-NFD-lock-0$/, { gear: 'up' }],
  [/^UC-NFD-lock-1$/, { gear: 'moving' }],
  [/light-on$/, { lamp: 'on' }],
  [/light-off$/, { lamp: 'off' }],
];
function togglesOf(plan) {
  const out = [];
  for (const n of plan.nodes) {
    if (!n.toggles.length) continue;
    const sem = SEMANTIC_TOGGLES.find(([re]) => re.test(n.name))?.[1] ?? null;
    out.push({
      node: plan.nameOf.get(n),
      default: n.toggles.every((t) => t.default),
      conditions: n.toggles.map((t) => ({ cond: t.cond, src: `${t.file}:${t.line}` })),
      ...(sem ? { semantic: sem } : {}),
    });
  }
  return out;
}

function boxOf(node) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const n of walk(node))
    if (n.geom && n.geom.triangles)
      for (let c = 0; c < 3; c++) ((min[c] = Math.min(min[c], n.geom.bbox.min[c])), (max[c] = Math.max(max[c], n.geom.bbox.max[c])));
  return Number.isFinite(min[0]) ? { min, max } : null;
}
function picksOf(plan) {
  const out = [];
  for (const n of plan.nodes) {
    const hotspot = n.geom && [...n.geom.groups.values()].every((g) => (n.materials[g.mat]?.trans ?? 0) >= 0.999);
    if (!n.picks.length && !(hotspot && n.geom?.triangles)) continue;
    const box = boxOf(n);
    if (!box) continue;
    // the box lives in the frame of the innermost pivot (rest position subtracted)
    let f = n.parent;
    while (f && f.kind !== 'pivot' && plan.origin.has(f)) f = f.parent;
    const frame = f && f.kind === 'pivot' ? f : null;
    const o = frame ? plan.origin.get(frame) : (plan.origin.get(plan.ROOT) ?? [0, 0, 0]);
    out.push({
      node: plan.nameOf.get(n),
      frame: frame ? plan.nameOf.get(frame) : plan.nameOf.get(plan.ROOT),
      box: { min: round3(sub3(box.min, o)), max: round3(sub3(box.max, o)) },
      hotspot: Boolean(hotspot),
      actions: n.picks.map((p) => ({ kind: p.kind, src: `${p.file}:${p.line}`, property: p.property ?? null, bindings: p.bindings })),
    });
  }
  return out;
}
function lodsOf(plan) {
  const out = [];
  for (const n of plan.nodes)
    for (const l of n.lods) out.push({ node: plan.nameOf.get(n), min: l.min, max: Number.isFinite(l.max) ? l.max : null, src: `${l.file}:${l.line}` });
  return out;
}
function uvAnimsOf(plan) {
  const out = [];
  for (const n of plan.nodes)
    for (const u of n.uvAnims)
      out.push({
        node: plan.nameOf.get(n),
        property: u.property,
        factor: u.factor,
        offset: u.offset,
        step: u.step,
        scroll: u.scroll,
        table: u.table,
        // glTF v runs down the image: FlightGear's +v becomes −v
        uv: [u.axis[0], -u.axis[1]],
        src: `${u.file}:${u.line}`,
      });
  return out;
}

const meta = {
  about:
    'Converted from the FlightGear A-10 by scripts/a10/convert-ac3d.mjs. Positions in metres; aircraft files in the BODY frame (+X right wing, +Y up, −Z nose, origin = reference point R); stores in their own BODY-aligned frame with the origin at the top of the suspension lugs.',
  source: SOURCE,
  frame: {
    axes: '+X right wing, +Y up, -Z nose (BODY)',
    units: 'm, rad',
    originFG: [7.65, 0, 0.3],
    originNote: 'R = 25 % of the model wing mean aerodynamic chord, on the centreline, 0.30 m above the FlightGear reference line',
    acToBody: [
      [0, 0, -1],
      [0, 1, 0],
      [1, 0, 0],
    ],
    acToBodyOffset: [0, -0.3, -7.65],
  },
  files: {
    exterior: 'models/a10-exterior.glb',
    cockpit: 'models/a10-cockpit.glb',
    pilot: 'models/a10-pilot.glb',
  },
  exterior: {
    pivots: pivotsOf(exteriorPlan, true),
    toggles: togglesOf(exteriorPlan),
    bounds: boundsMeta(exteriorPlan),
    lightsMaterials: [...new Set(LIGHTS.values())],
  },
  cockpit: {
    pivots: pivotsOf(cockpitPlan, false),
    toggles: togglesOf(cockpitPlan),
    uvAnims: uvAnimsOf(cockpitPlan),
    lods: lodsOf(cockpitPlan),
    models: cockpitModels.map((m) => ({ node: cockpitPlan.nameOf.get(m), file: m.file, offsets: m.offsets ?? null, standIn: !!m.standIn, frozen: !!m.frozen })),
    frozen,
  },
  pilot: { pivots: pivotsOf(pilotPlan, false), toggles: togglesOf(pilotPlan) },
  pick: [...picksOf(cockpitPlan).map((p) => ({ file: 'cockpit', ...p })), ...picksOf(pilotPlan).map((p) => ({ file: 'pilot', ...p }))],
  liveries: liveryMeta,
  liverySlots: { main: 'a-10-000', detail: 'a-10-000b' },
  eye,
  hud: { glassCorners: hudCorners, normal: hudNormal, source: 'Models/Cockpit/detail-cpt.ac object hud-screen (aft face of CPT-hud-screen)' },
  displays,
  gun,
  gear: { contacts, note: 'gear down, struts uncompressed; centre = wheel centre' },
  engines,
  lights,
  stations,
  racks,
  stores: storeMeta,
  storeTypes: STORE_TYPES,
  checks: { fans: fanCheck },
  budget: {},
};

function boundsMeta(plan) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const n of plan.nodes)
    if (n.geom && n.geom.triangles && n.kind === 'object')
      for (let c = 0; c < 3; c++) ((min[c] = Math.min(min[c], n.geom.bbox.min[c])), (max[c] = Math.max(max[c], n.geom.bbox.max[c])));
  return { min: round3(min), max: round3(max) };
}

let totalModels = 0;
for (const [f, s] of Object.entries(fileStats)) {
  totalModels += s.bytes;
  meta.budget[f] = { bytes: s.bytes, triangles: s.triangles, drawCalls: s.primitives, vertices: s.vertices, materials: s.materials, nodes: s.nodes };
}
let totalTex = 0;
const texList = [];
for (const [id, t] of [...texOut.entries()].sort()) {
  totalTex += t.bytes;
  texList.push({ id, ...t });
}
meta.textures = texList.map((t) => ({
  file: `textures/${t.file}`,
  source: t.source,
  size: [t.width, t.height],
  bytes: t.bytes,
  ...(t.livery ? { livery: t.livery } : {}),
  ...(t.atlas ? { atlas: t.atlas } : {}),
}));
writeFileSync(join(OUT_MODELS, 'a10-meta.json'), JSON.stringify(meta, null, 1) + '\n');
const metaBytes = statSync(join(OUT_MODELS, 'a10-meta.json')).size;

// ---------------------------------------------------------------------------------------------
// CREDITS.md: one row per generated file (between the markers; the rest is written by hand)
// ---------------------------------------------------------------------------------------------
const AUTHOR = 'FlightGear A-10 contributors';
const LICENCE = 'GPL-2.0 (package COPYING)';
const FILE_NOTES = {
  'a10-exterior.glb':
    'Exterior. Every A-10-model.xml animation as a hinge pivot (control surfaces, split ailerons/speed brakes, flaps, slats, canopy, gear with doors and linkages, fans); spin pivot added for the gun barrels; nose-gear lamp "on" variants left out',
  'a10-cockpit.glb':
    'Cockpit: tub, side consoles and every instrument sub-model placed with its offsets, and the MPCD; panels the simulation does not drive frozen at their default positions; 56 screw heads and one knob simplified by vertex clustering; HUD canvas quad and legacy 3-D HUD left out; altimeter built in code (its model is not in the package)',
  'a10-pilot.glb': 'Pilot and ejection seat',
};
const credits = [];
const bt = (x) => '`' + x + '`';
const shortSrc = (list) => {
  const dirs = new Map();
  for (const f of list) {
    const d = posix.dirname(f);
    if (!dirs.has(d)) dirs.set(d, []);
    dirs.get(d).push(posix.basename(f));
  }
  return [...dirs]
    .map(([d, fs]) => (fs.length > 6 ? `${bt(d + '/')} (${fs.length} files: ${fs.slice(0, 4).join(', ')}, …)` : fs.map((f) => bt(`${d}/${f}`)).join(', ')))
    .join('; ');
};
for (const { plan, file, store } of plans) {
  const set = new Set();
  let built = false;
  for (const n of plan.nodes) {
    if (n.file?.startsWith('(')) built = true;
    else if (n.file && n.kind === 'model') set.add(n.file);
    else if (n.file && (n.kind === 'object' || n.kind === 'group')) set.add(n.file);
  }
  const s0 = STORES.find((x) => x.id === store);
  let note = FILE_NOTES[file] ?? (s0 ? `${s0.label}; own frame, origin at the suspension lugs` : '');
  if (store === 'gbu12') note += '. Mk 82 body from the package without its fuze and fins; guidance and wing kits built in code';
  if (store === 'lau117') note += '. Built in code (no LAU-117 in the package)';
  if (store === 'cbu87') note += '. Shell only (the 202 modelled bomblets left out); also drawn for the CBU-97';
  if (store === 'lau68') note += '. Also drawn for the LAU-131';
  if (store === 'lau88') note += ". FlightGear's trirack_small, used as the LAU-88";
  credits.push({
    file: `public/a10/models/${file}`,
    source: shortSrc([...set].sort()) || 'built in code',
    author: built && !set.size ? 'this project' : built ? `${AUTHOR}; parts built in code by this project` : AUTHOR,
    licence: built && !set.size ? 'GPL-2.0-or-later' : LICENCE,
    changes: note,
  });
}
credits.push({
  file: 'public/a10/models/a10-meta.json',
  source: shortSrc(['Models/A-10-model.xml', 'A-10-base.xml', 'A-10-submodels.xml', 'Models/Stores/loads_models.xml']) + ' and the geometry above',
  author: AUTHOR,
  licence: LICENCE,
  changes: 'Hinges, toggles, eye point, HUD glass, displays, stations and store placements, gun, lights and gear contacts measured from the package by the converter',
});
for (const t of texList) {
  const srcs = Array.isArray(t.source) ? t.source : [t.source];
  credits.push({
    file: `public/a10/textures/${t.file}`,
    source: shortSrc(srcs),
    author: AUTHOR,
    licence: LICENCE,
    changes: t.atlas
      ? `Atlas page (${t.width}×${t.height}) of ${srcs.length} cockpit textures, each resized to its slot with 4 px edge padding, JPEG`
      : `${t.livery ? `Livery "${liveryMeta.find((l) => l.id === t.livery)?.name}": ` : ''}re-encoded as ${t.file.endsWith('.png') ? 'PNG' : 'JPEG'}, ${t.width}×${t.height}`,
  });
}
{
  const path = join(REPO, 'CREDITS.md');
  const BEGIN = '<!-- BEGIN flightgear-a10 (generated by scripts/a10/convert-ac3d.mjs; do not edit by hand) -->';
  const END = '<!-- END flightgear-a10 -->';
  const text0 = existsSync(path) ? readFileSync(path, 'utf8') : `${BEGIN}\n${END}\n`;
  const a = text0.indexOf(BEGIN);
  const b = text0.indexOf(END);
  if (a < 0 || b < a) throw new Error('CREDITS.md: generated-section markers missing');
  const esc = (x) => String(x).replace(/\|/g, '\\|');
  const rows = [
    '| File | Source (package path) | Author | Licence | Changes |',
    '|---|---|---|---|---|',
    ...credits.map((c) => `| ${bt(c.file)} | ${esc(c.source)} | ${esc(c.author)} | ${esc(c.licence)} | ${esc(c.changes)} |`),
  ];
  writeFileSync(path, text0.slice(0, a + BEGIN.length) + '\n\n' + rows.join('\n') + '\n\n' + text0.slice(b));
}

// ---------------------------------------------------------------------------------------------
// copy the originals that were read (import mode)
// ---------------------------------------------------------------------------------------------
if (opt.import) {
  for (const extra of ['COPYING', 'README.md', 'A-10-readme.txt']) src.used.add(extra);
  for (const rel of [...src.used].sort()) {
    const dst = join(THIRD, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src.abs(rel), dst);
  }
  writeFileSync(join(THIRD, 'FILES.txt'), [...src.used].sort().join('\n') + '\n');
  log(`copied ${src.used.size} original files into third_party/flightgear-a10/`);
}

// ---------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------
const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
log('\nfile                          size      tris   draws  verts');
for (const [f, s] of Object.entries(fileStats))
  log(`${f.padEnd(28)} ${kb(s.bytes).padStart(8)} ${String(s.triangles).padStart(8)} ${String(s.primitives).padStart(6)} ${String(s.vertices).padStart(7)}`);
log(`models ${kb(totalModels)} + meta ${kb(metaBytes)} + textures ${kb(totalTex)} (${texList.length} files) = ${(
  (totalModels + metaBytes + totalTex) /
  1024 /
  1024
).toFixed(2)} MB`);
if (opt.verbose) for (const w of warnings) log('warning:', w);
else log(`${warnings.length} warnings (--verbose to list)`);
