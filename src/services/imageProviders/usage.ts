import { AsyncLocalStorage } from "node:async_hooks";
import type { ImageProvider } from "./config.js";
import { priceForModel } from "./pricing.js";

export type UsageKind = "image" | "prompt_rewrite";

export type TokenCounts = {
  textInput: number;
  imageInput: number;
  textOutput: number;
  imageOutput: number;
};

export type UsageCall = TokenCounts & {
  kind: UsageKind;
  provider: ImageProvider;
  model: string;
  costUsd: number;
  priced: boolean;
};

export type UsageSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: UsageCall[];
};

const usageStore = new AsyncLocalStorage<UsageCall[]>();

/** Every provider call made inside `fn` appends its token usage to `calls`. */
export function runWithUsage<T>(calls: UsageCall[], fn: () => Promise<T>): Promise<T> {
  return usageStore.run(calls, fn);
}

function roundUsd(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

export function recordUsage(kind: UsageKind, provider: ImageProvider, model: string, tokens: TokenCounts | null) {
  const calls = usageStore.getStore();
  if (!calls || !tokens) {
    return;
  }
  const price = priceForModel(model);
  const cost = price
    ? (tokens.textInput * price.textInput +
        tokens.imageInput * price.imageInput +
        tokens.textOutput * price.textOutput +
        tokens.imageOutput * price.imageOutput) /
      1_000_000
    : 0;
  calls.push({ kind, provider, model, ...tokens, costUsd: roundUsd(cost), priced: price !== null });
}

export function summarizeUsage(calls: UsageCall[]): UsageSummary {
  const inputTokens = calls.reduce((sum, c) => sum + c.textInput + c.imageInput, 0);
  const outputTokens = calls.reduce((sum, c) => sum + c.textOutput + c.imageOutput, 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: roundUsd(calls.reduce((sum, c) => sum + c.costUsd, 0)),
    calls,
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Sums `[{ modality, tokenCount|tokens|token_count }]` into text vs image buckets. */
function splitByModality(details: unknown): { text: number; image: number } | null {
  if (!Array.isArray(details) || details.length === 0) {
    return null;
  }
  return details.reduce(
    (acc: { text: number; image: number }, d: any) => {
      const count = num(d?.tokenCount ?? d?.tokens ?? d?.token_count);
      const isImage = String(d?.modality || "").toUpperCase() === "IMAGE";
      return isImage ? { ...acc, image: acc.image + count } : { ...acc, text: acc.text + count };
    },
    { text: 0, image: 0 }
  );
}

/** OpenAI /images/generations and /images/edits `usage`. Output tokens are image tokens. */
export function openAIImageUsage(usage: any): TokenCounts | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const inDetails = usage.input_tokens_details;
  const outDetails = usage.output_tokens_details;
  const inputTotal = num(usage.input_tokens);
  const outputTotal = num(usage.output_tokens);
  const imageInput = num(inDetails?.image_tokens);
  const textInput = inDetails ? num(inDetails.text_tokens) : inputTotal;
  const textOutput = num(outDetails?.text_tokens);
  const imageOutput = outDetails && outDetails.image_tokens != null ? num(outDetails.image_tokens) : outputTotal - textOutput;
  return { textInput, imageInput, textOutput, imageOutput: Math.max(0, imageOutput) };
}

/** OpenAI /chat/completions `usage`. */
export function openAIChatUsage(usage: any): TokenCounts | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  return {
    textInput: num(usage.prompt_tokens),
    imageInput: 0,
    textOutput: num(usage.completion_tokens),
    imageOutput: 0,
  };
}

/** Gemini generateContent `usageMetadata`. Thinking tokens bill as text output. */
export function geminiUsageMetadata(meta: any, outputIsImage: boolean): TokenCounts | null {
  if (!meta || typeof meta !== "object") {
    return null;
  }
  const prompt = splitByModality(meta.promptTokensDetails);
  const candidates = splitByModality(meta.candidatesTokensDetails);
  const candidateTotal = num(meta.candidatesTokenCount);
  const thoughts = num(meta.thoughtsTokenCount);
  const output = candidates ?? (outputIsImage ? { text: 0, image: candidateTotal } : { text: candidateTotal, image: 0 });
  return {
    textInput: prompt ? prompt.text : num(meta.promptTokenCount),
    imageInput: prompt ? prompt.image : 0,
    textOutput: output.text + thoughts,
    imageOutput: output.image,
  };
}

/** Gemini Interactions API `usage` (field names vary by API revision, so read defensively). */
export function geminiInteractionsUsage(body: any): TokenCounts | null {
  if (body?.usageMetadata) {
    return geminiUsageMetadata(body.usageMetadata, true);
  }
  const usage = body?.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const input = splitByModality(usage.input_tokens_by_modality);
  const output = splitByModality(usage.output_tokens_by_modality);
  const inputTotal = num(usage.total_input_tokens ?? usage.input_tokens);
  const outputTotal = num(usage.total_output_tokens ?? usage.output_tokens);
  const thoughts = num(usage.total_thought_tokens ?? usage.thought_tokens);
  return {
    textInput: input ? input.text : inputTotal,
    imageInput: input ? input.image : 0,
    textOutput: (output ? output.text : 0) + thoughts,
    imageOutput: output ? output.image : outputTotal,
  };
}
