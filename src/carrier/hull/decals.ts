/**
 * Painted identity markings (hull number, ship name) as textured quads floated a few
 * centimetres off the surface they sit on. All of them sample one small atlas texture
 * (painted in shipTextures.ts) whose layout is defined here.
 */
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { v3add, v3cross, v3normalize, v3scale, v3sub, type V3 } from './geo';

/** Pixel layout of the decal atlas canvas. */
export const DECAL_ATLAS = {
  width: 1024,
  height: 512,
  number: { x: 8, y: 8, w: 400, h: 320 },
  name: { x: 0, y: 340, w: 1024, h: 172 },
} as const;

export type DecalKind = 'number' | 'name';

/** Width / height of a marking, for sizing its quad without distortion. */
export function decalAspect(kind: DecalKind): number {
  return DECAL_ATLAS[kind].w / DECAL_ATLAS[kind].h;
}

export class DecalBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];

  /**
   * One marking. The corners are given as the READER sees them (left-bottom, right-bottom,
   * right-top, left-top), which is what keeps text from coming out mirrored; the quad faces
   * the reader and is lifted `lift` metres off the surface along its normal.
   */
  quad(lb: V3, rb: V3, rt: V3, lt: V3, kind: DecalKind, lift: number): void {
    const normal = v3normalize(v3cross(v3sub(rb, lb), v3sub(lt, lb)));
    const off = v3scale(normal, lift);
    const rect = DECAL_ATLAS[kind];
    const u0 = rect.x / DECAL_ATLAS.width;
    const u1 = (rect.x + rect.w) / DECAL_ATLAS.width;
    const vTop = 1 - rect.y / DECAL_ATLAS.height;
    const vBottom = 1 - (rect.y + rect.h) / DECAL_ATLAS.height;
    const corners: [V3, number, number][] = [
      [v3add(lb, off), u0, vBottom],
      [v3add(rb, off), u1, vBottom],
      [v3add(rt, off), u1, vTop],
      [v3add(lt, off), u0, vTop],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [p, u, v] = corners[i];
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(normal[0], normal[1], normal[2]);
      this.uvs.push(u, v);
    }
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
    geometry.computeBoundingSphere();
    return geometry;
  }
}
