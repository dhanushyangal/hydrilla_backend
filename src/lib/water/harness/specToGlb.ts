/**
 * Build a tiny glTF 2.0 binary from procedural primitives.
 * Used so Water factories can run mesh.post.gate + turntables without a GPU.
 */

export type GlbMeshPart = {
  name: string;
  /** Flat xyz positions. */
  positions: number[];
  /** Vertex indices (triangles). */
  indices: number[];
  /** Flat xyz normals, same length as positions. */
  normals: number[];
};

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

function concatFloat32(parts: number[][]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function writeGlb(parts: GlbMeshPart[]): Buffer {
  if (parts.length === 0) {
    throw new Error("writeGlb: no mesh parts");
  }

  const posChunks: number[][] = [];
  const nrmChunks: number[][] = [];
  const idxChunks: number[][] = [];
  const accessors: object[] = [];
  const bufferViews: object[] = [];
  const meshes: object[] = [];
  const nodes: object[] = [];

  for (const part of parts) {
    posChunks.push(part.positions);
    nrmChunks.push(part.normals);
    idxChunks.push(part.indices);
  }

  const pos = concatFloat32(posChunks);
  const nrm = concatFloat32(nrmChunks);
  const idxCount = idxChunks.reduce((s, c) => s + c.length, 0);
  const idx = new Uint32Array(idxCount);
  {
    let o = 0;
    for (const c of idxChunks) {
      idx.set(c, o);
      o += c.length;
    }
  }

  const posBytes = Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength);
  const nrmBytes = Buffer.from(nrm.buffer, nrm.byteOffset, nrm.byteLength);
  const idxBytes = Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength);
  const bin = Buffer.concat([posBytes, nrmBytes, idxBytes]);

  bufferViews.push(
    { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
    { buffer: 0, byteOffset: posBytes.length, byteLength: nrmBytes.length, target: 34962 },
    {
      buffer: 0,
      byteOffset: posBytes.length + nrmBytes.length,
      byteLength: idxBytes.length,
      target: 34963,
    }
  );

  let vertexBase = 0;
  let indexBase = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const vCount = part.positions.length / 3;
    const iCount = part.indices.length;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let v = 0; v < vCount; v++) {
      const x = part.positions[v * 3]!;
      const y = part.positions[v * 3 + 1]!;
      const z = part.positions[v * 3 + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const posAcc = accessors.length;
    accessors.push({
      bufferView: 0,
      byteOffset: vertexBase * 12,
      componentType: 5126,
      count: vCount,
      type: "VEC3",
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    });
    const nrmAcc = accessors.length;
    accessors.push({
      bufferView: 1,
      byteOffset: vertexBase * 12,
      componentType: 5126,
      count: vCount,
      type: "VEC3",
    });
    const idxAcc = accessors.length;
    accessors.push({
      bufferView: 2,
      byteOffset: indexBase * 4,
      componentType: 5125,
      count: iCount,
      type: "SCALAR",
    });

    const meshIndex = meshes.length;
    meshes.push({
      name: part.name,
      primitives: [
        {
          attributes: { POSITION: posAcc, NORMAL: nrmAcc },
          indices: idxAcc,
          mode: 4,
        },
      ],
    });
    nodes.push({ name: part.name, mesh: meshIndex });

    vertexBase += vCount;
    indexBase += iCount;
  }

  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0", generator: "hydrilla-water-factory" },
      buffers: [{ byteLength: bin.length }],
      bufferViews,
      accessors,
      meshes,
      nodes,
      scenes: [{ nodes: nodes.map((_, i) => i) }],
      scene: 0,
    }),
    "utf8"
  );

  const jsonPad = pad4(json.length);
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = pad4(bin.length);
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

  const header = Buffer.alloc(12);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);

  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonChunk.length, 0);
  jsonHead.writeUInt32LE(CHUNK_JSON, 4);

  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binChunk.length, 0);
  binHead.writeUInt32LE(CHUNK_BIN, 4);

  return Buffer.concat([header, jsonHead, jsonChunk, binHead, binChunk]);
}

function pushTri(
  positions: number[],
  normals: number[],
  indices: number[],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  nx: number, ny: number, nz: number
) {
  const i = positions.length / 3;
  positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  indices.push(i, i + 1, i + 2);
}

function transform(
  x: number, y: number, z: number,
  pos: number[], rot: number[]
): [number, number, number] {
  const rx = rot[0] || 0;
  const ry = rot[1] || 0;
  const rz = rot[2] || 0;
  // ZYX euler
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cx = Math.cos(rx), sx = Math.sin(rx);
  let x1 = x * cz - y * sz;
  let y1 = x * sz + y * cz;
  let z1 = z;
  const x2 = x1 * cy + z1 * sy;
  const z2 = -x1 * sy + z1 * cy;
  const y3 = y1 * cx - z2 * sx;
  const z3 = y1 * sx + z2 * cx;
  return [x2 + (pos[0] || 0), y3 + (pos[1] || 0), z3 + (pos[2] || 0)];
}

