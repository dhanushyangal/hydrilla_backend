import { generateText, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import { combineAbortSignals } from "../lib/water/cancelRegistry.js";
import { getConnector } from "./index.js";
import { parseWaterModelId } from "./ids.js";
import type { ApiKeyProvider, LlmCallResult } from "./types.js";
import { usageFromSdk } from "./usage.js";

function parseIds(provider: ApiKeyProvider, modelId: string): { provider: ApiKeyProvider; nativeId: string } {
  const parsed = parseWaterModelId(modelId);
  if (parsed) return parsed;
  return { provider, nativeId: modelId };
}

async function generateViaSdk(params: {
  model: LanguageModel;
  system: string;
  userText: string;
  imageUrl?: string | null;
  maxTokens: number;
  abortSignal: AbortSignal;
  timeoutMs: number;
}): Promise<LlmCallResult> {
  const result = await generateText({
    model: params.model,
    system: params.system,
    ...(params.imageUrl
      ? {
          messages: [
            {
              role: "user" as const,
              content: [
                { type: "text" as const, text: params.userText },
                { type: "image" as const, image: params.imageUrl },
              ],
            },
          ],
        }
      : { prompt: params.userText }),
    maxOutputTokens: params.maxTokens,
    abortSignal: params.abortSignal,
    timeout: params.timeoutMs,
  });

  return {
    text: result.text || "",
    usage: usageFromSdk(result.usage),
  };
}

export async function callLLM(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  system: string;
  userText: string;
  imageUrl?: string | null;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<LlmCallResult> {
  const { provider, apiKey, system, userText } = params;
  const imageUrl = params.imageUrl || null;
  const maxTokens = params.maxTokens ?? 8192;
  const timeoutMs = params.timeoutMs ?? (provider === "cursor" ? 210_000 : 75_000);
  const signal = combineAbortSignals(timeoutMs, params.signal);
  const { nativeId } = parseIds(provider, params.modelId);
  const connector = getConnector(provider);

  if (connector.generateTextDirect) {
    return connector.generateTextDirect({
      apiKey,
      nativeModelId: nativeId,
      system,
      userText,
      imageUrl,
      timeoutMs,
      signal: params.signal,
    });
  }

  const model = connector.createModel(apiKey, nativeId);
  return generateViaSdk({
    model,
    system,
    userText,
    imageUrl,
    maxTokens,
    abortSignal: signal,
    timeoutMs,
  });
}

export async function callLLMObject<T>(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  system: string;
  userText: string;
  imageUrl?: string | null;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  schema: z.ZodType<T>;
}): Promise<{ output: T; text: string; usage: LlmCallResult["usage"] }> {
  const { provider, apiKey, system, userText, schema } = params;
  const timeoutMs = params.timeoutMs ?? (provider === "cursor" ? 210_000 : 75_000);
  const maxTokens = params.maxTokens ?? 4096;
  const signal = combineAbortSignals(timeoutMs, params.signal);
  const { nativeId } = parseIds(provider, params.modelId);
  const connector = getConnector(provider);

  if (connector.generateTextDirect) {
    const result = await connector.generateTextDirect({
      apiKey,
      nativeModelId: nativeId,
      system,
      userText,
      imageUrl: params.imageUrl,
      timeoutMs,
      signal: params.signal,
    });
    const parsed = schema.parse(extractJson(result.text));
    return { output: parsed, text: result.text, usage: result.usage };
  }

  const model = connector.createModel(apiKey, nativeId);
  const result = await generateText({
    model,
    system,
    ...(params.imageUrl
      ? {
          messages: [
            {
              role: "user" as const,
              content: [
                { type: "text" as const, text: userText },
                { type: "image" as const, image: params.imageUrl },
              ],
            },
          ],
        }
      : { prompt: userText }),
    maxOutputTokens: maxTokens,
    abortSignal: signal,
    timeout: timeoutMs,
    output: Output.object({ schema }),
  });

  if (result.output == null) {
    throw new Error("Model did not return structured output");
  }
  return {
    output: result.output as T,
    text: result.text || JSON.stringify(result.output),
    usage: usageFromSdk(result.usage),
  };
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] || text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found");
  return JSON.parse(raw.slice(start, end + 1));
}
