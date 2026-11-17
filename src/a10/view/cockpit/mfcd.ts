/**
 * The A-10C's two multifunction colour displays (MFCDs, PLAN_A10.md §7), built in code on the
 * FlightGear A-10A instrument panel. OWNED BY THE COCKPIT MODULE.
 *
 * The FlightGear package's colour display (the A-10A+ MPCD, node `MPCD` of the cockpit model)
 * is one merged mesh with 26 buttons (6 down each side, 7 along the top and bottom) and a laser
 * switch box, not the A-10C's 20-button bezel, so the bezels are made here, sized as the real
 * unit (panelData.ts MFCD): a 4.90 in screen in a 171 mm square bezel, twenty option-select
 * buttons (OSBs), five per edge, numbered 1–20 clockwise from the top left as on the A-10C —
 * 1–5 along the top, 6–10 down the right, 11–15 along the bottom (right to left), 16–20 up the
 * left —, guards between neighbouring buttons, and the corner controls (SYM, CON and BRT
 * rockers, the OFF/NT/DAY knob; decorative: the brightness is the page's own).
 *
 * Draw calls: the two bezels are one merged mesh with one material (its stencilled labels on a
 * canvas texture), the forty OSB caps one InstancedMesh (a press pushes a cap in for
 * MFCD.osbPressTime), and each screen is its display surface (displays.ts).
 */
