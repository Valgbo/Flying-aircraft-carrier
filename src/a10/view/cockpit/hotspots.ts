/**
 * The "A-10C box": small labelled switches for the controls the FlightGear A-10A cockpit does
 * not have (switches.ts lists them): LASER ARM (ARM / SAFE / TRAIN), TGP power (ON / OFF), ALT
 * SCE (BARO / DELTA / RADAR) in the top row; the autopilot's ENGAGE and MODE buttons and the
 * altitude alert (ALT ALERT, its setting in a small window) in the bottom row.
 * OWNED BY THE COCKPIT MODULE.
 *
 * It is built in code — a small housing with a face plate (stencilled labels on a canvas texture,
 * redrawn only when a read-out changes), toggle levers that show their position and push
 * buttons with lamps — and mounted as an add-on box on the left end of the instrument panel,
 * in the open corner between the HUD control panel and the canopy, turned toward the pilot's
 * eye (BOX_POSE). Each switch has a generous click box in the box's frame for the picker.
 */
import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Euler,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type Material,
} from 'three';
import type { CockpitControlId, CockpitSwitchState } from './switches';

export interface HotspotDef {
  id: CockpitControlId;
  kind: 'toggle3' | 'toggle2' | 'button';
  /** Label above the switch. */
  label: string;
  /** Position names, top to bottom (toggles). */
  positions: readonly string[];
  /** Column (0..2) and row (0 top, 1 bottom) on the face. */
  col: number;
  row: number;
}

/** Face size and housing depth, m. */
export const BOX_SIZE = { width: 0.118, height: 0.094, depth: 0.03 } as const;

export const HOTSPOTS: readonly HotspotDef[] = [
  {
    id: 'laserArm',
    kind: 'toggle3',
    label: 'LASER',
    positions: ['ARM', 'SAFE', 'TRAIN'],
    col: 0,
    row: 0,
  },
  { id: 'tgpPower', kind: 'toggle2', label: 'TGP', positions: ['ON', 'OFF'], col: 1, row: 0 },
  {
    id: 'altSource',
    kind: 'toggle3',
    label: 'ALT SCE',
    positions: ['BARO', 'DELTA', 'RADAR'],
    col: 2,
    row: 0,
  },
  { id: 'autopilot', kind: 'button', label: 'AP', positions: [], col: 0, row: 1 },
  { id: 'autopilotMode', kind: 'button', label: 'AP MODE', positions: [], col: 1, row: 1 },
  { id: 'altitudeAlert', kind: 'button', label: 'ALT ALERT', positions: [], col: 2, row: 1 },
];

/**
 * Where the box sits, BODY frame: the centre of its face, and its turn toward the eye (yaw to
 * the right, then tilt back). The panel's left end is at x ≈ −0.34 m here; the canopy glass at
 * x ≈ −0.45 m.
 */
export const BOX_POSE = {
  position: new Vector3(-0.392, 0.888, -5.2),
  yaw: (26 * Math.PI) / 180,
  tilt: (16 * Math.PI) / 180,
} as const;

/** Centre of a switch on the face (face frame, m: + right, + up). */
export function switchCentre(def: HotspotDef, out: Vector3): Vector3 {
  const cw = BOX_SIZE.width / 3;
  const ch = BOX_SIZE.height / 2;
  return out.set(
    -BOX_SIZE.width / 2 + cw * (def.col + 0.5),
    BOX_SIZE.height / 2 - ch * (def.row + 0.5) - 0.004,
    0,
  );
}

/** Click box half sizes around a switch, face frame (m). */
const HALF = new Vector3(0.017, 0.019, 0.018);

export interface HotspotTarget {
  id: CockpitControlId;
  /** Box in the hotspot group's local frame. */
  min: Vector3;
  max: Vector3;
}

const LEVER_ANGLE = (24 * Math.PI) / 180;

function leverIndex(def: HotspotDef, s: CockpitSwitchState): number {
  switch (def.id) {
    case 'laserArm':
      return s.laserArm === 'ARM' ? 0 : s.laserArm === 'TRAIN' ? 2 : 1;
    case 'tgpPower':
      return s.tgpPower ? 0 : 1;
    case 'altSource':
      return s.altSource === 'BARO' ? 0 : s.altSource === 'RADAR' ? 2 : 1;
    default:
      return 0;
  }
}

export function altAlertText(m: number): string {
  if (!(m > 1)) return 'OFF';
  return `${Math.round(m / 0.3048 / 10) * 10}`;
}

export function apModeText(mode: string): string {
  return mode === 'ALT_HDG' ? 'A/H' : mode;
}

