import type { ApiKeyProvider } from "./userApiKeysCrypto.js";

export type CatalogModel = {
  id: string;
  label: string;
  group:
    | "Hydrilla"
    | "Cursor"
    | "Anthropic"
    | "OpenAI"
    | "Google"
    | "OpenRouter"
    | "OpenRouter Free";
  kind: "mesh" | "code";
  provider: ApiKeyProvider | "hydrilla";
  openRouterSlug?: string;
  /** Native Cursor Cloud Agents model.id (omit for account default). */
  cursorModelId?: string | null;
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
  // --- Cursor Cloud Agents (BYOK) — live list from GET /v1/models; Auto omits model.id ---
  {
    id: "cursor-auto",
    label: "Cursor Auto",
    group: "Cursor",
    kind: "code",
    provider: "cursor",
    cursorModelId: null,
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
  if (modelId.startsWith("cursor-") || modelId.startsWith("cursor/")) return "cursor";
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

export type CursorModelParam = { id: string; value: string };

export type CursorModelRow = {
  /** Native Cursor model.id for Cloud Agents create */
  id: string;
  displayName: string;
  /** True when this is the account/default auto router */
  isAuto?: boolean;
  /** Alternate ids that resolve to the same model */
  aliases?: string[];
  /** Default variant params from GET /v1/models (pass on create) */
  defaultParams?: CursorModelParam[];
};

type CursorModelsCacheEntry = { at: number; rows: CursorModelRow[] };
const cursorModelsCache = new Map<string, CursorModelsCacheEntry>();
const CURSOR_MODELS_TTL_MS = 5 * 60 * 1000;

function isCursorAutoNative(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    !id ||
    lower === "default" ||
    lower === "auto" ||
    lower === "auto-smart" ||
    lower.startsWith("auto-")
  );
}

/**
 * Live models from Cursor Cloud Agents API (requires user API key).
 * Docs: https://cursor.com/docs/cloud-agent/api/endpoints#list-models
 * Only ids from this list may be passed as model.id on Create Agent.
 */
export async function fetchCursorModels(apiKey: string): Promise<CursorModelRow[]> {
  const cacheKey = apiKey.slice(-16);
  const cached = cursorModelsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CURSOR_MODELS_TTL_MS) {
    return cached.rows;
  }

  const res = await fetch("https://api.cursor.com/v1/models", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cursor models list failed (${res.status}): ${body.slice(0, 180)}`);
  }
  const json = (await res.json()) as {
    items?: Array<{
      id?: string;
      displayName?: string;
      name?: string;
      aliases?: string[];
      variants?: Array<{
        displayName?: string;
        isDefault?: boolean;
        params?: Array<{ id?: string; value?: string }>;
      }>;
    }>;
    models?: string[] | Array<{ id?: string; displayName?: string; name?: string }>;
  };

  const rows: CursorModelRow[] = [];
  const seen = new Set<string>();

  const push = (
    id: string,
    displayName?: string,
    aliases?: string[],
    defaultParams?: CursorModelParam[]
  ) => {
    const native = String(id || "").trim();
    if (!native || seen.has(native)) return;
    seen.add(native);
    rows.push({
      id: native,
      displayName: (displayName || native).trim() || native,
      isAuto: isCursorAutoNative(native),
      aliases: aliases?.filter(Boolean),
      defaultParams: defaultParams?.length ? defaultParams : undefined,
    });
  };

  for (const item of json.items || []) {
    if (!item?.id) continue;
    const defVariant =
      item.variants?.find((v) => v.isDefault) || item.variants?.[0];
    const defaultParams = (defVariant?.params || [])
      .filter((p): p is { id: string; value: string } => Boolean(p?.id && p.value != null))
      .map((p) => ({ id: String(p.id), value: String(p.value) }));
    push(item.id, item.displayName || item.name, item.aliases, defaultParams);
  }
  // v0-shaped fallback: { models: ["composer-2", ...] }
  for (const m of json.models || []) {
    if (typeof m === "string") push(m);
    else if (m?.id) push(m.id, m.displayName || m.name);
  }

  rows.sort((a, b) => {
    if (a.isAuto !== b.isAuto) return a.isAuto ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
  cursorModelsCache.set(cacheKey, { at: Date.now(), rows });
  return rows;
}

/**
 * Map a picker modelId → Cloud Agents `model` field.
 * Only uses ids returned by GET /v1/models for this API key.
 * Auto / unknown → omit model (account default).
 */
async function resolveCursorAgentModel(
  apiKey: string,
  modelId: string
): Promise<{ id?: string; params?: CursorModelParam[] }> {
  let requested = "";
  if (modelId === "cursor-auto" || !modelId) {
    requested = "";
  } else if (modelId.startsWith("cursor/")) {
    requested = modelId.slice("cursor/".length);
  } else if (modelId === "cursor-composer-2") {
    // Legacy curated id — resolve against live composer* if present
    requested = "composer";
  } else if (!modelId.startsWith("cursor-")) {
    requested = modelId;
  }

  if (!requested || isCursorAutoNative(requested)) return {};

  let models: CursorModelRow[] = [];
  try {
    models = await fetchCursorModels(apiKey);
  } catch {
    // If list fails, try the requested id bare (best effort)
    return { id: requested === "composer" ? undefined : requested };
  }

  const matchExact = models.find(
    (m) =>
      !m.isAuto &&
      (m.id === requested || (m.aliases || []).includes(requested))
  );
  if (matchExact) {
    return { id: matchExact.id, params: matchExact.defaultParams };
  }

  // Soft-match legacy "composer" / composer-* against whatever the key exposes
  if (requested === "composer" || requested.startsWith("composer-")) {
    const composer = models.find((m) => !m.isAuto && /^composer/i.test(m.id));
    if (composer) return { id: composer.id, params: composer.defaultParams };
  }

  // Not available for this key → account Auto
  return {};
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

    if (provider === "cursor") {
      // Cloud Agents API key probe — https://cursor.com/docs/api
      const res = await fetch("https://api.cursor.com/v1/me", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) return { ok: true };
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Cursor ${res.status}: ${body.slice(0, 180)}` };
    }

    return { ok: false, error: "Unknown provider" };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Verification request failed" };
  }
}

