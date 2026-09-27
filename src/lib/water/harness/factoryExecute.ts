/**
 * Execute a Water `createModel()` factory in a sealed vm and emit a GLB of the
 * live meshes. img2threejs gates the exported factory, not a spec proxy.
 *
 * No `three` npm dependency: a stub records Box/Sphere/Cylinder/Cone/Plane
 * (and a few cousins) then `writeGlb` serialises world-space triangles.
 */

import { runInNewContext } from "node:vm";
import { boxPart, conePart, cylinderPart, spherePart, writeGlb, type GlbMeshPart } from "./specToGlb.js";

export type FactoryExecuteResult =
  | { ok: true; glb: Buffer; meshNames: string[] }
  | { ok: false; error: string };

const EXEC_MS = 800;

type Vec = { x: number; y: number; z: number };

function v3(x = 0, y = 0, z = 0): Vec {
  return { x, y, z };
}

function matIdentity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function composeTRS(pos: Vec, euler: Vec, scale: Vec): number[] {
  const cx = Math.cos(euler.x), sx = Math.sin(euler.x);
  const cy = Math.cos(euler.y), sy = Math.sin(euler.y);
  const cz = Math.cos(euler.z), sz = Math.sin(euler.z);
  // XYZ euler → rotation matrix (Three.js Object3D default)
  const r00 = cy * cz;
  const r01 = -cy * sz;
  const r02 = sy;
  const r10 = cx * sz + cz * sx * sy;
  const r11 = cx * cz - sx * sy * sz;
  const r12 = -cy * sx;
  const r20 = sx * sz - cx * cz * sy;
  const r21 = cx * sz * sy + cz * sx;
  const r22 = cx * cy;
  const sxn = scale.x, syn = scale.y, szn = scale.z;
  return [
    r00 * sxn, r10 * sxn, r20 * sxn, 0,
    r01 * syn, r11 * syn, r21 * syn, 0,
    r02 * szn, r12 * szn, r22 * szn, 0,
    pos.x, pos.y, pos.z, 1,
  ];
}

function multiply(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r]! * b[c * 4 + 0]! +
        a[1 * 4 + r]! * b[c * 4 + 1]! +
        a[2 * 4 + r]! * b[c * 4 + 2]! +
        a[3 * 4 + r]! * b[c * 4 + 3]!;
    }
  }
  return o;
}