import {
  BoxGeometry,
  CanvasTexture,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { MFCD, MFCD_MOUNT } from './panelData';
import { PanelGeometryBuilder } from './panelGeometry';

export type MfcdSide = 'L' | 'R';
export const MFCD_SIDES: readonly MfcdSide[] = ['L', 'R'];
export const OSB_COUNT = 20;

/** Where an OSB is on its display's face (face frame, m), and which edge it is on. */
export interface OsbPlacement {
  button: number;
  x: number;
  y: number;
  /** 0 top, 1 right, 2 bottom, 3 left. */
  edge: 0 | 1 | 2 | 3;
}

/** Half the bezel's border width: distance from the screen edge to the button row's centre, m. */
const BAND = (MFCD.bezel - MFCD.screen) / 2;
/** Distance from the screen centre to the centre line of each edge's buttons, m. */
export const OSB_RING = MFCD.screen / 2 + BAND / 2;

/**
 * Face position of OSB `button` (1–20): five per edge, clockwise from the top left — the top
 * edge left to right, the right edge top to bottom, the bottom edge right to left, the left
 * edge bottom to top.
 */
export function osbPlacement(button: number): OsbPlacement {
  const n = MFCD.osbPerSide;
  const i = (button - 1) % n;
  const edge = Math.floor((button - 1) / n) as 0 | 1 | 2 | 3;
  const k = (i - (n - 1) / 2) * MFCD.osbPitch;
  switch (edge) {
    case 0:
      return { button, x: k, y: OSB_RING, edge };
    case 1:
      return { button, x: OSB_RING, y: -k, edge };
    case 2:
      return { button, x: -k, y: -OSB_RING, edge };
    default:
      return { button, x: -OSB_RING, y: k, edge };
  }
}

const _q = new Quaternion();
const _x = new Vector3(1, 0, 0);
const _v = new Vector3();
const _s = new Vector3(1, 1, 1);

/**
 * The face frame of a display in BODY coordinates: the screen centre on the bezel's front face,
 * leaning back with the panel (its top toward the nose).
 */
export function mfcdFaceMatrix(side: MfcdSide, out: Matrix4): Matrix4 {
  _v.set(side === 'L' ? -MFCD_MOUNT.x : MFCD_MOUNT.x, MFCD_MOUNT.y, MFCD_MOUNT.z);
  _q.setFromAxisAngle(_x, -MFCD_MOUNT.tilt);
  return out.compose(_v, _q, _s);
}

/** The screen's corners (BODY): top-left, top-right, bottom-right, bottom-left. */
export function mfcdScreenCorners(side: MfcdSide): [Vector3, Vector3, Vector3, Vector3] {
  const m = mfcdFaceMatrix(side, new Matrix4());
  const h = MFCD.screen / 2;
  const z = -MFCD.recess;
  return [
    new Vector3(-h, h, z).applyMatrix4(m),
    new Vector3(h, h, z).applyMatrix4(m),
    new Vector3(h, -h, z).applyMatrix4(m),
    new Vector3(-h, -h, z).applyMatrix4(m),
  ];
}

/** Index of an OSB in the instanced caps: left display 0–19, right 20–39. */
export function osbIndex(side: MfcdSide, button: number): number {
  return (side === 'L' ? 0 : OSB_COUNT) + button - 1;
}

/** The corner controls (decorative), clockwise from the top left. */
const CORNERS = [
  { label: 'SYM', kind: 'rocker' },
  { label: 'CON', kind: 'rocker' },
  { label: 'BRT', kind: 'rocker' },
  { label: 'OFF NT DAY', kind: 'knob' },
] as const;
/** Corner control centres: top-left, top-right, bottom-right, bottom-left. */
const CORNER_SIGNS: readonly [number, number][] = [
  [-1, 1],
  [1, 1],
  [1, -1],
  [-1, -1],
];

/** One display's static parts in its face frame. */
function bezelBuilder(): PanelGeometryBuilder {
  const g = new PanelGeometryBuilder();
  const B = MFCD.bezel / 2;
  const S = MFCD.screen / 2;
  const D = MFCD.depth;
  // the front face with the screen window, the housing's sides, the window's walls
  g.frame(-B, -B, B, B, -S, -S, S, S, 0);
  g.sides(-B, -B, B, B, D);
  // the window: walls down to just behind the screen, and a dark plate behind it
  g.window(-S, -S, S, S, -MFCD.recess - 0.0012, true);
  // guards between neighbouring buttons on each edge (raised ribs across the band)
  const rib = 0.0016;
  const ribLen = MFCD.osbCap.across + 0.003;
  const ribH = 0.0032;
  for (let e = 0; e < 4; e++) {
    for (let i = 0; i < MFCD.osbPerSide - 1; i++) {
      const k = (i - (MFCD.osbPerSide - 2) / 2) * MFCD.osbPitch;
      if (e === 0 || e === 2) {
        const y = e === 0 ? OSB_RING : -OSB_RING;
        g.box(k - rib / 2, y - ribLen / 2, 0, k + rib / 2, y + ribLen / 2, ribH);
      } else {
        const x = e === 1 ? OSB_RING : -OSB_RING;
        g.box(x - ribLen / 2, k - rib / 2, 0, x + ribLen / 2, k + rib / 2, ribH);
      }
    }
  }
  // corner controls
  for (let c = 0; c < 4; c++) {
    const cx = CORNER_SIGNS[c][0] * OSB_RING;
    const cy = CORNER_SIGNS[c][1] * OSB_RING;
    if (CORNERS[c].kind === 'rocker') {
      // a base plate and the rocker on it, long side vertical
      g.box(cx - 0.0042, cy - 0.0088, 0, cx + 0.0042, cy + 0.0088, 0.0012);
      g.box(cx - 0.0031, cy - 0.0078, 0.0012, cx + 0.0031, cy + 0.0078, 0.0048);
    } else {
      // the OFF/NT/DAY knob with its pointer (at DAY)
      g.cylinder(cx, cy, 0.0058, 0, 0.0058, 16);
      g.box(cx - 0.0006, cy, 0.0058, cx + 0.0006, cy + 0.0052, 0.0068);
    }
  }
  return g;
}

/** Paint the stencilled face: housing colour, button pockets, corner labels. */
function paintFace(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  const px = W / MFCD.bezel;
  const X = (x: number) => W / 2 + x * px;
  const Y = (y: number) => W / 2 - y * px;
  const g = ctx.createLinearGradient(0, 0, 0, W);
  g.addColorStop(0, '#24272a');
  g.addColorStop(1, '#1b1d20');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, W);
  // the plain spot every non-face surface samples (texture corner): the housing colour
  ctx.fillStyle = '#202326';
  ctx.fillRect(0, W - 8, 8, 8);
  // a worn edge and the window's lip
  ctx.strokeStyle = 'rgba(150,158,164,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, W - 4, W - 4);
  const S = MFCD.screen / 2;
  ctx.strokeStyle = 'rgba(8,9,10,0.9)';
  ctx.lineWidth = 5;
  ctx.strokeRect(X(-S) - 3, Y(S) - 3, S * 2 * px + 6, S * 2 * px + 6);
  // button pockets with a light rim, so the buttons read in the glareshield's shadow too
  for (let b = 1; b <= OSB_COUNT; b++) {
    const p = osbPlacement(b);
    const vertical = p.edge === 1 || p.edge === 3;
    const w = (vertical ? MFCD.osbCap.across : MFCD.osbCap.along) + 0.0026;
    const h = (vertical ? MFCD.osbCap.along : MFCD.osbCap.across) + 0.0026;
    ctx.fillStyle = 'rgba(6,7,8,0.85)';
    ctx.fillRect(X(p.x - w / 2), Y(p.y + h / 2), w * px, h * px);
    ctx.strokeStyle = 'rgba(178,184,188,0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(X(p.x - w / 2) - 1, Y(p.y + h / 2) - 1, w * px + 2, h * px + 2);
  }
  // corner labels (white stencil)
  ctx.fillStyle = '#e9e6dc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let c = 0; c < 4; c++) {
    const cx = CORNER_SIGNS[c][0] * OSB_RING;
    const cy = CORNER_SIGNS[c][1] * OSB_RING;
    const corner = CORNERS[c];
    if (corner.kind === 'rocker') {
      // the name beside the rocker, toward the screen; + above and − below it
      const lx = cx - CORNER_SIGNS[c][0] * 0.0102;
      ctx.font = `bold ${Math.round(0.0042 * px)}px Arial, Helvetica, sans-serif`;
      ctx.save();
      ctx.translate(X(lx), Y(cy));
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(corner.label, 0, 0);
      ctx.restore();
      ctx.font = `bold ${Math.round(0.0045 * px)}px Arial, Helvetica, sans-serif`;
      ctx.fillText('+', X(cx), Y(cy + 0.0105));
      ctx.fillText('−', X(cx), Y(cy - 0.0108));
    } else {
      ctx.font = `bold ${Math.round(0.0031 * px)}px Arial, Helvetica, sans-serif`;
      const r = 0.0088;
      const labels: [string, number][] = [
        ['OFF', Math.PI * 0.9],
        ['NT', Math.PI * 0.68],
        ['DAY', Math.PI * 0.5],
      ];
      for (const [text, a] of labels)
        ctx.fillText(text, X(cx + Math.cos(a) * r * 1.15), Y(cy + Math.sin(a) * r));
    }
  }
}

