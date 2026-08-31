import crypto from "crypto";
import { config } from "../config.js";
import {
  API_KEY_PROVIDERS,
  lookLikeKey as connectorLookLikeKey,
  lookLikeKeyError as connectorLookLikeKeyError,
  providerLabel as connectorProviderLabel,
  type ApiKeyProvider,
} from "../providers/index.js";
import { isApiKeyProvider, normalizeProviderId } from "../providers/ids.js";

export type { ApiKeyProvider };
export type ApiKeyStatus = "unchecked" | "valid" | "invalid";
export { API_KEY_PROVIDERS, isApiKeyProvider, normalizeProviderId };

function encryptionKey(): Buffer {
  const secret = config.userApiKeysEncryptionSecret;
  if (!secret || secret.length < 16) {
    throw new Error("USER_API_KEYS_ENCRYPTION_SECRET is not configured (min 16 chars)");
  }
  return crypto.scryptSync(secret, "hydrilla-user-api-keys-v1", 32);
}

export function encryptApiKey(value: string): {
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  last4: string;
} {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const trimmed = value.trim();
  return {
    encrypted_key: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
    last4: trimmed.slice(-4),
  };
}

export function decryptApiKey(row: {
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}): string | null {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(row.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(row.encrypted_key, "base64")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

export function providerLabel(provider: ApiKeyProvider): string {
  return connectorProviderLabel(provider);
}

export function lookLikeKey(provider: ApiKeyProvider, value: string): boolean {
  return connectorLookLikeKey(provider, value);
}

export function lookLikeKeyError(provider: ApiKeyProvider, value: string): string | null {
  return connectorLookLikeKeyError(provider, value);
}
