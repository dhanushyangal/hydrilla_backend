import dotenv from "dotenv";

dotenv.config();

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
    url: process.env.HUNYUAN_API_URL || "https://api.hydrilla.co",
  },
  s3: {
    bucket: process.env.S3_BUCKET || "hunyuan3d-outputs",
    region: process.env.S3_REGION || "us-east-1",
    presignedUrlExpiry: parseInt(process.env.S3_PRESIGNED_URL_EXPIRY || "3600", 10),
  },
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
  email: {
    url: process.env.ZEPTOMAIL_API_URL || "https://api.zeptomail.in/v1.1/email",
    token: process.env.ZEPTOMAIL_TOKEN || "Zoho-enczapikey PHtE6r0LFLy5jW4poREJ7PbrEZPxMtwn9O02K1RPstxDWaVWGk1Vq9p+kmKzrxkqUaNBHfPIzolquO+e5e2CIm/rNz5ODmqyqK3sx/VYSPOZsbq6x00VtF8cd0bbVIToddZj3CPevdrZNA==",
    fromAddress: process.env.ZEPTOMAIL_FROM_ADDRESS || "noreply@hydrilla.co",
    fromName: process.env.ZEPTOMAIL_FROM_NAME || "Hydrilla",
    frontendUrl: process.env.FRONTEND_URL || "https://hydrilla.co",
  },
  dodoPayment: {
    apiKey: process.env.DODO_PAYMENT_API_KEY || "",
    mode: process.env.DODO_PAYMENT_MODE || "test",  // "test" or "live"
    webhookSecret: process.env.DODO_PAYMENT_WEBHOOK_SECRET || "",
    baseUrl: (process.env.DODO_PAYMENT_MODE || "test") === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com",
    productId: process.env.DODO_PAYMENT_PRODUCT_ID || "",  // Early Access product ID (created in Dodo dashboard)
    returnUrl: process.env.DODO_PAYMENTS_RETURN_URL || "",  // Return URL after payment (e.g., http://localhost:3000/checkout/success)
  },
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

if (!config.dodoPayment.productId) {
  console.warn("[config] DODO_PAYMENT_PRODUCT_ID is missing. You need to create a product in Dodo dashboard first.");
}

if (!config.dodoPayment.returnUrl) {
  console.warn("[config] DODO_PAYMENTS_RETURN_URL is missing. Payment redirects will not work correctly.");
}
