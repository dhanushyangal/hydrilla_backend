import { supabase } from "../db.js";
import {
  API_KEY_PROVIDERS,
  ApiKeyProvider,
  ApiKeyStatus,
  decryptApiKey,
  encryptApiKey,
} from "../lib/userApiKeysCrypto.js";
import { dbProviderAliases, normalizeProviderId } from "../providers/ids.js";
import { logger } from "../logger.js";

export type PlatformApiKeyMeta = {
  provider: ApiKeyProvider;
  configured: boolean;
  last4: string | null;
  status: ApiKeyStatus;
  lastError: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
};

function emptyMeta(provider: ApiKeyProvider): PlatformApiKeyMeta {
  return {
    provider,
    configured: false,
    last4: null,
    status: "unchecked",
    lastError: null,
    verifiedAt: null,
    updatedAt: null,
  };
}

export async function listPlatformApiKeyMeta(): Promise<PlatformApiKeyMeta[]> {
  const { data, error } = await supabase
    .from("platform_api_keys")
    .select("provider, last4, status, last_error, verified_at, updated_at");

  if (error) {
    logger.warn({ err: error }, "listPlatformApiKeyMeta failed (migration may be pending)");
    return API_KEY_PROVIDERS.map(emptyMeta);
  }

  const byProvider = new Map<ApiKeyProvider, (typeof data)[number]>();
  for (const r of data || []) {
    const provider = normalizeProviderId(String(r.provider));
    if (!provider) continue;
    if (!byProvider.has(provider) || String(r.provider) === provider) {
      byProvider.set(provider, r);
    }
  }

  return API_KEY_PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    if (!row) return emptyMeta(provider);
    return {
      provider,
      configured: true,
      last4: row.last4 ?? null,
      status: (row.status as ApiKeyStatus) || "unchecked",
      lastError: row.last_error ?? null,
      verifiedAt: row.verified_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  });
}

export async function savePlatformApiKey(
  provider: ApiKeyProvider,
  plaintext: string
): Promise<PlatformApiKeyMeta> {
  const enc = encryptApiKey(plaintext.trim());
  const now = new Date().toISOString();
  const { error } = await supabase.from("platform_api_keys").upsert(
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
  if (error) throw error;

  return {
    provider,
    configured: true,
    last4: enc.last4,
    status: "unchecked",
    lastError: null,
    verifiedAt: null,
    updatedAt: now,
  };
}

export async function deletePlatformApiKey(provider: ApiKeyProvider): Promise<void> {
  const { error } = await supabase
    .from("platform_api_keys")
    .delete()
    .in("provider", dbProviderAliases(provider));
  if (error) throw error;
}

export async function getDecryptedPlatformApiKey(
  provider: ApiKeyProvider
): Promise<string | null> {
  const { data, error } = await supabase
    .from("platform_api_keys")
    .select("encrypted_key, iv, auth_tag, provider")
    .in("provider", dbProviderAliases(provider));

  if (error || !data?.length) return null;
  const preferred = data.find((r) => r.provider === provider) || data[0];
  return decryptApiKey(preferred);
}

export async function setPlatformApiKeyStatus(
  provider: ApiKeyProvider,
  status: ApiKeyStatus,
  lastError: string | null = null
): Promise<void> {
  const { error } = await supabase
    .from("platform_api_keys")
    .update({
      status,
      last_error: lastError,
      verified_at: status === "valid" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .in("provider", dbProviderAliases(provider));
  if (error) throw error;
}

export function isSharedKeyUsable(meta: { configured: boolean; status: ApiKeyStatus } | undefined): boolean {
  return Boolean(meta?.configured && meta.status !== "invalid");
}

/** Prefer a usable user BYOK key, then a platform key. */
export async function resolveWaterApiKey(
  userId: string,
  provider: ApiKeyProvider
): Promise<{ apiKey: string; source: "platform" | "user"; last4: string | null } | null> {
  const { getDecryptedUserApiKey, listUserApiKeyMeta } = await import("./userApiKeys.js");
  const userMeta = (await listUserApiKeyMeta(userId)).find((k) => k.provider === provider);
  if (isSharedKeyUsable(userMeta)) {
    const userKey = await getDecryptedUserApiKey(userId, provider);
    if (userKey) return { apiKey: userKey, source: "user", last4: userMeta?.last4 ?? null };
  }

  const platformMeta = (await listPlatformApiKeyMeta()).find((k) => k.provider === provider);
  if (isSharedKeyUsable(platformMeta)) {
    const platformKey = await getDecryptedPlatformApiKey(provider);
    if (platformKey) {
      return { apiKey: platformKey, source: "platform", last4: platformMeta?.last4 ?? null };
    }
  }

  return null;
}
