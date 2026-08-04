import { Router } from "express";
import { randomUUID } from "crypto";
import { waitUntil } from "@vercel/functions";
import { requireAuth, syncUserToDatabase } from "../middleware/auth.js";
import { createJob, getJobForUser, updateJobStatus } from "../repository/jobs.js";
import { getDecryptedUserApiKey, listUserApiKeyMeta } from "../repository/userApiKeys.js";
import {
  catalogEntry,
  isOpenRouterModelId,
  providerForModel,
  hasReportedTokenUsage,
} from "../lib/llmProviders.js";
import { intakeGate } from "../lib/codeSculptPipeline.js";
import { runStudioPipeline } from "../lib/water/harness/run.js";
import {
  parseQualityTier,
  parseWaterSkillId,
} from "../lib/waterSkills.js";
import { ENGINE } from "../lib/engines.js";
import { supabase } from "../db.js";
import { logger } from "../logger.js";
import { uploadDataUrlToS3 } from "../lib/s3Upload.js";
import type { ApiKeyProvider } from "../lib/userApiKeysCrypto.js";

/** Water engine router (legacy mount: /api/code-sculpt). */
export const codeSculptRouter = Router();
export const waterRouter = codeSculptRouter;

async function updateCodeSculptResult(
  jobId: string,
  data: {
    status: "WAIT" | "RUN" | "FAIL" | "DONE";
    factoryCode?: string | null;
    sculptPass?: string | null;
    sculptSpec?: Record<string, unknown> | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    previewImageUrl?: string | null;
    llmInputTokens?: number | null;
    llmOutputTokens?: number | null;
    llmTotalTokens?: number | null;
  }
) {
  const patch: Record<string, unknown> = {
    status: data.status,
    updated_at: new Date().toISOString(),
  };
  if (data.factoryCode !== undefined) patch.factory_code = data.factoryCode;
  if (data.sculptPass !== undefined) patch.sculpt_pass = data.sculptPass;
  if (data.sculptSpec !== undefined) patch.sculpt_spec = data.sculptSpec;
  if (data.errorCode !== undefined) patch.error_code = data.errorCode;
  if (data.errorMessage !== undefined) patch.error_message = data.errorMessage;
  if (data.previewImageUrl !== undefined) patch.preview_image_url = data.previewImageUrl;
  if (data.llmInputTokens !== undefined) patch.llm_input_tokens = data.llmInputTokens;
  if (data.llmOutputTokens !== undefined) patch.llm_output_tokens = data.llmOutputTokens;
  if (data.llmTotalTokens !== undefined) patch.llm_total_tokens = data.llmTotalTokens;

  const { error } = await supabase.from("jobs").update(patch).eq("id", jobId);
  if (error) throw error;
}

