/**
 * In-process Water Create brain.
 *
 * Product Generate (`POST /api/water/generate`) runs the same stages eve
 * `create-water` would call: compile → route → bind pack → generate.
 * eve `create-water` stays frozen off Generate (operator docs + 12-tool RPC).
 * This module is the in-process planner so the workspace does not need eve.
 *
 * Extension: append to WATER_PRODUCT_STAGES and handle the id in
 * `planWaterCreate`. Do not add a 13th tool id.
 *
 * WHY eve IS PARKED (decision: hybrid — AI SDK harness here, eve later for long sessions)
 * Generation needs the customer's BYOK key and model on every call, deterministic gates, and
 * a hard wall-clock budget (`runtimeLimits.ts`). Running it in-process with the AI SDK keeps
 * keys inside this backend and costs no extra orchestrator tokens. The eve package under
 * hyd-f `agent/` still compiles and mirrors these stage names so it can take over later.
 * Revisit when runs must resume after a crash or need human approval between stages; at
 * that point prefer Vercel Workflow steps around `runStudioPipeline` first, eve second.
 */

import { screenSubject, validateCompiledPrompt, type CompiledPrompt } from "../../create/compile.js";
import { planRoute, type RoutePlan } from "../../create/route.js";
import type { CreateProfile } from "../../create/quality/thresholds.js";
import {
  parseQualityTier,
  parseWaterSkillId,
  type QualityTier,
  type WaterSkillId,
} from "../../waterSkills.js";
import { bindWaterPack, profileToQualityTier, tierToProfile } from "./packs.js";

/** Shipped threejs product stages. Mesh-post / visual evaluate plug in later. */
export const WATER_PRODUCT_STAGES = [
  "water-compile-prompt",
  "water-route-estimate",
  "water-generate-3d",
  "water-mesh-post",
  "water-evaluate",
] as const;

export type WaterCreatePlan = {
  skillId: WaterSkillId;
  qualityTier: QualityTier;
  profile: CreateProfile;
  compiled: CompiledPrompt;
  route: RoutePlan;
  warnings: string[];
  notes: string[];
  stages: typeof WATER_PRODUCT_STAGES;
};

export type WaterCreatePlanResult =
  | { ok: true; plan: WaterCreatePlan }
  | { ok: false; message: string };

function compileFromBrief(
  prompt: string,
  pack: WaterSkillId,
  profile: CreateProfile
): CompiledPrompt {
  const styleLock =
    pack === "character"
      ? "Stylized original figure. Not a photoreal likeness of a real person."
      : "Stylized hard-surface / prop. Original design inspired by the brief.";
  const validated = validateCompiledPrompt({
    raw: {
      subject: prompt.trim().slice(0, 240) || "Subject",
      parts: pack === "character" ? ["head", "torso", "limbs"] : ["body", "detail"],
      materials: pack === "character" ? ["skin", "cloth"] : ["body", "accent"],
      scale_m: pack === "character" ? 1.7 : 0.4,
      ground_contact: true,
      style_lock: styleLock,
      asset_class: "prop",
      profile,
      i2_3d_intent: {
        geo_brief: prompt.trim().slice(0, 400) || "Named parts, grounded on y=0, metres.",
        texture_brief: "Independent PBR channels. No baked lighting in albedo.",
        poly_budget_hint: 16_000,
      },
    },
    engine: "water",
    needsT2i: false,
  });
  if (!validated.ok) {
    throw new Error(validated.refuseReason);
  }
  return validated.compiled;
}

function tryCompileFromBrief(
  prompt: string,
  pack: WaterSkillId,
  profile: CreateProfile
): { ok: true; compiled: CompiledPrompt } | { ok: false; error: string } {
  try {
    const compiled = compileFromBrief(prompt, pack, profile);
    return { ok: true, compiled };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Could not compile the Water brief.";
    return { ok: false, error: message };
  }
}

/**
 * Compile + route a Water brief. Does not spend the customer's generate tokens.
 * Pack is bound from the brief (or explicitly provided). Quality tier is the user's power control
 * (Fast / Standard / Studio); if omitted, Standard is used.
 */
export function planWaterCreate(params: {
  prompt: string;
  imageUrl?: string | null;
  qualityTier?: string | null;
  skillId?: string | null;
}): WaterCreatePlanResult {
  const prompt = (params.prompt || "").trim();
  const screen = screenSubject({ text: prompt, engine: "water" });
  if (!screen.ok) {
    return { ok: false, message: screen.refuseReason };
  }

  const explicitSkill = parseWaterSkillId(params.skillId);
  const bound = bindWaterPack(prompt);
  const skillId = explicitSkill || bound.skillId;
  const qualityTier: QualityTier = params.qualityTier
    ? parseQualityTier(params.qualityTier)
    : profileToQualityTier(bound.profile);
  const profile = params.qualityTier
    ? tierToProfile(qualityTier, bound.profile)
    : bound.profile;

  const compiledResult = tryCompileFromBrief(prompt, skillId, profile);
  if (!compiledResult.ok) {
    return { ok: false, message: compiledResult.error };
  }
  const compiled = compiledResult.compiled;

  const routed = planRoute({
    engine: "water",
    waterMode: "threejs",
    compiled,
    hasReferenceImage: Boolean(params.imageUrl),
    compileConfidence: 0.9,
  });
  if (!routed.ok) {
    return { ok: false, message: routed.reason };
  }

  return {
    ok: true,
    plan: {
      skillId,
      qualityTier,
      profile,
      compiled,
      route: routed.plan,
      warnings: screen.warnings,
      notes: routed.plan.notes,
      stages: WATER_PRODUCT_STAGES,
    },
  };
}
