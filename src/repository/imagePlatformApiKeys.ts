import { supabase } from "../db.js";
import { decryptApiKey, encryptApiKey, type ApiKeyStatus } from "../lib/userApiKeysCrypto.js";
import { logger } from "../logger.js";
import type { ImageProvider } from "../services/imageProviders/config.js";

export const IMAGE_API_KEY_PROVIDERS: readonly ImageProvider[] = ["openai", "gemini"];

export type ImagePlatformApiKeyMeta = {
  provider: ImageProvider;
  name: string;
  modelsDescription: string;
  docsUrl: string;
  keyPlaceholder: string;
  configured: boolean;
  source: "database" | "env" | "none";
  last4: string | null;
  status: ApiKeyStatus;
  lastError: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
};

const PROVIDER_INFO: Record<
  ImageProvider,
  { name: string; modelsDescription: string; docsUrl: string; keyPlaceholder: string }
> = {
  openai: {
    name: "OpenAI Image",
    modelsDescription: "gpt-image-2.5-flare (1K), gpt-image-2.5-sunburst (2K), gpt-4o-mini (3D rewriter)",
    docsUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-...",
  },
  gemini: {
    name: "Google Gemini Image",
    modelsDescription:
      "gemini-3.1-flash-image (1K), gemini-3-pro-image (2K), gemini-2.5-flash (3D rewriter). AI Studio or Vertex AI Express keys.",
    docsUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AQ... or AIza...",
  },
};

export function envImageKey(provider: ImageProvider): string | null {
  const names =
    provider === "openai"
      ? ["IMAGE_OPENAI_API_KEY"]
      : ["IMAGE_GEMINI_API_KEY", "IMAGE_GOOGLE_API_KEY"];
  for (const name of names) {
    const v = process.env[name]?.trim();
    if (v) {
      return v;
    }
  }
  return null;
}

export function lookLikeImageKey(provider: ImageProvider, value: string): boolean {
  const v = value.trim();
  if (v.length < 20) {
    return false;
  }
  if (provider === "openai") {
    return v.startsWith("sk-") || v.length > 40;
  }
  return v.length >= 20;
}

