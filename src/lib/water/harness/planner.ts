/**
 * Planner — assessment + quality contract + rich SculptSpec (img2threejs spirit).
 */

import { addTokenUsage, callLLM, callLLMObject, emptyTokenUsage, type LlmTokenUsage } from "../../llmProviders.js";
import {
  fallbackSpec,
  validateSculptSpec,
  type GateResult,
  type TokenPassBreakdown,
} from "../../codeSculptPipeline.js";
import type { ApiKeyProvider } from "../../userApiKeysCrypto.js";
import type { QualityTier, WaterSkillId } from "../../waterSkills.js";
import { getSkillPromptPack } from "../skills/index.js";
import type { QualityContract, RichSculptSpec } from "./types.js";
import { sculptSpecSchema } from "../../../providers/schemas.js";
import { logger } from "../../../logger.js";

/** Standard/Studio refuse to generate from an invalid spec. Fast may still fall back. */
export class SpecBlockedError extends Error {
  readonly code = "spec_blocked";
  readonly violations: string[];
  constructor(violations: string[]) {
    const detail = violations.slice(0, 6).join(" ");
    super(
      detail
        ? `The reconstruction spec failed quality gates after one repair: ${detail}`
        : "The reconstruction spec failed quality gates after one repair."
    );
    this.name = "SpecBlockedError";
    this.violations = violations;
  }
}

const BASE_PLANNER_SYSTEM = `You are a technical director planning a procedural Three.js reconstruction.

Return ONLY a JSON object (no prose, no markdown fences) with this shape:
{
  "name": string,
  "subjectClass": "object" | "character" | "hybrid" | "environment",
  "complexity": "simple" | "moderate" | "complex",
  "summary": string,
  "scale": { "unit": "m", "approxHeight": number },
  "materials": [{ "name": string, "color": "#rrggbb", "finish": "metal"|"plastic"|"glass"|"rubber"|"wood"|"fabric"|"emissive"|"skin", "roughness": number, "metalness": number }],
  "components": [{ "name": string, "primitive": "box"|"sphere"|"cylinder"|"cone"|"torus"|"plane"|"lathe"|"extrude", "parent": string|null, "size": [number, number, number], "position": [number, number, number], "rotation": [number, number, number], "material": string, "notes": string, "topologyClass": string }],
  "animation": { "idle": string, "sockets": [string] },
  "qualityContract": {
    "fidelityBar": "blockout" | "production" | "hero",
    "mustHaveDetails": [string],
    "forbiddenShortcuts": [string],
    "notes": string
  },
  "detailInventory": [{ "id": string, "zone": string, "detail": string, "mapsTo": string }],
  "featureReviewTargets": [{ "id": string, "importance": "critical"|"important", "pass": string }]
}

Rules:
- Prefer complexity "simple" on Fast, "moderate" on Standard/Studio unless the subject is tiny.
- simple: 3–5 parts. moderate: ≤6. complex: ≤8. Do not over-decompose.
- Parts must be the REAL named parts of THIS subject. A bottle is a standing cylinder + neck + cap. A person is head/torso/limbs. A camera is body + lens + viewfinder.
- NEVER reuse a generic 0.72×0.42×0.48 box with a side cylinder unless the brief is actually a camera body + lens.
- Every child must overlap or flush-meet its parent (shared face or slight inset). No hovering, no air gaps, no disconnected piles of primitives.
- Do not add extra tubes, floating cylinders, fastener clusters, or decorative junk that is not in the brief.
- Every component.material must match a materials[].name.
- Positions/sizes in metres, Y up, centred near origin, resting on y = 0.
- Parent names must reference another component or be null for roots.
- detailInventory: 0–3 identity notes only; skip micro-wear lists.
IMPORTANT — never refuse for copyright / trademark / famous names:
- Plan an ORIGINAL stylized subject inspired by the brief.
- Do not mention copyright or inability to generate.`;

function defaultContract(tier: QualityTier): QualityContract {
  return {
    fidelityBar: tier === "fast" ? "blockout" : tier === "studio" ? "hero" : "production",
    mustHaveDetails: ["readable silhouette", "named hierarchy", "grounded on y=0"],
    forbiddenShortcuts: [
      "single-blob mesh",
      "floating disconnected parts",
      "extra tubes not in the brief",
      "external texture URLs",
      "userData.tick or time-based animation in createModel",
    ],
  };
}