/** Known native ids for first-party chat providers (pass through as selected). */
const ANTHROPIC_IDS = new Set(["claude-sonnet-4-5", "claude-opus-4-5"]);
const OPENAI_IDS = new Set(["gpt-4.1", "gpt-4.1-mini"]);
const GEMINI_IDS = new Set(["gemini-2.5-flash", "gemini-2.5-pro"]);

function resolveNativeModel(provider: ApiKeyProvider, modelId: string): string {
  if (provider === "anthropic") {
    return ANTHROPIC_IDS.has(modelId) ? modelId : "claude-sonnet-4-5";
  }
  if (provider === "openai") {
    return OPENAI_IDS.has(modelId) ? modelId : "gpt-4.1";
  }
  if (provider === "gemini") {
    return GEMINI_IDS.has(modelId) ? modelId : "gemini-2.5-flash";
  }
  if (provider === "cursor") {
    // Native ids resolved at call time via GET /v1/models (resolveCursorAgentModel).
    if (modelId === "cursor-auto" || modelId === "cursor-composer-2") return "";
    if (modelId.startsWith("cursor/")) {
      const native = modelId.slice("cursor/".length);
      return isCursorAutoNative(native) ? "" : native;
    }
    return "";
  }
  return resolveOpenRouterSlug(modelId);
}

/**
 * Cursor Cloud Agents are not chat-completions. Water uses a no-repo agent run
 * and reads `run.result` (final assistant text).
 * Docs: https://cursor.com/docs/cloud-agent/api/endpoints
 *
 * Model selection: GET /v1/models for this key → pass model.id (+ default variant params).
 * Omit `model` for account Auto.
 */
/**
 * Cursor Cloud Agents expose metering at GET /v1/agents/{id}/usage.
 * Usage can lag a moment after FINISHED — retry a few times.
 */
