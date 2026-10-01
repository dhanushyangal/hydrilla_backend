import { logger } from "../../logger.js";

type InFlightJob<T> = {
  promise: Promise<T>;
  startedAt: number;
};

const inFlightMap = new Map<string, InFlightJob<unknown>>();
const MAX_IN_FLIGHT_AGE_MS = 200_000; // 3.3 minutes safety GC

function buildDedupKey(
  userId: string,
  op: string,
  prompt: string,
  provider: string,
  quality: string,
  aspect?: string | null
): string {
  return `${userId}:${op}:${provider}:${quality}:${aspect || ""}:${prompt.trim().toLowerCase()}`;
}

export async function runDeduplicatedImageJob<T>(
  userId: string,
  op: string,
  prompt: string,
  provider: string,
  quality: string,
  aspect: string | null | undefined,
  executor: () => Promise<T>
): Promise<{ result: T; reusedInFlight: boolean }> {
  const key = buildDedupKey(userId, op, prompt, provider, quality, aspect);

  const existing = inFlightMap.get(key);
  if (existing) {
    if (Date.now() - existing.startedAt < MAX_IN_FLIGHT_AGE_MS) {
      logger.info(
        { userId, op, provider, prompt: prompt.slice(0, 60) },
        "Deduplicating rapid submission: reusing in-flight image generation"
      );
      const result = (await existing.promise) as T;
      return { result, reusedInFlight: true };
    }
    inFlightMap.delete(key);
  }

  const jobPromise = executor();
  inFlightMap.set(key, { promise: jobPromise, startedAt: Date.now() });

  try {
    const result = await jobPromise;
    return { result, reusedInFlight: false };
  } finally {
    inFlightMap.delete(key);
  }
}

export function clearInFlightImageJobsForTesting(): void {
  inFlightMap.clear();
}
