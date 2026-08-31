import { anthropicConnector } from "./anthropic.js";
import { openaiConnector } from "./openai.js";
import { googleConnector } from "./google.js";
import { openrouterConnector } from "./openrouter.js";
import { cursorConnector } from "./cursor.js";
import type { ApiKeyProvider, Connector, ConnectorPublic, ListedModel } from "./types.js";
import { API_KEY_PROVIDERS } from "./types.js";
import { normalizeProviderId } from "./ids.js";

export const REGISTRY: Record<ApiKeyProvider, Connector> = {
  anthropic: anthropicConnector,
  openai: openaiConnector,
  google: googleConnector,
  openrouter: openrouterConnector,
  cursor: cursorConnector,
};

export function connectors(): Connector[] {
  return API_KEY_PROVIDERS.map((id) => REGISTRY[id]);
}

export function publicConnectors(): ConnectorPublic[] {
  return connectors().map(({ id, name, product, docsUrl, keyPlaceholder }) => ({
    id,
    name,
    product,
    docsUrl,
    keyPlaceholder,
  }));
}

export function getConnector(provider: ApiKeyProvider): Connector {
  return REGISTRY[provider];
}

export function providerLabel(provider: ApiKeyProvider): string {
  return REGISTRY[provider].name;
}

export function lookLikeKey(provider: ApiKeyProvider, value: string): boolean {
  const v = value.trim();
  if (v.length < 20) return false;
  return REGISTRY[provider].lookLikeKey(v);
}

export function lookLikeKeyError(provider: ApiKeyProvider, value: string): string | null {
  const v = value.trim();
  if (!v) return "apiKey is required";
  if (lookLikeKey(provider, v)) return null;
  return REGISTRY[provider].keyFormatError;
}

export async function verifyProviderKey(
  provider: ApiKeyProvider,
  apiKey: string
): Promise<{ ok: boolean; error?: string }> {
  const key = apiKey.trim();
  try {
    if (!lookLikeKey(provider, key)) {
      return { ok: false, error: REGISTRY[provider].keyFormatError };
    }
    await REGISTRY[provider].listModels(key);
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Verification request failed";
    return { ok: false, error: message };
  }
}

type CacheEntry = { at: number; models: ListedModel[] };
const listCache = new Map<string, CacheEntry>();
const LIST_TTL_MS = 5 * 60 * 1000;

export async function listModelsCached(
  provider: ApiKeyProvider,
  apiKey: string,
  last4: string | null
): Promise<ListedModel[]> {
  const cacheKey = `${provider}:${last4 || apiKey.slice(-8)}`;
  const cached = listCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.models;
  const models = await REGISTRY[provider].listModels(apiKey);
  listCache.set(cacheKey, { at: Date.now(), models });
  return models;
}

export function requireProviderParam(value: string): ApiKeyProvider | null {
  return normalizeProviderId(value);
}

export { API_KEY_PROVIDERS };
export type { ApiKeyProvider, Connector, ConnectorPublic, ListedModel };
