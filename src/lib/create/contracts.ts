/**
 * Create session contracts — JobCard (total state) + EvidenceManifest (promote gate).
 *
 * Docs: docs/contracts/JOB_CARD.md · docs/contracts/EVIDENCE_MANIFEST.md
 * Decisions: docs/DECISIONS_LOCKED.md
 *
 * Laws enforced here:
 *   - JobCard is total state; chat is never job truth.
 *   - `engine` is immutable for the life of the job.
 *   - `*-mesh-post` and `*-evaluate` are never skippable.
 *   - Promote requires a complete manifest whose captures match the current runId.
 */

import {
  PROFILE_FIDELITY_FLOOR,
  REFINE,
  TURNTABLE_ANGLES,
  resolveFloors,
  type CreateAssetClass,
  type CreateProfile,
} from "./quality/thresholds.js";

/** Create-side engine discriminator. Maps to `jobs.engine` on write. */
export type CreateEngine = "cloud" | "water";

/**
 * Water generate mode. Chosen inside Water — this is NOT an engine switch.
 * `threejs` is shipped; `mesh` (BYOK adapters) is deferred. See DECISIONS_LOCKED D1.
 */
export type WaterMode = "threejs" | "mesh";

/**
 * The compiled prompt. Defined here rather than in `compile.ts` because it is contract
 * state that lives on the JobCard: `run.route`, `mesh.post.gate`, and `asset.score` all
 * read `assetClass` and `scaleM` back from the card rather than having the agent re-send
 * them. Chat is never job state, and neither is a tool argument.
 */
export type CompiledPrompt = {
  subject: string;
  parts: string[];
  materials: string[];
  /** Longest dimension in metres. Drives the scale gate and the scale_match feature. */
  scaleM: number;
  groundContact: boolean;
  styleLock: string;
  /**
   * Declared asset class. AUTHORITATIVE — it comes from this contract and is never
   * re-derived from a filename or a prompt keyword downstream.
   */
  assetClass: CreateAssetClass;
  profile: CreateProfile;
  /** Studio/product reference prompt for the t2i worker. Cloud only. */
  t2iPrompt: string | null;
  /** Geometry intent for the image→3D worker. Separate from texture intent by design. */
  i2_3dIntent: {
    geoBrief: string;
    textureBrief: string;
    polyBudgetHint: number;
    needsTransparency: boolean;
    needsThinShell: boolean;
    needsLiquidVolume: boolean;
  };
};

export type CloudStageId =
  | "cloud-compile-prompt"
  | "cloud-route-estimate"
  | "cloud-t2i"
  | "cloud-preprocess-ref"
  | "cloud-run-pixal"
  | "cloud-mesh-post"
  | "cloud-bake"
  | "cloud-evaluate"
  | "cloud-refine-loop";

export type WaterStageId =
  | "water-compile-prompt"
  | "water-route-estimate"
  | "water-generate-3d"
  | "water-mesh-post"
  | "water-evaluate"
  | "water-refine-loop";

export type StageId = CloudStageId | WaterStageId;

export const CLOUD_STAGE_ORDER: CloudStageId[] = [
  "cloud-compile-prompt",
  "cloud-route-estimate",
  "cloud-t2i",
  "cloud-preprocess-ref",
  "cloud-run-pixal",
  "cloud-mesh-post",
  "cloud-bake",
  "cloud-evaluate",
  "cloud-refine-loop",
];

export const WATER_STAGE_ORDER: WaterStageId[] = [
  "water-compile-prompt",
  "water-route-estimate",
  "water-generate-3d",
  "water-mesh-post",
  "water-evaluate",
  "water-refine-loop",
];

/** Stages that may never be marked `skipped`. Gate integrity depends on this. */
const REQUIRED_STAGES = new Set<StageId>([
  "cloud-mesh-post",
  "cloud-evaluate",
  "water-mesh-post",
  "water-evaluate",
]);

export type StageStatus = "pending" | "running" | "done" | "skipped" | "failed";

/**
 * Deterministic fail codes. Gates emit these; never free-text "looks wrong".
 * HARD codes can never be rescued by an aesthetic score.
 */
export type FailCode =
  // geometry — HARD
  | "EMPTY_GLB"
  | "NO_NORMALS"
  | "NON_MANIFOLD"
  | "SELF_INTERSECT"
  | "NAN_BOUNDS"
  | "NOT_GROUNDED"
  | "TRI_BUDGET"
  | "FLOATER"
  | "THIN_SHELL"
  | "ORBIT_COLLAPSE"
  // materials / export
  | "NO_UV"
  | "MISSING_MAP"
  | "SCALE"
  | "GLTF_INVALID"
  // intake
  | "CROP"
  | "BAD_SILHOUETTE"
  | "ADMISSION_FG"
  | "ADMISSION_SIZE"
  | "ADMISSION_BLOB"
  // scoring
  | "IOU"
  | "ASPECT"
  | "IDENTITY_FEATURE"
  | "FIDELITY_FLOOR"
  | "VLM_SPREAD"
  | "PART_COVERAGE"
  | "ATTACHMENT"
  | "INTERIOR"
  // contract / routing
  | "CONTRACT"
  | "BANNED_API"
  | "REFUSED_CLASS"
  | "ROUTE_CONFIDENCE"
  | "EVIDENCE_INCOMPLETE";

