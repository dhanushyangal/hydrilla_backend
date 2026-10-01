import { Router } from "express";
import { config } from "../config.js";
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

async function fetchVmSystem(): Promise<{ reachable: boolean; data: unknown; error: string | null }> {
  try {
    const res = await fetch(
      `${config.gpuGateway.url}/admin/system`,
      withInternalSecretHeaders({ signal: AbortSignal.timeout(8000) })
    );
    if (!res.ok) {
      return { reachable: false, data: null, error: `GPU service returned ${res.status}` };
    }
    return { reachable: true, data: await res.json(), error: null };
  } catch (err) {
    return { reachable: false, data: null, error: errorMessage(err) };
  }
}

async function fetchInstance(): Promise<{ configured: boolean; data: unknown; error: string | null }> {
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
      })
    );
    const body = (await vmRes.json().catch(() => ({}))) as { detail?: string; message?: string; status?: string };
    if (!vmRes.ok) {
      return res.status(502).json({ error: body.detail || `GPU service returned ${vmRes.status}` });
    }
    logger.info({ mode, result: body.status }, "Admin requested GPU service restart");
    return res.json(body);
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, "Admin GPU restart failed");
    return res.status(502).json({
      error: "GPU service is not reachable. If the instance is stopped, start it first.",
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
      })
    );
    const body = (await vmRes.json().catch(() => ({}))) as Record<string, unknown>;
    if (!vmRes.ok) {
      return res.status(502).json({ error: (body.detail as string) || `GPU service returned ${vmRes.status}` });
    }
    return res.json(body);
  } catch (err) {
    return res.status(502).json({ error: errorMessage(err) });
  }
});

adminGpuRouter.post("/instance/:action", async (req, res) => {
  const action = String(req.params.action) as GcpInstanceAction;
  if (!INSTANCE_ACTIONS.includes(action)) {
    return res.status(400).json({ error: "action must be start, stop, or reset" });
  }
  if (!isGcpComputeConfigured()) {
    return res.status(400).json({ error: "GCP_SERVICE_ACCOUNT_KEY is not configured on the backend" });
  }
  try {
    const operation = await runGpuInstanceAction(action);
    logger.info({ action, operation }, "Admin GPU instance action");
    return res.json({ ok: true, action, operation });
  } catch (err) {
    logger.error({ err: errorMessage(err), action }, "Admin GPU instance action failed");
    return res.status(502).json({ error: errorMessage(err) });
  }
});