function transformPoint(m: number[], x: number, y: number, z: number): [number, number, number] {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]! || 1;
  return [
    (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w,
    (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w,
    (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w,
  ];
}

function transformDir(m: number[], x: number, y: number, z: number): [number, number, number] {
  const dx = m[0]! * x + m[4]! * y + m[8]! * z;
  const dy = m[1]! * x + m[5]! * y + m[9]! * z;
  const dz = m[2]! * x + m[6]! * y + m[10]! * z;
  const len = Math.hypot(dx, dy, dz) || 1;
  return [dx / len, dy / len, dz / len];
}

function applyWorld(part: GlbMeshPart, matrix: number[]): GlbMeshPart {
  const positions: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i < part.positions.length; i += 3) {
    const p = transformPoint(matrix, part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!);
    positions.push(p[0], p[1], p[2]);
  }
  for (let i = 0; i < part.normals.length; i += 3) {
    const n = transformDir(matrix, part.normals[i]!, part.normals[i + 1]!, part.normals[i + 2]!);
    normals.push(n[0], n[1], n[2]);
  }
  return { name: part.name, positions, normals, indices: part.indices.slice() };
}

type GeomKind = "box" | "sphere" | "cylinder" | "cone" | "plane";

type Geom = {
  kind: GeomKind;
  size: [number, number, number];
};

function localPart(name: string, geom: Geom): GlbMeshPart {
  const s = geom.size;
  if (geom.kind === "sphere") return spherePart(name, s, [0, 0, 0], [0, 0, 0]);
  if (geom.kind === "cylinder") return cylinderPart(name, s, [0, 0, 0], [0, 0, 0]);
  if (geom.kind === "cone") return conePart(name, s, [0, 0, 0], [0, 0, 0]);
  if (geom.kind === "plane") return boxPart(name, [s[0], s[1], Math.max(0.002, s[2])], [0, 0, 0], [0, 0, 0]);
  return boxPart(name, s, [0, 0, 0], [0, 0, 0]);
}

function vecApi(seed: Vec) {
  const v = seed;
  return {
    get x() {
      return v.x;
    },
    set x(n: number) {
      v.x = Number(n) || 0;
    },
    get y() {
      return v.y;
    },
    set y(n: number) {
      v.y = Number(n) || 0;
    },
    get z() {
      return v.z;
    },
    set z(n: number) {
      v.z = Number(n) || 0;
    },
    set(x: number, y: number, z: number) {
      v.x = Number(x) || 0;
      v.y = Number(y) || 0;
      v.z = Number(z) || 0;
      return this;
    },
    copy(o: { x?: number; y?: number; z?: number }) {
      v.x = Number(o?.x) || 0;
      v.y = Number(o?.y) || 0;
      v.z = Number(o?.z) || 0;
      return this;
    },
    clone() {
      return vecApi(v3(v.x, v.y, v.z));
    },
    setScalar(n: number) {
      v.x = v.y = v.z = Number(n) || 0;
      return this;
    },
    add(o: { x?: number; y?: number; z?: number }) {
      v.x += Number(o?.x) || 0;
      v.y += Number(o?.y) || 0;
      v.z += Number(o?.z) || 0;
      return this;
    },
    _raw: v,
  };
}

function buildStub(): { THREE: Record<string, unknown>; harvest: () => GlbMeshPart[] } {
  const meshes: Array<{ obj: any; geom: Geom }> = [];

  class Object3D {
    name = "";
    children: Object3D[] = [];
    parent: Object3D | null = null;
    position = vecApi(v3());
    rotation = vecApi(v3());
    scale = vecApi(v3(1, 1, 1));
    userData: Record<string, unknown> = {};
    visible = true;
    castShadow = false;
    receiveShadow = false;
    matrixWorld = matIdentity();
    add(...kids: Object3D[]) {
      for (const k of kids) {
        if (!k) continue;
        k.parent = this;
        this.children.push(k);
      }
      return this;
    }
    traverse(fn: (o: Object3D) => void) {
      fn(this);
      for (const c of this.children) c.traverse(fn);
    }
    updateMatrixWorld() {
      const p = (this.position as any)._raw as Vec;
      const r = (this.rotation as any)._raw as Vec;
      const s = (this.scale as any)._raw as Vec;
      const local = composeTRS(p, r, s);
      this.matrixWorld = this.parent ? multiply(this.parent.matrixWorld, local) : local;
      for (const c of this.children) c.updateMatrixWorld();
    }
  }

  class Group extends Object3D {
    isGroup = true;
  }

  class Mesh extends Object3D {
    isMesh = true;
    geometry: { _geom: Geom };
    material: unknown;
    constructor(geometry: { _geom: Geom }, material: unknown) {
      super();
      this.geometry = geometry || { _geom: { kind: "box", size: [0.2, 0.2, 0.2] } };
      this.material = material;
      meshes.push({ obj: this, geom: this.geometry._geom });
    }
  }

  function geom(kind: GeomKind, size: [number, number, number]) {
    return { _geom: { kind, size }, dispose() {} };
  }

  const THREE = {
    Group,
    Mesh,
    Object3D,
    BoxGeometry: function BoxGeometry(w = 1, h = 1, d = 1) {
      return geom("box", [Number(w) || 1, Number(h) || 1, Number(d) || 1]);
    },
    SphereGeometry: function SphereGeometry(r = 0.5) {
      const d = Math.max(0.01, Number(r) || 0.5) * 2;
      return geom("sphere", [d, d, d]);
    },
    CylinderGeometry: function CylinderGeometry(rt = 1, rb = 1, h = 1) {
      const top = Number(rt) || 0;
      const bot = Number(rb) || 0;
      const height = Math.max(0.01, Number(h) || 1);
      const rad = Math.max(top, bot, 0.01);
      if (top < rad * 0.15 || bot < rad * 0.15) return geom("cone", [rad * 2, height, rad * 2]);
      return geom("cylinder", [rad * 2, height, rad * 2]);
    },
    ConeGeometry: function ConeGeometry(r = 0.5, h = 1) {
      const rad = Math.max(0.01, Number(r) || 0.5);
      return geom("cone", [rad * 2, Math.max(0.01, Number(h) || 1), rad * 2]);
    },
    PlaneGeometry: function PlaneGeometry(w = 1, h = 1) {
      return geom("plane", [Number(w) || 1, Number(h) || 1, 0.004]);
    },
    CircleGeometry: function CircleGeometry(r = 0.5) {
      const d = Math.max(0.01, Number(r) || 0.5) * 2;
      return geom("plane", [d, d, 0.004]);
    },
    CapsuleGeometry: function CapsuleGeometry(r = 0.1, len = 0.4) {
      const rad = Math.max(0.01, Number(r) || 0.1);
      return geom("cylinder", [rad * 2, Math.max(0.01, Number(len) || 0.4) + rad * 2, rad * 2]);
    },
    TorusGeometry: function TorusGeometry(r = 0.3) {
      const d = Math.max(0.05, Number(r) || 0.3) * 2;
      return geom("cylinder", [d, d * 0.25, d]);
    },
    LatheGeometry: function LatheGeometry() {
      return geom("cylinder", [0.2, 0.4, 0.2]);
    },
    ExtrudeGeometry: function ExtrudeGeometry() {
      return geom("box", [0.2, 0.2, 0.2]);
    },
    BufferGeometry: function BufferGeometry() {
      return geom("box", [0.2, 0.2, 0.2]);
    },
    InstancedMesh: Mesh,
    MeshStandardMaterial: function MeshStandardMaterial() {
      return { color: { set() {} }, roughness: 0.5, metalness: 0, dispose() {} };
    },
    MeshPhysicalMaterial: function MeshPhysicalMaterial() {
      return { color: { set() {} }, roughness: 0.5, metalness: 0, dispose() {} };
    },
    MeshBasicMaterial: function MeshBasicMaterial() {
      return { color: { set() {} }, dispose() {} };
    },
    MeshLambertMaterial: function MeshLambertMaterial() {
      return { color: { set() {} }, dispose() {} };
    },
    MeshPhongMaterial: function MeshPhongMaterial() {
      return { color: { set() {} }, dispose() {} };
    },
    Color: function Color() {
      return { set() {}, convertSRGBToLinear() {} };
    },
    Vector3: function Vector3(x = 0, y = 0, z = 0) {
      return vecApi(v3(Number(x) || 0, Number(y) || 0, Number(z) || 0));
    },
    Euler: function Euler(x = 0, y = 0, z = 0) {
      return vecApi(v3(Number(x) || 0, Number(y) || 0, Number(z) || 0));
    },
    Quaternion: function Quaternion() {
      return { set() {}, setFromEuler() {}, identity() {} };
    },
    Matrix4: function Matrix4() {
      return { identity() {}, makeRotationY() {}, multiply() {} };
    },
    CanvasTexture: function CanvasTexture() {
      return { needsUpdate: true, dispose() {} };
    },
    Texture: function Texture() {
      return { dispose() {} };
    },
    DoubleSide: 2,
    FrontSide: 0,
    BackSide: 1,
    SRGBColorSpace: "srgb",
    MathUtils: { degToRad: (d: number) => (Number(d) || 0) * (Math.PI / 180), clamp: (n: number, a: number, b: number) => Math.min(b, Math.max(a, n)) },
  };

  return {
    THREE,
    harvest() {
      const roots = new Set<any>();
      for (const { obj } of meshes) {
        let cursor: any = obj;
        while (cursor?.parent) cursor = cursor.parent;
        if (cursor) roots.add(cursor);
      }
      for (const root of roots) root.updateMatrixWorld?.();
      const parts: GlbMeshPart[] = [];
      for (const { obj, geom } of meshes) {
        if (!obj.visible) continue;
        const name = String(obj.name || "mesh");
        parts.push(applyWorld(localPart(name, geom), obj.matrixWorld || matIdentity()));
      }
      return parts;
    },
  };
}

function stripTypeScript(src: string): string {
  return src
    .replace(/^[\t ]*import[\s\S]*?from\s+['"][^'"]+['"];?\s*/gm, "")
    .replace(/\bexport\s+default\s+/g, "")
    .replace(/\bexport\s+/g, "")
    .replace(/\bas\s+THREE\.[A-Za-z0-9_]+/g, "")
    .replace(/:\s*THREE\.[A-Za-z0-9_<>|&\s]+/g, "")
    .replace(/:\s*(?:string|number|boolean|void|any|unknown|never|null|undefined)(\[\])?/g, "");
}

/**
 * Run factory TypeScript and return a GLB of the meshes `createModel()` built.
 */
export function executeFactoryToGlb(factoryCode: string): FactoryExecuteResult {
  const code = (factoryCode || "").trim();
  if (code.length < 80 || !/function\s+createModel\s*\(/.test(code)) {
    return { ok: false, error: "Factory has no createModel() to execute." };
  }
  if (/\b(?:process|require|fetch|XMLHttpRequest|WebSocket|eval)\b/.test(code)) {
    return { ok: false, error: "Factory uses a banned host API." };
  }

  const stub = buildStub();
  const canvas = {
    width: 8,
    height: 8,
    getContext() {
      return {
        fillStyle: "",
        fillRect() {},
        clearRect() {},
        beginPath() {},
        arc() {},
        fill() {},
        stroke() {},
        createLinearGradient() {
          return { addColorStop() {} };
        },
      };
    },
  };
  const sandbox = {
    THREE: stub.THREE,
    Math,
    console: { log() {}, warn() {}, info() {}, error() {} },
    document: { createElement: () => canvas },
    undefined,
  };

  const wrapped = `${stripTypeScript(code)}
if (typeof createModel !== "function") throw new Error("createModel is not a function");
const __root = createModel();
if (!__root) throw new Error("createModel returned empty");
__root.updateMatrixWorld && __root.updateMatrixWorld();
__root;`;

  try {
    runInNewContext(wrapped, sandbox, { timeout: EXEC_MS, displayErrors: false });
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err).slice(0, 240) };
  }

  const parts = stub.harvest();
  if (parts.length === 0) {
    return { ok: false, error: "createModel() built no meshes." };
  }

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

  try {
    return {
      ok: true,
      glb: writeGlb(parts),
      meshNames: parts.map((p) => p.name),
    };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err).slice(0, 240) };
  }
}