export function boxPart(name: string, size: number[], pos: number[], rot: number[]): GlbMeshPart {
  const hx = Math.max(0.01, size[0] || 0.2) / 2;
  const hy = Math.max(0.01, size[1] || 0.2) / 2;
  const hz = Math.max(0.01, size[2] || 0.2) / 2;
  const faces: Array<{ n: [number, number, number]; q: Array<[number, number, number]> }> = [
    { n: [0, 0, 1], q: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], q: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    { n: [1, 0, 0], q: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], q: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { n: [0, 1, 0], q: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], q: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const q = face.q.map((p) => transform(p[0], p[1], p[2], pos, rot));
    const n = transform(face.n[0], face.n[1], face.n[2], [0, 0, 0], rot);
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const nx = n[0] / len, ny = n[1] / len, nz = n[2] / len;
    pushTri(positions, normals, indices, q[0]![0], q[0]![1], q[0]![2], q[1]![0], q[1]![1], q[1]![2], q[2]![0], q[2]![1], q[2]![2], nx, ny, nz);
    pushTri(positions, normals, indices, q[0]![0], q[0]![1], q[0]![2], q[2]![0], q[2]![1], q[2]![2], q[3]![0], q[3]![1], q[3]![2], nx, ny, nz);
  }
  return { name, positions, indices, normals };
}

export function cylinderPart(name: string, size: number[], pos: number[], rot: number[]): GlbMeshPart {
  const radius = Math.max(0.01, (size[0] || 0.1) / 2);
  const height = Math.max(0.01, size[1] || 0.2);
  const segs = 16;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const hy = height / 2;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const p0 = transform(c0 * radius, -hy, s0 * radius, pos, rot);
    const p1 = transform(c1 * radius, -hy, s1 * radius, pos, rot);
    const p2 = transform(c1 * radius, hy, s1 * radius, pos, rot);
    const p3 = transform(c0 * radius, hy, s0 * radius, pos, rot);
    const n0 = transform(c0, 0, s0, [0, 0, 0], rot);
    const n1 = transform(c1, 0, s1, [0, 0, 0], rot);
    const l0 = Math.hypot(n0[0], n0[1], n0[2]) || 1;
    const l1 = Math.hypot(n1[0], n1[1], n1[2]) || 1;
    const iBase = positions.length / 3;
    positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
    normals.push(
      n0[0] / l0, n0[1] / l0, n0[2] / l0,
      n1[0] / l1, n1[1] / l1, n1[2] / l1,
      n1[0] / l1, n1[1] / l1, n1[2] / l1,
      n0[0] / l0, n0[1] / l0, n0[2] / l0
    );
    indices.push(iBase, iBase + 2, iBase + 1, iBase, iBase + 3, iBase + 2);

    const top = transform(0, hy, 0, pos, rot);
    const tn = transform(0, 1, 0, [0, 0, 0], rot);
    const tl = Math.hypot(tn[0], tn[1], tn[2]) || 1;
    pushTri(positions, normals, indices, top[0], top[1], top[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], tn[0] / tl, tn[1] / tl, tn[2] / tl);
    const bot = transform(0, -hy, 0, pos, rot);
    const bn = transform(0, -1, 0, [0, 0, 0], rot);
    const bl = Math.hypot(bn[0], bn[1], bn[2]) || 1;
    pushTri(positions, normals, indices, bot[0], bot[1], bot[2], p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], bn[0] / bl, bn[1] / bl, bn[2] / bl);
  }
  return { name, positions, indices, normals };
}

