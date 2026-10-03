import { Router } from "express";
import { randomUUID } from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { S3Client, PutObjectCommand, GetObjectCommand, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import { logger } from "../logger.js";
import { config, timingSafeEqualString } from "../config.js";
import { supabase } from "../db.js";
import { createJob, getJob, listJobsForUser, updateJobResult, updateJobStatus, deleteJob, getJobForUser, getJobLineage, upsertJobParents, getJobParentIds } from "../repository/jobs.js";
import { createChat, getChatForUser, listChatsForUser, updateChatName, updateChatUpdatedAt, deleteChat, getOrCreateActiveChat } from "../repository/chats.js";
import { createWorkspace, getWorkspace, getWorkspaceForUser, listWorkspacesForUser, listJobsForWorkspace, updateWorkspaceName, updateWorkspaceUpdatedAt, deleteWorkspace } from "../repository/workspaces.js";
import { optionalAuth, requireAuth, syncUserToDatabase } from "../middleware/auth.js";
import { normalizeGlbUrl, normalizePreviewUrl, unwrapImageProxyUrl } from "../utils/s3Urls.js";
import { isWaterEngine, isWaterJobId, isWaterJobRow } from "../lib/engines.js";
import {
  generateImage,
  imageProviderAvailability,
  isImageProviderError,
  runDeduplicatedImageJob,
  validateImagePrompt,
  IMAGE_CREDITS,
  parseImageAspect,
  parseImageProvider,
  parseImageQuality,
  runWithUsage,
  summarizeUsage,
  type GeneratedImage,
  type ImageAspect,
  type ImageOperation,
  type ImageProvider,
  type ImageQuality,
  type InputImage,
  type UsageCall,
} from "../services/imageProviders/index.js";
import { recordImageUsage, type ImageUsageRecord } from "../repository/imageUsage.js";
import { MULTI_VIEW_3D_SYSTEM_PROMPT, buildMultiView3DEditPrompt } from "../services/imageProviders/editPrompts.js";
import { runDeduplicated3DSubmission } from "../services/inFlight3d.js";
import { JobStatus, JobRecord, ChatRecord, WorkspaceRecord, GenerateType } from "../types.js";

export const threeDRouter = Router();

function compactVisualEvidence(spec: unknown): {
  gatePassed?: boolean;
  fidelity?: number | null;
  failCodes?: string[];
  source?: string;
} | null {
  if (!spec || typeof spec !== "object") return null;
  const visual = (spec as { visual?: Record<string, unknown> }).visual;
  if (!visual || typeof visual !== "object") return null;
  return {
    gatePassed: visual.gatePassed === true,
    fidelity: typeof visual.fidelity === "number" ? visual.fidelity : null,
    failCodes: Array.isArray(visual.failCodes) ? (visual.failCodes as string[]) : [],
    source: typeof visual.source === "string" ? visual.source : undefined,
  };
}

/** Attach shared internal secret on every Node → GPU request */
export function withInternalSecretHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers || {});
  if (config.internalApiSecret) {
    headers.set("X-Hydrilla-Internal", config.internalApiSecret);
  }
  return { ...init, headers };
}

function assertInternalSecret(req: { headers: Record<string, unknown> | any }, res: any): boolean {
  const expected = config.internalApiSecret;
  if (!expected) {
    res.status(503).json({ error: "Internal API secret not configured" });
    return false;
  }
  const provided = String(req.headers["x-hydrilla-internal"] || "");
  if (!timingSafeEqualString(provided, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/** Deny if authenticated user does not own the job (ownerless jobs allowed for authenticated users). */
function denyIfNotJobOwner(job: { userId?: string | null }, userId: string | undefined, res: any): boolean {
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return true;
  }
  if (job.userId && job.userId !== userId) {
    res.status(403).json({ error: "You don't have permission to access this job" });
    return true;
  }
  return false;
}

function isAllowedImageProxyUrl(imageUrl: string): boolean {
  try {
    const u = new URL(imageUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    const bucket = (config.s3.bucket || "").toLowerCase();
    const region = (config.s3.region || "us-east-1").toLowerCase();
    const allowedHosts = new Set<string>([
      `${bucket}.s3.amazonaws.com`,
      `${bucket}.s3.${region}.amazonaws.com`,
      `s3.${region}.amazonaws.com`,
      "s3.amazonaws.com",
      "api.hydrilla.co",
    ]);
    for (const legacy of LEGACY_S3_BUCKETS) {
      allowedHosts.add(`${legacy}.s3.amazonaws.com`);
      allowedHosts.add(`${legacy}.s3.${region}.amazonaws.com`);
    }
    if (allowedHosts.has(host)) return true;
    // path-style: s3.region.amazonaws.com/bucket/...
    if ((host === `s3.${region}.amazonaws.com` || host === "s3.amazonaws.com") &&
        (u.pathname.startsWith(`/${bucket}/`) || LEGACY_S3_BUCKETS.some((b) => u.pathname.startsWith(`/${b}/`)))) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Configure multer for file uploads
// In Vercel/serverless, use /tmp which is writable, otherwise use local uploads directory
// Detect Vercel/serverless environment more reliably
const isVercel = process.env.VERCEL === "1" || 
                 process.env.VERCEL_ENV || 
                 process.cwd().startsWith("/var/task") ||
                 process.cwd().startsWith("/var/runtime");

// In Vercel/serverless, always use memory storage since files should go to S3
// Never try to create directories in Vercel - it will fail
let storage: multer.StorageEngine;

if (isVercel) {
  // In Vercel, always use memory storage - files should be uploaded to S3
  storage = multer.memoryStorage();
} else {
  // In non-Vercel environments, try to use disk storage
  const uploadsDir = path.join(process.cwd(), "uploads");
  
  // Helper function to safely create directory
  function ensureUploadsDir(): boolean {
    try {
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      return true;
    } catch (err: any) {
      logger.warn({ err: err.message, uploadsDir }, "Failed to create uploads directory");
      return false;
    }
  }

  // Try to use disk storage, fallback to memory if it fails
  if (ensureUploadsDir()) {
    storage = multer.diskStorage({
      destination: (_req: any, _file: any, cb: any) => {
        // Directory should already exist, but ensure it just in case
        try {
          if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
          }
          cb(null, uploadsDir);
        } catch (err: any) {
          cb(err);
        }
      },
      filename: (_req: any, file: any, cb: any) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `image-${uniqueSuffix}${ext}`);
      },
    });
  } else {
    // Fallback to memory storage if directory creation fails
    storage = multer.memoryStorage();
  }
}

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
  fileFilter: (_req: any, file: any, cb: any) => {
    // Accept any image/* mimetype, 3D model formats (.glb, .gltf, .obj), or generic/empty mimetypes.
    const allowedExt = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".glb", ".gltf", ".obj"];
    const mimetype = (file.mimetype || "").toLowerCase();
    const originalName = (file.originalname || "").toLowerCase();
    const ext = path.extname(originalName);
    const isImageMime = mimetype.startsWith("image/");
    const is3dMime =
      mimetype.startsWith("model/") ||
      mimetype === "application/octet-stream" ||
      mimetype === "binary/octet-stream" ||
      mimetype === "application/json";
    const isGenericMime = mimetype === "" || mimetype === "application/octet-stream" || mimetype === "binary/octet-stream";
    const hasAllowedExt = allowedExt.includes(ext);
    if (isImageMime || (is3dMime && hasAllowedExt) || (isGenericMime && hasAllowedExt)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Only images and 3D models (.glb, .gltf, .obj) are allowed. (received mimetype="${file.mimetype}", filename="${file.originalname}")`));
    }
  },
});

/**
 * Read uploaded file bytes regardless of multer storage backend.
 * - With memory storage (Vercel): file.buffer is set.
 * - With disk storage (local dev): file.path is set, file.buffer is undefined.
 *
 * Repacking via `new Uint8Array(file.buffer)` when the buffer is undefined
 * produces an empty Uint8Array, which silently uploads a 0-byte file —
 * causing downstream "cannot identify image file" errors.
 */
function readMulterFile(file: Express.Multer.File): Buffer {
  if (file.buffer && file.buffer.length > 0) return file.buffer;
  if (file.path) return fs.readFileSync(file.path);
  throw new Error("Uploaded file has neither buffer nor path");
}

const uploadFlexible = (req: any, res: any, next: any) => {
  upload.any()(req, res, (err: any) => {
    if (err) {
      return next(err);
    }
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      req.file = req.files[0];
    }
    next();
  });
};

/** GPU VM gateway (no trailing slash) — BlueFox3D image-to-3d on api.hydrilla.co */
const GPU_GATEWAY = config.gpuGateway.url;

/** Image jobs are produced by OpenAI/Gemini in-request; they never exist on the VM. */
const PROVIDER_IMAGE_TYPES: GenerateType[] = ["TextToImage", "EditImage"];

const LEGACY_S3_BUCKETS = (process.env.LEGACY_S3_BUCKETS || "hydrilla-outputs")
  .split(",")
  .map((bucket) => bucket.trim().toLowerCase())
  .filter(Boolean);

/** Resolve a relative gateway image URL (e.g. /outputs/...) to a full URL. */
function resolveGatewayImageUrl(url: string | undefined | null, baseUrl: string = GPU_GATEWAY): string | null {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = baseUrl.replace(/\/$/, "");
  return url.startsWith("/") ? `${base}${url}` : `${base}/${url}`;
}

/** Fetch from the GPU VM gateway. */
async function fetchGateway(
  path: string,
  init: RequestInit = {}
): Promise<{ response: Response; baseUrl: string }> {
  const pathStr = path.startsWith("/") ? path : `/${path}`;
  const signal = init.signal || AbortSignal.timeout(10000);
  const response = await fetch(`${GPU_GATEWAY}${pathStr}`, {
    ...withInternalSecretHeaders(init),
    signal,
  });
  return { response, baseUrl: GPU_GATEWAY };
}

/** Fetch /queue/info from the GPU gateway. */
async function fetchQueueInfoFromGateway(
  base: string,
  init: RequestInit = {}
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${base}/queue/info`, withInternalSecretHeaders(init));
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Hosts the remote GPU worker cannot reach (it would try localhost on its own machine). */
function isHostnameUnreachableFromExternalGateway(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

function isImageUrlUnreachableByRemoteWorker(imageUrl: string): boolean {
  try {
    const u = new URL(imageUrl);
    return isHostnameUnreachableFromExternalGateway(u.hostname);
  } catch {
    return false;
  }
}

function isKnownS3Bucket(bucket: string): boolean {
  const normalized = bucket.toLowerCase();
  return normalized === config.s3.bucket.toLowerCase() || LEGACY_S3_BUCKETS.includes(normalized);
}

function extractOwnedS3KeyFromUrl(fileUrl: string): string | null {
  if (!config.s3.bucket) return null;
  try {
    const u = new URL(fileUrl);
    const host = u.hostname.toLowerCase();
    const bucket = config.s3.bucket.toLowerCase();
    const pathNoSlash = u.pathname.replace(/^\/+/, "");

    // Supports virtual-hosted and path-style S3 URLs:
    // - https://<bucket>.s3.<region>.amazonaws.com/<key>
    // - https://s3.<region>.amazonaws.com/<bucket>/<key>
    const virtualHostedBucket = host.split(".s3.")[0];
    if (host.includes(".s3.") && isKnownS3Bucket(virtualHostedBucket)) {
      return decodeURIComponent(pathNoSlash.split("?")[0]);
    }
    const [pathBucket, ...keyParts] = pathNoSlash.split("/");
    if (pathBucket && keyParts.length > 0 && isKnownS3Bucket(pathBucket)) {
      return decodeURIComponent(keyParts.join("/").split("?")[0]);
    }
  } catch {
    for (const bucket of [config.s3.bucket, ...LEGACY_S3_BUCKETS]) {
      const marker = `${bucket}/`;
      const idx = fileUrl.indexOf(marker);
      if (idx >= 0) {
        return decodeURIComponent(fileUrl.slice(idx + marker.length).split("?")[0]);
      }
    }
  }
  return null;
}

function contentTypeForImageKey(key: string, fallback?: string): string {
  const ext = path.extname(key).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".glb") return "model/gltf-binary";
  if (ext === ".gltf") return "model/gltf+json";
  return fallback && fallback !== "binary/octet-stream" && fallback !== "application/octet-stream"
    ? fallback
    : "image/png";
}

function getJobIdFromS3Key(key: string): string | null {
  const [prefix, jobId] = key.split("/");
  if (!jobId) return null;
  // "combined" is kept so legacy Combined rows still resolve in the image proxy.
  return ["preview", "image", "text", "edit", "combined"].includes(prefix) ? jobId : null;
}

function uniqueKeys(keys: string[]): string[] {
  return Array.from(new Set(keys.filter(Boolean)));
}

function imageKeyCandidates(key: string): string[] {
  const jobId = getJobIdFromS3Key(key);
  if (!jobId) return [key];
  return uniqueKeys([
    key,
    `preview/${jobId}/preview_image.png`,
    `image/${jobId}/processed_image.png`,
    `text/${jobId}/processed_image.png`,
    `text/${jobId}/generated_image.png`,
    `edit/${jobId}/edited.png`,
    `combined/${jobId}/combined.png`,
    `image/${jobId}/mesh.glb`,
    `text/${jobId}/mesh.glb`,
  ]);
}

function glbKeyCandidates(key: string): string[] {
  const jobId = getJobIdFromS3Key(key);
  if (!jobId) return [key];
  return uniqueKeys([
    key,
    `image/${jobId}/mesh.glb`,
    `text/${jobId}/mesh.glb`,
  ]);
}

async function getFirstExistingS3Object(keys: string[]) {
  if (!s3Client) throw new Error("S3 client is not initialized");
  let lastErr: any = null;
  for (const key of keys) {
    try {
      const out = await s3Client.send(
        new GetObjectCommand({
          Bucket: config.s3.bucket,
          Key: key,
        })
      );
      return { key, out };
    } catch (err: any) {
      lastErr = err;
      const code = err?.Code || err?.name || err?.$metadata?.httpStatusCode;
      if (code === "NoSuchKey" || code === "NotFound" || code === 404) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("S3 object not found");
}

/**
 * Load image bytes for URLs that only this backend can read (e.g. disk under /uploads/ or loopback).
 * Used so we can POST multipart image_file to the gateway instead of image_url.
 */
async function loadImageBytesForLocalBackendUrl(imageUrl: string): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  let pathname: string;
  try {
    pathname = new URL(imageUrl).pathname;
  } catch {
    throw new Error("Invalid image URL");
  }
  const uploadsMatch = pathname.match(/\/uploads\/([^/]+)$/);
  if (uploadsMatch) {
    const filename = uploadsMatch[1];
    const filePath = path.join(process.cwd(), "uploads", filename);
    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(filename).toLowerCase();
      const contentType =
        ext === ".png"
          ? "image/png"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".gif"
                ? "image/gif"
                : "application/octet-stream";
      return { buffer, contentType, filename };
    }
  }
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Could not download image (${res.status})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const basename = path.basename(pathname) || "image.jpg";
  return { buffer, contentType, filename: basename };
}

/**
 * Load image bytes directly from our S3 bucket URL (works even when the bucket/object is private),
 * so image-to-3d can proceed without requiring public read on uploads/*.
 */
function isGatewayOutputImageUrl(imageUrl: string): boolean {
  return (
    imageUrl.includes("/outputs/preview/") ||
    imageUrl.includes("/outputs/image/") ||
    imageUrl.includes("/outputs/edit/")
  );
}

/** Map owned S3 keys to public gateway /outputs/ URLs (file may only exist on GPU disk). */
function gatewayOutputUrlCandidates(imageUrl: string): string[] {
  const urls: string[] = [];
  const trimmed = (imageUrl || "").trim().split("?")[0];
  if (!trimmed) return urls;

  if (isGatewayOutputImageUrl(trimmed)) {
    urls.push(trimmed.startsWith("http") ? trimmed : resolveGatewayImageUrl(trimmed, GPU_GATEWAY) || trimmed);
  }

  const key = extractOwnedS3KeyFromUrl(trimmed);
  if (key) {
    const gatewayBase = GPU_GATEWAY.replace(/\/$/, "");
    for (const candidateKey of imageKeyCandidates(key)) {
      const match = candidateKey.match(/^(preview|image|edit)\/([^/]+)\/(.+)$/);
      if (match) {
        urls.push(`${gatewayBase}/outputs/${match[1]}/${match[2]}/${match[3]}`);
      }
    }
  }

  return uniqueKeys(urls);
}

async function readResponseBodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) throw new Error("Response body missing");
  const stream = body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
  }
  return Buffer.concat(chunks);
}

