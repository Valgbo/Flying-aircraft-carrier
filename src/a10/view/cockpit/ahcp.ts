/**
 * The A-10C armament HUD control panel (AHCP), built in code where the A-10A's armament control
 * panel is on the FlightGear instrument panel (below the left MFCD). OWNED BY THE COCKPIT MODULE.
 *
 * Ten toggle switches in two rows (panelData.ts AHCP):
 *
 *   MASTER ARM   GUN/PAC     LASER ARM   TGP        ALT SCE
 *   ARM          ARM         ARM         ON         BARO
 *   SAFE         SAFE        SAFE        OFF        DELTA
 *   TRAIN        GUNARM      TRAIN                  RADAR
 *
 *   HUD          HUD         CICU        JTRS       IFFCC
 *   DAY          NORM        ON          ON         ON
 *   NIGHT        STBY        OFF         OFF        TEST
 *                                                   OFF
 *
 * The top row is live: each click queues its command (switches.ts, the wave-1 rules: Master Arm
 * and LASER ARM left ARM ↔ SAFE and right TRAIN ↔ SAFE, GUN/PAC and ALT SCE step, TGP toggles)
 * and the levers show the simulation's switch state. The bottom row is decorative: the levers
 * move when clicked (left up, right down) and nothing else happens. Below the AHCP a blank
 * plate covers the rest of the A-10A panel's face.
 *
 * Draw calls: the plate (housing, faces, collars; one material with the stencil texture) and the
 * ten levers (one InstancedMesh).
 */
