/**
 * The autopilot's controls on the LASTE panel of the FlightGear cockpit (view/cockpit/laste.ts):
 * the ENGAGE/DISENGAGE button and the PATH – ALT/HDG – ALT switch are the model's own parts,
 * merged into its static mesh. The tests build a stand-in of that mesh quantized exactly as the
 * converter writes it (Int16 positions, Int8 normals, padded strides → interleaved attributes,
 * the node's offset and scale) and check that the lever shows the mode, the cap goes in when
 * clicked, nothing else moves and the template geometry stays untouched.
 */
import { describe, expect, it } from 'vitest';
import {
  Box3,
  BufferGeometry,
  Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  Object3D,
  Ray,
  Vector3,
} from 'three';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { clickCommand } from '../../../src/a10/view/cockpit/clickables';
import {
  LASTE_MODE_ORDER,
  LastePanel,
  lasteControlBox,
  lasteLeverAngle,
  lastePressDepth,
} from '../../../src/a10/view/cockpit/laste';
import { LASTE } from '../../../src/a10/view/cockpit/panelData';
import { pickTarget, type PickTarget } from '../../../src/a10/view/cockpit/picking';
import {
  COCKPIT_CONTROLS,
  createSwitchState,
  type CockpitSwitchState,
} from '../../../src/a10/view/cockpit/switches';

const EYE = new Vector3(A10_GEOMETRY.eye.x, A10_GEOMETRY.eye.y, A10_GEOMETRY.eye.z);
const LEFT = 0;
const RIGHT = 2;
/** The static mesh node's quantization offset and scale in the converted cockpit. */
const NODE_T = new Vector3(0.165885, 0.712705, -5.310925);
const NODE_S = 1.002615;
/** One quantization step, m. */
const Q = NODE_S / 32767;

const L = LASTE.lever;
const B = LASTE.button;
/** BODY points of the stand-in mesh. */
const PTS = {
  /** The shaft just under the bezel's top: below the pivot, it stays. */
  leverBase: new Vector3(L.x, L.pivot - 0.0004, L.z),
  leverMid: new Vector3(L.x, 0.421, L.z),
  leverTip: new Vector3(L.x, L.tip, L.z),
  leverBat: new Vector3(L.x + 0.003, L.tip - 0.001, L.z + 0.002),
  /** The switch's collar ring and the bezel under it: below the pivot, they stay. */
  collar: new Vector3(L.x + 0.0038, 0.412, L.z),
  bezel: new Vector3(L.x - 0.003, 0.4154, L.z + 0.002),
  capTop: new Vector3(B.x, B.top, B.z),
  capEdge: new Vector3(B.x + 0.0025, B.top, B.z - 0.001),
  /** The cap's foot ring: it stays (the cap's sides shorten when it goes in). */
  capFoot: new Vector3(B.x + 0.003, 0.412, B.z),
  /** The RDR ALTM switch 3 cm left of the button: another part, never moved. */
  radarAltSwitch: new Vector3(-0.3751, 0.428, -4.8104),
};
type PointName = keyof typeof PTS;
const NAMES = Object.keys(PTS) as PointName[];

/** A stand-in for the cockpit's merged static mesh, as GLTFLoader builds a quantized primitive. */
function standInCockpit(): { root: Group; mesh: Mesh; template: BufferGeometry } {
  const pos = new Int16Array(NAMES.length * 4);
  const nrm = new Int8Array(NAMES.length * 4);
  NAMES.forEach((n, i) => {
    const p = PTS[n];
    pos[i * 4] = Math.round(((p.x - NODE_T.x) / NODE_S) * 32767);
    pos[i * 4 + 1] = Math.round(((p.y - NODE_T.y) / NODE_S) * 32767);
    pos[i * 4 + 2] = Math.round(((p.z - NODE_T.z) / NODE_S) * 32767);
    nrm[i * 4 + 1] = 127; // +Y
  });
  const g = new BufferGeometry();
  g.setAttribute(
    'position',
    new InterleavedBufferAttribute(new InterleavedBuffer(pos, 4), 3, 0, true),
  );
  g.setAttribute(
    'normal',
    new InterleavedBufferAttribute(new InterleavedBuffer(nrm, 4), 3, 0, true),
  );
  const mesh = new Mesh(g);
  const node = new Group();
  node.position.copy(NODE_T);
  node.scale.setScalar(NODE_S);
  node.add(mesh);
  const root = new Group();
  root.add(node);
  root.updateMatrixWorld(true);
  return { root, mesh, template: g };
}