const _c = new Vector3();

export class HotspotBox {
  /** The face frame: origin at the face centre, +X right, +Y up, +Z toward the pilot. */
  readonly group = new Group();
  readonly targets: HotspotTarget[] = [];
  private readonly canvas: HTMLCanvasElement | null;
  private readonly texture: CanvasTexture | null;
  private readonly face: MeshStandardMaterial;
  private readonly levers = new Map<CockpitControlId, Group>();
  private readonly lamps = new Map<CockpitControlId, MeshStandardMaterial>();
  private readonly materials: Material[] = [];
  private readonly geometries: (BoxGeometry | CylinderGeometry | SphereGeometry)[] = [];
  private lastKey = '';

  constructor() {
    this.group.name = 'a10c-box';
    this.group.position.copy(BOX_POSE.position);
    this.group.quaternion.setFromEuler(new Euler(BOX_POSE.tilt, BOX_POSE.yaw, 0, 'YXZ'));
    const W = BOX_SIZE.width;
    const H = BOX_SIZE.height;
    const D = BOX_SIZE.depth;

    this.canvas =
      typeof document === 'undefined'
        ? null
        : (document.createElement('canvas') as HTMLCanvasElement);
    if (this.canvas) {
      this.canvas.width = 512;
      this.canvas.height = Math.round((512 * H) / W);
      this.texture = new CanvasTexture(this.canvas);
      this.texture.colorSpace = SRGBColorSpace;
      this.texture.minFilter = LinearMipmapLinearFilter;
      this.texture.magFilter = LinearFilter;
      this.texture.anisotropy = 8;
    } else this.texture = null;

    // the housing, its face at z = 0 (labels on the +Z side)
    const housingGeo = new BoxGeometry(W + 0.006, H + 0.006, D);
    housingGeo.translate(0, 0, -D / 2);
    const edge = new MeshStandardMaterial({
      name: 'a10c-box-housing',
      color: 0x1d1f21,
      roughness: 0.7,
    });
    this.face = new MeshStandardMaterial({
      name: 'a10c-box-face',
      color: 0xffffff,
      map: this.texture,
      // the stencilled labels glow at dusk, like the panel's instrument lighting
      emissiveMap: this.texture,
      emissive: 0x000000,
      roughness: 0.82,
      metalness: 0.05,
    });
    // BoxGeometry groups: +x, −x, +y, −y, +z, −z
    const housing = new Mesh(housingGeo, [edge, edge, edge, edge, this.face, edge]);
    housing.name = 'a10c-box-housing';
    // the bracket that bolts the box to the end of the instrument panel, behind its right side
    const bracketGeo = new BoxGeometry(0.06, 0.07, 0.004);
    bracketGeo.translate(W / 2 + 0.024, -0.004, -D + 0.002);
    const bracket = new Mesh(bracketGeo, edge);
    bracket.name = 'a10c-box-bracket';
    this.group.add(housing, bracket);
    this.geometries.push(housingGeo, bracketGeo);
    this.materials.push(edge, this.face);

    const leverGeo = new CylinderGeometry(0.0012, 0.0017, 0.012, 10);
    leverGeo.rotateX(Math.PI / 2);
    leverGeo.translate(0, 0, 0.006);
    const tipGeo = new SphereGeometry(0.0024, 12, 8);
    tipGeo.translate(0, 0, 0.0125);
    const collarGeo = new CylinderGeometry(0.0042, 0.0042, 0.003, 16);
    collarGeo.rotateX(Math.PI / 2);
    collarGeo.translate(0, 0, 0.0015);
    const buttonGeo = new BoxGeometry(0.014, 0.009, 0.004);
    buttonGeo.translate(0, 0, 0.002);
    this.geometries.push(leverGeo, tipGeo, collarGeo, buttonGeo);
    const metal = new MeshStandardMaterial({
      name: 'a10c-box-lever',
      color: 0xc4c8cc,
      roughness: 0.32,
      metalness: 0.75,
    });
    const black = new MeshStandardMaterial({
      name: 'a10c-box-collar',
      color: 0x111214,
      roughness: 0.5,
    });
    this.materials.push(metal, black);

    for (const def of HOTSPOTS) {
      const c = switchCentre(def, _c);
      if (def.kind === 'button') {
        const lamp = new MeshStandardMaterial({
          name: `a10c-box-${def.id}`,
          color: 0x2b2d2f,
          roughness: 0.55,
          emissive: 0x000000,
        });
        this.materials.push(lamp);
        const b = new Mesh(buttonGeo, lamp);
        b.position.set(c.x, c.y, 0);
        b.name = `a10c-box-${def.id}`;
        this.group.add(b);
        this.lamps.set(def.id, lamp);
      } else {
        const collar = new Mesh(collarGeo, black);
        collar.position.set(c.x - 0.006, c.y, 0);
        const lever = new Group();
        lever.name = `a10c-box-${def.id}`;
        lever.position.set(c.x - 0.006, c.y, 0.002);
        lever.add(new Mesh(leverGeo, metal), new Mesh(tipGeo, metal));
        this.group.add(collar, lever);
        this.levers.set(def.id, lever);
      }
      this.targets.push({
        id: def.id,
        min: new Vector3(c.x - HALF.x, c.y - HALF.y, -0.002),
        max: new Vector3(c.x + HALF.x, c.y + HALF.y, HALF.z),
      });
    }
    this.group.updateMatrixWorld(true);
  }

