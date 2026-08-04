import dotenv from "dotenv";

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

export const config = {
  port: parseInt(process.env.PORT || "4000", 10),
  supabase: {
    url: process.env.SUPABASE_URL || "https://vyyzepmcqeqoxwjqnrxh.supabase.co",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5eXplcG1jcWVxb3h3anFucnhoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTgxNjQ3MSwiZXhwIjoyMDgxMzkyNDcxfQ.C6j9KLUGqd2erlpKJZlyyjDiN6oetytGaD_X-oMqq9A",
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
  s3: {
    bucket: process.env.S3_BUCKET || "hydrilla-outputs-1",
    region: process.env.S3_REGION || "us-east-1",
    presignedUrlExpiry: parseInt(process.env.S3_PRESIGNED_URL_EXPIRY || "3600", 10),
  },
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "2000", 10),
  email: {
    url: process.env.ZEPTOMAIL_API_URL || "https://api.zeptomail.in/v1.1/email",
    token: process.env.ZEPTOMAIL_TOKEN || "Zoho-enczapikey PHtE6r0LFLy5jW4poREJ7PbrEZPxMtwn9O02K1RPstxDWaVWGk1Vq9p+kmKzrxkqUaNBHfPIzolquO+e5e2CIm/rNz5ODmqyqK3sx/VYSPOZsbq6x00VtF8cd0bbVIToddZj3CPevdrZNA==",
    fromAddress: process.env.ZEPTOMAIL_FROM_ADDRESS || "noreply@hydrilla.co",
    fromName: process.env.ZEPTOMAIL_FROM_NAME || "Hydrilla",
    frontendUrl: process.env.FRONTEND_URL || "https://hydrilla.co",
  },
  adminEmails: (process.env.ADMIN_EMAILS || "dhanushyangal@gmail.com,dhanushyangal1@gmail.com,tharak.nagaveti@gmail.com")
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

if (!config.supabase.serviceRoleKey) {
  console.warn("[config] SUPABASE_SERVICE_ROLE_KEY is missing. Database operations will fail until set.");
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

const onVercel = process.env.VERCEL === "1" || !!process.env.VERCEL_ENV;
if (
  onVercel &&
  (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
) {
  console.warn(
    "[config] Vercel: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing — image uploads will fail until set (with S3_BUCKET, S3_REGION)."
  );
}
