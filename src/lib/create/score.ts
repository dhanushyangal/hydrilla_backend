/**
 * `asset.score` — the skeptical evaluator. Owns promote/reject.
 *
 * Order is load-bearing and enforced by `scoreAsset`:
 *   1. mesh-post HARD must be green. A HARD geometry fail is never scored, never
 *      VLM-rescued, never promoted. This is checked first and returns immediately.
 *   2. Evidence must be complete and fresh for the current runId.
 *   3. Tier1 geometry comparison (IoU / scale / aspect), with the objectness probe.
 *   4. Deterministic identity features.
 *   5. Optional VLM, multi-sample near the threshold. Unavailable ⇒ unavailable, never a pass.
 *   6. Profile + class floors, raise-only.
 *
 * Spec: agent-skills/.../skills/cloud/cloud-evaluate/SKILL.md
 * Rubrics: .../references/{prop-score-rubric,car-identity-features,img2threejs-must-fold}.md
 */

import {
  checkEvidence,
  isHardGeoFail,
  type EvidenceManifest,
  type FailCode,
  type JobCard,
} from "./contracts.js";
import type { GateReport } from "./mesh/gate.js";
import { composeComparisonSheet, type SheetTile } from "./mesh/png.js";
import { maskAspect, silhouetteIou } from "./mesh/silhouette.js";
import type { RenderViewsResult } from "./mesh/views.js";
import {
  MESH_POST,
  SCORE,
  TIER1,
  resolveFloors,
  type CreateAssetClass,
  type CreateProfile,
} from "./quality/thresholds.js";

export type ReferenceMask = {
  mask: Uint8Array;
  width: number;
  height: number;
  /** Where the reference came from — required for provenance. */
  source: "user_upload" | "t2i" | "rembg";
};

export type Tier1Result = {
  /** Best silhouette IoU across the orbit against the reference. */
  iou: number | null;
  /** Which turntable angle produced the best IoU. */
  bestAngle: number | null;
  scaleError: number | null;
  aspectError: number | null;
  objectness: number;
  passed: boolean;
  /**
   * True when IoU is below its floor but objectness clears RECON_OBJ_MIN. The run goes to
   * a targeted probe instead of a blind IoU reject — and this never rescues a geo HARD fail.
   */
  objectnessProbe: boolean;
  failCodes: FailCode[];
  notes: string[];
};

export type FeatureScore = {
  name: string;
  /** null when the signal needs a VLM that was not available. */
  score: number | null;
  critical: boolean;
  /** How the number was obtained — evidence provenance, not vibes. */
  provenance: "deterministic" | "vlm";
  detail: string;
};

export type VlmSample = {
  /** Per-criterion scores, keyed by feature name. */
  criteria: Record<string, number>;
};

export type VlmResult =
  | { available: true; samples: VlmSample[] }
  | { available: false; reason: string };

/**
 * A VLM scorer. Deliberately an interface: no provider is wired in here, so the evaluator
 * cannot accidentally depend on one being present.
 */
export type VlmScorer = (input: {
  viewPngs: Buffer[];
  assetClass: CreateAssetClass;
  criteria: string[];
  /** Number of samples requested; the evaluator asks for more near a threshold. */
  samples: number;
}) => Promise<VlmResult>;

/** The default. Fails closed: no VLM means VLM-gated features stay unavailable. */
export const unavailableVlm: VlmScorer = async () => ({
  available: false,
  reason: "No VLM adapter is configured for this deployment.",
});

export type ScoreReport = {
  runId: string;
  engine: JobCard["engine"];
  profile: CreateProfile;
  assetClass: CreateAssetClass;
  /** Blocked before any measurement when mesh-post was a HARD fail. */
  scored: boolean;
  tier1: Tier1Result | null;
  features: FeatureScore[];
  /** Aggregate fidelity, 0..1. null when too little evidence to compute one. */
  fidelity: number | null;
  floors: ReturnType<typeof resolveFloors>;
  vlm: { attempted: boolean; available: boolean; reason?: string; spread?: number };
  promoteEligible: boolean;
  /** True when the score is high enough to be worth another refine pass. */
  worthRefining: boolean;
  failCodes: FailCode[];
  reasons: string[];
  /** Exactly one per runId. */
  comparisonSheet: Buffer | null;
};

