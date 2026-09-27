/**
 * Software silhouette rasteriser — the CPU stand-in for a GPU turntable.
 *
 * Gives us three things the quality bar needs without a GL context:
 *   - orbit area ratio (collapse detection) for `mesh.post.gate`
 *   - turntable view masks at 0/90/180/270 for `asset.render_views`
 *   - silhouette IoU vs a reference mask for Tier1 in `asset.score`
 *
 * Orthographic projection with a depth buffer. Shaded output is a cheap Lambert term so
 * the turntable PNGs are readable by a human reviewer, but every gate decision is made
 * from the binary coverage mask, not from the shading.
 */

import type { ParsedGlb } from "./glb.js";
import type { Bounds } from "./geometry.js";

export type SilhouetteView = {
  /** Yaw in degrees around +Y. */
  angle: number;
  width: number;
  height: number;
  /** 1 where the mesh covers the pixel. */
  mask: Uint8Array;
  /** 0..255 Lambert shading, 0 where uncovered. Human-readable only. */
  shade: Uint8Array;
  /** Covered pixels. */
  coveredPixels: number;
  /** Covered pixels / pixels inside the projected bounding box. Collapse metric. */
  areaRatio: number;
  /** Projected bounding box in pixels. */
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
};

const DEFAULT_SIZE = 256;
/** Fraction of the frame left empty around the subject. */
const PADDING = 0.08;

type Projected = { x: number; y: number; depth: number };

/**
 * Project a world point for a given yaw. Camera looks down -Z after rotation; screen Y
 * is flipped so the image reads upright.
 */
function project(
  x: number,
  y: number,
  z: number,
  cos: number,
  sin: number,
  center: [number, number, number],
  scale: number,
  size: number
): Projected {
  const dx = x - center[0];
  const dy = y - center[1];
  const dz = z - center[2];
  const rx = dx * cos + dz * sin;
  const rz = -dx * sin + dz * cos;
  return {
    x: size / 2 + rx * scale,
    y: size / 2 - dy * scale,
    depth: rz,
  };
}

/** Fill one triangle with depth test. Standard top-left rule barycentric rasteriser. */
function rasteriseTriangle(
  p0: Projected,
  p1: Projected,
  p2: Projected,
  shadeValue: number,
  size: number,
  mask: Uint8Array,
  shade: Uint8Array,
  depth: Float32Array
) {
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  if (minX > maxX || minY > maxY) return;

  const area = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
  if (Math.abs(area) < 1e-12) return;
  const invArea = 1 / area;

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const w0 = ((p1.x - cx) * (p2.y - cy) - (p1.y - cy) * (p2.x - cx)) * invArea;
      const w1 = ((p2.x - cx) * (p0.y - cy) - (p2.y - cy) * (p0.x - cx)) * invArea;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;

      const d = w0 * p0.depth + w1 * p1.depth + w2 * p2.depth;
      const at = py * size + px;
      if (d < depth[at]!) {
        depth[at] = d;
        shade[at] = shadeValue;
      }
      mask[at] = 1;
    }
  }
}

/**
 * Render orthographic silhouettes at the given yaw angles.
 *
 * A single shared scale across all angles keeps the views comparable, which is what makes
 * the area ratio meaningful as a collapse signal.
 */
export function renderSilhouettes(
  glb: ParsedGlb,
  bounds: Bounds,
  angles: readonly number[],
  size: number = DEFAULT_SIZE
): SilhouetteView[] {
  const views: SilhouetteView[] = [];
  if (!bounds.finite) return views;

  // Worst-case horizontal extent across any yaw is the diagonal of the XZ footprint.
  const horizontal = Math.hypot(bounds.size[0], bounds.size[2]);
  const extent = Math.max(horizontal, bounds.size[1]);
  if (extent <= 1e-9) return views;
  const scale = (size * (1 - 2 * PADDING)) / extent;

  for (const angle of angles) {
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const mask = new Uint8Array(size * size);
    const shade = new Uint8Array(size * size);
    const depth = new Float32Array(size * size).fill(Infinity);

    for (const prim of glb.primitives) {
      const { positions, indices, normals } = prim;
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const i0 = indices[t]!, i1 = indices[t + 1]!, i2 = indices[t + 2]!;
        const ax = positions[i0 * 3]!, ay = positions[i0 * 3 + 1]!, az = positions[i0 * 3 + 2]!;
        const bx = positions[i1 * 3]!, by = positions[i1 * 3 + 1]!, bz = positions[i1 * 3 + 2]!;
        const cx = positions[i2 * 3]!, cy = positions[i2 * 3 + 1]!, cz = positions[i2 * 3 + 2]!;
        if (
          !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
          !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
          !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
        ) {
          continue;
        }

        // Face normal from winding; used only for shading.
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const nlen = Math.hypot(nx, ny, nz) || 1;
        nx /= nlen; ny /= nlen; nz /= nlen;
        if (normals) {
          const sx = normals[i0 * 3]!, sy = normals[i0 * 3 + 1]!, sz = normals[i0 * 3 + 2]!;
          if (Number.isFinite(sx)) { nx = sx; ny = sy; nz = sz; }
        }
        // Rotate the normal into view space and light from the camera, slightly above.
        const rnx = nx * cos + nz * sin;
        const rny = ny;
        const lambert = Math.abs(rnx * 0.25 + rny * 0.35 + 0.75);
        const shadeValue = Math.max(30, Math.min(255, Math.round(60 + lambert * 170)));

        rasteriseTriangle(
          project(ax, ay, az, cos, sin, bounds.center, scale, size),
          project(bx, by, bz, cos, sin, bounds.center, scale, size),
          project(cx, cy, cz, cos, sin, bounds.center, scale, size),
          shadeValue,
          size,
          mask,
          shade,
          depth
        );
      }
    }

    views.push({ angle, ...summariseMask(mask, size, size), mask, shade });
  }

  return views;
}

