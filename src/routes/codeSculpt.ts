import { Router } from "express";
import { randomUUID } from "crypto";
import { waitUntil } from "@vercel/functions";
import { requireAuth, syncUserToDatabase } from "../middleware/auth.js";
import { createJob, getJobForUser } from "../repository/jobs.js";
import {
  insertJobCard,
  checkpointStage,
  saveCompiledPrompt,
  addEvidenceCapture,
  setJobCardOutcome,
} from "../repository/jobCards.js";
import { newRunId, packWaterVisual, runFactoryVisualPass } from "../lib/water/harness/visualPass.js";
import { admitWaterImageUrl } from "../lib/water/harness/imageIntake.js";
import { SpecBlockedError } from "../lib/water/harness/planner.js";
import { resolveWaterApiKey } from "../repository/platformApiKeys.js";
import { hasReportedTokenUsage, parseWaterModelId } from "../lib/llmProviders.js";
import { intakeGate, validateFactoryCode } from "../lib/codeSculptPipeline.js";
import { generateWaterAsset } from "../lib/water/generateWaterAsset.js";
import { assertWaterByokModel, CloudFirewallError } from "../lib/water/cloudFirewall.js";
import { runWaterDirector } from "../lib/water/agents/director.js";
import { runVisualQa } from "../lib/water/agents/visualQa.js";
import { runPerformanceQa } from "../lib/water/agents/performanceQa.js";
import {
  persistWaterGenerate,
  loadWaterSceneForJob,
  applyWaterSceneOp,
  insertWaterMessage,
  listWaterMessages,
  type WaterSceneOp,
} from "../repository/waterEngine.js";
import type { Vec3 } from "../lib/water/scene/ir.js";
import { planWaterCreate } from "../lib/water/orchestrator/routeCreate.js";
import { STALE_RUN_MS } from "../lib/water/runtimeLimits.js";
import {
  registerWaterCancel,
  cancelWaterJob,
  clearWaterCancel,
  isUserCancelError,
  isWaterCancelled,
  WATER_CANCELLED_MESSAGE,
} from "../lib/water/cancelRegistry.js";
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
    durationMs?: number | null;
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
  if (data.durationMs !== undefined) patch.duration_ms = data.durationMs;

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
    const intake = intakeGate({ prompt, imageUrl });
    if (!intake.ok) {
      return res.status(400).json({
        error: "intake_failed",
        message: intake.violations.join(" "),
      });
    }

    let imageAdmission: Awaited<ReturnType<typeof admitWaterImageUrl>> | null = null;
    if (imageUrl) {
      imageAdmission = await admitWaterImageUrl(imageUrl);
      if (!imageAdmission.ok) {
        return res.status(400).json({
          error: "intake_failed",
          message: imageAdmission.message,
        });
      }
    }

    // Pack is bound from the brief. Quality is the user's Fast / Standard / Studio pick.
    const routed = planWaterCreate({
      prompt,
      imageUrl,
      qualityTier: req.body?.qualityTier,
    });
    if (!routed.ok) {
      return res.status(400).json({ error: "intake_failed", message: routed.message });
    }
    const { skillId, qualityTier } = routed.plan;

    try {
      assertWaterByokModel(modelId);
    } catch (err) {
      if (err instanceof CloudFirewallError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
    const parsed = parseWaterModelId(modelId);
    if (!parsed) {
      return res.status(400).json({ error: "Select a bring-your-own model for Water" });
    }
    const provider = parsed.provider;

    const resolved = await resolveWaterApiKey(userId, provider as ApiKeyProvider);
    if (!resolved) {
      return res.status(400).json({
        error: "api_key_required",
        provider,
        message: `Add a ${provider} API key in Settings → Models & API Keys`,
      });
    }
    const apiKey = resolved.apiKey;

    const jobId = `wt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const runId = newRunId();

    let previousFactoryCode = String(req.body?.factoryCode || "").trim() || null;
    if (!previousFactoryCode && parentJobId) {
      const { data: parent } = await supabase
        .from("jobs")
        .select("factory_code, user_id")
        .eq("id", parentJobId)
        .maybeSingle();
      if (parent?.user_id === userId && parent.factory_code) {
        previousFactoryCode = String(parent.factory_code);
      }
    }

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
        sculpt_spec: {
          skillId,
          qualityTier,
          profile: routed.plan.profile,
          createStages: routed.plan.stages,
          routeNotes: routed.plan.notes,
        },
      })
      .eq("id", jobId)
      .then(({ error }) => {
        if (error) {
          logger.warn({ error, jobId }, "engine columns update skipped (migration pending?)");
        }
      });

    try {
      await insertJobCard({
        jobId,
        runId,
        engine: "water",
        waterMode: "threejs",
        profile: routed.plan.profile,
        assetClass: routed.plan.compiled.assetClass,
      });
      await saveCompiledPrompt({
        jobId,
        compiled: routed.plan.compiled,
        confidence: 0.9,
      });
      await checkpointStage(jobId, {
        stageId: "water-compile-prompt",
        status: "done",
        next: "water-route-estimate",
      });
      await checkpointStage(jobId, {
        stageId: "water-route-estimate",
        status: "done",
        next: "water-generate-3d",
      });
      await checkpointStage(jobId, {
        stageId: "water-generate-3d",
        status: "running",
      });
      if (imageAdmission?.ok) {
        await addEvidenceCapture({
          jobId,
          runId,
          kind: "admission_report",
          uri: `job://${jobId}/${runId}/admission.json`,
          meta: {
            maskSource: imageAdmission.report.maskSource,
            admitted: imageAdmission.report.admitted,
            width: imageAdmission.report.width,
            height: imageAdmission.report.height,
            shortSidePx: imageAdmission.report.shortSidePx,
            foregroundRatio: imageAdmission.report.foregroundRatio,
            failCodes: imageAdmission.report.failCodes,
            reasons: imageAdmission.report.reasons.slice(0, 6),
          },
        });
      }
    } catch (err: any) {
      logger.warn({ err: err?.message, jobId }, "JobCard persist skipped");
    }

    // The client polls the job. On Vercel, waitUntil keeps the function alive
    // after the response; locally the normal Node process owns the task.
    const cancelController = registerWaterCancel(jobId);
    const generationStarted = Date.now();
    const elapsedNow = () => Math.max(0, Date.now() - generationStarted);
    const generationTask = (async () => {
      try {
        const result = await generateWaterAsset({
          provider: provider as ApiKeyProvider,
          modelId,
          apiKey,
          prompt,
          imageUrl,
          skillId,
          qualityTier,
          jobId,
          runId,
          profile: routed.plan.profile,
          assetClass: routed.plan.compiled.assetClass,
          previousFactoryCode,
          referenceMask:
            imageAdmission?.ok && imageAdmission.report.mask
              ? {
                  mask: imageAdmission.report.mask.mask,
                  width: imageAdmission.report.mask.width,
                  height: imageAdmission.report.mask.height,
                  source: imageAdmission.report.maskSource === "rembg_adapter" ? "rembg" : "user_upload",
                }
              : null,
          signal: cancelController.signal,
          onPass: async (pass) => {
            if (cancelController.signal.aborted) return;
            await supabase.from("jobs").update({ sculpt_pass: pass }).eq("id", jobId);
          },
        });

        if (isWaterCancelled(jobId)) {
          await updateCodeSculptResult(jobId, {
            status: "FAIL",
            errorCode: "cancelled",
            errorMessage: WATER_CANCELLED_MESSAGE,
            sculptPass: "cancelled",
            durationMs: elapsedNow(),
          });
          return;
        }

        // Don't overwrite a cancel that won the race after the pipeline returned
        {
          const { data: latest } = await supabase
            .from("jobs")
            .select("status, error_code")
            .eq("id", jobId)
            .maybeSingle();
          if (latest?.error_code === "cancelled") {
            return;
          }
        }

        const factoryCode = result.factoryCode;
        if (!factoryCode || factoryCode.length < 200) {
          await updateCodeSculptResult(jobId, {
            status: "FAIL",
            errorCode: "empty_factory",
            errorMessage:
              "The model did not return usable Three.js code. Try another Water model, or rephrase the prompt.",
            durationMs: elapsedNow(),
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
            profile: routed.plan.profile,
            createStages: routed.plan.stages,
            routeNotes: routed.plan.notes,
            pass: lastPass,
            completedPasses: result.completedPasses,
            passReviews: result.passReviews,
            partial: result.partial,
            usedFallback: Boolean(result.partial) &&
              String((result.spec as { qualityContract?: { notes?: string } })?.qualityContract?.notes || "")
                .includes("[fallback"),
            mode: imageUrl ? "image_to_code" : "text_to_code",
            refined: result.refined,
            specGate: result.specGate,
            codeGate: result.codeGate,
            spec: result.spec,
            visual: result.visual || null,
            runId,
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
          durationMs: result.elapsedMs ?? elapsedNow(),
        });

        try {
          await persistWaterGenerate({
            userId,
            workspaceId,
            jobId,
            runId,
            qualityTier: result.qualityTier,
            pack: result.skillId,
            modelId,
            factoryCode,
            spec: result.spec,
            passReviews: result.passReviews,
            meshNames: result.visual?.meshNames,
            triangleCount: null,
            drawCalls: result.visual?.meshNames?.length ?? null,
            durationMs: result.elapsedMs ?? elapsedNow(),
            tokenUsage: hasReportedTokenUsage(result.tokenUsage) ? result.tokenUsage : null,
          });
        } catch (err: any) {
          logger.warn({ err: err?.message, jobId }, "water_* dual-write skipped");
        }

        try {
          await checkpointStage(jobId, {
            stageId: "water-generate-3d",
            status: "done",
            next: "water-mesh-post",
          });
          const gateFailed = Boolean(result.visual && result.visual.gatePassed === false);
          const geoCodes = (result.visual?.failCodes || []).filter((c): c is import("../lib/create/contracts.js").FailCode =>
            [
              "EMPTY_GLB",
              "NO_NORMALS",
              "NON_MANIFOLD",
              "SELF_INTERSECT",
              "NAN_BOUNDS",
              "NOT_GROUNDED",
              "TRI_BUDGET",
              "FLOATER",
              "THIN_SHELL",
              "ORBIT_COLLAPSE",
              "GLTF_INVALID",
              "CONTRACT",
            ].includes(c)
          );
          await checkpointStage(jobId, {
            stageId: "water-mesh-post",
            status: gateFailed ? "failed" : "done",
            failCodes: gateFailed ? (geoCodes.length ? geoCodes : ["CONTRACT"]) : undefined,
            next: gateFailed ? null : "water-evaluate",
          });
          if (!gateFailed) {
            await checkpointStage(jobId, {
              stageId: "water-evaluate",
              status: "done",
              next: null,
            });
          }
          await setJobCardOutcome(
            jobId,
            gateFailed
              ? "rejected"
              : result.visual?.promoteEligible
                ? "promoted"
                : result.partial
                  ? "partial"
                  : "pending"
          );
          if (typeof result.refineTotal === "number" && result.refineTotal > 0) {
            await supabase
              .from("job_cards")
              .update({ refine_total: Math.min(6, result.refineTotal) })
              .eq("job_id", jobId);
          }
          if (result.visual) {
            await addEvidenceCapture({
              jobId,
              runId,
              kind: "score_report",
              uri: `job://${jobId}/${runId}/score.json`,
              meta: result.visual,
            });
          }
        } catch (err: any) {
          logger.warn({ err: err?.message, jobId }, "JobCard checkpoint after generate skipped");
        }
      } catch (err: any) {
        if (err instanceof SpecBlockedError || err?.name === "SpecBlockedError" || err?.code === "spec_blocked") {
          logger.warn({ jobId, violations: err?.violations }, "Water spec blocked — job not generated");
          try {
            await updateCodeSculptResult(jobId, {
              status: "FAIL",
              errorCode: "spec_blocked",
              errorMessage: err?.message?.slice(0, 500) || "The reconstruction spec failed quality gates.",
              sculptPass: "spec",
              durationMs: elapsedNow(),
            });
          } catch {}
          return;
        }
        if (isUserCancelError(err) || isWaterCancelled(jobId)) {
          logger.info({ jobId }, "Water Studio generation cancelled by user");
          try {
            await updateCodeSculptResult(jobId, {
              status: "FAIL",
              errorCode: "cancelled",
              errorMessage: WATER_CANCELLED_MESSAGE,
              sculptPass: "cancelled",
              durationMs: elapsedNow(),
            });
          } catch {}
          return;
        }
        logger.error({ err, jobId }, "Water Studio generation failed");
        try {
          await updateCodeSculptResult(jobId, {
            status: "FAIL",
            errorCode: "water_failed",
            errorMessage: err?.message?.slice(0, 500) || "Generation failed",
            durationMs: elapsedNow(),
          });
        } catch {}
      } finally {
        clearWaterCancel(jobId);
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

codeSculptRouter.post("/jobs/:jobId/cancel", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const jobId = req.params.jobId;
    const job = await getJobForUser(jobId, userId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const status = String((job as { status?: string }).status || "").toUpperCase();
    if (status === "DONE") {
      return res.status(400).json({ error: "Job already completed" });
    }
    const errMsg = String((job as { errorMessage?: string | null }).errorMessage || "");
    if (status === "FAIL" && /cancel/i.test(errMsg)) {
      return res.json({ job_id: jobId, status: "cancelled", message: WATER_CANCELLED_MESSAGE });
    }

    cancelWaterJob(jobId);

    await updateCodeSculptResult(jobId, {
      status: "FAIL",
      errorCode: "cancelled",
      errorMessage: WATER_CANCELLED_MESSAGE,
      sculptPass: "cancelled",
      durationMs: Math.max(0, Date.now() - new Date(job.createdAt).getTime() || 0),
    });

    res.json({
      job_id: jobId,
      status: "cancelled",
      message: WATER_CANCELLED_MESSAGE,
    });
  } catch (err: any) {
    logger.error({ err }, "POST /api/water/jobs/:jobId/cancel failed");
    res.status(500).json({ error: err?.message || "Failed to cancel Water job" });
  }
});

codeSculptRouter.patch("/jobs/:jobId/factory", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const jobId = req.params.jobId;
    const job = await getJobForUser(jobId, userId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (String(job.status).toUpperCase() !== "DONE") {
      return res.status(400).json({ error: "Open a finished Water model before editing factory code." });
    }

    const factoryCode = String(req.body?.factoryCode || "").trim();
    const spec =
      job.sculptSpec && typeof job.sculptSpec === "object" && (job.sculptSpec as { spec?: any }).spec
        ? (job.sculptSpec as { spec: any }).spec
        : { name: "edit", components: [], materials: [] };
    const codeGate = validateFactoryCode(factoryCode, spec);
    if (!codeGate.ok) {
      return res.status(400).json({
        error: "code_gate",
        message: codeGate.violations.join(" "),
        violations: codeGate.violations,
      });
    }

    const runId = newRunId();
    const sculptSpec = (job.sculptSpec && typeof job.sculptSpec === "object" ? job.sculptSpec : {}) as Record<
      string,
      unknown
    >;
    const profile = (sculptSpec.profile as "draft" | "balanced" | "quality" | "game_ready") || "balanced";
    const visual = await runFactoryVisualPass({
      jobId,
      runId,
      spec,
      factoryCode,
      profile,
      assetClass: "prop",
      expectedScaleM: spec.scale?.approxHeight ?? null,
      allowSpecProxy: false,
    });
    const visualJson = packWaterVisual(visual);

    const { error } = await supabase
      .from("jobs")
      .update({
        factory_code: factoryCode,
        sculpt_spec: {
          ...sculptSpec,
          spec,
          visual: visualJson,
          handEdit: true,
          runId,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (error) throw error;

    try {
      await addEvidenceCapture({
        jobId,
        runId,
        kind: "score_report",
        uri: `job://${jobId}/${runId}/score.json`,
        meta: {
          gatePassed: visual.gate.passed,
          fidelity: visual.score.fidelity,
          failCodes: visual.score.failCodes,
          promoteEligible: visual.score.promoteEligible,
          handEdit: true,
        },
      });
    } catch (err: any) {
      logger.warn({ err: err?.message, jobId }, "hand-edit evidence capture skipped");
    }

    res.json({
      factoryCode,
      visual: visualJson,
    });
  } catch (err: any) {
    logger.error({ err }, "PATCH /api/water/jobs/:jobId/factory failed");
    res.status(500).json({ error: err?.message || "Failed to save factory" });
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
        "id, status, engine, result_kind, llm_model, llm_provider, factory_code, sculpt_pass, sculpt_spec, preview_image_url, image_url, error_code, error_message, prompt, created_at, updated_at, llm_input_tokens, llm_output_tokens, llm_total_tokens, duration_ms"
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
      Date.now() - updatedAtMs > STALE_RUN_MS;
    if (isStaleRun) {
      await updateCodeSculptResult(jobId, {
        status: "FAIL",
        sculptPass: data?.sculpt_pass || "blockout",
        errorCode: "water_timeout",
        errorMessage:
          "The Water provider stopped responding and the job expired. Retry with Fast/Standard or another model.",
        durationMs: Math.max(
          0,
          Date.now() - Date.parse(String(data?.created_at || job.createdAt || "")) || 0
        ),
      }).catch((error) => {
        logger.warn({ error, jobId }, "Failed to expire stale Water job");
      });
    }

    const scene = await loadWaterSceneForJob(jobId, userId);
    const visualEvidence =
      data?.sculpt_spec && typeof data.sculpt_spec === "object"
        ? (data.sculpt_spec as { visual?: unknown }).visual ?? null
        : null;

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
        durationMs: typeof data?.duration_ms === "number" ? data.duration_ms : job.durationMs ?? null,
        visualEvidence,
        scene,
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

codeSculptRouter.post("/chat", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    await syncUserToDatabase(userId);
    const jobId = String(req.body?.jobId || "").trim();
    const message = String(req.body?.message || "").trim();
    const modelId = String(req.body?.modelId || "").trim();
    if (!jobId || !message) {
      return res.status(400).json({ error: "jobId and message are required" });
    }
    try {
      assertWaterByokModel(modelId);
    } catch (err) {
      if (err instanceof CloudFirewallError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
    const parsed = parseWaterModelId(modelId);
    if (!parsed) {
      return res.status(400).json({ error: "Select a bring-your-own model for Water" });
    }
    const job = await getJobForUser(jobId, userId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const resolved = await resolveWaterApiKey(userId, parsed.provider as ApiKeyProvider);
    if (!resolved) {
      return res.status(400).json({
        error: "api_key_required",
        provider: parsed.provider,
        message: `Add a ${parsed.provider} API key in Settings → Models & API Keys`,
      });
    }

    const { data } = await supabase
      .from("jobs")
      .select("sculpt_spec, engine")
      .eq("id", jobId)
      .maybeSingle();
    if (data?.engine && data.engine !== "water" && data.engine !== "code_sculpt") {
      return res.status(400).json({ error: "Cloud jobs cannot enter the Water agent engine." });
    }
    const visual =
      data?.sculpt_spec && typeof data.sculpt_spec === "object"
        ? runVisualQa((data.sculpt_spec as { visual?: Parameters<typeof runVisualQa>[0] }).visual)
        : runVisualQa(null);

    const sceneBefore = await loadWaterSceneForJob(jobId, userId);
    await insertWaterMessage({
      jobId,
      sceneId: sceneBefore?.sceneId,
      role: "user",
      content: message,
    });

    const result = await runWaterDirector({
      userId,
      jobId,
      message,
      modelId,
      apiKey: resolved.apiKey,
      visual,
    });

    await insertWaterMessage({
      jobId,
      sceneId: result.scene?.sceneId || sceneBefore?.sceneId,
      role: "assistant",
      content: result.reply,
    });

    res.json({
      kind: result.kind,
      reply: result.reply,
      refinePrompt: result.refinePrompt || null,
      scene: result.scene || sceneBefore,
      visual: result.visual || visual,
      performance: result.performance || runPerformanceQa({
        meshNames: result.scene?.meshNames || sceneBefore?.meshNames,
        triangleCount: result.scene?.triangleCount ?? sceneBefore?.triangleCount,
        drawCalls: result.scene?.drawCalls ?? sceneBefore?.drawCalls,
      }),
    });
  } catch (err: any) {
    logger.error({ err }, "POST /api/water/chat failed");
    res.status(500).json({ error: err?.message || "Follow-up failed" });
  }
});

codeSculptRouter.get("/jobs/:jobId/messages", requireAuth, async (req, res) => {
  try {
    const rows = await listWaterMessages(req.params.jobId, req.userId!);
    res.json({ messages: rows });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to load messages" });
  }
});

codeSculptRouter.get("/jobs/:jobId/scene", requireAuth, async (req, res) => {
  try {
    const scene = await loadWaterSceneForJob(req.params.jobId, req.userId!);
    if (!scene) return res.status(404).json({ error: "Scene not found" });
    res.json({ scene });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to load scene" });
  }
});

codeSculptRouter.patch("/jobs/:jobId/scene", requireAuth, async (req, res) => {
  try {
    const op = String(req.body?.op || "move") as WaterSceneOp;
    if (!["move", "rotate", "scale", "material"].includes(op)) {
      return res.status(400).json({ error: "Unsupported op" });
    }
    const partName =
      typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 200) : null;
    if (op === "material" && !req.body?.material) {
      return res.status(400).json({ error: "material is required" });
    }
    const scene = await applyWaterSceneOp({
      userId: req.userId!,
      jobId: req.params.jobId,
      op,
      position: Array.isArray(req.body?.position) ? (req.body.position as Vec3) : undefined,
      rotation: Array.isArray(req.body?.rotation) ? (req.body.rotation as Vec3) : undefined,
      scale: Array.isArray(req.body?.scale) ? (req.body.scale as Vec3) : undefined,
      material: req.body?.material || null,
      partName,
    });
    if (!scene) return res.status(404).json({ error: "Scene not found" });
    res.json({ scene });
  } catch (err: any) {
    logger.error({ err }, "PATCH water scene failed");
    res.status(500).json({ error: err?.message || "Failed to update scene" });
  }
});
