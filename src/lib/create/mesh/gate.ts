/**
 * `mesh.post.gate` — the deterministic geometry HARD gate. Zero LLM tokens.
 *
 * Runs on both engines: Cloud after the Pixal/BlueFox export, Water on the GLB exported
 * from a factory. Same numbers, reports tagged by engine.
 *
 * Contract: docs/contracts/JOB_CARD.md · numbers: ../quality/thresholds.ts
 * Skill spec: agent-skills/.../skills/cloud/cloud-mesh-post/SKILL.md
 *
 * Laws:
 *   - No aesthetic judgement here. No VLM. A HARD fail is never rescued downstream.
 *   - Class profiles may RAISE bars, never lower them.
 *   - An inconclusive check fails closed; it never passes by default.
 */

import type { CreateEngine, FailCode } from "../contracts.js";
import {
  MESH_POST,
  TURNTABLE_ANGLES,
  type CreateAssetClass,
  type CreateProfile,
} from "../quality/thresholds.js";
import { analyseGeometry, computeBounds, type GeometryStats } from "./geometry.js";
import { parseGlb, GlbParseError, type ParsedGlb } from "./glb.js";
import { renderSilhouettes, type SilhouetteView } from "./silhouette.js";

/** Physical size envelopes, in metres. From cloud-mesh-post/references/hard-surface-geo.md. */
export const SCALE_ENVELOPE: Record<CreateAssetClass, { min: number; max: number }> = {
  prop: { min: 0.05, max: 5 },
  "prop-hero": { min: 0.05, max: 5 },
  vehicle: { min: 0.5, max: 12 },
};

/** A mesh sitting this far off the ground plane, relative to its height, is hovering. */
const GROUND_TOLERANCE_RATIO = 0.02;
/** Above this share of faces disagreeing with their normals, the asset reads inside-out. */
const MAX_INVERTED_NORMAL_RATIO = 0.25;

export type GateFinding = {
  code: FailCode;
  severity: "hard" | "warn";
  detail: string;
};

export type GateReport = {
  engine: CreateEngine;
  profile: CreateProfile;
  assetClass: CreateAssetClass;
  passed: boolean;
  findings: GateFinding[];
  /** True when a remesh pass could plausibly fix every HARD finding. */
  remeshCandidate: boolean;
  stats: GeometryStats | null;
  views: Array<{ angle: number; areaRatio: number; orbitRatio: number; coveredPixels: number }>;
  /** Measurements a reviewer needs without re-running the gate. */
  measurements: {
    triangleCount: number;
    longestEdgeM: number;
    volume: number;
    nonManifoldEdges: number;
    boundaryEdges: number;
    componentCount: number;
    minOrbitAreaRatio: number | null;
    uvCoverage: number;
    hasNormals: boolean;
  };
  /** Set when the GLB could not be parsed at all. */
  parseError?: string;
};

/** Fail codes a remesh pass can plausibly clear. */
const REMESHABLE: Set<FailCode> = new Set(["NON_MANIFOLD", "SELF_INTERSECT", "TRI_BUDGET", "FLOATER"]);

export type GateOptions = {
  engine: CreateEngine;
  profile: CreateProfile;
  assetClass: CreateAssetClass;
  /** Compiled `scale_m` intent; enables the tighter scale check. */
  expectedScaleM?: number | null;
  /** Raster size for the silhouette pass. */
  viewSize?: number;
  /** Cap on triangle-pair intersection tests. */
  maxPairTests?: number;
  /**
   * Water factories are overlapping primitives on purpose (flush/intersect children).
   * Skip SELF_INTERSECT / NON_MANIFOLD — those are Cloud watertight-mesh gates.
   */
  factoryOverlappingPrims?: boolean;
};

/**
 * Gate a GLB. Returns a report; never throws for mesh problems — an unparseable file is a
 * fail code, not an exception, so the JobCard always records a reason.
 */