export function spherePart(name: string, size: number[], pos: number[], rot: number[]): GlbMeshPart {
  const r = Math.max(0.01, (size[0] || 0.1) / 2);
  const segs = 12;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y < segs; y++) {
    const v0 = y / segs;
    const v1 = (y + 1) / segs;
    const phi0 = v0 * Math.PI;
    const phi1 = v1 * Math.PI;
    for (let x = 0; x < segs; x++) {
      const u0 = x / segs;
      const u1 = (x + 1) / segs;
      const th0 = u0 * Math.PI * 2;
      const th1 = u1 * Math.PI * 2;
      const pts = [
        [Math.sin(phi0) * Math.cos(th0), Math.cos(phi0), Math.sin(phi0) * Math.sin(th0)],
        [Math.sin(phi0) * Math.cos(th1), Math.cos(phi0), Math.sin(phi0) * Math.sin(th1)],
        [Math.sin(phi1) * Math.cos(th1), Math.cos(phi1), Math.sin(phi1) * Math.sin(th1)],
        [Math.sin(phi1) * Math.cos(th0), Math.cos(phi1), Math.sin(phi1) * Math.sin(th0)],
      ].map((p) => {
        const t = transform(p[0]! * r, p[1]! * r, p[2]! * r, pos, rot);
        const n = transform(p[0]!, p[1]!, p[2]!, [0, 0, 0], rot);
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        return { t, n: [n[0] / l, n[1] / l, n[2] / l] as [number, number, number] };
      });
      const a = pts[0]!, b = pts[1]!, c = pts[2]!, d = pts[3]!;
      const i0 = positions.length / 3;
      for (const p of [a, b, c]) {
        positions.push(p.t[0], p.t[1], p.t[2]);
        normals.push(p.n[0], p.n[1], p.n[2]);
      }
      indices.push(i0, i0 + 1, i0 + 2);
      const i1 = positions.length / 3;
      for (const p of [a, c, d]) {
        positions.push(p.t[0], p.t[1], p.t[2]);
        normals.push(p.n[0], p.n[1], p.n[2]);
      }
      indices.push(i1, i1 + 1, i1 + 2);
    }
  }
  return { name, positions, indices, normals };
}

export function conePart(name: string, size: number[], pos: number[], rot: number[]): GlbMeshPart {
  const radius = Math.max(0.01, (size[0] || 0.1) / 2);
  const height = Math.max(0.01, size[1] || 0.2);
  const segs = 14;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const hy = height / 2;
  const apex = transform(0, hy, 0, pos, rot);
  const bot = transform(0, -hy, 0, pos, rot);
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p0 = transform(Math.cos(a0) * radius, -hy, Math.sin(a0) * radius, pos, rot);
    const p1 = transform(Math.cos(a1) * radius, -hy, Math.sin(a1) * radius, pos, rot);
    const nx = Math.cos((a0 + a1) / 2);
    const nz = Math.sin((a0 + a1) / 2);
    const n = transform(nx, 0.4, nz, [0, 0, 0], rot);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    pushTri(positions, normals, indices, apex[0], apex[1], apex[2], p1[0], p1[1], p1[2], p0[0], p0[1], p0[2], n[0] / l, n[1] / l, n[2] / l);
    const dn = transform(0, -1, 0, [0, 0, 0], rot);
    const dl = Math.hypot(dn[0], dn[1], dn[2]) || 1;
    pushTri(positions, normals, indices, bot[0], bot[1], bot[2], p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], dn[0] / dl, dn[1] / dl, dn[2] / dl);
  }
  return { name, positions, indices, normals };
}

export type SpecLike = {
  components?: Array<{
    name?: string;
    primitive?: string;
    size?: number[];
    position?: number[];
    rotation?: number[];
  }>;
};

/** Build a GLB from the sculpt spec (and optional factory-code name coverage). */
export function specToGlb(spec: SpecLike, factoryCode?: string | null): Buffer {
  const parts: GlbMeshPart[] = [];
  const code = factoryCode || "";
  for (const c of spec.components || []) {
    const name = (c.name || "part").trim() || "part";
    if (code && spec.components!.length >= 3 && !code.includes(name)) continue;
    const size = c.size && c.size.length >= 3 ? c.size : [0.2, 0.2, 0.2];
    const pos = c.position && c.position.length >= 3 ? c.position : [0, size[1]! / 2, 0];
    const rot = c.rotation && c.rotation.length >= 3 ? c.rotation : [0, 0, 0];
    const prim = (c.primitive || "box").toLowerCase();
    if (prim === "sphere") parts.push(spherePart(name, size, pos, rot));
    else if (prim === "cylinder" || prim === "capsule") parts.push(cylinderPart(name, size, pos, rot));
    else if (prim === "cone") parts.push(conePart(name, size, pos, rot));
    else parts.push(boxPart(name, size, pos, rot));
  }
  if (parts.length === 0) {
    parts.push(boxPart("body", [0.3, 0.3, 0.3], [0, 0.15, 0], [0, 0, 0]));
  }

  // Ground on y=0
  let minY = Infinity;
  for (const p of parts) {
    for (let i = 1; i < p.positions.length; i += 3) {
      if (p.positions[i]! < minY) minY = p.positions[i]!;
    }
  }
  if (Number.isFinite(minY) && Math.abs(minY) > 1e-6) {
    for (const p of parts) {
      for (let i = 1; i < p.positions.length; i += 3) {
        p.positions[i]! -= minY;
      }
    }
  }
  return writeGlb(parts);
}