/** BODY position of a stand-in point as the mesh draws it now. */
function drawn(mesh: Mesh, name: PointName): Vector3 {
  const i = NAMES.indexOf(name);
  mesh.updateMatrixWorld(true);
  return new Vector3()
    .fromBufferAttribute(mesh.geometry.attributes.position, i)
    .applyMatrix4(mesh.matrixWorld);
}

function state(patch: Partial<CockpitSwitchState> = {}): CockpitSwitchState {
  return { ...createSwitchState(), ...patch };
}

function expectAt(got: Vector3, want: Vector3, what: string): void {
  expect(got.distanceTo(want), `${what}: ${got.toArray()} vs ${want.toArray()}`).toBeLessThan(
    3 * Q,
  );
}

describe('the LASTE panel autopilot controls', () => {
  it('queues the autopilot commands: left engages or disengages, right disengages, the switch steps the mode', () => {
    const s = state();
    expect(clickCommand('autopilot', LEFT, s)).toEqual({ type: 'autopilot', action: 'toggle' });
    expect(clickCommand('autopilot', RIGHT, s)).toEqual({ type: 'autopilot', action: 'disengage' });
    expect(clickCommand('autopilotMode', LEFT, s)).toEqual({ type: 'autopilot', action: 'mode' });
    expect(clickCommand('autopilotMode', RIGHT, s)).toEqual({ type: 'autopilot', action: 'mode' });
    for (const id of ['autopilot', 'autopilotMode'] as const)
      expect(COCKPIT_CONTROLS.find((c) => c.id === id)?.target.kind).toBe('laste');
  });

  it("puts the click boxes on the model's button and lever, apart, each the first hit from the eye", () => {
    const button = lasteControlBox('autopilot', new Box3());
    const lever = lasteControlBox('autopilotMode', new Box3());
    expect(button.containsPoint(PTS.capTop)).toBe(true);
    expect(lever.containsPoint(PTS.leverTip)).toBe(true);
    expect(lever.containsPoint(PTS.leverBase)).toBe(true);
    // the lever's bat at either end of its throw stays inside its box
    for (const a of [-LASTE.leverThrow, LASTE.leverThrow]) {
      const tip = new Vector3(
        L.x,
        L.pivot + (L.tip - L.pivot) * Math.cos(a),
        L.z + (L.tip - L.pivot) * Math.sin(a),
      );
      expect(lever.containsPoint(tip)).toBe(true);
    }
    expect(
      button.clone().expandByScalar(0.003).intersectsBox(lever.clone().expandByScalar(0.003)),
    ).toBe(false);
    // the RDR ALTM switch beside the button is not part of either box
    expect(button.clone().expandByScalar(0.003).containsPoint(PTS.radarAltSwitch)).toBe(false);
    const frame = new Object3D();
    frame.updateMatrixWorld(true);
    const targets: PickTarget[] = [
      { id: 'autopilot', label: 'AUTOPILOT', frame, box: button, pad: 0.003 },
      { id: 'autopilotMode', label: 'AUTOPILOT MODE', frame, box: lever, pad: 0.003 },
    ];
    const ray = (p: Vector3) => new Ray(EYE.clone(), p.clone().sub(EYE).normalize());
    expect(pickTarget(targets, ray(PTS.capTop))?.id).toBe('autopilot');
    expect(pickTarget(targets, ray(PTS.leverTip))?.id).toBe('autopilotMode');
  });

  it('shows the mode on the lever: PATH forward, ALT/HDG centre, ALT aft', () => {
    expect(LASTE_MODE_ORDER).toEqual(['PATH', 'ALT_HDG', 'ALT']);
    expect(lasteLeverAngle('PATH')).toBeCloseTo(-LASTE.leverThrow, 12);
    expect(lasteLeverAngle('ALT_HDG')).toBe(0);
    expect(lasteLeverAngle('ALT')).toBeCloseTo(LASTE.leverThrow, 12);

    const { root, mesh, template } = standInCockpit();
    const own: BufferGeometry[] = [];
    const panel = new LastePanel(root, own);
    // the lever's three vertices above the pivot, the cap's two top vertices — nothing else
    expect(panel.lever.count).toBe(3);
    expect(panel.button.count).toBe(2);
    // one private copy of the primitive for both parts: the template keeps its vertices
    expect(mesh.geometry).not.toBe(template);
    expect(own).toEqual([mesh.geometry]);

    const h = L.tip - L.pivot;
    const sin = Math.sin(LASTE.leverThrow);
    const cos = Math.cos(LASTE.leverThrow);
    panel.update(state({ autopilotMode: 'PATH' }), 0);
    // the bat tips toward the nose (−Z) and down by the throw; the pivot stays
    expectAt(
      drawn(mesh, 'leverTip'),
      new Vector3(L.x, L.pivot + h * cos, L.z - h * sin),
      'PATH tip',
    );
    for (const n of [
      'leverBase',
      'collar',
      'bezel',
      'capTop',
      'capFoot',
      'radarAltSwitch',
    ] as const)
      expectAt(drawn(mesh, n), PTS[n], n);
    // the template is untouched
    expectAt(
      new Vector3()
        .fromBufferAttribute(template.attributes.position, NAMES.indexOf('leverTip'))
        .applyMatrix4(mesh.matrixWorld),
      PTS.leverTip,
      'template tip',
    );

    panel.update(state({ autopilotMode: 'ALT' }), 0);
    expectAt(
      drawn(mesh, 'leverTip'),
      new Vector3(L.x, L.pivot + h * cos, L.z + h * sin),
      'ALT tip',
    );
    panel.update(state({ autopilotMode: 'ALT_HDG' }), 0);
    for (const n of ['leverTip', 'leverMid', 'leverBat'] as const)
      expectAt(drawn(mesh, n), PTS[n], `ALT/HDG ${n}`);
    // normals turn with the lever
    panel.update(state({ autopilotMode: 'PATH' }), 0);
    const ni = NAMES.indexOf('leverTip');
    const n = new Vector3().fromBufferAttribute(mesh.geometry.attributes.normal, ni);
    expect(n.y).toBeCloseTo(cos, 1);
    expect(n.z).toBeCloseTo(-sin, 1);
  });

  it('pushes the button cap in when clicked and lets it spring back', () => {
    expect(lastePressDepth(0)).toBe(0);
    expect(lastePressDepth(LASTE.buttonPressTime)).toBe(LASTE.buttonTravel);
    const { root, mesh } = standInCockpit();
    const panel = new LastePanel(root, []);
    panel.update(state(), 0);
    expectAt(drawn(mesh, 'capTop'), PTS.capTop, 'cap at rest');
    panel.press();
    panel.update(state(), 0.01);
    expect(panel.depth).toBe(LASTE.buttonTravel);
    expectAt(drawn(mesh, 'capTop'), PTS.capTop.clone().setY(B.top - LASTE.buttonTravel), 'cap in');
    expectAt(drawn(mesh, 'capFoot'), PTS.capFoot, 'cap foot');
    // halfway back during the last 40 % of the press, home after it
    panel.update(state(), LASTE.buttonPressTime * 0.69);
    expect(panel.depth).toBeGreaterThan(0);
    expect(panel.depth).toBeLessThan(LASTE.buttonTravel);
    panel.update(state(), 0.2);
    expect(panel.depth).toBe(0);
    expectAt(drawn(mesh, 'capTop'), PTS.capTop, 'cap back');
  });

  it('changes nothing in a model without the panel', () => {
    const root = new Group();
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new InterleavedBufferAttribute(new InterleavedBuffer(new Int16Array(4), 4), 3, 0, true),
    );
    const mesh = new Mesh(g);
    root.add(mesh);
    const panel = new LastePanel(root, []);
    expect(panel.lever.count + panel.button.count).toBe(0);
    expect(mesh.geometry).toBe(g);
    panel.press();
    expect(() => panel.update(state({ autopilotMode: 'ALT' }), 0.05)).not.toThrow();
  });
});
