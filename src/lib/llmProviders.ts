/**
 * Water LLM entry — re-exports the provider manager.
 */

export {
  addTokenUsage,
  emptyTokenUsage,
  hasReportedTokenUsage,
} from "../providers/usage.js";
export { callLLM, callLLMObject } from "../providers/llm.js";
export {
  verifyProviderKey,
  publicConnectors,
  listModelsCached,
  getConnector,
  connectors,
} from "../providers/index.js";
export { fetchOpenRouterKeyInfo } from "../providers/openrouter.js";
export { fetchCursorModels } from "../providers/cursor.js";
export async function fetchOpenRouterFreeModels() {
  const { openrouterConnector } = await import("../providers/openrouter.js");
  const models = await openrouterConnector.listModels("");
  return models
    .filter((m) => m.free)
    .map((m) => ({
      id: m.id,
      name: m.name,
      vision: true,
      contextLength: null as number | null,
    }));
}
export {
  parseWaterModelId,
  providerForModel,
  migrateCodeModelId,
  canonicalModelId,
  isApiKeyProvider,
  normalizeProviderId,
} from "../providers/ids.js";
export type { LlmTokenUsage, LlmCallResult, ApiKeyProvider } from "../providers/types.js";
export type { CursorModelRow } from "../providers/cursor.js";