import {
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
import { AHCP } from './panelData';
import { PanelGeometryBuilder } from './panelGeometry';
import type { CockpitSwitchState } from './switches';

export type AhcpLiveId = 'masterArm' | 'gunPac' | 'laserArm' | 'tgpPower' | 'altSource';
export type AhcpDecorId = 'hudDayNight' | 'hudNormStby' | 'cicu' | 'jtrs' | 'iffcc';
export type AhcpSwitchId = AhcpLiveId | AhcpDecorId;

export interface AhcpSwitchDef {
  id: AhcpSwitchId;
  /** Stencil above the switch ('\n' breaks the line). */
  label: string;
  /** Lever positions, top to bottom. */
  positions: readonly string[];
  row: 0 | 1;
  col: 0 | 1 | 2 | 3 | 4;
  /** True: a simulation switch (queues a command); false: decorative. */
  live: boolean;
}

export const AHCP_SWITCHES: readonly AhcpSwitchDef[] = [
  {
    id: 'masterArm',
    label: 'MASTER\nARM',
    positions: ['ARM', 'SAFE', 'TRAIN'],
    row: 0,
    col: 0,
    live: true,
  },
  {
    id: 'gunPac',
    label: 'GUN/PAC',
    positions: ['ARM', 'SAFE', 'GUNARM'],
    row: 0,
    col: 1,
    live: true,
  },
  {
    id: 'laserArm',
    label: 'LASER\nARM',
    positions: ['ARM', 'SAFE', 'TRAIN'],
    row: 0,
    col: 2,
    live: true,
  },
  { id: 'tgpPower', label: 'TGP', positions: ['ON', 'OFF'], row: 0, col: 3, live: true },
  {
    id: 'altSource',
    label: 'ALT SCE',
    positions: ['BARO', 'DELTA', 'RADAR'],
    row: 0,
    col: 4,
    live: true,
  },
  { id: 'hudDayNight', label: 'HUD', positions: ['DAY', 'NIGHT'], row: 1, col: 0, live: false },
  { id: 'hudNormStby', label: 'HUD', positions: ['NORM', 'STBY'], row: 1, col: 1, live: false },
  { id: 'cicu', label: 'CICU', positions: ['ON', 'OFF'], row: 1, col: 2, live: false },
  { id: 'jtrs', label: 'JTRS', positions: ['ON', 'OFF'], row: 1, col: 3, live: false },
  {
    id: 'iffcc',
    label: 'IFFCC',
    positions: ['ON', 'TEST', 'OFF'],
    row: 1,
    col: 4,
    live: false,
  },
];

/** Decorative switch positions (index into `positions`): all start in their top position. */
export type AhcpDecorState = Record<AhcpDecorId, number>;

export function createAhcpDecorState(): AhcpDecorState {
  return { hudDayNight: 0, hudNormStby: 0, cicu: 0, jtrs: 0, iffcc: 0 };
}

export function ahcpSwitch(id: AhcpSwitchId): AhcpSwitchDef {
  const d = AHCP_SWITCHES.find((s) => s.id === id);
  if (!d) throw new Error(`no AHCP switch ${id}`);
  return d;
}

/** Which position (top = 0) a switch's lever shows. */
export function ahcpPosition(
  def: AhcpSwitchDef,
  s: CockpitSwitchState,
  decor: AhcpDecorState,
): number {
  let value: string;
  switch (def.id) {
    case 'masterArm':
      value = s.masterArm;
      break;
    case 'gunPac':
      value = s.gunPac;
      break;
    case 'laserArm':
      value = s.laserArm;
      break;
    case 'tgpPower':
      value = s.tgpPower ? 'ON' : 'OFF';
      break;
    case 'altSource':
      value = s.altSource;
      break;
    default:
      return Math.max(0, Math.min(def.positions.length - 1, decor[def.id]));
  }
  return Math.max(0, def.positions.indexOf(value));
}

/** A click on a decorative switch: left one position up, right one down (2-way: toggles). */
export function clickDecor(decor: AhcpDecorState, id: AhcpDecorId, button: number): number {
  const n = ahcpSwitch(id).positions.length;
  const cur = decor[id];
  if (n === 2) decor[id] = cur === 0 ? 1 : 0;
  else decor[id] = Math.max(0, Math.min(n - 1, cur + (button === 2 ? 1 : -1)));
  return decor[id];
}

/** The lever angle for a position, rad (+ = tip up). */
export function leverAngle(index: number, count: number): number {
  if (count === 2) return index === 0 ? AHCP.leverThrow : -AHCP.leverThrow;
  return (1 - index) * AHCP.leverThrow;
}

/** Switch centre on the plate's face (face frame, m). */
export function ahcpSwitchCentre(def: AhcpSwitchDef, out: Vector3): Vector3 {
  return out.set((def.col - 2) * AHCP.columnPitch - 0.006, AHCP.rowY[def.row], 0);
}

/** The AHCP's bottom edge on the plate (the blank plate is below it), m. */
const AHCP_BOTTOM = -0.04;

const _q = new Quaternion();
const _x = new Vector3(1, 0, 0);
const _v = new Vector3();
const _s = new Vector3(1, 1, 1);

/** The plate's face frame in BODY coordinates. */
export function ahcpFaceMatrix(out: Matrix4): Matrix4 {
  _v.set(AHCP.centre.x, AHCP.centre.y, AHCP.centre.z);
  _q.setFromAxisAngle(_x, -AHCP.tilt);
  return out.compose(_v, _q, _s);
}

function plateBuilder(): PanelGeometryBuilder {
  const g = new PanelGeometryBuilder();
  const W = AHCP.width / 2;
  const H = AHCP.height / 2;
  // the face (the whole texture), the housing's sides
  g.frame(-W, -H, W, H, 0, 0, 0, 0, 0);
  g.sides(-W, -H, W, H, AHCP.depth);
  // collars of the toggles
  const c = new Vector3();
  for (const def of AHCP_SWITCHES) {
    ahcpSwitchCentre(def, c);
    g.cylinder(c.x, c.y, 0.0046, 0, 0.0028, 16);
  }
  return g;
}

/** The lever: a shaft and a bat-shaped tip along +Z from the pivot. */
function leverBuilder(): PanelGeometryBuilder {
  const g = new PanelGeometryBuilder();
  g.cylinder(0, 0, 0.0013, 0, 0.0115, 10);
  g.cylinder(0, 0, 0.0024, 0.0095, 0.0148, 12);
  return g;
}

function paintPlate(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const Wpx = canvas.width;
  const Hpx = canvas.height;
  const px = Wpx / AHCP.width;
  const X = (x: number) => Wpx / 2 + x * px;
  const Y = (y: number) => Hpx / 2 - y * px;
  ctx.fillStyle = '#2b2e31';
  ctx.fillRect(0, 0, Wpx, Hpx);
  // the plain spot (texture corner) for the housing's sides
  ctx.fillStyle = '#25282b';
  ctx.fillRect(0, Hpx - 8, 8, 8);
  // two plates: the AHCP above, a blank plate below, each with a bevel and four fasteners
  const plates: [number, number][] = [
    [AHCP.height / 2, AHCP_BOTTOM],
    [AHCP_BOTTOM, -AHCP.height / 2],
  ];
  for (const [top, bottom] of plates) {
    const y0 = Y(top) + 2;
    const y1 = Y(bottom) - 2;
    ctx.strokeStyle = 'rgba(160,166,170,0.35)';
    ctx.lineWidth = 3;
    ctx.strokeRect(4, y0 + 2, Wpx - 8, y1 - y0 - 4);
    ctx.strokeStyle = 'rgba(5,6,7,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y1 + 1);
    ctx.lineTo(Wpx, y1 + 1);
    ctx.stroke();
    const r = 0.0026 * px;
    for (const fx of [0.012, AHCP.width - 0.012])
      for (const fy of [y0 + 0.008 * px, y1 - 0.008 * px]) {
        const cx = fx * px;
        ctx.fillStyle = '#1a1c1e';
        ctx.beginPath();
        ctx.arc(cx, fy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(120,126,130,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.7, fy);
        ctx.lineTo(cx + r * 0.7, fy);
        ctx.stroke();
      }
  }
  // stencils
  ctx.fillStyle = '#ece8dd';
  ctx.textBaseline = 'middle';
  const c = new Vector3();
  for (const def of AHCP_SWITCHES) {
    ahcpSwitchCentre(def, c);
    // the switch name above it
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(0.0047 * px)}px Arial, Helvetica, sans-serif`;
    const lines = def.label.split('\n');
    lines.forEach((line, i) => {
      // the last line just above the switch, earlier lines above it
      const y = c.y + 0.0225 + (lines.length - 1 - i) * 0.0058;
      ctx.fillText(line, X(c.x), Y(y));
    });
    // positions right of the lever, top to bottom
    ctx.textAlign = 'left';
    ctx.font = `bold ${Math.round(0.0036 * px)}px Arial, Helvetica, sans-serif`;
    const n = def.positions.length;
    def.positions.forEach((name, i) => {
      const a = leverAngle(i, n);
      const y = c.y + Math.sin(a) * 0.0135;
      ctx.fillText(name, X(c.x + 0.0068), Y(y));
    });
  }
  // a hairline between the rows
  ctx.strokeStyle = 'rgba(200,205,208,0.25)';
  ctx.lineWidth = 2;
  const mid = (AHCP.rowY[0] + AHCP.rowY[1]) / 2 + 0.0035;
  ctx.beginPath();
  ctx.moveTo(X(-AHCP.width / 2 + 0.008), Y(mid));
  ctx.lineTo(X(AHCP.width / 2 - 0.008), Y(mid));
  ctx.stroke();
}

const _m = new Matrix4();
const _t = new Matrix4();
const _r = new Matrix4();
const _c = new Vector3();

/** The AHCP and its blank plate. */
export class Ahcp {
  readonly group = new Group();
  /** The plate's face frame (pick boxes are in it). */
  readonly frame = new Object3D();
  readonly plate: Mesh;
  readonly levers: InstancedMesh;
  readonly decor = createAhcpDecorState();
  readonly materials: Material[] = [];
  readonly geometries: BufferGeometry[] = [];
  private readonly texture: CanvasTexture | null;
  private readonly faceMaterial: MeshStandardMaterial;
  /** Lever position shown per switch (−1 = not drawn yet). */
  private readonly shown = new Int8Array(AHCP_SWITCHES.length).fill(-1);

  constructor() {
    this.group.name = 'a10c-ahcp';
    ahcpFaceMatrix(_m);
    this.frame.name = 'a10c-ahcp-face';
    this.frame.matrixAutoUpdate = false;
    this.frame.matrix.copy(_m);
    this.group.add(this.frame);

    const canvas =
      typeof document === 'undefined'
        ? null
        : (document.createElement('canvas') as HTMLCanvasElement);
    if (canvas) {
      canvas.width = 1024;
      canvas.height = Math.round((1024 * AHCP.height) / AHCP.width);
      paintPlate(canvas);
      this.texture = new CanvasTexture(canvas);
      this.texture.colorSpace = SRGBColorSpace;
      this.texture.minFilter = LinearMipmapLinearFilter;
      this.texture.magFilter = LinearFilter;
      this.texture.anisotropy = 8;
      this.texture.name = 'ahcp';
    } else this.texture = null;
    this.faceMaterial = new MeshStandardMaterial({
      name: 'a10c-ahcp',
      color: this.texture ? 0xffffff : 0x2b2e31,
      map: this.texture,
      emissiveMap: this.texture,
      emissive: 0x000000,
      roughness: 0.8,
      metalness: 0.06,
    });
    this.materials.push(this.faceMaterial);
    const plateGeo = plateBuilder().build(_m);
    this.geometries.push(plateGeo);
    this.plate = new Mesh(plateGeo, this.faceMaterial);
    this.plate.name = 'a10c-ahcp-plate';
    this.group.add(this.plate);

    const leverGeo = leverBuilder().build();
    this.geometries.push(leverGeo);
    const metal = new MeshStandardMaterial({
      name: 'a10c-ahcp-lever',
      color: 0xc9cdd1,
      roughness: 0.3,
      metalness: 0.8,
    });
    this.materials.push(metal);
    this.levers = new InstancedMesh(leverGeo, metal, AHCP_SWITCHES.length);
    this.levers.name = 'a10c-ahcp-levers';
    this.levers.instanceMatrix.setUsage(DynamicDrawUsage);
    this.levers.frustumCulled = false;
    this.group.add(this.levers);
    this.group.updateMatrixWorld(true);
  }

  /** The click box of a switch in the face frame. */
  switchBox(id: AhcpSwitchId, outMin: Vector3, outMax: Vector3): void {
    ahcpSwitchCentre(ahcpSwitch(id), _c);
    outMin.set(_c.x - 0.0125, _c.y - 0.0155, -0.001);
    outMax.set(_c.x + 0.0125, _c.y + 0.0155, 0.018);
  }

  /** Show the switch positions (levers move only when a position changed) and the night glow. */
  update(s: CockpitSwitchState, night: number): void {
    let dirty = false;
    for (let i = 0; i < AHCP_SWITCHES.length; i++) {
      const def = AHCP_SWITCHES[i];
      const p = ahcpPosition(def, s, this.decor);
      if (p === this.shown[i]) continue;
      this.shown[i] = p;
      dirty = true;
      ahcpSwitchCentre(def, _c);
      ahcpFaceMatrix(_m);
      _t.makeTranslation(_c.x, _c.y, 0.0026);
      // + angle tips the lever up: rotate the +Z lever about −X
      _r.makeRotationX(-leverAngle(p, def.positions.length));
      _m.multiply(_t).multiply(_r);
      this.levers.setMatrixAt(i, _m);
    }
    if (dirty) this.levers.instanceMatrix.needsUpdate = true;
    this.faceMaterial.emissive.setRGB(night * 0.55, night * 0.47, night * 0.36);
  }

  /** The position a switch shows now (top = 0), for tests and the sandbox. */
  shownPosition(id: AhcpSwitchId): number {
    return this.shown[AHCP_SWITCHES.findIndex((d) => d.id === id)];
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.texture?.dispose();
    this.levers.dispose();
  }
}
