/**
 * Water Studio orchestrator — planner → locked passes → generator/evaluator.
 * Anthropic-inspired: separate generator vs evaluator; deterministic gates first.
 *
 * Resilience: per-pass try/catch, keep best code, retry refusals, deterministic fallback.
 */

import {
  addTokenUsage,
  emptyTokenUsage,
} from "../../llmProviders.js";
import { intakeGate, type GateResult } from "../../codeSculptPipeline.js";
import type { ApiKeyProvider } from "../../userApiKeysCrypto.js";
import {
  passesForTier,
  type BuildPassId,
  type QualityTier,
  type WaterSkillId,
} from "../../waterSkills.js";
import { evaluatePass } from "./evaluator.js";
import { generatePass, looksLikeRefusalOrEmpty } from "./generator.js";
import { buildMinimalFactory } from "./fallbackFactory.js";
import { runPlanner } from "./planner.js";
import type { HarnessProgressPass, PassReview, StudioPipelineResult } from "./types.js";
import { logger } from "../../../logger.js";
import {
  isUserCancelError,
  isTimeoutAbort,
  throwIfAborted,
} from "../cancelRegistry.js";
import { runFactoryVisualPass } from "./visualPass.js";
import { HARNESS_WALL_BUDGET_MS } from "../runtimeLimits.js";
import { REFINE, type CreateAssetClass, type CreateProfile } from "../../create/quality/thresholds.js";
import type { ReferenceMask } from "../../create/score.js";

/** Next pass is illegal until review=continue (or Fast with a clean gate). */
function nextPassLegal(
  review: PassReview,
  codeGate: { ok: boolean },
  tier: QualityTier
): boolean {
  if (review.action === "stop" || review.action === "refine-spec") return false;
  if (review.action === "continue" && codeGate.ok) return true;
  if (tier === "fast") return codeGate.ok && review.fidelity >= 0.55;
  return false;
}

/**
 * Soft wall-clock budgets per tier. Cursor Cloud Agents need 1–4 min per call, so they get
 * more room than native providers. Every budget is clamped to `HARNESS_WALL_BUDGET_MS` so a
 * run always returns (partial if needed) before Vercel kills the function — see
 * `runtimeLimits.ts` for why and for when this should move to durable Workflow steps.
 */
function budgetFor(provider: ApiKeyProvider, tier: QualityTier): number {
  const cursor = provider === "cursor";
  const tierBudget =
    tier === "fast" ? (cursor ? 240_000 : 120_000)
    : tier === "standard" ? (cursor ? 600_000 : 420_000)
    : cursor ? 900_000 : 720_000;
  return Math.min(tierBudget, HARNESS_WALL_BUDGET_MS);
}

function stageCap(provider: ApiKeyProvider, tier: QualityTier): number {
  if (provider === "cursor") return 210_000;
  if (tier === "fast") return 75_000;
  if (tier === "standard") return 120_000;
  return 180_000;
}