async function loadImageBytesFromOwnedS3Url(
  imageUrl: string
): Promise<{ buffer: Buffer; contentType: string; filename: string } | null> {
  if (!s3Enabled || !s3Client || !config.s3.bucket) return null;
  try {
    const key = extractOwnedS3KeyFromUrl(imageUrl);
    if (!key) return null;
    const { key: resolvedKey, out } = await getFirstExistingS3Object(imageKeyCandidates(key));
    if (!out.Body) throw new Error("S3 object body missing");
    const buffer = await readResponseBodyToBuffer(out.Body);
    const filename = path.basename(resolvedKey) || "image.jpg";
    const contentType = contentTypeForImageKey(resolvedKey, out.ContentType || "image/jpeg");
    if (!buffer.length) throw new Error("S3 object was empty");
    return { buffer, contentType, filename };
  } catch (err: any) {
    logger.warn({ err: err?.message, imageUrl }, "Failed to fetch owned S3 image directly");
    return null;
  }
}

/** Load image bytes for image-to-3d — S3, then gateway /outputs/, then direct fetch. */
async function loadImageBytesFor3dSubmission(
  imageUrl: string
): Promise<{ buffer: Buffer; contentType: string; filename: string } | null> {
  const fromS3 = await loadImageBytesFromOwnedS3Url(imageUrl);
  if (fromS3) return fromS3;

  for (const gatewayUrl of gatewayOutputUrlCandidates(imageUrl)) {
    try {
      const res = await fetch(gatewayUrl);
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) continue;
      let pathname = "preview_image.png";
      try {
        pathname = new URL(gatewayUrl).pathname;
      } catch {
        /* keep default */
      }
      const filename = path.basename(pathname) || "preview_image.png";
      const contentType = res.headers.get("content-type") || contentTypeForImageKey(filename);
      return { buffer, contentType, filename };
    } catch (err: any) {
      logger.warn({ err: err?.message, gatewayUrl }, "Failed to fetch image from gateway output URL");
    }
  }

  const resolved = resolveGatewayImageUrl(imageUrl, GPU_GATEWAY) || imageUrl;
  if (resolved.startsWith("http") && !extractOwnedS3KeyFromUrl(resolved)) {
    try {
      const res = await fetch(resolved);
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length) {
          let pathname = "image.jpg";
          try {
            pathname = new URL(resolved).pathname;
          } catch {
            /* keep default */
          }
          const filename = path.basename(pathname) || "image.jpg";
          const contentType = res.headers.get("content-type") || contentTypeForImageKey(filename);
          return { buffer, contentType, filename };
        }
      }
    } catch (err: any) {
      logger.warn({ err: err?.message, imageUrl: resolved }, "Failed to fetch image URL for 3D submission");
    }
  }

  return null;
}

/**
 * image-to-3d with file body via the GPU gateway.
 */
async function fetchGatewayImageTo3DMultipart(
  image: { buffer: Buffer; contentType: string; filename: string },
  userId: string
): Promise<{ response: Response; baseUrl: string }> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(image.buffer)], { type: image.contentType });
  formData.append("image", blob, image.filename);
  formData.append("user_id", userId);
  return fetchGateway("/image-to-3d", { method: "POST", body: formData });
}

/** Non-2xx reply from the GPU VM when submitting a job. */
class GpuSubmitHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GpuSubmitHttpError";
  }
}

/** The VM restarts itself periodically; short retries handle transient restarting. */
const GPU_SUBMIT_RETRY_DELAYS_MS = [1500, 2500];

function isTransientGpuSubmitError(err: unknown): boolean {
  if (err instanceof GpuSubmitHttpError) {
    if (/queue full/i.test(err.message)) {
      return false;
    }
    return err.status === 502 || err.status === 503 || err.status === 504;
  }
  const msg = err && typeof (err as any).message === "string" ? (err as any).message : "";
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|network|AbortError/i.test(msg);
}

async function submitWithGpuRestartRetry<T>(submit: () => Promise<T>, attempt = 0): Promise<T> {
  try {
    return await submit();
  } catch (err) {
    const delayMs = GPU_SUBMIT_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined || !isTransientGpuSubmitError(err)) {
      throw err;
    }
    logger.warn(
      { attempt: attempt + 1, delayMs, err: (err as any)?.message },
      "GPU VM temporarily unavailable (likely restarting); retrying job submission"
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return submitWithGpuRestartRetry(submit, attempt + 1);
  }
}

/** Map gateway/network errors to a user-facing message when the GPU API is unreachable. */
function gatewayErrorToUserMessage(err: unknown): string {
  const msg = err && typeof (err as any).message === "string" ? (err as any).message : "";
  if (/fetch failed|timeout|ECONNREFUSED|ECONNRESET|network|Gateway request failed|Gateway returned 5|AbortError/i.test(msg)) {
    return "GPU is currently offline or restarting. Please try again in a moment.";
  }
  return msg || "GPU is currently offline or restarting. Please try again in a moment.";
}

// Credits for 3D generation. Standard image-to-3d is 30 credits; high / ultra1k is 40 credits; full text-to-3d / chained edit is 65 credits.
const CREDITS_IMAGE_TO_3D = 30;
const CREDITS_IMAGE_TO_3D_HIGH = 40;
const CREDITS_TEXT_TO_3D = 65;

// Initialize S3 client (Vercel/serverless has no writable disk — uploads must use S3 with valid AWS creds)
let s3Client: S3Client | null = null;
let s3Enabled = false;

try {
  const hasAwsCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  s3Client = new S3Client({
    region: config.s3.region,
  });
  // On Vercel, do not attempt S3 without keys (PutObject would fail anyway)
  s3Enabled = hasAwsCreds || !isVercel;
  if (!s3Enabled) {
    s3Client = null;
    if (isVercel) {
      logger.warn("S3 disabled on Vercel: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for image uploads.");
    }
  } else {
    logger.info(
      { bucket: config.s3.bucket, region: config.s3.region, hasAwsCreds },
      "S3 client initialized"
    );
  }
} catch (err: any) {
  logger.warn({ err }, "Failed to initialize S3 client. S3 uploads disabled.");
  s3Enabled = false;
  s3Client = null;
}

/** Public URL for an uploaded object (virtual-hosted style, or override via S3_PUBLIC_BASE_URL). */
function publicUrlForS3Key(key: string): string {
  const base = process.env.S3_PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (base) {
    return `${base}/${key}`;
  }
  return `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${key}`;
}

// Helper functions for status conversion
function convertStatus(apiStatus: string): "WAIT" | "RUN" | "FAIL" | "DONE" {
  switch (apiStatus) {
    case "pending":
    case "queued":
      return "WAIT";
    case "processing":
      return "RUN";
    case "failed":
    case "cancelled":
      return "FAIL";
    case "completed":
      return "DONE";
    default:
      return "WAIT";
  }
}

/** Map hydrilla_runtime status payload to frontend QueueInfo shape. */
function buildQueueInfoFromApiJob(apiJob: Record<string, unknown>): Record<string, unknown> | null {
  if (apiJob.queue && typeof apiJob.queue === "object") {
    return apiJob.queue as Record<string, unknown>;
  }
  const position =
    typeof apiJob.queue_position === "number" ? apiJob.queue_position : 0;
  const rawStatus = String(apiJob.status || "").toLowerCase();
  const isQueued = rawStatus === "queued" || rawStatus === "pending" || rawStatus === "wait";
  const isProcessing = rawStatus === "processing" || rawStatus === "run";
  const jobsAhead = isQueued && position > 0 ? Math.max(0, position - 1) : 0;
  const estimatedTotal =
    typeof apiJob.estimated_seconds === "number"
      ? apiJob.estimated_seconds
      : typeof apiJob.estimated_total_seconds === "number"
        ? apiJob.estimated_total_seconds
        : 300;
  const waitSec = jobsAhead * estimatedTotal;
  return {
    position,
    jobs_ahead: jobsAhead,
    estimated_wait_seconds: waitSec,
    estimated_total_seconds: estimatedTotal,
    queue_length: position,
    currently_processing: isProcessing,
  };
}