codeSculptRouter.post("/generate", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    await syncUserToDatabase(userId);

    // Text → 3D is the primary path. An image is an optional extra reference.
    const imageUrl = String(req.body?.imageUrl || "").trim() || null;
    const modelId = String(req.body?.modelId || "").trim();
    const prompt = req.body?.prompt ? String(req.body.prompt).trim() : "";
    const workspaceId = req.body?.workspaceId || null;
    const parentJobId = req.body?.parentJobId || null;
    const skillId = parseWaterSkillId(req.body?.skillId);
    const qualityTier = parseQualityTier(req.body?.qualityTier);

    const intake = intakeGate({ prompt, imageUrl });
    if (!intake.ok) {
      return res.status(400).json({
        error: "intake_failed",
        message: intake.violations.join(" "),
      });
    }

    const entry = catalogEntry(modelId);
    if (!entry || entry.kind !== "code") {
      // Allow OpenRouter free / live slugs / Cursor ids that may not be in the static catalog yet
      const resolved = providerForModel(modelId);
      if (!isOpenRouterModelId(modelId) && resolved !== "openrouter" && resolved !== "cursor") {
        return res.status(400).json({ error: "Select a bring-your-own model for Water" });
      }
    }

    const provider = providerForModel(modelId);
    if (!provider || provider === "hydrilla") {
      return res.status(400).json({ error: "Invalid model provider" });
    }

    const keys = await listUserApiKeyMeta(userId);
    const keyMeta = keys.find((k) => k.provider === provider);
    if (!keyMeta?.configured) {
      return res.status(400).json({
        error: "api_key_required",
        provider,
        message: `Add a ${provider} API key in Settings → Models & API Keys`,
      });
    }
    if (keyMeta.status === "invalid") {
      return res.status(400).json({
        error: "api_key_invalid",
        provider,
        message: "Your API key failed verification. Update it in Settings.",
      });
    }

    const apiKey = await getDecryptedUserApiKey(userId, provider as ApiKeyProvider);
    if (!apiKey) {
      return res.status(400).json({
        error: "api_key_required",
        provider,
        message: "Add an API key in Settings → Models & API Keys",
      });
    }

    const jobId = `wt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    // Create Water job — credits_used 0 (bring-your-own-key)
    try {
      await createJob({
        id: jobId,
        userId,
        workspaceId,
        parentJobId,
        prompt,
        imageUrl,
        sourceImages: imageUrl ? [imageUrl] : null,
        generateType: ENGINE.water.writeGenerateType as any,
        status: "RUN",
        creditsUsed: 0,
      });
    } catch (err: any) {
      logger.error({ err }, "Failed to create Water job");
      return res.status(500).json({
        error:
          "Could not create Water job. Run SQL migration add_user_api_keys_and_code_sculpt.sql in Supabase.",
      });
    }

    // Set engine fields (columns from migration). Ignore if columns missing.
    await supabase
      .from("jobs")
      .update({
        engine: ENGINE.water.writeEngine,
        result_kind: ENGINE.water.resultKind,
        llm_model: modelId,
        llm_provider: provider,
        sculpt_pass: "assessment",
      })
      .eq("id", jobId)
      .then(({ error }) => {
        if (error) {
          logger.warn({ error, jobId }, "engine columns update skipped (migration pending?)");
        }
      });

    // The client polls the job. On Vercel, waitUntil keeps the function alive
    // after the response; locally the normal Node process owns the task.
    const generationTask = (async () => {
      try {
        const result = await runStudioPipeline({
          provider: provider as ApiKeyProvider,
          modelId,
          apiKey,
          prompt,
          imageUrl,
          skillId,
          qualityTier,
          onPass: async (pass) => {
            await supabase.from("jobs").update({ sculpt_pass: pass }).eq("id", jobId);
          },
        });

        const factoryCode = result.factoryCode;
        if (!factoryCode || factoryCode.length < 200) {
          await updateCodeSculptResult(jobId, {
            status: "FAIL",
            errorCode: "empty_factory",
            errorMessage:
              "The model did not return usable Three.js code. Try another Water model, or rephrase the prompt.",
          });
          return;
        }

        const lastPass =
          result.completedPasses[result.completedPasses.length - 1] || "blockout";

        await updateCodeSculptResult(jobId, {
          status: "DONE",
          factoryCode,
          sculptPass: result.partial ? "partial" : lastPass,
          sculptSpec: {
            modelId,
            provider,
            skillId: result.skillId,
            qualityTier: result.qualityTier,
            pass: lastPass,
            completedPasses: result.completedPasses,
            passReviews: result.passReviews,
            partial: result.partial,
            usedFallback: Boolean(
              result.partial &&
                (result.spec as { qualityContract?: { notes?: string } })?.qualityContract?.notes?.includes(
                  "[fallback-factory]"
                )
            ),
            mode: imageUrl ? "image_to_code" : "text_to_code",
            refined: result.refined,
            specGate: result.specGate,
            codeGate: result.codeGate,
            spec: result.spec,
            tokenUsage: hasReportedTokenUsage(result.tokenUsage) ? result.tokenUsage : null,
            tokenPasses: result.tokenPasses,
            createdAt: new Date().toISOString(),
          },
          previewImageUrl: imageUrl,
          llmInputTokens: hasReportedTokenUsage(result.tokenUsage)
            ? result.tokenUsage.inputTokens
            : null,
          llmOutputTokens: hasReportedTokenUsage(result.tokenUsage)
            ? result.tokenUsage.outputTokens
            : null,
          llmTotalTokens: hasReportedTokenUsage(result.tokenUsage)
            ? result.tokenUsage.totalTokens
            : null,
        });
      } catch (err: any) {
        logger.error({ err, jobId }, "Water Studio generation failed");
        try {
          await updateJobStatus(jobId, {
            status: "FAIL",
            errorCode: "water_failed",
            errorMessage: err?.message?.slice(0, 500) || "Generation failed",
          });
        } catch {}
      }
    })();

    if (process.env.VERCEL === "1" || process.env.VERCEL_ENV) {
      waitUntil(generationTask);
    } else {
      void generationTask;
    }

    res.json({
      jobId,
      status: "RUN",
      engine: "water",
      skillId,
      qualityTier,
      mode: imageUrl ? "image_to_code" : "text_to_code",
    });
  } catch (err: any) {
    logger.error({ err }, "POST /api/water/generate failed");
    res.status(500).json({ error: err?.message || "Water failed" });
  }
});

codeSculptRouter.get("/jobs/:jobId", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const jobId = req.params.jobId;
    const job = await getJobForUser(jobId, userId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const { data } = await supabase
      .from("jobs")
      .select(
        "id, status, engine, result_kind, llm_model, llm_provider, factory_code, sculpt_pass, sculpt_spec, preview_image_url, image_url, error_code, error_message, prompt, created_at, updated_at, llm_input_tokens, llm_output_tokens, llm_total_tokens"
      )
      .eq("id", jobId)
      .maybeSingle();

    const tokenFromSpec =
      data?.sculpt_spec && typeof data.sculpt_spec === "object"
        ? (data.sculpt_spec as { tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } })
            .tokenUsage
        : null;
    const dbStatus = (data?.status || job.status) as string;
    const updatedAtMs = Date.parse(data?.updated_at || job.updatedAt || "");
    const isStaleRun =
      (dbStatus === "RUN" || dbStatus === "WAIT") &&
      Number.isFinite(updatedAtMs) &&
      Date.now() - updatedAtMs > 8 * 60 * 1000;
    if (isStaleRun) {
      await updateCodeSculptResult(jobId, {
        status: "FAIL",
        sculptPass: data?.sculpt_pass || "blockout",
        errorCode: "water_timeout",
        errorMessage:
          "The Water provider stopped responding and the job expired. Retry with Fast/Standard or another model.",
      }).catch((error) => {
        logger.warn({ error, jobId }, "Failed to expire stale Water job");
      });
    }

    res.json({
      job: {
        id: job.id,
        status: isStaleRun ? "FAIL" : job.status,
        prompt: job.prompt,
        imageUrl: job.imageUrl,
        previewImageUrl: job.previewImageUrl ?? data?.preview_image_url ?? null,
        errorCode: isStaleRun ? "water_timeout" : job.errorCode,
        errorMessage: isStaleRun
          ? "The Water provider stopped responding and the job expired. Retry with Fast/Standard or another model."
          : job.errorMessage,
        engine: data?.engine || "water",
        resultKind: data?.result_kind || "three_factory",
        llmModel: data?.llm_model || null,
        llmProvider: data?.llm_provider || null,
        factoryCode: data?.factory_code || null,
        sculptPass: data?.sculpt_pass || null,
        sculptSpec: data?.sculpt_spec || null,
        llmInputTokens: data?.llm_input_tokens ?? tokenFromSpec?.inputTokens ?? null,
        llmOutputTokens: data?.llm_output_tokens ?? tokenFromSpec?.outputTokens ?? null,
        llmTotalTokens: data?.llm_total_tokens ?? tokenFromSpec?.totalTokens ?? null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "GET code-sculpt job failed");
    res.status(500).json({ error: "Failed to load job" });
  }
});

/** List Water jobs with LLM token usage for the signed-in user. */
codeSculptRouter.get("/usage", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "100"), 10) || 100, 1), 200);

    const { data, error } = await supabase
      .from("jobs")
      .select(
        "id, prompt, status, llm_model, llm_provider, llm_input_tokens, llm_output_tokens, llm_total_tokens, sculpt_spec, created_at, engine"
      )
      .eq("user_id", userId)
      .or("engine.eq.water,engine.eq.code_sculpt,id.like.wt_%,id.like.cs_%")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const jobs = (data || []).map((row: any) => {
      const fromSpec =
        row.sculpt_spec && typeof row.sculpt_spec === "object"
          ? (row.sculpt_spec as { tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } })
              .tokenUsage
          : null;
      return {
        id: row.id,
        prompt: row.prompt,
        status: row.status,
        model: row.llm_model || null,
        provider: row.llm_provider || null,
        inputTokens: row.llm_input_tokens ?? fromSpec?.inputTokens ?? null,
        outputTokens: row.llm_output_tokens ?? fromSpec?.outputTokens ?? null,
        totalTokens: row.llm_total_tokens ?? fromSpec?.totalTokens ?? null,
        createdAt: row.created_at,
      };
    });

    res.json({ jobs });
  } catch (err: any) {
    logger.error({ err }, "GET /api/water/usage failed");
    res.status(500).json({ error: err?.message || "Failed to load Water usage" });
  }
});

/**
 * Save a client-captured three-quarter screenshot as the library thumbnail.
 * Accepts a JPEG/PNG data URL (preferred) or a public image URL.
 */
codeSculptRouter.post("/jobs/:jobId/thumbnail", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const jobId = req.params.jobId;
    const job = await getJobForUser(jobId, userId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const dataUrl = String(req.body?.dataUrl || "").trim();
    const imageUrl = String(req.body?.imageUrl || "").trim();

    let previewImageUrl: string | null = null;

    if (dataUrl.startsWith("data:image/")) {
      // Prefer a durable S3 thumbnail; fall back to the data URL only if S3 is off.
      const s3Url = await uploadDataUrlToS3(dataUrl, `preview/${jobId}/water_thumb.jpg`);
      if (s3Url) {
        previewImageUrl = s3Url;
      } else {
        if (dataUrl.length > 900_000) {
          return res.status(400).json({ error: "Thumbnail too large" });
        }
        previewImageUrl = dataUrl;
      }
    } else if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
      previewImageUrl = imageUrl;
    } else {
      return res.status(400).json({ error: "Provide dataUrl or imageUrl" });
    }

    const { error } = await supabase
      .from("jobs")
      .update({
        preview_image_url: previewImageUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .eq("user_id", userId);

    if (error) throw error;

    res.json({ ok: true, previewImageUrl });
  } catch (err: any) {
    logger.error({ err }, "POST water thumbnail failed");
    res.status(500).json({ error: err?.message || "Failed to save thumbnail" });
  }
});
