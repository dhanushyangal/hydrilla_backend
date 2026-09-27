/**
 * Deterministic geometry analysis for `mesh.post.gate`. Zero LLM tokens.
 *
 * Every function here is pure math over a parsed GLB. The gate in `gate.ts` turns these
 * measurements into fail codes; nothing in this file decides pass/fail, so thresholds
 * stay in one place (`../quality/thresholds.ts`).
 *
 * Reference: agent-skills/.../cloud-mesh-post/references/{quality-bar,hard-surface-geo}.md
 */

import type { ParsedGlb, ParsedPrimitive } from "./glb.js";

export type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  center: [number, number, number];
  finite: boolean;
};

export type GeometryStats = {
  triangleCount: number;
  vertexCount: number;
  degenerateTriangles: number;
  hasNormals: boolean;
  /** Fraction of primitives carrying TEXCOORD_0. */
  uvCoverage: number;
  bounds: Bounds;
  /** Non-manifold edges: shared by anything other than exactly 2 triangles. */
  nonManifoldEdges: number;
  boundaryEdges: number;
  /** Connected components by shared vertex position, largest first, as triangle counts. */
  components: number[];
  /**
   * Components whose triangle share of the mesh is below the floater threshold and
   * which do not touch the largest component's bounds. Candidate FLOATER.
   */
  floaterComponents: number;
  /** Signed-volume-based check; near-zero means a flat or open shell. */
  volume: number;
  /** Lowest Y of the mesh — grounding uses this against total height. */
  minY: number;
  /** Longest bounding-box edge, in asset units (metres by glTF convention). */
  longestEdge: number;
  /** Inward/outward normal disagreement, as a fraction of sampled triangles. */
  invertedNormalRatio: number;
  selfIntersectingPairs: number;
  /** True when the self-intersection scan hit its work budget and stopped early. */
  selfIntersectionTruncated: boolean;
};

const EPSILON = 1e-9;
/** Vertices closer than this weld together for topology purposes. */
const WELD_PRECISION = 1e-5;

export function emptyBounds(): Bounds {
  return {
    min: [0, 0, 0],
    max: [0, 0, 0],
    size: [0, 0, 0],
    center: [0, 0, 0],
    finite: false,
  };
}

/** Quantised position key so topology survives float noise from exporters. */
function vertexKey(x: number, y: number, z: number): string {
  const q = (v: number) => Math.round(v / WELD_PRECISION);
  return `${q(x)},${q(y)},${q(z)}`;
}

type Triangle = {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  /** Welded vertex ids. */
  ia: number;
  ib: number;
  ic: number;
};

/** Flatten all primitives into one welded triangle list. */
function buildTriangles(glb: ParsedGlb): { triangles: Triangle[]; vertexCount: number; degenerate: number } {
  const idByKey = new Map<string, number>();
  const triangles: Triangle[] = [];
  let degenerate = 0;

  const weld = (x: number, y: number, z: number): number => {
    const key = vertexKey(x, y, z);
    const existing = idByKey.get(key);
    if (existing !== undefined) return existing;
    const id = idByKey.size;
    idByKey.set(key, id);
    return id;
  };

  for (const prim of glb.primitives) {
    const { positions, indices } = prim;
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const i0 = indices[t]!, i1 = indices[t + 1]!, i2 = indices[t + 2]!;
      const a: [number, number, number] = [positions[i0 * 3]!, positions[i0 * 3 + 1]!, positions[i0 * 3 + 2]!];
      const b: [number, number, number] = [positions[i1 * 3]!, positions[i1 * 3 + 1]!, positions[i1 * 3 + 2]!];
      const c: [number, number, number] = [positions[i2 * 3]!, positions[i2 * 3 + 1]!, positions[i2 * 3 + 2]!];

      const ia = weld(a[0], a[1], a[2]);
      const ib = weld(b[0], b[1], b[2]);
      const ic = weld(c[0], c[1], c[2]);
      if (ia === ib || ib === ic || ia === ic) {
        degenerate++;
        continue;
      }
      if (triangleArea(a, b, c) <= EPSILON) {
        degenerate++;
        continue;
      }
      triangles.push({ a, b, c, ia, ib, ic });
    }
  }

  return { triangles, vertexCount: idByKey.size, degenerate };
}

