import { generateText, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import {
  combineAbortSignals,
  isUserCancelError,
  WATER_CANCELLED_MESSAGE,
} from "../lib/water/cancelRegistry.js";
import { getConnector } from "./index.js";
import { parseWaterModelId } from "./ids.js";
import type { ApiKeyProvider, LlmCallResult } from "./types.js";
import { usageFromSdk } from "./usage.js";

function remapAbort(err: unknown, userSignal?: AbortSignal): never {
  if (isUserCancelError(err) || userSignal?.aborted) {
    const e = new Error(WATER_CANCELLED_MESSAGE);
    e.name = "AbortError";
    throw e;
  }
  const e = new Error("Stage timed out");
  e.name = "TimeoutError";
  throw e;
}

function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Error;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  return /aborted|timeout/i.test(String(e.message || ""));
}

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
    try {
      return await connector.generateTextDirect({
        apiKey,
        nativeModelId: nativeId,
        system,
        userText,
        imageUrl,
        timeoutMs,
        signal,
      });
    } catch (err) {
      if (isAbortLike(err)) remapAbort(err, params.signal);
      throw err;
    }
  }

  const model = connector.createModel(apiKey, nativeId);
  try {
    return await generateViaSdk({
      model,
      system,
      userText,
      imageUrl,
      maxTokens,
      abortSignal: signal,
      timeoutMs,
    });
  } catch (err) {
    if (isAbortLike(err)) remapAbort(err, params.signal);
    throw err;
  }
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
    try {
      const result = await connector.generateTextDirect({
        apiKey,
        nativeModelId: nativeId,
        system,
        userText,
        imageUrl: params.imageUrl,
        timeoutMs,
        signal,
      });
      const parsed = schema.parse(extractJson(result.text));
      return { output: parsed, text: result.text, usage: result.usage };
    } catch (err) {
      if (isAbortLike(err)) remapAbort(err, params.signal);
      throw err;
    }
  }

  const model = connector.createModel(apiKey, nativeId);
  try {
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
      if (result.text) {
        const parsed = schema.parse(extractJson(result.text));
        return {
          output: parsed,
          text: result.text,
          usage: usageFromSdk(result.usage),
        };
      }
      throw new Error("Model did not return structured output");
    }
    return {
      output: result.output as T,
      text: result.text || JSON.stringify(result.output),
      usage: usageFromSdk(result.usage),
    };
  } catch (err) {
    if (isAbortLike(err)) remapAbort(err, params.signal);
    throw err;
  }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] || text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found");
  return JSON.parse(raw.slice(start, end + 1));
}