/** VLM-only criteria by class. Everything else is measured deterministically. */
const VLM_CRITERIA: Record<CreateAssetClass, string[]> = {
  prop: ["material_separation", "surface_readability"],
  "prop-hero": ["material_separation", "surface_readability", "detail_density"],
  vehicle: ["cabin_greenhouse", "glass_readability", "panel_grille_readability"],
};

/** Deterministic features are the same shape for every class; weights differ by class. */
const CRITICAL_DETERMINISTIC = new Set(["silhouette_readability", "ground_contact", "scale_match"]);

/**
 * Tier1: geometric agreement with the reference, before any aesthetics.
 *
 * IoU is taken as the best match across the orbit rather than against a single view. A
 * generated mesh legitimately differs in yaw from a reference photo, and punishing that
 * produced false rejects on otherwise good assets.
 */
export function runTier1(params: {
  views: RenderViewsResult;
  reference: ReferenceMask | null;
  gate: GateReport;
  expectedScaleM?: number | null;
}): Tier1Result {
  const notes: string[] = [];
  const failCodes: FailCode[] = [];
  const { views, reference, gate } = params;

  const obj = views.meanObjectness;

  let iou: number | null = null;
  let bestAngle: number | null = null;
  let aspectError: number | null = null;

  if (!reference) {
    notes.push("No reference mask supplied; IoU and aspect were not measured.");
  } else if (views.views.length === 0) {
    notes.push("No rendered views; Tier1 could not be measured.");
  } else {
    for (const view of views.views) {
      const value = silhouetteIou(
        { mask: view.mask, width: view.width, height: view.height },
        reference
      );
      if (iou === null || value > iou) {
        iou = value;
        bestAngle = view.angle;
      }
    }

    const referenceAspect = maskAspect({
      bbox: summariseBbox(reference.mask, reference.width, reference.height),
    });
    const best = views.views.find((v) => v.angle === bestAngle);
    const candidateAspect = best
      ? maskAspect({ bbox: summariseBbox(best.mask, best.width, best.height) })
      : null;
    if (referenceAspect && candidateAspect) {
      aspectError = Math.abs(candidateAspect - referenceAspect) / referenceAspect;
    }
  }

  // Scale is measured against the compiled intent, not against the reference image —
  // a photo carries no metric scale.
  let scaleError: number | null = null;
  if (params.expectedScaleM && params.expectedScaleM > 0 && gate.measurements.longestEdgeM > 0) {
    scaleError =
      Math.abs(gate.measurements.longestEdgeM - params.expectedScaleM) / params.expectedScaleM;
  } else {
    notes.push("No compiled scale_m; scale error was not measured.");
  }

  let objectnessProbe = false;
  if (iou !== null && iou < TIER1.minIou) {
    if (obj >= TIER1.reconObjMin) {
      objectnessProbe = true;
      notes.push(
        `IoU ${iou.toFixed(3)} is below ${TIER1.minIou} but objectness ${obj.toFixed(3)} clears ${TIER1.reconObjMin} — routing to a targeted probe instead of a blind IoU reject.`
      );
    } else {
      failCodes.push("IOU");
      notes.push(`IoU ${iou.toFixed(3)} below ${TIER1.minIou} with objectness ${obj.toFixed(3)}.`);
    }
  }
  if (scaleError !== null && scaleError > TIER1.maxScaleError) {
    failCodes.push("SCALE");
    notes.push(`Scale error ${(scaleError * 100).toFixed(1)}% exceeds ${TIER1.maxScaleError * 100}%.`);
  }
  if (aspectError !== null && aspectError > TIER1.maxAspectError) {
    failCodes.push("ASPECT");
    notes.push(`Aspect error ${(aspectError * 100).toFixed(1)}% exceeds ${TIER1.maxAspectError * 100}%.`);
  }

  return {
    iou,
    bestAngle,
    scaleError,
    aspectError,
    objectness: obj,
    passed: failCodes.length === 0,
    objectnessProbe,
    failCodes,
    notes,
  };
}

function summariseBbox(mask: Uint8Array, width: number, height: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let covered = 0;
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
  return covered === 0 ? null : { x0, y0, x1, y1 };
}

/**
 * Deterministic identity features. Never more than `maxCriticalFeatures` critical entries.
 * Everything measurable without a model is measured here; class-specific aesthetics are
 * left to the VLM and stay `null` when it is absent.
 */