function triangleArea(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number]
): number {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return 0.5 * Math.hypot(cx, cy, cz);
}

export function computeBounds(glb: ParsedGlb): Bounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let finite = true;
  let any = false;

  for (const prim of glb.primitives) {
    const p = prim.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        finite = false;
        continue;
      }
      any = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }

  if (!any) return { ...emptyBounds(), finite };

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    finite,
  };
}

/**
 * Edge manifoldness. An edge shared by exactly 2 triangles is manifold; 1 is a boundary
 * (open shell); 3+ is non-manifold and a HARD fail.
 */
function analyseEdges(triangles: Triangle[]): { nonManifold: number; boundary: number } {
  const counts = new Map<string, number>();
  const bump = (u: number, v: number) => {
    const key = u < v ? `${u}_${v}` : `${v}_${u}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (const t of triangles) {
    bump(t.ia, t.ib);
    bump(t.ib, t.ic);
    bump(t.ic, t.ia);
  }
  let nonManifold = 0;
  let boundary = 0;
  for (const count of counts.values()) {
    if (count === 1) boundary++;
    else if (count > 2) nonManifold++;
  }
  return { nonManifold, boundary };
}

/** Connected components over welded vertices, returned as triangle counts, largest first. */
function analyseComponents(
  triangles: Triangle[],
  vertexCount: number
): { components: number[]; triangleComponent: Int32Array } {
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (const t of triangles) {
    union(t.ia, t.ib);
    union(t.ib, t.ic);
  }

  const sizeByRoot = new Map<number, number>();
  const triangleComponent = new Int32Array(triangles.length);
  for (let i = 0; i < triangles.length; i++) {
    const root = find(triangles[i]!.ia);
    triangleComponent[i] = root;
    sizeByRoot.set(root, (sizeByRoot.get(root) || 0) + 1);
  }

  const components = [...sizeByRoot.values()].sort((a, b) => b - a);
  return { components, triangleComponent };
}

/** Signed volume via the divergence theorem. Sign depends on winding; magnitude does not. */
function computeVolume(triangles: Triangle[]): number {
  let total = 0;
  for (const t of triangles) {
    const { a, b, c } = t;
    total +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return Math.abs(total);
}

/**
 * Fraction of triangles whose supplied normal disagrees with their winding normal.
 * Catches assets exported with flipped faces, which read as black/inside-out in engines.
 */
function invertedNormalRatio(glb: ParsedGlb): number {
  let checked = 0;
  let disagree = 0;
  for (const prim of glb.primitives) {
    if (!prim.normals) continue;
    const { positions, indices, normals } = prim;
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const i0 = indices[t]!, i1 = indices[t + 1]!, i2 = indices[t + 2]!;
      const ax = positions[i0 * 3]!, ay = positions[i0 * 3 + 1]!, az = positions[i0 * 3 + 2]!;
      const bx = positions[i1 * 3]!, by = positions[i1 * 3 + 1]!, bz = positions[i1 * 3 + 2]!;
      const cx = positions[i2 * 3]!, cy = positions[i2 * 3 + 1]!, cz = positions[i2 * 3 + 2]!;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len <= EPSILON) continue;
      // Average the three supplied vertex normals.
      const sx = (normals[i0 * 3]! + normals[i1 * 3]! + normals[i2 * 3]!) / 3;
      const sy = (normals[i0 * 3 + 1]! + normals[i1 * 3 + 1]! + normals[i2 * 3 + 1]!) / 3;
      const sz = (normals[i0 * 3 + 2]! + normals[i1 * 3 + 2]! + normals[i2 * 3 + 2]!) / 3;
      const slen = Math.hypot(sx, sy, sz);
      if (slen <= EPSILON) continue;
      const dot = (nx / len) * (sx / slen) + (ny / len) * (sy / slen) + (nz / len) * (sz / slen);
      checked++;
      if (dot < -0.5) disagree++;
    }
  }
  return checked === 0 ? 0 : disagree / checked;
}

/**
 * Triangle-triangle intersection, ignoring pairs that share a welded vertex.
 *
 * Contact is strictly interior: a crossing that lands exactly on an edge or vertex of the
 * other triangle counts as touching, not intersecting. That is deliberate — parts resting
 * flush against each other (a wheel on a base plate) are legal, and treating flush contact
 * as a HARD fail would reject good assets.
 */
function trianglesIntersect(t1: Triangle, t2: Triangle): boolean {
  if (
    t1.ia === t2.ia || t1.ia === t2.ib || t1.ia === t2.ic ||
    t1.ib === t2.ia || t1.ib === t2.ib || t1.ib === t2.ic ||
    t1.ic === t2.ia || t1.ic === t2.ib || t1.ic === t2.ic
  ) {
    return false; // adjacent faces legitimately touch
  }
  return segmentsCrossTriangle(t1, t2) || segmentsCrossTriangle(t2, t1);
}

function segmentsCrossTriangle(source: Triangle, target: Triangle): boolean {
  const edges: Array<[[number, number, number], [number, number, number]]> = [
    [source.a, source.b],
    [source.b, source.c],
    [source.c, source.a],
  ];
  for (const [p, q] of edges) {
    if (segmentIntersectsTriangle(p, q, target.a, target.b, target.c)) return true;
  }
  return false;
}

/** Möller–Trumbore, clamped to the segment. */
function segmentIntersectsTriangle(
  p: [number, number, number],
  q: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number]
): boolean {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];

  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-12) return false; // parallel

  const invDet = 1 / det;
  const sx = p[0] - a[0], sy = p[1] - a[1], sz = p[2] - a[2];
  const u = invDet * (sx * hx + sy * hy + sz * hz);
  if (u < 1e-9 || u > 1 - 1e-9) return false;

  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = invDet * (dx * qx + dy * qy + dz * qz);
  if (v < 1e-9 || u + v > 1 - 1e-9) return false;

  const t = invDet * (e2x * qx + e2y * qy + e2z * qz);
  // Strictly inside the segment — endpoint touches are not intersections.
  return t > 1e-9 && t < 1 - 1e-9;
}

type TriAabb = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };

function triangleAabb(t: Triangle): TriAabb {
  return {
    minX: Math.min(t.a[0], t.b[0], t.c[0]),
    minY: Math.min(t.a[1], t.b[1], t.c[1]),
    minZ: Math.min(t.a[2], t.b[2], t.c[2]),
    maxX: Math.max(t.a[0], t.b[0], t.c[0]),
    maxY: Math.max(t.a[1], t.b[1], t.c[1]),
    maxZ: Math.max(t.a[2], t.b[2], t.c[2]),
  };
}

function aabbOverlap(a: TriAabb, b: TriAabb): boolean {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX &&
    a.minY <= b.maxY && a.maxY >= b.minY &&
    a.minZ <= b.maxZ && a.maxZ >= b.minZ
  );
}

/** A triangle spanning more cells than this is tested broadly instead of being binned. */
const MAX_CELLS_PER_TRIANGLE = 128;

/**
 * Self-intersection scan with a uniform grid.
 *
 * Triangles are binned by every cell their AABB touches, not by their vertex cells —
 * binning by vertices alone misses two large faces that cross in a cell neither owns a
 * vertex in, which is exactly the overlapping-part artefact we care about.
 *
 * Cell size is derived from the mean triangle size so the number of cells per triangle
 * stays small on both dense and coarse meshes. Exhaustive testing is O(n²), so the scan
 * carries a work budget; if it runs out, `truncated` is reported and the gate treats the
 * result as inconclusive rather than as a pass.
 */
function analyseSelfIntersection(
  triangles: Triangle[],
  bounds: Bounds,
  maxPairTests: number
): { pairs: number; truncated: boolean } {
  if (triangles.length < 2 || !bounds.finite) return { pairs: 0, truncated: false };

  const extent = Math.max(bounds.size[0], bounds.size[1], bounds.size[2]);
  if (extent <= EPSILON) return { pairs: 0, truncated: false };

  const aabbs = triangles.map(triangleAabb);

  // Size cells to the typical triangle so AABB binning stays cheap.
  let meanSpan = 0;
  for (const box of aabbs) {
    meanSpan += Math.max(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
  }
  meanSpan /= aabbs.length;
  const cell = Math.max(meanSpan, extent / 128, EPSILON);

  const grid = new Map<string, number[]>();
  /** Triangles too large to bin usefully; compared against everything nearby. */
  const oversized: number[] = [];

  const cellIndex = (value: number, origin: number) => Math.floor((value - origin) / cell);

  for (let i = 0; i < triangles.length; i++) {
    const box = aabbs[i]!;
    const ix0 = cellIndex(box.minX, bounds.min[0]);
    const ix1 = cellIndex(box.maxX, bounds.min[0]);
    const iy0 = cellIndex(box.minY, bounds.min[1]);
    const iy1 = cellIndex(box.maxY, bounds.min[1]);
    const iz0 = cellIndex(box.minZ, bounds.min[2]);
    const iz1 = cellIndex(box.maxZ, bounds.min[2]);

    const spanned = (ix1 - ix0 + 1) * (iy1 - iy0 + 1) * (iz1 - iz0 + 1);
    if (spanned > MAX_CELLS_PER_TRIANGLE) {
      oversized.push(i);
      continue;
    }
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const key = `${ix},${iy},${iz}`;
          const bucket = grid.get(key);
          if (bucket) bucket.push(i);
          else grid.set(key, [i]);
        }
      }
    }
  }

  let pairs = 0;
  let tests = 0;
  const tested = new Set<number>();
  const triangleCount = triangles.length;

  const testPair = (lo: number, hi: number): "hit" | "miss" | "budget" => {
    const key = lo * triangleCount + hi;
    if (tested.has(key)) return "miss";
    tested.add(key);
    if (!aabbOverlap(aabbs[lo]!, aabbs[hi]!)) return "miss";
    if (++tests > maxPairTests) return "budget";
    return trianglesIntersect(triangles[lo]!, triangles[hi]!) ? "hit" : "miss";
  };

  for (const bucket of grid.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const lo = Math.min(bucket[i]!, bucket[j]!);
        const hi = Math.max(bucket[i]!, bucket[j]!);
        const result = testPair(lo, hi);
        if (result === "budget") return { pairs, truncated: true };
        // A handful is enough to fail; stop burning CPU.
        if (result === "hit" && ++pairs >= 8) return { pairs, truncated: false };
      }
    }
  }

  for (const big of oversized) {
    for (let other = 0; other < triangleCount; other++) {
      if (other === big) continue;
      const lo = Math.min(big, other);
      const hi = Math.max(big, other);
      const result = testPair(lo, hi);
      if (result === "budget") return { pairs, truncated: true };
      if (result === "hit" && ++pairs >= 8) return { pairs, truncated: false };
    }
  }

  return { pairs, truncated: false };
}

export function analyseGeometry(
  glb: ParsedGlb,
  options: { maxPairTests?: number; floaterShare?: number } = {}
): GeometryStats {
  const bounds = computeBounds(glb);
  const { triangles, vertexCount, degenerate } = buildTriangles(glb);

  const edges = analyseEdges(triangles);
  const { components } = analyseComponents(triangles, vertexCount);
  const floaterShare = options.floaterShare ?? 0.02;
  const totalTris = triangles.length || 1;
  // Small disconnected islands are the classic Trellis artefact: orphan blobs under the
  // chassis, stray wheel fragments.
  const floaterComponents = components
    .slice(1)
    .filter((count) => count / totalTris < floaterShare).length;

  const primitivesWithUv = glb.primitives.filter((p: ParsedPrimitive) => p.hasUv).length;
  const selfIntersection = analyseSelfIntersection(
    triangles,
    bounds,
    options.maxPairTests ?? 400_000
  );

  return {
    triangleCount: triangles.length,
    vertexCount,
    degenerateTriangles: degenerate,
    hasNormals: glb.primitives.some((p) => p.normals !== null),
    uvCoverage: glb.primitives.length === 0 ? 0 : primitivesWithUv / glb.primitives.length,
    bounds,
    nonManifoldEdges: edges.nonManifold,
    boundaryEdges: edges.boundary,
    components,
    floaterComponents,
    volume: computeVolume(triangles),
    minY: bounds.finite ? bounds.min[1] : 0,
    longestEdge: Math.max(bounds.size[0], bounds.size[1], bounds.size[2]),
    invertedNormalRatio: invertedNormalRatio(glb),
    selfIntersectingPairs: selfIntersection.pairs,
    selfIntersectionTruncated: selfIntersection.truncated,
  };
}
