/**
 * JobCard + EvidenceManifest persistence.
 *
 * The JobCard is total state: a resumed session reads from here, never from chat history.
 * Every write goes through `validateCheckpoint` first, so an illegal transition is rejected
 * in code before the DB constraints get a chance to reject it — that way callers get a
 * readable reason instead of a Postgres error.
 *
 * Schema: sql/010_create_job_cards.sql · Contract: docs/contracts/JOB_CARD.md
 */

import { supabase } from "../db.js";
import { logger } from "../logger.js";
import {
  createJobCard,
  stageOrderFor,
  validateCheckpoint,
  type CaptureKind,
  type CompiledPrompt,
  type CheckpointInput,
  type CreateEngine,
  type EvidenceCapture,
  type EvidenceManifest,
  type FailCode,
  type JobCard,
  type JobCardOutcome,
  type JobCardStage,
  type StageId,
  type StageStatus,
  type WaterMode,
} from "../lib/create/contracts.js";
import type { CreateAssetClass, CreateProfile } from "../lib/create/quality/thresholds.js";

const CARDS = "job_cards";
const STAGES = "job_card_stages";
const CAPTURES = "evidence_captures";

type StageRow = {
  stage_id: string;
  position: number;
  status: StageStatus;
  skip_reason: string | null;
  fail_codes: FailCode[] | null;
  artifacts: string[] | null;
  attempt: number;
  started_at: string | null;
  ended_at: string | null;
};

type CardRow = {
  job_id: string;
  run_id: string;
  engine: CreateEngine;
  water_mode: WaterMode | null;
  profile: CreateProfile;
  asset_class: CreateAssetClass;
  next_stage: string | null;
  outcome: JobCardOutcome;
  refine_total: number;
  compiled: CompiledPrompt | null;
  compile_confidence: number | null;
};

/** Create the card and its full stage ledger in the pending state. */
export async function insertJobCard(params: {
  jobId: string;
  runId: string;
  engine: CreateEngine;
  waterMode?: WaterMode;
  profile: CreateProfile;
  assetClass: CreateAssetClass;
}): Promise<JobCard> {
  const card = createJobCard(params);

  const { error: cardError } = await supabase.from(CARDS).insert({
    job_id: card.jobId,
    run_id: card.runId,
    engine: card.engine,
    water_mode: card.waterMode ?? null,
    profile: card.profile,
    asset_class: card.assetClass,
    next_stage: card.next,
    outcome: card.outcome,
    refine_total: 0,
  });
  if (cardError) {
    logger.error(cardError, "Failed to insert job_card");
    throw new Error(`Could not create JobCard: ${cardError.message}`);
  }

  const rows = card.stages.map((stage, index) => ({
    job_id: card.jobId,
    stage_id: stage.id,
    position: index,
    status: stage.status,
    fail_codes: [],
    artifacts: [],
    attempt: stage.attempt,
  }));
  const { error: stageError } = await supabase.from(STAGES).insert(rows);
  if (stageError) {
    logger.error(stageError, "Failed to insert job_card_stages");
    throw new Error(`Could not create JobCard stages: ${stageError.message}`);
  }

  return card;
}

