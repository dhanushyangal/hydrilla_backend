import { Router } from "express";
import { requireAuth, syncUserToDatabase } from "../middleware/auth.js";
import {
  deleteUserApiKey,
  getDecryptedUserApiKey,
  getUserModelPrefs,
  listUserApiKeyMeta,
  saveUserApiKey,
  setUserApiKeyStatus,
  upsertUserModelPrefs,
} from "../repository/userApiKeys.js";
import {
  generateDeveloperApiKey,
  getDeveloperKeyDetails,
  listDeveloperKeysForUser,
  revokeDeveloperApiKey,
} from "../repository/developerApiKeys.js";
import { resolveWaterApiKey } from "../repository/platformApiKeys.js";
import { lookLikeKeyError, providerLabel } from "../lib/userApiKeysCrypto.js";
import {
  fetchCursorModels,
  fetchOpenRouterFreeModels,
  fetchOpenRouterKeyInfo,
  verifyProviderKey,
} from "../lib/llmProviders.js";
import {
  listModelsCached,
  publicConnectors,
  requireProviderParam,
} from "../providers/index.js";
import { canonicalModelId } from "../providers/ids.js";
import { API_KEY_PROVIDERS, type ApiKeyProvider } from "../providers/types.js";
import { logger } from "../logger.js";

export const userRouter = Router();

function keyPayload(k: {
  provider: ApiKeyProvider;
  configured: boolean;
  last4: string | null;
  status: string;
  lastError: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
}) {
  return { ...k, label: providerLabel(k.provider) };
}

userRouter.get("/cursor/models", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const resolved = await resolveWaterApiKey(userId, "cursor");
    if (!resolved) {
      return res.status(404).json({ error: "No Cursor API key saved. Add one in Settings." });
    }
    const models = await fetchCursorModels(resolved.apiKey);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json({
      models,
      syncedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    logger.error({ err }, "GET /api/user/cursor/models failed");
    res.status(502).json({ error: err?.message || "Failed to sync Cursor models" });
  }
});

userRouter.get("/openrouter/free-models", requireAuth, async (_req, res) => {
  try {
    const models = await fetchOpenRouterFreeModels();
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json({ models, syncedAt: new Date().toISOString() });
  } catch (err: any) {
    logger.error({ err }, "GET /api/user/openrouter/free-models failed");
    res.status(502).json({ error: err?.message || "Failed to sync free models" });
  }
});

userRouter.get("/openrouter/key-status", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const resolved = await resolveWaterApiKey(userId, "openrouter");
    if (!resolved) {
      return res.status(404).json({ error: "No OpenRouter key saved" });
    }
    const info = await fetchOpenRouterKeyInfo(resolved.apiKey);
    res.json({ status: info });
  } catch (err: any) {
    logger.error({ err }, "GET /api/user/openrouter/key-status failed");
    res.status(502).json({ error: err?.message || "Failed to load OpenRouter key status" });
  }
});

userRouter.get("/models", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    await syncUserToDatabase(userId);
    const groups = [];
    for (const provider of API_KEY_PROVIDERS) {
      const resolved = await resolveWaterApiKey(userId, provider);
      if (!resolved) continue;
      try {
        const listed = await listModelsCached(provider, resolved.apiKey, resolved.last4);
        groups.push({
          provider,
          name: providerLabel(provider),
          source: resolved.source,
          models: listed.map((m) => ({
            id: canonicalModelId(provider, m.id),
            name: m.name,
            nativeId: m.id,
            free: m.free,
          })),
        });
      } catch (err: any) {
        logger.warn({ err, provider }, "listModels failed");
        groups.push({
          provider,
          name: providerLabel(provider),
          source: resolved.source,
          models: [],
          error: err?.message || "Failed to list models",
        });
      }
    }
    res.setHeader("Cache-Control", "private, max-age=60");
    res.json({ groups, syncedAt: new Date().toISOString() });
  } catch (err: any) {
    logger.error({ err }, "GET /api/user/models failed");
    res.status(500).json({ error: "Failed to load models" });
  }
});

userRouter.get("/api-keys", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    await syncUserToDatabase(userId);
    const keys = await listUserApiKeyMeta(userId);
    const { listPlatformApiKeyMeta } = await import("../repository/platformApiKeys.js");
    const sharedKeys = await listPlatformApiKeyMeta();
    const prefs = await getUserModelPrefs(userId);
    res.json({
      connectors: publicConnectors(),
      keys: keys.map(keyPayload),
      sharedKeys: sharedKeys.map((k) => ({
        provider: k.provider,
        label: providerLabel(k.provider),
        configured: k.configured,
        status: k.status,
        last4: null,
        lastError: null,
        verifiedAt: k.verifiedAt,
        updatedAt: k.updatedAt,
      })),
      prefs,
    });
  } catch (err: any) {
    logger.error({ err }, "GET /api/user/api-keys failed");
    res.status(500).json({
      error: err?.message?.includes("USER_API_KEYS_ENCRYPTION_SECRET")
        ? "Server missing USER_API_KEYS_ENCRYPTION_SECRET"
        : "Failed to load API keys",
    });
  }
});

