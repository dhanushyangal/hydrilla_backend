import { createAnthropic } from "@ai-sdk/anthropic";
import type { Connector, ListedModel } from "./types.js";
import { friendlyProviderError } from "./errors.js";

export const anthropicConnector: Connector = {
  id: "anthropic",
  name: "Anthropic",
  product: "Claude API",
  docsUrl: "https://platform.claude.com/settings/keys",
  keyPlaceholder: "sk-ant-...",
  lookLikeKey: (v) => v.trim().startsWith("sk-ant-") && v.trim().length >= 20,
  keyFormatError:
    "Anthropic keys must start with sk-ant-. Create one at https://platform.claude.com/settings/keys",
  createModel: (apiKey, nativeModelId) => createAnthropic({ apiKey })(nativeModelId),
  listModels: async (apiKey) => {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(friendlyProviderError("anthropic", res.status, body));
    }
    const json = (await res.json()) as {
      data?: Array<{ id?: string; display_name?: string; type?: string }>;
    };
    const out: ListedModel[] = [];
    for (const m of json.data || []) {
      if (!m.id) continue;
      if (m.type && m.type !== "model") continue;
      out.push({ id: m.id, name: m.display_name || m.id });
    }
    return out;
  },
};
