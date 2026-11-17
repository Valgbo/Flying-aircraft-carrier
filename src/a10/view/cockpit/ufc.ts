/**
 * The A-10C up-front controller (UFC), built in code under the HUD where the A-10A has its small
 * altitude-alert panel. OWNED BY THE COCKPIT MODULE.
 *
 *   [1] [2] [3] [4] [5]    [ENT ] [FWD]    DATA SEL DEPR INTEN STEER   [MASTER ]
 *   [6] [7] [8] [9] [0]    [MK  ] [MID]     ▲    ▲   ▲    ▲     ▲     [CAUTION]
 *   [SPC][HACK][FUNC][LTR][CLR] [ALT ] [AFT]  ▼    ▼   ▼    ▼     ▼
 *                               [ALRT]
 *
 * What the simulation supports today: STEER ▲/▼ steps the steerpoint ({ type: 'steerpoint' }),
 * ALT ALRT steps the altitude alert (left up, right down: the wave-1 altitude-alert control),
 * and the MASTER CAUTION lamp lights with the flight's master caution (it replaces the A-10A's
 * lamp, which the left MFCD covers). The avionics has a UFC scratchpad for laser codes (type four
 * digits, then press CODE on the DSMS or TGP page; CLR empties it: core/avionics ufcKey), and
 * `ufcScratchpadKey` gives the key it takes for each of our keys — but no Command carries a key
 * press to it yet (core/types.ts is the foundation's: the module report asks for
 * `{ type: 'ufc'; key: string }`, as the avionics module did). Until then the digits, CLR, ENT
 * and the other keys move when pressed and queue nothing; the codes are set on the DSMS and TGP
 * pages' OSBs (CODE moves the cursor digit, INC steps it).
 *
 * Draw calls: the plate (stencils and every key legend on one canvas texture), the key caps (one
 * merged mesh: each cap's top samples its legend from the same texture; a press moves only that
 * cap's vertices) and the master-caution lamp (its own unlit material, amber when lit).
 */
