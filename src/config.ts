import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "4000", 10),
  supabase: {
    url: process.env.SUPABASE_URL || "https://vyyzepmcqeqoxwjqnrxh.supabase.co",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
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
