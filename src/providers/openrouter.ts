import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Connector, ListedModel } from "./types.js";
import { friendlyProviderError } from "./errors.js";

type OpenRouterModelRow = {
  id: string;
  name?: string;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { modality?: string; input_modalities?: string[] };
};

function isFreePricing(m: OpenRouterModelRow): boolean {
  if (m.id === "openrouter/free" || m.id.endsWith(":free")) return true;
  const prompt = Number(m.pricing?.prompt ?? NaN);
  const completion = Number(m.pricing?.completion ?? NaN);
  return prompt === 0 && completion === 0 && m.id.includes(":free");
}

export const openrouterConnector: Connector = {
  id: "openrouter",
  name: "OpenRouter",
  product: "",
  docsUrl: "https://openrouter.ai/settings/keys",
  keyPlaceholder: "sk-or-v1-...",
  lookLikeKey: (v) => {
    const t = v.trim();
    return t.length >= 20 && (t.startsWith("sk-or-") || t.length > 40);
  },
  keyFormatError: "API key format looks invalid",
  createModel: (apiKey, nativeModelId) =>
    createOpenAICompatible({
      name: "openrouter",
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://hydrilla.ai",
        "X-Title": "Hydrilla Water",
      },
    })(nativeModelId),
  listModels: async (apiKey) => {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(friendlyProviderError("openrouter", res.status, body));
    }
    const json = (await res.json()) as { data?: OpenRouterModelRow[] };
    const out: ListedModel[] = [];
    for (const m of json.data || []) {
      if (!m.id) continue;
      if (/content-safety|lyria/i.test(m.id)) continue;
      out.push({
        id: m.id,
        name: m.name || m.id,
        free: isFreePricing(m),
      });
    }
    out.sort((a, b) => {
      if (a.id === "openrouter/free") return -1;
      if (b.id === "openrouter/free") return 1;
      if (Boolean(a.free) !== Boolean(b.free)) return a.free ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  },
};

export async function fetchOpenRouterKeyInfo(apiKey: string): Promise<{
  label: string | null;
  limit: number | null;
  usage: number | null;
  isFreeTier: boolean | null;
  rateLimit?: unknown;
}> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter key info failed (${res.status})`);
  }
  const json = (await res.json()) as {
    data?: {
      label?: string;
      limit?: number | null;
      usage?: number;
      is_free_tier?: boolean;
      rate_limit?: unknown;
    };
  };
  const d = json.data || {};
  return {
    label: d.label ?? null,
    limit: d.limit ?? null,
    usage: d.usage ?? null,
    isFreeTier: d.is_free_tier ?? null,
    rateLimit: d.rate_limit,
  };
}
