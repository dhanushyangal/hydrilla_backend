import crypto from "crypto";
import fs from "fs";
import { config } from "../config.js";

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export type GcpInstanceInfo = {
  name: string;
  status: string;
  machineType: string | null;
  gpus: { type: string; count: number }[];
  lastStartTimestamp: string | null;
  lastStopTimestamp: string | null;
  externalIp: string | null;
};

export type GcpInstanceAction = "start" | "stop" | "reset";

const COMPUTE_SCOPE = "https://www.googleapis.com/auth/compute";
const cachedToken: { value: string | null; expiresAt: number } = { value: null, expiresAt: 0 };

function parseServiceAccountKey(raw: string): ServiceAccountKey | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  const jsonText = (() => {
    if (trimmed.startsWith("{")) {
      return trimmed;
    }
    if (fs.existsSync(trimmed)) {
      try {
        return fs.readFileSync(trimmed, "utf8");
      } catch {
        // fall through to base64
      }
    }
    try {
      return Buffer.from(trimmed, "base64").toString("utf8");
    } catch {
      return "";
    }
  })();

  try {
    const parsed = JSON.parse(jsonText) as ServiceAccountKey;
    if (!parsed.client_email || !parsed.private_key) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function isGcpComputeConfigured(): boolean {
  return parseServiceAccountKey(config.gcpGpuInstance.serviceAccountKey) !== null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

async function getAccessToken(): Promise<string> {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }
  const key = parseServiceAccountKey(config.gcpGpuInstance.serviceAccountKey);
  if (!key) {
    throw new Error("GCP_SERVICE_ACCOUNT_KEY is not configured");
  }
  const tokenUri = key.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: key.client_email, scope: COMPUTE_SCOPE, aud: tokenUri, iat: now, exp: now + 3600 })
  );
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key);
  const assertion = `${header}.${claims}.${base64url(signature)}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`GCP auth failed: ${body.error_description || res.statusText}`);
  }
  cachedToken.value = body.access_token;
  cachedToken.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
  return body.access_token;
}

function instanceUrl(suffix = ""): string {
  const { projectId, zone, instance } = config.gcpGpuInstance;
  return `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${instance}${suffix}`;
}

async function computeRequest(url: string, method: "GET" | "POST"): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GCP Compute ${method} failed (${res.status}): ${body?.error?.message || res.statusText}`);
  }
  return body;
}

function lastPathSegment(url: unknown): string | null {
  return typeof url === "string" ? url.split("/").pop() || null : null;
}

export async function getGpuInstanceInfo(): Promise<GcpInstanceInfo> {
  const raw = await computeRequest(instanceUrl(), "GET");
  const accelerators = Array.isArray(raw.guestAccelerators) ? raw.guestAccelerators : [];
  const accessConfigs = raw.networkInterfaces?.[0]?.accessConfigs ?? [];
  return {
    name: raw.name,
    status: raw.status,
    machineType: lastPathSegment(raw.machineType),
    gpus: accelerators.map((a: any) => ({
      type: lastPathSegment(a.acceleratorType) || "unknown",
      count: Number(a.acceleratorCount) || 0,
    })),
    lastStartTimestamp: raw.lastStartTimestamp ?? null,
    lastStopTimestamp: raw.lastStopTimestamp ?? null,
    externalIp: accessConfigs[0]?.natIP ?? null,
  };
}

/** start / stop / reset (hard reboot). Returns the GCP operation name. */
export async function runGpuInstanceAction(action: GcpInstanceAction): Promise<string> {
  const op = await computeRequest(instanceUrl(`/${action}`), "POST");
  return String(op?.name || "");
}
