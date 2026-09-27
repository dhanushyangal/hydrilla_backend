/**
 * Minimal GLB / glTF 2.0 reader — dependency-free.
 *
 * Only what the geometry gate needs: triangle positions, indices, normals, node
 * transforms, material/texture presence, and node names. Deliberately not a general
 * loader (no animation, no morph targets, no Draco).
 *
 * Written by hand rather than pulling a loader so `mesh.post.gate` runs anywhere the
 * backend runs, with no native deps and no network at install time.
 *
 * Spec: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout
 */

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/** glTF accessor componentType → bytes per component. */
const COMPONENT_BYTES: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export type Mat4 = Float64Array; // column-major, glTF convention

export type ParsedPrimitive = {
  /** World-space vertex positions, flat xyz. */
  positions: Float64Array;
  /** Triangle vertex indices into `positions` / 3. Always triangles. */
  indices: Uint32Array;
  /** World-space normals if the asset supplied them, flat xyz. */
  normals: Float64Array | null;
  hasUv: boolean;
  materialIndex: number | null;
  /** Owning node name, for part-name checks. */
  nodeName: string | null;
  /** glTF primitive mode; we only gate triangles (4). */
  mode: number;
};

export type ParsedMaterial = {
  name: string | null;
  hasBaseColorTexture: boolean;
  hasMetallicRoughnessTexture: boolean;
  hasNormalTexture: boolean;
  metallicFactor: number | null;
  roughnessFactor: number | null;
  /** alphaMode !== OPAQUE, or baseColorFactor alpha < 1. */
  isTransparent: boolean;
};

export type ParsedGlb = {
  primitives: ParsedPrimitive[];
  materials: ParsedMaterial[];
  nodeNames: string[];
  /** Total triangles across all primitives. */
  triangleCount: number;
  /** Non-triangle primitives found (points/lines) — gate treats these as suspicious. */
  nonTrianglePrimitives: number;
  generator: string | null;
  textureCount: number;
};

export class GlbParseError extends Error {}

function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Column-major multiply: out = a * b (apply b first, then a). */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function fromTrs(
  t?: number[] | null,
  r?: number[] | null,
  s?: number[] | null
): Mat4 {
  const [x, y, z, w] = r && r.length === 4 ? r : [0, 0, 0, 1];
  const [sx, sy, sz] = s && s.length === 3 ? s : [1, 1, 1];
  const x2 = x! + x!, y2 = y! + y!, z2 = z! + z!;
  const xx = x! * x2, xy = x! * y2, xz = x! * z2;
  const yy = y! * y2, yz = y! * z2, zz = z! * z2;
  const wx = w! * x2, wy = w! * y2, wz = w! * z2;

  const m = new Float64Array(16);
  m[0] = (1 - (yy + zz)) * sx!;
  m[1] = (xy + wz) * sx!;
  m[2] = (xz - wy) * sx!;
  m[4] = (xy - wz) * sy!;
  m[5] = (1 - (xx + zz)) * sy!;
  m[6] = (yz + wx) * sy!;
  m[8] = (xz + wy) * sz!;
  m[9] = (yz - wx) * sz!;
  m[10] = (1 - (xx + yy)) * sz!;
  m[12] = t?.[0] ?? 0;
  m[13] = t?.[1] ?? 0;
  m[14] = t?.[2] ?? 0;
  m[15] = 1;
  return m;
}

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/** Normals ignore translation. Non-uniform scale is approximated; good enough for orientation checks. */
function transformDirection(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z,
    m[1]! * x + m[5]! * y + m[9]! * z,
    m[2]! * x + m[6]! * y + m[10]! * z,
  ];
}

type GltfJson = any;

/** Split a .glb container into its JSON and BIN chunks. */
function readGlbChunks(buf: Buffer): { json: GltfJson; bin: Buffer | null } {
  if (buf.length < 12) throw new GlbParseError("File is too small to be a GLB.");
  const magic = buf.readUInt32LE(0);

  // A bare .gltf JSON file is also accepted (Water exports JSON glTF).
  if (magic !== GLB_MAGIC) {
    const text = buf.toString("utf8").trim();
    if (text.startsWith("{")) {
      try {
        return { json: JSON.parse(text), bin: null };
      } catch {
        throw new GlbParseError("Not a GLB and not parseable glTF JSON.");
      }
    }
    throw new GlbParseError("Bad GLB magic — file is not glTF binary.");
  }

  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new GlbParseError(`Unsupported GLB version ${version}.`);

  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Buffer | null = null;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buf.length) throw new GlbParseError("Chunk length runs past end of file.");
    if (type === CHUNK_JSON) {
      json = JSON.parse(buf.subarray(start, end).toString("utf8"));
    } else if (type === CHUNK_BIN) {
      bin = buf.subarray(start, end);
    }
    // Chunks are 4-byte aligned.
    offset = end + ((4 - (length % 4)) % 4);
  }

  if (!json) throw new GlbParseError("GLB has no JSON chunk.");
  return { json, bin };
}