async function fetchCursorRunUsage(
  apiKey: string,
  agentId: string,
  runId: string
): Promise<LlmTokenUsage | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
    try {
      const url = `https://api.cursor.com/v1/agents/${encodeURIComponent(agentId)}/usage?runId=${encodeURIComponent(runId)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        totalUsage?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
        runs?: Array<{
          id?: string;
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
          };
        }>;
      };
      const raw =
        data.runs?.find((r) => r.id === runId)?.usage ||
        data.runs?.[0]?.usage ||
        data.totalUsage;
      if (!raw) continue;
      const fromCounts = usageFromCounts(raw.inputTokens ?? 0, raw.outputTokens ?? 0);
      if (fromCounts) {
        if (raw.totalTokens && raw.totalTokens > fromCounts.totalTokens) {
          fromCounts.totalTokens = Math.floor(raw.totalTokens);
        }
        return fromCounts;
      }
      if (raw.totalTokens && raw.totalTokens > 0) {
        return {
          inputTokens: Math.max(0, Math.floor(raw.inputTokens || 0)),
          outputTokens: Math.max(0, Math.floor(raw.outputTokens || 0)),
          totalTokens: Math.floor(raw.totalTokens),
        };
      }
    } catch {
      // keep trying
    }
  }
  return null;
}

async function callCursorCloudAgent(params: {
  apiKey: string;
  modelId: string;
  system: string;
  userText: string;
  imageUrl?: string | null;
  timeoutMs?: number;
}): Promise<LlmCallResult> {
  const timeoutMs = params.timeoutMs ?? 210_000;
  const signal = AbortSignal.timeout(timeoutMs);
  let selection = await resolveCursorAgentModel(params.apiKey, params.modelId);
  const promptText = [
    params.system.trim(),
    "",
    "---",
    "",
    params.userText.trim(),
    "",
    "IMPORTANT: You are answering a one-shot generation request for Hydrilla Water.",
    "Do not edit files or use tools. Reply with ONLY the requested output in your final message.",
  ].join("\n");

  const buildBody = (sel: { id?: string; params?: CursorModelParam[] }): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      prompt: {
        text: promptText,
        ...(params.imageUrl ? { images: [{ url: params.imageUrl }] } : {}),
      },
      name: "Hydrilla Water",
      // Omit repos + env → no-repo agent (text-only generation).
    };
    if (sel.id) {
      body.model = {
        id: sel.id,
        ...(sel.params?.length ? { params: sel.params } : {}),
      };
    }
    return body;
  };

  const createAgent = async (sel: { id?: string; params?: CursorModelParam[] }) =>
    fetch("https://api.cursor.com/v1/agents", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildBody(sel)),
    });

  let createRes = await createAgent(selection);
  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => "");
    // Invalid / unavailable model → retry once with account Auto (omit model)
    if (
      createRes.status === 400 &&
      selection.id &&
      /invalid_model|not available|invalid/i.test(errBody)
    ) {
      selection = {};
      createRes = await createAgent(selection);
      if (!createRes.ok) {
        const retryBody = await createRes.text().catch(() => "");
        throw new Error(friendlyProviderError("cursor", createRes.status, retryBody || errBody));
      }
    } else {
      throw new Error(friendlyProviderError("cursor", createRes.status, errBody));
    }
  }

  const created = (await createRes.json()) as {
    agent?: { id?: string };
    run?: { id?: string; status?: string; result?: string };
  };
  const agentId = created.agent?.id;
  const runId = created.run?.id;
  if (!agentId || !runId) {
    throw new Error("Cursor agent create returned no agent/run id");
  }

  const terminal = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = created.run?.status || "CREATING";

  const archiveAgent = () => {
    void fetch(`https://api.cursor.com/v1/agents/${agentId}/archive`, {
      method: "POST",
      headers: { Authorization: `Bearer ${params.apiKey}` },
    }).catch(() => {});
  };

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const runRes = await fetch(`https://api.cursor.com/v1/agents/${agentId}/runs/${runId}`, {
      signal,
      headers: { Authorization: `Bearer ${params.apiKey}` },
    });
    if (!runRes.ok) {
      const errBody = await runRes.text().catch(() => "");
      throw new Error(friendlyProviderError("cursor", runRes.status, errBody));
    }
    const run = (await runRes.json()) as {
      status?: string;
      result?: string;
    };
    lastStatus = run.status || lastStatus;
    if (run.status && terminal.has(run.status)) {
      if (run.status !== "FINISHED") {
        archiveAgent();
        throw new Error(`Cursor run ended with status ${run.status}`);
      }
      const text = (run.result || "").trim();
      if (!text) {
        archiveAgent();
        throw new Error("Cursor run finished with empty result");
      }
      // Fetch usage before archive — metering can lag slightly after FINISHED.
      const usage = await fetchCursorRunUsage(params.apiKey, agentId, runId);
      archiveAgent();
      return { text, usage };
    }
  }

  archiveAgent();
  throw new Error(`Cursor run timed out (last status: ${lastStatus})`);
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

export type LlmTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type LlmCallResult = {
  text: string;
  usage: LlmTokenUsage | null;
};

