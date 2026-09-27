/**
 * Synthetic GLB builders for gate tests. Test-only — never imported by src/.
 *
 * Produces real binary GLB files (valid JSON + BIN chunks) so the gate is exercised
 * through the same parser production uses, not through a hand-made in-memory object.
 */

export type MeshData = {
  positions: number[];
  indices: number[];
  normals?: number[];
  uvs?: number[];
};

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

/** Assemble a single-primitive GLB from raw arrays. */
export function buildGlb(mesh: MeshData, options: { name?: string } = {}): Buffer {
  const vertexCount = mesh.positions.length / 3;
  const positions = Buffer.from(new Float32Array(mesh.positions).buffer);
  const indices = Buffer.from(new Uint32Array(mesh.indices).buffer);
  const normals = mesh.normals ? Buffer.from(new Float32Array(mesh.normals).buffer) : null;
  const uvs = mesh.uvs ? Buffer.from(new Float32Array(mesh.uvs).buffer) : null;

  const views: Array<{ buffer: Buffer; target?: number }> = [{ buffer: positions }];
  if (normals) views.push({ buffer: normals });
  if (uvs) views.push({ buffer: uvs });
  views.push({ buffer: indices });

  const bufferViews: any[] = [];
  const parts: Buffer[] = [];
  let offset = 0;
  for (const view of views) {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: view.buffer.length });
    parts.push(view.buffer);
    offset += view.buffer.length;
    const padding = pad4(offset);
    if (padding) {
      parts.push(Buffer.alloc(padding));
      offset += padding;
    }
  }
  const bin = Buffer.concat(parts);

  // Bounds are required on POSITION accessors.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    minX = Math.min(minX, mesh.positions[i]!);
    minY = Math.min(minY, mesh.positions[i + 1]!);
    minZ = Math.min(minZ, mesh.positions[i + 2]!);
    maxX = Math.max(maxX, mesh.positions[i]!);
    maxY = Math.max(maxY, mesh.positions[i + 1]!);
    maxZ = Math.max(maxZ, mesh.positions[i + 2]!);
  }

  const accessors: any[] = [
    {
      bufferView: 0,
      componentType: 5126,
      count: vertexCount,
      type: "VEC3",
      min: [minX, minY, minZ].map((v) => (Number.isFinite(v) ? v : 0)),
      max: [maxX, maxY, maxZ].map((v) => (Number.isFinite(v) ? v : 0)),
    },
  ];
  const attributes: Record<string, number> = { POSITION: 0 };
  let viewIndex = 1;
  if (normals) {
    accessors.push({ bufferView: viewIndex, componentType: 5126, count: vertexCount, type: "VEC3" });
    attributes.NORMAL = accessors.length - 1;
    viewIndex++;
  }
  if (uvs) {
    accessors.push({ bufferView: viewIndex, componentType: 5126, count: vertexCount, type: "VEC2" });
    attributes.TEXCOORD_0 = accessors.length - 1;
    viewIndex++;
  }
  accessors.push({
    bufferView: viewIndex,
    componentType: 5125,
    count: mesh.indices.length,
    type: "SCALAR",
  });
  const indexAccessor = accessors.length - 1;

  const json = {
    asset: { version: "2.0", generator: "hydrilla-test-fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: options.name ?? "subject" }],
    meshes: [{ primitives: [{ attributes, indices: indexAccessor, material: 0, mode: 4 }] }],
    materials: [
      {
        name: "body",
        pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0.1, roughnessFactor: 0.5 },
      },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
  };

  return packGlb(json, bin);
}

/** Wrap JSON + BIN into the GLB container. */
export function packGlb(json: unknown, bin: Buffer): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = Buffer.alloc(pad4(jsonBuf.length), 0x20); // spaces
  const binPad = Buffer.alloc(pad4(bin.length), 0);

  const jsonChunk = Buffer.concat([
    uint32(jsonBuf.length + jsonPad.length),
    Buffer.from("JSON", "ascii"),
    jsonBuf,
    jsonPad,
  ]);
  const binChunk =
    bin.length > 0
      ? Buffer.concat([
          uint32(bin.length + binPad.length),
          Buffer.from("BIN\0", "ascii"),
          bin,
          binPad,
        ])
      : Buffer.alloc(0);

  const total = 12 + jsonChunk.length + binChunk.length;
  const header = Buffer.concat([Buffer.from("glTF", "ascii"), uint32(2), uint32(total)]);
  return Buffer.concat([header, jsonChunk, binChunk]);
}

