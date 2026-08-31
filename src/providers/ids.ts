import { API_KEY_PROVIDERS, type ApiKeyProvider } from "./types.js";

/** Map retired / unprefixed catalog ids → canonical `provider:nativeId`. */
export function migrateCodeModelId(id: string | null | undefined): string | null {
  if (!id) return null;
  const raw = id.trim();
  if (!raw) return null;

  if (raw === "claude-sonnet-4-5" || raw === "claude-sonnet-5") return "anthropic:claude-sonnet-5";
  if (raw === "claude-opus-4-5" || raw === "claude-opus-5") return "anthropic:claude-opus-5";
  if (raw === "claude-haiku-4-5") return "anthropic:claude-haiku-4-5";
  if (raw === "gpt-4.1" || raw === "gpt-4.1-mini") return `openai:${raw}`;
  if (raw.startsWith("gemini-")) return `google:${raw}`;
  if (raw === "cursor-auto" || raw === "cursor-composer-2") return "cursor:auto";
  if (raw.startsWith("cursor/")) return `cursor:${raw.slice("cursor/".length) || "auto"}`;
  if (raw.startsWith("cursor-") && !raw.startsWith("cursor:")) {
    const rest = raw.slice("cursor-".length);
    return rest === "auto" ? "cursor:auto" : `cursor:${rest}`;
  }
  if (raw === "openrouter/free") return "openrouter:openrouter/free";
  if (raw.startsWith("openrouter/") && !raw.startsWith("openrouter:")) {
    return `openrouter:${raw.slice("openrouter/".length)}`;
  }
  if (raw.endsWith(":free") && !raw.startsWith("openrouter:")) {
    return `openrouter:${raw}`;
  }

  return raw;
}

export function canonicalModelId(provider: ApiKeyProvider, nativeId: string): string {
  const native = nativeId.trim() || (provider === "cursor" ? "auto" : nativeId);
  return `${provider}:${native}`;
}

export function parseWaterModelId(
  modelId: string
): { provider: ApiKeyProvider; nativeId: string } | null {
  const migrated = migrateCodeModelId(modelId) || modelId;
  const colon = migrated.indexOf(":");
  if (colon > 0) {
    const prefix = migrated.slice(0, colon);
    const native = migrated.slice(colon + 1);
    const provider = normalizeProviderId(prefix);
    if (provider && native) return { provider, nativeId: native };
  }

  // Last-resort legacy shapes
  if (migrated.startsWith("claude-")) return { provider: "anthropic", nativeId: migrated };
  if (migrated.startsWith("gpt-")) return { provider: "openai", nativeId: migrated };
  if (migrated.startsWith("gemini-")) return { provider: "google", nativeId: migrated };
  if (migrated.endsWith(":free") || migrated === "openrouter/free" || migrated.startsWith("openrouter/")) {
    const native =
      migrated === "openrouter/free"
        ? "openrouter/free"
        : migrated.startsWith("openrouter/")
          ? migrated.slice("openrouter/".length)
          : migrated;
    return { provider: "openrouter", nativeId: native };
  }
  if (migrated.startsWith("cursor")) return { provider: "cursor", nativeId: "auto" };
  return null;
}

export function providerForModel(modelId: string): ApiKeyProvider | "hydrilla" | null {
  if (modelId === "trilles" || modelId === "hunyuan3d") return "hydrilla";
  return parseWaterModelId(modelId)?.provider ?? null;
}

export function normalizeProviderId(value: string): ApiKeyProvider | null {
  const v = value === "gemini" ? "google" : value;
  return (API_KEY_PROVIDERS as string[]).includes(v) ? (v as ApiKeyProvider) : null;
}

export function isApiKeyProvider(value: string): value is ApiKeyProvider {
  return normalizeProviderId(value) !== null;
}

export function dbProviderAliases(provider: ApiKeyProvider): string[] {
  if (provider === "google") return ["google", "gemini"];
  return [provider];
}
