import { GEMINI_IMAGE_SIZE, geminiImageModel, type ImageAspect, type ImageQuality } from "./config.js";
import { ImageProviderError } from "./errors.js";
import type { GeneratedImage, InputImage } from "./types.js";
import { geminiInteractionsUsage, geminiUsageMetadata, recordUsage } from "./usage.js";

/**
 * Two backends serve the same Gemini image models:
 * - developer: Gemini API (AI Studio keys), Interactions API
 * - vertex: Vertex AI express mode (API keys bound to a GCP project), generateContent
 * GEMINI_API_BACKEND=developer|vertex forces one; otherwise developer is tried first and
 * keys that Google blocks for it (API_KEY_SERVICE_BLOCKED / SERVICE_DISABLED) fall back to Vertex.
 */
export type GeminiBackend = "developer" | "vertex";

const GEMINI_BASE = (
  process.env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta"
).replace(/\/$/, "");

const VERTEX_BASE = (
  process.env.GEMINI_VERTEX_BASE_URL?.trim() || "https://aiplatform.googleapis.com/v1/publishers/google/models"
).replace(/\/$/, "");

function forcedBackend(): GeminiBackend | null {
  const v = process.env.GEMINI_API_BACKEND?.trim().toLowerCase();
  return v === "vertex" || v === "developer" ? v : null;
}

/** Backend that last worked per key, so fallback costs one extra request per process. */
const backendByKey = new Map<string, GeminiBackend>();

type GeminiInputBlock =
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; data: string };

/** Interactions API body. Edits omit aspect_ratio so the output follows the input image. */
export function buildGeminiBody(
  prompt: string,
  quality: ImageQuality,
  aspect: ImageAspect | null,
  imageOrImages?: { mime_type: string; data: string } | Array<{ mime_type: string; data: string }>
) {
  const input: GeminiInputBlock[] = [];
  const list = Array.isArray(imageOrImages)
    ? imageOrImages
    : imageOrImages
      ? [imageOrImages]
      : [];
  list.forEach((img) => {
    input.push({ type: "image", mime_type: img.mime_type, data: img.data });
  });
  input.push({ type: "text", text: prompt });
  return {
    model: geminiImageModel(quality),
    input,
    response_format: {
      type: "image",
      mime_type: "image/png",
      ...(aspect ? { aspect_ratio: aspect } : {}),
      image_size: GEMINI_IMAGE_SIZE[quality],
    },
  };
}

/** Vertex generateContent body. Edits omit aspectRatio so the output follows the input image. */
export function buildVertexGeminiBody(
  prompt: string,
  quality: ImageQuality,
  aspect: ImageAspect | null,
  imageOrImages?: { mime_type: string; data: string } | Array<{ mime_type: string; data: string }>
) {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  const list = Array.isArray(imageOrImages)
    ? imageOrImages
    : imageOrImages
      ? [imageOrImages]
      : [];
  list.forEach((img) => {
    parts.push({ inlineData: { mimeType: img.mime_type, data: img.data } });
  });
  parts.push({ text: prompt });
  return {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        ...(aspect ? { aspectRatio: aspect } : {}),
        imageSize: GEMINI_IMAGE_SIZE[quality],
        imageOutputOptions: { mimeType: "image/png" },
      },
    },
  };
}

/** Last image block from model_output steps (thought steps may also carry draft images). */
export function extractGeminiImage(body: any): { data: string; mime: string } | null {
  const steps: any[] = Array.isArray(body?.steps) ? body.steps : [];
  for (const step of steps) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) {
      continue;
    }
    for (const block of step.content) {
      if (block?.type === "image" && typeof block.data === "string" && block.data) {
        return { data: block.data, mime: String(block.mime_type || "image/png") };
      }
    }
  }
  if (body?.output_image?.data && typeof body.output_image.data === "string") {
    return { data: body.output_image.data, mime: String(body.output_image.mime_type || "image/png") };
  }
  return null;
}

/** Last non-thought inlineData image across candidates. */
export function extractVertexGeminiImage(body: any): { data: string; mime: string } | null {
  const candidates: any[] = Array.isArray(body?.candidates) ? body.candidates : [];
  for (const candidate of candidates) {
    const parts: any[] = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (part?.thought === true) {
        continue;
      }
      const inline = part?.inlineData;
      if (inline && typeof inline.data === "string" && inline.data) {
        return { data: inline.data, mime: String(inline.mimeType || "image/png") };
      }
    }
  }
  return null;
}

function vertexBlockReason(body: any): string | null {
  const blocked = body?.promptFeedback?.blockReason;
  if (blocked) {
    return String(blocked);
  }
  const finish = body?.candidates?.[0]?.finishReason;
  if (finish && finish !== "STOP" && finish !== "MAX_TOKENS") {
    return String(finish);
  }
  return null;
}

type ParsedGoogleError = { message: string; code: string; reasons: string[] };

function parseGoogleError(res: Response, text: string): ParsedGoogleError {
  const body = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const err = (Array.isArray(body) ? body[0] : body)?.error ?? {};
  const details: any[] = Array.isArray(err.details) ? err.details : [];
  return {
    message: String(err.message || text.slice(0, 300) || `Gemini returned ${res.status}`),
    code: String(err.status || `http_${res.status}`),
    reasons: details.map((d) => String(d?.reason || "")).filter(Boolean),
  };
}

/** Google refuses this key for the backend (not a bad key): try the other backend. */
function isBackendBlocked(status: number, parsed: ParsedGoogleError): boolean {
  if (status !== 403) {
    return false;
  }
  return parsed.reasons.some((r) => r === "API_KEY_SERVICE_BLOCKED" || r === "SERVICE_DISABLED");
}