import {
  BufferAttribute,
  CanvasTexture,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { UFC } from './panelData';
import { PanelGeometryBuilder } from './panelGeometry';

export type UfcKeyId =
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '0'
  | 'SPC'
  | 'HACK'
  | 'FUNC'
  | 'LTR'
  | 'CLR'
  | 'ENT'
  | 'MK'
  | 'ALT_ALRT'
  | 'FWD'
  | 'MID'
  | 'AFT'
  | 'DATA_UP'
  | 'DATA_DN'
  | 'SEL_UP'
  | 'SEL_DN'
  | 'DEPR_UP'
  | 'DEPR_DN'
  | 'INTEN_UP'
  | 'INTEN_DN'
  | 'STEER_UP'
  | 'STEER_DN'
  | 'MASTER_CAUTION';

export interface UfcKeyDef {
  id: UfcKeyId;
  /** Legend on the cap ('\n' breaks the line; '▲'/'▼' on rocker halves). */
  legend: string;
  /** Name on the hover label. */
  name: string;
  /** Grid cell (column from the left, row from the top) of the cap's centre. */
  col: number;
  row: number;
  /** Size in cells (default 1 × 1). */
  w?: number;
  h?: number;
}

const DIGITS: UfcKeyId[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const ROCKERS: readonly [string, number][] = [
  ['DATA', 9],
  ['SEL', 10],
  ['DEPR', 11],
  ['INTEN', 12],
  ['STEER', 13],
];

export const UFC_KEYS: readonly UfcKeyDef[] = [
  ...DIGITS.map((d, i) => ({ id: d, legend: d, name: d, col: i % 5, row: Math.floor(i / 5) })),
  { id: 'SPC', legend: 'SPC', name: 'SPC', col: 0, row: 2 },
  { id: 'HACK', legend: 'HACK', name: 'HACK', col: 1, row: 2 },
  { id: 'FUNC', legend: 'FUNC', name: 'FUNC', col: 2, row: 2 },
  { id: 'LTR', legend: 'LTR', name: 'LTR', col: 3, row: 2 },
  { id: 'CLR', legend: 'CLR', name: 'CLR', col: 4, row: 2 },
  { id: 'ENT', legend: 'ENT', name: 'ENT', col: 6, row: 0 },
  { id: 'MK', legend: 'MK', name: 'MARK', col: 6, row: 1 },
  { id: 'ALT_ALRT', legend: 'ALT\nALRT', name: 'ALT ALRT', col: 6, row: 2 },
  { id: 'FWD', legend: 'FWD', name: 'FWD', col: 7, row: 0 },
  { id: 'MID', legend: 'MID', name: 'MID', col: 7, row: 1 },
  { id: 'AFT', legend: 'AFT', name: 'AFT', col: 7, row: 2 },
  ...ROCKERS.flatMap(([n, col]) => [
    { id: `${n}_UP` as UfcKeyId, legend: '▲', name: `${n} ▲`, col, row: 0.08 },
    { id: `${n}_DN` as UfcKeyId, legend: '▼', name: `${n} ▼`, col, row: 0.92 },
  ]),
  {
    id: 'MASTER_CAUTION',
    legend: 'MASTER\nCAUTION',
    name: 'MASTER CAUTION',
    col: 14.75,
    row: 0.5,
    w: 1.32,
    h: 1.75,
  },
];

/**
 * The key the avionics' UFC scratchpad takes for one of our keys (digits and CLR; STEER goes as
 * the `steerpoint` command), or null. Ready for a `{ type: 'ufc'; key }` command (module report).
 */
export function ufcScratchpadKey(id: UfcKeyId): string | null {
  if (id.length === 1 && id >= '0' && id <= '9') return id;
  return id === 'CLR' ? 'CLR' : null;
}

export function ufcKey(id: UfcKeyId): UfcKeyDef {
  const d = UFC_KEYS.find((k) => k.id === id);
  if (!d) throw new Error(`no UFC key ${id}`);
  return d;
}

/** Centre of a key cell on the face (face frame, m). */
export function ufcKeyCentre(def: UfcKeyDef, out: Vector3): Vector3 {
  const x0 = -7.5 * UFC.pitchX;
  return out.set(x0 + def.col * UFC.pitchX, (1 - def.row) * UFC.pitchY, 0);
}

/** Half size of a key's cap on the face, m. */
export function ufcKeyHalf(def: UfcKeyDef): { x: number; y: number } {
  const w = def.w ?? 1;
  const h = def.h ?? 1;
  // rocker halves are a little taller and touch in the middle
  const rocker = def.id.endsWith('_UP') || def.id.endsWith('_DN');
  return {
    x: (UFC.key.w + (w - 1) * UFC.pitchX) / 2,
    y: rocker ? UFC.pitchY * 0.44 : (UFC.key.h + (h - 1) * UFC.pitchY) / 2,
  };
}

const _q = new Quaternion();
const _xAxis = new Vector3(1, 0, 0);
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);

/** The UFC's face frame in BODY coordinates. */
export function ufcFaceMatrix(out: Matrix4): Matrix4 {
  _p.set(UFC.centre.x, UFC.centre.y, UFC.centre.z);
  _q.setFromAxisAngle(_xAxis, -UFC.tilt);
  return out.compose(_p, _q, _s);
}

/** Texture layout: px per metre of face; the face is the whole canvas. */
const TEX_W = 1024;
const TEX_H = Math.round((TEX_W * UFC.height) / UFC.width);
const PX = TEX_W / UFC.width;
const tx = (x: number) => TEX_W / 2 + x * PX;
const ty = (y: number) => TEX_H / 2 - y * PX;
/** The texture spot every cap side samples (a cap-coloured block in the top-left corner). */
const CAP_SIDE_UV: readonly [number, number] = [3 / TEX_W, 1 - 3 / TEX_H];

function paintUfc(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#2a2d30';
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  ctx.fillStyle = '#25282b';
  ctx.fillRect(0, TEX_H - 8, 8, 8);
  ctx.fillStyle = '#3e4347';
  ctx.fillRect(0, 0, 8, 8);
  ctx.strokeStyle = 'rgba(160,166,170,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, TEX_W - 4, TEX_H - 4);
  const c = new Vector3();
  // rocker names under the rockers
  ctx.fillStyle = '#ece8dd';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(0.0034 * PX)}px Arial, Helvetica, sans-serif`;
  for (const [name, col] of ROCKERS)
    ctx.fillText(name, tx(-7.5 * UFC.pitchX + col * UFC.pitchX), ty(-UFC.pitchY * 1.02));
  // every key's cap face with its legend (the caps' tops sample these squares)
  for (const def of UFC_KEYS) {
    if (def.id === 'MASTER_CAUTION') continue;
    ufcKeyCentre(def, c);
    const h = ufcKeyHalf(def);
    ctx.fillStyle = '#3e4347';
    ctx.fillRect(tx(c.x - h.x), ty(c.y + h.y), h.x * 2 * PX, h.y * 2 * PX);
    ctx.fillStyle = '#f2efe6';
    const lines = def.legend.split('\n');
    const size = lines.length > 1 || def.legend.length > 3 ? 0.0027 : 0.0042;
    ctx.font = `bold ${Math.round(size * PX)}px Arial, Helvetica, sans-serif`;
    lines.forEach((line, i) => {
      const dy = (i - (lines.length - 1) / 2) * size * 1.15;
      ctx.fillText(line, tx(c.x), ty(c.y - dy));
    });
  }
}

/** One key cap: its first vertex and vertex count in the caps geometry. */
interface CapRange {
  start: number;
  count: number;
}

const _m = new Matrix4();
const _n = new Vector3();

/** The UFC: plate, key caps, master-caution lamp. */
export class Ufc {
  readonly group = new Group();
  /** The face frame (pick boxes are in it). */
  readonly frame = new Object3D();
  readonly plate: Mesh;
  readonly caps: Mesh;
  readonly lamp: Mesh;
  readonly materials: Material[] = [];
  readonly geometries: BufferGeometry[] = [];
  private readonly texture: CanvasTexture | null;
  private readonly lampTexture: CanvasTexture | null;
  private readonly lampMaterial: MeshBasicMaterial;
  private readonly plateMaterial: MeshStandardMaterial;
  private readonly ranges = new Map<UfcKeyId, CapRange>();
  private readonly rest: Float32Array;
  private readonly pressLeft = new Map<UfcKeyId, number>();
  /** Face normal in BODY (a pressed cap moves against it). */
  private readonly normal = new Vector3();
  private lampLit: boolean | null = null;

  constructor() {
    this.group.name = 'a10c-ufc';
    ufcFaceMatrix(_m);
    this.frame.name = 'a10c-ufc-face';
    this.frame.matrixAutoUpdate = false;
    this.frame.matrix.copy(_m);
    this.group.add(this.frame);
    this.normal.set(0, 0, 1).transformDirection(_m);

    const canvas =
      typeof document === 'undefined'
        ? null
        : (document.createElement('canvas') as HTMLCanvasElement);
    if (canvas) {
      canvas.width = TEX_W;
      canvas.height = TEX_H;
      paintUfc(canvas);
      this.texture = new CanvasTexture(canvas);
      this.texture.colorSpace = SRGBColorSpace;
      this.texture.minFilter = LinearMipmapLinearFilter;
      this.texture.magFilter = LinearFilter;
      this.texture.anisotropy = 8;
      this.texture.name = 'ufc';
    } else this.texture = null;
    this.plateMaterial = new MeshStandardMaterial({
      name: 'a10c-ufc',
      color: this.texture ? 0xffffff : 0x2a2d30,
      map: this.texture,
      emissiveMap: this.texture,
      emissive: 0x000000,
      roughness: 0.75,
      metalness: 0.06,
    });
    this.materials.push(this.plateMaterial);

    // the plate
    const W = UFC.width / 2;
    const H = UFC.height / 2;
    const plate = new PanelGeometryBuilder();
    plate.frame(-W, -H, W, H, 0, 0, 0, 0, 0);
    plate.sides(-W, -H, W, H, UFC.depth);
    const plateGeo = plate.build(_m);
    this.geometries.push(plateGeo);
    this.plate = new Mesh(plateGeo, this.plateMaterial);
    this.plate.name = 'a10c-ufc-plate';
    this.group.add(this.plate);

    // the key caps: tops sample their legends, sides the cap colour
    const caps = new PanelGeometryBuilder();
    const c = new Vector3();
    const uv = (x: number, y: number): [number, number] => [tx(x) / TEX_W, 1 - ty(y) / TEX_H];
    for (const def of UFC_KEYS) {
      if (def.id === 'MASTER_CAUTION') continue;
      ufcKeyCentre(def, c);
      const h = ufcKeyHalf(def);
      const start = caps.positions.length / 3;
      const x0 = c.x - h.x;
      const x1 = c.x + h.x;
      const y0 = c.y - h.y;
      const y1 = c.y + h.y;
      const z1 = UFC.key.height;
      caps.box(x0, y0, 0, x1, y1, z1, [uv(x0, y0), uv(x1, y0), uv(x1, y1), uv(x0, y1)]);
      this.ranges.set(def.id, { start, count: caps.positions.length / 3 - start });
    }
    // cap sides: the plain spot is the plate's; point them at the cap colour instead
    for (let i = 0; i < caps.uvs.length; i += 2) {
      if (caps.uvs[i] === 0.004 && caps.uvs[i + 1] === 0.004) {
        caps.uvs[i] = CAP_SIDE_UV[0];
        caps.uvs[i + 1] = CAP_SIDE_UV[1];
      }
    }
    const capsGeo = caps.build(_m);
    this.geometries.push(capsGeo);
    this.rest = Float32Array.from(capsGeo.getAttribute('position').array as Float32Array);
    const capMaterial = new MeshStandardMaterial({
      name: 'a10c-ufc-keys',
      color: this.texture ? 0xffffff : 0x3e4347,
      map: this.texture,
      roughness: 0.6,
      metalness: 0.05,
    });
    this.materials.push(capMaterial);
    this.caps = new Mesh(capsGeo, capMaterial);
    this.caps.name = 'a10c-ufc-keys';
    this.group.add(this.caps);

    // the master-caution lamp: its own legend texture, unlit (it glows amber when lit)
    const lampDef = ufcKey('MASTER_CAUTION');
    ufcKeyCentre(lampDef, c);
    const lh = ufcKeyHalf(lampDef);
    const lamp = new PanelGeometryBuilder();
    lamp.box(c.x - lh.x, c.y - lh.y, 0, c.x + lh.x, c.y + lh.y, UFC.key.height, [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    const lampGeo = lamp.build(_m);
    this.geometries.push(lampGeo);
    this.ranges.set('MASTER_CAUTION', { start: 0, count: 0 });
    const lampCanvas =
      typeof document === 'undefined'
        ? null
        : (document.createElement('canvas') as HTMLCanvasElement);
    if (lampCanvas) {
      lampCanvas.width = 128;
      lampCanvas.height = Math.round((128 * lh.y) / lh.x);
      this.lampTexture = new CanvasTexture(lampCanvas);
      this.lampTexture.colorSpace = SRGBColorSpace;
      this.lampTexture.name = 'ufc-master-caution';
    } else this.lampTexture = null;
    this.lampMaterial = new MeshBasicMaterial({
      name: 'a10c-ufc-master-caution',
      map: this.lampTexture,
      color: 0xffffff,
      toneMapped: false,
    });
    this.materials.push(this.lampMaterial);
    this.lamp = new Mesh(lampGeo, this.lampMaterial);
    this.lamp.name = 'a10c-ufc-master-caution';
    this.group.add(this.lamp);
    this.setLamp(false);
    this.group.updateMatrixWorld(true);
  }

  /** The click box of a key in the face frame. */
  keyBox(id: UfcKeyId, outMin: Vector3, outMax: Vector3): void {
    const def = ufcKey(id);
    ufcKeyCentre(def, outMin);
    const h = ufcKeyHalf(def);
    const cx = outMin.x;
    const cy = outMin.y;
    outMin.set(cx - h.x - 0.0008, cy - h.y - 0.0008, -0.001);
    outMax.set(cx + h.x + 0.0008, cy + h.y + 0.0008, UFC.key.height + 0.003);
  }

  /** Push a key in (it springs back after the press time). */
  press(id: UfcKeyId): void {
    this.pressLeft.set(id, PRESS_TIME);
  }

  /** How far a key is pushed in now, m. */
  keyDepth(id: UfcKeyId): number {
    return keyDepth(this.pressLeft.get(id) ?? 0);
  }

  /** Advance the key presses (real seconds), the lamp and the night glow. */
  update(dt: number, masterCaution: boolean, night: number): void {
    if (this.pressLeft.size > 0) {
      const pos = this.caps.geometry.getAttribute('position') as BufferAttribute;
      const arr = pos.array as Float32Array;
      for (const [id, left] of this.pressLeft) {
        const next = Math.max(0, left - Math.max(0, dt));
        const r = this.ranges.get(id);
        if (r && r.count > 0) {
          const d = -keyDepth(next);
          _n.copy(this.normal).multiplyScalar(d);
          for (let v = r.start; v < r.start + r.count; v++) {
            arr[v * 3] = this.rest[v * 3] + _n.x;
            arr[v * 3 + 1] = this.rest[v * 3 + 1] + _n.y;
            arr[v * 3 + 2] = this.rest[v * 3 + 2] + _n.z;
          }
        }
        if (next > 0) this.pressLeft.set(id, next);
        else this.pressLeft.delete(id);
      }
      pos.needsUpdate = true;
    }
    if (masterCaution !== this.lampLit) this.setLamp(masterCaution);
    this.plateMaterial.emissive.setRGB(night * 0.55, night * 0.47, night * 0.36);
  }

  private setLamp(lit: boolean): void {
    this.lampLit = lit;
    const c = this.lampTexture?.image as HTMLCanvasElement | undefined;
    const ctx = c?.getContext('2d');
    if (c && ctx && this.lampTexture) {
      ctx.fillStyle = lit ? '#ffb31a' : '#2c2a24';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = lit ? '#ffe2a0' : '#4a463c';
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, c.width - 4, c.height - 4);
      ctx.fillStyle = lit ? '#2a1600' : '#8d8676';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.round(c.width * 0.2)}px Arial, Helvetica, sans-serif`;
      ctx.fillText('MASTER', c.width / 2, c.height * 0.38);
      ctx.fillText('CAUTION', c.width / 2, c.height * 0.62);
      this.lampTexture.needsUpdate = true;
    } else {
      this.lampMaterial.color.set(lit ? 0xffb31a : 0x2c2a24);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.texture?.dispose();
    this.lampTexture?.dispose();
  }
}

const PRESS_TIME = 0.16;

/** Key depth for the press time left: held for the first 60 %, then springs back. */
function keyDepth(left: number): number {
  if (!(left > 0)) return 0;
  const t = 1 - left / PRESS_TIME;
  if (t < 0.6) return UFC.keyTravel;
  return UFC.keyTravel * (1 - (t - 0.6) / 0.4);
}
