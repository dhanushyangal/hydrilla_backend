import { logger } from "../logger.js";

type InFlight3dJob = {
  promise: Promise<{ jobId: string }>;
  startedAt: number;
};

const inFlight3dMap = new Map<string, InFlight3dJob>();
const MAX_IN_FLIGHT_AGE_MS = 60_000; // 60s safety timeout for 3D submissions

function buildDedupKey(userId: string, imageUrl: string): string {
  return `${userId}:3d:${imageUrl.trim().toLowerCase()}`;
}

export async function runDeduplicated3DSubmission(
  userId: string,
  imageUrl: string,
  executor: () => Promise<{ jobId: string }>
): Promise<{ jobId: string; reusedInFlight: boolean }> {
  const key = buildDedupKey(userId, imageUrl);

  const existing = inFlight3dMap.get(key);
  if (existing) {
    if (Date.now() - existing.startedAt < MAX_IN_FLIGHT_AGE_MS) {
      logger.info(
        { userId, imageUrl: imageUrl.slice(0, 60) },
        "Deduplicating rapid 3D submission: reusing in-flight 3D job creation"
      );
      const res = await existing.promise;
      return { jobId: res.jobId, reusedInFlight: true };
    }
    inFlight3dMap.delete(key);
  }

  const jobPromise = executor();
  inFlight3dMap.set(key, { promise: jobPromise, startedAt: Date.now() });

  try {
    const res = await jobPromise;
    return { jobId: res.jobId, reusedInFlight: false };
  } finally {
    inFlight3dMap.delete(key);
  }
}

export function clearInFlight3dJobsForTesting(): void {
  inFlight3dMap.clear();
}
