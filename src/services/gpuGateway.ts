import { config, timingSafeEqualString } from "../config.js";
import { logger } from "../logger.js";

export function withInternalSecretHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers || {});
  if (config.internalApiSecret) {
    headers.set("X-Hydrilla-Internal", config.internalApiSecret);
  }
  return { ...init, headers };
}

export class GpuSubmitHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GpuSubmitHttpError";
  }
}

const GPU_SUBMIT_RETRY_DELAYS_MS = [2000, 3000, 5000, 5000, 5000];

function isTransientGpuSubmitError(err: unknown): boolean {
  if (err instanceof GpuSubmitHttpError) {
    if (/queue full/i.test(err.message)) {
      return false;
    }
    return err.status === 502 || err.status === 503 || err.status === 504;
  }
  const msg = err && typeof (err as any).message === "string" ? (err as any).message : "";
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|network/i.test(msg);
}

export async function submitWithGpuRestartRetry<T>(
  submit: () => Promise<T>,
  attempt: number = 0
): Promise<T> {
  try {
    return await submit();
  } catch (err) {
    const delayMs = GPU_SUBMIT_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined || !isTransientGpuSubmitError(err)) {
      throw err;
    }
    logger.warn(
      { attempt: attempt + 1, delayMs, err: (err as any)?.message },
      "GPU VM temporarily unavailable; retrying job submission"
    );
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
    return submitWithGpuRestartRetry(submit, attempt + 1);
  }
}

export async function submitImageTo3dGpu(params: {
  imageUrl?: string;
  imageBuffer?: Buffer;
  filename?: string;
  contentType?: string;
  resolution?: number;
  seed?: number;
  userId: string;
}): Promise<{ jobId: string; jobsAhead?: number }> {
  const resolution = params.resolution ?? 1024;
  const seed = params.seed ?? 42;

  const submitFn = async (): Promise<{ jobId: string; jobsAhead?: number }> => {
    if (params.imageBuffer) {
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(params.imageBuffer)], {
        type: params.contentType || "image/png",
      });
      formData.append("image", blob, params.filename || "image.png");
      formData.append("user_id", params.userId);
      formData.append("resolution", String(resolution));
      formData.append("seed", String(seed));

      const res = await fetch(
        `${config.gpuGateway.url}/image-to-3d`,
        withInternalSecretHeaders({
          method: "POST",
          body: formData,
        })
      );

      if (!res.ok) {
        const text = await res.text();
        throw new GpuSubmitHttpError(res.status, text || `GPU returned status ${res.status}`);
      }

      const data = (await res.json()) as { job_id: string; jobs_ahead?: number };
      return { jobId: data.job_id, jobsAhead: data.jobs_ahead };
    }

    if (params.imageUrl) {
      const formData = new URLSearchParams();
      formData.append("image_url", params.imageUrl);
      formData.append("user_id", params.userId);
      formData.append("resolution", String(resolution));
      formData.append("seed", String(seed));

      const res = await fetch(
        `${config.gpuGateway.url}/image-to-3d`,
        withInternalSecretHeaders({
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formData.toString(),
        })
      );

      if (!res.ok) {
        const text = await res.text();
        throw new GpuSubmitHttpError(res.status, text || `GPU returned status ${res.status}`);
      }

      const data = (await res.json()) as { job_id: string; jobs_ahead?: number };
      return { jobId: data.job_id, jobsAhead: data.jobs_ahead };
    }

    throw new Error("Either imageUrl or imageBuffer is required");
  };

  return submitWithGpuRestartRetry(submitFn);
}

export async function fetchGpuJobStatus(
  jobId: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(
      `${config.gpuGateway.url}/status/${jobId}`,
      withInternalSecretHeaders({
        signal: AbortSignal.timeout(8000),
      })
    );

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err, jobId }, "Failed to fetch GPU status for job");
    return null;
  }
}

export async function cancelGpuJob(jobId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${config.gpuGateway.url}/cancel/${jobId}`,
      withInternalSecretHeaders({
        method: "POST",
        signal: AbortSignal.timeout(5000),
      })
    );
    return res.ok;
  } catch (err) {
    logger.warn({ err, jobId }, "Failed to cancel GPU job");
    return false;
  }
}

export async function fetchGpuQueueInfo(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(
      `${config.gpuGateway.url}/queue/info`,
      withInternalSecretHeaders({
        signal: AbortSignal.timeout(5000),
      })
    );
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
