import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { S3Client, PutObjectCommand, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { publicUrlForS3Key } from "./s3Upload.js";

const isVercel =
  process.env.VERCEL === "1" ||
  process.env.VERCEL_ENV ||
  process.cwd().startsWith("/var/task") ||
  process.cwd().startsWith("/var/runtime");

let s3Client: S3Client | null = null;
let s3Enabled = false;

try {
  const hasAwsCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  if (hasAwsCreds || !isVercel) {
    s3Client = new S3Client({ region: config.s3.region });
    s3Enabled = hasAwsCreds || !isVercel;
  }
} catch (err) {
  logger.warn({ err }, "Blog image S3 client init failed");
}

export async function uploadBlogImage(
  fileBuffer: Buffer,
  originalName: string,
  mimetype: string,
  localFilename?: string
): Promise<string> {
  const fileExtension = path.extname(originalName).toLowerCase() || ".jpg";
  const contentType = mimetype || `image/${fileExtension.slice(1)}`;

  if (s3Enabled && s3Client && config.s3.bucket) {
    const s3Key = `blog/${randomUUID()}${fileExtension}`;
    const putInput: PutObjectCommandInput = {
      Bucket: config.s3.bucket,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: contentType,
    };
    const acl = process.env.S3_PUT_ACL?.trim();
    if (acl === "public-read" || acl === "private") {
      putInput.ACL = acl;
    }
    await s3Client.send(new PutObjectCommand(putInput));
    return publicUrlForS3Key(s3Key);
  }

  if (isVercel) {
    throw new Error(
      "S3 is required on Vercel. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET, and S3_REGION."
    );
  }

  const uploadsDir = path.join(process.cwd(), "uploads", "blog");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = localFilename || `${Date.now()}-${randomUUID()}${fileExtension}`;
  const dest = path.join(uploadsDir, filename);
  fs.writeFileSync(dest, fileBuffer);
  const baseUrl = process.env.BACKEND_URL || `http://localhost:${config.port}`;
  return `${baseUrl}/uploads/blog/${filename}`;
}
