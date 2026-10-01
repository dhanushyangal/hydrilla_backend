import { logger } from "../../logger.js";
import type { ImageAspect, ImageProvider, ImageQuality } from "./config.js";
import { ImageProviderError } from "./errors.js";
import { geminiGenerate } from "./gemini.js";
import { resolveImageApiKey } from "./keys.js";
import { openAIEdit, openAIGenerate } from "./openai.js";
import { adaptRestrictedElement, optimizePromptFor3D } from "./rewriter.js";
import type { GeneratedImage, InputImage } from "./types.js";

export * from "./config.js";
export { ImageProviderError, isImageProviderError } from "./errors.js";
export { runDeduplicatedImageJob, clearInFlightImageJobsForTesting } from "./inFlight.js";
export { imageProviderAvailability, resolveImageApiKey } from "./keys.js";
export { adaptRestrictedElement, optimizePromptFor3D } from "./rewriter.js";
export type { GeneratedImage, InputImage } from "./types.js";
export { runWithUsage, summarizeUsage, type UsageCall, type UsageSummary } from "./usage.js";

const PROVIDER_TIMEOUT_MS = 180_000;

const PROVIDER_LABEL: Record<ImageProvider, string> = { openai: "OpenAI", gemini: "Gemini" };

function isModerationBlocked(err: unknown): boolean {
  if (!(err instanceof ImageProviderError)) {
    return false;
  }
  if (err.status === 422 && err.code === "IMAGE_REQUEST_BLOCKED") {
    return true;
  }
  if (err.code === "moderation_blocked") {
    return true;
  }
  return false;
}

async function dispatchProviderCall(
  apiKey: string,
  opts: {
    provider: ImageProvider;
    quality: ImageQuality;
    aspect: ImageAspect;
    prompt: string;
    inputImage?: InputImage | null;
  },
  signal: AbortSignal
): Promise<GeneratedImage> {
  if (opts.provider === "openai") {
    if (opts.inputImage) {
      return await openAIEdit(apiKey, opts.prompt, opts.quality, opts.inputImage, signal);
    }
    return await openAIGenerate(apiKey, opts.prompt, opts.quality, opts.aspect, signal);
  }
  return await geminiGenerate(
    apiKey,
    opts.prompt,
    opts.quality,
    opts.inputImage ? null : opts.aspect,
    opts.inputImage ?? null,
    signal
  );
}

async function executeWithRemediation(
  apiKey: string,
  opts: {
    provider: ImageProvider;
    quality: ImageQuality;
    aspect: ImageAspect;
    prompt: string;
    inputImage?: InputImage | null;
  },
  signal: AbortSignal
): Promise<GeneratedImage> {
  const initialPrompt = opts.inputImage
    ? opts.prompt
    : await optimizePromptFor3D(opts.prompt, opts.provider);

  try {
    return await dispatchProviderCall(apiKey, { ...opts, prompt: initialPrompt }, signal);
  } catch (err: unknown) {
    if (!isModerationBlocked(err)) {
      throw err;
    }

    const detail = err instanceof ImageProviderError ? err.detail : undefined;
    logger.info(
      {
        provider: opts.provider,
        originalPrompt: opts.prompt.slice(0, 100),
        detail,
      },
      "Image request blocked by safety filter; attempting restricted-element adaptation"
    );

    const safePrompt = await adaptRestrictedElement(opts.prompt, detail, opts.provider);

    return await dispatchProviderCall(apiKey, { ...opts, prompt: safePrompt }, signal);
  }
}

export async function generateImage(opts: {
  provider: ImageProvider;
  quality: ImageQuality;
  aspect: ImageAspect;
  prompt: string;
  inputImage?: InputImage | null;
}): Promise<GeneratedImage> {
  const apiKey = await resolveImageApiKey(opts.provider);
  if (!apiKey) {
    throw new ImageProviderError(
      `${PROVIDER_LABEL[opts.provider]} image generation is not configured.`,
      503,
      "provider_not_configured"
    );
  }

  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  try {
    return await executeWithRemediation(apiKey, opts, signal);
  } catch (err: unknown) {
    if (err instanceof ImageProviderError) {
      throw err;
    }
    const errObj = err as { name?: string; message?: string } | null;
    if (errObj?.name === "TimeoutError" || errObj?.name === "AbortError") {
      throw new ImageProviderError(
        `${PROVIDER_LABEL[opts.provider]} took too long to generate the image. Try again.`,
        504,
        "provider_timeout"
      );
    }
    throw new ImageProviderError(
      `${PROVIDER_LABEL[opts.provider]} is unreachable: ${errObj?.message || "network error"}`,
      502,
      "provider_unreachable"
    );
  }
}
