import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { logger } from "../logger.js";

const isVercel =
  process.env.VERCEL === "1" ||
  process.env.VERCEL_ENV ||
  process.cwd().startsWith("/var/task") ||
  process.cwd().startsWith("/var/runtime");

let s3Client: S3Client | null = null;

try {
  const hasAwsCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  if (hasAwsCreds || !isVercel) {
    s3Client = new S3Client({ region: config.s3.region });
  } else {
    logger.warn("S3 disabled on Vercel: set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY");
  }
} catch (err) {
  logger.warn({ err }, "S3 upload client init failed");
  s3Client = null;
}

export function publicUrlForS3Key(key: string): string {
  const base = process.env.S3_PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (base) return `${base}/${key}`;
  return `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${key}`;
}

function contentTypeForKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

/**
 * Upload a data URL (base64) to S3 and return its public URL.
 * Returns null when S3 is not configured — callers should keep the data URL.
 */
export async function uploadDataUrlToS3(dataUrl: string, key: string): Promise<string | null> {
  if (!s3Client || !config.s3.bucket) return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  const contentType = match[1] || contentTypeForKey(key);
  let buffer: Buffer;
  try {
    buffer = Buffer.from(match[2], "base64");
  } catch {
    return null;
  }
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) return null;

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );
    return publicUrlForS3Key(key);
  } catch (err) {
    logger.warn({ err, key }, "S3 data-url upload failed");
    return null;
  }
}
