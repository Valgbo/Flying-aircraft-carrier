/**
 * Jet — the visuals of the whole air wing: every aircraft in `sim.jets` drawn with shared
 * geometry and materials as six instanced meshes (airframe, canopy, landing gear + hook,
 * afterburner, navigation lights, tail numbers). It only reads `sim`; the flight-ops logic
 * decides where the jets are.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
  Vector3,
  type InstancedMesh,
} from 'three';
import { PALETTE } from '../config/palette';
import { sim } from '../state/sim';
import { clamp01, moveToward } from '../utils/math';
import { GEAR_FOLD_Y, NOZZLE_CENTRE, buildJetGeometries } from './jetGeometry';
import { OPS } from './opsConfig';

const COUNT = OPS.jetCount;
/** Seconds the landing gear takes to travel. */
const GEAR_TRAVEL_TIME = 0.9;

/** One cell per aircraft with its number, read on the fins. */
function createNumberAtlas(): CanvasTexture {
  const cell = 96;
  const canvas = document.createElement('canvas');
  canvas.width = cell * COUNT;
  canvas.height = cell;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#161b20';
    ctx.font = `900 ${cell * 0.92}px "Arial Narrow", Arial, Helvetica, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < COUNT; i++) ctx.fillText(String(i + 1), cell * (i + 0.5), cell * 0.54);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function createParts() {
  const geometries = buildJetGeometries();
  geometries.numbers.setAttribute(
    'aDigit',
    new InstancedBufferAttribute(
      Float32Array.from({ length: COUNT }, (_, i) => i),
      1,
    ),
  );
  const atlas = createNumberAtlas();
  const airframe = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    metalness: 0.35,
    roughness: 0.55,
  });
  const canopy = new MeshStandardMaterial({
    color: PALETTE.glass,
    flatShading: true,
    metalness: 0.35,
    roughness: 0.12,
  });
  const glow = new MeshBasicMaterial({
    vertexColors: true,
    toneMapped: false,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  const navLights = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const numbers = new MeshStandardMaterial({
    map: atlas,
    alphaTest: 0.5,
    metalness: 0.1,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // each instance samples its own cell of the number atlas
  numbers.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute float aDigit;\n${shader.vertexShader}`.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>\n\tvMapUv = vec2((uv.x + aDigit) / ${COUNT.toFixed(1)}, uv.y);`,
    );
  };
  numbers.customProgramCacheKey = () => `jet-numbers-${COUNT}`;
  const materials = { airframe, canopy, glow, navLights, numbers };
  return {
    geometries,
    materials,
    dispose(): void {
      for (const geometry of Object.values(geometries)) geometry.dispose();
      for (const material of Object.values(materials)) material.dispose();
      atlas.dispose();
    },
  };
}

const ONE = new Vector3(1, 1, 1);
const GLOW_COLOR = new Color(PALETTE.glowHot);
const _jet = new Matrix4();
const _part = new Matrix4();
const _local = new Matrix4();
const _color = new Color();

export default function Jet() {
  const parts = useMemo(createParts, []);
  useEffect(() => () => parts.dispose(), [parts]);
  const gearTravel = useMemo(() => new Float32Array(COUNT).fill(1), []);

  const airframe = useRef<InstancedMesh>(null);
  const canopy = useRef<InstancedMesh>(null);
  const gear = useRef<InstancedMesh>(null);
  const glow = useRef<InstancedMesh>(null);
  const navLights = useRef<InstancedMesh>(null);
  const numbers = useRef<InstancedMesh>(null);

  useFrame(() => {
    const meshes = [airframe, canopy, gear, glow, navLights, numbers];
    const count = Math.min(sim.jets.length, COUNT);
    const digits = parts.geometries.numbers.getAttribute('aDigit') as InstancedBufferAttribute;
    for (let i = 0; i < count; i++) {
      const jet = sim.jets[i];
      _jet.compose(jet.position, jet.quaternion, ONE);
      airframe.current?.setMatrixAt(i, _jet);
      canopy.current?.setMatrixAt(i, _jet);
      navLights.current?.setMatrixAt(i, _jet);
      numbers.current?.setMatrixAt(i, _jet);
      if (digits.getX(i) !== jet.id - 1) {
        digits.setX(i, jet.id - 1);
        digits.needsUpdate = true;
      }

      // landing gear and hook fold flat into the belly
      const travel = moveToward(gearTravel[i], jet.gearDown ? 1 : 0, sim.dt / GEAR_TRAVEL_TIME);
      gearTravel[i] = travel;
      const extend = Math.max(travel, 0.001);
      _local.makeScale(1, extend, 1).setPosition(0, GEAR_FOLD_Y * (1 - extend), 0);
      gear.current?.setMatrixAt(i, _part.multiplyMatrices(_jet, _local));

      // afterburner: brightness, flame length and the size of the hot core follow engine power
      const power = clamp01(jet.power);
      const reheat = clamp01((power - 0.45) / 0.55);
      const core = 0.4 + 0.6 * reheat;
      _local
        .makeScale(core, core, 0.03 + reheat)
        .setPosition(NOZZLE_CENTRE[0], NOZZLE_CENTRE[1], NOZZLE_CENTRE[2]);
      glow.current?.setMatrixAt(i, _part.multiplyMatrices(_jet, _local));
      glow.current?.setColorAt(
        i,
        _color.copy(GLOW_COLOR).multiplyScalar(0.08 + 2.6 * power * power),
      );
    }
    for (const ref of meshes) {
      const mesh = ref.current;
      if (!mesh) continue;
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    }
    const glowColors = glow.current?.instanceColor;
    if (glowColors) glowColors.needsUpdate = true;
  });

  const { geometries, materials } = parts;
  // instances move far from the origin every frame, so the meshes are never culled as a whole
  return (
    <group>
      <instancedMesh
        ref={airframe}
        args={[geometries.airframe, materials.airframe, COUNT]}
        frustumCulled={false}
        castShadow
        receiveShadow
      />
      <instancedMesh
        ref={canopy}
        args={[geometries.canopy, materials.canopy, COUNT]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={gear}
        args={[geometries.gear, materials.airframe, COUNT]}
        frustumCulled={false}
        castShadow
      />
      <instancedMesh
        ref={glow}
        args={[geometries.glow, materials.glow, COUNT]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={navLights}
        args={[geometries.navLights, materials.navLights, COUNT]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={numbers}
        args={[geometries.numbers, materials.numbers, COUNT]}
        frustumCulled={false}
      />
    </group>
  );
}