export async function verifyImageProviderKey(
  provider: ImageProvider,
  apiKey: string
): Promise<{ ok: boolean; error?: string }> {
  const key = apiKey.trim();
  if (!lookLikeImageKey(provider, key)) {
    return { ok: false, error: "API key format looks invalid" };
  }

  if (provider === "openai") {
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        return { ok: false, error: body?.error?.message || `OpenAI returned ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || "Failed to connect to OpenAI" };
    }
  }

  // Gemini: Check AI Studio and Vertex Express in parallel
  const checkAiStudio = async (): Promise<boolean> => {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout(6_000) }
      );
      return res.ok;
    } catch {
      return false;
    }
  };

  const checkVertex = async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(
        "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] }),
          signal: AbortSignal.timeout(7_000),
        }
      );
      if (res.ok) {
        return { ok: true };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return { ok: false, error: body?.error?.message || `Vertex returned ${res.status}` };
    } catch (err: any) {
      return { ok: false, error: err?.message || "Failed to reach Google Vertex" };
    }
  };

  const [devOk, vertexRes] = await Promise.all([checkAiStudio(), checkVertex()]);
  if (devOk || vertexRes.ok) {
    return { ok: true };
  }
  return { ok: false, error: vertexRes.error || "Google rejected the key" };
}

const envVerificationCache = new Map<
  ImageProvider,
  { status: ApiKeyStatus; lastError: string | null; verifiedAt: string | null }
>();

export function setEnvImageKeyVerification(
  provider: ImageProvider,
  status: ApiKeyStatus,
  lastError: string | null = null
): void {
  envVerificationCache.set(provider, {
    status,
    lastError,
    verifiedAt: status === "valid" ? new Date().toISOString() : null,
  });
}

export function clearEnvImageKeyVerification(provider: ImageProvider): void {
  envVerificationCache.delete(provider);
}

export async function listImagePlatformApiKeyMeta(): Promise<ImagePlatformApiKeyMeta[]> {
  const { data, error } = await supabase
    .from("image_platform_api_keys")
    .select("provider, last4, status, last_error, verified_at, updated_at");

  if (error) {
    logger.warn({ err: error.message }, "listImagePlatformApiKeyMeta: reading from env fallback");
  }

  const dbRows = new Map<string, {
    provider: string;
    last4: string | null;
    status: ApiKeyStatus;
    last_error: string | null;
    verified_at: string | null;
    updated_at: string | null;
  }>();
  for (const r of data || []) {
    dbRows.set(r.provider, {
      provider: r.provider,
      last4: r.last4 ?? null,
      status: (r.status as ApiKeyStatus) || "unchecked",
      last_error: r.last_error ?? null,
      verified_at: r.verified_at ?? null,
      updated_at: r.updated_at ?? null,
    });
  }

  return await Promise.all(
    IMAGE_API_KEY_PROVIDERS.map(async (provider) => {
      const info = PROVIDER_INFO[provider];
      const row = dbRows.get(provider);
      if (row) {
        return {
          provider,
          ...info,
          configured: true,
          source: "database" as const,
          last4: row.last4 ?? null,
          status: (row.status as ApiKeyStatus) || "unchecked",
          lastError: row.last_error ?? null,
          verifiedAt: row.verified_at ?? null,
          updatedAt: row.updated_at ?? null,
        };
      }

      const envVal = envImageKey(provider);
      if (envVal) {
        const cached = envVerificationCache.get(provider);
        if (cached) {
          return {
            provider,
            ...info,
            configured: true,
            source: "env" as const,
            last4: envVal.slice(-4),
            status: cached.status,
            lastError: cached.lastError,
            verifiedAt: cached.verifiedAt,
            updatedAt: null,
          };
        }

        const probe = await verifyImageProviderKey(provider, envVal).catch((err: any) => ({
          ok: false,
          error: err?.message || "Verification failed",
        }));

        const verified = {
          status: (probe.ok ? "valid" : "invalid") as ApiKeyStatus,
          lastError: probe.ok ? null : probe.error || "Verification failed",
          verifiedAt: probe.ok ? new Date().toISOString() : null,
        };
        envVerificationCache.set(provider, verified);

        return {
          provider,
          ...info,
          configured: true,
          source: "env" as const,
          last4: envVal.slice(-4),
          status: verified.status,
          lastError: verified.lastError,
          verifiedAt: verified.verifiedAt,
          updatedAt: null,
        };
      }

      return {
        provider,
        ...info,
        configured: false,
        source: "none" as const,
        last4: null,
        status: "unchecked" as const,
        lastError: null,
        verifiedAt: null,
        updatedAt: null,
      };
    })
  );
}

export async function getDecryptedImagePlatformApiKey(
  provider: ImageProvider
): Promise<string | null> {
  const { data, error } = await supabase
    .from("image_platform_api_keys")
    .select("encrypted_key, iv, auth_tag")
    .eq("provider", provider)
    .maybeSingle();

  if (error || !data) {
    return null;
  }
  return decryptApiKey(data);
}

export async function saveImagePlatformApiKey(
  provider: ImageProvider,
  plaintext: string
): Promise<ImagePlatformApiKeyMeta> {
  const enc = encryptApiKey(plaintext.trim());
  const now = new Date().toISOString();
  const { error } = await supabase.from("image_platform_api_keys").upsert(
    {
      provider,
      encrypted_key: enc.encrypted_key,
      iv: enc.iv,
      auth_tag: enc.auth_tag,
      last4: enc.last4,
      status: "unchecked",
      last_error: null,
      verified_at: null,
      updated_at: now,
    },
    { onConflict: "provider" }
  );

  if (error) {
    if (error.message.includes("does not exist") || error.code === "42P01") {
      throw new Error(
        "Database table image_platform_api_keys is missing. Run backend/sql/014_image_platform_api_keys.sql in Supabase."
      );
    }
    throw error;
  }

  const info = PROVIDER_INFO[provider];
  return {
    provider,
    ...info,
    configured: true,
    source: "database",
    last4: enc.last4,
    status: "unchecked",
    lastError: null,
    verifiedAt: null,
    updatedAt: now,
  };
}

export async function deleteImagePlatformApiKey(provider: ImageProvider): Promise<void> {
  const { error } = await supabase.from("image_platform_api_keys").delete().eq("provider", provider);
  if (error) {
    throw error;
  }
}

export async function setImagePlatformApiKeyStatus(
  provider: ImageProvider,
  status: ApiKeyStatus,
  lastError: string | null = null
): Promise<void> {
  const { error } = await supabase
    .from("image_platform_api_keys")
    .update({
      status,
      last_error: lastError,
      verified_at: status === "valid" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("provider", provider);

  if (error) {
    throw error;
  }
}