/** Load total state. Returns null when the job has no card (a pre-harness job). */
export async function loadJobCard(jobId: string): Promise<JobCard | null> {
  const { data: cardData, error: cardError } = await supabase
    .from(CARDS)
    .select("*")
    .eq("job_id", jobId)
    .maybeSingle();
  if (cardError) {
    logger.error(cardError, "Failed to load job_card");
    throw new Error(`Could not load JobCard: ${cardError.message}`);
  }
  if (!cardData) return null;
  const row = cardData as CardRow;

  const { data: stageData, error: stageError } = await supabase
    .from(STAGES)
    .select("*")
    .eq("job_id", jobId)
    .order("position", { ascending: true });
  if (stageError) {
    logger.error(stageError, "Failed to load job_card_stages");
    throw new Error(`Could not load JobCard stages: ${stageError.message}`);
  }

  const order = stageOrderFor(row.engine);
  const byId = new Map<string, StageRow>((stageData as StageRow[] | null ?? []).map((s) => [s.stage_id, s]));

  // Rebuild from the canonical order so an incomplete ledger cannot silently drop a stage.
  const stages: JobCardStage[] = order.map((id) => {
    const stored = byId.get(id);
    if (!stored) return { id, status: "pending", attempt: 1 };
    return {
      id,
      status: stored.status,
      skipReason: stored.skip_reason,
      failCodes: stored.fail_codes ?? [],
      artifacts: stored.artifacts ?? [],
      attempt: stored.attempt,
      startedAt: stored.started_at,
      endedAt: stored.ended_at,
    };
  });

  const perStage: Partial<Record<StageId, number>> = {};
  for (const stage of stages) {
    // Attempt 1 is the first run; anything beyond that is a refine re-entry.
    if (stage.attempt > 1) perStage[stage.id] = stage.attempt - 1;
  }

  return {
    jobId: row.job_id,
    runId: row.run_id,
    engine: row.engine,
    waterMode: row.water_mode ?? undefined,
    profile: row.profile,
    assetClass: row.asset_class,
    stages,
    next: (row.next_stage as StageId | null) ?? null,
    refine: { perStage, total: row.refine_total },
    outcome: row.outcome,
    compiled: row.compiled ?? null,
    compileConfidence: row.compile_confidence ?? null,
  };
}

/**
 * Persist the CompiledPrompt and its confidence.
 *
 * `assetClass` and `profile` on the card are updated to match, because the compiled contract
 * is the authoritative source for both and the card row was created before they were known.
 */
export async function saveCompiledPrompt(params: {
  jobId: string;
  compiled: CompiledPrompt;
  confidence: number | null;
}): Promise<void> {
  const { error } = await supabase
    .from(CARDS)
    .update({
      compiled: params.compiled,
      compile_confidence: params.confidence,
      asset_class: params.compiled.assetClass,
      profile: params.compiled.profile,
    })
    .eq("job_id", params.jobId);
  if (error) {
    logger.error(error, "Failed to save compiled prompt");
    throw new Error(`Could not save CompiledPrompt: ${error.message}`);
  }
}

export type CheckpointResult =
  | { ok: true; card: JobCard }
  | { ok: false; reason: string };

/**
 * `run.checkpoint`. Validates against the in-memory card, then persists the stage row and
 * the card's `next` pointer. Returns a reason instead of throwing for contract violations,
 * because a violation is a decision the caller has to handle, not an outage.
 */
export async function checkpointStage(
  jobId: string,
  input: CheckpointInput
): Promise<CheckpointResult> {
  const card = await loadJobCard(jobId);
  if (!card) return { ok: false, reason: `No JobCard for job ${jobId}.` };

  const validation = validateCheckpoint(card, input);
  if (!validation.ok) return validation;

  const now = new Date().toISOString();
  const stage = card.stages.find((s) => s.id === input.stageId)!;

  const patch: Record<string, unknown> = {
    status: input.status,
    skip_reason: input.status === "skipped" ? input.skipReason : null,
    fail_codes: input.failCodes ?? [],
    // Artifacts accumulate across attempts; a later attempt should not erase evidence.
    artifacts: [...new Set([...(stage.artifacts ?? []), ...(input.artifacts ?? [])])],
  };
  if (input.status === "running" && !stage.startedAt) patch.started_at = now;
  if (input.status === "done" || input.status === "failed" || input.status === "skipped") {
    patch.ended_at = now;
  }

  const { error: stageError } = await supabase
    .from(STAGES)
    .update(patch)
    .eq("job_id", jobId)
    .eq("stage_id", input.stageId);
  if (stageError) {
    logger.error(stageError, "Failed to checkpoint stage");
    throw new Error(`Could not checkpoint ${input.stageId}: ${stageError.message}`);
  }

  if (input.next !== undefined) {
    const { error } = await supabase
      .from(CARDS)
      .update({ next_stage: input.next })
      .eq("job_id", jobId);
    if (error) {
      logger.error(error, "Failed to update next_stage");
      throw new Error(`Could not update next stage: ${error.message}`);
    }
  }

  const reloaded = await loadJobCard(jobId);
  return { ok: true, card: reloaded! };
}

