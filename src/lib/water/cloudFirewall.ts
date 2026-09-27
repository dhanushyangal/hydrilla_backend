/**
 * Cloud firewall — Water agent modules must never run on Hydrilla GPU jobs.
 *
 * Do not import this from routes/threeD.ts. Cloud generate stays /api/3d/*.
 */

import { parseWaterModelId } from "../../providers/ids.js";
import { isHydrillaCloudEngine, isWaterEngine } from "../engines.js";

export class CloudFirewallError extends Error {
  readonly code = "cloud_firewall";
  constructor(message = "This Water agent path is BYOK only. Cloud generate is unchanged.") {
    super(message);
    this.name = "CloudFirewallError";
  }
}

/** True when the request is a Water BYOK model id, never hydrilla/trilles. */
export function isWaterByokModel(modelId?: string | null): boolean {
  const parsed = parseWaterModelId(String(modelId || "").trim());
  return Boolean(parsed);
}

export function assertWaterByokModel(modelId?: string | null): void {
  if (!isWaterByokModel(modelId)) {
    throw new CloudFirewallError();
  }
}

export function assertWaterJobEngine(engine?: string | null): void {
  if (isHydrillaCloudEngine(engine) || (!isWaterEngine(engine) && engine && engine !== "water")) {
    throw new CloudFirewallError("Cloud jobs cannot enter the Water agent engine.");
  }
}
