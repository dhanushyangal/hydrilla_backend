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
  throwIfAborted,
} from "../cancelRegistry.js";

/**
 * Soft wall-clock budgets. Cursor Cloud Agents need 1–4 min per call —
 * native providers can stay tighter. Local Node has no hard wall; Vercel
 * waitUntil still benefits from finishing early when possible.
 */
function budgetFor(provider: ApiKeyProvider, tier: QualityTier): number {
  const cursor = provider === "cursor";
  if (tier === "fast") return cursor ? 240_000 : 90_000;
  if (tier === "standard") return cursor ? 600_000 : 200_000;
  return cursor ? 900_000 : 240_000; // studio
}

export async function runStudioPipeline(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  prompt: string;
  imageUrl?: string | null;
  skillId: WaterSkillId;
  qualityTier: QualityTier;
  onPass?: (pass: HarnessProgressPass) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<StudioPipelineResult> {
  const started = Date.now();
  const isCursor = params.provider === "cursor";
  // Cursor agents routinely need 2–4 minutes; 60s caps caused empty→fallback blockouts.
  const defaultStageMax = isCursor ? 210_000 : 60_000;
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

  await note("spec");

  const unlocked = passesForTier(params.qualityTier);
  let factoryCode = "";
  let lastCodeGate: GateResult = { ok: true, violations: [] };
  const passReviews: PassReview[] = [];
  const completedPasses: BuildPassId[] = [];
  let anyRefined = false;
  let partial = false;
  let usedFallback = false;

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
      logger.warn({ err: err?.message, passId }, "Water generatePass failed — keeping prior code");
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
    let evaluation = await evaluatePass({
      provider: params.provider,
      modelId: params.modelId,
      apiKey: params.apiKey,
      skillId: params.skillId,
      passId,
      spec,
      code: gen.code,
      skipLlm:
        params.qualityTier === "fast" ||
        // Save tokens on Studio after we already have a solid blockout
        (params.qualityTier === "studio" && passId !== "blockout" && Date.now() - started > budget * 0.55),
      refined: false,
      timeoutMs: stageTimeoutMs(30_000),
      signal: params.signal,
    });
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
            pass: `${passId}_refine`,
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
          skipLlm: params.qualityTier === "fast" || params.qualityTier === "studio",
          refined: true,
          timeoutMs: stageTimeoutMs(30_000),
          signal: params.signal,
        });
        tokenUsage = addTokenUsage(tokenUsage, evaluation.usage);
        lastCodeGate = evaluation.codeGate;
      } catch (err: any) {
        if (isUserCancelError(err)) throw err;
        logger.warn({ err: err?.message, passId }, "Water refine failed — keeping prior attempt");
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
        notes: usedFallback
          ? `${spec.qualityContract?.notes || ""} [fallback-factory]`.trim()
          : spec.qualityContract?.notes,
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
  };
}
