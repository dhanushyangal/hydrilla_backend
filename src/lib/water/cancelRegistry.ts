/**
 * In-process cancel registry for Water Studio generations.
 * AbortController stops in-flight LLM fetches; callers mark jobs FAIL.
 *
 * Timeout aborts are NOT user cancels. Standard/Studio stages routinely hit
 * AbortSignal.timeout; treating those as "Cancelled by user" killed real jobs.
 */

const controllers = new Map<string, AbortController>();

export const WATER_CANCELLED_MESSAGE = "Cancelled by user";
export const USER_CANCEL_REASON = "user-cancel";
export const STAGE_TIMEOUT_REASON = "stage-timeout";

export function registerWaterCancel(jobId: string): AbortController {
  const existing = controllers.get(jobId);
  if (existing && !existing.signal.aborted) {
    existing.abort(STAGE_TIMEOUT_REASON);
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
    ac.abort(USER_CANCEL_REASON);
  }
  return true;
}

export function clearWaterCancel(jobId: string): void {
  controllers.delete(jobId);
}

export function isWaterCancelled(jobId: string): boolean {
  const ac = controllers.get(jobId);
  if (!ac?.signal.aborted) return false;
  return abortReasonName(ac.signal.reason) === USER_CANCEL_REASON;
}

function abortReasonName(reason: unknown): string {
  if (reason == null) return "";
  if (typeof reason === "string") return reason;
  if (typeof reason === "object") {
    const r = reason as { name?: string; message?: string };
    if (r.name) return r.name;
    if (r.message) return r.message;
  }
  return String(reason);
}

/** True only when the user hit Cancel — never for LLM/stage timeouts. */
export function isUserCancelError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (isTimeoutAbort(err)) return false;
  const e = err as Error & { cause?: unknown };
  if (e.message === WATER_CANCELLED_MESSAGE) return true;
  const names = [abortReasonName(e), abortReasonName(e.cause)];
  if (names.some((n) => n === USER_CANCEL_REASON || n === WATER_CANCELLED_MESSAGE)) {
    return true;
  }
  return false;
}

export function isTimeoutAbort(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Error & { cause?: unknown; name?: string };
  const blob = `${e.name || ""} ${e.message || ""} ${abortReasonName(e.cause)}`;
  if (/stage-timeout|TimeoutError|timeout/i.test(blob) && !/cancelled by user/i.test(blob)) {
    return true;
  }
  return abortReasonName((err as { cause?: unknown }).cause) === STAGE_TIMEOUT_REASON;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = abortReasonName(signal.reason);
  if (reason === STAGE_TIMEOUT_REASON || /timeout/i.test(reason)) {
    const err = new Error("Stage timed out");
    err.name = "TimeoutError";
    throw err;
  }
  const err = new Error(WATER_CANCELLED_MESSAGE);
  err.name = "AbortError";
  throw err;
}

/** Combine stage timeout with an optional user-cancel signal. Reasons stay distinct. */
export function combineAbortSignals(
  timeoutMs: number,
  userSignal?: AbortSignal
): AbortSignal {
  const ctrl = new AbortController();
  const abortWith = (reason: unknown) => {
    if (!ctrl.signal.aborted) ctrl.abort(reason);
  };

  if (userSignal?.aborted) {
    abortWith(userSignal.reason ?? USER_CANCEL_REASON);
    return ctrl.signal;
  }

  const timer = setTimeout(() => {
    abortWith(STAGE_TIMEOUT_REASON);
  }, Math.max(1, timeoutMs));

  const onUser = () => {
    clearTimeout(timer);
    abortWith(userSignal?.reason ?? USER_CANCEL_REASON);
  };
  userSignal?.addEventListener("abort", onUser, { once: true });
  ctrl.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      userSignal?.removeEventListener("abort", onUser);
    },
    { once: true }
  );

  return ctrl.signal;
}