export function runMeshPostGate(glbBytes: Buffer, options: GateOptions): GateReport {
  const base = {
    engine: options.engine,
    profile: options.profile,
    assetClass: options.assetClass,
    views: [] as GateReport["views"],
  };

  let parsed: ParsedGlb;
  try {
    parsed = parseGlb(glbBytes);
  } catch (err) {
    const detail = err instanceof GlbParseError ? err.message : String(err);
    return {
      ...base,
      passed: false,
      findings: [{ code: "GLTF_INVALID", severity: "hard", detail }],
      remeshCandidate: false,
      stats: null,
      measurements: {
        triangleCount: 0,
        longestEdgeM: 0,
        volume: 0,
        nonManifoldEdges: 0,
        boundaryEdges: 0,
        componentCount: 0,
        minOrbitAreaRatio: null,
        uvCoverage: 0,
        hasNormals: false,
      },
      parseError: detail,
    };
  }

  const findings: GateFinding[] = [];
  const stats = analyseGeometry(parsed, { maxPairTests: options.maxPairTests });

  // --- Emptiness -----------------------------------------------------------------
  if (stats.triangleCount === 0) {
    findings.push({
      code: "EMPTY_GLB",
      severity: "hard",
      detail: parsed.primitives.length === 0
        ? "No triangle primitives in the asset."
        : `All ${stats.degenerateTriangles} triangles were degenerate.`,
    });
  }

  // --- Finite bounds -------------------------------------------------------------
  if (!stats.bounds.finite) {
    findings.push({
      code: "NAN_BOUNDS",
      severity: "hard",
      detail: "Vertex positions contain NaN or Infinity.",
    });
  }

  // --- Normals -------------------------------------------------------------------
  if (stats.triangleCount > 0 && !stats.hasNormals) {
    findings.push({
      code: "NO_NORMALS",
      severity: "hard",
      detail: "No NORMAL attribute; engines will render flat or unlit.",
    });
  }
  if (stats.invertedNormalRatio > MAX_INVERTED_NORMAL_RATIO) {
    findings.push({
      code: "NO_NORMALS",
      severity: "hard",
      detail: `${(stats.invertedNormalRatio * 100).toFixed(0)}% of faces disagree with their normals (inside-out).`,
    });
  }

  // --- Manifoldness --------------------------------------------------------------
  if (
    !options.factoryOverlappingPrims &&
    stats.nonManifoldEdges > MESH_POST.maxNonManifoldEdges
  ) {
    findings.push({
      code: "NON_MANIFOLD",
      severity: "hard",
      detail: `${stats.nonManifoldEdges} non-manifold edge(s); tolerance is ${MESH_POST.maxNonManifoldEdges}.`,
    });
  }

  // --- Self-intersection ---------------------------------------------------------
  if (!options.factoryOverlappingPrims) {
    if (stats.selfIntersectingPairs > 0) {
      findings.push({
        code: "SELF_INTERSECT",
        severity: "hard",
        detail: `${stats.selfIntersectingPairs} intersecting triangle pair(s).`,
      });
    } else if (stats.selfIntersectionTruncated) {
      findings.push({
        code: "SELF_INTERSECT",
        severity: "hard",
        detail: "Self-intersection scan exceeded its work budget; result inconclusive, failing closed.",
      });
    }
  }

  // --- Volume --------------------------------------------------------------------
  if (stats.triangleCount > 0 && stats.volume <= 0) {
    findings.push({
      code: "THIN_SHELL",
      severity: "hard",
      detail: "Enclosed volume is zero — the asset is a flat or fully open shell.",
    });
  }

  // --- Triangle budget -----------------------------------------------------------
  // Draft is the only path with a ceiling here; game_ready tiers belong to mesh.bake.
  if (options.profile === "draft" && stats.triangleCount > MESH_POST.maxTrianglesDraft) {
    findings.push({
      code: "TRI_BUDGET",
      severity: "hard",
      detail: `${stats.triangleCount} triangles exceeds the draft ceiling of ${MESH_POST.maxTrianglesDraft}.`,
    });
  }

  // --- Floaters ------------------------------------------------------------------
  if (stats.floaterComponents > 0) {
    findings.push({
      code: "FLOATER",
      severity: "hard",
      detail: `${stats.floaterComponents} disconnected island(s) under 2% of the mesh — orphan blobs.`,
    });
  }

  // --- Scale ---------------------------------------------------------------------
  const envelope = SCALE_ENVELOPE[options.assetClass];
  if (stats.bounds.finite && stats.longestEdge > 0) {
    if (stats.longestEdge < envelope.min || stats.longestEdge > envelope.max) {
      findings.push({
        code: "SCALE",
        severity: "hard",
        detail: `Longest edge ${stats.longestEdge.toFixed(3)} m is outside the ${options.assetClass} envelope [${envelope.min}, ${envelope.max}] m.`,
      });
    }
    if (options.expectedScaleM && options.expectedScaleM > 0) {
      const error = Math.abs(stats.longestEdge - options.expectedScaleM) / options.expectedScaleM;
      // ±20% for prop class, per prop-score-rubric.md.
      if (error > 0.2) {
        findings.push({
          code: "SCALE",
          severity: options.profile === "draft" ? "warn" : "hard",
          detail: `Longest edge ${stats.longestEdge.toFixed(3)} m is ${(error * 100).toFixed(0)}% off the compiled scale_m of ${options.expectedScaleM} m.`,
        });
      }
    }
  }

  // --- Grounding -----------------------------------------------------------------
  if (stats.bounds.finite && stats.bounds.size[1] > 0) {
    const offset = Math.abs(stats.minY) / stats.bounds.size[1];
    if (offset > GROUND_TOLERANCE_RATIO) {
      findings.push({
        code: "NOT_GROUNDED",
        severity: "hard",
        detail: `Lowest vertex sits ${stats.minY.toFixed(3)} m from the ground plane (${(offset * 100).toFixed(1)}% of height); needs +Y grounded normalise.`,
      });
    }
  }

  // --- Orbit collapse ------------------------------------------------------------
  // Measured as each view's coverage relative to the widest view. A slab that reads
  // correctly head-on but vanishes edge-on fails here; solidity alone would not catch it.
  let views: SilhouetteView[] = [];
  let orbitRatios: number[] = [];
  let minOrbitRatio: number | null = null;
  if (stats.triangleCount > 0 && stats.bounds.finite) {
    views = renderSilhouettes(parsed, computeBounds(parsed), TURNTABLE_ANGLES, options.viewSize ?? 256);
    if (views.length > 0) {
      const widest = Math.max(...views.map((v) => v.coveredPixels));
      orbitRatios = views.map((v) => (widest > 0 ? v.coveredPixels / widest : 0));
      minOrbitRatio = Math.min(...orbitRatios);
      const collapsed = views
        .map((v, i) => ({ view: v, ratio: orbitRatios[i]! }))
        .filter((entry) => entry.ratio < MESH_POST.minOrbitAreaRatio);
      if (collapsed.length > 0) {
        findings.push({
          code: "ORBIT_COLLAPSE",
          severity: "hard",
          detail: `Silhouette collapses at ${collapsed.map((c) => `${c.view.angle}°`).join(", ")} — coverage ${collapsed.map((c) => c.ratio.toFixed(3)).join(", ")} of the widest view, below ${MESH_POST.minOrbitAreaRatio}.`,
        });
      }
    }
  }

  // --- UVs (warn; bake owns the fix) --------------------------------------------
  if (stats.triangleCount > 0 && stats.uvCoverage < 1) {
    findings.push({
      code: "NO_UV",
      severity: "warn",
      detail: `${Math.round((1 - stats.uvCoverage) * 100)}% of primitives lack TEXCOORD_0; mesh.bake must unwrap before game_ready.`,
    });
  }

  const hardFindings = findings.filter((f) => f.severity === "hard");

  return {
    ...base,
    passed: hardFindings.length === 0,
    findings,
    remeshCandidate:
      hardFindings.length > 0 && hardFindings.every((f) => REMESHABLE.has(f.code)),
    stats,
    views: views.map((v, i) => ({
      angle: v.angle,
      areaRatio: v.areaRatio,
      orbitRatio: orbitRatios[i] ?? 0,
      coveredPixels: v.coveredPixels,
    })),
    measurements: {
      triangleCount: stats.triangleCount,
      longestEdgeM: stats.longestEdge,
      volume: stats.volume,
      nonManifoldEdges: stats.nonManifoldEdges,
      boundaryEdges: stats.boundaryEdges,
      componentCount: stats.components.length,
      minOrbitAreaRatio: minOrbitRatio,
      uvCoverage: stats.uvCoverage,
      hasNormals: stats.hasNormals,
    },
  };
}

/** HARD fail codes from a report, for `run.checkpoint`. */
export function hardFailCodes(report: GateReport): FailCode[] {
  return [...new Set(report.findings.filter((f) => f.severity === "hard").map((f) => f.code))];
}