const _m = new Matrix4();
const _mi = new Matrix4();
const _t = new Matrix4();
const _rz = new Matrix4().makeRotationZ(Math.PI / 2);

/** Both MFCD bezels with their OSBs, and the pick frames of their faces. */
export class MfcdPanels {
  readonly group = new Group();
  /** Each display's face frame (pick boxes are in it). */
  readonly faces: Record<MfcdSide, Object3D>;
  /** The static bezels (both displays). */
  readonly bezel: Mesh;
  /** The forty OSB caps. */
  readonly caps: InstancedMesh;
  readonly materials: Material[] = [];
  readonly geometries: BufferGeometry[] = [];
  private readonly texture: CanvasTexture | null;
  private readonly faceMaterial: MeshStandardMaterial;
  /** Seconds of press left per OSB (0 = up). */
  private readonly pressLeft = new Float32Array(OSB_COUNT * 2);
  private capsDirty = true;

  constructor() {
    this.group.name = 'a10c-mfcds';
    const canvas =
      typeof document === 'undefined'
        ? null
        : (document.createElement('canvas') as HTMLCanvasElement);
    if (canvas) {
      canvas.width = 512;
      canvas.height = 512;
      paintFace(canvas);
      this.texture = new CanvasTexture(canvas);
      this.texture.colorSpace = SRGBColorSpace;
      this.texture.minFilter = LinearMipmapLinearFilter;
      this.texture.magFilter = LinearFilter;
      this.texture.anisotropy = 8;
      this.texture.name = 'mfcd-bezel';
    } else this.texture = null;
    this.faceMaterial = new MeshStandardMaterial({
      name: 'mfcd-bezel',
      color: this.texture ? 0xffffff : 0x25282b,
      map: this.texture,
      // the stencilled labels glow at dusk with the panel lighting
      emissiveMap: this.texture,
      emissive: 0x000000,
      roughness: 0.78,
      metalness: 0.08,
    });
    this.materials.push(this.faceMaterial);

    // static bezels, both baked into BODY coordinates
    const one = bezelBuilder();
    const all = new PanelGeometryBuilder();
    const faces = {} as Record<MfcdSide, Object3D>;
    for (const side of MFCD_SIDES) {
      mfcdFaceMatrix(side, _m);
      one.appendTo(all, _m);
      const f = new Object3D();
      f.name = `mfcd-${side}-face`;
      f.matrixAutoUpdate = false;
      f.matrix.copy(_m);
      this.group.add(f);
      faces[side] = f;
    }
    this.faces = faces;
    const bezelGeo = all.build();
    this.geometries.push(bezelGeo);
    this.bezel = new Mesh(bezelGeo, this.faceMaterial);
    this.bezel.name = 'a10c-mfcd-bezels';
    this.group.add(this.bezel);

    // the OSB caps: one instance per button, base on the face
    const c = MFCD.osbCap;
    const capGeo = new BoxGeometry(c.along, c.across, c.height);
    capGeo.translate(0, 0, c.height / 2);
    this.geometries.push(capGeo);
    const capMat = new MeshStandardMaterial({
      name: 'mfcd-osb',
      color: 0x565c61,
      roughness: 0.5,
      metalness: 0.1,
    });
    this.materials.push(capMat);
    this.caps = new InstancedMesh(capGeo, capMat, OSB_COUNT * 2);
    this.caps.name = 'a10c-mfcd-osbs';
    this.caps.instanceMatrix.setUsage(DynamicDrawUsage);
    this.caps.frustumCulled = false;
    this.group.add(this.caps);
    this.updateCaps();
    this.group.updateMatrixWorld(true);
  }

