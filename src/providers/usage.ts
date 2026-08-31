import type { LlmTokenUsage } from "./types.js";

export function emptyTokenUsage(): LlmTokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function hasReportedTokenUsage(u: LlmTokenUsage | null | undefined): boolean {
  if (!u) return false;
  return u.inputTokens > 0 || u.outputTokens > 0 || u.totalTokens > 0;
}

export function addTokenUsage(a: LlmTokenUsage, b: LlmTokenUsage | null | undefined): LlmTokenUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + (b.inputTokens || 0),
    outputTokens: a.outputTokens + (b.outputTokens || 0),
    totalTokens: a.totalTokens + (b.totalTokens || 0),
  };
}

export function usageFromCounts(input: number, output: number): LlmTokenUsage | null {
  const inputTokens = Math.max(0, Math.floor(input || 0));
  const outputTokens = Math.max(0, Math.floor(output || 0));
  if (inputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function usageFromSdk(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} | undefined): LlmTokenUsage | null {
  if (!usage) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? input + output;
  if (input === 0 && output === 0 && total === 0) return null;
  return {
    inputTokens: Math.max(0, Math.floor(input)),
    outputTokens: Math.max(0, Math.floor(output)),
    totalTokens: Math.max(0, Math.floor(total)),
  };
}
