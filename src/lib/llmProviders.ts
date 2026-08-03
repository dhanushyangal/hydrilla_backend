import type { ApiKeyProvider } from "./userApiKeysCrypto.js";

export type CatalogModel = {
  id: string;
  label: string;
  group: "Hydrilla" | "Anthropic" | "OpenAI" | "Google" | "OpenRouter" | "OpenRouter Free";
  kind: "mesh" | "code";
  provider: ApiKeyProvider | "hydrilla";
  openRouterSlug?: string;
  vision?: boolean;
  free?: boolean;
  comingSoon?: boolean;
};

export const MODEL_CATALOG: CatalogModel[] = [
  { id: "trilles", label: "Trilles", group: "Hydrilla", kind: "mesh", provider: "hydrilla" },
  {
    id: "hunyuan3d",
    label: "Hunyuan 3D",
    group: "Hydrilla",
    kind: "mesh",
    provider: "hydrilla",
    comingSoon: true,
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    group: "Anthropic",
    kind: "code",
    provider: "anthropic",
    vision: true,
  },
  {
    id: "claude-opus-4-5",
    label: "Claude Opus 4.5",
    group: "Anthropic",
    kind: "code",
    provider: "anthropic",
    vision: true,
  },
  { id: "gpt-4.1", label: "GPT-4.1", group: "OpenAI", kind: "code", provider: "openai", vision: true },
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    group: "OpenAI",
    kind: "code",
    provider: "openai",
    vision: true,
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    group: "Google",
    kind: "code",
    provider: "gemini",
    vision: true,
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    group: "Google",
    kind: "code",
    provider: "gemini",
    vision: true,
  },
  // --- OpenRouter Free (BYOK, $0) ---
  {
    id: "openrouter/free",
    label: "Auto Free (recommended)",
    group: "OpenRouter Free",
    kind: "code",
    provider: "openrouter",
    openRouterSlug: "openrouter/free",
    vision: true,
    free: true,
  },
  {
    id: "google/gemma-4-31b-it:free",
    label: "Gemma 4 31B",
    group: "OpenRouter Free",
    kind: "code",
    provider: "openrouter",
    openRouterSlug: "google/gemma-4-31b-it:free",
    vision: true,
    free: true,
  },
  {
    id: "google/gemma-4-26b-a4b-it:free",
    label: "Gemma 4 26B",
    group: "OpenRouter Free",
    kind: "code",
    provider: "openrouter",
    openRouterSlug: "google/gemma-4-26b-a4b-it:free",
    vision: true,
    free: true,
  },
  {
    id: "nvidia/nemotron-nano-12b-v2-vl:free",
    label: "Nemotron Nano 12B VL",
    group: "OpenRouter Free",
    kind: "code",
    provider: "openrouter",
    openRouterSlug: "nvidia/nemotron-nano-12b-v2-vl:free",
    vision: true,
    free: true,
  },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    label: "Nemotron 3 Nano Omni",
    group: "OpenRouter Free",
    kind: "code",
    provider: "openrouter",
    openRouterSlug: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    vision: true,
    free: true,
  },
  // --- OpenRouter paid (still BYOK) ---
  {
    id: "openrouter/anthropic/claude-sonnet-4",
    label: "Claude Sonnet 4",
    group: "OpenRouter",
    kind: "code",
    provider: "openrouter",
    openRouterSlug: "anthropic/claude-sonnet-4",
    vision: true,
  },
  {
    id: "openrouter/anthropic/claude-opus-4",
    label: "Claude Opus 4",
    group: "OpenRouter",
    kind: "code",
    provider: "openrouter",
    openRouterSlug: "anthropic/claude-opus-4",
    vision: true,
  },
  {
    id: "openrouter/openai/gpt-4.1",
    label: "GPT-4.1",
    group: "OpenRouter",
    kind: "code",
    provider: "openrouter",
    openRouterSlug: "openai/gpt-4.1",
    vision: true,
  },
  {
    id: "openrouter/openai/gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    group: "OpenRouter",
    kind: "code",
    provider: "openrouter",
    openRouterSlug: "openai/gpt-4.1-mini",
    vision: true,
  },
  {
    id: "openrouter/google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    group: "OpenRouter",
    kind: "code",
    provider: "openrouter",
    openRouterSlug: "google/gemini-2.5-flash",
    vision: true,
  },
  {
    id: "openrouter/google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    group: "OpenRouter",
    kind: "code",
    provider: "openrouter",
    openRouterSlug: "google/gemini-2.5-pro",
    vision: true,
  },
];