export function deterministicFeatures(params: {
  views: RenderViewsResult;
  gate: GateReport;
  assetClass: CreateAssetClass;
  expectedScaleM?: number | null;
  /** Distinct material slots on the asset, for part separation. */
  materialCount: number;
  /** Named nodes, for the "named parts" axis of the prop rubric. */
  namedParts: string[];
}): FeatureScore[] {
  const { views, gate } = params;
  const features: FeatureScore[] = [];

  // 1. Silhouette readability: is the worst view still a coherent mass?
  //
  // Measured as the minimum solidity (coverage / bounding-box area) around the orbit, NOT
  // as coverage consistency between views. A car is metres long and barely two wide, so
  // its front and side silhouettes differ enormously — grading that difference punishes
  // correctly proportioned assets. Outright collapse is already a HARD gate fail.
  const minSolidity =
    views.views.length > 0 ? Math.min(...views.views.map((v) => v.areaRatio)) : 0;
  features.push({
    name: "silhouette_readability",
    score: clamp01(minSolidity / 0.5),
    critical: true,
    provenance: "deterministic",
    detail: `Worst-angle silhouette solidity ${minSolidity.toFixed(3)} across ${views.views.length} views.`,
  });

  // 2. Ground contact. The gate already HARD-fails a hover; this grades how clean it is.
  const height = gate.stats?.bounds.size[1] ?? 0;
  const offset = height > 0 ? Math.abs(gate.stats?.minY ?? 0) / height : 1;
  features.push({
    name: "ground_contact",
    score: clamp01(1 - offset / 0.02),
    critical: true,
    provenance: "deterministic",
    detail: `Lowest vertex is ${(offset * 100).toFixed(2)}% of height off the ground plane.`,
  });

  // 3. Scale against the compiled contract.
  if (params.expectedScaleM && params.expectedScaleM > 0) {
    const error =
      Math.abs(gate.measurements.longestEdgeM - params.expectedScaleM) / params.expectedScaleM;
    features.push({
      name: "scale_match",
      score: clamp01(1 - error / 0.2),
      critical: true,
      provenance: "deterministic",
      detail: `${gate.measurements.longestEdgeM.toFixed(3)} m against a compiled ${params.expectedScaleM} m (${(error * 100).toFixed(1)}% off).`,
    });
  } else {
    features.push({
      name: "scale_match",
      score: null,
      critical: true,
      provenance: "deterministic",
      detail: "No compiled scale_m to compare against.",
    });
  }

  // 4. Part separation: distinct material slots and named nodes.
  const partSignal = Math.min(1, (params.materialCount - 1) / 2) * 0.6 +
    Math.min(1, params.namedParts.length / 3) * 0.4;
  features.push({
    name: "part_separation",
    score: clamp01(partSignal),
    critical: false,
    provenance: "deterministic",
    detail: `${params.materialCount} material slot(s), ${params.namedParts.length} named node(s).`,
  });

  // 5. Orbit stability: how much the silhouette area swings around the turntable.
  // Informational and non-critical, precisely because elongation is legitimate.
  features.push({
    name: "orbit_stability",
    score: clamp01((views.orbitConsistency - MESH_POST.minOrbitAreaRatio) / 0.35),
    critical: false,
    provenance: "deterministic",
    detail: `Silhouette coverage varies by ${((1 - views.orbitConsistency) * 100).toFixed(0)}% around the orbit (min/max ${views.orbitConsistency.toFixed(3)}).`,
  });

  return features;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Build the single comparison sheet for this runId: the reference beside each orbit view.
 * The column order is returned in the score report — the sheet carries a coded marker bar
 * rather than text, because there is no font dependency.
 */
export function buildComparisonSheet(params: {
  views: RenderViewsResult;
  reference: ReferenceMask | null;
}): { png: Buffer | null; columns: string[] } {
  const tiles: SheetTile[] = [];
  const columns: string[] = [];

  if (params.reference) {
    const pixels = new Uint8Array(params.reference.width * params.reference.height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = params.reference.mask[i] ? 90 : 244;
    tiles.push({
      label: `reference:${params.reference.source}`,
      width: params.reference.width,
      height: params.reference.height,
      pixels,
    });
    columns.push(`reference (${params.reference.source})`);
  }

  for (const view of params.views.views) {
    const pixels = new Uint8Array(view.width * view.height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = view.mask[i] ? 90 : 244;
    tiles.push({ label: `candidate:${view.angle}`, width: view.width, height: view.height, pixels });
    columns.push(`candidate ${view.angle}°`);
  }

  if (tiles.length === 0) return { png: null, columns: [] };
  return { png: composeComparisonSheet(tiles), columns };
}

/**
 * Run the evaluator. `vlm` defaults to the unavailable scorer so a deployment without a
 * model configured degrades to "cannot promote", never to "promoted anyway".
 */
export async function scoreAsset(params: {
  card: JobCard;
  gate: GateReport;
  views: RenderViewsResult;
  reference: ReferenceMask | null;
  manifest: EvidenceManifest;
  expectedScaleM?: number | null;
  materialCount: number;
  namedParts: string[];
  bakeRan?: boolean;
  vlm?: VlmScorer;
  structure?: {
    missing: string[];
    fused: boolean;
    floating: string[];
    notes: string[];
  };
  interior?: {
    score: number | null;
    cellsCompared: number;
    passed: boolean;
    notes: string[];
  };
}): Promise<ScoreReport> {
  const { card, gate } = params;
  const floors = resolveFloors(card.profile, card.assetClass);
  const reasons: string[] = [];
  const failCodes: FailCode[] = [];

  const base: ScoreReport = {
    runId: card.runId,
    engine: card.engine,
    profile: card.profile,
    assetClass: card.assetClass,
    scored: false,
    tier1: null,
    features: [],
    fidelity: null,
    floors,
    vlm: { attempted: false, available: false },
    promoteEligible: false,
    worthRefining: false,
    failCodes,
    reasons,
    comparisonSheet: null,
  };

  // --- Step 1: a HARD geometry fail is never scored -------------------------------
  const gateCodes = gate.findings.filter((f) => f.severity === "hard").map((f) => f.code);
  if (!gate.passed || isHardGeoFail(gateCodes)) {
    reasons.push(
      `mesh-post HARD fail (${gateCodes.join(", ") || "gate did not pass"}) — refusing to score aesthetics. Fix geometry or reject.`
    );
    return { ...base, failCodes: gateCodes };
  }

  // --- Step 2: Tier1 --------------------------------------------------------------
  const tier1 = runTier1({
    views: params.views,
    reference: params.reference,
    gate,
    expectedScaleM: params.expectedScaleM,
  });
  failCodes.push(...tier1.failCodes);
  reasons.push(...tier1.notes);

  // --- Step 3: deterministic features --------------------------------------------
  const features = deterministicFeatures({
    views: params.views,
    gate,
    assetClass: card.assetClass,
    expectedScaleM: params.expectedScaleM,
    materialCount: params.materialCount,
    namedParts: params.namedParts,
  });

  // --- Step 4: comparison sheet --------------------------------------------------
  const sheet = buildComparisonSheet({ views: params.views, reference: params.reference });
  if (sheet.png) reasons.push(`Comparison sheet columns: ${sheet.columns.join(" | ")}.`);

  // --- Step 5: VLM, only past a geo HARD pass ------------------------------------
  const criteria = VLM_CRITERIA[card.assetClass];
  const scorer = params.vlm ?? unavailableVlm;
  const deterministicMean = mean(features.map((f) => f.score).filter(isNumber));
  // Multi-sample when the deterministic signal sits near a floor, where a single sample
  // is most likely to flip the decision.
  const nearThreshold = Math.abs(deterministicMean - floors.fidelity) < 0.1;
  let vlmState: ScoreReport["vlm"] = { attempted: true, available: false };

  const vlmResult = await scorer({
    viewPngs: params.views.views.map((v) => v.png),
    assetClass: card.assetClass,
    criteria,
    samples: nearThreshold ? 3 : 1,
  });

  if (!vlmResult.available) {
    vlmState = { attempted: true, available: false, reason: vlmResult.reason };
    for (const name of criteria) {
      features.push({
        name,
        score: null,
        critical: card.assetClass === "vehicle",
        provenance: "vlm",
        detail: `Unavailable: ${vlmResult.reason}`,
      });
    }
    reasons.push(
      `VLM unavailable (${vlmResult.reason}); ${criteria.length} criteria are unmeasured. Unmeasured is not a pass.`
    );
  } else {
    let maxSpread = 0;
    for (const name of criteria) {
      const values = vlmResult.samples
        .map((s) => s.criteria[name])
        .filter(isNumber);
      if (values.length === 0) {
        features.push({
          name,
          score: null,
          critical: card.assetClass === "vehicle",
          provenance: "vlm",
          detail: "VLM returned no value for this criterion.",
        });
        continue;
      }
      const spread = Math.max(...values) - Math.min(...values);
      maxSpread = Math.max(maxSpread, spread);
      features.push({
        name,
        score: mean(values),
        critical: card.assetClass === "vehicle",
        provenance: "vlm",
        detail: `${values.length} sample(s), mean ${mean(values).toFixed(3)}, spread ${spread.toFixed(3)}.`,
      });
    }
    vlmState = { attempted: true, available: true, spread: maxSpread };
    if (maxSpread > SCORE.vlmMaxSpread) {
      failCodes.push("VLM_SPREAD");
      reasons.push(
        `VLM sample spread ${maxSpread.toFixed(3)} exceeds ${SCORE.vlmMaxSpread} — the judge is not confident.`
      );
    }
  }

  // --- Step 6: floors -------------------------------------------------------------
  const criticalFeatures = features.filter((f) => f.critical).slice(0, SCORE.maxCriticalFeatures);
  const importantFeatures = features.filter((f) => !f.critical);

  const unmeasuredCritical = criticalFeatures.filter((f) => f.score === null);
  for (const feature of criticalFeatures) {
    if (feature.score !== null && feature.score < floors.criticalFeature) {
      failCodes.push("IDENTITY_FEATURE");
      reasons.push(
        `Critical feature "${feature.name}" scored ${feature.score.toFixed(2)}, below the ${floors.criticalFeature.toFixed(2)} floor. ${feature.detail}`
      );
    }
  }
  if (unmeasuredCritical.length > 0) {
    failCodes.push("IDENTITY_FEATURE");
    reasons.push(
      `Critical feature(s) unmeasured: ${unmeasuredCritical.map((f) => f.name).join(", ")}. Cannot promote on missing evidence.`
    );
  }

  const importantMean = mean(importantFeatures.map((f) => f.score).filter(isNumber));
  if (importantFeatures.some((f) => f.score !== null) && importantMean < floors.importantAvg) {
    reasons.push(
      `Important feature mean ${importantMean.toFixed(2)} is below the ${floors.importantAvg.toFixed(2)} floor.`
    );
    failCodes.push("FIDELITY_FLOOR");
  }

  // Fidelity blends Tier1 agreement with the feature scores. Unmeasured critical features
  // hold it at null rather than letting a partial measurement stand in for the whole.
  const measured = [...criticalFeatures, ...importantFeatures].map((f) => f.score).filter(isNumber);
  const fidelity =
    unmeasuredCritical.length > 0 || measured.length === 0
      ? null
      : clamp01(mean(measured) * 0.7 + (tier1.iou ?? mean(measured)) * 0.3);

  if (fidelity !== null && fidelity < floors.fidelity) {
    failCodes.push("FIDELITY_FLOOR");
    reasons.push(`Fidelity ${fidelity.toFixed(2)} is below the ${card.profile}/${card.assetClass} floor ${floors.fidelity.toFixed(2)}.`);
  }

  if (params.structure) {
    reasons.push(...params.structure.notes);
    if (params.structure.missing.length > 0 || params.structure.fused) {
      failCodes.push("PART_COVERAGE");
    }
    if (params.structure.floating.length > 0) {
      failCodes.push("ATTACHMENT");
    }
  }
  if (params.interior) {
    reasons.push(...params.interior.notes);
    if (!params.interior.passed) {
      failCodes.push("INTERIOR");
    }
  }

  // --- Evidence gate --------------------------------------------------------------
  const evidence = checkEvidence({
    manifest: params.manifest,
    card,
    hasReferenceImage: Boolean(params.reference),
    bakeRan: params.bakeRan,
    fidelity,
    gatePassed: gate.passed,
  });
  if (!evidence.promoteEligible) {
    failCodes.push("EVIDENCE_INCOMPLETE");
    reasons.push(...evidence.reasons);
  }

  const uniqueCodes = [...new Set(failCodes)];
  const promoteEligible = uniqueCodes.length === 0 && evidence.promoteEligible && fidelity !== null;

  return {
    ...base,
    scored: true,
    tier1,
    features,
    fidelity,
    vlm: vlmState,
    promoteEligible,
    // Below the continue floor there is nothing worth another paid pass.
    worthRefining:
      !promoteEligible &&
      fidelity !== null &&
      fidelity >= floors.continueAt &&
      !isHardGeoFail(uniqueCodes),
    failCodes: uniqueCodes,
    reasons,
    comparisonSheet: sheet.png,
  };
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