function decodeDataUri(uri: string): Buffer | null {
  const match = /^data:[^;,]*;base64,(.*)$/.exec(uri);
  if (!match) return null;
  return Buffer.from(match[1]!, "base64");
}

/** Read one accessor as Float64Array (numeric) — handles stride and normalization. */
function readAccessor(
  json: GltfJson,
  buffers: (Buffer | null)[],
  accessorIndex: number
): Float64Array {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) throw new GlbParseError(`Missing accessor ${accessorIndex}.`);

  const numComponents = TYPE_COMPONENTS[accessor.type];
  if (!numComponents) throw new GlbParseError(`Unknown accessor type ${accessor.type}.`);
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (!componentBytes) {
    throw new GlbParseError(`Unknown componentType ${accessor.componentType}.`);
  }

  const count: number = accessor.count;
  const out = new Float64Array(count * numComponents);

  // Sparse-only or zero-initialised accessors are legal and read as zeros.
  if (accessor.bufferView === undefined) return out;

  const view = json.bufferViews?.[accessor.bufferView];
  if (!view) throw new GlbParseError(`Missing bufferView ${accessor.bufferView}.`);
  const data = buffers[view.buffer ?? 0];
  if (!data) throw new GlbParseError(`Buffer ${view.buffer ?? 0} is not available.`);

  const baseOffset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const elementBytes = componentBytes * numComponents;
  const stride: number = view.byteStride && view.byteStride > 0 ? view.byteStride : elementBytes;

  for (let i = 0; i < count; i++) {
    const elementStart = baseOffset + i * stride;
    for (let c = 0; c < numComponents; c++) {
      const at = elementStart + c * componentBytes;
      if (at + componentBytes > data.length) {
        throw new GlbParseError("Accessor reads past the end of its buffer.");
      }
      let value: number;
      switch (accessor.componentType) {
        case 5126: value = data.readFloatLE(at); break;
        case 5125: value = data.readUInt32LE(at); break;
        case 5123: value = data.readUInt16LE(at); break;
        case 5122: value = data.readInt16LE(at); break;
        case 5121: value = data.readUInt8(at); break;
        case 5120: value = data.readInt8(at); break;
        default: throw new GlbParseError(`Unhandled componentType ${accessor.componentType}.`);
      }
      out[i * numComponents + c] = value;
    }
  }
  return out;
}

function parseMaterial(material: any): ParsedMaterial {
  const pbr = material?.pbrMetallicRoughness || {};
  const alpha = Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor[3] : 1;
  return {
    name: material?.name ?? null,
    hasBaseColorTexture: pbr.baseColorTexture !== undefined,
    hasMetallicRoughnessTexture: pbr.metallicRoughnessTexture !== undefined,
    hasNormalTexture: material?.normalTexture !== undefined,
    metallicFactor: pbr.metallicFactor ?? null,
    roughnessFactor: pbr.roughnessFactor ?? null,
    isTransparent:
      (material?.alphaMode && material.alphaMode !== "OPAQUE") || (typeof alpha === "number" && alpha < 1),
  };
}

/**
 * Parse a GLB (or glTF JSON) into world-space triangle soup grouped by primitive.
 *
 * Node transforms are applied, so downstream gates work in the same space the engine
 * will import — that is what makes the grounding and scale checks meaningful.
 */