  /** The click box of an OSB in its face frame (around the cap, inside half the pitch). */
  osbBox(button: number, outMin: Vector3, outMax: Vector3): void {
    const p = osbPlacement(button);
    const vertical = p.edge === 1 || p.edge === 3;
    const half = MFCD.osbPitch / 2 - 0.0016;
    const across = MFCD.osbCap.across / 2 + 0.002;
    const hx = vertical ? across : half;
    const hy = vertical ? half : across;
    outMin.set(p.x - hx, p.y - hy, -0.001);
    outMax.set(p.x + hx, p.y + hy, MFCD.osbCap.height + 0.003);
  }

  /** Push a button in (it springs back after MFCD.osbPressTime). */
  pressOsb(side: MfcdSide, button: number): void {
    if (button < 1 || button > OSB_COUNT) return;
    this.pressLeft[osbIndex(side, button)] = MFCD.osbPressTime;
    this.capsDirty = true;
  }

  /** How far a cap is pushed in now, m (for tests and the sandbox). */
  osbDepth(side: MfcdSide, button: number): number {
    return pressDepth(this.pressLeft[osbIndex(side, button)]);
  }

  /** Advance the press animations (real seconds) and the night glow of the labels. */
  update(dt: number, night: number): void {
    const p = this.pressLeft;
    for (let i = 0; i < p.length; i++) {
      if (p[i] > 0) {
        p[i] = Math.max(0, p[i] - Math.max(0, dt));
        this.capsDirty = true;
      }
    }
    if (this.capsDirty) this.updateCaps();
    this.faceMaterial.emissive.setRGB(night * 0.55, night * 0.47, night * 0.36);
  }

  private updateCaps(): void {
    this.capsDirty = false;
    for (const side of MFCD_SIDES) {
      mfcdFaceMatrix(side, _m);
      for (let b = 1; b <= OSB_COUNT; b++) {
        const p = osbPlacement(b);
        const i = osbIndex(side, b);
        _t.makeTranslation(p.x, p.y, -pressDepth(this.pressLeft[i]));
        if (p.edge === 1 || p.edge === 3) _t.multiply(_rz);
        _mi.multiplyMatrices(_m, _t);
        this.caps.setMatrixAt(i, _mi);
      }
    }
    this.caps.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.texture?.dispose();
    this.caps.dispose();
  }
}

/** Cap depth for the press time left: held down for the first 60 %, then springs back. */
export function pressDepth(left: number): number {
  if (!(left > 0)) return 0;
  const t = 1 - left / MFCD.osbPressTime; // 0 → 1 over the press
  if (t < 0.6) return MFCD.osbTravel;
  return MFCD.osbTravel * (1 - (t - 0.6) / 0.4);
}
