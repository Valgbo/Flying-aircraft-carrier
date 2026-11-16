/**
 * Minimal glTF 2.0 binary (GLB) writer for the A-10 model converter.
 *
 * Geometry is stored with KHR_mesh_quantization: positions as normalised int16 (the holder node
 * carries the dequantisation as a UNIFORM scale + translation, so normals stay correct), normals
 * as normalised int8, texture coordinates as normalised uint16 (the material's
 * KHR_texture_transform maps them back to the source range), indices as uint16 or uint32.
 */

const BYTE = 5120;
const UNSIGNED_BYTE = 5121;
const SHORT = 5122;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const FLOAT = 5126;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export class GltfBuilder {
  constructor(generator) {
    this.json = {
      asset: { version: '2.0', generator },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      textures: [],
      images: [],
      samplers: [],
      accessors: [],
      bufferViews: [],
      buffers: [{ byteLength: 0 }],
    };
    this.parts = [];
    this.byteLength = 0;
    this.extensionsUsed = new Set();
    this.extensionsRequired = new Set();
    this.stats = { triangles: 0, vertices: 0, primitives: 0, geometryBytes: 0 };
  }

  /** Append raw bytes as a buffer view (4-byte aligned). */
  addBufferView(bytes, target, byteStride) {
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.byteLength += pad;
    }
    const view = { buffer: 0, byteOffset: this.byteLength, byteLength: bytes.byteLength };
    if (target) view.target = target;
    if (byteStride) view.byteStride = byteStride;
    this.parts.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.byteLength += bytes.byteLength;
    this.json.bufferViews.push(view);
    return this.json.bufferViews.length - 1;
  }

  addAccessor(a) {
    this.json.accessors.push(a);
    return this.json.accessors.length - 1;
  }

  addNode(node) {
    this.json.nodes.push(node);
    return this.json.nodes.length - 1;
  }

  addSampler(s) {
    const key = JSON.stringify(s);
    this._samplers ??= new Map();
    if (this._samplers.has(key)) return this._samplers.get(key);
    this.json.samplers.push(s);
    const i = this.json.samplers.length - 1;
    this._samplers.set(key, i);
    return i;
  }

  /** Texture referencing an external image URI (deduplicated by URI). */
  addTexture(uri, mimeType) {
    this._tex ??= new Map();
    if (this._tex.has(uri)) return this._tex.get(uri);
    this.json.images.push({ uri, mimeType });
    const sampler = this.addSampler({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
    this.json.textures.push({ sampler, source: this.json.images.length - 1 });
    const i = this.json.textures.length - 1;
    this._tex.set(uri, i);
    return i;
  }

  addMaterial(m) {
    this.json.materials.push(m);
    return this.json.materials.length - 1;
  }

  /**
   * Add one mesh with several primitives sharing one quantisation frame.
   * @param {string} name
   * @param {Array<{pos:number[], nrm:number[], uv?:number[]|null, idx:number[], material:number,
   *   uvRange?: {min:number[], scale:number[]} | null, uvFloat?: boolean}>} prims positions in the
   *   holder's parent frame
   * @returns {{ mesh: number, translation: number[], scale: number }} holder node transform
   */
  addMesh(name, prims) {
    this.extensionsUsed.add('KHR_mesh_quantization');
    this.extensionsRequired.add('KHR_mesh_quantization');
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of prims)
      for (let i = 0; i < p.pos.length; i += 3)
        for (let c = 0; c < 3; c++) {
          if (p.pos[i + c] < min[c]) min[c] = p.pos[i + c];
          if (p.pos[i + c] > max[c]) max[c] = p.pos[i + c];
        }
    const centre = [0, 1, 2].map((c) => (min[c] + max[c]) / 2);
    const half = Math.max(1e-4, ...[0, 1, 2].map((c) => (max[c] - min[c]) / 2));
    const primitives = [];
    for (const p of prims) {
      const n = p.pos.length / 3;
      // positions: int16 normalised, padded to 8 bytes
      const qp = new Int16Array(n * 4);
      const qmin = [32767, 32767, 32767];
      const qmax = [-32767, -32767, -32767];
      for (let i = 0; i < n; i++)
        for (let c = 0; c < 3; c++) {
          const q = Math.max(
            -32767,
            Math.min(32767, Math.round(((p.pos[i * 3 + c] - centre[c]) / half) * 32767)),
          );
          qp[i * 4 + c] = q;
          if (q < qmin[c]) qmin[c] = q;
          if (q > qmax[c]) qmax[c] = q;
        }
      const posView = this.addBufferView(qp, ARRAY_BUFFER, 8);
      const attributes = {
        POSITION: this.addAccessor({
          bufferView: posView,
          componentType: SHORT,
          normalized: true,
          count: n,
          type: 'VEC3',
          min: qmin,
          max: qmax,
        }),
      };
      // normals: int8 normalised, padded to 4 bytes
      const qn = new Int8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const x = p.nrm[i * 3];
        const y = p.nrm[i * 3 + 1];
        const z = p.nrm[i * 3 + 2];
        const l = Math.hypot(x, y, z) || 1;
        qn[i * 4] = Math.round((x / l) * 127);
        qn[i * 4 + 1] = Math.round((y / l) * 127);
        qn[i * 4 + 2] = Math.round((z / l) * 127);
      }
      attributes.NORMAL = this.addAccessor({
        bufferView: this.addBufferView(qn, ARRAY_BUFFER, 4),
        componentType: BYTE,
        normalized: true,
        count: n,
        type: 'VEC3',
      });
      let colBytes = 0;
      if (p.col) {
        // linear vertex colours, uint8 normalised, padded to 4 bytes
        const qc = new Uint8Array(n * 4);
        for (let i = 0; i < n; i++)
          for (let c = 0; c < 3; c++) qc[i * 4 + c] = Math.round(Math.min(1, Math.max(0, p.col[i * 3 + c])) * 255);
        attributes.COLOR_0 = this.addAccessor({
          bufferView: this.addBufferView(qc, ARRAY_BUFFER, 4),
          componentType: UNSIGNED_BYTE,
          normalized: true,
          count: n,
          type: 'VEC3',
        });
        colBytes = qc.byteLength;
      }
      let uvBytes = 0;
      if (p.uv && p.uvFloat) {
        const fu = new Float32Array(p.uv);
        attributes.TEXCOORD_0 = this.addAccessor({
          bufferView: this.addBufferView(fu, ARRAY_BUFFER),
          componentType: FLOAT,
          count: n,
          type: 'VEC2',
        });
        uvBytes = fu.byteLength;
      } else if (p.uv && p.uvRange) {
        const qu = new Uint16Array(n * 2);
        const r = p.uvRange;
        for (let i = 0; i < n; i++)
          for (let c = 0; c < 2; c++) {
            const t = r.scale[c] > 0 ? (p.uv[i * 2 + c] - r.min[c]) / r.scale[c] : 0;
            qu[i * 2 + c] = Math.max(0, Math.min(65535, Math.round(t * 65535)));
          }
        attributes.TEXCOORD_0 = this.addAccessor({
          bufferView: this.addBufferView(qu, ARRAY_BUFFER),
          componentType: UNSIGNED_SHORT,
          normalized: true,
          count: n,
          type: 'VEC2',
        });
        uvBytes = qu.byteLength;
      }
      const big = n > 65535;
      const qi = big ? new Uint32Array(p.idx) : new Uint16Array(p.idx);
      const indices = this.addAccessor({
        bufferView: this.addBufferView(qi, ELEMENT_ARRAY_BUFFER),
        componentType: big ? UNSIGNED_INT : UNSIGNED_SHORT,
        count: p.idx.length,
        type: 'SCALAR',
      });
      primitives.push({ attributes, indices, material: p.material, mode: 4 });
      this.stats.triangles += p.idx.length / 3;
      this.stats.vertices += n;
      this.stats.primitives++;
      this.stats.geometryBytes += qp.byteLength + qn.byteLength + uvBytes + colBytes + qi.byteLength;
    }
    // no mesh name: GLTFLoader gives meshes and nodes names from one pool, and the node (whose
    // name is `name`) must keep it
    void name;
    this.json.meshes.push({ primitives });
    return { mesh: this.json.meshes.length - 1, translation: centre, scale: half };
  }

  /** Serialise to a GLB buffer. */
  toGLB() {
    const json = this.json;
    for (const k of ['meshes', 'materials', 'textures', 'images', 'samplers', 'accessors', 'bufferViews'])
      if (json[k].length === 0) delete json[k];
    if (this.extensionsUsed.size) json.extensionsUsed = [...this.extensionsUsed].sort();
    if (this.extensionsRequired.size) json.extensionsRequired = [...this.extensionsRequired].sort();
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.byteLength += pad;
    }
    json.buffers[0].byteLength = this.byteLength;
    if (this.byteLength === 0) delete json.buffers;
    let jsonText = JSON.stringify(json);
    while (Buffer.byteLength(jsonText) % 4) jsonText += ' ';
    const jsonBytes = Buffer.from(jsonText, 'utf8');
    const total = 12 + 8 + jsonBytes.length + (this.byteLength ? 8 + this.byteLength : 0);
    const out = Buffer.alloc(total);
    let o = 0;
    out.writeUInt32LE(0x46546c67, o); // 'glTF'
    out.writeUInt32LE(2, o + 4);
    out.writeUInt32LE(total, o + 8);
    o += 12;
    out.writeUInt32LE(jsonBytes.length, o);
    out.writeUInt32LE(0x4e4f534a, o + 4); // 'JSON'
    jsonBytes.copy(out, o + 8);
    o += 8 + jsonBytes.length;
    if (this.byteLength) {
      out.writeUInt32LE(this.byteLength, o);
      out.writeUInt32LE(0x004e4942, o + 4); // 'BIN\0'
      o += 8;
      for (const p of this.parts) {
        out.set(p, o);
        o += p.byteLength;
      }
    }
    return out;
  }
}

export const GL = { BYTE, UNSIGNED_BYTE, SHORT, UNSIGNED_SHORT, UNSIGNED_INT, FLOAT };