export function parseGlb(buf: Buffer): ParsedGlb {
  const { json, bin } = readGlbChunks(buf);

  const buffers: (Buffer | null)[] = (json.buffers || []).map((b: any, i: number) => {
    if (b.uri === undefined) return i === 0 ? bin : null;
    if (typeof b.uri === "string" && b.uri.startsWith("data:")) return decodeDataUri(b.uri);
    // External .bin siblings are not fetched — the gate runs on self-contained assets.
    return null;
  });
  if (buffers.length === 0 && bin) buffers.push(bin);

  const materials: ParsedMaterial[] = (json.materials || []).map(parseMaterial);
  const primitives: ParsedPrimitive[] = [];
  const nodeNames: string[] = [];
  let nonTrianglePrimitives = 0;

  const nodes: any[] = json.nodes || [];
  const meshes: any[] = json.meshes || [];

  const visitNode = (nodeIndex: number, parent: Mat4, seen: Set<number>) => {
    if (seen.has(nodeIndex)) return; // defend against malformed cyclic graphs
    seen.add(nodeIndex);
    const node = nodes[nodeIndex];
    if (!node) return;

    const local: Mat4 = Array.isArray(node.matrix)
      ? Float64Array.from(node.matrix)
      : fromTrs(node.translation, node.rotation, node.scale);
    const world = multiply(parent, local);

    if (node.name) nodeNames.push(String(node.name));

    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      for (const prim of mesh?.primitives || []) {
        const mode = prim.mode === undefined ? 4 : prim.mode;
        if (mode !== 4) {
          nonTrianglePrimitives++;
          continue;
        }
        const posAccessor = prim.attributes?.POSITION;
        if (posAccessor === undefined) continue;

        let raw: Float64Array;
        try {
          raw = readAccessor(json, buffers, posAccessor);
        } catch {
          continue; // unreadable primitive; emptiness is caught by the gate
        }
        const vertexCount = raw.length / 3;
        const positions = new Float64Array(raw.length);
        for (let v = 0; v < vertexCount; v++) {
          const [x, y, z] = transformPoint(world, raw[v * 3]!, raw[v * 3 + 1]!, raw[v * 3 + 2]!);
          positions[v * 3] = x;
          positions[v * 3 + 1] = y;
          positions[v * 3 + 2] = z;
        }

        let normals: Float64Array | null = null;
        if (prim.attributes?.NORMAL !== undefined) {
          try {
            const rawN = readAccessor(json, buffers, prim.attributes.NORMAL);
            normals = new Float64Array(rawN.length);
            for (let v = 0; v < rawN.length / 3; v++) {
              const [x, y, z] = transformDirection(world, rawN[v * 3]!, rawN[v * 3 + 1]!, rawN[v * 3 + 2]!);
              const len = Math.hypot(x, y, z) || 1;
              normals[v * 3] = x / len;
              normals[v * 3 + 1] = y / len;
              normals[v * 3 + 2] = z / len;
            }
          } catch {
            normals = null;
          }
        }

        let indices: Uint32Array;
        if (prim.indices !== undefined) {
          try {
            const rawI = readAccessor(json, buffers, prim.indices);
            indices = Uint32Array.from(rawI);
          } catch {
            continue;
          }
        } else {
          indices = new Uint32Array(vertexCount);
          for (let i = 0; i < vertexCount; i++) indices[i] = i;
        }

        primitives.push({
          positions,
          indices,
          normals,
          hasUv: prim.attributes?.TEXCOORD_0 !== undefined,
          materialIndex: prim.material ?? null,
          nodeName: node.name ?? null,
          mode,
        });
      }
    }

    for (const child of node.children || []) visitNode(child, world, seen);
  };

  const sceneIndex = json.scene ?? 0;
  const roots: number[] = json.scenes?.[sceneIndex]?.nodes ?? nodes.map((_, i) => i);
  const seen = new Set<number>();
  for (const root of roots) visitNode(root, identity(), seen);

  // Some exporters emit meshes with no node referencing them. Include them untransformed
  // rather than silently reporting an empty asset.
  if (primitives.length === 0 && meshes.length > 0) {
    for (const mesh of meshes) {
      for (const prim of mesh.primitives || []) {
        const mode = prim.mode === undefined ? 4 : prim.mode;
        if (mode !== 4 || prim.attributes?.POSITION === undefined) {
          if (mode !== 4) nonTrianglePrimitives++;
          continue;
        }
        try {
          const positions = readAccessor(json, buffers, prim.attributes.POSITION);
          const vertexCount = positions.length / 3;
          const indices =
            prim.indices !== undefined
              ? Uint32Array.from(readAccessor(json, buffers, prim.indices))
              : Uint32Array.from({ length: vertexCount }, (_, i) => i);
          primitives.push({
            positions,
            indices,
            normals:
              prim.attributes?.NORMAL !== undefined
                ? readAccessor(json, buffers, prim.attributes.NORMAL)
                : null,
            hasUv: prim.attributes?.TEXCOORD_0 !== undefined,
            materialIndex: prim.material ?? null,
            nodeName: mesh.name ?? null,
            mode,
          });
        } catch {
          /* skip unreadable primitive */
        }
      }
    }
  }

  const triangleCount = primitives.reduce((sum, p) => sum + Math.floor(p.indices.length / 3), 0);

  return {
    primitives,
    materials,
    nodeNames,
    triangleCount,
    nonTrianglePrimitives,
    generator: json.asset?.generator ?? null,
    textureCount: (json.textures || []).length,
  };
}