function toProviderError(status: number, parsed: ParsedGoogleError): ImageProviderError {
  const isPromptTooLong =
    status === 400 &&
    (/too long|exceed.*length|maximum.*characters|max_length/i.test(parsed.message) ||
      parsed.reasons.some((r) => /too_long|exceed/i.test(r)));

  if (isPromptTooLong) {
    return new ImageProviderError(
      "Prompt exceeds maximum supported length for image generation.",
      400,
      "PROMPT_TOO_LONG",
      parsed.message
    );
  }

  const isBlocked =
    status === 400 &&
    (/safety|blocked|prohibited|content|policy/i.test(parsed.message) ||
      parsed.reasons.some((r) => /safety|blocked|prohibited|content|policy/i.test(r)));

  if (isBlocked || status === 400) {
    return new ImageProviderError(
      "This image request couldn't be generated. Try changing the prompt.",
      422,
      "IMAGE_REQUEST_BLOCKED",
      parsed.message
    );
  }
  if (status === 401 || status === 403) {
    return new ImageProviderError(
      "Image generation service is temporarily unavailable.",
      502,
      "IMAGE_SERVICE_UNAVAILABLE",
      parsed.message
    );
  }
  if (status === 404) {
    return new ImageProviderError(
      "The requested image model is not available.",
      502,
      "model_not_found",
      parsed.message
    );
  }
  if (status === 429) {
    return new ImageProviderError(
      "Image generation is busy right now. Try again shortly.",
      503,
      "IMAGE_RATE_LIMITED",
      parsed.code
    );
  }
  return new ImageProviderError(
    "Failed to generate image. Please try again.",
    502,
    "IMAGE_GENERATION_FAILED",
    parsed.message
  );
}

class BackendBlocked extends Error {
  constructor(readonly providerError: ImageProviderError) {
    super(providerError.message);
  }
}

async function callDeveloper(
  apiKey: string,
  prompt: string,
  quality: ImageQuality,
  aspect: ImageAspect | null,
  images: Array<{ mime_type: string; data: string }> | undefined,
  signal: AbortSignal
): Promise<GeneratedImage> {
  const body = buildGeminiBody(prompt, quality, aspect, images);
  const res = await fetch(`${GEMINI_BASE}/interactions`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const parsed = parseGoogleError(res, await res.text().catch(() => ""));
    const err = toProviderError(res.status, parsed);
    if (isBackendBlocked(res.status, parsed)) {
      throw new BackendBlocked(err);
    }
    throw err;
  }
  const json = await res.json();
  recordUsage("image", "gemini", body.model, geminiInteractionsUsage(json));
  const out = extractGeminiImage(json);
  if (!out) {
    throw new ImageProviderError(
      "This image request couldn't be generated. Try changing the prompt.",
      422,
      "IMAGE_REQUEST_BLOCKED",
      "Developer API returned no image; content likely blocked"
    );
  }
  return { bytes: Buffer.from(out.data, "base64"), mime: out.mime, model: body.model };
}

async function callVertex(
  apiKey: string,
  prompt: string,
  quality: ImageQuality,
  aspect: ImageAspect | null,
  images: Array<{ mime_type: string; data: string }> | undefined,
  signal: AbortSignal
): Promise<GeneratedImage> {
  const model = geminiImageModel(quality);
  const body = buildVertexGeminiBody(prompt, quality, aspect, images);
  const res = await fetch(`${VERTEX_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const parsed = parseGoogleError(res, await res.text().catch(() => ""));
    const err = toProviderError(res.status, parsed);
    if (isBackendBlocked(res.status, parsed)) {
      throw new BackendBlocked(err);
    }
    throw err;
  }
  const json = await res.json();
  recordUsage("image", "gemini", model, geminiUsageMetadata(json?.usageMetadata, true));
  const out = extractVertexGeminiImage(json);
  if (!out) {
    const reason = vertexBlockReason(json);
    throw new ImageProviderError(
      "This image request couldn't be generated. Try changing the prompt.",
      422,
      "IMAGE_REQUEST_BLOCKED",
      reason ? `Vertex block: ${reason}` : "Vertex returned no image"
    );
  }
  return { bytes: Buffer.from(out.data, "base64"), mime: out.mime, model };
}

export async function geminiGenerate(
  apiKey: string,
  prompt: string,
  quality: ImageQuality,
  aspect: ImageAspect | null,
  imageOrImages: InputImage | InputImage[] | null,
  signal: AbortSignal
): Promise<GeneratedImage> {
  const imagesList = Array.isArray(imageOrImages)
    ? imageOrImages
    : imageOrImages
      ? [imageOrImages]
      : [];
  const imageBlocks = imagesList.length > 0
    ? imagesList.map((img) => ({
        mime_type: img.contentType,
        data: img.buffer.toString("base64"),
      }))
    : undefined;
  const call = (backend: GeminiBackend) =>
    (backend === "vertex" ? callVertex : callDeveloper)(apiKey, prompt, quality, aspect, imageBlocks, signal);

  const forced = forcedBackend();
  if (forced) {
    try {
      return await call(forced);
    } catch (err) {
      if (err instanceof BackendBlocked) {
        throw err.providerError;
      }
      throw err;
    }
  }

  const first = backendByKey.get(apiKey) ?? "developer";
  try {
    const out = await call(first);
    backendByKey.set(apiKey, first);
    return out;
  } catch (err) {
    if (!(err instanceof BackendBlocked)) {
      throw err;
    }
    const second: GeminiBackend = first === "developer" ? "vertex" : "developer";
    try {
      const out = await call(second);
      backendByKey.set(apiKey, second);
      return out;
    } catch (fallbackErr) {
      if (fallbackErr instanceof BackendBlocked) {
        throw fallbackErr.providerError;
      }
      throw fallbackErr;
    }
  }
}
