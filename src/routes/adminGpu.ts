import { Router } from "express";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { logger } from "../logger.js";
import {
  getGpuInstanceInfo,
  isGcpComputeConfigured,
  runGpuInstanceAction,
  type GcpInstanceAction,
} from "../services/gcpCompute.js";
import { withInternalSecretHeaders } from "./threeD.js";

/** Mounted under /api/admin (already requireAuth + requireAdmin). */
export const adminGpuRouter = Router();

const INSTANCE_ACTIONS: GcpInstanceAction[] = ["start", "stop", "reset"];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchVmSystem(): Promise<{
  reachable: boolean;
  data: unknown;
  error: string | null;
}> {
  try {
    const res = await fetch(
      `${config.gpuGateway.url}/admin/system`,
      withInternalSecretHeaders({ signal: AbortSignal.timeout(8000) }),
    );
    if (!res.ok) {
      return {
        reachable: false,
        data: null,
        error: `GPU service returned ${res.status}`,
      };
    }
    return { reachable: true, data: await res.json(), error: null };
  } catch (err) {
    return { reachable: false, data: null, error: errorMessage(err) };
  }
}

async function fetchInstance(): Promise<{
  configured: boolean;
  data: unknown;
  error: string | null;
}> {
  if (!isGcpComputeConfigured()) {
    return { configured: false, data: null, error: null };
  }
  try {
    return { configured: true, data: await getGpuInstanceInfo(), error: null };
  } catch (err) {
    return { configured: true, data: null, error: errorMessage(err) };
  }
}

adminGpuRouter.get("/", async (_req, res) => {
  const [vm, instance] = await Promise.all([fetchVmSystem(), fetchInstance()]);
  res.json({
    gateway: config.gpuGateway.url,
    instanceName: config.gcpGpuInstance.instance,
    zone: config.gcpGpuInstance.zone,
    vm,
    instance,
    checkedAt: new Date().toISOString(),
  });
});

adminGpuRouter.post("/restart", async (req, res) => {
  const mode = req.body?.mode === "now" ? "now" : "when_idle";
  try {
    const vmRes = await fetch(
      `${config.gpuGateway.url}/admin/restart`,
      withInternalSecretHeaders({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
        signal: AbortSignal.timeout(10_000),
      }),
    );
    const body = (await vmRes.json().catch(() => ({}))) as {
      detail?: string;
      message?: string;
      status?: string;
    };
    if (!vmRes.ok) {
      return res
        .status(502)
        .json({ error: body.detail || `GPU service returned ${vmRes.status}` });
    }
    logger.info(
      { mode, result: body.status },
      "Admin requested GPU service restart",
    );
    return res.json(body);
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, "Admin GPU restart failed");
    return res.status(502).json({
      error:
        "GPU service is not reachable. If the instance is stopped, start it first.",
    });
  }
});

adminGpuRouter.post("/trim-memory", async (_req, res) => {
  try {
    const vmRes = await fetch(
      `${config.gpuGateway.url}/admin/trim-memory`,
      withInternalSecretHeaders({
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      }),
    );
    const body = (await vmRes.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!vmRes.ok) {
      return res
        .status(502)
        .json({
          error:
            (body.detail as string) || `GPU service returned ${vmRes.status}`,
        });
    }
    return res.json(body);
  } catch (err) {
    return res.status(502).json({ error: errorMessage(err) });
  }
});