  /** Show the switch positions and read-outs (allocation-free unless a read-out changed). */
  update(s: CockpitSwitchState, night: number): void {
    for (const def of HOTSPOTS) {
      const lever = this.levers.get(def.id);
      if (lever) {
        const i = leverIndex(def, s);
        const n = def.positions.length;
        // first position up, last down, middle centred
        const a = n === 2 ? (i === 0 ? 1 : -1) * LEVER_ANGLE : (1 - i) * LEVER_ANGLE;
        lever.rotation.x = -a;
      }
    }
    const ap = this.lamps.get('autopilot');
    if (ap)
      ap.emissive.setRGB(
        s.autopilotEngaged ? 0.1 : 0,
        s.autopilotEngaged ? 1.4 : 0,
        s.autopilotEngaged ? 0.25 : 0,
      );
    const alt = this.lamps.get('altitudeAlert');
    if (alt) alt.emissive.setRGB(s.altitudeAlert > 1 ? 1.2 : 0, s.altitudeAlert > 1 ? 0.75 : 0, 0);
    this.face.emissive.setRGB(night * 0.55, night * 0.45, night * 0.32);
    const key = `${s.autopilotMode}|${altAlertText(s.altitudeAlert)}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.paint(s);
    }
  }

  private paint(s: CockpitSwitchState): void {
    const c = this.canvas;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !this.texture) return;
    const W = c.width;
    const H = c.height;
    const px = W / BOX_SIZE.width;
    ctx.fillStyle = '#2a2d30';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#41464a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, W - 4, H - 4);
    // the row divider
    ctx.beginPath();
    ctx.moveTo(10, H / 2);
    ctx.lineTo(W - 10, H / 2);
    ctx.stroke();
    ctx.fillStyle = '#16181a';
    for (const [x, y] of [
      [10, 10],
      [W - 10, 10],
      [10, H - 10],
      [W - 10, H - 10],
    ]) {
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.textBaseline = 'middle';
    for (const def of HOTSPOTS) {
      const sc = switchCentre(def, _c);
      const x = W / 2 + sc.x * px;
      const y = H / 2 - sc.y * px;
      const top = y - 0.0165 * px;
      ctx.fillStyle = '#ece7da';
      ctx.textAlign = 'center';
      ctx.font = 'bold 21px Arial, Helvetica, sans-serif';
      ctx.fillText(def.label, x, top);
      if (def.kind !== 'button') {
        ctx.font = 'bold 13px Arial, Helvetica, sans-serif';
        ctx.textAlign = 'left';
        const n = def.positions.length;
        const step = 0.0085 * px;
        def.positions.forEach((name, i) => {
          const yy = n === 2 ? y + (i === 0 ? -step : step) : y + (i - 1) * step;
          ctx.fillText(name, x + 0.0012 * px, yy);
        });
      } else {
        const text =
          def.id === 'autopilotMode'
            ? apModeText(s.autopilotMode)
            : def.id === 'altitudeAlert'
              ? altAlertText(s.altitudeAlert)
              : 'ENGAGE';
        const wy = y + 0.0125 * px;
        if (def.id === 'autopilot') {
          ctx.font = 'bold 14px Arial, Helvetica, sans-serif';
          ctx.fillText(text, x, wy);
        } else {
          const w = 0.026 * px;
          ctx.fillStyle = '#0b0d0c';
          ctx.fillRect(x - w / 2, wy - 11, w, 22);
          ctx.fillStyle = '#9dff9f';
          ctx.font = 'bold 17px "Courier New", monospace';
          ctx.fillText(text, x, wy + 1);
        }
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.texture?.dispose();
  }
}
