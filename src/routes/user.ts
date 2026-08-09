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
  isApiKeyProvider,
  lookLikeKeyError,
  providerLabel,
} from "../lib/userApiKeysCrypto.js";
import {
  fetchCursorModels,
  fetchOpenRouterFreeModels,
  fetchOpenRouterKeyInfo,
  verifyProviderKey,
} from "../lib/llmProviders.js";
import { logger } from "../logger.js";

export const userRouter = Router();

/**
 * Live Cursor Cloud Agents models for the picker (requires a saved Cursor key).
 * GET https://api.cursor.com/v1/models
 */
userRouter.get("/cursor/models", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const plaintext = await getDecryptedUserApiKey(userId, "cursor");
    if (!plaintext) {
      return res.status(404).json({ error: "No Cursor API key saved. Add one in Settings." });
    }
    const models = await fetchCursorModels(plaintext);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json({
      models,
      syncedAt: new Date().toISOString(),
      note:
        "From Cursor GET /v1/models for your key. Pass these ids as model.id on create; Auto omits model.",
    });
  } catch (err: any) {
    logger.error({ err }, "GET /api/user/cursor/models failed");
    res.status(502).json({ error: err?.message || "Failed to sync Cursor models" });
  }
});

/** Live free-model catalog from OpenRouter (public list, auth optional for consistency). */
userRouter.get("/openrouter/free-models", requireAuth, async (_req, res) => {
  try {
    const models = await fetchOpenRouterFreeModels();
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json({
      models,
      syncedAt: new Date().toISOString(),
      note:
        "Free models: ~50 req/day (never purchased credits) or ~1000/day after a one-time $10 credit purchase. Hard limit ~20 rpm.",
    });
  } catch (err: any) {
    logger.error({ err }, "GET /api/user/openrouter/free-models failed");
    res.status(502).json({ error: err?.message || "Failed to sync free models" });
  }
});

/** Account usage for the saved OpenRouter key (never returns the key). */
userRouter.get("/openrouter/key-status", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const plaintext = await getDecryptedUserApiKey(userId, "openrouter");
    if (!plaintext) {
      return res.status(404).json({ error: "No OpenRouter key saved" });
    }
    const info = await fetchOpenRouterKeyInfo(plaintext);
    res.json({ status: info });
  } catch (err: any) {
    logger.error({ err }, "GET /api/user/openrouter/key-status failed");
    res.status(502).json({ error: err?.message || "Failed to load OpenRouter key status" });
  }
});

userRouter.get("/api-keys", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    await syncUserToDatabase(userId);
    const keys = await listUserApiKeyMeta(userId);
    const prefs = await getUserModelPrefs(userId);
    res.json({
      keys: keys.map((k) => ({
        ...k,
        label: providerLabel(k.provider),
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
    const provider = String(req.params.provider || "");
    if (!isApiKeyProvider(provider)) {
      return res.status(400).json({ error: "Unsupported provider" });
    }
    const apiKey = String(req.body?.apiKey || "").trim();
    const formatError = lookLikeKeyError(provider, apiKey);
    if (formatError) {
      return res.status(400).json({ error: formatError });
    }

    await syncUserToDatabase(userId);
    const meta = await saveUserApiKey(userId, provider, apiKey);

    // Auto-verify on save
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
      error =
        "Database is missing the Cursor provider. Run sql/add_cursor_provider.sql in Supabase.";
    } else if (msg) {
      error = msg.slice(0, 240);
    }
    res.status(500).json({ error });
  }
});

userRouter.post("/api-keys/:provider/verify", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const provider = String(req.params.provider || "");
    if (!isApiKeyProvider(provider)) {
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
    const provider = String(req.params.provider || "");
    if (!isApiKeyProvider(provider)) {
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
    });
    const prefs = await getUserModelPrefs(userId);
    res.json({ prefs });
  } catch (err: any) {
    logger.error({ err }, "PATCH model-prefs failed");
    res.status(500).json({ error: "Failed to save preferences" });
  }
});