/** HARD geometry failures. An aesthetic score must never override these. */
export const HARD_GEO_FAIL_CODES = new Set<FailCode>([
  "EMPTY_GLB",
  "NO_NORMALS",
  "NON_MANIFOLD",
  "SELF_INTERSECT",
  "NAN_BOUNDS",
  "NOT_GROUNDED",
  "TRI_BUDGET",
  "FLOATER",
  "THIN_SHELL",
  "ORBIT_COLLAPSE",
]);

export function isHardGeoFail(codes: FailCode[]): boolean {
  return codes.some((c) => HARD_GEO_FAIL_CODES.has(c));
}

export type JobCardStage = {
  id: StageId;
  status: StageStatus;
  /** Required when status is `skipped`. */
  skipReason?: string | null;
  /** Required when status is `failed`. */
  failCodes?: FailCode[];
  artifacts?: string[];
  startedAt?: string | null;
  endedAt?: string | null;
  /** 1-based; increments on refine re-entry. */
  attempt: number;
};

export type JobCardOutcome = "pending" | "promoted" | "rejected" | "partial" | "failed";

export type JobCard = {
  jobId: string;
  /** Re-minted on generate, remesh, bake, and each refine iteration. */
  runId: string;
  /** Immutable for the life of the job. */
  engine: CreateEngine;
  waterMode?: WaterMode;
  profile: CreateProfile;
  assetClass: CreateAssetClass;
  stages: JobCardStage[];
  next: StageId | null;
  refine: { perStage: Partial<Record<StageId, number>>; total: number };
  outcome: JobCardOutcome;
  /** Persisted at `prompt.compile`. Later stages read it instead of re-receiving it. */
  compiled?: CompiledPrompt | null;
  /**
   * The compiler's confidence that it understood the request. `run.route` gates on this
   * and fails closed when it is absent — an unknown confidence is not a high one.
   */
  compileConfidence?: number | null;
};

export function stageOrderFor(engine: CreateEngine): StageId[] {
  return engine === "cloud" ? [...CLOUD_STAGE_ORDER] : [...WATER_STAGE_ORDER];
}

export function createJobCard(params: {
  jobId: string;
  runId: string;
  engine: CreateEngine;
  waterMode?: WaterMode;
  profile: CreateProfile;
  assetClass: CreateAssetClass;
}): JobCard {
  const order = stageOrderFor(params.engine);
  return {
    jobId: params.jobId,
    runId: params.runId,
    engine: params.engine,
    waterMode: params.engine === "water" ? params.waterMode || "threejs" : undefined,
    profile: params.profile,
    assetClass: params.assetClass,
    stages: order.map((id) => ({ id, status: "pending", attempt: 1 })),
    next: order[0] || null,
    refine: { perStage: {}, total: 0 },
    outcome: "pending",
  };
}

export type CheckpointInput = {
  stageId: StageId;
  status: StageStatus;
  skipReason?: string | null;
  failCodes?: FailCode[];
  artifacts?: string[];
  next?: StageId | null;
};

/**
 * Validate a checkpoint against the card. Pure — callers persist on success.
 * Rejects the four illegal transitions from JOB_CARD.md.
 */
export function validateCheckpoint(
  card: JobCard,
  input: CheckpointInput
): { ok: true } | { ok: false; reason: string } {
  const stage = card.stages.find((s) => s.id === input.stageId);
  if (!stage) {
    return { ok: false, reason: `Stage ${input.stageId} is not on this card.` };
  }
  if (input.status === "skipped") {
    if (REQUIRED_STAGES.has(input.stageId)) {
      return { ok: false, reason: `Stage ${input.stageId} is never skippable.` };
    }
    if (!input.skipReason) {
      return { ok: false, reason: `Skipping ${input.stageId} requires a skipReason.` };
    }
  }
  if (input.status === "failed" && !input.failCodes?.length) {
    return { ok: false, reason: `Failing ${input.stageId} requires at least one fail code.` };
  }
  if (input.next && !card.stages.some((s) => s.id === input.next)) {
    return { ok: false, reason: `next "${input.next}" is not a stage on this card.` };
  }
  // Stage-aware gating: nothing runs past the geo gate until it has passed.
  const gate = card.stages.find((s) => s.id === `${card.engine}-mesh-post` as StageId);
  if (gate && input.next && gate.status !== "done") {
    const order = stageOrderFor(card.engine);
    if (order.indexOf(input.next) > order.indexOf(gate.id)) {
      return {
        ok: false,
        reason: `Cannot advance to ${input.next} before ${gate.id} passes.`,
      };
    }
  }
  return { ok: true };
}

