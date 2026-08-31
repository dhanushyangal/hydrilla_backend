import { supabase } from "../db.js";
import {
  API_KEY_PROVIDERS,
  ApiKeyProvider,
  ApiKeyStatus,
  decryptApiKey,
  encryptApiKey,
} from "../lib/userApiKeysCrypto.js";
import { dbProviderAliases, migrateCodeModelId, normalizeProviderId } from "../providers/ids.js";
import { logger } from "../logger.js";

export type UserApiKeyMeta = {
  provider: ApiKeyProvider;
  configured: boolean;
  last4: string | null;
  status: ApiKeyStatus;
  lastError: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
};

export async function listUserApiKeyMeta(userId: string): Promise<UserApiKeyMeta[]> {
  const { data, error } = await supabase
    .from("user_api_keys")
    .select("provider, last4, status, last_error, verified_at, updated_at")
    .eq("user_id", userId);

  if (error) {
    logger.warn({ err: error }, "listUserApiKeyMeta failed (migration may be pending)");
    return API_KEY_PROVIDERS.map((provider) => ({
      provider,
      configured: false,
      last4: null,
      status: "unchecked" as const,
      lastError: null,
      verifiedAt: null,
      updatedAt: null,
    }));
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
    return {
      provider,
      configured: Boolean(row),
      last4: row?.last4 ?? null,
      status: (row?.status as ApiKeyStatus) || "unchecked",
      lastError: row?.last_error ?? null,
      verifiedAt: row?.verified_at ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

export async function saveUserApiKey(
  userId: string,
  provider: ApiKeyProvider,
  plaintext: string
): Promise<UserApiKeyMeta> {
  const enc = encryptApiKey(plaintext.trim());
  const { error } = await supabase.from("user_api_keys").upsert(
    {
      user_id: userId,
      provider,
      encrypted_key: enc.encrypted_key,
      iv: enc.iv,
      auth_tag: enc.auth_tag,
      last4: enc.last4,
      status: "unchecked",
      last_error: null,
      verified_at: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" }
  );
  if (error) throw error;

  return {
    provider,
    configured: true,
    last4: enc.last4,
    status: "unchecked",
    lastError: null,
    verifiedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

export async function deleteUserApiKey(userId: string, provider: ApiKeyProvider): Promise<void> {
  const { error } = await supabase
    .from("user_api_keys")
    .delete()
    .eq("user_id", userId)
    .in("provider", dbProviderAliases(provider));
  if (error) throw error;
}

export async function getDecryptedUserApiKey(
  userId: string,
  provider: ApiKeyProvider
): Promise<string | null> {
  const aliases = dbProviderAliases(provider);
  const { data, error } = await supabase
    .from("user_api_keys")
    .select("encrypted_key, iv, auth_tag, provider")
    .eq("user_id", userId)
    .in("provider", aliases);

  if (error || !data?.length) return null;
  const preferred = data.find((r) => r.provider === provider) || data[0];
  return decryptApiKey(preferred);
}

export async function setUserApiKeyStatus(
  userId: string,
  provider: ApiKeyProvider,
  status: ApiKeyStatus,
  lastError: string | null = null
): Promise<void> {
  const { error } = await supabase
    .from("user_api_keys")
    .update({
      status,
      last_error: lastError,
      verified_at: status === "valid" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .in("provider", dbProviderAliases(provider));
  if (error) throw error;
}

function migrateDefaultCodeModel(id: string | null): string | null {
  return migrateCodeModelId(id);
}

function normalizeEnabledModels(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = raw
    .filter((x): x is string => typeof x === "string")
    .map((id) => migrateCodeModelId(id) || id)
    .filter(Boolean);
  return [...new Set(ids)].slice(0, 80);
}

export async function getUserModelPrefs(userId: string): Promise<{
  defaultMeshModel: string;
  defaultCodeModel: string | null;
  enabledCodeModels: string[] | null;
}> {
  let data: {
    default_mesh_model?: string | null;
    default_code_model?: string | null;
    enabled_code_models?: unknown;
  } | null = null;

  {
    const full = await supabase
      .from("user_model_prefs")
      .select("default_mesh_model, default_code_model, enabled_code_models")
      .eq("user_id", userId)
      .maybeSingle();
    if (full.error && String(full.error.message || "").includes("enabled_code_models")) {
      const legacy = await supabase
        .from("user_model_prefs")
        .select("default_mesh_model, default_code_model")
        .eq("user_id", userId)
        .maybeSingle();
      data = legacy.data;
    } else {
      data = full.data;
    }
  }

  const rawCode = data?.default_code_model || null;
  const migrated = migrateDefaultCodeModel(rawCode);
  if (rawCode && migrated && migrated !== rawCode) {
    void supabase
      .from("user_model_prefs")
      .update({
        default_code_model: migrated,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  }

  return {
    defaultMeshModel: data?.default_mesh_model || "trilles",
    defaultCodeModel: migrated,
    enabledCodeModels: normalizeEnabledModels(data?.enabled_code_models),
  };
}

export async function upsertUserModelPrefs(
  userId: string,
  prefs: {
    defaultMeshModel?: string;
    defaultCodeModel?: string | null;
    enabledCodeModels?: string[] | null;
  }
): Promise<void> {
  const current = await getUserModelPrefs(userId);
  const mesh =
    prefs.defaultMeshModel !== undefined
      ? prefs.defaultMeshModel || "trilles"
      : current.defaultMeshModel;
  const code = migrateDefaultCodeModel(
    prefs.defaultCodeModel !== undefined
      ? prefs.defaultCodeModel
      : current.defaultCodeModel
  );
  const enabled =
    prefs.enabledCodeModels !== undefined
      ? normalizeEnabledModels(prefs.enabledCodeModels)
      : current.enabledCodeModels;

  const row: Record<string, unknown> = {
    user_id: userId,
    default_mesh_model: mesh,
    default_code_model: code,
    updated_at: new Date().toISOString(),
  };
  if (enabled) row.enabled_code_models = enabled;

  const { error } = await supabase.from("user_model_prefs").upsert(row, { onConflict: "user_id" });
  if (error && String(error.message || "").includes("enabled_code_models")) {
    const { error: retry } = await supabase.from("user_model_prefs").upsert(
      {
        user_id: userId,
        default_mesh_model: mesh,
        default_code_model: code,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (retry) throw retry;
    return;
  }
  if (error) throw error;
}
