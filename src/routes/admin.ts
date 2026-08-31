import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { supabase } from "../db.js";
import {
  deletePlatformApiKey,
  getDecryptedPlatformApiKey,
  listPlatformApiKeyMeta,
  savePlatformApiKey,
  setPlatformApiKeyStatus,
} from "../repository/platformApiKeys.js";
import { lookLikeKeyError, providerLabel } from "../lib/userApiKeysCrypto.js";
import { verifyProviderKey } from "../lib/llmProviders.js";
import { publicConnectors, requireProviderParam } from "../providers/index.js";
import { logger } from "../logger.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

function publicKeyMeta(k: Awaited<ReturnType<typeof listPlatformApiKeyMeta>>[number]) {
  return { ...k, label: providerLabel(k.provider) };
}

async function listKeysPayload() {
  const keys = await listPlatformApiKeyMeta();
  return { connectors: publicConnectors(), keys: keys.map(publicKeyMeta) };
}

adminRouter.get("/overview", async (_req, res) => {
  try {
    const [{ count, error }, payload] = await Promise.all([
      supabase.from("users").select("id", { count: "exact", head: true }),
      listKeysPayload(),
    ]);
    if (error) throw error;
    res.json({
      userCount: count ?? 0,
      connectors: payload.connectors,
      keys: payload.keys,
    });
  } catch (err: any) {
    logger.error({ err }, "GET /api/admin/overview failed");
    res.status(500).json({ error: "Failed to load overview" });
  }
});

async function getKeys(_req: unknown, res: any) {
  try {
    res.json(await listKeysPayload());
  } catch (err: any) {
    logger.error({ err }, "GET admin api-keys failed");
    res.status(500).json({ error: "Failed to load Water API keys" });
  }
}

async function putKey(req: any, res: any) {
  try {
    const provider = requireProviderParam(String(req.params.provider || ""));
    if (!provider) {
      return res.status(400).json({ error: "Unsupported provider" });
    }
    const apiKey = String(req.body?.apiKey || "").trim();
    const formatError = lookLikeKeyError(provider, apiKey);
    if (formatError) {
      return res.status(400).json({ error: formatError });
    }

    const meta = await savePlatformApiKey(provider, apiKey);
    const probe = await verifyProviderKey(provider, apiKey);
    await setPlatformApiKeyStatus(
      provider,
      probe.ok ? "valid" : "invalid",
      probe.ok ? null : probe.error || "Verification failed"
    );

    res.json({
      key: {
        ...meta,
        status: probe.ok ? "valid" : "invalid",
        lastError: probe.ok ? null : probe.error || "Verification failed",
        verifiedAt: probe.ok ? new Date().toISOString() : null,
        label: providerLabel(provider),
      },
    });
  } catch (err: any) {
    logger.error({ err }, "PUT admin api-keys failed");
    const msg = String(err?.message || "");
    res.status(500).json({
      error: msg.includes("USER_API_KEYS_ENCRYPTION_SECRET")
        ? "Server missing USER_API_KEYS_ENCRYPTION_SECRET"
        : "Failed to save API key",
    });
  }
}

async function deleteKey(req: any, res: any) {
  try {
    const provider = requireProviderParam(String(req.params.provider || ""));
    if (!provider) {
      return res.status(400).json({ error: "Unsupported provider" });
    }
    await deletePlatformApiKey(provider);
    res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err }, "DELETE admin api-keys failed");
    res.status(500).json({ error: "Failed to remove API key" });
  }
}

async function verifyKey(req: any, res: any) {
  try {
    const provider = requireProviderParam(String(req.params.provider || ""));
    if (!provider) {
      return res.status(400).json({ error: "Unsupported provider" });
    }
    const plaintext = await getDecryptedPlatformApiKey(provider);
    if (!plaintext) {
      return res.status(404).json({ error: "No key saved for this provider" });
    }
    const probe = await verifyProviderKey(provider, plaintext);
    await setPlatformApiKeyStatus(
      provider,
      probe.ok ? "valid" : "invalid",
      probe.ok ? null : probe.error || "Verification failed"
    );
    res.json({
      ok: probe.ok,
      status: probe.ok ? "valid" : "invalid",
      error: probe.ok ? null : probe.error || "Verification failed",
    });
  } catch (err: any) {
    logger.error({ err }, "POST admin api-keys verify failed");
    res.status(500).json({ error: "Verification failed" });
  }
}

adminRouter.get("/api-keys", getKeys);
adminRouter.put("/api-keys/:provider", putKey);
adminRouter.delete("/api-keys/:provider", deleteKey);
adminRouter.post("/api-keys/:provider/verify", verifyKey);

adminRouter.get("/water-keys", getKeys);
adminRouter.put("/water-keys/:provider", putKey);
adminRouter.delete("/water-keys/:provider", deleteKey);
adminRouter.post("/water-keys/:provider/verify", verifyKey);
