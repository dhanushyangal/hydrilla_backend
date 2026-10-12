import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { S3Client, PutObjectCommand, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { publicUrlForS3Key } from "./s3Upload.js";

const isVercel = Boolean(
  process.env.VERCEL === "1" ||
  process.env.VERCEL_ENV ||
  process.cwd().startsWith("/var/task") ||
  process.cwd().startsWith("/var/runtime")
);

function initS3Client(): S3Client | null {
  try {
    const hasAwsCreds = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    if (hasAwsCreds || !isVercel) {
      return new S3Client({ region: config.s3.region });
    }
  } catch (err) {
    logger.warn({ err }, "[Support] S3 client init failed");
  }
  return null;
}

const s3Client = initS3Client();

export async function uploadSupportAttachment(
  fileBuffer: Buffer,
  originalName: string,
  mimetype: string,
  localFilename?: string
): Promise<string> {
  const fileExtension = path.extname(originalName).toLowerCase() || ".png";
  const contentType = mimetype || "application/octet-stream";

  if (s3Client && config.s3.bucket) {
    try {
      const s3Key = `support/${randomUUID()}${fileExtension}`;
      const acl = process.env.S3_PUT_ACL?.trim();
      const putInput: PutObjectCommandInput = {
        Bucket: config.s3.bucket,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: contentType,
        ...(acl === "public-read" || acl === "private" ? { ACL: acl as any } : {}),
      };
      await s3Client.send(new PutObjectCommand(putInput));
      return publicUrlForS3Key(s3Key);
    } catch (err) {
      logger.error({ err }, "[Support] S3 upload failed, trying local fallback");
      if (isVercel) {
        throw new Error("Failed to upload attachment to S3");
      }
    }
  }

  if (isVercel) {
    throw new Error(
      "S3 storage is required on Vercel for file uploads. AWS credentials not configured."
    );
  }

  const uploadsDir = path.join(process.cwd(), "uploads", "support");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const filename = localFilename || `${randomUUID()}${fileExtension}`;
  const dest = path.join(uploadsDir, filename);
  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, fileBuffer);
  }

  const baseUrl = (process.env.BACKEND_URL || `http://localhost:${config.port}`).replace(/\/+$/, "");
  return `${baseUrl}/uploads/support/${filename}`;
}