/** Coverage, projected bbox, and the collapse ratio for one mask. */
export function summariseMask(
  mask: Uint8Array,
  width: number,
  height: number
): { width: number; height: number; coveredPixels: number; areaRatio: number; bbox: SilhouetteView["bbox"] } {
  let covered = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      covered++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (covered === 0) {
    return { width, height, coveredPixels: 0, areaRatio: 0, bbox: null };
  }
  const bboxArea = (x1 - x0 + 1) * (y1 - y0 + 1);
  return {
    width,
    height,
    coveredPixels: covered,
    areaRatio: bboxArea > 0 ? covered / bboxArea : 0,
    bbox: { x0, y0, x1, y1 },
  };
}

/**
 * Silhouette IoU between two masks. Both are normalised by their own bounding box first,
 * so this measures shape agreement rather than framing agreement — that is the right
 * comparison for a generated mesh against a reference photo or t2i plate.
 */
export function silhouetteIou(
  a: { mask: Uint8Array; width: number; height: number },
  b: { mask: Uint8Array; width: number; height: number },
  gridSize = 128
): number {
  const na = normaliseMask(a, gridSize);
  const nb = normaliseMask(b, gridSize);
  if (!na || !nb) return 0;

  let intersection = 0;
  let union = 0;
  for (let i = 0; i < na.length; i++) {
    const inA = na[i] === 1;
    const inB = nb[i] === 1;
    if (inA && inB) intersection++;
    if (inA || inB) union++;
  }
  return union === 0 ? 0 : intersection / union;
}

/** Resample a mask's bounding-box content into a square grid. */
function normaliseMask(
  source: { mask: Uint8Array; width: number; height: number },
  gridSize: number
): Uint8Array | null {
  const summary = summariseMask(source.mask, source.width, source.height);
  if (!summary.bbox) return null;
  const { x0, y0, x1, y1 } = summary.bbox;
  const boxW = x1 - x0 + 1;
  const boxH = y1 - y0 + 1;

  const out = new Uint8Array(gridSize * gridSize);
  for (let gy = 0; gy < gridSize; gy++) {
    const sy = y0 + Math.floor((gy / gridSize) * boxH);
    for (let gx = 0; gx < gridSize; gx++) {
      const sx = x0 + Math.floor((gx / gridSize) * boxW);
      out[gy * gridSize + gx] = source.mask[sy * source.width + sx] ? 1 : 0;
    }
  }
  return out;
}

/** Aspect ratio of the projected silhouette; feeds Tier1's aspect error. */
export function maskAspect(view: { bbox: SilhouetteView["bbox"] }): number | null {
  if (!view.bbox) return null;
  const w = view.bbox.x1 - view.bbox.x0 + 1;
  const h = view.bbox.y1 - view.bbox.y0 + 1;
  return h === 0 ? null : w / h;
}

/**
 * Objectness: how much of the silhouette forms one solid, centred blob. Used as the
 * Tier1 rescue signal (`RECON_OBJ_MIN`) when a generated mesh fails IoU against a photo
 * for reasons that are framing rather than geometry.
 */
export function objectness(view: SilhouetteView): number {
  if (!view.bbox || view.coveredPixels === 0) return 0;
  const solidity = view.areaRatio;

  // Centroid offset from frame centre, normalised.
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < view.height; y++) {
    for (let x = 0; x < view.width; x++) {
      if (view.mask[y * view.width + x]) {
        sumX += x;
        sumY += y;
      }
    }
  }
  const cx = sumX / view.coveredPixels;
  const cy = sumY / view.coveredPixels;
  const offset =
    Math.hypot(cx - view.width / 2, cy - view.height / 2) / (Math.min(view.width, view.height) / 2);
  const centredness = Math.max(0, 1 - offset);

  return Math.max(0, Math.min(1, solidity * 0.6 + centredness * 0.4));
}