// ============================================
// Generate 3D Model Endpoint (requires auth)
// ============================================
threeDRouter.post("/generate", requireAuth, async (req, res) => {
  try {
    const body = req.body as {
      prompt?: string;
      imageUrl?: string;
      imageBase64?: string;
      chatId?: string;
      workspaceId?: string;
      parentJobId?: string;
      parentJobIds?: string[];
      resolution?: string | number;
    };
    const userId = req.userId!;

    // Sync user to database on first request
    await syncUserToDatabase(userId);

    const { deductCredit } = await import("../services/credits.js");

    if (body.imageUrl || body.imageBase64) {
      if (body.imageBase64) {
        return res.status(400).json({ error: "Please provide imageUrl instead of imageBase64" });
      }
      const imageUrl = body.imageUrl!;
      const trimmedUrl = (imageUrl || "").trim();
      if (/^(blob:|data:)/i.test(trimmedUrl)) {
        return res.status(400).json({
          error:
            "That image link only exists in your browser. Re-upload the file or choose the image from your library, then try Generate 3D again.",
        });
      }

      // Remote GPU cannot fetch localhost/private S3 — load bytes here and POST multipart.
      let multipartForImage: { buffer: Buffer; contentType: string; filename: string } | null =
        await loadImageBytesFor3dSubmission(imageUrl);
      if (!multipartForImage && isImageUrlUnreachableByRemoteWorker(imageUrl)) {
        try {
          multipartForImage = await loadImageBytesForLocalBackendUrl(imageUrl);
        } catch (e: any) {
          return res.status(400).json({ error: e?.message || "Could not load image for 3D generation" });
        }
      }
      if (
        !multipartForImage &&
        (extractOwnedS3KeyFromUrl(imageUrl) || isGatewayOutputImageUrl(imageUrl))
      ) {
        return res.status(400).json({
          error:
            "Could not load the source image for 3D generation. Try generating the preview again or re-select the image from your library.",
        });
      }

      const isHighResolution = body.resolution === "ultra1k" || body.resolution === "high" || body.resolution === 1536 || body.resolution === "1536";
      const creditsToCharge = isHighResolution ? CREDITS_IMAGE_TO_3D_HIGH : CREDITS_IMAGE_TO_3D;

      const { jobId } = await runDeduplicated3DSubmission(userId, imageUrl, async () => {
        const deductResult = await deductCredit(userId, creditsToCharge, true);
        if (!deductResult.ok) {
          const creditErr = new Error(deductResult.error);
          (creditErr as any).status = 402;
          throw creditErr;
        }

        const parseImageTo3dError = async (response: Response): Promise<string> => {
          const text = await response.text();
          if (!text) {
            return "Failed to submit image-to-3d job";
          }
          try {
            const errorData = JSON.parse(text) as { error?: string; detail?: string };
            return errorData.error || errorData.detail || text;
          } catch {
            return text;
          }
        };

        const submitToGpu = async (): Promise<string> => {
          if (multipartForImage) {
            const { response } = await fetchGatewayImageTo3DMultipart(multipartForImage, userId);
            if (!response.ok) {
              throw new GpuSubmitHttpError(response.status, await parseImageTo3dError(response));
            }
            const data = await response.json();
            return data.job_id;
          }
          const formData = new URLSearchParams();
          formData.append("image_url", imageUrl);
          formData.append("user_id", userId);
          const { response } = await fetchGateway("/image-to-3d", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formData.toString(),
          });
          if (!response.ok) {
            throw new GpuSubmitHttpError(response.status, await parseImageTo3dError(response));
          }
          const data = await response.json();
          return data.job_id;
        };

        const createdJobId = await (async () => {
          try {
            return await submitWithGpuRestartRetry(submitToGpu);
          } catch (submitErr) {
            const { refundCredit } = await import("../services/credits.js");
            await refundCredit(userId, creditsToCharge);
            throw submitErr;
          }
        })();

        // Create job in database with user_id and credits_used
        const canonicalImageUrl = unwrapImageProxyUrl(body.imageUrl) || body.imageUrl || null;
        const sourceImages = canonicalImageUrl && (canonicalImageUrl.startsWith("http://") || canonicalImageUrl.startsWith("https://"))
          ? [canonicalImageUrl]
          : null;
        const detectedGenerateType: GenerateType = "ImageTo3D";
        const finalParentJobId = body.parentJobId || (body.parentJobIds && body.parentJobIds.length > 0 ? body.parentJobIds[0] : null);
        const finalParentJobIds = body.parentJobIds && body.parentJobIds.length > 0
          ? body.parentJobIds
          : (finalParentJobId ? [finalParentJobId] : []);

        await createJob({
          id: createdJobId,
          userId,
          chatId: body.chatId || null,
          workspaceId: body.workspaceId || null,
          parentJobId: finalParentJobId,
          parentJobIds: finalParentJobIds,
          prompt: body.prompt || null,
          imageUrl: canonicalImageUrl,
          sourceImages,
          generateType: detectedGenerateType,
          creditsUsed: creditsToCharge,
          previewImageUrl: canonicalImageUrl,
        });

        return { jobId: createdJobId };
      });

      return res.json({ jobId });
    }

    if (body.prompt) {
      return res.status(400).json({
        error: "Text-to-3D runs as text-to-image then image-to-3d. Call /text-to-image first, then /generate with imageUrl.",
      });
    }

    return res.status(400).json({ error: "imageUrl is required" });
  } catch (err: any) {
    logger.error(err, "failed to submit job");
    if (err?.status === 402) {
      return res.status(402).json({ error: err.message });
    }
    const userMsg = gatewayErrorToUserMessage(err);
    const statusCode = err?.status && err.status >= 400 && err.status < 500 ? err.status : 503;
    return res.status(statusCode).json({
      error: userMsg,
      creditsRefunded: true,
    });
  }
});

// ============================================
// Image generation (OpenAI / Gemini) — credits by tier
// ============================================

type ImageOptions = { provider: ImageProvider; quality: ImageQuality; aspect: ImageAspect };

type ImageJobContext = {
  chatId: string | null;
  workspaceId: string | null;
  parentJobId: string | null;
  parentJobIds: string[];
  sourceImages: string[] | null;
  imageUrl: string | null;
  userPrompt?: string | null;
};

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Validates provider / quality / aspect; sends 400 and returns null when invalid. */
function parseImageOptions(body: any, res: any): ImageOptions | null {
  const provider = parseImageProvider(body?.provider);
  const quality = parseImageQuality(body?.quality);
  const aspect = parseImageAspect(body?.aspect);
  if (!provider) {
    res.status(400).json({ error: "provider must be one of: openai, gemini" });
    return null;
  }
  if (!quality) {
    res.status(400).json({ error: "quality must be one of: low, high" });
    return null;
  }
  if (!aspect) {
    res.status(400).json({ error: "aspect must be one of: 1:1, 3:2, 2:3" });
    return null;
  }
  return { provider, quality, aspect };
}

async function storeGeneratedImage(key: string, image: GeneratedImage): Promise<string> {
  if (!s3Enabled || !s3Client || !config.s3.bucket) {
    throw new Error("S3 is not configured; generated images cannot be stored.");
  }
  const putInput: PutObjectCommandInput = {
    Bucket: config.s3.bucket,
    Key: key,
    Body: image.bytes,
    ContentType: image.mime,
  };
  const acl = process.env.S3_PUT_ACL?.trim();
  if (acl) {
    putInput.ACL = acl as PutObjectCommandInput["ACL"];
  }
  await s3Client.send(new PutObjectCommand(putInput));
  return publicUrlForS3Key(key);
}

/** Fire-and-forget: usage bookkeeping must never fail or slow the user's request. */
function saveImageUsage(record: Omit<ImageUsageRecord, "usage">, calls: UsageCall[]) {
  if (record.status === "failed" && calls.length === 0) {
    return;
  }
  const usage = summarizeUsage(calls);
  recordImageUsage({ ...record, usage }).catch((err: any) => {
    logger.warn(
      { err: err?.message, jobId: record.jobId, userId: record.userId, costUsd: usage.costUsd },
      "Failed to record image usage (non-critical)"
    );
  });
}

/** Charge the tier, call the provider, store the result in S3, record a DONE job. Refunds on failure. */
async function runProviderImageJob(
  res: any,
  userId: string,
  op: ImageOperation,
  prompt: string,
  options: ImageOptions,
  ctx: ImageJobContext,
  inputImage: InputImage | null,
  inputImages?: InputImage[] | null
) {
  const executeGeneration = async () => {
    const credits = IMAGE_CREDITS[op][options.quality];
    const { deductCredit, refundCredit } = await import("../services/credits.js");
    const deductResult = await deductCredit(userId, credits, true);
    if (!deductResult.ok) {
      return { ok: false as const, status: 402, payload: { error: deductResult.error } };
    }

    const jobId = randomUUID();
    const usageCalls: UsageCall[] = [];
    const usageBase = { userId, operation: op, provider: options.provider, quality: options.quality, source: "web" as const };
    const outcome = await runWithUsage(usageCalls, async () => {
      const generated = await generateImage({ ...options, prompt, inputImage, inputImages });
      const key = op === "edit" ? `edit/${jobId}/edited.png` : `preview/${jobId}/preview_image.png`;
      return { image: generated, imageUrl: await storeGeneratedImage(key, generated) };
    }).then(
      (value) => ({ ok: true as const, ...value }),
      (err: any) => ({ ok: false as const, err })
    );

    if (!outcome.ok) {
      const err = outcome.err;
      await refundCredit(userId, credits);
      saveImageUsage(
        {
          ...usageBase,
          jobId: null,
          model: usageCalls.filter((c) => c.kind === "image").at(-1)?.model ?? null,
          status: "failed",
          errorCode: isImageProviderError(err) ? err.code : "IMAGE_GENERATION_FAILED",
          creditsCharged: 0,
        },
        usageCalls
      );
      if (isImageProviderError(err)) {
        logger.warn(
          {
            err: err.message,
            detail: err.detail,
            code: err.code,
            provider: options.provider,
            op,
            ...(err.status === 422 ? { prompt: prompt.slice(0, 200) } : {}),
          },
          "image provider failed"
        );
        return {
          ok: false as const,
          status: err.status,
          payload: {
            success: false,
            error: {
              code: err.code,
              message: err.message,
            },
            code: err.code,
            message: err.message,
          },
        };
      }
      logger.error({ err: err?.message, op }, "image generation failed");
      return {
        ok: false as const,
        status: 500,
        payload: {
          success: false,
          error: {
            code: "IMAGE_GENERATION_FAILED",
            message: "Failed to generate image. Please try again.",
          },
          code: "IMAGE_GENERATION_FAILED",
          message: "Failed to generate image. Please try again.",
        },
      };
    }

    const { image, imageUrl } = outcome;
    saveImageUsage(
      {
        ...usageBase,
        jobId,
        model: image.model,
        status: "succeeded",
        errorCode: null,
        creditsCharged: credits,
      },
      usageCalls
    );

    try {
      await createJob({
        id: jobId,
        userId,
        chatId: ctx.chatId,
        workspaceId: ctx.workspaceId,
        parentJobId: ctx.parentJobId || (ctx.parentJobIds[0] ?? null),
        parentJobIds: ctx.parentJobIds.length > 0 ? ctx.parentJobIds : ctx.parentJobId ? [ctx.parentJobId] : [],
        prompt: (ctx.userPrompt ?? prompt).trim() || null,
        imageUrl: ctx.imageUrl,
        sourceImages: ctx.sourceImages,
        generateType: op === "edit" ? "EditImage" : "TextToImage",
        status: "DONE",
        creditsUsed: credits,
        previewImageUrl: imageUrl,
        llmProvider: options.provider,
        llmModel: image.model,
      });
    } catch (jobErr: any) {
      logger.warn({ err: jobErr?.message, jobId }, "Failed to record image job (non-critical)");
    }

    return {
      ok: true as const,
      status: 200,
      payload: {
        job_id: jobId,
        ...(op === "edit" ? { edit_id: jobId } : { preview_id: jobId }),
        status: "completed",
        image_url: imageUrl,
        prompt: ctx.userPrompt ?? prompt,
        provider: options.provider,
        quality: options.quality,
        ...(op === "edit" ? {} : { aspect: options.aspect }),
        model: image.model,
        credits_used: credits,
      },
    };
  };

  const finalOutcome = inputImage
    ? await executeGeneration()
    : (await runDeduplicatedImageJob(
        userId,
        op,
        prompt,
        options.provider,
        options.quality,
        options.aspect,
        executeGeneration
      )).result;

  return res.status(finalOutcome.status).json(finalOutcome.payload);
}

threeDRouter.post("/text-to-image", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    await syncUserToDatabase(userId);
    const body = (req.body || {}) as Record<string, unknown>;
    const promptValidation = validateImagePrompt(body.prompt);
    if (!promptValidation.ok) {
      return res.status(400).json({ error: promptValidation.error, code: promptValidation.code });
    }
    const prompt = promptValidation.prompt;
    const options = parseImageOptions(body, res);
    if (!options) {
      return;
    }

    await runProviderImageJob(res, userId, "text-to-image", prompt, options, {
      chatId: typeof body.chatId === "string" ? body.chatId : null,
      workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : null,
      parentJobId: typeof body.parentJobId === "string" ? body.parentJobId : null,
      parentJobIds: parseStringArray(body.parentJobIds),
      sourceImages: null,
      imageUrl: null,
    }, null);
  } catch (err: any) {
    logger.error({ err: err.message }, "text-to-image failed");
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Image generation failed" });
    }
  }
});

// ============================================
// Edit image (OpenAI / Gemini) — credits by tier
// ============================================
threeDRouter.post("/edit-image", requireAuth, uploadFlexible, async (req, res) => {
  try {
    const userId = req.userId!;
    await syncUserToDatabase(userId);
    const body = (req.body || {}) as Record<string, unknown>;
    const promptValidation = validateImagePrompt(body.prompt);
    if (!promptValidation.ok) {
      return res.status(400).json({ error: promptValidation.error, code: promptValidation.code });
    }
    const prompt = promptValidation.prompt;
    const imageUrl = typeof body.image_url === "string" && body.image_url.trim() ? body.image_url.trim() : undefined;
    const files: Express.Multer.File[] = Array.isArray(req.files)
      ? (req.files as Express.Multer.File[])
      : (req.file ? [req.file] : []);

    const modelFiles = files.filter((f) => {
      const ext = path.extname(f.originalname || "").toLowerCase();
      return [".glb", ".gltf", ".obj"].includes(ext) || (f.mimetype || "").startsWith("model/");
    });
    if (modelFiles.length > 0) {
      return res.status(400).json({
        error: "3D model editing requires rendered preview snapshots of the model. Please use the rendered preview in Edit Studio to apply modifications.",
      });
    }

    const options = parseImageOptions(body, res);
    if (!options) {
      return;
    }
    const sourceImagesList = parseStringArray(body.sourceImages);

    const resolvedFiles: InputImage[] = files.map((file) => {
      const filename = file.originalname || "image.png";
      return {
        buffer: readMulterFile(file),
        contentType: contentTypeForImageKey(filename, file.mimetype),
        filename,
      };
    });

    const targetUrls = resolvedFiles.length === 0
      ? (sourceImagesList.length > 0 ? sourceImagesList : (imageUrl ? [imageUrl] : []))
      : [];

    const loadedUrlImages = await Promise.all(
      targetUrls.map(async (url) => {
        const loaded = await loadImageBytesFor3dSubmission(url);
        if (loaded) {
          return {
            ...loaded,
            contentType: contentTypeForImageKey(loaded.filename, loaded.contentType),
          };
        }
        if (isImageUrlUnreachableByRemoteWorker(url)) {
          try {
            const local = await loadImageBytesForLocalBackendUrl(url);
            if (local) {
              return {
                ...local,
                contentType: contentTypeForImageKey(local.filename, local.contentType),
              };
            }
          } catch {
            return null;
          }
        }
        return null;
      })
    );

    const validLoadedImages = loadedUrlImages.filter((img): img is InputImage => img !== null);
    const allImages: InputImage[] = resolvedFiles.length > 0 ? resolvedFiles : validLoadedImages;

    if (allImages.length === 0) {
      return res.status(400).json({ error: "Could not load the source image(s) for editing." });
    }

    const userPrompt = prompt.trim();
    const isMultiView = allImages.length >= 2;
    const effectivePrompt = isMultiView
      ? `${MULTI_VIEW_3D_SYSTEM_PROMPT}\n\n${buildMultiView3DEditPrompt(prompt, typeof body.additionalPrompt === "string" ? body.additionalPrompt : null)}`
      : prompt;

    await runProviderImageJob(
      res,
      userId,
      "edit",
      effectivePrompt,
      options,
      {
        chatId: typeof body.chatId === "string" ? body.chatId : null,
        workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : null,
        parentJobId: typeof body.parentJobId === "string" ? body.parentJobId : null,
        parentJobIds: parseStringArray(body.parentJobIds),
        sourceImages: sourceImagesList.length > 0 ? sourceImagesList : (imageUrl ? [imageUrl] : null),
        imageUrl: imageUrl || null,
        userPrompt,
      },
      allImages[0] ?? null,
      allImages.length > 0 ? allImages : null
    );
  } catch (err: any) {
    logger.error({ err: err.message }, "edit-image failed");
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Image edit failed" });
    }
  }
});

