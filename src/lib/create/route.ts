/**
 * `run.route` + `run.estimate` — the last free checkpoint before we spend.
 *
 * Two laws:
 *   1. Routing happens INSIDE the session's engine. This module physically cannot return
 *      a different engine than it was given — there is no engine field in the output.
 *      "Fall back to the other engine" was killed; a low-confidence route stops instead.
 *   2. Confidence below the floor is a stop, not a shrug.
 *
 * Spec: agent-skills/.../skills/cloud/cloud-route-estimate/SKILL.md
 *       .../references/class-poly-budgets.md
 */

import type { CreateEngine, FailCode, WaterMode } from "./contracts.js";
import type { CompiledPrompt } from "./compile.js";
import {
  ROUTE_CONFIDENCE_MIN,
  type CreateAssetClass,
  type CreateProfile,
} from "./quality/thresholds.js";

/** Adapters permitted per engine. Cross-engine adapters are unrepresentable by construction. */
export const CLOUD_ADAPTERS = ["bluefox"] as const;
export const WATER_MESH_ADAPTERS = ["meshy", "tripo", "fal", "rodin"] as const;

export type CloudAdapter = (typeof CLOUD_ADAPTERS)[number];
export type WaterMeshAdapter = (typeof WATER_MESH_ADAPTERS)[number];

/**
 * Triangle budgets by class and profile, post-remesh.
 * Source: cloud-route-estimate/references/class-poly-budgets.md
 */
export const POLY_BUDGETS: Record<CreateAssetClass, Record<CreateProfile, number>> = {
  prop: { draft: 12_000, balanced: 16_000, quality: 25_000, game_ready: 12_000 },
  "prop-hero": { draft: 18_000, balanced: 24_000, quality: 40_000, game_ready: 20_000 },
  vehicle: { draft: 16_000, balanced: 22_000, quality: 35_000, game_ready: 18_000 },
};

export type RoutePlan = {
  /** Echo only. Equal to the session engine by construction. */
  engine: CreateEngine;
  waterMode?: WaterMode;
  adapter: CloudAdapter | WaterMeshAdapter | "threejs-factory";
  profile: CreateProfile;
  /** Cloud text-only input requires the locked t2i → i2_3d pipeline. */
  needsT2i: boolean;
  needsPreprocess: boolean;
  /** Whether `mesh.bake` will run. */
  needsBake: boolean;
  polyBudget: number;
  confidence: number;
  notes: string[];
};

export type RouteResult =
  | { ok: true; plan: RoutePlan }
  | { ok: false; reason: string; failCodes: FailCode[]; confidence: number };

/**
 * Plan a run inside the session's engine.
 *
 * `engine` is an input, echoed back. There is no branch in this function that can change
 * it, which is the structural version of the "engine is immutable" rule.
 */
export function planRoute(params: {
  engine: CreateEngine;
  waterMode?: WaterMode;
  compiled: CompiledPrompt;
  hasReferenceImage: boolean;
  /** Caller's confidence that the compile understood the request, 0..1. */
  compileConfidence: number;
}): RouteResult {
  const notes: string[] = [];
  const { compiled, engine } = params;

  if (params.compileConfidence < ROUTE_CONFIDENCE_MIN) {
    return {
      ok: false,
      reason:
        `Route confidence ${params.compileConfidence.toFixed(2)} is below the ${ROUTE_CONFIDENCE_MIN} floor. ` +
        `Stopping before any spend — ask the user to clarify the subject rather than guessing.`,
      failCodes: ["ROUTE_CONFIDENCE"],
      confidence: params.compileConfidence,
    };
  }

  const profile = compiled.profile;
  const polyBudget = Math.min(
    POLY_BUDGETS[compiled.assetClass][profile],
    Math.max(compiled.i2_3dIntent.polyBudgetHint, 1_000)
  );
  if (polyBudget < compiled.i2_3dIntent.polyBudgetHint) {
    notes.push(
      `Poly hint ${compiled.i2_3dIntent.polyBudgetHint} clamped to the ${compiled.assetClass}/${profile} budget of ${polyBudget}.`
    );
  }

  if (engine === "cloud") {
    // The Cloud pipeline is locked: text → image → 3D. A text-only request does not skip
    // to generate; it goes through t2i first.
    const needsT2i = !params.hasReferenceImage;
    if (needsT2i) {
      notes.push("Text-only input on Cloud: the locked text→image→image→3D pipeline applies.");
    }
    return {
      ok: true,
      plan: {
        engine,
        adapter: "bluefox",
        profile,
        needsT2i,
        // Admission runs on whatever image reaches the generator, user-supplied or generated.
        needsPreprocess: true,
        needsBake: profile === "game_ready",
        polyBudget,
        confidence: params.compileConfidence,
        notes,
      },
    };
  }

  // Water. Choosing a mode inside Water is not an engine switch (DECISIONS_LOCKED D1).
  const waterMode: WaterMode = params.waterMode ?? "threejs";
  if (waterMode === "threejs") {
    notes.push(
      "Water threejs mode: the deliverable is procedural factory code; the GLB is exported from it for the geometry gate."
    );
    return {
      ok: true,
      plan: {
        engine,
        waterMode,
        adapter: "threejs-factory",
        profile,
        // No t2i and no matting on the factory path — there is no image in the loop.
        needsT2i: false,
        needsPreprocess: false,
        needsBake: false,
        polyBudget,
        confidence: params.compileConfidence,
        notes,
      },
    };
  }

  notes.push("Water mesh mode: BYOK adapter. The user's own key pays for this call.");
  return {
    ok: true,
    plan: {
      engine,
      waterMode,
      adapter: "meshy",
      profile,
      needsT2i: false,
      needsPreprocess: params.hasReferenceImage,
      needsBake: profile === "game_ready",
      polyBudget,
      confidence: params.compileConfidence,
      notes,
    },
  };
}

export type EstimateResult =
  | { ok: true; credits: number; breakdown: Array<{ stage: string; credits: number }> }
  | { ok: false; reason: string; required: number; available: number };

/** Indicative credit cost per stage. Cloud spends platform credits; Water mesh spends the user's key. */
const STAGE_CREDITS: Record<string, number> = {
  t2i: 1,
  rembg: 0,
  generate: 8,
  mesh_post: 0,
  bake: 4,
  render_views: 0,
  score: 1,
};

/**
 * `run.estimate` — a hard gate. Under-funded runs stop here rather than failing halfway
 * through and leaving a half-paid job behind.
 */
export function estimateRun(params: {
  plan: RoutePlan;
  availableCredits: number;
}): EstimateResult {
  const breakdown: Array<{ stage: string; credits: number }> = [];
  const add = (stage: string) => breakdown.push({ stage, credits: STAGE_CREDITS[stage] ?? 0 });

  if (params.plan.needsT2i) add("t2i");
  if (params.plan.needsPreprocess) add("rembg");
  // Water mesh generation is billed to the user's own provider key, not to platform credits.
  if (!(params.plan.engine === "water" && params.plan.waterMode === "mesh")) add("generate");
  add("mesh_post");
  if (params.plan.needsBake) add("bake");
  add("render_views");
  add("score");

  const credits = breakdown.reduce((sum, entry) => sum + entry.credits, 0);
  if (credits > params.availableCredits) {
    return {
      ok: false,
      reason: `This run needs ${credits} credits and ${params.availableCredits} are available.`,
      required: credits,
      available: params.availableCredits,
    };
  }
  return { ok: true, credits, breakdown };
}
