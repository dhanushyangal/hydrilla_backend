/**
 * Structure gates that pixel metrics cannot see: named-part coverage and
 * parent/child attachment. Folded into `asset.score` / `mesh.post.gate`.
 */

import { parseGlb } from "../../create/mesh/glb.js";

export type Aabb = { min: [number, number, number]; max: [number, number, number] };

export type StructureReport = {
  meshNames: string[];
  missing: string[];
  fused: boolean;
  floating: string[];
  passed: boolean;
  notes: string[];
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function nameMatches(want: string, have: string): boolean {
  const w = norm(want);
  const h = norm(have);
  if (!w || !h) return false;
  if (w === h) return true;
  if (h.endsWith(`_${w}`) || h.startsWith(`${w}_`)) return true;
  if (w.length >= 4 && h.includes(w)) return true;
  return false;
}

function aabbFromPositions(positions: ArrayLike<number>): Aabb | null {
  if (positions.length < 3) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function mergeAabb(a: Aabb, b: Aabb): Aabb {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

function extent(box: Aabb): number {
  return Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
}

function overlapOrFlush(a: Aabb, b: Aabb, slack: number): boolean {
  const sep =
    a.max[0] < b.min[0] - slack ||
    b.max[0] < a.min[0] - slack ||
    a.max[1] < b.min[1] - slack ||
    b.max[1] < a.min[1] - slack ||
    a.max[2] < b.min[2] - slack ||
    b.max[2] < a.min[2] - slack;
  return !sep;
}

export function inspectStructure(params: {
  glb: Buffer;
  specComponents?: Array<{ name?: string; parent?: string | null }>;
  executedNames?: string[];
}): StructureReport {
  const notes: string[] = [];
  let meshNames = params.executedNames?.filter(Boolean) || [];
  const boxes = new Map<string, Aabb>();

  try {
    const parsed = parseGlb(params.glb);
    if (meshNames.length === 0) {
      meshNames = parsed.nodeNames.filter(Boolean) as string[];
    }
    for (const prim of parsed.primitives) {
      const key = prim.nodeName || "mesh";
      const box = aabbFromPositions(prim.positions);
      if (!box) continue;
      const prev = boxes.get(key);
      boxes.set(key, prev ? mergeAabb(prev, box) : box);
    }
  } catch (err: any) {
    return {
      meshNames,
      missing: (params.specComponents || []).map((c) => c.name || "").filter(Boolean),
      fused: false,
      floating: [],
      passed: false,
      notes: [`Could not parse factory GLB (${String(err?.message || err).slice(0, 120)}).`],
    };
  }

  const spec = (params.specComponents || []).filter((c) => c.name);
  const missing: string[] = [];
  for (const c of spec) {
    const want = c.name!;
    if (!meshNames.some((have) => nameMatches(want, have))) missing.push(want);
  }

  const fused = spec.length >= 3 && meshNames.length === 1;
  if (fused) notes.push("Spec listed multiple parts but the factory fused them onto one mesh.");

  const floating: string[] = [];
  for (const c of spec) {
    if (!c.parent) continue;
    const childName = meshNames.find((n) => nameMatches(c.name!, n));
    const parentName = meshNames.find((n) => nameMatches(c.parent!, n));
    if (!childName || !parentName) continue;
    const childBox = boxes.get(childName);
    const parentBox = boxes.get(parentName);
    if (!childBox || !parentBox) continue;
    const slack = Math.max(0.02, extent(parentBox) * 0.08);
    if (!overlapOrFlush(childBox, parentBox, slack)) {
      floating.push(c.name!);
    }
  }

  if (missing.length) notes.push(`Specified parts never built: ${missing.join(", ")}.`);
  if (floating.length) notes.push(`Parts not attached to parent: ${floating.join(", ")}.`);

  return {
    meshNames,
    missing,
    fused,
    floating,
    passed: missing.length === 0 && floating.length === 0 && !fused,
    notes,
  };
}
