import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import multer from "multer";
import { requireDeveloperAuth } from "../../middleware/developerAuth.js";
import { deductCredit, refundCredit, getCreditsRow } from "../../services/credits.js";
import {
  submitImageTo3dGpu,
  fetchGpuJobStatus,
  cancelGpuJob,
} from "../../services/gpuGateway.js";
import {
  generateImage,
  runDeduplicatedImageJob,
  validateImagePrompt,
  IMAGE_CREDITS,
  parseImageAspect,
  parseImageProvider,
  parseImageQuality,
  runWithUsage,
  summarizeUsage,
  type ImageAspect,
  type ImageProvider,
  type ImageQuality,
  type InputImage,
  type UsageCall,
} from "../../services/imageProviders/index.js";
import { createJob, getJob, updateJobStatus } from "../../repository/jobs.js";
import { recordDeveloperApiKeyUsage } from "../../repository/developerApiKeys.js";
import { recordImageUsage, type ImageUsageRecord } from "../../repository/imageUsage.js";
import { uploadBufferToS3 } from "../../lib/s3Upload.js";
import { normalizeGlbUrl } from "../../utils/s3Urls.js";
import { logger } from "../../logger.js";

export const developerV1Router = Router();

const upload = multer({
  limits: { fileSize: 30 * 1024 * 1024 },
});

const CREDITS_3D = 30;

function saveApiImageUsage(record: Omit<ImageUsageRecord, "usage">, calls: UsageCall[]): void {
  if (record.status === "failed" && calls.length === 0) {
    return;
  }
  const usage = summarizeUsage(calls);
  recordImageUsage({ ...record, source: "api", usage }).catch((err: unknown) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: errMsg, jobId: record.jobId, userId: record.userId, costUsd: usage.costUsd },
      "Failed to record API image usage (non-critical)"
    );
  });
}

function trackKeyUsage(
  req: Request,
  endpoint: string,
  statusCode: number,
  creditsDeducted: number,
  details?: Record<string, unknown>
): void {
  if (!req.developerKeyId || !req.developerUserId) {
    return;
  }
  void recordDeveloperApiKeyUsage({
    apiKeyId: req.developerKeyId,
    userId: req.developerUserId,
    endpoint,
    method: req.method,
    statusCode,
    creditsDeducted,
    details,
  });
}