// ============================================
// Get Job Status (optional auth for viewing)
// ============================================
threeDRouter.get("/status/:jobId", requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const userId = req.userId;

  if (jobId.startsWith("pending-")) {
    return res.status(404).json({ error: "Job pending submission" });
  }

  try {
    // First, try to get job from database
    let job = await getJob(jobId);

    // Water jobs are not GPU/mesh jobs — never treat them as GLB pipeline status.
    if (job && (isWaterJobId(jobId) || isWaterJobRow(job as any))) {
      if (denyIfNotJobOwner(job, userId, res)) return;
      return res.status(400).json({
        error: "water_job",
        message: "This is a Water job. Use GET /api/water/jobs/:id instead of /api/3d/status.",
      });
    }

    // If job exists and is completed, return it immediately (no need to check external API)
    // Also return immediately for preview-only jobs (they don't exist in Python API)
    if (
      job &&
      (job.status === "DONE" ||
        job.status === "FAIL" ||
        PROVIDER_IMAGE_TYPES.includes(job.generateType as GenerateType) ||
        (job.previewImageUrl && !job.resultGlbUrl))
    ) {
      // Check ownership
      if (denyIfNotJobOwner(job, userId, res)) {
        return;
      }

      // Safety check: if job failed and still has credits_used > 0, refund now
      if (job.status === "FAIL" && job.userId && (job.creditsUsed ?? 0) > 0) {
        const refundAmount = job.creditsUsed;
        const { refundCredit } = await import("../services/credits.js");
        await refundCredit(job.userId, refundAmount);
        await updateJobStatus(jobId, { status: "FAIL", creditsUsed: 0 });
        job.creditsUsed = 0;
      }
      
      // Normalize URLs to ensure they're direct S3 URLs (not expired signed URLs)
      if (job.resultGlbUrl) {
        job.resultGlbUrl = normalizeGlbUrl(jobId, job.resultGlbUrl);
      }
      if (job.previewImageUrl) {
        job.previewImageUrl = normalizePreviewUrl(jobId, job.previewImageUrl);
      }
      
      return res.json({ job, creditsRefunded: job.status === "FAIL" });
    }

    // 16-minute timeout cap (allows 12+ min generations when GPU OOM restart occurs)
    const MAX_JOB_AGE_MS = 16 * 60 * 1000;
    const elapsedMs = job ? Date.now() - new Date(job.createdAt).getTime() : 0;

    // For pending/processing jobs or if job doesn't exist, try to fetch from external API
    // But if API is unreachable and we have the job in DB, return the DB version
    let apiJob = null;
    try {
      // Create abort controller for timeout (gateway may be busy processing; allow time to respond)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
      
      const { response } = await fetchGateway(`/status/${jobId}`, {
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      if (response.ok) {
        apiJob = await response.json();
      } else if (response.status === 404) {
        // If API says job not found and we don't have it in DB, return 404
        if (!job) {
          return res.status(404).json({ error: "Job not found" });
        }
        // If we have it in DB but API says not found, check if it timed out past 16 minutes
        if (denyIfNotJobOwner(job, userId, res)) return;
        
        if ((job.status === "WAIT" || job.status === "RUN") && elapsedMs >= MAX_JOB_AGE_MS) {
          const refundAmount = Boolean(job.userId) && (job.creditsUsed ?? 0) > 0 ? job.creditsUsed : 0;
          const timeoutMessage = "Generation timed out. Your credits have been automatically refunded.";
          await updateJobStatus(jobId, {
            status: "FAIL",
            errorCode: "GENERATION_TIMEOUT",
            errorMessage: timeoutMessage,
            creditsUsed: refundAmount > 0 ? 0 : undefined,
          });
          if (refundAmount > 0 && job.userId) {
            const { refundCredit } = await import("../services/credits.js");
            await refundCredit(job.userId, refundAmount);
          }
          job.status = "FAIL";
          job.errorMessage = timeoutMessage;
          job.creditsUsed = 0;
          return res.json({ job, creditsRefunded: true });
        }

        // Normalize URLs to ensure they're direct S3 URLs (not expired signed URLs)
        if (job.resultGlbUrl) {
          job.resultGlbUrl = normalizeGlbUrl(jobId, job.resultGlbUrl);
        }
        if (job.previewImageUrl) {
          job.previewImageUrl = normalizePreviewUrl(jobId, job.previewImageUrl);
        }
        
        return res.json({ job });
      }
    } catch (apiErr: any) {
      // External API is unreachable (timeout, network error, etc.)
      const isTimeout = apiErr.name === 'AbortError' || apiErr.message?.includes('timeout') || apiErr.message?.includes('Connect Timeout');
      logger.warn({ jobId, err: apiErr.message, isTimeout }, "External API unreachable, using database data");
      
      // If we have the job in database, return it
      if (job) {
        if (denyIfNotJobOwner(job, userId, res)) {
          return;
        }

        // 16-minute timeout check:
        // If GPU gateway is unreachable and job has reached or exceeded 16 minutes, expire and refund it.
        const ageMs = Date.now() - new Date(job.createdAt).getTime();
        if ((job.status === "WAIT" || job.status === "RUN") && ageMs >= MAX_JOB_AGE_MS) {
          const refundAmount = Boolean(job.userId) && (job.creditsUsed ?? 0) > 0 ? job.creditsUsed : 0;
          const timeoutMessage = "Generation timed out. Your credits have been automatically refunded.";
          await updateJobStatus(jobId, {
            status: "FAIL",
            errorCode: "GENERATION_TIMEOUT",
            errorMessage: timeoutMessage,
            creditsUsed: refundAmount > 0 ? 0 : undefined,
          });
          if (refundAmount > 0 && job.userId) {
            const { refundCredit } = await import("../services/credits.js");
            await refundCredit(job.userId, refundAmount);
          }
          job.status = "FAIL";
          job.errorMessage = timeoutMessage;
          job.creditsUsed = 0;
          return res.json({ job, creditsRefunded: true });
        }
        
        // Normalize URLs to ensure they're direct S3 URLs (not expired signed URLs)
        if (job.resultGlbUrl) {
          job.resultGlbUrl = normalizeGlbUrl(jobId, job.resultGlbUrl);
        }
        if (job.previewImageUrl) {
          job.previewImageUrl = normalizePreviewUrl(jobId, job.previewImageUrl);
        }
        
        return res.json({ job, creditsRefunded: job.status === "FAIL" });
      }
      
      // If no job in DB and API is unreachable, return error
      return res.status(503).json({ 
        error: "GPU is unavailable" 
      });
    }

    // If we got data from API, process it
    if (!apiJob) {
      // Should not reach here, but handle it
      if (job) {
        if (denyIfNotJobOwner(job, userId, res)) return;
        
        // Normalize URLs to ensure they're direct S3 URLs (not expired signed URLs)
        if (job.resultGlbUrl) {
          job.resultGlbUrl = normalizeGlbUrl(jobId, job.resultGlbUrl);
        }
        if (job.previewImageUrl) {
          job.previewImageUrl = normalizePreviewUrl(jobId, job.previewImageUrl);
        }
        
        return res.json({ job });
      }
      return res.status(404).json({ error: "Job not found" });
    }

    // Get or create job in database
    if (!job) {
      // Create job if it doesn't exist (for legacy support)
      await createJob({
        id: jobId,
        userId: userId || null,
        prompt: apiJob.result?.prompt || null,
        imageUrl: null,
        generateType: "ImageTo3D",
      });
      job = await getJob(jobId);
    }

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Check ownership (allow viewing if no userId or if user owns the job or if job has no owner)
    if (denyIfNotJobOwner(job, userId, res)) return;

    // Update job status from API
    const status = convertStatus(apiJob.status);
    await updateJobStatus(jobId, { status });

    if (apiJob.status === "completed" && apiJob.result) {
      const apiGlbUrl = apiJob.result.mesh_url || apiJob.result.output;
      const apiPreviewUrl = apiJob.result.processed_image_url || apiJob.result.generated_image_url || apiJob.result.processed_image || apiJob.result.generated_image;
      
      // Use direct S3 URLs (public bucket, no expiration)
      const glbUrl = normalizeGlbUrl(jobId, apiGlbUrl);
      const previewUrl = normalizePreviewUrl(jobId, apiPreviewUrl);
      
      await updateJobResult(jobId, {
        resultGlbUrl: glbUrl,
        previewImageUrl: previewUrl,
      });
      job.resultGlbUrl = glbUrl;
      job.previewImageUrl = previewUrl;
    }

    if (apiJob.status === "failed" || apiJob.status === "cancelled") {
      const wasInFlight = job.status === "WAIT" || job.status === "RUN" || !job.status;
      const refundAmount = wasInFlight && job.userId ? (job.creditsUsed ?? 0) : 0;
      const rawError = apiJob.error || (apiJob.status === "cancelled" ? "Job cancelled" : "Job failed");
      const failureMsg = rawError.includes("refunded")
        ? rawError
        : `${rawError}. Your credits have been automatically refunded.`;
      await updateJobStatus(jobId, {
        status,
        errorCode: null,
        errorMessage: failureMsg,
        creditsUsed: refundAmount > 0 ? 0 : undefined,
      });
      if (refundAmount > 0 && job.userId) {
        const { refundCredit } = await import("../services/credits.js");
        await refundCredit(job.userId, refundAmount);
        job.creditsUsed = 0;
      }
      job.errorMessage = failureMsg;
    }

    job.status = status;
    
    // Normalize URLs to ensure they're direct S3 URLs (not expired signed URLs)
    if (job.resultGlbUrl) {
      job.resultGlbUrl = normalizeGlbUrl(jobId, job.resultGlbUrl);
    }
    if (job.previewImageUrl) {
      job.previewImageUrl = normalizePreviewUrl(jobId, job.previewImageUrl);
    }
    
    // Include queue info + live GPU progress for accurate UI updates
    const response_data: Record<string, unknown> = {
      job,
      creditsRefunded: job.status === "FAIL" || apiJob.status === "cancelled",
    };
    const queue = buildQueueInfoFromApiJob(apiJob as Record<string, unknown>);
    if (queue) {
      response_data.queue = queue;
    }
    if (typeof apiJob.progress === "number") {
      response_data.progress = apiJob.progress;
    }
    if (typeof apiJob.message === "string" && apiJob.message.trim()) {
      response_data.message = apiJob.message;
    }
    if (typeof apiJob.created_at === "number") {
      response_data.created_at =
        apiJob.created_at < 1e12 ? apiJob.created_at * 1000 : apiJob.created_at;
    }

    res.json(response_data);
  } catch (err: any) {
    logger.error(err, "failed to query job");
    res.status(500).json({ error: gatewayErrorToUserMessage(err) });
  }
});

// ============================================
// Cancel 3D / image Job (proxy to Python gateway)
// ============================================
threeDRouter.post("/cancel/:jobId", requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const userId = req.userId;

  try {
    const job = await getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (denyIfNotJobOwner(job, userId, res)) {
      return;
    }

    if (isWaterJobId(jobId) || isWaterJobRow(job as any)) {
      return res.status(400).json({
        error: "Use POST /api/water/jobs/:jobId/cancel for Water jobs",
      });
    }

    const status = String(job.status || "").toUpperCase();
    if (status === "DONE" || PROVIDER_IMAGE_TYPES.includes(job.generateType as GenerateType)) {
      return res.status(400).json({ error: "Job already completed" });
    }
    if (status === "FAIL" && String(job.errorMessage || "").toLowerCase().includes("cancel")) {
      return res.json({ job_id: jobId, status: "cancelled", message: "Job cancelled" });
    }

    // Mark local job cancelled while still in-flight so UI/poll see FAIL immediately.
    const wasInFlight = status === "WAIT" || status === "RUN" || status === "PENDING" || !status;
    const refundAmount = wasInFlight && userId ? (job.creditsUsed ?? 0) : 0;
    if (wasInFlight) {
      const cancelMessage = "Cancelled by user. Your credits have been automatically refunded.";
      await updateJobStatus(jobId, {
        status: "FAIL",
        errorMessage: cancelMessage,
        creditsUsed: refundAmount > 0 ? 0 : undefined,
      });
      if (refundAmount > 0 && userId) {
        const { refundCredit } = await import("../services/credits.js");
        await refundCredit(userId, refundAmount);
        job.creditsUsed = 0;
      }
    }

    // Best-effort notify GPU so workers skip remaining stages
    const gatewayMessage = await (async (): Promise<string> => {
      try {
        const { response } = await fetchGateway(`/cancel/${jobId}`, { method: "POST" });
        const data = await response.json().catch(() => ({} as any));
        if (response.ok) {
          return data.message || "Job cancelled";
        }
        if (response.status === 404 || response.status === 400) {
          // Job never reached GPU, or already terminal there — local cancel still wins
          logger.info(
            { jobId, gatewayStatus: response.status, err: data.error },
            "GPU cancel soft-succeeded"
          );
          return "Job cancelled";
        }
        logger.warn(
          { jobId, gatewayStatus: response.status, err: data.error },
          "GPU cancel returned error; local job already marked cancelled"
        );
        return "Job cancelled";
      } catch (gwErr: any) {
        logger.warn({ jobId, err: gwErr?.message }, "GPU cancel request failed; local job marked cancelled");
        return "Job cancelled";
      }
    })();

    if (!wasInFlight && status !== "FAIL") {
      await updateJobStatus(jobId, { status: "FAIL", errorMessage: "Cancelled by user" });
    }

    res.json({
      job_id: jobId,
      status: "cancelled",
      message: gatewayMessage,
      creditsRefunded: refundAmount > 0,
    });
  } catch (err: any) {
    logger.error(err, "cancel job");
    res.status(500).json({ error: gatewayErrorToUserMessage(err) });
  }
});

