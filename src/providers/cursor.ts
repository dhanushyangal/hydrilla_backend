import {
  combineAbortSignals,
  isUserCancelError,
  WATER_CANCELLED_MESSAGE,
} from "../lib/water/cancelRegistry.js";
import { friendlyProviderError } from "./errors.js";
import type { Connector, ListedModel, LlmCallResult, LlmTokenUsage } from "./types.js";
import { usageFromCounts } from "./usage.js";

export type CursorModelParam = { id: string; value: string };

export type CursorModelRow = {
  id: string;
  displayName: string;
  isAuto?: boolean;
  aliases?: string[];
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
    const defVariant = item.variants?.find((v) => v.isDefault) || item.variants?.[0];
    const defaultParams = (defVariant?.params || [])
      .filter((p): p is { id: string; value: string } => Boolean(p?.id && p.value != null))
      .map((p) => ({ id: String(p.id), value: String(p.value) }));
    push(item.id, item.displayName || item.name, item.aliases, defaultParams);
  }
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

async function resolveCursorAgentModel(
  apiKey: string,
  modelId: string
): Promise<{ id?: string; params?: CursorModelParam[] }> {
  let requested = "";
  if (modelId === "cursor-auto" || modelId === "auto" || !modelId) {
    requested = "";
  } else if (modelId.startsWith("cursor/")) {
    requested = modelId.slice("cursor/".length);
  } else if (modelId.startsWith("cursor:")) {
    requested = modelId.slice("cursor:".length);
  } else if (modelId === "cursor-composer-2") {
    requested = "composer";
  } else if (!modelId.startsWith("cursor-")) {
    requested = modelId;
  }

  if (!requested || isCursorAutoNative(requested)) return {};

  let models: CursorModelRow[] = [];
  try {
    models = await fetchCursorModels(apiKey);
  } catch {
    return { id: requested === "composer" ? undefined : requested };
  }

  const matchExact = models.find(
    (m) => !m.isAuto && (m.id === requested || (m.aliases || []).includes(requested))
  );
  if (matchExact) {
    return { id: matchExact.id, params: matchExact.defaultParams };
  }

  if (requested === "composer" || requested.startsWith("composer-")) {
    const composer = models.find((m) => !m.isAuto && /^composer/i.test(m.id));
    if (composer) return { id: composer.id, params: composer.defaultParams };
  }

  return {};
}

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

export async function callCursorCloudAgent(params: {
  apiKey: string;
  modelId: string;
  system: string;
  userText: string;
  imageUrl?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<LlmCallResult> {
  const timeoutMs = params.timeoutMs ?? 210_000;
  const signal = combineAbortSignals(timeoutMs, params.signal);
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
    if (signal.aborted) {
      archiveAgent();
      const err = new Error(WATER_CANCELLED_MESSAGE);
      err.name = "AbortError";
      throw err;
    }
    await new Promise((r) => setTimeout(r, 2000));
    try {
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
        const usage = await fetchCursorRunUsage(params.apiKey, agentId, runId);
        archiveAgent();
        return { text, usage };
      }
    } catch (err) {
      if (isUserCancelError(err) || signal.aborted) {
        archiveAgent();
        const e = new Error(WATER_CANCELLED_MESSAGE);
        e.name = "AbortError";
        throw e;
      }
      throw err;
    }
  }

  archiveAgent();
  throw new Error(`Cursor run timed out (last status: ${lastStatus})`);
}

export const cursorConnector: Connector = {
  id: "cursor",
  name: "Cursor",
  product: "Cloud Agents API",
  docsUrl: "https://cursor.com/dashboard/api",
  keyPlaceholder: "crsr_...",
  lookLikeKey: (v) => {
    const t = v.trim();
    return t.startsWith("crsr_") || t.length >= 24;
  },
  keyFormatError: "API key format looks invalid",
  createModel: () => {
    throw new Error("Cursor Cloud Agents are not an AI SDK chat model");
  },
  listModels: async (apiKey) => {
    const me = await fetch("https://api.cursor.com/v1/me", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!me.ok) {
      const body = await me.text().catch(() => "");
      throw new Error(friendlyProviderError("cursor", me.status, body));
    }
    const rows = await fetchCursorModels(apiKey);
    const out: ListedModel[] = [{ id: "auto", name: "Cursor Auto" }];
    for (const m of rows) {
      if (m.isAuto) {
        out[0] = { id: "auto", name: m.displayName?.trim() || "Cursor Auto" };
        continue;
      }
      out.push({ id: m.id, name: m.displayName || m.id });
    }
    return out;
  },
  generateTextDirect: async (params) =>
    callCursorCloudAgent({
      apiKey: params.apiKey,
      modelId: params.nativeModelId,
      system: params.system,
      userText: params.userText,
      imageUrl: params.imageUrl,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    }),
};