function parseTimestamp(dateStr?: string | null): number {
  if (!dateStr) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

function mapJobStatus(rawStatus?: string | null): "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELLED" {
  const s = (rawStatus || "").toUpperCase();
  if (s === "SUCCESS" || s === "COMPLETED") {
    return "SUCCEEDED";
  }
  if (s === "FAIL" || s === "FAILED" || s === "ERROR") {
    return "FAILED";
  }
  if (s === "PROCESSING" || s === "RUNNING") {
    return "IN_PROGRESS";
  }
  if (s === "CANCELLED" || s === "CANCELED") {
    return "CANCELLED";
  }
  return "PENDING";
}

async function fetchImageBufferFromUrl(imageUrl: string): Promise<InputImage> {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`Failed to download reference image: HTTP ${res.status}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const contentType = res.headers.get("content-type") || "image/png";
  const urlObj = new URL(imageUrl);
  const filename = urlObj.pathname.split("/").pop() || "input.png";
  return { buffer, contentType, filename };
}

// ============================================================================
// 1. POST /v1/3d/image-to-3d: Image -> High-res Textured 3D GLB
// ============================================================================
developerV1Router.post(
  "/3d/image-to-3d",
  requireDeveloperAuth,
  upload.single("image"),
  async (req: Request, res: Response) => {
    const userId = req.developerUserId!;
    const body = (req.body || {}) as Record<string, unknown>;
    const file = req.file;

    const requestedResolution = Number(body.resolution) === 1536 ? 1024 : (Number(body.resolution) || 1024);
    const requestedSeed = typeof body.seed === "number" ? body.seed : 42;

    const deductResult = await deductCredit(userId, CREDITS_3D, true);
    if (!deductResult.ok) {
      trackKeyUsage(req, "/v1/3d/image-to-3d", 402, 0, {
        error: deductResult.error,
      });
      res.status(402).json({
        error: {
          message: deductResult.error,
          type: "insufficient_credits",
          code: "credit_balance_exhausted",
        },
      });
      return;
    }

    try {
      const inputBufferData = await (async (): Promise<InputImage> => {
        if (file) {
          return {
            buffer: file.buffer,
            contentType: file.mimetype || "image/png",
            filename: file.originalname || "image.png",
          };
        }
        const imageUrl = typeof body.image_url === "string" ? body.image_url.trim() : "";
        if (imageUrl) {
          return await fetchImageBufferFromUrl(imageUrl);
        }
        throw new Error("Either an 'image' file upload or 'image_url' is required.");
      })();

      // Upload source image to S3 for durability
      const sourceImageKey = `uploads/developer_${randomUUID()}_${inputBufferData.filename}`;
      const savedImageUrl = await uploadBufferToS3(
        inputBufferData.buffer,
        sourceImageKey,
        inputBufferData.contentType
      );

      // Submit to BlueFox3D GPU
      const gpuResult = await submitImageTo3dGpu({
        imageBuffer: inputBufferData.buffer,
        contentType: inputBufferData.contentType,
        filename: inputBufferData.filename,
        resolution: requestedResolution,
        seed: requestedSeed,
        userId,
      });

      const jobId = gpuResult.jobId;

      await createJob({
        id: jobId,
        userId,
        imageUrl: savedImageUrl,
        sourceImages: [savedImageUrl],
        generateType: "ImageTo3D",
        status: "WAIT",
        creditsUsed: CREDITS_3D,
        source: "api",
      });

      trackKeyUsage(req, "/v1/3d/image-to-3d", 200, CREDITS_3D, {
        taskId: jobId,
        model: "bluefox-1",
        resolution: requestedResolution,
      });

      res.status(200).json({
        id: jobId,
        object: "task",
        type: "image-to-3d",
        model: "bluefox-1",
        status: "PENDING",
        resolution: requestedResolution,
        jobs_ahead: gpuResult.jobsAhead ?? 0,
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
    } catch (err: unknown) {
      await refundCredit(userId, CREDITS_3D);
      const message = err instanceof Error ? err.message : "Failed to initiate 3D reconstruction";
      logger.error({ err, userId }, "Developer image-to-3d failed");
      trackKeyUsage(req, "/v1/3d/image-to-3d", 500, 0, {
        error: message,
      });
      res.status(500).json({
        error: {
          message,
          type: "api_error",
          code: "generation_failed",
        },
      });
    }
  }
);

// ============================================================================
// 2. POST /v1/3d/text-to-3d: Prompt -> Concept Image -> 3D Reconstruction
// ============================================================================
developerV1Router.post(
  "/3d/text-to-3d",
  requireDeveloperAuth,
  async (req: Request, res: Response) => {
    const userId = req.developerUserId!;
    const body = (req.body || {}) as Record<string, unknown>;

    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      trackKeyUsage(req, "/v1/3d/text-to-3d", 400, 0, {
        error: "parameter_missing",
      });
      res.status(400).json({
        error: {
          message: "Prompt is required for text-to-3d generation.",
          type: "invalid_request_error",
          code: "parameter_missing",
        },
      });
      return;
    }

    const imageModelOpts = (typeof body.image_model === "object" && body.image_model !== null
      ? (body.image_model as Record<string, unknown>)
      : {}) as Record<string, unknown>;

    const provider: ImageProvider = parseImageProvider(imageModelOpts.provider || body.provider) || "openai";
    const quality: ImageQuality = parseImageQuality(imageModelOpts.quality || body.quality) || "high";
    const aspect: ImageAspect = parseImageAspect(imageModelOpts.aspect || body.aspect) || "1:1";
    const requestedResolution = Number(body.resolution) === 1536 ? 1024 : (Number(body.resolution) || 1024);
    const requestedSeed = typeof body.seed === "number" ? body.seed : 42;

    const imageCredits = IMAGE_CREDITS["text-to-image"][quality];
    const totalCredits = CREDITS_3D + imageCredits;

    const deductResult = await deductCredit(userId, totalCredits, true);
    if (!deductResult.ok) {
      trackKeyUsage(req, "/v1/3d/text-to-3d", 402, 0, {
        error: deductResult.error,
      });
      res.status(402).json({
        error: {
          message: deductResult.error,
          type: "insufficient_credits",
          code: "credit_balance_exhausted",
        },
      });
      return;
    }

    const usageCalls: UsageCall[] = [];
    try {
      // Step A: Generate concept reference image
      const generatedImage = await runWithUsage(usageCalls, async () => {
        return await generateImage({
          provider,
          quality,
          aspect,
          prompt,
        });
      });

      saveApiImageUsage(
        {
          userId,
          jobId: null,
          operation: "text-to-image",
          provider,
          model: generatedImage.model,
          quality,
          status: "succeeded",
          errorCode: null,
          creditsCharged: imageCredits,
          source: "api",
        },
        usageCalls
      );

      const previewKey = `preview/dev_${randomUUID()}.png`;
      const previewUrl = await uploadBufferToS3(
        generatedImage.bytes,
        previewKey,
        generatedImage.mime
      );

      // Step B: Submit concept image to BlueFox3D GPU
      const gpuResult = await submitImageTo3dGpu({
        imageBuffer: generatedImage.bytes,
        contentType: generatedImage.mime,
        filename: "concept.png",
        resolution: requestedResolution,
        seed: requestedSeed,
        userId,
      });

      const jobId = gpuResult.jobId;

      await createJob({
        id: jobId,
        userId,
        prompt,
        imageUrl: previewUrl,
        previewImageUrl: previewUrl,
        sourceImages: [previewUrl],
        generateType: "TextTo3D",
        status: "WAIT",
        creditsUsed: totalCredits,
        llmProvider: provider,
        llmModel: generatedImage.model,
        source: "api",
      });

      trackKeyUsage(req, "/v1/3d/text-to-3d", 200, totalCredits, {
        taskId: jobId,
        model: "bluefox-1",
        resolution: requestedResolution,
        prompt: prompt.slice(0, 100),
        imageModel: generatedImage.model,
      });

      res.status(200).json({
        id: jobId,
        object: "task",
        type: "text-to-3d",
        model: "bluefox-1",
        status: "PENDING",
        resolution: requestedResolution,
        reference_image_url: previewUrl,
        reference_image_model: generatedImage.model,
        jobs_ahead: gpuResult.jobsAhead ?? 0,
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
    } catch (err: unknown) {
      await refundCredit(userId, totalCredits);
      if (usageCalls.length > 0) {
        saveApiImageUsage(
          {
            userId,
            jobId: null,
            operation: "text-to-image",
            provider,
            model: usageCalls.filter((c) => c.kind === "image").at(-1)?.model ?? null,
            quality,
            status: "failed",
            errorCode: "GENERATION_FAILED",
            creditsCharged: 0,
            source: "api",
          },
          usageCalls
        );
      }
      const message = err instanceof Error ? err.message : "Failed to execute text-to-3d generation";
      logger.error({ err, userId }, "Developer text-to-3d failed");
      trackKeyUsage(req, "/v1/3d/text-to-3d", 500, 0, {
        error: message,
      });
      res.status(500).json({
        error: {
          message,
          type: "api_error",
          code: "generation_failed",
        },
      });
    }
  }
);

// ============================================================================
// 3. GET /v1/3d/tasks/:taskId & /v1/tasks/:taskId: Poll status & retrieve GLB
// ============================================================================
async function handleGetTask(req: Request, res: Response) {
  const userId = req.developerUserId!;
  const taskId = req.params.taskId;

  if (!taskId) {
    res.status(400).json({
      error: {
        message: "Task ID is required.",
        type: "invalid_request_error",
        code: "parameter_missing",
      },
    });
    return;
  }

  const job = await getJob(taskId);
  if (!job) {
    res.status(404).json({
      error: {
        message: `Task '${taskId}' not found.`,
        type: "invalid_request_error",
        code: "task_not_found",
      },
    });
    return;
  }

  if (job.userId && job.userId !== userId) {
    res.status(403).json({
      error: {
        message: "You do not have access to this task.",
        type: "permission_error",
        code: "task_forbidden",
      },
    });
    return;
  }

  // 20-minute timeout check:
  // If task has been running/waiting for >= 20 minutes, expire it and refund automatically.
  const ageMs = Date.now() - new Date(job.createdAt).getTime();
  const isTimedOut = (job.status === "WAIT" || job.status === "RUN") && ageMs >= 20 * 60 * 1000;
  if (isTimedOut) {
    const refundAmount = job.creditsUsed > 0 ? job.creditsUsed : CREDITS_3D;
    const timeoutMsg = "Generation timed out. Credits have been automatically refunded.";
    await updateJobStatus(taskId, {
      status: "FAIL",
      errorCode: "GENERATION_TIMEOUT",
      errorMessage: timeoutMsg,
      creditsUsed: 0,
    });
    if (refundAmount > 0) {
      await refundCredit(userId, refundAmount);
    }
    job.status = "FAIL";
    job.errorMessage = timeoutMsg;
    job.creditsUsed = 0;
  }

  // If still in progress, check live GPU status
  const mappedStatus = mapJobStatus(job.status);
  const liveProgress = await (async (): Promise<{ progress: number; message?: string }> => {
    if (mappedStatus === "SUCCEEDED") {
      return { progress: 100 };
    }
    if (mappedStatus === "FAILED" || mappedStatus === "CANCELLED") {
      return { progress: 0 };
    }
    const gpuStatus = await fetchGpuJobStatus(taskId);
    if (gpuStatus && typeof gpuStatus.progress === "number") {
      return {
        progress: Math.min(Math.max(gpuStatus.progress, 0), 99),
        message: typeof gpuStatus.message === "string" ? gpuStatus.message : undefined,
      };
    }
    return { progress: mappedStatus === "IN_PROGRESS" ? 50 : 10 };
  })();

  const resultPayload = mappedStatus === "SUCCEEDED"
    ? {
        mesh_url: normalizeGlbUrl(job.id, job.resultGlbUrl),
        preview_image_url: job.previewImageUrl || job.imageUrl,
        format: "glb",
        model: "bluefox-1",
      }
    : null;

  trackKeyUsage(req, "/v1/3d/tasks", 200, 0, {
    taskId: job.id,
    status: mappedStatus,
  });

  res.status(200).json({
    id: job.id,
    object: "task",
    type: job.generateType === "TextTo3D" ? "text-to-3d" : "image-to-3d",
    status: mappedStatus,
    progress: liveProgress.progress,
    status_message: liveProgress.message || null,
    model: "bluefox-1",
    result: resultPayload,
    error: mappedStatus === "FAILED" ? job.errorMessage || "Generation failed" : null,
    created_at: parseTimestamp(job.createdAt?.toISOString()),
    updated_at: parseTimestamp(job.updatedAt?.toISOString()),
  });
}

developerV1Router.get("/3d/tasks/:taskId", requireDeveloperAuth, handleGetTask);
developerV1Router.get("/tasks/:taskId", requireDeveloperAuth, handleGetTask);

// ============================================================================
// 4. DELETE /v1/3d/tasks/:taskId & /v1/tasks/:taskId: Cancel task
// ============================================================================
async function handleCancelTask(req: Request, res: Response) {
  const userId = req.developerUserId!;
  const taskId = req.params.taskId;

  const job = await getJob(taskId);
  if (!job) {
    res.status(404).json({
      error: {
        message: `Task '${taskId}' not found.`,
        type: "invalid_request_error",
        code: "task_not_found",
      },
    });
    return;
  }

  if (job.userId && job.userId !== userId) {
    res.status(403).json({
      error: {
        message: "You do not have access to this task.",
        type: "permission_error",
        code: "task_forbidden",
      },
    });
    return;
  }

  const wasInFlight = job.status === "WAIT" || job.status === "RUN" || !job.status;
  const refundAmount = wasInFlight && job.creditsUsed > 0 ? job.creditsUsed : 0;

  await cancelGpuJob(taskId);
  await updateJobStatus(taskId, {
    status: "FAIL",
    errorCode: "CANCELLED",
    errorMessage: "Job cancelled by user. Credits have been automatically refunded.",
    creditsUsed: refundAmount > 0 ? 0 : undefined,
  });

  if (refundAmount > 0) {
    await refundCredit(userId, refundAmount);
  }

  trackKeyUsage(req, "/v1/3d/tasks", 200, 0, {
    taskId,
    action: "cancel",
  });

  res.status(200).json({
    id: taskId,
    object: "task",
    status: "CANCELLED",
  });
}

developerV1Router.delete("/3d/tasks/:taskId", requireDeveloperAuth, handleCancelTask);
developerV1Router.delete("/tasks/:taskId", requireDeveloperAuth, handleCancelTask);

// ============================================================================
// 5. POST /v1/images/generate: Concept Art / Turnarounds (OpenAI / Gemini)
// ============================================================================
developerV1Router.post(
  "/images/generate",
  requireDeveloperAuth,
  async (req: Request, res: Response) => {
    const userId = req.developerUserId!;
    const body = (req.body || {}) as Record<string, unknown>;

    const promptValidation = validateImagePrompt(body.prompt);
    if (!promptValidation.ok) {
      trackKeyUsage(req, "/v1/images/generate", 400, 0, {
        error: promptValidation.error,
      });
      res.status(400).json({
        error: {
          message: promptValidation.error,
          type: "invalid_request_error",
          code: promptValidation.code.toLowerCase(),
        },
      });
      return;
    }
    const prompt = promptValidation.prompt;

    const provider: ImageProvider = parseImageProvider(body.model || body.provider) || "openai";
    const quality: ImageQuality = parseImageQuality(body.quality) || "low";
    const aspect: ImageAspect = parseImageAspect(body.aspect) || "1:1";

    const credits = IMAGE_CREDITS["text-to-image"][quality];

    const executeGeneration = async () => {
      const deductResult = await deductCredit(userId, credits, true);
      if (!deductResult.ok) {
        return {
          status: 402,
          payload: {
            error: {
              message: deductResult.error,
              type: "insufficient_credits",
              code: "credit_balance_exhausted",
            },
          },
        };
      }

      const usageCalls: UsageCall[] = [];
      try {
        const generated = await runWithUsage(usageCalls, async () => {
          return await generateImage({
            provider,
            quality,
            aspect,
            prompt,
          });
        });

        const imageId = `img_${randomUUID()}`;
        const s3Key = `preview/${imageId}.png`;
        const imageUrl = await uploadBufferToS3(generated.bytes, s3Key, generated.mime);

        saveApiImageUsage(
          {
            userId,
            jobId: null,
            operation: "text-to-image",
            provider,
            model: generated.model,
            quality,
            status: "succeeded",
            errorCode: null,
            creditsCharged: credits,
            source: "api",
          },
          usageCalls
        );

        return {
          status: 200,
          payload: {
            id: imageId,
            object: "image",
            provider,
            model: generated.model,
            image_url: imageUrl,
            quality,
            aspect,
            credits_used: credits,
            created_at: Math.floor(Date.now() / 1000),
          },
        };
      } catch (err: unknown) {
        await refundCredit(userId, credits);
        if (usageCalls.length > 0) {
          saveApiImageUsage(
            {
              userId,
              jobId: null,
              operation: "text-to-image",
              provider,
              model: usageCalls.filter((c) => c.kind === "image").at(-1)?.model ?? null,
              quality,
              status: "failed",
              errorCode: "GENERATION_FAILED",
              creditsCharged: 0,
              source: "api",
            },
            usageCalls
          );
        }
        const message = err instanceof Error ? err.message : "Failed to generate image";
        logger.error({ err, userId }, "Developer image generation failed");
        return {
          status: 500,
          payload: {
            error: {
              message,
              type: "api_error",
              code: "generation_failed",
            },
          },
        };
      }
    };

    const outcome = await runDeduplicatedImageJob(
      userId,
      "text-to-image",
      prompt,
      provider,
      quality,
      aspect,
      executeGeneration
    );

    const statusCode = outcome.result.status;
    const creditsDeducted = statusCode === 200 ? credits : 0;
    trackKeyUsage(req, "/v1/images/generate", statusCode, creditsDeducted, {
      provider,
      quality,
      aspect,
      prompt: prompt.slice(0, 100),
    });

    res.status(outcome.result.status).json(outcome.result.payload);
  }
);

// ============================================================================
// 6. POST /v1/images/edit: Edit image with prompt (OpenAI / Gemini)
// ============================================================================
developerV1Router.post(
  "/images/edit",
  requireDeveloperAuth,
  upload.single("image"),
  async (req: Request, res: Response) => {
    const userId = req.developerUserId!;
    const body = (req.body || {}) as Record<string, unknown>;
    const file = req.file;

    const promptValidation = validateImagePrompt(body.prompt);
    if (!promptValidation.ok) {
      trackKeyUsage(req, "/v1/images/edit", 400, 0, {
        error: promptValidation.error,
      });
      res.status(400).json({
        error: {
          message: promptValidation.error,
          type: "invalid_request_error",
          code: promptValidation.code.toLowerCase(),
        },
      });
      return;
    }
    const prompt = promptValidation.prompt;

    const provider: ImageProvider = parseImageProvider(body.model || body.provider) || "openai";
    const quality: ImageQuality = parseImageQuality(body.quality) || "low";

    const credits = IMAGE_CREDITS["edit"][quality];
    const deductResult = await deductCredit(userId, credits, true);
    if (!deductResult.ok) {
      trackKeyUsage(req, "/v1/images/edit", 402, 0, {
        error: deductResult.error,
      });
      res.status(402).json({
        error: {
          message: deductResult.error,
          type: "insufficient_credits",
          code: "credit_balance_exhausted",
        },
      });
      return;
    }

    const usageCalls: UsageCall[] = [];
    try {
      const inputBufferData = await (async (): Promise<InputImage> => {
        if (file) {
          return {
            buffer: file.buffer,
            contentType: file.mimetype || "image/png",
            filename: file.originalname || "image.png",
          };
        }
        const imageUrl = typeof body.image_url === "string" ? body.image_url.trim() : "";
        if (imageUrl) {
          return await fetchImageBufferFromUrl(imageUrl);
        }
        throw new Error("Either an 'image' file upload or 'image_url' is required.");
      })();

      const edited = await runWithUsage(usageCalls, async () => {
        return await generateImage({
          provider,
          quality,
          aspect: "1:1",
          prompt,
          inputImage: inputBufferData,
        });
      });

      const imageId = `edit_${randomUUID()}`;
      const s3Key = `edit/${imageId}.png`;
      const imageUrl = await uploadBufferToS3(edited.bytes, s3Key, edited.mime);

      saveApiImageUsage(
        {
          userId,
          jobId: null,
          operation: "edit",
          provider,
          model: edited.model,
          quality,
          status: "succeeded",
          errorCode: null,
          creditsCharged: credits,
          source: "api",
        },
        usageCalls
      );

      trackKeyUsage(req, "/v1/images/edit", 200, credits, {
        imageId,
        model: edited.model,
        provider,
        quality,
        prompt: prompt.slice(0, 100),
      });

      res.status(200).json({
        id: imageId,
        object: "image",
        provider,
        model: edited.model,
        image_url: imageUrl,
        quality,
        credits_used: credits,
        created_at: Math.floor(Date.now() / 1000),
      });
    } catch (err: unknown) {
      await refundCredit(userId, credits);
      if (usageCalls.length > 0) {
        saveApiImageUsage(
          {
            userId,
            jobId: null,
            operation: "edit",
            provider,
            model: usageCalls.filter((c) => c.kind === "image").at(-1)?.model ?? null,
            quality,
            status: "failed",
            errorCode: "EDIT_FAILED",
            creditsCharged: 0,
            source: "api",
          },
          usageCalls
        );
      }
      const message = err instanceof Error ? err.message : "Failed to edit image";
      logger.error({ err, userId }, "Developer image edit failed");
      trackKeyUsage(req, "/v1/images/edit", 500, 0, {
        error: message,
      });
      res.status(500).json({
        error: {
          message,
          type: "api_error",
          code: "edit_failed",
        },
      });
    }
  }
);

// ============================================================================
// 7. GET /v1/models: List available 3D and 2D models
// ============================================================================
developerV1Router.get("/models", requireDeveloperAuth, async (req: Request, res: Response) => {
  trackKeyUsage(req, "/v1/models", 200, 0);
  res.status(200).json({
    object: "list",
    data: [
      {
        id: "bluefox-1",
        object: "model",
        type: "3d",
        name: "BlueFox 3D (Cascade 1536)",
        description:
          "High-resolution textured 3D mesh reconstruction from single image or text with 4096 PBR maps and clean silhouettes.",
        resolutions: [1024, 1536],
        output_formats: ["glb"],
        credit_cost: CREDITS_3D,
      },
      {
        id: "openai-image-high",
        object: "model",
        type: "image",
        provider: "openai",
        quality: "high",
        name: "OpenAI Image (High Fidelity)",
        description: "2048x2048 high-resolution 2D concept generation using gpt-image-2.5-flare (high quality).",
        credit_cost: IMAGE_CREDITS["text-to-image"]["high"],
      },
      {
        id: "openai-image-low",
        object: "model",
        type: "image",
        provider: "openai",
        quality: "low",
        name: "OpenAI Image (Fast)",
        description: "1024x1024 rapid draft 2D generation using gpt-image-2.5-flare.",
        credit_cost: IMAGE_CREDITS["text-to-image"]["low"],
      },
      {
        id: "gemini-image-high",
        object: "model",
        type: "image",
        provider: "gemini",
        quality: "high",
        name: "Gemini Image (2K Cinematic)",
        description: "2K resolution concept generation using Google gemini-3.1-flash-image.",
        credit_cost: IMAGE_CREDITS["text-to-image"]["high"],
      },
      {
        id: "gemini-image-low",
        object: "model",
        type: "image",
        provider: "gemini",
        quality: "low",
        name: "Gemini Image (1K Fast)",
        description: "1K resolution draft generation using Google gemini-3.1-flash-image.",
        credit_cost: IMAGE_CREDITS["text-to-image"]["low"],
      },
    ],
  });
});

// ============================================================================
// 8. GET /v1/user/me: Developer profile and credit balance
// ============================================================================
developerV1Router.get("/user/me", requireDeveloperAuth, async (req: Request, res: Response) => {
  const userId = req.developerUserId!;
  const creditsRow = await getCreditsRow(userId);

  const total = creditsRow?.credits_total ?? 0;
  const used = creditsRow?.credits_used ?? 0;
  const remaining = Math.max(0, total - used);

  trackKeyUsage(req, "/v1/user/me", 200, 0);

  res.status(200).json({
    object: "user",
    id: userId,
    plan: creditsRow?.plan || "free",
    credits: {
      total,
      used,
      remaining,
    },
    active_key: {
      id: req.developerKeyId || null,
      name: req.developerKeyName || null,
    },
  });
});
