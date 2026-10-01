export type ImageProvider = "openai" | "gemini";
export type ImageQuality = "low" | "high";
export type ImageAspect = "1:1" | "3:2" | "2:3";
export type ImageOperation = "text-to-image" | "edit";

export const IMAGE_PROVIDERS: readonly ImageProvider[] = ["openai", "gemini"];
export const IMAGE_QUALITIES: readonly ImageQuality[] = ["low", "high"];
export const IMAGE_ASPECTS: readonly ImageAspect[] = ["1:1", "3:2", "2:3"];

export const DEFAULT_IMAGE_PROVIDER: ImageProvider = "openai";
export const DEFAULT_IMAGE_QUALITY: ImageQuality = "low";
export const DEFAULT_IMAGE_ASPECT: ImageAspect = "1:1";

export const IMAGE_CREDITS: Record<ImageOperation, Record<ImageQuality, number>> = {
  "text-to-image": { low: 2, high: 5 },
  edit: { low: 3, high: 6 },
};

function envModel(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function openAIImageModel(quality: ImageQuality): string {
  return quality === "high"
    ? envModel("OPENAI_IMAGE_MODEL_HIGH", "gpt-image-2.5-sunburst")
    : envModel("OPENAI_IMAGE_MODEL_LOW", "gpt-image-2.5-flare");
}

export function geminiImageModel(quality: ImageQuality): string {
  return quality === "high"
    ? envModel("GEMINI_IMAGE_MODEL_HIGH", "gemini-3-pro-image")
    : envModel("GEMINI_IMAGE_MODEL_LOW", "gemini-3.1-flash-image");
}

/** OpenAI `quality` per tier (gpt-image-2.5 accepts low|medium|high|xhigh|max|auto). */
export const OPENAI_QUALITY: Record<ImageQuality, string> = { low: "medium", high: "high" };

/** OpenAI sizes must be multiples of 16, ratio within 1:3..3:1, 655,360..8,294,400 px, edge <= 3840. */
export const OPENAI_SIZES: Record<ImageQuality, Record<ImageAspect, string>> = {
  low: { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" },
  high: { "1:1": "2048x2048", "3:2": "2304x1536", "2:3": "1536x2304" },
};

/** Gemini `image_size` must use an uppercase K. */
export const GEMINI_IMAGE_SIZE: Record<ImageQuality, string> = { low: "1K", high: "2K" };

export const MIN_IMAGE_PROMPT_LENGTH = 2;
export const MAX_IMAGE_PROMPT_LENGTH = 4000;

export type PromptValidationErrorCode = "PROMPT_REQUIRED" | "PROMPT_TOO_SHORT" | "PROMPT_TOO_LONG";

export type PromptValidationResult =
  | { ok: true; prompt: string }
  | { ok: false; error: string; code: PromptValidationErrorCode };

export function validateImagePrompt(raw: unknown): PromptValidationResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "Prompt is required.", code: "PROMPT_REQUIRED" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Prompt is required.", code: "PROMPT_REQUIRED" };
  }
  if (trimmed.length < MIN_IMAGE_PROMPT_LENGTH) {
    return {
      ok: false,
      error: `Prompt is too short. Please provide at least ${MIN_IMAGE_PROMPT_LENGTH} characters.`,
      code: "PROMPT_TOO_SHORT",
    };
  }
  if (raw.length > MAX_IMAGE_PROMPT_LENGTH) {
    return {
      ok: false,
      error: `Prompt exceeds maximum supported length of ${MAX_IMAGE_PROMPT_LENGTH} characters.`,
      code: "PROMPT_TOO_LONG",
    };
  }
  return { ok: true, prompt: trimmed };
}

export function parseImageProvider(v: unknown): ImageProvider | null {
  if (v == null || v === "") {
    return DEFAULT_IMAGE_PROVIDER;
  }
  const s = String(v).trim().toLowerCase();
  if (s === "google") {
    return "gemini";
  }
  return (IMAGE_PROVIDERS as readonly string[]).includes(s) ? (s as ImageProvider) : null;
}

export function parseImageQuality(v: unknown): ImageQuality | null {
  if (v == null || v === "") {
    return DEFAULT_IMAGE_QUALITY;
  }
  const s = String(v).trim().toLowerCase();
  return (IMAGE_QUALITIES as readonly string[]).includes(s) ? (s as ImageQuality) : null;
}

export function parseImageAspect(v: unknown): ImageAspect | null {
  if (v == null || v === "") {
    return DEFAULT_IMAGE_ASPECT;
  }
  const s = String(v).trim();
  return (IMAGE_ASPECTS as readonly string[]).includes(s) ? (s as ImageAspect) : null;
}
