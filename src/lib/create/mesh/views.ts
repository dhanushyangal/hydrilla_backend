/**
 * `asset.render_views` — turntable evidence capture.
 *
 * Evidence only. This module makes no judgement: it produces the four stills and the
 * masks that `asset.score` measures. Keeping capture and judgement apart is what stops a
 * "the render looked fine" argument from reaching a promote decision.
 *
 * Contract: docs/contracts/EVIDENCE_MANIFEST.md — exactly one turntable capture per angle.
 */

import { TURNTABLE_ANGLES } from "../quality/thresholds.js";
import { computeBounds } from "./geometry.js";
import { parseGlb } from "./glb.js";
import { shadeToPng } from "./png.js";
import { objectness, renderSilhouettes, type SilhouetteView } from "./silhouette.js";

export type RenderedView = {
  angle: number;
  /** PNG bytes, ready to upload as a `turntable` capture. */
  png: Buffer;
  width: number;
  height: number;
  coveredPixels: number;
  /** Coverage relative to the widest view — the collapse metric. */
  orbitRatio: number;
  /** Covered / bbox area — solidity. */
  areaRatio: number;
  objectness: number;
  /** Retained in-process for scoring; not persisted. */
  mask: Uint8Array;
};

export type RenderViewsResult = {
  views: RenderedView[];
  /** Multi-orbit self-consistency: how stable the silhouette is around the orbit. */
  orbitConsistency: number;
  /** Mean objectness across the orbit. */
  meanObjectness: number;
  error?: string;
};

/**
 * Render the turntable. Returns an empty view list with an `error` rather than throwing,
 * so a bad asset produces a recorded reason on the JobCard.
 */
export function renderViews(
  glbBytes: Buffer,
  options: { size?: number; angles?: readonly number[] } = {}
): RenderViewsResult {
  const size = options.size ?? 320;
  const angles = options.angles ?? TURNTABLE_ANGLES;

  let views: SilhouetteView[];
  try {
    const parsed = parseGlb(glbBytes);
    views = renderSilhouettes(parsed, computeBounds(parsed), angles, size);
  } catch (err) {
    return { views: [], orbitConsistency: 0, meanObjectness: 0, error: String(err) };
  }

  if (views.length === 0) {
    return { views: [], orbitConsistency: 0, meanObjectness: 0, error: "Nothing rasterised." };
  }

  const widest = Math.max(...views.map((v) => v.coveredPixels));
  const rendered: RenderedView[] = views.map((view) => ({
    angle: view.angle,
    png: shadeToPng(view.shade, view.mask, view.width, view.height),
    width: view.width,
    height: view.height,
    coveredPixels: view.coveredPixels,
    orbitRatio: widest > 0 ? view.coveredPixels / widest : 0,
    areaRatio: view.areaRatio,
    objectness: objectness(view),
    mask: view.mask,
  }));

  // Consistency = min/max coverage around the orbit. The evaluator prefers this over a
  // single-view IoU against a t2i plate, which punishes legitimate viewpoint differences.
  const coverages = rendered.map((v) => v.coveredPixels);
  const minCoverage = Math.min(...coverages);
  const maxCoverage = Math.max(...coverages);

  return {
    views: rendered,
    orbitConsistency: maxCoverage > 0 ? minCoverage / maxCoverage : 0,
    meanObjectness: rendered.reduce((sum, v) => sum + v.objectness, 0) / rendered.length,
  };
}
