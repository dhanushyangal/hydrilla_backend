import dotenv from "dotenv";
import crypto from "crypto";

// Load .env then .env.local (local overrides — matches Next.js convention)
dotenv.config();
dotenv.config({ path: ".env.local", override: true });

/** Single production GPU runtime (hydrilla_runtime on :8000) */
const GATEWAY_URL = "https://api.hydrilla.co";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function gatewayUrl(...envKeys: string[]): string {
  for (const key of envKeys) {
    const v = process.env[key]?.trim();
    if (v) return stripTrailingSlash(v);
  }
  return GATEWAY_URL;
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `[config] Missing required environment variable: ${name}. Set it in .env (do not hardcode secrets in source).`
    );
  }
  return v;
}

const defaultCorsOrigins = [
  "https://hydrilla.co",
  "https://www.hydrilla.co",
  "https://hydrilla.ai",
  "https://www.hydrilla.ai",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

export const config = {
  port: parseInt(process.env.PORT || "4000", 10),
  supabase: {
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  },
  clerk: {
    publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "",
    secretKey: process.env.CLERK_SECRET_KEY || "",
  },
  hunyuanApi: {
    /** Unified GPU gateway (image + 3D on same host) */
    url: gatewayUrl("HUNYUAN_API_URL"),
  },
  fluxGateway: {
    url: gatewayUrl("FLUX_GATEWAY_URL", "FLUX_API_URL", "HUNYUAN_API_URL"),
  },
  trellisGateway: {
    url: gatewayUrl("TRELLIS_GATEWAY_URL", "TRELLIS_API_URL", "HUNYUAN_API_URL"),
  },
  /** Shared secret for Node ↔ GPU and internal job webhooks */
  internalApiSecret: process.env.HYDRILLA_INTERNAL_API_SECRET || "",
  corsOrigins: (
    process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
      : defaultCorsOrigins
  ),
  s3: {
    bucket: process.env.S3_BUCKET || "hydrilla-outputs-1",
    region: process.env.S3_REGION || "us-east-1",
    presignedUrlExpiry: parseInt(process.env.S3_PRESIGNED_URL_EXPIRY || "3600", 10),
  },
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "2000", 10),
  email: {
    url: process.env.ZEPTOMAIL_API_URL || "https://api.zeptomail.in/v1.1/email",
    token: process.env.ZEPTOMAIL_TOKEN || "",
    fromAddress: process.env.ZEPTOMAIL_FROM_ADDRESS || "noreply@hydrilla.co",
    fromName: process.env.ZEPTOMAIL_FROM_NAME || "Hydrilla",
    frontendUrl: process.env.FRONTEND_URL || "https://hydrilla.co",
  },
  adminEmails: (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean),
  frontendUrl: process.env.FRONTEND_URL || "https://hydrilla.co",
  databaseUrl: process.env.DATABASE_URL || "",
  /** AES key material for BYOK API keys (scrypt). Set in Vercel env. */
  userApiKeysEncryptionSecret:
    process.env.USER_API_KEYS_ENCRYPTION_SECRET || "",
  dodoPayment: {
    apiKey: process.env.DODO_PAYMENT_API_KEY || "",
    mode: process.env.DODO_PAYMENT_MODE || "test",  // "test" or "live"
    webhookSecret: process.env.DODO_PAYMENT_WEBHOOK_SECRET || "",
    baseUrl: (process.env.DODO_PAYMENT_MODE || "test") === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com",
    environment: ((process.env.DODO_PAYMENT_MODE || "test") === "live" ? "live_mode" : "test_mode") as "live_mode" | "test_mode",
    // Subscription plan product IDs (created in Dodo dashboard)
    creatorProductId: process.env.DODO_PAYMENT_CREATOR_PRODUCT_ID || "",
    studioProductId: process.env.DODO_PAYMENT_STUDIO_PRODUCT_ID || "",
    returnUrl: process.env.DODO_PAYMENTS_RETURN_URL || "",
  },
  // Map product IDs to plan names and credit limits
  planConfig: {
    creator: {
      productId: process.env.DODO_PAYMENT_CREATOR_PRODUCT_ID || "",
      credits: 1000,
      label: "Creator",
    },
    studio: {
      productId: process.env.DODO_PAYMENT_STUDIO_PRODUCT_ID || "",
      credits: 4000,
      label: "Studio",
    },
  } as Record<string, { productId: string; credits: number; label: string }>,
};

if (!config.hunyuanApi.url) {
  console.warn("[config] HUNYUAN_API_URL is missing. API calls will fail until set.");
}

if (!config.clerk.secretKey) {
  console.warn("[config] CLERK_SECRET_KEY is missing. Authentication will fail until set.");
}

if (!config.email.token) {
  console.warn("[config] ZEPTOMAIL_TOKEN is missing. Email functionality will be disabled.");
}

if (!config.dodoPayment.apiKey) {
  console.warn("[config] DODO_PAYMENT_API_KEY is missing. Payment functionality will be disabled.");
}

if (!config.dodoPayment.creatorProductId) {
  console.warn("[config] DODO_PAYMENT_CREATOR_PRODUCT_ID is missing. Creator plan checkout will not work.");
}

if (!config.dodoPayment.studioProductId) {
  console.warn("[config] DODO_PAYMENT_STUDIO_PRODUCT_ID is missing. Studio plan checkout will not work.");
}

if (!config.dodoPayment.returnUrl) {
  console.warn("[config] DODO_PAYMENTS_RETURN_URL is missing. Payment redirects will not work correctly.");
}

if (!config.userApiKeysEncryptionSecret) {
  console.warn(
    "[config] USER_API_KEYS_ENCRYPTION_SECRET is missing. BYOK / Water API key storage will fail until set."
  );
}

if (!config.internalApiSecret) {
  console.warn(
    "[config] HYDRILLA_INTERNAL_API_SECRET is missing. GPU gateway calls and internal job webhooks will be rejected until set."
  );
}

if (!config.adminEmails.length) {
  console.warn("[config] ADMIN_EMAILS is missing. Admin-only routes will deny all users.");
}

const onVercel = process.env.VERCEL === "1" || !!process.env.VERCEL_ENV;
if (
  onVercel &&
  (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
) {
  console.warn(
    "[config] Vercel: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing — image uploads will fail until set (with S3_BUCKET, S3_REGION)."
  );
}

/** Constant-time compare for internal API secret headers */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