export function catalogEntry(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function isOpenRouterModelId(modelId: string): boolean {
  return (
    modelId === "openrouter/free" ||
    modelId.endsWith(":free") ||
    modelId.startsWith("openrouter/")
  );
}

export function providerForModel(modelId: string): ApiKeyProvider | "hydrilla" | null {
  const entry = catalogEntry(modelId);
  if (entry) return entry.provider;
  if (isOpenRouterModelId(modelId)) return "openrouter";
  return null;
}

/** Resolve the model string sent to OpenRouter's chat completions API. */
export function resolveOpenRouterSlug(modelId: string): string {
  const entry = catalogEntry(modelId);
  if (entry?.openRouterSlug) return entry.openRouterSlug;
  if (modelId === "openrouter/free") return "openrouter/free";
  if (modelId.endsWith(":free")) return modelId;
  if (modelId.startsWith("openrouter/") && modelId !== "openrouter/auto") {
    return modelId.replace(/^openrouter\//, "");
  }
  return "openrouter/free";
}

export type FreeOpenRouterModel = {
  id: string;
  name: string;
  vision: boolean;
  contextLength: number | null;
};

type OpenRouterModelRow = {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { modality?: string; input_modalities?: string[] };
};

function isFreePricing(m: OpenRouterModelRow): boolean {
  if (m.id === "openrouter/free" || m.id.endsWith(":free")) return true;
  const prompt = Number(m.pricing?.prompt ?? NaN);
  const completion = Number(m.pricing?.completion ?? NaN);
  return prompt === 0 && completion === 0 && m.id.includes(":free");
}

function hasVision(m: OpenRouterModelRow): boolean {
  if (m.id === "openrouter/free") return true;
  const modality = m.architecture?.modality || "";
  if (modality.includes("image")) return true;
  const inputs = m.architecture?.input_modalities || [];
  return inputs.includes("image");
}

/** Public OpenRouter models list filtered to free chat models. */
export async function fetchOpenRouterFreeModels(): Promise<FreeOpenRouterModel[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter models list failed (${res.status})`);
  }
  const json = (await res.json()) as { data?: OpenRouterModelRow[] };

  const out: FreeOpenRouterModel[] = [];
  for (const m of json.data || []) {
    if (!m.id || !isFreePricing(m)) continue;
    // Skip safety / non-generative toys when obvious
    if (/content-safety|lyria/i.test(m.id)) continue;
    out.push({
      id: m.id,
      name: m.name || m.id,
      vision: hasVision(m),
      contextLength: m.context_length ?? null,
    });
  }

  out.sort((a, b) => {
    if (a.id === "openrouter/free") return -1;
    if (b.id === "openrouter/free") return 1;
    if (a.vision !== b.vision) return a.vision ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** Optional account probe — never logs the key. */
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

/** Live probe — never logs the key. */
export async function verifyProviderKey(
  provider: ApiKeyProvider,
  apiKey: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (res.ok) return { ok: true };
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Anthropic ${res.status}: ${body.slice(0, 180)}` };
    }

    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) return { ok: true };
      const body = await res.text().catch(() => "");
      return { ok: false, error: `OpenAI ${res.status}: ${body.slice(0, 180)}` };
    }

    if (provider === "openrouter") {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) return { ok: true };
      const body = await res.text().catch(() => "");
      return { ok: false, error: `OpenRouter ${res.status}: ${body.slice(0, 180)}` };
    }

    if (provider === "gemini") {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
      );
      if (res.ok) return { ok: true };
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Gemini ${res.status}: ${body.slice(0, 180)}` };
    }

    return { ok: false, error: "Unknown provider" };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Verification request failed" };
  }
}

function resolveNativeModel(provider: ApiKeyProvider, modelId: string): string {
  if (provider === "anthropic") {
    return modelId === "claude-opus-4-5" ? "claude-opus-4-5" : "claude-sonnet-4-5";
  }
  if (provider === "openai") {
    return modelId === "gpt-4.1-mini" ? "gpt-4.1-mini" : "gpt-4.1";
  }
  if (provider === "gemini") {
    return modelId === "gemini-2.5-pro" ? "gemini-2.5-pro" : "gemini-2.5-flash";
  }
  return resolveOpenRouterSlug(modelId);
}

function friendlyProviderError(provider: ApiKeyProvider, status: number, body: string): string {
  if (status === 429) {
    return provider === "openrouter"
      ? "Free model rate limit reached (~20/min, ~50/day). Wait a minute, or pick Auto Free / another free model."
      : "Provider rate limit reached. Wait a moment and try again.";
  }
  if (status === 401 || status === 403) {
    return "Your API key was rejected. Re-check it in Settings → Models & API Keys.";
  }
  return `${provider} request failed (${status}): ${body.slice(0, 240)}`;
}

/**
 * One text (optionally vision) completion across all supported providers.
 * `imageUrl` is optional — text-only prompts are the primary Code Sculpt path.
 */
export async function callLLM(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  system: string;
  userText: string;
  imageUrl?: string | null;
  maxTokens?: number;
}): Promise<string> {
  const { provider, apiKey, system, userText } = params;
  const imageUrl = params.imageUrl || null;
  const maxTokens = params.maxTokens ?? 8192;
  const model = resolveNativeModel(provider, params.modelId);

  if (provider === "anthropic") {
    const content: Array<Record<string, unknown>> = [];
    if (imageUrl) content.push({ type: "image", source: { type: "url", url: imageUrl } });
    content.push({ type: "text", text: userText });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(friendlyProviderError(provider, res.status, body));
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return (
      data.content?.filter((c) => c.type === "text").map((c) => c.text || "").join("\n") || ""
    );
  }

  if (provider === "openai" || provider === "openrouter") {
    const base =
      provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1";
    const userContent = imageUrl
      ? [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageUrl } },
        ]
      : userText;

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(provider === "openrouter"
          ? { "HTTP-Referer": "https://hydrilla.ai", "X-Title": "Hydrilla Water" }
          : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(friendlyProviderError(provider, res.status, body));
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (data.error?.message) throw new Error(data.error.message);
    return data.choices?.[0]?.message?.content || "";
  }

  // gemini
  const parts: Array<Record<string, unknown>> = [{ text: userText }];
  if (imageUrl) {
    parts.push({ fileData: { mimeType: "image/jpeg", fileUri: imageUrl } });
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && imageUrl) {
    // Gemini fileUri needs Files-API URIs; retry text-only with a described reference.
    const res2 = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
      }),
    });
    if (!res2.ok) {
      const errText = await res2.text().catch(() => "");
      throw new Error(friendlyProviderError(provider, res2.status, errText));
    }
    const data2 = (await res2.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return data2.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") || "";
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(friendlyProviderError(provider, res.status, errText));
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") || "";
}
