/**
 * A drum counter for the altimeter. The altimeter in the converted cockpit is a stand-in built by
 * the converter (its FlightGear model lives outside the package): a dial, marks and a needle
 * (one turn per 1,000 ft), no numerals. Like the real AAU-34 altimeter, this adds a counter window
 * left of the dial's centre under the needle — 10,000, 1,000 and 100 ft drums, rolled on like
 * an odometer (simgear step/scroll semantics, instruments.ts). OWNED BY THE COCKPIT MODULE.
 *
 * Geometry from the stand-in (scripts/a10/convert-lib-build.mjs buildAltimeter): dial centre
 * BODY (0.1145, 0.8275, −5.2485), face 3.8 mm behind it, marks at −3.4 mm, needle at −2 mm,
 * face turned 5° up toward the eye.
 */
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { stepScroll } from './instruments';

/** The dial: centre, unit normal toward the eye, unit up along the face (BODY). */
const CENTRE = new Vector3(0.1145, 0.8275, -5.2485);
const NORMAL = new Vector3(0, 0.0872, 0.9962).normalize();
const UP = new Vector3(0, 0.9962, -0.0872).normalize();
/** Depth of the counter along the normal (between the marks and the needle), m. */
const DEPTH = -0.0029;
const DIGIT = { width: 0.0058, height: 0.0084, gap: 0.0004 } as const;
/** Centre of the window across the face (left of the dial centre), m. */
const WINDOW_X = -0.0158;

/** The digit a drum shows for an altitude (fractional while rolling): 10k, 1k, 100 ft. */
export function altimeterDrums(altFt: number, out: Float64Array): Float64Array {
  const a = Math.max(0, Number.isFinite(altFt) ? altFt : 0);
  // the 100 ft drum turns with the needle; the others roll over in the last 100 ft
  out[2] = (a / 100) % 10;
  out[1] = (stepScroll(a, 1000, 100) / 1000) % 10;
  out[0] = (stepScroll(a, 10000, 100) / 10000) % 10;
  return out;
}

function stripTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 640;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#0c0c0c';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#e9e6dc';
  ctx.font = 'bold 54px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 0 at the top … 9 at the bottom: rolling on brings the next digit up from below
  for (let d = 0; d < 10; d++) ctx.fillText(String(d), 32, d * 64 + 34);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

export class AltimeterCounter {
  readonly group = new Group();
  /** Materials of the drums (the cockpit makes them glow at dusk). */
  readonly materials: MeshStandardMaterial[] = [];
  private readonly strip: CanvasTexture | null;
  private readonly geometry: BufferGeometry;
  private readonly backGeometry: BufferGeometry;
  private readonly back: MeshStandardMaterial;
  private readonly drums = new Float64Array(3);

  constructor() {
    this.group.name = 'altimeter-counter';
    this.strip = stripTexture();
    this.geometry = new PlaneGeometry(DIGIT.width, DIGIT.height);
    this.backGeometry = new PlaneGeometry(
      3 * DIGIT.width + 4 * DIGIT.gap + 0.002,
      DIGIT.height + 0.0024,
    );
    this.back = new MeshStandardMaterial({
      name: 'altimeter-window',
      color: 0x050505,
      roughness: 0.6,
    });
    const right = new Vector3().crossVectors(UP, NORMAL).normalize();
    // the face frame: +X across, +Y up, +Z toward the eye
    this.group.matrix.makeBasis(right, UP, NORMAL);
    this.group.matrix.setPosition(CENTRE.clone().addScaledVector(NORMAL, DEPTH));
    this.group.matrixAutoUpdate = false;
    const back = new Mesh(this.backGeometry, this.back);
    back.position.set(WINDOW_X, 0, -0.0002);
    back.name = 'altimeter-window';
    this.group.add(back);
    for (let i = 0; i < 3; i++) {
      const map = this.strip ? this.strip.clone() : null;
      if (map) map.repeat.set(1, 0.1);
      const m = new MeshStandardMaterial({
        name: `altimeter-drum-${i}`,
        color: new Color(1, 1, 1),
        map,
        emissiveMap: map,
        emissive: 0x000000,
        roughness: 0.7,
      });
      this.materials.push(m);
      const d = new Mesh(this.geometry, m);
      d.position.set(WINDOW_X + (i - 1) * (DIGIT.width + DIGIT.gap), 0, 0);
      d.name = `altimeter-drum-${i}`;
      this.group.add(d);
    }
    this.group.updateMatrixWorld(true);
  }

  /** Show an altitude, feet (allocation-free). */
  update(altFt: number): void {
    altimeterDrums(altFt, this.drums);
    for (let i = 0; i < 3; i++) {
      const map = this.materials[i].map;
      // digit d sits at canvas rows d/10 … (d+1)/10 from the top (v = 1 at the top)
      if (map) map.offset.y = 0.9 - this.drums[i] / 10;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.backGeometry.dispose();
    this.back.dispose();
    for (const m of this.materials) {
      m.map?.dispose();
      m.dispose();
    }
    this.strip?.dispose();
  }
}
