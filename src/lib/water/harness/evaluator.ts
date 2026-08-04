/**
 * Evaluator — deterministic gates first, then skeptic LLM (Anthropic harness pattern).
 */

import { callLLM, type LlmTokenUsage } from "../../llmProviders.js";
import { validateFactoryCode, type GateResult } from "../../codeSculptPipeline.js";
import type { ApiKeyProvider } from "../../userApiKeysCrypto.js";
import type { BuildPassId, WaterSkillId } from "../../waterSkills.js";
import { getSkillPromptPack } from "../skills/index.js";
import type { PassReview, PassReviewAction, RichSculptSpec } from "./types.js";

const EVAL_SYSTEM = `You are a skeptical technical art director reviewing procedural Three.js factory code.
You did NOT write this code. Be strict. Do not praise mediocre work.
Return ONLY JSON (no markdown):
{
  "fidelity": number,          // 0-1
  "action": "continue" | "refine-code" | "stop",
  "summary": string,           // concrete issues or why it passes
  "criteriaScores": { "<criterion>": number }  // 0-1 each
}
Rules:
- action=continue only if fidelity >= 0.72 AND every criterion >= 0.6
- Prefer refine-code when structure is OK but pass goals are missing
- Prefer stop only for catastrophic contract failures (should be rare; gates catch those)
- Cite specific missing mesh names, materials, or sockets — no vague "looks good"`;

export type EvalResult = {
  review: PassReview;
  usage: LlmTokenUsage | null;
  codeGate: GateResult;
};

export async function evaluatePass(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  skillId: WaterSkillId;
  passId: BuildPassId;
  spec: RichSculptSpec;
  code: string;
  /** Skip LLM on fast tier blockout if deterministic gate passes. */
  skipLlm?: boolean;
  refined: boolean;
  timeoutMs?: number;
}): Promise<EvalResult> {
  const codeGate = validateFactoryCode(params.code, params.spec);
  const pack = getSkillPromptPack(params.skillId);

  if (!codeGate.ok) {
    const blocking = codeGate.violations.filter(
      (v) => v.startsWith("Missing") || v.startsWith("Forbidden") || v.includes("too short")
    );
    return {
      codeGate,
      usage: null,
      review: {
        passId: params.passId,
        action: blocking.length ? "refine-code" : "refine-code",
        fidelity: 0.35,
        summary: codeGate.violations.join(" "),
        refined: params.refined,
      },
    };
  }

  if (params.skipLlm) {
    return {
      codeGate,
      usage: null,
      review: {
        passId: params.passId,
        action: "continue",
        fidelity: 0.8,
        summary: "Deterministic code gate passed (fast tier).",
        refined: params.refined,
      },
    };
  }

  try {
    const result = await callLLM({
      provider: params.provider,
      modelId: params.modelId,
      apiKey: params.apiKey,
      system: EVAL_SYSTEM,
      userText: `Pass under review: ${params.passId}
Skill: ${params.skillId}

Criteria (score each 0-1):
${pack.evaluatorCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Quality contract:
${JSON.stringify(params.spec.qualityContract || {}, null, 2)}

Factory code:
\`\`\`typescript
${params.code.slice(0, 24000)}
\`\`\`

Return JSON only.`,
      maxTokens: 1024,
      timeoutMs: params.timeoutMs,
    });

    const parsed = extractEvalJson(result.text);
    const action = normalizeAction(parsed.action);
    const fidelity = clamp01(parsed.fidelity);
    let finalAction: PassReviewAction = action;
    if (fidelity < 0.72 && finalAction === "continue") finalAction = "refine-code";

    return {
      codeGate,
      usage: result.usage,
      review: {
        passId: params.passId,
        action: finalAction,
        fidelity,
        summary: String(parsed.summary || "").slice(0, 800) || "Evaluated",
        criteriaScores: parsed.criteriaScores,
        refined: params.refined,
      },
    };
  } catch {
    // If evaluator fails, don't block the pipeline — continue on gate pass
    return {
      codeGate,
      usage: null,
      review: {
        passId: params.passId,
        action: "continue",
        fidelity: 0.75,
        summary: "Evaluator unavailable; deterministic gate passed.",
        refined: params.refined,
      },
    };
  }
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : parseFloat(String(n));
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function normalizeAction(a: unknown): PassReviewAction {
  const s = String(a || "").toLowerCase();
  if (s === "refine-code" || s === "refine_code") return "refine-code";
  if (s === "refine-spec" || s === "refine_spec") return "refine-spec";
  if (s === "stop") return "stop";
  return "continue";
}

function extractEvalJson(text: string): {
  fidelity?: number;
  action?: string;
  summary?: string;
  criteriaScores?: Record<string, number>;
} {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] || text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return {};
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return {};
  }
}
