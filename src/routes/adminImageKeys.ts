import { Router } from "express";
import { logger } from "../logger.js";
import {
  clearEnvImageKeyVerification,
  deleteImagePlatformApiKey,
  envImageKey,
  getDecryptedImagePlatformApiKey,
  listImagePlatformApiKeyMeta,
  lookLikeImageKey,
  saveImagePlatformApiKey,
  setEnvImageKeyVerification,
  setImagePlatformApiKeyStatus,
  verifyImageProviderKey,
} from "../repository/imagePlatformApiKeys.js";
import type { ImageProvider } from "../services/imageProviders/config.js";

export const adminImageKeysRouter = Router();

function parseImageProviderParam(param: string): ImageProvider | null {
  const p = param.trim().toLowerCase();
  if (p === "openai" || p === "gemini") {
    return p;
  }
  return null;
}

adminImageKeysRouter.get("/", async (_req, res) => {
  try {
    const keys = await listImagePlatformApiKeyMeta();
    res.json({ keys });
  } catch (err: any) {
    logger.error({ err }, "GET /api/admin/image-keys failed");
    res.status(500).json({ error: "Failed to load image generation keys" });
  }
});

adminImageKeysRouter.put("/:provider", async (req, res) => {
  try {
    const provider = parseImageProviderParam(String(req.params.provider || ""));
    if (!provider) {
      return res.status(400).json({ error: "Unsupported image provider (expected openai or gemini)" });
    }

    const apiKey = String(req.body?.apiKey || "").trim();
    if (!apiKey) {
      return res.status(400).json({ error: "apiKey is required" });
    }
    if (!lookLikeImageKey(provider, apiKey)) {
      return res.status(400).json({ error: "API key format looks invalid" });
    }

    const meta = await saveImagePlatformApiKey(provider, apiKey);
    clearEnvImageKeyVerification(provider);
    const probe = await verifyImageProviderKey(provider, apiKey);
    await setImagePlatformApiKeyStatus(
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
      },
    });
  } catch (err: any) {
    logger.error({ err }, "PUT /api/admin/image-keys/:provider failed");
    const msg = String(err?.message || "");
    res.status(500).json({
      error: msg.includes("USER_API_KEYS_ENCRYPTION_SECRET")
        ? "Server missing USER_API_KEYS_ENCRYPTION_SECRET"
        : msg || "Failed to save image API key",
    });
  }
});

adminImageKeysRouter.delete("/:provider", async (req, res) => {
  try {
    const provider = parseImageProviderParam(String(req.params.provider || ""));
    if (!provider) {
      return res.status(400).json({ error: "Unsupported image provider (expected openai or gemini)" });
    }

    await deleteImagePlatformApiKey(provider);
    res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err }, "DELETE /api/admin/image-keys/:provider failed");
    res.status(500).json({ error: "Failed to remove image API key" });
  }
});

adminImageKeysRouter.post("/:provider/verify", async (req, res) => {
  try {
    const provider = parseImageProviderParam(String(req.params.provider || ""));
    if (!provider) {
      return res.status(400).json({ error: "Unsupported image provider (expected openai or gemini)" });
    }

    const plaintext = (await getDecryptedImagePlatformApiKey(provider)) || envImageKey(provider);
    if (!plaintext) {
      return res.status(404).json({ error: "No key configured for this provider in database or .env" });
    }

    const probe = await verifyImageProviderKey(provider, plaintext);
    setEnvImageKeyVerification(
      provider,
      probe.ok ? "valid" : "invalid",
      probe.ok ? null : probe.error || "Verification failed"
    );
    await setImagePlatformApiKeyStatus(
      provider,
      probe.ok ? "valid" : "invalid",
      probe.ok ? null : probe.error || "Verification failed"
    ).catch(() => {
      // If key is only in .env, DB update is skipped
    });

    res.json({
      ok: probe.ok,
      status: probe.ok ? "valid" : "invalid",
      error: probe.ok ? null : probe.error || "Verification failed",
    });
  } catch (err: any) {
    logger.error({ err }, "POST /api/admin/image-keys/:provider/verify failed");
    res.status(500).json({ error: "Verification failed" });
  }
});