/** Resume: first stage not yet resolved. Never replays chat, never re-runs `done`. */
export function nextStage(card: JobCard): StageId | null {
  const pending = card.stages.find((s) => s.status !== "done" && s.status !== "skipped");
  return pending?.id ?? null;
}

export function canRefine(
  card: JobCard,
  stageId: StageId
): { allowed: boolean; reason?: string } {
  if (card.refine.total >= REFINE.maxTotal) {
    return { allowed: false, reason: `Refine ceiling reached (${REFINE.maxTotal}).` };
  }
  const used = card.refine.perStage[stageId] || 0;
  if (used >= REFINE.maxPerStage) {
    return {
      allowed: false,
      reason: `Stage ${stageId} hit its refine cap (${REFINE.maxPerStage}).`,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// EvidenceManifest
// ---------------------------------------------------------------------------

export type CaptureKind =
  | "glb"
  | "gate_report"
  | "turntable"
  | "comparison_sheet"
  | "admission_report"
  | "bake_report"
  | "score_report";

export type EvidenceCapture = {
  kind: CaptureKind;
  uri: string;
  /** Captures whose runId differs from the card's current runId are stale. */
  runId: string;
  createdAt: string;
  meta?: Record<string, unknown>;
};

export type EvidenceManifest = {
  jobId: string;
  runId: string;
  captures: EvidenceCapture[];
};

export type EvidenceCheck = {
  promoteEligible: boolean;
  missing: CaptureKind[];
  reasons: string[];
};

const ALWAYS_REQUIRED: CaptureKind[] = [
  "glb",
  "gate_report",
  "turntable",
  "comparison_sheet",
  "score_report",
];

export function requiredCaptures(params: {
  profile: CreateProfile;
  hasReferenceImage: boolean;
  bakeRan: boolean;
  engine: CreateEngine;
}): CaptureKind[] {
  const required = [...ALWAYS_REQUIRED];
  if (params.hasReferenceImage) {
    required.push("admission_report");
  }
  if (params.profile === "game_ready" || params.bakeRan) {
    required.push("bake_report");
  }
  return required;
}

/**
 * The promote gate. `promoteEligible` is derived — never trust a stored flag.
 * Fresh + complete + HARD pass + floor met, or it does not promote.
 */
export function checkEvidence(params: {
  manifest: EvidenceManifest;
  card: JobCard;
  hasReferenceImage?: boolean;
  bakeRan?: boolean;
  /** From `score_report`; compared against the resolved profile/class floor. */
  fidelity?: number | null;
  /** From `gate_report`. */
  gatePassed?: boolean;
}): EvidenceCheck {
  const reasons: string[] = [];
  const { manifest, card } = params;

  if (manifest.runId !== card.runId) {
    reasons.push(`Manifest runId ${manifest.runId} is stale (card is ${card.runId}).`);
  }

  const fresh = manifest.captures.filter((c) => c.runId === card.runId);
  const staleCount = manifest.captures.length - fresh.length;
  if (staleCount > 0) {
    reasons.push(`${staleCount} capture(s) belong to an earlier runId and do not count.`);
  }

  const required = requiredCaptures({
    profile: card.profile,
    hasReferenceImage: Boolean(params.hasReferenceImage),
    bakeRan: Boolean(params.bakeRan),
    engine: card.engine,
  });
  const present = new Set(fresh.map((c) => c.kind));
  const missing = required.filter((kind) => !present.has(kind));
  if (missing.length) {
    reasons.push(`Missing capture(s): ${missing.join(", ")}.`);
  }

  const sheets = fresh.filter((c) => c.kind === "comparison_sheet");
  if (sheets.length > 1) {
    reasons.push(`Exactly one comparison_sheet per runId; found ${sheets.length}.`);
  }

  const turntables = fresh.filter((c) => c.kind === "turntable");
  if (present.has("turntable") && turntables.length !== TURNTABLE_ANGLES.length) {
    reasons.push(
      `Expected ${TURNTABLE_ANGLES.length} turntable captures (${TURNTABLE_ANGLES.join("/")}°); found ${turntables.length}.`
    );
  }

  if (params.gatePassed === false) {
    reasons.push("gate_report is a HARD fail; no score can promote it.");
  }

  if (typeof params.fidelity === "number") {
    const floor = resolveFloors(card.profile, card.assetClass).fidelity;
    if (params.fidelity < floor) {
      reasons.push(
        `Fidelity ${params.fidelity.toFixed(2)} is below the ${card.profile}/${card.assetClass} floor ${floor.toFixed(2)}.`
      );
    }
  }

  return { promoteEligible: reasons.length === 0, missing, reasons };
}

/** Profile floors, re-exported so callers never hardcode one. */
export { PROFILE_FIDELITY_FLOOR };
