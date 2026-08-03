import crypto from "crypto";
import { config } from "../config.js";

export type ApiKeyProvider = "anthropic" | "openai" | "gemini" | "openrouter" | "cursor";
export type ApiKeyStatus = "unchecked" | "valid" | "invalid";

export const API_KEY_PROVIDERS: ApiKeyProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "cursor",
];

export function isApiKeyProvider(value: string): value is ApiKeyProvider {
  return (API_KEY_PROVIDERS as string[]).includes(value);
}

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
  switch (provider) {
    case "anthropic":
      return "Anthropic (Claude)";
    case "openai":
      return "OpenAI";
    case "gemini":
      return "Google (Gemini)";
    case "openrouter":
      return "OpenRouter";
    case "cursor":
      return "Cursor";
  }
}

export function lookLikeKey(provider: ApiKeyProvider, value: string): boolean {
  const v = value.trim();
  if (v.length < 20) return false;
  if (provider === "anthropic") return v.startsWith("sk-ant-") || v.length > 40;
  if (provider === "openai") return v.startsWith("sk-") || v.length > 40;
  if (provider === "openrouter") return v.startsWith("sk-or-") || v.length > 40;
  if (provider === "gemini") return v.length > 20;
  // Cursor Cloud Agents / SDK keys (often crsr_…)
  if (provider === "cursor") return v.startsWith("crsr_") || v.length >= 24;
  return false;
}