userRouter.put("/api-keys/:provider", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const provider = requireProviderParam(String(req.params.provider || ""));
    if (!provider) {
      return res.status(400).json({ error: "Unsupported provider" });
    }
    const apiKey = String(req.body?.apiKey || "").trim();
    const formatError = lookLikeKeyError(provider, apiKey);
    if (formatError) {
      return res.status(400).json({ error: formatError });
    }

    await syncUserToDatabase(userId);
    const meta = await saveUserApiKey(userId, provider, apiKey);
    const probe = await verifyProviderKey(provider, apiKey);
    await setUserApiKeyStatus(
      userId,
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
    logger.error({ err }, "PUT /api/user/api-keys failed");
    const msg = String(err?.message || "");
    let error = "Failed to save API key";
    if (msg.includes("USER_API_KEYS_ENCRYPTION_SECRET")) {
      error = "Server missing USER_API_KEYS_ENCRYPTION_SECRET";
    } else if (msg.includes("user_api_keys_provider_check")) {
      error = "Database provider check is missing google. Run sql/007_provider_google.sql in Supabase.";
    } else if (msg) {
      error = msg.slice(0, 240);
    }
    res.status(500).json({ error });
  }
});

userRouter.post("/api-keys/:provider/verify", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const provider = requireProviderParam(String(req.params.provider || ""));
    if (!provider) {
      return res.status(400).json({ error: "Unsupported provider" });
    }
    const plaintext = await getDecryptedUserApiKey(userId, provider);
    if (!plaintext) {
      return res.status(404).json({ error: "No key saved for this provider" });
    }
    const probe = await verifyProviderKey(provider, plaintext);
    await setUserApiKeyStatus(
      userId,
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
    logger.error({ err }, "POST verify api-key failed");
    res.status(500).json({ error: "Verification failed" });
  }
});

userRouter.delete("/api-keys/:provider", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const provider = requireProviderParam(String(req.params.provider || ""));
    if (!provider) {
      return res.status(400).json({ error: "Unsupported provider" });
    }
    await deleteUserApiKey(userId, provider);
    res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err }, "DELETE api-key failed");
    res.status(500).json({ error: "Failed to remove API key" });
  }
});

userRouter.patch("/model-prefs", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    await upsertUserModelPrefs(userId, {
      defaultMeshModel: req.body?.defaultMeshModel,
      defaultCodeModel: req.body?.defaultCodeModel,
      enabledCodeModels:
        req.body?.enabledCodeModels !== undefined ? req.body.enabledCodeModels : undefined,
    });
    const prefs = await getUserModelPrefs(userId);
    res.json({ prefs });
  } catch (err: any) {
    logger.error({ err }, "PATCH model-prefs failed");
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

// ============================================================================
// Developer API Keys (hyd_live_...) for public API usage
// ============================================================================
userRouter.get("/developer-keys", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    await syncUserToDatabase(userId);
    const keys = await listDeveloperKeysForUser(userId);
    res.json({ keys });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to list developer keys";
    logger.error({ err }, "GET /api/user/developer-keys failed");
    res.status(500).json({ error: message });
  }
});

userRouter.get("/developer-keys/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const keyId = req.params.id;
    if (!keyId) {
      res.status(400).json({ error: "Key ID required" });
      return;
    }
    await syncUserToDatabase(userId);
    const details = await getDeveloperKeyDetails(userId, keyId);
    if (!details) {
      res.status(404).json({ error: "Developer API key not found" });
      return;
    }
    res.json({ details });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch developer key details";
    logger.error({ err }, "GET /api/user/developer-keys/:id failed");
    res.status(500).json({ error: message });
  }
});

userRouter.post("/developer-keys", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    await syncUserToDatabase(userId);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "Default API Key";
    const result = await generateDeveloperApiKey(userId, name);
    res.status(201).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to generate developer key";
    logger.error({ err }, "POST /api/user/developer-keys failed");
    res.status(500).json({ error: message });
  }
});

userRouter.delete("/developer-keys/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const keyId = req.params.id;
    if (!keyId) {
      res.status(400).json({ error: "Key ID required" });
      return;
    }
    const success = await revokeDeveloperApiKey(userId, keyId);
    if (!success) {
      res.status(404).json({ error: "Key not found or already revoked" });
      return;
    }
    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to revoke developer key";
    logger.error({ err }, "DELETE /api/user/developer-keys/:id failed");
    res.status(500).json({ error: message });
  }
});