export function emptyTokenUsage(): LlmTokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/** True when the provider reported a non-zero token count. */
export function hasReportedTokenUsage(u: LlmTokenUsage | null | undefined): boolean {
  if (!u) return false;
  return u.inputTokens > 0 || u.outputTokens > 0 || u.totalTokens > 0;
}

export function addTokenUsage(
  a: LlmTokenUsage,
  b: LlmTokenUsage | null | undefined
): LlmTokenUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + (b.inputTokens || 0),
    outputTokens: a.outputTokens + (b.outputTokens || 0),
    totalTokens: a.totalTokens + (b.totalTokens || 0),
  };
}

function usageFromCounts(input: number, output: number): LlmTokenUsage | null {
  const inputTokens = Math.max(0, Math.floor(input || 0));
  const outputTokens = Math.max(0, Math.floor(output || 0));
  if (inputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/**
 * One text (optionally vision) completion across all supported providers.
 * `imageUrl` is optional — text-only prompts are the primary Code Sculpt path.
 * Returns completion text plus provider token usage when available.
 */
export async function callLLM(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  system: string;
  userText: string;
  imageUrl?: string | null;
  maxTokens?: number;
  /** Hard cap per provider call so one pass cannot strand a Water job forever. */
  timeoutMs?: number;
}): Promise<LlmCallResult> {
  const { provider, apiKey, system, userText } = params;
  const imageUrl = params.imageUrl || null;
  const maxTokens = params.maxTokens ?? 8192;
  // Cursor Cloud Agents commonly need 2–4 min; 75s default aborted Studio runs into fallback.
  const timeoutMs =
    params.timeoutMs ?? (provider === "cursor" ? 210_000 : 75_000);
  const signal = AbortSignal.timeout(timeoutMs);
  const model = resolveNativeModel(provider, params.modelId);

  if (provider === "cursor") {
    return callCursorCloudAgent({
      apiKey,
      modelId: params.modelId,
      system,
      userText,
      imageUrl,
      timeoutMs,
    });
  }

  if (provider === "anthropic") {
    const content: Array<Record<string, unknown>> = [];
    if (imageUrl) content.push({ type: "image", source: { type: "url", url: imageUrl } });
    content.push({ type: "text", text: userText });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
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
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text =
      data.content?.filter((c) => c.type === "text").map((c) => c.text || "").join("\n") || "";
    return {
      text,
      usage: usageFromCounts(data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0),
    };
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
      signal,
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
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        // OpenRouter sometimes nests native accounting
        prompt_tokens_details?: unknown;
        native_tokens_prompt?: number;
        native_tokens_completion?: number;
      };
    };
    if (data.error?.message) throw new Error(data.error.message);
    const promptTok =
      data.usage?.prompt_tokens ?? data.usage?.native_tokens_prompt ?? 0;
    const completionTok =
      data.usage?.completion_tokens ?? data.usage?.native_tokens_completion ?? 0;
    const usage = usageFromCounts(promptTok, completionTok);
    if (usage && data.usage?.total_tokens) {
      usage.totalTokens = Math.max(usage.totalTokens, Math.floor(data.usage.total_tokens));
    }
    return {
      text: data.choices?.[0]?.message?.content || "",
      usage,
    };
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
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && imageUrl) {
    // Gemini fileUri needs Files-API URIs; retry text-only with a described reference.
    const res2 = await fetch(url, {
      method: "POST",
      signal,
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
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };
    const usage = usageFromCounts(
      data2.usageMetadata?.promptTokenCount ?? 0,
      data2.usageMetadata?.candidatesTokenCount ?? 0
    );
    if (usage && data2.usageMetadata?.totalTokenCount) {
      usage.totalTokens = Math.max(
        usage.totalTokens,
        Math.floor(data2.usageMetadata.totalTokenCount)
      );
    }
    return {
      text:
        data2.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") || "",
      usage,
    };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(friendlyProviderError(provider, res.status, errText));
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  const usage = usageFromCounts(
    data.usageMetadata?.promptTokenCount ?? 0,
    data.usageMetadata?.candidatesTokenCount ?? 0
  );
  if (usage && data.usageMetadata?.totalTokenCount) {
    usage.totalTokens = Math.max(
      usage.totalTokens,
      Math.floor(data.usageMetadata.totalTokenCount)
    );
  }
  return {
    text: data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") || "",
    usage,
  };
}
