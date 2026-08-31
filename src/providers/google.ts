import { createGoogle } from "@ai-sdk/google";
import type { Connector, ListedModel } from "./types.js";
import { friendlyProviderError } from "./errors.js";

export const googleConnector: Connector = {
  id: "google",
  name: "Google",
  product: "Gemini API",
  docsUrl: "https://aistudio.google.com/apikey",
  keyPlaceholder: "AIza...",
  lookLikeKey: (v) => v.trim().length > 20,
  keyFormatError: "API key format looks invalid",
  createModel: (apiKey, nativeModelId) => createGoogle({ apiKey })(nativeModelId),
  listModels: async (apiKey) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(friendlyProviderError("google", res.status, body));
    }
    const json = (await res.json()) as {
      models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
    };
    const out: ListedModel[] = [];
    for (const m of json.models || []) {
      const raw = String(m.name || "").replace(/^models\//, "");
      if (!raw) continue;
      if (/embedding|imagen|veo|tts|aqa/i.test(raw)) continue;
      const methods = m.supportedGenerationMethods || [];
      if (methods.length && !methods.includes("generateContent")) continue;
      out.push({ id: raw, name: m.displayName || raw });
    }
    return out;
  },
};
