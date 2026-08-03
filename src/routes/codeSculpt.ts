import { Router } from "express";
import { randomUUID } from "crypto";
import { waitUntil } from "@vercel/functions";
import { requireAuth, requireApprovedAccess, syncUserToDatabase } from "../middleware/auth.js";
import { createJob, getJobForUser, updateJobStatus } from "../repository/jobs.js";
import { getDecryptedUserApiKey, listUserApiKeyMeta } from "../repository/userApiKeys.js";
import {
  catalogEntry,
  isOpenRouterModelId,
  providerForModel,
} from "../lib/llmProviders.js";
import { intakeGate, runCodeSculptPipeline } from "../lib/codeSculptPipeline.js";
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

  const { error } = await supabase.from("jobs").update(patch).eq("id", jobId);
  if (error) throw error;
}

codeSculptRouter.post("/generate", requireAuth, requireApprovedAccess, async (req, res) => {
  try {
    const userId = req.userId!;
    await syncUserToDatabase(userId);

    // Text → 3D is the primary path. An image is an optional extra reference.
    const imageUrl = String(req.body?.imageUrl || "").trim() || null;
    const modelId = String(req.body?.modelId || "").trim();
    const prompt = req.body?.prompt ? String(req.body.prompt).trim() : "";
    const workspaceId = req.body?.workspaceId || null;
    const parentJobId = req.body?.parentJobId || null;

    const intake = intakeGate({ prompt, imageUrl });
    if (!intake.ok) {
      return res.status(400).json({
        error: "intake_failed",
        message: intake.violations.join(" "),
      });
    }

    const entry = catalogEntry(modelId);
    if (!entry || entry.kind !== "code") {
      // Allow OpenRouter free / live slugs that may not be in the static catalog yet
      if (!isOpenRouterModelId(modelId) && providerForModel(modelId) !== "openrouter") {
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
        enablePBR: true,
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
        const result = await runCodeSculptPipeline({
          provider: provider as ApiKeyProvider,
          modelId,
          apiKey,
          prompt,
          imageUrl,
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
              "Model returned no usable code. Try a stronger model (Auto Free routes to a capable one).",
          });
          return;
        }

        await updateCodeSculptResult(jobId, {
          status: "DONE",
          factoryCode,
          sculptPass: "blockout",
          sculptSpec: {
            modelId,
            provider,
            pass: "blockout",
            mode: imageUrl ? "image_to_code" : "text_to_code",
            refined: result.refined,
            specGate: result.specGate,
            codeGate: result.codeGate,
            spec: result.spec,
            createdAt: new Date().toISOString(),
          },
          previewImageUrl: imageUrl,
        });
      } catch (err: any) {
        logger.error({ err, jobId }, "Code Sculpt generation failed");
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
        "id, status, engine, result_kind, llm_model, llm_provider, factory_code, sculpt_pass, sculpt_spec, preview_image_url, image_url, error_code, error_message, prompt, created_at, updated_at"
      )
      .eq("id", jobId)
      .maybeSingle();

    res.json({
      job: {
        id: job.id,
        status: job.status,
        prompt: job.prompt,
        imageUrl: job.imageUrl,
        previewImageUrl: job.previewImageUrl ?? data?.preview_image_url ?? null,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        engine: data?.engine || "water",
        resultKind: data?.result_kind || "three_factory",
        llmModel: data?.llm_model || null,
        llmProvider: data?.llm_provider || null,
        factoryCode: data?.factory_code || null,
        sculptPass: data?.sculpt_pass || null,
        sculptSpec: data?.sculpt_spec || null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "GET code-sculpt job failed");
    res.status(500).json({ error: "Failed to load job" });
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