adminGpuRouter.post("/clear-queue", async (_req, res) => {
  try {
    const clearedTracker = { count: 0 };

    // 1. Fetch current GPU system info to identify the active generation job (if any)
    const sysRes = await fetch(
      `${config.gpuGateway.url}/admin/system`,
      withInternalSecretHeaders({ signal: AbortSignal.timeout(5000) }),
    ).catch(() => null);

    const currentlyProcessingId = await (async () => {
      if (!sysRes || !sysRes.ok) {
        return null;
      }
      const sysData = (await sysRes.json().catch(() => ({}))) as {
        queue?: { processing_job_id?: string | null; waiting_jobs?: number };
      };
      return sysData.queue?.processing_job_id || null;
    })();

    // 2. Call native VM clear-queue endpoint (purges waiting jobs in job_queue only, leaves active job alone)
    const vmRes = await fetch(
      `${config.gpuGateway.url}/admin/clear-queue`,
      withInternalSecretHeaders({
        method: "POST",
        signal: AbortSignal.timeout(8000),
      }),
    ).catch(() => null);

    const vmClearedIds = await (async () => {
      if (!vmRes || !vmRes.ok) {
        return [] as string[];
      }
      const vmBody = (await vmRes.json().catch(() => ({}))) as {
        cleared_jobs?: number;
        cleared_job_ids?: string[];
      };
      clearedTracker.count += vmBody.cleared_jobs || 0;
      if (Array.isArray(vmBody.cleared_job_ids)) {
        return vmBody.cleared_job_ids;
      }
      return [];
    })();

    // 3. Find any queued/waiting jobs in Supabase from the last 48 hours (ONLY status "WAIT", never active running jobs)
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: pendingJobs } = await supabase
      .from("jobs")
      .select("id, status, user_id, credits_used")
      .eq("status", "WAIT")
      .gte("created_at", cutoff);

    // Ensure currently running job is strictly excluded
    const waitingList = (pendingJobs || []).filter((job) => {
      return job.id !== currentlyProcessingId;
    });

    if (waitingList.length > 0) {
      await Promise.allSettled(
        waitingList.map(async (job) => {
          if (vmClearedIds.includes(job.id)) {
            return;
          }
          return fetch(
            `${config.gpuGateway.url}/cancel/${job.id}`,
            withInternalSecretHeaders({
              method: "POST",
              signal: AbortSignal.timeout(5000),
            }),
          ).catch(() => null);
        }),
      );

      await supabase
        .from("jobs")
        .update({
          status: "FAILED",
          error_code: "CANCELLED",
          error_message: "Job cancelled by admin (queue cleared)",
          updated_at: new Date().toISOString(),
        })
        .in(
          "id",
          waitingList.map((j) => j.id),
        );

      // Refund credits for cancelled waiting jobs
      const { refundCredit } = await import("../services/credits.js");
      await Promise.allSettled(
        waitingList.map(async (job) => {
          const creditsToRefund = job.credits_used ?? 0;
          if (creditsToRefund > 0 && job.user_id) {
            await refundCredit(job.user_id, creditsToRefund).catch(() => null);
          }
        }),
      );

      // Add to tracker if not already counted by vmClearedIds
      for (const w of waitingList) {
        if (!vmClearedIds.includes(w.id)) {
          clearedTracker.count += 1;
        }
      }
    }

    // 4. Also scan recent user jobs on GPU gateway for any lingering pending (waiting) items
    const userIds = Array.from(
      new Set(waitingList.map((j) => j.user_id).filter(Boolean)),
    );
    for (const uid of userIds) {
      const uRes = await fetch(
        `${config.gpuGateway.url}/jobs/user/${uid}`,
        withInternalSecretHeaders({ signal: AbortSignal.timeout(5000) }),
      ).catch(() => null);
      if (uRes && uRes.ok) {
        const uData = (await uRes.json().catch(() => ({}))) as {
          jobs?: Array<{ job_id: string; status: string }>;
        };
        // ONLY cancel 'pending' waiting jobs; NEVER cancel 'processing' (the active job)
        const pendingOnVm = (uData.jobs || []).filter((j) => {
          return j.status === "pending" && j.job_id !== currentlyProcessingId;
        });
        for (const pj of pendingOnVm) {
          if (
            !vmClearedIds.includes(pj.job_id) &&
            !waitingList.some((w) => w.id === pj.job_id)
          ) {
            await fetch(
              `${config.gpuGateway.url}/cancel/${pj.job_id}`,
              withInternalSecretHeaders({
                method: "POST",
                signal: AbortSignal.timeout(5000),
              }),
            ).catch(() => null);
            clearedTracker.count += 1;
          }
        }
      }
    }

    const totalCleared = clearedTracker.count;
    logger.info(
      { totalCleared, keptRunningJobId: currentlyProcessingId },
      "Admin cleared GPU queue (active job preserved)",
    );

    const message = (() => {
      if (totalCleared > 0) {
        if (currentlyProcessingId) {
          return `Successfully cleared ${totalCleared} waiting job(s) from the queue. Currently active generation is still running.`;
        }
        return `Successfully cleared ${totalCleared} waiting job(s) from the queue`;
      }
      if (currentlyProcessingId) {
        return "Queue is empty. Active job is currently running on the GPU.";
      }
      return "Queue is already empty";
    })();

    return res.json({
      status: "ok",
      cleared_jobs: totalCleared,
      active_job_id: currentlyProcessingId,
      message,
    });
  } catch (err) {
    logger.error({ err: errorMessage(err) }, "Failed to clear GPU queue");
    return res.status(500).json({ error: errorMessage(err) });
  }
});

adminGpuRouter.post("/instance/:action", async (req, res) => {
  const action = String(req.params.action) as GcpInstanceAction;
  if (!INSTANCE_ACTIONS.includes(action)) {
    return res
      .status(400)
      .json({ error: "action must be start, stop, or reset" });
  }
  if (!isGcpComputeConfigured()) {
    return res
      .status(400)
      .json({
        error: "GCP_SERVICE_ACCOUNT_KEY is not configured on the backend",
      });
  }
  try {
    const operation = await runGpuInstanceAction(action);
    logger.info({ action, operation }, "Admin GPU instance action");
    return res.json({ ok: true, action, operation });
  } catch (err) {
    logger.error(
      { err: errorMessage(err), action },
      "Admin GPU instance action failed",
    );
    return res.status(502).json({ error: errorMessage(err) });
  }
});
