import crypto from "crypto";
import fs from "fs";
import { execSync } from "child_process";
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

export type GcpInstanceListItem = GcpInstanceInfo & {
  zone: string;
  isTarget: boolean;
  hasStaticIp: boolean;
  staticIpName?: string | null;
};

export type StaticIpInfo = {
  name: string;
  address: string;
  attachedToInstance: string | null;
  status: string;
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

function getGcloudAccessToken(): string | null {
  try {
    const token = execSync("gcloud auth print-access-token", {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (token) {
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

export function isGcpComputeConfigured(): boolean {
  if (parseServiceAccountKey(config.gcpGpuInstance.serviceAccountKey) !== null) {
    return true;
  }
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60_000) {
    return true;
  }
  return getGcloudAccessToken() !== null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

async function getAccessToken(): Promise<string> {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }
  const key = parseServiceAccountKey(config.gcpGpuInstance.serviceAccountKey);
  if (key) {
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
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new Error(`GCP auth failed: ${body.error_description || res.statusText}`);
    }
    cachedToken.value = body.access_token;
    cachedToken.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return body.access_token;
  }

  // Fallback to local gcloud credentials if running in local environment
  const gcloudToken = getGcloudAccessToken();
  if (gcloudToken) {
    cachedToken.value = gcloudToken;
    cachedToken.expiresAt = Date.now() + 1800 * 1000;
    return gcloudToken;
  }

  throw new Error("GCP credentials not configured (set GCP_SERVICE_ACCOUNT_KEY or login via gcloud)");
}

function computeBaseUrl(): string {
  const { projectId, zone } = config.gcpGpuInstance;
  return `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}`;
}

function regionBaseUrl(): string {
  const { projectId, zone } = config.gcpGpuInstance;
  const region = zone.split("-").slice(0, 2).join("-");
  return `https://compute.googleapis.com/compute/v1/projects/${projectId}/regions/${region}`;
}

function instanceUrl(suffix = "", instanceName?: string): string {
  const target = instanceName || config.gcpGpuInstance.instance;
  if (!target) {
    throw new Error("No GCP GPU instance configured. Please select a target instance in the Admin Panel.");
  }
  return `${computeBaseUrl()}/instances/${target}${suffix}`;
}

async function computeRequest(url: string, method: "GET" | "POST", body?: unknown): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const resBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GCP Compute ${method} failed (${res.status}): ${resBody?.error?.message || res.statusText}`);
  }
  return resBody;
}

async function waitForZoneOperation(operationName: string): Promise<void> {
  const { projectId, zone } = config.gcpGpuInstance;
  const url = `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/operations/${operationName}`;
  const start = Date.now();
  const poll = async (): Promise<void> => {
    if (Date.now() - start > 90_000) {
      throw new Error(`Timed out waiting for GCP operation ${operationName}`);
    }
    const op = await computeRequest(url, "GET");
    if (op.status === "DONE") {
      if (op.error) {
        const msg = op.error.errors?.[0]?.message || "GCP Operation failed";
        throw new Error(msg);
      }
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });
    return poll();
  };
  return poll();
}

function lastPathSegment(url: unknown): string | null {
  return typeof url === "string" ? url.split("/").pop() || null : null;
}

function parseInstanceRaw(raw: any): GcpInstanceInfo {
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

export async function getGpuInstanceInfo(instanceName?: string): Promise<GcpInstanceInfo | null> {
  const target = instanceName || config.gcpGpuInstance.instance;
  if (!target) {
    return null;
  }
  const raw = await computeRequest(instanceUrl("", target), "GET");
  return parseInstanceRaw(raw);
}

export async function getStaticAddresses(): Promise<StaticIpInfo[]> {
  try {
    const res = await computeRequest(`${regionBaseUrl()}/addresses`, "GET");
    const items = Array.isArray(res.items) ? res.items : [];
    return items.map((a: any) => {
      const attachedUser = Array.isArray(a.users) && a.users[0] ? a.users[0] : null;
      return {
        name: a.name,
        address: a.address,
        status: a.status,
        attachedToInstance: lastPathSegment(attachedUser),
      };
    });
  } catch (err) {
    return [];
  }
}

export async function getStaticIpInfo(): Promise<StaticIpInfo | null> {
  const addresses = await getStaticAddresses();
  const primary = addresses.find((a) => {
    return a.name === "hydrilla-ip" || a.address === "35.244.62.144";
  });
  if (primary) {
    return primary;
  }
  return addresses[0] ?? null;
}

export async function listGpuInstances(): Promise<GcpInstanceListItem[]> {
  const [instancesRes, addresses] = await Promise.all([
    computeRequest(`${computeBaseUrl()}/instances`, "GET"),
    getStaticAddresses(),
  ]);
  const items = Array.isArray(instancesRes.items) ? instancesRes.items : [];
  return items.map((raw: any) => {
    const info = parseInstanceRaw(raw);
    const matchedStatic = addresses.find((a) => {
      return a.address === info.externalIp || a.attachedToInstance === info.name;
    });
    return {
      ...info,
      zone: config.gcpGpuInstance.zone,
      isTarget: info.name === config.gcpGpuInstance.instance,
      hasStaticIp: Boolean(matchedStatic),
      staticIpName: matchedStatic?.name ?? null,
    };
  });
}

/**
 * Shifts the permanent reserved static IP (35.244.62.144 / hydrilla-ip)
 * to the specified target instance without starting either VM.
 */
export async function shiftStaticIp(targetInstanceName: string): Promise<{
  success: boolean;
  message: string;
  attachedTo: string;
  address: string;
}> {
  const staticIp = await getStaticIpInfo();
  if (!staticIp) {
    throw new Error("Permanent reserved IP (hydrilla-ip) not found in GCP region");
  }

  const ipAddress = staticIp.address;
  const currentOwner = staticIp.attachedToInstance;

  if (currentOwner === targetInstanceName) {
    return {
      success: true,
      message: `Permanent IP ${ipAddress} is already attached to ${targetInstanceName}.`,
      attachedTo: targetInstanceName,
      address: ipAddress,
    };
  }

  // Step 1: If current owner exists and is different from target, detach from current owner
  if (currentOwner && currentOwner !== targetInstanceName) {
    const ownerInst = await computeRequest(instanceUrl("", currentOwner), "GET");
    const currentAccessConfigs = ownerInst.networkInterfaces?.[0]?.accessConfigs ?? [];
    if (currentAccessConfigs.length > 0) {
      const configName = currentAccessConfigs[0].name;
      const delOp = await computeRequest(
        instanceUrl(`/deleteAccessConfig?accessConfig=${encodeURIComponent(configName)}&networkInterface=nic0`, currentOwner),
        "POST"
      );
      if (delOp.name) {
        await waitForZoneOperation(delOp.name);
      }
      // Re-add an ephemeral NAT config on the previous instance so it keeps standard internet config
      const addEphemeralOp = await computeRequest(
        instanceUrl(`/addAccessConfig?networkInterface=nic0`, currentOwner),
        "POST",
        {
          name: "external-nat",
          networkTier: "PREMIUM",
          type: "ONE_TO_ONE_NAT",
        }
      );
      if (addEphemeralOp.name) {
        await waitForZoneOperation(addEphemeralOp.name);
      }
    }
  }

  // Step 2: Ensure targetInstance doesn't already have an active accessConfig conflict
  const targetInst = await computeRequest(instanceUrl("", targetInstanceName), "GET");
  const targetAccessConfigs = targetInst.networkInterfaces?.[0]?.accessConfigs ?? [];
  if (targetAccessConfigs.length > 0) {
    const configName = targetAccessConfigs[0].name;
    const delTargetOp = await computeRequest(
      instanceUrl(`/deleteAccessConfig?accessConfig=${encodeURIComponent(configName)}&networkInterface=nic0`, targetInstanceName),
      "POST"
    );
    if (delTargetOp.name) {
      await waitForZoneOperation(delTargetOp.name);
    }
  }

  // Step 3: Attach the permanent static IP to targetInstance
  const addStaticOp = await computeRequest(
    instanceUrl(`/addAccessConfig?networkInterface=nic0`, targetInstanceName),
    "POST",
    {
      name: "External NAT",
      natIP: ipAddress,
      networkTier: "PREMIUM",
      type: "ONE_TO_ONE_NAT",
    }
  );
  if (addStaticOp.name) {
    await waitForZoneOperation(addStaticOp.name);
  }

  return {
    success: true,
    message: `Permanent IP ${ipAddress} successfully attached to ${targetInstanceName}. Neither VM was started.`,
    attachedTo: targetInstanceName,
    address: ipAddress,
  };
}

/** start / stop / reset (hard reboot). Returns the GCP operation name. */
export async function runGpuInstanceAction(action: GcpInstanceAction, instanceName?: string): Promise<string> {
  const target = instanceName || config.gcpGpuInstance.instance;
  if (!target) {
    throw new Error("No target GPU instance specified. Please select a target instance in the Admin Panel.");
  }
  const suffix = action === "stop" ? "/stop?discardLocalSsd=true" : `/${action}`;
  const op = await computeRequest(instanceUrl(suffix, target), "POST");
  return String(op?.name || "");
}