/**
 * Mint a new runId. Called on generate, remesh, bake, and each refine iteration — anything
 * that invalidates existing evidence. Old captures stay in the table but stop counting,
 * because `checkEvidence` only accepts captures matching the current runId.
 */
export async function bumpRunId(jobId: string, runId: string): Promise<void> {
  const { error } = await supabase.from(CARDS).update({ run_id: runId }).eq("job_id", jobId);
  if (error) {
    logger.error(error, "Failed to bump run_id");
    throw new Error(`Could not bump runId: ${error.message}`);
  }
}

/** Increment refine counters. Callers must check `canRefine` first. */
export async function recordRefineAttempt(
  jobId: string,
  stageId: StageId
): Promise<{ perStage: number; total: number }> {
  const card = await loadJobCard(jobId);
  if (!card) throw new Error(`No JobCard for job ${jobId}.`);

  const nextAttempt = (card.stages.find((s) => s.id === stageId)?.attempt ?? 1) + 1;
  const nextTotal = card.refine.total + 1;

  const { error: stageError } = await supabase
    .from(STAGES)
    .update({ attempt: nextAttempt, status: "pending", fail_codes: [] })
    .eq("job_id", jobId)
    .eq("stage_id", stageId);
  if (stageError) {
    logger.error(stageError, "Failed to record refine attempt on stage");
    throw new Error(`Could not record refine attempt: ${stageError.message}`);
  }

  const { error: cardError } = await supabase
    .from(CARDS)
    .update({ refine_total: nextTotal })
    .eq("job_id", jobId);
  if (cardError) {
    logger.error(cardError, "Failed to record refine total");
    throw new Error(`Could not record refine total: ${cardError.message}`);
  }

  return { perStage: nextAttempt - 1, total: nextTotal };
}

export async function setJobCardOutcome(jobId: string, outcome: JobCardOutcome): Promise<void> {
  const { error } = await supabase.from(CARDS).update({ outcome }).eq("job_id", jobId);
  if (error) {
    logger.error(error, "Failed to set job card outcome");
    throw new Error(`Could not set outcome: ${error.message}`);
  }
}

/**
 * Record an evidence capture. The unique index on (job_id, run_id) for comparison sheets
 * enforces "exactly one sheet per runId" at the DB level, so a duplicate write surfaces as
 * a conflict rather than as two sheets.
 */
export async function addEvidenceCapture(params: {
  jobId: string;
  runId: string;
  kind: CaptureKind;
  uri: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase.from(CAPTURES).insert({
    job_id: params.jobId,
    run_id: params.runId,
    kind: params.kind,
    uri: params.uri,
    meta: params.meta ?? {},
  });
  if (error) {
    logger.error(error, "Failed to record evidence capture");
    throw new Error(`Could not record ${params.kind} capture: ${error.message}`);
  }
}

/**
 * Load the manifest for a run. Captures from other runs are loaded too — `checkEvidence`
 * needs to see them in order to report staleness rather than silently ignoring it.
 */
export async function loadEvidenceManifest(
  jobId: string,
  runId: string
): Promise<EvidenceManifest> {
  const { data, error } = await supabase
    .from(CAPTURES)
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });
  if (error) {
    logger.error(error, "Failed to load evidence captures");
    throw new Error(`Could not load evidence: ${error.message}`);
  }

  const captures: EvidenceCapture[] = (data ?? []).map((row: any) => ({
    kind: row.kind as CaptureKind,
    uri: row.uri,
    runId: row.run_id,
    createdAt: row.created_at,
    meta: row.meta ?? {},
  }));

  return { jobId, runId, captures };
}