// ============================================
// Get Job Result
// ============================================
threeDRouter.get("/result/:jobId", requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const userId = req.userId;

  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    // Check ownership
    if (denyIfNotJobOwner(job, userId, res)) return;

    if (PROVIDER_IMAGE_TYPES.includes(job.generateType as GenerateType)) {
      if (job.previewImageUrl) {
        job.previewImageUrl = normalizePreviewUrl(jobId, job.previewImageUrl);
      }
      return res.json({ job });
    }

    // Fetch from API for latest result
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const { response } = await fetchGateway(`/status/${jobId}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const apiJob = await response.json();
        if (apiJob.status === "completed" && apiJob.result) {
          const apiGlbUrl = apiJob.result.mesh_url || apiJob.result.output;
          const apiPreviewUrl = apiJob.result.processed_image_url || apiJob.result.generated_image_url || apiJob.result.processed_image || apiJob.result.generated_image;
          
          // Use direct S3 URLs (public bucket, no expiration)
          const glbUrl = normalizeGlbUrl(jobId, apiGlbUrl);
          const previewUrl = normalizePreviewUrl(jobId, apiPreviewUrl);
          
          if (glbUrl || previewUrl) {
            await updateJobResult(jobId, {
              resultGlbUrl: glbUrl,
              previewImageUrl: previewUrl,
            });
            job.resultGlbUrl = glbUrl;
            job.previewImageUrl = previewUrl;
          }
        }
      }
    } catch (err) {
      logger.error(err, "failed to fetch from API, using cached result");
    }

    // Normalize URLs to ensure they're direct S3 URLs (not expired signed URLs)
    if (job.resultGlbUrl) {
      job.resultGlbUrl = normalizeGlbUrl(jobId, job.resultGlbUrl);
    }
    if (job.previewImageUrl) {
      job.previewImageUrl = normalizePreviewUrl(jobId, job.previewImageUrl);
    }

    res.json({ job });
  } catch (err: any) {
    res.status(500).json({ error: gatewayErrorToUserMessage(err) });
  }
});

// ============================================
// Get Queue Info (for accurate time estimation)
// ============================================
// Fallback queue info when Python API is unavailable (avoids duplication)
// Default 3D job time (seconds) - should match gateway ESTIMATED_3D_TIME for consistent ETA
const DEFAULT_ESTIMATED_3D_SECONDS = 300; // 5 min - conservative so progress/ETA don't overshoot
const QUEUE_INFO_FALLBACK = {
  error: "GPU API is currently unavailable",
  api_available: false,
  queue_length: 0,
  currently_processing: false,
  waiting_jobs: 0,
  jobs_ahead_for_new: 0,
  estimated_wait_for_new_job_seconds: DEFAULT_ESTIMATED_3D_SECONDS,
  estimated_total_seconds: DEFAULT_ESTIMATED_3D_SECONDS,
  estimated_time_per_job_seconds: DEFAULT_ESTIMATED_3D_SECONDS,
  preview_queue_length: 0,
  currently_generating_preview: false,
  preview_waiting: 0,
  estimated_wait_for_preview_seconds: 0,
  estimated_preview_time_seconds: 25,
};

threeDRouter.get("/queue/info", async (_req, res) => {
  try {
    // Respond before frontend timeout: use 1.5s so we always send a response first
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);

    const init = { signal: controller.signal };
    const queueInfo = await fetchQueueInfoFromGateway(GPU_GATEWAY, init);
    clearTimeout(timeoutId);

    if (queueInfo && Object.keys(queueInfo).length > 0) {
      if (!res.headersSent) {
        return res.json({ ...queueInfo, api_available: true });
      }
      return;
    }
    logger.warn("Python API returned no queue info from GPU gateway");
    // Return 200 with fallback so 3D form is not blocked; only actual submit failure shows GPU offline
    if (!res.headersSent) {
      return res.status(200).json({ ...QUEUE_INFO_FALLBACK, api_available: false });
    }
    return;
  } catch (err: any) {
    const isClientAbort = err.name === "AbortError" || err.message === "This operation was aborted";
    if (isClientAbort && res.headersSent) {
      return;
    }
    if (!isClientAbort) {
      logger.warn({ err: err.message }, "Failed to fetch queue info from Python API");
    }
    // Return 200 with fallback so queue check never blocks 3D; GPU offline only on actual submit failure
    if (!res.headersSent) {
      try {
        return res.status(200).json({ ...QUEUE_INFO_FALLBACK, api_available: false });
      } catch (_) {
        // Client may have closed the connection; ignore write errors
      }
    }
  }
});

// ============================================
// Health check
// Image features come from provider keys (OpenAI / Gemini); image-to-3d from the GPU VM.
// ============================================

type GpuFeatures = {
  text_to_image: boolean;
  text_to_3d: boolean;
  image_to_3d: boolean;
  edit_image: boolean;
};

function isGpuPipelineReady(body: any): boolean {
  if (!body) return false;
  if (body.features && typeof body.features === "object" && body.features.image_to_3d === false) {
    return false;
  }
  return !!(
    body.pipeline_loaded === true ||
    body.model_loaded === true ||
    body.trellis_loaded === true ||
    body.trellis2_pipeline_loaded === true
  );
}

async function probeGpuVm(): Promise<{ reachable: boolean; ready: boolean; raw: any }> {
  try {
    const res = await fetch(`${GPU_GATEWAY}/health`, withInternalSecretHeaders({ signal: AbortSignal.timeout(5000) }));
    if (!res.ok) return { reachable: false, ready: false, raw: null };
    const raw = await res.json().catch(() => null);
    return { reachable: !!raw, ready: isGpuPipelineReady(raw), raw };
  } catch {
    return { reachable: false, ready: false, raw: null };
  }
}

threeDRouter.get("/health", async (_req, res) => {
  const [providers, gpu] = await Promise.all([imageProviderAvailability(), probeGpuVm()]);
  const imageAvailable = providers.openai || providers.gemini;
  const features: GpuFeatures = {
    text_to_image: imageAvailable,
    edit_image: imageAvailable,
    image_to_3d: gpu.ready,
    text_to_3d: imageAvailable && gpu.ready,
  };
  const status: "ok" | "degraded" | "down" =
    imageAvailable && gpu.ready ? "ok" : imageAvailable || gpu.ready ? "degraded" : "down";

  return res.status(200).json({
    status,
    mode: "cloud",
    features,
    providers,
    gpu: {
      reachable: gpu.reachable,
      ready: gpu.ready,
      status: gpu.raw?.status ?? (gpu.reachable ? "unknown" : "unreachable"),
      model: gpu.raw?.model ?? null,
    },
    image: { reachable: imageAvailable, ready: imageAvailable },
    trellis: { reachable: gpu.reachable, ready: gpu.ready },
    ...(gpu.reachable ? {} : { gateway: "unreachable" }),
    queues: {
      "3d": gpu.raw?.queue_length ?? gpu.raw?.queues?.queue_length ?? 0,
    },
  });
});

// ============================================
// Proxy GLB file from S3 (to avoid CORS issues)
// ============================================
threeDRouter.get("/glb/:jobId", optionalAuth, async (req, res) => {
  const { jobId } = req.params;
  const userId = req.userId;

  try {
    // Get job to verify ownership and get GLB URL
    const job = await getJob(jobId);
    if (!job) {
      // Fallback: check S3 directly for this jobId if DB row is missing
      if (s3Enabled && s3Client) {
        const candidateKeys = [
          `image/${jobId}/mesh.glb`,
          `text/${jobId}/mesh.glb`,
        ];
        try {
          const { key: _resolvedKey, out: s3Response } = await getFirstExistingS3Object(candidateKeys);
          const contentLength = s3Response.ContentLength || 0;
          res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
          res.setHeader("Content-Type", "model/gltf-binary");
          res.setHeader("Content-Disposition", 'inline; filename="mesh.glb"');
          res.setHeader("Cache-Control", "public, max-age=3600");
          if (contentLength > 0) {
            res.setHeader("Content-Length", contentLength.toString());
          }
          if (s3Response.Body) {
            const stream = s3Response.Body as Readable;
            stream.pipe(res);
            return;
          }
        } catch {
          // continue to 404
        }
      }
      return res.status(404).json({ error: "Job not found" });
    }

    // Check ownership if user is authenticated and job has an owner
    if (job.userId && userId && job.userId !== userId) {
      return res.status(403).json({ error: "You don't have permission to access this job" });
    }

    if (isWaterJobId(jobId) || isWaterJobRow(job as any)) {
      return res.status(404).json({
        error: "Water jobs have no GLB mesh. Open via /api/water/jobs/:id (procedural Three.js).",
      });
    }

    // Get GLB URL
    const glbUrl = job.resultGlbUrl;
    if (!glbUrl) {
      return res.status(404).json({ error: "GLB file not found for this job" });
    }

    // If it's one of our current or legacy S3 URLs, fetch from the configured bucket.
    // Old DB rows may still point at hydrilla-outputs/ap-south-1, but the object keys
    // were migrated to the new bucket.
    const glbS3Key = extractOwnedS3KeyFromUrl(glbUrl);
    if (glbS3Key && s3Enabled && s3Client) {
      try {
        const { key: resolvedKey, out: s3Response } = await getFirstExistingS3Object(glbKeyCandidates(glbS3Key));
          
        // Get content length for progress tracking
        const contentLength = s3Response.ContentLength || s3Response.ContentLength || 0;
          
        // Set CORS and cache headers (browser can cache GLB for 1 hour)
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.setHeader("Content-Type", "model/gltf-binary");
        res.setHeader("Content-Disposition", `inline; filename="mesh.glb"`);
        res.setHeader("Cache-Control", "public, max-age=3600");
        if (contentLength > 0) {
          res.setHeader("Content-Length", contentLength.toString());
        }
          
        // Pipe S3 stream directly to response (no buffering = faster first byte)
        if (s3Response.Body) {
          const stream = s3Response.Body as Readable;
          stream.on("error", (err: Error) => {
            logger.error({ jobId, s3Key: resolvedKey, err: err.message }, "Error streaming from S3");
            if (!res.headersSent) res.status(500).json({ error: "Failed to stream GLB file" });
          });
          stream.pipe(res);
          return;
        }
      } catch (s3Err: any) {
        logger.warn({ jobId, err: s3Err.message }, "Failed to fetch from S3, trying direct URL");
      }
    }

    // Fallback: proxy through backend by streaming the URL (no buffering = faster first byte)
    try {
      const response = await fetch(glbUrl);
      if (!response.ok) {
        return res.status(response.status).json({ error: "Failed to fetch GLB file" });
      }

      const contentLength = response.headers.get("content-length");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Content-Type", "model/gltf-binary");
      res.setHeader("Content-Disposition", `inline; filename="mesh.glb"`);
      res.setHeader("Cache-Control", "public, max-age=3600");
      if (contentLength) res.setHeader("Content-Length", contentLength);

      // Stream response body to client (Node 18+ Readable.fromWeb = faster first byte)
      const body = response.body;
      if (body) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fetch body is web ReadableStream; fromWeb accepts it at runtime
        const nodeStream = Readable.fromWeb(body as any);
        nodeStream.pipe(res);
      } else {
        const buffer = await response.arrayBuffer();
        res.send(Buffer.from(buffer));
      }
    } catch (fetchErr: any) {
      logger.error({ jobId, err: fetchErr.message }, "Failed to proxy GLB file");
      res.status(500).json({ error: "Failed to load GLB file" });
    }
  } catch (err: any) {
    logger.error({ err, jobId }, "Error proxying GLB file");
    res.status(500).json({ error: err.message || "Failed to proxy GLB file" });
  }
});

// ============================================
// Proxy image from S3 (to avoid CORS issues when the browser fetches image bytes)
// ============================================
// No requireAuth: <img> tags cannot send Bearer tokens. Access is limited by
// isAllowedImageProxyUrl (Hydrilla S3 / GPU hosts only) — objects are already public.
threeDRouter.get("/image-proxy", async (req, res) => {
  const imageUrl = req.query.url as string;
  if (!imageUrl) {
    return res.status(400).json({ error: "url query parameter is required" });
  }

  // Only allow proxying from known Hydrilla S3 buckets / GPU hosts
  if (!isAllowedImageProxyUrl(imageUrl)) {
    return res.status(403).json({ error: "URL not allowed for proxying" });
  }

  try {
    // If it's one of our current or legacy S3 URLs, fetch from the configured bucket.
    const imageS3Key = extractOwnedS3KeyFromUrl(imageUrl);
    if (imageS3Key && s3Enabled && s3Client) {
      try {
        const { key: resolvedKey, out: s3Response } = await getFirstExistingS3Object(imageKeyCandidates(imageS3Key));
        const contentLength = s3Response.ContentLength || 0;
        res.setHeader("Content-Type", contentTypeForImageKey(resolvedKey, s3Response.ContentType || undefined));
        res.setHeader("Cache-Control", "public, max-age=3600");
        if (contentLength > 0) res.setHeader("Content-Length", contentLength.toString());

        if (s3Response.Body) {
          const stream = s3Response.Body as Readable;
          stream.on("error", (err: Error) => {
            logger.error({ s3Key: resolvedKey, err: err.message }, "Error streaming image from S3");
            if (!res.headersSent) res.status(500).json({ error: "Failed to stream image" });
          });
          stream.pipe(res);
          return;
        }
      } catch (s3Err: any) {
        logger.warn({ err: s3Err.message }, "Failed to fetch image from S3, trying direct URL");
      }
    }

    // Fallback: proxy through direct fetch
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return res.status(response.status).json({ error: "Failed to fetch image" });
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const contentLength = response.headers.get("content-length");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    const body = response.body;
    if (body) {
      const nodeStream = Readable.fromWeb(body as any);
      nodeStream.pipe(res);
    } else {
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "Error proxying image");
    res.status(500).json({ error: err.message || "Failed to proxy image" });
  }
});

// ============================================
// Get User's Job History (optional auth - returns empty if not authenticated)
// ============================================
threeDRouter.get("/history", requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    
    // If authenticated, return only user's jobs
    // If not authenticated, return empty array (for security)
    if (userId) {
      try {
        const jobs = await listJobsForUser(userId, 100);
        
        // Normalize URLs for all jobs to ensure they're direct S3 URLs (not expired signed URLs)
        if (jobs && jobs.length > 0) {
          jobs.forEach(job => {
            if (job.resultGlbUrl) {
              job.resultGlbUrl = normalizeGlbUrl(job.id, job.resultGlbUrl);
            }
            if (job.previewImageUrl) {
              job.previewImageUrl = normalizePreviewUrl(job.id, job.previewImageUrl);
            }
          });
          
          logger.info({ 
            jobId: jobs[0].id, 
            glbUrl: jobs[0].resultGlbUrl, 
            previewUrl: jobs[0].previewImageUrl,
            status: jobs[0].status
          }, "Sample job from history");
        }
        
        res.json({ jobs: jobs || [] });
      } catch (dbErr: any) {
        logger.error({ err: dbErr, userId }, "Database error fetching jobs");
        // Return empty array instead of error to prevent frontend crash
        // This allows the frontend to load even if database has issues
        res.json({ jobs: [] });
      }
    } else {
      // For unauthenticated requests, return empty to protect user data
      res.json({ jobs: [] });
    }
  } catch (err: any) {
    logger.error({ err, userId: req.userId }, "Failed to fetch history");
    res.status(500).json({ error: err.message || "Failed to fetch history" });
  }
});

// ============================================
// Delete a Job (requires auth)
// ============================================
threeDRouter.delete("/jobs/:jobId", requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const userId = req.userId!;

  try {
    const job = await getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Check ownership
    if (job.userId !== userId) {
      return res.status(403).json({ error: "You don't have permission to delete this job" });
    }

    await deleteJob(jobId, userId);
    res.json({ success: true, message: "Job deleted" });
  } catch (err: any) {
    logger.error(err, "failed to delete job");
    res.status(500).json({ error: err.message || "Failed to delete job" });
  }
});

// ============================================
// Chat Management Endpoints
// ============================================

// Get all chats for user
threeDRouter.get("/chats", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const chats = await listChatsForUser(userId, 100);
    res.json({ chats });
  } catch (err: any) {
    logger.error(err, "failed to fetch chats");
    // Check if error is due to missing table
    if (err.code === "TABLE_NOT_FOUND" || 
        (err.message && (err.message.includes("relation") || err.message.includes("does not exist")))) {
      logger.warn("Chats table does not exist yet. Please run the migration.");
      res.status(200).json({ chats: [] }); // Return empty array instead of error
    } else {
      res.status(500).json({ error: err.message || "Failed to fetch chats" });
    }
  }
});

// Get or create active chat (most recent chat, or create new one)
// IMPORTANT: This must come BEFORE /chats/:chatId to avoid route conflicts
threeDRouter.get("/chats/active", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    
    // Ensure user exists in database before creating chat (chats table has FK to users)
    try {
      await syncUserToDatabase(userId);
    } catch (syncErr: any) {
      logger.warn({ err: syncErr, userId }, "Failed to sync user to database, continuing anyway");
      // Continue - user might already exist
    }
    
    const chat = await getOrCreateActiveChat(userId);
    res.json({ chat });
  } catch (err: any) {
    logger.error({ 
      err, 
      userId: req.userId, 
      errorCode: err.code, 
      errorMessage: err.message,
      errorStack: err.stack 
    }, "failed to get or create active chat");
    
    // Check if error is due to missing table
    if (err.code === "TABLE_NOT_FOUND" || 
        (err.message && (err.message.includes("relation") || err.message.includes("does not exist")))) {
      logger.warn("Chats table does not exist yet. Please run the migration.");
      res.status(200).json({ chat: null }); // Return null instead of error
      return;
    }
    
    // Check if error is due to user not existing (foreign key violation)
    if (err.message && err.message.includes("does not exist") && err.message.includes("User")) {
      logger.warn({ userId: req.userId }, "User does not exist in database - returning null chat");
      res.status(200).json({ chat: null }); // Return null instead of error
      return;
    }
    
    // For all other errors, return null gracefully instead of 500
    // This prevents the frontend from showing errors when the backend has issues
    logger.warn({ 
      fullError: err,
      errorDetails: {
        code: err.code,
        message: err.message,
        details: err.details,
        hint: err.hint,
      }
    }, "Error getting active chat - returning null gracefully");
    res.status(200).json({ chat: null }); // Return null instead of error to prevent frontend crashes
  }
});

// Get a specific chat with its jobs
threeDRouter.get("/chats/:chatId", requireAuth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.userId!;

    const chat = await getChatForUser(chatId, userId);
    if (!chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    // Get all jobs in this chat
    const { data: jobsData, error: jobsError } = await supabase
      .from("jobs")
      .select("*")
      .eq("chat_id", chatId)
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (jobsError) throw jobsError;

    const jobs = (jobsData || []).map((row: any) => {
      // Normalize URLs to remove expired signed URL parameters
      let imageUrl = row.image_url;
      let previewImageUrl = row.preview_image_url;
      let resultGlbUrl = row.result_glb_url;
      
      // Normalize image URLs
      if (imageUrl && imageUrl.includes('amazonaws.com')) {
        imageUrl = imageUrl.split('?')[0]; // Strip query params
      }
      if (previewImageUrl) {
        previewImageUrl = normalizePreviewUrl(row.id, previewImageUrl);
      }
      if (resultGlbUrl) {
        resultGlbUrl = normalizeGlbUrl(row.id, resultGlbUrl);
      }
      
      return {
        id: row.id,
        userId: row.user_id || null,
        chatId: row.chat_id || null,
        status: row.status,
        prompt: row.prompt,
        imageUrl: imageUrl,
        generateType: row.generate_type,
        resultGlbUrl: resultGlbUrl,
        previewImageUrl: previewImageUrl,
        errorMessage: row.error_message,
        durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    res.json({ chat, jobs });
  } catch (err: any) {
    logger.error(err, "failed to fetch chat");
    res.status(500).json({ error: err.message || "Failed to fetch chat" });
  }
});

// Create a new chat
threeDRouter.post("/chats", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const { name } = req.body as { name?: string };

    // Ensure user exists in DB so chat insert (FK on user_id) succeeds
    await syncUserToDatabase(userId);

    const chat = await createChat({
      userId,
      name: name || "New Chat",
    });

    res.json({ chat });
  } catch (err: any) {
    logger.error(err, "failed to create chat");
    res.status(500).json({ error: err.message || "Failed to create chat" });
  }
});

// Update chat name
threeDRouter.patch("/chats/:chatId/name", requireAuth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.userId!;
    const { name } = req.body as { name: string };

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Chat name is required" });
    }

    await updateChatName(chatId, name.trim(), userId);
    res.json({ success: true });
  } catch (err: any) {
    logger.error(err, "failed to update chat name");
    res.status(500).json({ error: err.message || "Failed to update chat name" });
  }
});

// Delete a chat
threeDRouter.delete("/chats/:chatId", requireAuth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.userId!;

    const chat = await getChatForUser(chatId, userId);
    if (!chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    await deleteChat(chatId, userId);
    res.json({ success: true, message: "Chat deleted" });
  } catch (err: any) {
    logger.error(err, "failed to delete chat");
    res.status(500).json({ error: err.message || "Failed to delete chat" });
  }
});

// ============================================
// Register Job (with optional auth)
// ============================================
threeDRouter.post("/register-job", requireAuth, async (req, res) => {
  try {
    const { job_id, prompt, imageUrl, previewImageUrl, previewJobId, parentJobId, parentJobIds, chatId, workspaceId, generateType: reqGenerateType, sourceImages } = req.body as {
      job_id: string;
      prompt?: string;
      imageUrl?: string;
      previewImageUrl?: string;
      previewJobId?: string;
      parentJobId?: string;
      parentJobIds?: string[];   // Multi-parent lineage IDs
      chatId?: string;
      workspaceId?: string;
      generateType?: string;
      sourceImages?: string[];   // Actual source image URLs used as input
    };
    const userId = req.userId;
    
    // Get or create active chat if user is authenticated, no chatId provided,
    // and this is NOT a workspace job (workspace jobs don't need chats — saves a DB round-trip)
    let finalChatId: string | null = chatId || null;
    if (userId && !finalChatId && !workspaceId) {
      try {
        const activeChat = await getOrCreateActiveChat(userId);
        finalChatId = activeChat.id;
        logger.info({ jobId: job_id, chatId: finalChatId }, "Using active chat for job");
      } catch (chatErr) {
        logger.warn({ err: chatErr, jobId: job_id }, "Failed to get/create active chat, continuing without chat");
      }
    }

    if (!job_id) {
      return res.status(400).json({ error: "job_id is required" });
    }

    // Sync user to database if authenticated (IMPORTANT: do this first!)
    if (userId) {
      logger.info({ userId }, "Syncing user to database before job registration");
      const syncResult = await syncUserToDatabase(userId);
      if (!syncResult) {
        logger.warn({ userId }, "User sync returned null, but continuing with job registration");
      }
    }

    // If previewJobId is provided, fetch the preview job to copy prompt
    let previewJob: JobRecord | null = null;
    let finalPrompt = prompt || null;
    
    logger.info({ jobId: job_id, previewJobId, hasPrompt: !!prompt, hasImageUrl: !!imageUrl }, "Register job request received");
    
    if (previewJobId) {
      logger.info({ jobId: job_id, previewJobId }, "Preview job ID provided, fetching preview job");
      previewJob = await getJob(previewJobId);
      if (previewJob) {
        logger.info({ jobId: job_id, previewJobId, previewJobPrompt: previewJob.prompt?.slice(0, 50) }, "Preview job found");
        // Copy prompt from preview job (preview job prompt takes priority)
        if (previewJob.prompt !== null && previewJob.prompt !== undefined) {
          finalPrompt = previewJob.prompt;
          logger.info({ jobId: job_id, previewJobId, prompt: finalPrompt?.slice(0, 50) }, "Copied prompt from preview job");
        } else {
          logger.warn({ jobId: job_id, previewJobId }, "Preview job has no prompt to copy");
        }
      } else {
        logger.warn({ jobId: job_id, previewJobId }, "Preview job not found");
      }
    } else {
      logger.info({ jobId: job_id }, "No preview job ID provided");
      
      // Fallback: If no previewJobId but we have an imageUrl, try to find the preview job
      // by matching the imageUrl with a preview job's previewImageUrl
      if (imageUrl && userId) {
        try {
          const { data: previewJobs, error: previewError } = await supabase
            .from("jobs")
            .select("id, prompt")
            .eq("preview_image_url", imageUrl)
            .eq("user_id", userId)
            .is("result_glb_url", null) // Only preview jobs (no 3D result)
            .limit(1);
          
          if (!previewError && previewJobs && previewJobs.length > 0) {
            const foundPreviewJob = previewJobs[0];
            logger.info({ jobId: job_id, foundPreviewJobId: foundPreviewJob.id, prompt: foundPreviewJob.prompt?.slice(0, 50) }, "Found preview job by matching imageUrl");
            
            // Use the found preview job's prompt
            if (foundPreviewJob.prompt !== null && foundPreviewJob.prompt !== undefined) {
              finalPrompt = foundPreviewJob.prompt;
            }
            // Set previewJobId for later use
            const foundPreviewJobId = foundPreviewJob.id;
            // We'll treat this as if previewJobId was provided
            previewJob = await getJob(foundPreviewJobId);
          }
        } catch (fallbackErr) {
          logger.warn({ err: fallbackErr, jobId: job_id }, "Failed to find preview job by imageUrl fallback");
        }
      }
    }

    // Validate and use provided generateType, fallback to explicit operation types
    const validGenerateTypes: GenerateType[] = [
      "Normal",
      "LowPoly",
      "Geometry",
      "Sketch",
      "TextToImage",
      "TextTo3D",
      "ImageTo3D",
      "EditImage",
    ];
    const finalGenerateType: GenerateType = (reqGenerateType && validGenerateTypes.includes(reqGenerateType as GenerateType))
      ? (reqGenerateType as GenerateType)
      : (previewImageUrl ? "TextToImage" : "ImageTo3D");

    const existingJob = await getJob(job_id);
    if (existingJob) {
      // Check ownership - don't allow updating jobs owned by other users
      if (existingJob.userId && userId && existingJob.userId !== userId) {
        return res.status(403).json({ error: "You don't have permission to update this job" });
      }
      
      // Resolve parent for existing job
      const finalParentJobId = parentJobId || previewJobId || null;

      // Update user_id, chat_id, workspace_id, and parent_job_id if job exists but has no owner and we have a userId
      if (!existingJob.userId && userId) {
        try {
          const updateData: any = { user_id: userId };
          if (finalChatId && !existingJob.chatId) {
            updateData.chat_id = finalChatId;
          }
          if (workspaceId && !existingJob.workspaceId) {
            updateData.workspace_id = workspaceId;
          }
          if (finalParentJobId && !existingJob.parentJobId) {
            updateData.parent_job_id = finalParentJobId;
          }
          await supabase
            .from("jobs")
            .update(updateData)
            .eq("id", job_id);
          logger.info({ jobId: job_id, userId, chatId: finalChatId, workspaceId, parentJobId: finalParentJobId }, "Updated job with user_id, chat_id, workspace_id, parent_job_id");
        } catch (updateErr) {
          logger.warn({ err: updateErr }, "Failed to update job with user_id/chat_id/workspace_id/parent_job_id");
        }
      } else {
        // Job already has an owner - update chat_id, workspace_id, and parent_job_id if not set
        const patchData: any = {};
        if (finalChatId && !existingJob.chatId && userId) {
          patchData.chat_id = finalChatId;
        }
        if (workspaceId && !existingJob.workspaceId) {
          patchData.workspace_id = workspaceId;
        }
        if (finalParentJobId && !existingJob.parentJobId) {
          patchData.parent_job_id = finalParentJobId;
        }
        if (Object.keys(patchData).length > 0) {
          try {
            await supabase
              .from("jobs")
              .update(patchData)
              .eq("id", job_id);
            logger.info({ jobId: job_id, ...patchData }, "Updated existing job with chat_id/workspace_id/parent_job_id");
          } catch (updateErr) {
            logger.warn({ err: updateErr }, "Failed to update job with chat_id/workspace_id/parent_job_id");
          }
        }
      }
      
      // Upsert multi-parent relationships + source_images for existing job
      const existingParentJobIds = (parentJobIds && parentJobIds.length > 0) ? parentJobIds : (finalParentJobId ? [finalParentJobId] : []);
      if (existingParentJobIds.length > 0) {
        await upsertJobParents(job_id, existingParentJobIds);
      }
      const resolvedSourceImages =
        sourceImages && sourceImages.length > 0
          ? sourceImages
          : imageUrl && imageUrl !== "uploaded_file" && (imageUrl.startsWith("http://") || imageUrl.startsWith("https://"))
            ? [imageUrl]
            : null;
      if (resolvedSourceImages && resolvedSourceImages.length > 0 && !existingJob.sourceImages) {
        try {
          await supabase.from("jobs").update({ source_images: JSON.stringify(resolvedSourceImages) }).eq("id", job_id);
        } catch (srcErr) {
          logger.warn({ err: srcErr }, "Failed to update source_images for existing job");
        }
      }

      if (!existingJob.generateType || existingJob.generateType === "Normal") {
        try {
          await supabase
            .from("jobs")
            .update({ generate_type: finalGenerateType, updated_at: new Date().toISOString() })
            .eq("id", job_id);
          logger.info({ jobId: job_id, generateType: finalGenerateType }, "Updated existing job generate_type");
        } catch (typeErr) {
          logger.warn({ err: typeErr, jobId: job_id }, "Failed to update generate_type for existing job");
        }
      }

      // Update prompt from preview job if provided
      if (previewJob) {
        try {
          const updateData: any = { updated_at: new Date().toISOString() };
          let hasUpdates = false;
          
          // Always update prompt if we have it from preview job (even if it's an empty string)
          if (finalPrompt !== null && finalPrompt !== undefined) {
            updateData.prompt = finalPrompt;
            hasUpdates = true;
            logger.info({ jobId: job_id, previewJobId, prompt: finalPrompt?.slice(0, 50) }, "Will update prompt from preview job");
          } else {
            logger.warn({ jobId: job_id, previewJobId, previewJobPrompt: previewJob.prompt }, "Preview job has no prompt to copy");
          }
          
          // Update the job if we have changes
          if (hasUpdates) {
            const { error: updateError } = await supabase
              .from("jobs")
              .update(updateData)
              .eq("id", job_id);
            
            if (updateError) {
              throw updateError;
            }
            
            logger.info({ jobId: job_id, prompt: finalPrompt?.slice(0, 50) }, "Successfully updated existing job with preview job prompt");
          } else {
            logger.warn({ jobId: job_id, previewJobId }, "No updates to apply from preview job");
          }
        } catch (updateErr: any) {
          logger.error({ err: updateErr, jobId: job_id, previewJobId, finalPrompt: finalPrompt?.slice(0, 50) }, "Failed to update job with preview job prompt");
        }
      } else if (previewJobId) {
        logger.warn({ jobId: job_id, previewJobId }, "Preview job not found, cannot copy prompt");
      }
      
      // Update preview image if provided
      if (previewImageUrl) {
        await updateJobResult(job_id, { previewImageUrl });
        // If preview is provided and job doesn't have 3D result, set status to DONE
        if (!existingJob.resultGlbUrl) {
          await updateJobStatus(job_id, { status: "DONE" });
        }
      }

      // Ensure workspace_id is set when provided (e.g. 3D job created by webhook first, then register-job from workspace)
      if (workspaceId && !existingJob.workspaceId) {
        try {
          await supabase.from("jobs").update({ workspace_id: workspaceId }).eq("id", job_id);
          logger.info({ jobId: job_id, workspaceId }, "Set workspace_id on existing job");
        } catch (err: any) {
          logger.warn({ err, jobId: job_id, workspaceId }, "Failed to set workspace_id on existing job (non-critical)");
        }
      }
      
      if (finalChatId) {
        await updateChatUpdatedAt(finalChatId);
      }
      if (workspaceId) {
        await updateWorkspaceUpdatedAt(workspaceId);
      }
      return res.json({ success: true, job_id, message: "Job already exists" });
    }

    // If previewImageUrl is provided, this is a preview-only job (image already generated)
    // Set status to DONE since the preview is complete
    const initialStatus: JobStatus = previewImageUrl ? "DONE" : "WAIT";
    
    // Resolve parent: explicit parentJobId takes priority, then previewJobId (for 3D from image)
    const finalParentJobId = parentJobId || previewJobId || null;
    // Multi-parent IDs: use explicit array if provided, otherwise fall back to single parent
    const finalParentJobIds = (parentJobIds && parentJobIds.length > 0) ? parentJobIds : (finalParentJobId ? [finalParentJobId] : []);

    // Source image for image-to-3D: prefer explicit sourceImages, else imageUrl when it's a real URL
    const resolvedSourceImages =
      sourceImages && sourceImages.length > 0
        ? sourceImages
        : imageUrl && imageUrl !== "uploaded_file" && (imageUrl.startsWith("http://") || imageUrl.startsWith("https://"))
          ? [imageUrl]
          : null;

    // Deduct credits when creating a new 3D job (WAIT, no preview-only); preview-only jobs use 0 credits
    const isHighResolution = req.body?.resolution === "ultra1k" || req.body?.resolution === "high" || req.body?.resolution === 1536 || req.body?.resolution === "1536";
    const resolved3DCredits = isHighResolution ? CREDITS_IMAGE_TO_3D_HIGH : CREDITS_IMAGE_TO_3D;
    const isNew3DJob = initialStatus === "WAIT" && !previewImageUrl;
    const shouldDeduct = Boolean(isNew3DJob && userId);
    const creditsToSet = shouldDeduct ? resolved3DCredits : 0;
    if (shouldDeduct && userId) {
      const { deductCredit } = await import("../services/credits.js");
      const deductResult = await deductCredit(userId, resolved3DCredits, true);
      if (!deductResult.ok) {
        return res.status(402).json({ error: deductResult.error });
      }
    }

    try {
      await createJob({
        id: job_id,
        userId: userId || null,
        chatId: finalChatId,
        workspaceId: workspaceId || null,
        parentJobId: finalParentJobId,
        parentJobIds: finalParentJobIds,
        prompt: finalPrompt,
        imageUrl: imageUrl || null,
        sourceImages: resolvedSourceImages,
        generateType: finalGenerateType,
        status: initialStatus,
        creditsUsed: creditsToSet,
      });
    } catch (createErr) {
      if (shouldDeduct && userId) {
        const { refundCredit } = await import("../services/credits.js");
        await refundCredit(userId, resolved3DCredits);
      }
      throw createErr;
    }
    
    if (finalChatId) {
      await updateChatUpdatedAt(finalChatId);
    }
    
    if (workspaceId) {
      await updateWorkspaceUpdatedAt(workspaceId);
    }
    
    // Update preview image if provided
    if (previewImageUrl) {
      await updateJobResult(job_id, { previewImageUrl });
    }

    logger.info({ jobId: job_id, userId, prompt: finalPrompt?.slice(0, 50) }, "Job registered successfully");
    res.json({ success: true, job_id });
  } catch (err: any) {
    logger.error(err, "failed to register job");
    res.status(500).json({ error: err.message || "Failed to register job" });
  }
});

// ============================================
// Job Lineage (iterative prompting DAG)
// ============================================
threeDRouter.get("/jobs/:jobId/lineage", requireAuth, async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!jobId) {
      return res.status(400).json({ error: "jobId is required" });
    }
    const job = await getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (denyIfNotJobOwner(job, req.userId, res)) return;

    const chain = await getJobLineage(jobId);
    res.json({
      lineage: chain.map((j) => ({
        id: j.id,
        parentJobId: j.parentJobId,
        parentJobIds: j.parentJobIds,     // All parent IDs (multi-parent)
        sourceImages: j.sourceImages,     // Source image URLs used as input
        prompt: j.prompt,
        previewImageUrl: j.previewImageUrl,
        resultGlbUrl: j.resultGlbUrl,
        generateType: j.generateType,
        status: j.status,
        durationMs: j.durationMs ?? null,
        createdAt: j.createdAt,
      })),
    });
  } catch (err: any) {
    logger.error(err, "failed to get job lineage");
    res.status(500).json({ error: err.message || "Failed to get job lineage" });
  }
});

// ============================================
// Webhook for job updates (internal shared secret)
// ============================================
threeDRouter.post("/webhook/job-update", async (req, res) => {
  if (!assertInternalSecret(req, res)) return;
  try {
    const { job_id, status, result, error, user_id } = req.body as {
      job_id: string;
      status: string;
      result?: any;
      error?: string;
      user_id?: string;
    };

    if (!job_id) {
      return res.status(400).json({ error: "job_id is required" });
    }

    let job = await getJob(job_id);
    if (!job) {
      await createJob({
        id: job_id,
        userId: user_id || null,
        prompt: result?.prompt || null,
        imageUrl: null,
        generateType: "ImageTo3D",
      });
      job = await getJob(job_id);
    }

    if (!job) {
      return res.status(500).json({ error: "Failed to create/get job" });
    }

    const dbStatus = convertStatus(status);
    await updateJobStatus(job_id, {
      status: dbStatus,
      errorCode: null,
      errorMessage: error || null,
    });

    if (status === "completed" && result) {
      const apiGlbUrl = result.mesh_url || result.output;
      const apiPreviewUrl = result.processed_image_url || result.generated_image_url || result.processed_image || result.generated_image;
      
      // Use direct S3 URLs (public bucket, no expiration)
      const glbUrl = normalizeGlbUrl(job_id, apiGlbUrl);
      const previewUrl = normalizePreviewUrl(job_id, apiPreviewUrl);
      
      // Check if job had GLB URL before (to avoid duplicate emails)
      const hadGlbUrlBefore = !!job.resultGlbUrl;
      
      await updateJobResult(job_id, {
        resultGlbUrl: glbUrl,
        previewImageUrl: previewUrl,
      });
      
      // If this 3D job was created from a preview image, delete the preview job
      // Find preview job by matching this job's imageUrl with preview job's previewImageUrl
      if (job.imageUrl && job.userId) {
        try {
          const { data: previewJobs, error: previewError } = await supabase
            .from("jobs")
            .select("id")
            .eq("preview_image_url", job.imageUrl)
            .eq("user_id", job.userId)
            .is("result_glb_url", null) // Only preview jobs (no 3D result)
            .limit(1);
          
          if (!previewError && previewJobs && previewJobs.length > 0) {
            const previewJobId = previewJobs[0].id;
            // Delete the preview job
            await deleteJob(previewJobId, job.userId);
            logger.info({ jobId: job_id, previewJobId }, "Deleted preview job after 3D completion");
          }
        } catch (deleteErr) {
          // Log but don't fail webhook processing
          logger.warn({ err: deleteErr, job_id }, "Failed to delete preview job (non-critical)");
        }
      }
      
      // Send completion email if this is the first time we're getting the GLB URL
      // and the job has a user (not anonymous)
      if (!hadGlbUrlBefore && glbUrl && job.userId) {
        // Import email service here to avoid circular dependency
        import("../services/email.js")
          .then(({ sendCompletionEmailForJob }) => {
            sendCompletionEmailForJob(
              job_id,
              job.userId,
              job.prompt || null,
              glbUrl,
              previewUrl
            ).catch((err) => {
              // Log error but don't fail webhook processing
              logger.error({ err: err.message, job_id }, "Failed to send completion email (non-critical)");
            });
          })
          .catch((err) => {
            logger.error({ err: err.message, job_id }, "Failed to import email service");
          });
      }
    }

    res.json({ success: true, job_id });
  } catch (err: any) {
    logger.error(err, "webhook job update failed");
    res.status(500).json({ error: err.message || "Failed to update job" });
  }
});

// ============================================
// File & Model Upload (images and 3D models)
// ============================================
const handleFileUpload = async (req: any, res: any) => {
  try {
    const uploadedFile = req.file || (req.files && req.files[0]);
    if (!uploadedFile) {
      return res.status(400).json({ error: "No file provided" });
    }

    const fileBuffer = uploadedFile.buffer || (uploadedFile.path ? fs.readFileSync(uploadedFile.path) : null);
    if (!fileBuffer) {
      return res.status(500).json({ error: "Failed to read uploaded file" });
    }

    const fileExtension = path.extname(uploadedFile.originalname).toLowerCase();
    const is3D = [".glb", ".gltf", ".obj"].includes(fileExtension);
    const default3DMime =
      fileExtension === ".glb"
        ? "model/gltf-binary"
        : fileExtension === ".gltf"
          ? "model/gltf+json"
          : "model/obj";
    const contentType =
      uploadedFile.mimetype && uploadedFile.mimetype !== "application/octet-stream"
        ? uploadedFile.mimetype
        : is3D
          ? default3DMime
          : `image/${fileExtension.slice(1) || "png"}`;

    const uploadToS3 = async (): Promise<string | null> => {
      if (!s3Enabled || !s3Client) {
        return null;
      }
      const s3Key = `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}${fileExtension}`;
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
      if (uploadedFile.path && fs.existsSync(uploadedFile.path)) {
        try {
          fs.unlinkSync(uploadedFile.path);
        } catch (unlinkErr) {
          logger.warn({ err: unlinkErr }, "Failed to delete temporary file");
        }
      }
      logger.info({ s3Key }, "File uploaded to S3");
      return publicUrlForS3Key(s3Key);
    };

    const getFileUrl = async (): Promise<string> => {
      try {
        const s3Url = await uploadToS3();
        if (s3Url) {
          return s3Url;
        }
      } catch (s3Err: any) {
        const code = s3Err?.Code || s3Err?.name;
        logger.error({ err: s3Err, code }, "S3 upload failed");
        if (isVercel) {
          const hint =
            code === "AccessControlListNotSupported"
              ? " Bucket has ACLs disabled — do not set S3_PUT_ACL; add a bucket policy for GetObject on uploads/*."
              : " Add AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET, S3_REGION on Vercel; IAM user needs s3:PutObject.";
          throw new Error(`S3 upload failed.${hint}`);
        }
      }

      if (isVercel) {
        throw new Error(
          "S3 is required on Vercel. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET, and S3_REGION on the backend project."
        );
      }
      const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
      return `${baseUrl}/uploads/${uploadedFile.filename}`;
    };

    const fileUrl = await getFileUrl();
    res.json({ success: true, url: fileUrl });
  } catch (err: any) {
    logger.error(err, "failed to upload file");
    res.status(500).json({ error: err.message || "Failed to upload file" });
  }
};

threeDRouter.post("/upload-image", requireAuth, uploadFlexible, handleFileUpload);
threeDRouter.post("/upload-model", requireAuth, uploadFlexible, handleFileUpload);

// ============================================
// Sync User to Database (requires auth)
// Called after login to ensure user is in database
// ============================================
threeDRouter.post("/sync-user", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    
    logger.info({ userId }, "User sync endpoint called");
    
    const userData = await syncUserToDatabase(userId);
    
    if (userData) {
      res.json({ 
        success: true, 
        user: {
          id: userData.id,
          email: userData.email,
          firstName: userData.first_name,
          lastName: userData.last_name,
        }
      });
    } else {
      logger.warn({ userId }, "User sync returned null - user may not exist in Clerk or database error");
      // Still return success but with a warning
      res.json({ 
        success: false, 
        message: "User sync failed - check logs",
        userId 
      });
    }
  } catch (err: any) {
    logger.error({ err, userId: req.userId }, "failed to sync user");
    res.status(500).json({ error: err.message || "Failed to sync user" });
  }
});

// ============================================
// Get Current User Profile (requires auth)
// ============================================
threeDRouter.get("/me", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    
    // First sync user to ensure they exist in database
    await syncUserToDatabase(userId);
    
    // Fetch user from database
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();
    
    if (error) {
      logger.error({ err: error, userId }, "Failed to fetch user from database");
      res.status(500).json({ error: "Failed to fetch user" });
      return;
    }
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Get user's job stats
    const { count: totalJobs } = await supabase
      .from("jobs")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);
    
    const { count: completedJobs } = await supabase
      .from("jobs")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "DONE");
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        imageUrl: user.image_url,
        createdAt: user.created_at,
      },
      stats: {
        totalJobs: totalJobs || 0,
        completedJobs: completedJobs || 0,
      }
    });
  } catch (err: any) {
    logger.error(err, "failed to get user profile");
    res.status(500).json({ error: err.message || "Failed to get user profile" });
  }
});

// ============================================
// GPU Offline Notification Endpoint
// ============================================
threeDRouter.post("/notify-gpu-offline", requireAuth, async (req, res) => {
  try {
    const userId = req.userId || null;
    const { errorMessage } = req.body;

    logger.info({ userId, errorMessage }, "Received GPU offline notification request");

    if (!errorMessage) {
      logger.warn({ userId }, "GPU offline notification request missing errorMessage");
      return res.status(400).json({ error: "errorMessage is required" });
    }

    // Import email service here to avoid circular dependency
    import("../services/email.js")
      .then(async ({ sendGpuOfflineNotification, getUserEmail }) => {
        // Fetch user email from database if userId is available
        let userEmail: string | null = null;
        if (userId) {
          try {
            const userInfo = await getUserEmail(userId);
            userEmail = userInfo?.email || null;
            logger.info({ userId, userEmail }, "Fetched user email for notification");
          } catch (err: any) {
            logger.warn({ err: err.message, userId }, "Failed to fetch user email for notification");
          }
        }

        logger.info({ userId, userEmail, errorMessage }, "Sending GPU offline notification email");
        sendGpuOfflineNotification(userId, userEmail, errorMessage)
          .then((success) => {
            if (success) {
              logger.info({ userId, userEmail }, "GPU offline notification email sent successfully");
            } else {
              logger.error({ userId, userEmail }, "GPU offline notification email failed after retries");
            }
          })
          .catch((err: any) => {
            logger.error({ err: err.message, stack: err.stack, userId, userEmail }, "Failed to send GPU offline notification (non-critical)");
          });
      })
      .catch((err: any) => {
        logger.error({ err: err.message, stack: err.stack, userId }, "Failed to import email service");
      });

    // Return success immediately (email is sent asynchronously)
    res.json({ success: true, message: "Notification sent" });
  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, "Error in notify-gpu-offline endpoint");
    res.status(500).json({ error: "Failed to send notification" });
  }
});


// ============================================
// WORKSPACES
// ============================================

/**
 * List all workspaces for the current user.
 * Short cache (5s) reduces repeat requests when navigating back to /app/studio.
 */
threeDRouter.get("/workspaces", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const workspaces = await listWorkspacesForUser(userId);
    res.setHeader("Cache-Control", "private, max-age=5, stale-while-revalidate=10");
    res.json({ workspaces });
  } catch (err: any) {
    if (err.code === "TABLE_NOT_FOUND" || err.message?.includes("does not exist")) {
      return res.json({ workspaces: [] });
    }
    logger.error(err, "Failed to list workspaces");
    res.status(500).json({ error: err.message || "Failed to list workspaces" });
  }
});

/**
 * Create a new workspace
 */
threeDRouter.post("/workspaces", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    // Ensure users row exists (FK) — avoids create failures right after first login.
    await syncUserToDatabase(userId);
    const { name } = req.body as { name?: string };
    const workspace = await createWorkspace({ userId, name: name || "Untitled Workspace" });
    res.json({ workspace });
  } catch (err: any) {
    if (err.code === "TABLE_NOT_FOUND") {
      return res.status(500).json({ error: "Workspaces table does not exist. Please run the migration." });
    }
    logger.error(err, "Failed to create workspace");
    res.status(500).json({ error: err.message || "Failed to create workspace" });
  }
});

/**
 * Get a workspace by ID
 */
threeDRouter.get("/workspaces/:workspaceId", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;
    const workspace = await getWorkspaceForUser(workspaceId, userId);
    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found" });
    }
    res.json({ workspace });
  } catch (err: any) {
    logger.error(err, "Failed to get workspace");
    res.status(500).json({ error: err.message || "Failed to get workspace" });
  }
});

/**
 * Get all jobs for a specific workspace
 */
threeDRouter.get("/workspaces/:workspaceId/jobs", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;

    // Verify ownership
    const workspace = await getWorkspaceForUser(workspaceId, userId);
    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    const jobs = await listJobsForWorkspace(workspaceId, userId);
    
    // Normalize URLs in the same way the history endpoint does
    const normalizedJobs = jobs.map((row: any) => {
      let imageUrl = row.image_url;
      let previewImageUrl = row.preview_image_url;
      let resultGlbUrl = row.result_glb_url;

      if (imageUrl && imageUrl.includes("amazonaws.com")) {
        imageUrl = imageUrl.split("?")[0];
      }
      if (previewImageUrl) {
        previewImageUrl = normalizePreviewUrl(row.id, previewImageUrl);
      }

      // Do not inline full factory_code here — it can be huge. Clients fetch
      // it from GET /api/water/jobs/:id (legacy: /api/code-sculpt/jobs/:id).
      const hasFactoryCode = Boolean(row.factory_code && String(row.factory_code).length > 0);
      const waterLike =
        String(row.id || "").startsWith("wt_") ||
        String(row.id || "").startsWith("cs_") ||
        isWaterEngine(row.engine) ||
        isWaterEngine(row.generate_type) ||
        row.result_kind === "three_factory" ||
        hasFactoryCode;

      // Water jobs never have a mesh GLB — never expose a proxy URL that 404s.
      if (waterLike) {
        resultGlbUrl = null;
      } else if (resultGlbUrl) {
        resultGlbUrl = normalizeGlbUrl(row.id, resultGlbUrl);
      }

      return {
        id: row.id,
        userId: row.user_id || null,
        chatId: row.chat_id || null,
        workspaceId: row.workspace_id || null,
        parentJobId: row.parent_job_id || null,
        status: row.status,
        prompt: row.prompt,
        imageUrl: imageUrl,
        generateType: row.generate_type ?? (waterLike ? "Water" : null),
        resultGlbUrl: resultGlbUrl,
        previewImageUrl: previewImageUrl,
        errorMessage: row.error_message,
        engine: row.engine ?? (waterLike ? "water" : "trilles"),
        resultKind: row.result_kind ?? (waterLike ? "three_factory" : "glb"),
        sculptPass: row.sculpt_pass ?? null,
        // Signal completion without shipping the full TypeScript payload
        factoryCode: hasFactoryCode ? "__present__" : null,
        hasFactoryCode,
        durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
        visualEvidence: compactVisualEvidence(row.sculpt_spec),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    res.json({ jobs: normalizedJobs });
  } catch (err: any) {
    logger.error(err, "Failed to list workspace jobs");
    res.status(500).json({ error: err.message || "Failed to list workspace jobs" });
  }
});

/**
 * Update workspace name
 */
threeDRouter.patch("/workspaces/:workspaceId/name", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;
    const { name } = req.body as { name: string };

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    await updateWorkspaceName(workspaceId, name.trim(), userId);
    res.json({ success: true });
  } catch (err: any) {
    logger.error(err, "Failed to update workspace name");
    res.status(500).json({ error: err.message || "Failed to update workspace name" });
  }
});

/**
 * Delete a workspace
 */
threeDRouter.delete("/workspaces/:workspaceId", requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;
    await deleteWorkspace(workspaceId, userId);
    res.json({ success: true });
  } catch (err: any) {
    logger.error(err, "Failed to delete workspace");
    res.status(500).json({ error: err.message || "Failed to delete workspace" });
  }
});
