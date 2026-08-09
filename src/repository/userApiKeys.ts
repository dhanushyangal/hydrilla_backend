import { supabase } from "../db.js";
import {
  ApiKeyProvider,
  ApiKeyStatus,
  decryptApiKey,
  encryptApiKey,
  isApiKeyProvider,
} from "../lib/userApiKeysCrypto.js";
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
  const providers: ApiKeyProvider[] = ["anthropic", "openai", "gemini", "openrouter", "cursor"];
  const { data, error } = await supabase
    .from("user_api_keys")
    .select("provider, last4, status, last_error, verified_at, updated_at")
    .eq("user_id", userId);

  if (error) {
    // Table may not exist yet — return empty configured state
    logger.warn({ err: error }, "listUserApiKeyMeta failed (migration may be pending)");
    return providers.map((provider) => ({
      provider,
      configured: false,
      last4: null,
      status: "unchecked" as const,
      lastError: null,
      verifiedAt: null,
      updatedAt: null,
    }));
  }

  const byProvider = new Map(
    (data || [])
      .filter((r) => isApiKeyProvider(String(r.provider)))
      .map((r) => [r.provider as ApiKeyProvider, r])
  );

  return providers.map((provider) => {
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
    .eq("provider", provider);
  if (error) throw error;
}

export async function getDecryptedUserApiKey(
  userId: string,
  provider: ApiKeyProvider
): Promise<string | null> {
  const { data, error } = await supabase
    .from("user_api_keys")
    .select("encrypted_key, iv, auth_tag")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();

  if (error || !data) return null;
  return decryptApiKey(data);
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
    .eq("provider", provider);
  if (error) throw error;
}

/** Retired Claude 4.5 catalog ids → current Water Anthropic models. */
function migrateDefaultCodeModel(id: string | null): string | null {
  if (!id) return null;
  if (id === "claude-sonnet-4-5") return "claude-sonnet-5";
  if (id === "claude-opus-4-5") return "claude-opus-5";
  return id;
}

export async function getUserModelPrefs(userId: string): Promise<{
  defaultMeshModel: string;
  defaultCodeModel: string | null;
}> {
  const { data } = await supabase
    .from("user_model_prefs")
    .select("default_mesh_model, default_code_model")
    .eq("user_id", userId)
    .maybeSingle();

  const rawCode = data?.default_code_model || null;
  const migrated = migrateDefaultCodeModel(rawCode);
  // Persist migration so subsequent loads / jobs use the current catalog id.
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
  };
}

export async function upsertUserModelPrefs(
  userId: string,
  prefs: { defaultMeshModel?: string; defaultCodeModel?: string | null }
): Promise<void> {
  // Merge with existing row so omitting a field does not wipe it.
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

  const { error } = await supabase.from("user_model_prefs").upsert(
    {
      user_id: userId,
      default_mesh_model: mesh,
      default_code_model: code,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}