export async function runStudioPipeline(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  prompt: string;
  imageUrl?: string | null;
  skillId: WaterSkillId;
  qualityTier: QualityTier;
  jobId?: string;
  runId?: string;
  profile?: CreateProfile;
  assetClass?: CreateAssetClass;
  /** Hand-edited or parent factory — refine-code, do not regenerate from scratch. */
  previousFactoryCode?: string | null;
  /** Admitted reference mask for Tier1 / interior difference. */
  referenceMask?: ReferenceMask | null;
  onPass?: (pass: HarnessProgressPass) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<StudioPipelineResult> {
  const started = Date.now();
  const isCursor = params.provider === "cursor";
  const defaultStageMax = stageCap(params.provider, params.qualityTier);
  const budget = budgetFor(params.provider, params.qualityTier);
  const remainingMs = () => Math.max(0, budget - (Date.now() - started));
  const stageTimeoutMs = (max = defaultStageMax, reserve = isCursor ? 30_000 : 20_000) =>
    Math.max(5_000, Math.min(max, remainingMs() - reserve));
  const note = async (pass: HarnessProgressPass) => {
    try {
      await params.onPass?.(pass);
    } catch {
      /* progress must never fail the run */
    }
  };

  throwIfAborted(params.signal);

  const intake = intakeGate({ prompt: params.prompt, imageUrl: params.imageUrl });
  if (!intake.ok) {
    throw new Error(intake.violations.join(" ") || "intake_failed");
  }

  await note("assessment");
  await note("planner");
  throwIfAborted(params.signal);
  const planned = await runPlanner({
    provider: params.provider,
    modelId: params.modelId,
    apiKey: params.apiKey,
    prompt: params.prompt,
    imageUrl: params.imageUrl,
    skillId: params.skillId,
    qualityTier: params.qualityTier,
    timeoutMs: stageTimeoutMs(isCursor ? 210_000 : 50_000, isCursor ? 40_000 : 40_000),
    signal: params.signal,
  });

  let tokenUsage = planned.tokenUsage;
  const tokenPasses = [...planned.tokenPasses];
  const spec = planned.spec;
  const specGate = planned.gate;
  const specUsedFallback = planned.usedFallback;
  if (specUsedFallback) {
    logger.warn(
      { skillId: params.skillId, qualityTier: params.qualityTier, prompt: params.prompt.slice(0, 80) },
      "Water Studio planner used subject-aware fallback spec"
    );
  }

  await note("spec");

  const unlocked = passesForTier(params.qualityTier);
  let factoryCode = params.previousFactoryCode && params.previousFactoryCode.length >= 200
    ? params.previousFactoryCode
    : "";
  let lastCodeGate: GateResult = { ok: true, violations: [] };
  const passReviews: PassReview[] = [];
  const completedPasses: BuildPassId[] = [];
  let anyRefined = false;
  let partial = false;
  let usedFallback = false;
  let refineTotal = 0;

  for (const passId of unlocked) {
    throwIfAborted(params.signal);
    if (remainingMs() < 20_000) {
      partial = true;
      logger.warn(
        { passId, qualityTier: params.qualityTier, elapsedMs: Date.now() - started },
        "Water Studio budget hit — returning best code so far"
      );
      break;
    }

    logger.info(
      { passId, qualityTier: params.qualityTier, remainingMs: remainingMs() },
      "Water Studio pass started"
    );
    await note(passId);
    let refined = false;

    let gen: { code: string; usage: Awaited<ReturnType<typeof generatePass>>["usage"] };
    try {
      gen = await generatePass({
        provider: params.provider,
        modelId: params.modelId,
        apiKey: params.apiKey,
        spec,
        prompt: params.prompt,
        imageUrl: params.imageUrl,
        skillId: params.skillId,
        passId,
        previousCode: factoryCode || null,
        timeoutMs: stageTimeoutMs(),
        signal: params.signal,
      });
    } catch (err: any) {
      if (isUserCancelError(err)) throw err;
      if (isTimeoutAbort(err)) {
        logger.warn({ passId }, "Water generatePass timed out — keeping prior code");
        partial = true;
        if (factoryCode.length >= 200) break;
      } else {
        logger.warn({ err: err?.message, passId }, "Water generatePass failed — keeping prior code");
      }
      if (factoryCode.length >= 200) {
        partial = true;
        passReviews.push({
          passId,
          action: "stop",
          fidelity: 0.5,
          summary: `Pass skipped: ${err?.message || "LLM error"}`,
          refined: false,
        });
        break;
      }
      // No prior code — retry once with anti-refusal hint
      try {
        if (remainingMs() < 20_000) throw new Error("Water Studio time budget exhausted");
        throwIfAborted(params.signal);
        gen = await generatePass({
          provider: params.provider,
          modelId: params.modelId,
          apiKey: params.apiKey,
          spec,
          prompt: params.prompt,
          imageUrl: params.imageUrl,
          skillId: params.skillId,
          passId,
          previousCode: null,
          retryHint:
            "RETRY: Previous call failed. Output a complete createModel() TypeScript module for an ORIGINAL stylized character/object inspired by the brief. No apologies.",
          timeoutMs: stageTimeoutMs(),
          signal: params.signal,
        });
      } catch (err2: any) {
        if (isUserCancelError(err2)) throw err2;
        logger.warn({ err: err2?.message, passId }, "Water generatePass retry failed");
        break;
      }
    }

    tokenUsage = addTokenUsage(tokenUsage, gen.usage);
    if (gen.usage) {
      tokenPasses.push({
        pass: passId,
        inputTokens: gen.usage.inputTokens,
        outputTokens: gen.usage.outputTokens,
        totalTokens: gen.usage.totalTokens,
      });
    }

    // Refusal / empty → one dedicated retry on blockout (or first pass)
    if (looksLikeRefusalOrEmpty(gen.code) && remainingMs() >= 20_000) {
      logger.warn(
        { passId, codeLen: gen.code?.length || 0 },
        "Water pass returned refusal/empty code — retrying"
      );
      try {
        const retry = await generatePass({
          provider: params.provider,
          modelId: params.modelId,
          apiKey: params.apiKey,
          spec,
          prompt: params.prompt,
          imageUrl: params.imageUrl,
          skillId: params.skillId,
          passId,
          previousCode: factoryCode || null,
          retryHint:
            "RETRY: Your last reply was unusable (too short, missing createModel, or a refusal). Emit ONLY a full TypeScript module. Invent an original stylized design inspired by the brief — never refuse famous names.",
          timeoutMs: stageTimeoutMs(),
          signal: params.signal,
        });
        tokenUsage = addTokenUsage(tokenUsage, retry.usage);
        if (!looksLikeRefusalOrEmpty(retry.code)) {
          gen = retry;
        }
      } catch (err: any) {
        if (isUserCancelError(err)) throw err;
        logger.warn({ err: err?.message, passId }, "Water refusal-retry failed");
      }
    }

    // Still unusable and we have nothing — don't burn evaluator tokens
    if (looksLikeRefusalOrEmpty(gen.code) && factoryCode.length < 200) {
      passReviews.push({
        passId,
        action: "refine-code",
        fidelity: 0.2,
        summary: "Model returned empty or refusal text",
        refined: false,
      });
      if (passId === "blockout") {
        // Fall through to fallback after loop
        break;
      }
      continue;
    }

    // If this pass is empty but we already have good code, keep prior and continue
    if (looksLikeRefusalOrEmpty(gen.code) && factoryCode.length >= 200) {
      passReviews.push({
        passId,
        action: "continue",
        fidelity: 0.6,
        summary: "Pass skipped — model returned empty; kept prior factory",
        refined: false,
      });
      completedPasses.push(passId);
      partial = true;
      continue;
    }

    await note("evaluate");
    throwIfAborted(params.signal);
    let evaluation;
    try {
      evaluation = await evaluatePass({
        provider: params.provider,
        modelId: params.modelId,
        apiKey: params.apiKey,
        skillId: params.skillId,
        passId,
        spec,
        code: gen.code,
        skipLlm:
          params.qualityTier === "fast" ||
          (params.qualityTier === "studio" && passId !== "blockout" && Date.now() - started > budget * 0.55),
        refined: false,
        timeoutMs: stageTimeoutMs(params.qualityTier === "fast" ? 20_000 : 45_000),
        signal: params.signal,
      });
    } catch (err: any) {
      if (isUserCancelError(err)) throw err;
      logger.warn({ err: err?.message, passId }, "Water evaluatePass failed — continuing on code gate");
      evaluation = {
        codeGate: lastCodeGate,
        usage: null,
        review: {
          passId,
          action: "continue" as const,
          fidelity: 0.7,
          summary: isTimeoutAbort(err) ? "Evaluator timed out; kept code." : `Evaluator error: ${err?.message || "failed"}`,
          refined: false,
        },
      };
    }
    tokenUsage = addTokenUsage(tokenUsage, evaluation.usage);
    if (evaluation.usage) {
      tokenPasses.push({
        pass: `${passId}_eval`,
        inputTokens: evaluation.usage.inputTokens,
        outputTokens: evaluation.usage.outputTokens,
        totalTokens: evaluation.usage.totalTokens,
      });
    }
    lastCodeGate = evaluation.codeGate;

    if (
      evaluation.review.action === "refine-code" &&
      remainingMs() >= 20_000 &&
      !looksLikeRefusalOrEmpty(gen.code)
    ) {
      let lastFid = evaluation.review.fidelity;
      let perPass = 0;
      while (
        perPass < REFINE.maxPerStage &&
        refineTotal < REFINE.maxTotal &&
        remainingMs() >= 20_000 &&
        evaluation.review.action === "refine-code" &&
        !looksLikeRefusalOrEmpty(gen.code)
      ) {
        refined = true;
        anyRefined = true;
        const evalFeedback = evaluation.review.summary;
        await note(passId);
        try {
          const retryGen = await generatePass({
            provider: params.provider,
            modelId: params.modelId,
            apiKey: params.apiKey,
            spec,
            prompt: params.prompt,
            imageUrl: params.imageUrl,
            skillId: params.skillId,
            passId,
            previousCode: gen.code,
            violations: evaluation.codeGate.ok ? undefined : evaluation.codeGate.violations,
            evaluatorFeedback: evalFeedback,
            timeoutMs: stageTimeoutMs(),
            signal: params.signal,
          });
          tokenUsage = addTokenUsage(tokenUsage, retryGen.usage);
          if (!looksLikeRefusalOrEmpty(retryGen.code)) {
            gen = retryGen;
          }
          if (retryGen.usage) {
            tokenPasses.push({
              pass: `${passId}_refine${perPass + 1}`,
              inputTokens: retryGen.usage.inputTokens,
              outputTokens: retryGen.usage.outputTokens,
              totalTokens: retryGen.usage.totalTokens,
            });
          }

          await note("evaluate");
          throwIfAborted(params.signal);
          evaluation = await evaluatePass({
            provider: params.provider,
            modelId: params.modelId,
            apiKey: params.apiKey,
            skillId: params.skillId,
            passId,
            spec,
            code: gen.code,
            skipLlm: params.qualityTier === "fast" || (params.qualityTier === "studio" && perPass > 0),
            refined: true,
            timeoutMs: stageTimeoutMs(30_000),
            signal: params.signal,
          });
          tokenUsage = addTokenUsage(tokenUsage, evaluation.usage);
          lastCodeGate = evaluation.codeGate;
          perPass += 1;
          refineTotal += 1;
          const delta = evaluation.review.fidelity - lastFid;
          if (delta < REFINE.minDelta && evaluation.review.action !== "continue") {
            logger.info({ passId, delta, perPass }, "Water refine plateau — locking pass");
            break;
          }
          lastFid = evaluation.review.fidelity;
        } catch (err: any) {
          if (isUserCancelError(err)) throw err;
          logger.warn({ err: err?.message, passId }, "Water refine failed — keeping prior attempt");
          break;
        }
      }
    }

    // Never replace good code with worse/empty
    if (!looksLikeRefusalOrEmpty(gen.code)) {
      if (!factoryCode || gen.code.length >= factoryCode.length * 0.6) {
        factoryCode = gen.code;
      }
    }

    passReviews.push({ ...evaluation.review, refined });
    completedPasses.push(passId);
    logger.info(
      {
        passId,
        action: evaluation.review.action,
        codeLength: factoryCode.length,
        remainingMs: remainingMs(),
      },
      "Water Studio pass completed"
    );

    if (!lastCodeGate.ok && passId === "blockout" && looksLikeRefusalOrEmpty(factoryCode)) {
      // Will use fallback below
      break;
    }

    if (!nextPassLegal(evaluation.review, lastCodeGate, params.qualityTier)) {
      partial = true;
      logger.info(
        { passId, action: evaluation.review.action, fidelity: evaluation.review.fidelity },
        "Water pass lock — next pass illegal without continue/evidence"
      );
      break;
    }
  }

  if (looksLikeRefusalOrEmpty(factoryCode)) {
    throwIfAborted(params.signal);
    logger.warn(
      { skillId: params.skillId, qualityTier: params.qualityTier, modelId: params.modelId },
      "Water Studio using deterministic fallback factory"
    );
    factoryCode = buildMinimalFactory({
      prompt: params.prompt,
      skillId: params.skillId,
      spec,
    });
    usedFallback = true;
    partial = true;
    lastCodeGate = { ok: true, violations: [] };
    if (!completedPasses.includes("blockout")) completedPasses.push("blockout");
  }

  let visual: StudioPipelineResult["visual"];
  if (factoryCode.length >= 200) {
    try {
      throwIfAborted(params.signal);
      await note("evaluate");
      const vis = await runFactoryVisualPass({
        jobId: params.jobId || "wt_local",
        runId: params.runId || `wr_${Date.now().toString(36)}`,
        spec,
        factoryCode,
        profile: params.profile || (params.qualityTier === "studio" ? "quality" : "balanced"),
        assetClass: params.assetClass || "prop",
        expectedScaleM: spec.scale?.approxHeight ?? null,
        reference: params.referenceMask ?? null,
        allowSpecProxy: params.qualityTier === "fast",
      });
      visual = {
        gatePassed: vis.gate.passed,
        fidelity: vis.score.fidelity,
        failCodes: vis.score.failCodes,
        promoteEligible: vis.score.promoteEligible,
        reasons: vis.score.reasons.slice(0, 8),
        source: vis.source,
        meshNames: vis.meshNames.slice(0, 16),
        turntables: vis.turntables,
        sheetDataUrl: vis.sheetDataUrl,
      };

      const identityMiss = vis.score.failCodes.includes("IDENTITY_FEATURE") || !vis.gate.passed;
      if (
        params.qualityTier !== "fast" &&
        identityMiss &&
        remainingMs() >= 40_000 &&
        vis.score.worthRefining &&
        refineTotal < REFINE.maxTotal
      ) {
        const lastPass = completedPasses[completedPasses.length - 1] || "blockout";
        try {
          const retryGen = await generatePass({
            provider: params.provider,
            modelId: params.modelId,
            apiKey: params.apiKey,
            spec,
            prompt: params.prompt,
            imageUrl: params.imageUrl,
            skillId: params.skillId,
            passId: lastPass,
            previousCode: factoryCode,
            evaluatorFeedback: vis.score.reasons.slice(0, 6).join("\n"),
            timeoutMs: stageTimeoutMs(),
            signal: params.signal,
          });
          tokenUsage = addTokenUsage(tokenUsage, retryGen.usage);
          if (!looksLikeRefusalOrEmpty(retryGen.code)) {
            factoryCode = retryGen.code;
            anyRefined = true;
            refineTotal += 1;
            const vis2 = await runFactoryVisualPass({
              jobId: params.jobId || "wt_local",
              runId: params.runId || `wr_${Date.now().toString(36)}`,
              spec,
              factoryCode,
              profile: params.profile || "balanced",
              assetClass: params.assetClass || "prop",
              expectedScaleM: spec.scale?.approxHeight ?? null,
              reference: params.referenceMask ?? null,
              allowSpecProxy: false,
            });
            visual = {
              gatePassed: vis2.gate.passed,
              fidelity: vis2.score.fidelity,
              failCodes: vis2.score.failCodes,
              promoteEligible: vis2.score.promoteEligible,
              reasons: vis2.score.reasons.slice(0, 8),
              source: vis2.source,
              meshNames: vis2.meshNames.slice(0, 16),
              turntables: vis2.turntables,
              sheetDataUrl: vis2.sheetDataUrl,
            };
          }
        } catch (err: any) {
          if (isUserCancelError(err)) throw err;
          logger.warn({ err: err?.message }, "Water visual refine failed — keeping prior factory");
        }
      }
    } catch (err: any) {
      if (isUserCancelError(err)) throw err;
      logger.warn({ err: err?.message }, "Water visual pass failed — shipping factory anyway");
    }
  }

  if (partial) await note("partial");
  else await note("done");

  return {
    factoryCode,
    spec: {
      ...spec,
      qualityContract: {
        ...(spec.qualityContract || {
          fidelityBar: "blockout",
          mustHaveDetails: [],
          forbiddenShortcuts: [],
        }),
        notes: [spec.qualityContract?.notes, specUsedFallback ? "[fallback-spec]" : "", usedFallback ? "[fallback-factory]" : ""]
          .filter(Boolean)
          .join(" ")
          .trim() || undefined,
      },
    },
    pass: partial ? "partial" : completedPasses[completedPasses.length - 1] || "blockout",
    completedPasses,
    passReviews,
    specGate,
    codeGate: lastCodeGate,
    refined: anyRefined,
    partial: partial || usedFallback,
    skillId: params.skillId,
    qualityTier: params.qualityTier,
    tokenUsage: tokenUsage || emptyTokenUsage(),
    tokenPasses,
    visual,
    elapsedMs: Date.now() - started,
    refineTotal,
  };
}
