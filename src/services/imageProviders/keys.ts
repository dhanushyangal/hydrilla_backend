import { envImageKey, getDecryptedImagePlatformApiKey } from "../../repository/imagePlatformApiKeys.js";
import { logger } from "../../logger.js";
import type { ImageProvider } from "./config.js";

const CACHE_TTL_MS = 60_000;
const cache = new Map<ImageProvider, { key: string | null; at: number }>();

function legacyEnvKey(provider: ImageProvider): string | null {
  const names =
    provider === "openai" ? ["OPENAI_API_KEY"] : ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
  for (const name of names) {
    const v = process.env[name]?.trim();
    if (v) {
      return v;
    }
  }
  return null;
}

/**
 * Resolves the API key specifically for image generation (OpenAI / Gemini).
 * Order:
 * 1. Dedicated image env vars (IMAGE_OPENAI_API_KEY / IMAGE_GEMINI_API_KEY)
 * 2. Dedicated image platform keys table in DB (image_platform_api_keys)
 * 3. Legacy env fallback (OPENAI_API_KEY / GEMINI_API_KEY) if dedicated ones are not provided
 *
 * Distinct from Water / Code Sculpt LLM keys!
 */
export async function resolveImageApiKey(provider: ImageProvider): Promise<string | null> {
  const dedicatedEnv = envImageKey(provider);
  if (dedicatedEnv) {
    return dedicatedEnv;
  }

  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.key;
  }

  const dbKey = await getDecryptedImagePlatformApiKey(provider).catch((err) => {
    logger.warn({ err: err?.message, provider }, "Image platform API key lookup failed");
    return null;
  });

  const finalKey = dbKey || legacyEnvKey(provider);
  cache.set(provider, { key: finalKey, at: Date.now() });
  return finalKey;
}

export async function imageProviderAvailability(): Promise<Record<ImageProvider, boolean>> {
  const [openai, gemini] = await Promise.all([
    resolveImageApiKey("openai"),
    resolveImageApiKey("gemini"),
  ]);
  return { openai: Boolean(openai), gemini: Boolean(gemini) };
}
