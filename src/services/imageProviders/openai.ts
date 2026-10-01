import {
  OPENAI_QUALITY,
  OPENAI_SIZES,
  openAIImageModel,
  type ImageAspect,
  type ImageQuality,
} from "./config.js";
import { ImageProviderError } from "./errors.js";
import type { GeneratedImage, InputImage } from "./types.js";
import { openAIImageUsage, recordUsage } from "./usage.js";

const OPENAI_BASE = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");

/** OpenAI's "auto" filter rejects many harmless game-asset prompts (weapons, monsters, armor); "low" is less strict. */
export function openAIModeration(): "low" | "auto" {
  return process.env.OPENAI_IMAGE_MODERATION?.trim().toLowerCase() === "auto" ? "auto" : "low";
}

export function buildOpenAIGenerateBody(prompt: string, quality: ImageQuality, aspect: ImageAspect) {
  return {
    model: openAIImageModel(quality),
    prompt,
    quality: OPENAI_QUALITY[quality],
    size: OPENAI_SIZES[quality][aspect],
    output_format: "png",
    moderation: openAIModeration(),
    n: 1,
  };
}

/** Edits keep the input aspect, so size is "auto". */
export function buildOpenAIEditFields(prompt: string, quality: ImageQuality): Record<string, string> {
  return {
    model: openAIImageModel(quality),
    prompt,
    quality: OPENAI_QUALITY[quality],
    size: "auto",
    output_format: "png",
    moderation: openAIModeration(),
    n: "1",
  };
}

async function toProviderError(res: Response): Promise<ImageProviderError> {
  const text = await res.text().catch(() => "");
  const body = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const err = body?.error ?? {};
  const code = String(err.code || err.type || `http_${res.status}`);
  const rawMessage = String(err.message || text || `OpenAI returned ${res.status}`);

  const isBlocked =
    code === "moderation_blocked" ||
    /moderation|safety|policy|prohibited|content_filter|inappropriate/i.test(rawMessage) ||
    /moderation|safety|policy/i.test(code);

  if (isBlocked) {
    const details = body?.moderation_details ?? err.moderation_details ?? {};
    const stage = String(details.moderation_stage || "");
    const categories: string[] = Array.isArray(details.categories) ? details.categories.map(String) : [];
    return new ImageProviderError(
      "This image request couldn't be generated. Try changing the prompt.",
      422,
      "IMAGE_REQUEST_BLOCKED",
      JSON.stringify({ stage: stage || null, categories, raw_code: code, raw_message: rawMessage })
    );
  }

  const isPromptTooLong =
    /too long|exceed.*length|maximum.*characters|max_length/i.test(rawMessage) ||
    code === "prompt_too_long";

  if (isPromptTooLong) {
    return new ImageProviderError(
      "Prompt exceeds maximum supported length for image generation.",
      400,
      "PROMPT_TOO_LONG",
      rawMessage
    );
  }

  if (err.type === "image_generation_user_error" || res.status === 400) {
    return new ImageProviderError(
      "This image request couldn't be generated. Try changing the prompt.",
      422,
      "IMAGE_REQUEST_BLOCKED",
      rawMessage
    );
  }

  if (res.status === 401 || res.status === 403) {
    return new ImageProviderError(
      "Image generation service is temporarily unavailable.",
      502,
      "IMAGE_SERVICE_UNAVAILABLE",
      rawMessage
    );
  }

  if (res.status === 429) {
    return new ImageProviderError(
      "Image generation is busy right now. Try again shortly.",
      503,
      "IMAGE_RATE_LIMITED",
      code
    );
  }

  return new ImageProviderError(
    "Failed to generate image. Please try again.",
    502,
    "IMAGE_GENERATION_FAILED",
    rawMessage
  );
}

function readImage(body: any, model: string): GeneratedImage {
  const b64 = body?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) {
    throw new ImageProviderError(
      "This image request couldn't be generated. Try changing the prompt.",
      422,
      "IMAGE_REQUEST_BLOCKED",
      "OpenAI returned no image data"
    );
  }
  const format = String(body?.output_format || "png").toLowerCase();
  const mime = format === "jpeg" || format === "jpg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  return { bytes: Buffer.from(b64, "base64"), mime, model };
}

export async function openAIGenerate(
  apiKey: string,
  prompt: string,
  quality: ImageQuality,
  aspect: ImageAspect,
  signal: AbortSignal
): Promise<GeneratedImage> {
  const body = buildOpenAIGenerateBody(prompt, quality, aspect);
  const res = await fetch(`${OPENAI_BASE}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw await toProviderError(res);
  }
  const json = await res.json();
  recordUsage("image", "openai", body.model, openAIImageUsage(json?.usage));
  return readImage(json, body.model);
}

export async function openAIEdit(
  apiKey: string,
  prompt: string,
  quality: ImageQuality,
  image: InputImage,
  signal: AbortSignal
): Promise<GeneratedImage> {
  const fields = buildOpenAIEditFields(prompt, quality);
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v);
  }
  form.append("image", new Blob([new Uint8Array(image.buffer)], { type: image.contentType }), image.filename);

  const res = await fetch(`${OPENAI_BASE}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  });
  if (!res.ok) {
    throw await toProviderError(res);
  }
  const json = await res.json();
  recordUsage("image", "openai", fields.model, openAIImageUsage(json?.usage));
  return readImage(json, fields.model);
}