export function enrichSpecDefaults(spec: RichSculptSpec, tier: QualityTier): RichSculptSpec {
  if (!spec.qualityContract) spec.qualityContract = defaultContract(tier);
  if (!Array.isArray(spec.detailInventory)) spec.detailInventory = [];
  if (!Array.isArray(spec.featureReviewTargets)) spec.featureReviewTargets = [];
  if (spec.featureReviewTargets.length === 0 && (spec.components || []).length) {
    spec.featureReviewTargets = (spec.components || []).slice(0, 5).map((c, i) => ({
      id: c.name || `part-${i}`,
      importance: i === 0 ? "critical" : "important",
      pass: "blockout",
    }));
  }
  for (const c of spec.components || []) {
    if (!c.topologyClass) {
      const prim = (c.primitive || "").toLowerCase();
      c.topologyClass =
        prim === "sphere" || prim === "lathe" ? "organic" : prim === "cylinder" || prim === "cone" ? "revolution" : "hard-surface";
    }
  }
  return spec;
}

/** Extra strictness beyond validateSculptSpec. */
export function strictQualityGate(
  spec: RichSculptSpec,
  skillExtra: string,
  tier: QualityTier
): GateResult {
  const base = validateSculptSpec(spec);
  const violations = [...base.violations];
  if (tier === "studio") {
    const inv = spec.detailInventory || [];
    const min = spec.complexity === "complex" ? 3 : 1;
    if (inv.length < min) {
      violations.push(
        `detailInventory too shallow: ${inv.length} entries (needs >= ${min} for ${spec.complexity}).`
      );
    }
  }
  const maxParts = spec.complexity === "complex" ? 8 : spec.complexity === "moderate" ? 6 : 5;
  if ((spec.components || []).length > maxParts) {
    violations.push(`Too many parts: ${(spec.components || []).length} (cap ${maxParts}). Merge into attached volumes.`);
  }
  if (skillExtra.includes("sockets") && (spec.animation?.sockets?.length || 0) < 2) {
    // animation skill — soft check already in pack; keep if sockets required by text
  }
  if (/Characters need/i.test(skillExtra)) {
    const names = (spec.components || []).map((c) => (c.name || "").toLowerCase());
    if (!names.some((n) => n.includes("head"))) {
      violations.push("Character spec missing a head component.");
    }
  }

  if (tier !== "fast") {
    const critical = (spec.featureReviewTargets || []).filter((t) => t.importance === "critical");
    if (critical.length === 0) {
      violations.push("Standard/Studio specs need at least one critical identity feature.");
    }
    if (critical.length > 5) {
      violations.push(`Too many critical identity features (${critical.length}); cap is 5.`);
    }
    const organicNames = /head|torso|body|limb|arm|leg|neck|bottle|neck|cap|lens/i;
    for (const c of spec.components || []) {
      const prim = (c.primitive || "").toLowerCase();
      const topo = (c.topologyClass || "").toLowerCase();
      const nm = (c.name || "").toLowerCase();
      if ((topo === "organic" || organicNames.test(nm)) && prim === "box" && /head|torso|bottle/.test(nm)) {
        violations.push(
          `Component "${c.name}" reads organic/round but is a box — pick cylinder/sphere (topology before primitive).`
        );
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

export async function runPlanner(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  prompt: string;
  imageUrl?: string | null;
  skillId: WaterSkillId;
  qualityTier: QualityTier;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{
  spec: RichSculptSpec;
  gate: GateResult;
  usedFallback: boolean;
  tokenUsage: LlmTokenUsage;
  tokenPasses: TokenPassBreakdown[];
}> {
  const pack = getSkillPromptPack(params.skillId);
  const subject = params.imageUrl
    ? `Reference image attached. User note: ${params.prompt || "(none)"}`
    : `Subject described by the user: "${params.prompt}"`;

  const userText = `${subject}

Quality tier: ${params.qualityTier}
Skill: ${params.skillId}

${pack.plannerSystemExtra}

${pack.strictSpecExtra}

Plan the procedural reconstruction. Return the JSON spec only.`;

  let usage = emptyTokenUsage();
  const tokenPasses: TokenPassBreakdown[] = [];

  let spec: RichSculptSpec | null = null;
  try {
    const result = await callLLMObject({
      provider: params.provider,
      modelId: params.modelId,
      apiKey: params.apiKey,
      system: `${BASE_PLANNER_SYSTEM}\n\nSkill focus:\n${pack.plannerSystemExtra}`,
      userText,
      imageUrl: params.imageUrl,
      maxTokens: 4096,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      schema: sculptSpecSchema,
    });
    usage = addTokenUsage(usage, result.usage);
    if (result.usage) {
      tokenPasses.push({
        pass: "planner",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      });
    }
    spec = enrichSpecDefaults(result.output as RichSculptSpec, params.qualityTier);
  } catch (err: any) {
    logger.warn(
      { err: err?.message, modelId: params.modelId, skillId: params.skillId },
      "Water planner structured output failed — retrying as JSON text"
    );
    try {
      const textResult = await callLLM({
        provider: params.provider,
        modelId: params.modelId,
        apiKey: params.apiKey,
        system: `${BASE_PLANNER_SYSTEM}\n\nSkill focus:\n${pack.plannerSystemExtra}`,
        userText: `${userText}\n\nReturn the JSON spec only. No markdown.`,
        imageUrl: params.imageUrl,
        maxTokens: 4096,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
      });
      usage = addTokenUsage(usage, textResult.usage);
      if (textResult.usage) {
        tokenPasses.push({
          pass: "planner_text",
          inputTokens: textResult.usage.inputTokens,
          outputTokens: textResult.usage.outputTokens,
          totalTokens: textResult.usage.totalTokens,
        });
      }
      const raw = textResult.text || "";
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end <= start) throw new Error("No JSON object in planner text");
      spec = enrichSpecDefaults(
        sculptSpecSchema.parse(JSON.parse(raw.slice(start, end + 1))) as RichSculptSpec,
        params.qualityTier
      );
    } catch (err2: any) {
      logger.warn(
        { err: err2?.message, skillId: params.skillId, prompt: params.prompt?.slice(0, 80) },
        "Water planner text retry failed"
      );
      spec = null;
    }
  }

  if (!spec) {
    if (params.qualityTier !== "fast") {
      throw new SpecBlockedError(["Planner did not return a valid JSON spec."]);
    }
    const fb = enrichSpecDefaults(
      fallbackSpec(params.prompt, params.skillId) as RichSculptSpec,
      params.qualityTier
    );
    return {
      spec: fb,
      gate: validateSculptSpec(fb),
      usedFallback: true,
      tokenUsage: usage,
      tokenPasses,
    };
  }

  let gate = strictQualityGate(spec, pack.strictSpecExtra, params.qualityTier);
  if (gate.ok || params.qualityTier === "fast") {
    // Fast: allow base validate only
    if (params.qualityTier === "fast") gate = validateSculptSpec(spec);
    if (gate.ok) return { spec, gate, usedFallback: false, tokenUsage: usage, tokenPasses };
  }

  // One bounded repair
  try {
    const repairedResult = await callLLMObject({
      provider: params.provider,
      modelId: params.modelId,
      apiKey: params.apiKey,
      system: `${BASE_PLANNER_SYSTEM}\n\nSkill focus:\n${pack.plannerSystemExtra}`,
      userText: `The following spec failed validation:
${JSON.stringify(spec, null, 2)}

Fix every violation and return the complete JSON spec only:
- ${gate.violations.join("\n- ")}`,
      imageUrl: params.imageUrl,
      maxTokens: 4096,
      timeoutMs: params.timeoutMs,
      schema: sculptSpecSchema,
    });
    usage = addTokenUsage(usage, repairedResult.usage);
    if (repairedResult.usage) {
      tokenPasses.push({
        pass: "spec_repair",
        inputTokens: repairedResult.usage.inputTokens,
        outputTokens: repairedResult.usage.outputTokens,
        totalTokens: repairedResult.usage.totalTokens,
      });
    }
    const repaired = enrichSpecDefaults(
      repairedResult.output as RichSculptSpec,
      params.qualityTier
    );
    const repairedGate =
      params.qualityTier === "fast"
        ? validateSculptSpec(repaired)
        : strictQualityGate(repaired, pack.strictSpecExtra, params.qualityTier);
    if (repairedGate.ok) {
      return { spec: repaired, gate: repairedGate, usedFallback: false, tokenUsage: usage, tokenPasses };
    }
    if (params.qualityTier !== "fast") {
      throw new SpecBlockedError(repairedGate.violations);
    }
  } catch (err) {
    if (err instanceof SpecBlockedError) throw err;
    // Fast: fall through to the subject-aware template.
  }

  if (params.qualityTier !== "fast") {
    throw new SpecBlockedError(gate.violations.length ? gate.violations : ["Spec failed the strict quality gate."]);
  }

  const fb = enrichSpecDefaults(
    fallbackSpec(params.prompt, params.skillId) as RichSculptSpec,
    params.qualityTier
  );
  return {
    spec: fb,
    gate: validateSculptSpec(fb),
    usedFallback: true,
    tokenUsage: usage,
    tokenPasses,
  };
}
