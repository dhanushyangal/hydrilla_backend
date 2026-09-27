/**
 * Frozen 12 Create tool IDs as AI SDK tool() — Water workers only.
 * Never import from /api/3d. job.submit stays 501 on the factory path.
 */

import { tool } from "ai";
import { z } from "zod";
import { TOOL_IDS, assertToolId } from "../../create/toolSurface.js";
import { screenSubject, validateCompiledPrompt } from "../../create/compile.js";
import { estimateRun, planRoute } from "../../create/route.js";
import { admitReference } from "../../create/admission.js";
import { runMeshPostGate } from "../../create/mesh/gate.js";
import { renderViews } from "../../create/mesh/views.js";
import { scoreAsset } from "../../create/score.js";
import { checkpointStage, loadEvidenceManifest, loadJobCard } from "../../../repository/jobCards.js";
import { getJobForUser } from "../../../repository/jobs.js";
import type { StageId } from "../../create/contracts.js";

for (const id of TOOL_IDS) assertToolId(id);

const jobIdSchema = z.object({
  jobId: z.string().min(1),
});

export function createWaterToolSurface(ctx: { userId?: string } = {}) {
  return {
    "prompt.compile": tool({
      description: "prompt.compile — Water compile screen + contract validation. engine=water only.",
      inputSchema: z.object({
        text: z.string().min(1),
        profile: z.enum(["draft", "balanced", "quality", "game_ready"]).optional(),
      }),
      execute: async ({ text, profile }) => {
        const screen = screenSubject({ text, engine: "water" });
        if (!screen.ok) return screen;
        const validated = validateCompiledPrompt({
          raw: {
            subject: text.slice(0, 240),
            parts: ["body", "detail"],
            materials: ["body", "accent"],
            scale_m: 0.4,
            ground_contact: true,
            style_lock: "Stylized original. Factory is static.",
            asset_class: "prop",
            profile: profile || "balanced",
            i2_3d_intent: {
              geo_brief: text.slice(0, 400),
              texture_brief: "Independent PBR. No baked lighting in albedo.",
              poly_budget_hint: 16_000,
            },
          },
          engine: "water",
          needsT2i: false,
        });
        return validated;
      },
    }),
    "run.estimate": tool({
      description: "run.estimate — Water BYOK estimate. Platform credits are 0 on factory generate.",
      inputSchema: z.object({
        compileConfidence: z.number().min(0).max(1).optional(),
        hasReferenceImage: z.boolean().optional(),
      }),
      execute: async ({ compileConfidence, hasReferenceImage }) => {
        const compiled = validateCompiledPrompt({
          raw: {
            subject: "Water asset",
            parts: ["body"],
            materials: ["body"],
            scale_m: 0.4,
            ground_contact: true,
            style_lock: "Stylized",
            asset_class: "prop",
            profile: "balanced",
            i2_3d_intent: {
              geo_brief: "Named parts, grounded.",
              texture_brief: "PBR",
              poly_budget_hint: 16_000,
            },
          },
          engine: "water",
          needsT2i: false,
        });
        if (!compiled.ok) return compiled;
        const route = planRoute({
          engine: "water",
          waterMode: "threejs",
          compiled: compiled.compiled,
          hasReferenceImage: Boolean(hasReferenceImage),
          compileConfidence: compileConfidence ?? 0.9,
        });
        if (!route.ok) return route;
        return estimateRun({ plan: route.plan, availableCredits: 0 });
      },
    }),
    "run.route": tool({
      description: "run.route — route inside Water. Cannot change engine to Cloud.",
      inputSchema: z.object({
        hasReferenceImage: z.boolean().optional(),
        compileConfidence: z.number().min(0).max(1).optional(),
      }),
      execute: async ({ hasReferenceImage, compileConfidence }) => {
        const compiled = validateCompiledPrompt({
          raw: {
            subject: "Water asset",
            parts: ["body"],
            materials: ["body"],
            scale_m: 0.4,
            ground_contact: true,
            style_lock: "Stylized",
            asset_class: "prop",
            profile: "balanced",
            i2_3d_intent: {
              geo_brief: "Named parts",
              texture_brief: "PBR",
              poly_budget_hint: 16_000,
            },
          },
          engine: "water",
          needsT2i: false,
        });
        if (!compiled.ok) return compiled;
        return planRoute({
          engine: "water",
          waterMode: "threejs",
          compiled: compiled.compiled,
          hasReferenceImage: Boolean(hasReferenceImage),
          compileConfidence: compileConfidence ?? 0.9,
        });
      },
    }),
    "image.rembg": tool({
      description: "image.rembg — admit a PNG reference for Water. Fails closed.",
      inputSchema: z.object({
        imageBase64: z.string().min(8),
        contentType: z.string().optional(),
      }),
      execute: async ({ imageBase64, contentType }) => {
        const bytes = Buffer.from(imageBase64.replace(/^data:[^;]+;base64,/, ""), "base64");
        return admitReference({ bytes, contentType: contentType || "image/png" });
      },
    }),
    "job.submit": tool({
      description:
        "job.submit — Water mesh adapters only. Shipped factory generate does not use this tool.",
      inputSchema: jobIdSchema.extend({ kind: z.string().optional() }),
      execute: async () => ({
        ok: false,
        code: 501,
        message: "Shipped Water generate uses generateWaterAsset, not job.submit.",
      }),
    }),
    "job.await": tool({
      description: "job.await — poll a Water jobs row the user owns.",
      inputSchema: jobIdSchema,
      execute: async ({ jobId }) => {
        if (!ctx.userId) return { ok: false, message: "No user" };
        const job = await getJobForUser(jobId, ctx.userId);
        if (!job) return { ok: false, message: "Job not found" };
        return { ok: true, status: job.status, errorCode: job.errorCode };
      },
    }),
    "mesh.post.gate": tool({
      description: "mesh.post.gate — HARD geometry gate on a GLB. Water factory path uses visual stats when no GLB.",
      inputSchema: z.object({
        glbBase64: z.string().optional(),
        profile: z.enum(["draft", "balanced", "quality", "game_ready"]).optional(),
      }),
      execute: async ({ glbBase64, profile }) => {
        if (!glbBase64) {
          return { ok: false, message: "No GLB on factory path; use Performance QA stats instead." };
        }
        const bytes = Buffer.from(glbBase64, "base64");
        return runMeshPostGate(bytes, {
          engine: "water",
          profile: profile || "balanced",
          assetClass: "prop",
        });
      },
    }),
    "mesh.bake": tool({
      description: "mesh.bake — Hydrilla bake worker. Not on the factory generate path.",
      inputSchema: jobIdSchema,
      execute: async () => ({
        ok: false,
        message: "Bake is not on shipped Water factory generate.",
      }),
    }),
    "asset.render_views": tool({
      description: "asset.render_views — turntable stills from a GLB.",
      inputSchema: z.object({ glbBase64: z.string().min(8) }),
      execute: async ({ glbBase64 }) => {
        const bytes = Buffer.from(glbBase64, "base64");
        const views = renderViews(bytes);
        return {
          ok: !views.error,
          error: views.error,
          orbitConsistency: views.orbitConsistency,
          meanObjectness: views.meanObjectness,
          angles: views.views.map((v) => v.angle),
        };
      },
    }),
    "asset.score": tool({
      description: "asset.score — Water evaluator. Requires JobCard + gate + views.",
      inputSchema: jobIdSchema.extend({
        glbBase64: z.string().optional(),
      }),
      execute: async ({ jobId, glbBase64 }) => {
        const card = await loadJobCard(jobId);
        if (!card) return { ok: false, message: "No JobCard" };
        if (!glbBase64) return { ok: false, message: "GLB required to score" };
        const bytes = Buffer.from(glbBase64, "base64");
        const gate = runMeshPostGate(bytes, {
          engine: "water",
          profile: card.profile,
          assetClass: card.assetClass,
        });
        const views = renderViews(bytes);
        const manifest = await loadEvidenceManifest(jobId, card.runId);
        return scoreAsset({
          card,
          gate,
          views,
          reference: null,
          manifest,
          materialCount: 1,
          namedParts: [],
        });
      },
    }),
    "run.checkpoint": tool({
      description: "run.checkpoint — persist a JobCard stage. Chat is never truth.",
      inputSchema: z.object({
        jobId: z.string().min(1),
        stageId: z.string().min(1),
        status: z.enum(["pending", "running", "done", "skipped", "failed"]),
        next: z.string().nullable().optional(),
        skipReason: z.string().optional(),
      }),
      execute: async ({ jobId, stageId, status, next, skipReason }) => {
        return checkpointStage(jobId, {
          stageId: stageId as StageId,
          status,
          next: (next ?? undefined) as StageId | undefined,
          skipReason,
        });
      },
    }),
    "experiment.fanout": tool({
      description: "experiment.fanout — paid-sample lab. Disabled on shipped generate.",
      inputSchema: z.object({ note: z.string().optional() }),
      execute: async () => ({
        ok: false,
        message: "Fanout is lab-only. Shipped Water generate is sequential passes.",
      }),
    }),
  };
}
