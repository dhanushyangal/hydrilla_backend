import { createOpenAI } from "@ai-sdk/openai";
import type { Connector, ListedModel } from "./types.js";
import { friendlyProviderError } from "./errors.js";

const SKIP = /embedding|whisper|tts|dall-e|davinci|babbage|ada-|moderation|transcribe|sora|gpt-image|realtime|audio/i;

export const openaiConnector: Connector = {
  id: "openai",
  name: "OpenAI",
  product: "API",
  docsUrl: "https://platform.openai.com/api-keys",
  keyPlaceholder: "sk-...",
  lookLikeKey: (v) => {
    const t = v.trim();
    return t.length >= 20 && (t.startsWith("sk-") || t.length > 40);
  },
  keyFormatError: "API key format looks invalid",
  createModel: (apiKey, nativeModelId) => createOpenAI({ apiKey })(nativeModelId),
  listModels: async (apiKey) => {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(friendlyProviderError("openai", res.status, body));
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }>; object?: string };
    const out: ListedModel[] = [];
    for (const m of json.data || []) {
      const id = String(m.id || "").trim();
      if (!id || SKIP.test(id)) continue;
      if (!/^(gpt-|o[1-9]|chatgpt-|computer-use)/i.test(id) && !/^ft:/i.test(id)) continue;
      out.push({ id, name: id });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  },
};