function uint32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
}

/**
 * Closed, manifold, axis-aligned box.
 *
 * Vertices are duplicated per face so normals are flat; the gate welds by position, so
 * topology still reads as manifold. `segments` subdivides each face, which is how the
 * triangle-budget and floater-share fixtures reach realistic counts.
 */
export function makeBox(params: {
  min: [number, number, number];
  max: [number, number, number];
  segments?: number;
  withNormals?: boolean;
  withUvs?: boolean;
}): MeshData {
  const segments = Math.max(1, params.segments ?? 1);
  const [x0, y0, z0] = params.min;
  const [x1, y1, z1] = params.max;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // axis: which axis the face faces; dir: +1 / -1
  const faces: Array<{ axis: 0 | 1 | 2; dir: 1 | -1 }> = [
    { axis: 0, dir: 1 }, { axis: 0, dir: -1 },
    { axis: 1, dir: 1 }, { axis: 1, dir: -1 },
    { axis: 2, dir: 1 }, { axis: 2, dir: -1 },
  ];

  for (const face of faces) {
    const base = positions.length / 3;
    // Two in-plane axes.
    const u = ((face.axis + 1) % 3) as 0 | 1 | 2;
    const v = ((face.axis + 2) % 3) as 0 | 1 | 2;
    const lo = [x0, y0, z0];
    const hi = [x1, y1, z1];
    const fixed = face.dir === 1 ? hi[face.axis]! : lo[face.axis]!;

    for (let iv = 0; iv <= segments; iv++) {
      for (let iu = 0; iu <= segments; iu++) {
        const point = [0, 0, 0];
        point[face.axis] = fixed;
        point[u] = lo[u]! + ((hi[u]! - lo[u]!) * iu) / segments;
        point[v] = lo[v]! + ((hi[v]! - lo[v]!) * iv) / segments;
        positions.push(point[0]!, point[1]!, point[2]!);

        const normal = [0, 0, 0];
        normal[face.axis] = face.dir;
        normals.push(normal[0]!, normal[1]!, normal[2]!);
        uvs.push(iu / segments, iv / segments);
      }
    }

    const row = segments + 1;
    for (let iv = 0; iv < segments; iv++) {
      for (let iu = 0; iu < segments; iu++) {
        const a = base + iv * row + iu;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        // Winding flipped for negative faces so all normals point outward.
        if (face.dir === 1) indices.push(a, b, d, a, d, c);
        else indices.push(a, d, b, a, c, d);
      }
    }
  }

  return {
    positions,
    indices,
    normals: params.withNormals === false ? undefined : normals,
    uvs: params.withUvs === false ? undefined : uvs,
  };
}

/** Merge meshes into one primitive, offsetting indices. */
export function mergeMeshes(...meshes: MeshData[]): MeshData {
  const out: MeshData = { positions: [], indices: [], normals: [], uvs: [] };
  let vertexOffset = 0;
  for (const mesh of meshes) {
    out.positions.push(...mesh.positions);
    out.normals!.push(...(mesh.normals ?? new Array((mesh.positions.length / 3) * 3).fill(0)));
    out.uvs!.push(...(mesh.uvs ?? new Array((mesh.positions.length / 3) * 2).fill(0)));
    for (const index of mesh.indices) out.indices.push(index + vertexOffset);
    vertexOffset += mesh.positions.length / 3;
  }
  return out;
}

export function translate(mesh: MeshData, dx: number, dy: number, dz: number): MeshData {
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! + dx;
    positions[i + 1] = positions[i + 1]! + dy;
    positions[i + 2] = positions[i + 2]! + dz;
  }
  return { ...mesh, positions };
}

/** A flat quad in the XY plane — zero volume, collapses edge-on. */
export function makePlane(size = 1): MeshData {
  return {
    positions: [0, 0, 0, size, 0, 0, size, size, 0, 0, size, 0],
    indices: [0, 1, 2, 0, 2, 3],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  };
}

/** A GLB with a mesh that has no primitives at all. */
export function buildEmptyGlb(): Buffer {
  return packGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: "empty" }],
    },
    Buffer.alloc(0)
  );
}
