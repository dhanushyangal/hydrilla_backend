/**
 * In-process cancel registry for Water Studio generations.
 * AbortController stops in-flight LLM fetches; callers mark jobs FAIL.
 */

const controllers = new Map<string, AbortController>();

export const WATER_CANCELLED_MESSAGE = "Cancelled by user";

export function registerWaterCancel(jobId: string): AbortController {
  // Replace any stale controller for the same id
  const existing = controllers.get(jobId);
  if (existing && !existing.signal.aborted) {
    existing.abort();
  }
  const ac = new AbortController();
  controllers.set(jobId, ac);
  return ac;
}

export function getWaterCancelSignal(jobId: string): AbortSignal | undefined {
  return controllers.get(jobId)?.signal;
}

export function cancelWaterJob(jobId: string): boolean {
  const ac = controllers.get(jobId);
  if (!ac) return false;
  if (!ac.signal.aborted) {
    ac.abort();
  }
  return true;
}

export function clearWaterCancel(jobId: string): void {
  controllers.delete(jobId);
}

export function isWaterCancelled(jobId: string): boolean {
  return Boolean(controllers.get(jobId)?.signal.aborted);
}

export function isUserCancelError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Error & { name?: string };
  if (e.name === "AbortError") return true;
  const msg = String(e.message || "");
  return /cancelled by user|The operation was aborted|This operation was aborted|aborted/i.test(
    msg
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error(WATER_CANCELLED_MESSAGE);
  err.name = "AbortError";
  throw err;
}

/** Combine stage timeout with an optional user-cancel signal. */
export function combineAbortSignals(
  timeoutMs: number,
  userSignal?: AbortSignal
): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  if (!userSignal) return timeout;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([timeout, userSignal]);
  }
  const ctrl = new AbortController();
  const onAbort = () => {
    if (!ctrl.signal.aborted) ctrl.abort();
  };
  if (timeout.aborted || userSignal.aborted) {
    ctrl.abort();
    return ctrl.signal;
  }
  timeout.addEventListener("abort", onAbort, { once: true });
  userSignal.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}
