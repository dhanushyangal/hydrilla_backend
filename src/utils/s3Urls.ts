import { config } from "../config.js";

const LEGACY_S3_BUCKETS = (process.env.LEGACY_S3_BUCKETS || "hydrilla-outputs")
  .split(",")
  .map((bucket) => bucket.trim().toLowerCase())
  .filter(Boolean);

/**
 * Extract target URL if input is wrapped in backend /api/3d/image-proxy
 */
export function unwrapImageProxyUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  const s = url.trim();
  if (s.includes("/api/3d/image-proxy")) {
    try {
      const parsed = new URL(s, "http://localhost");
      const real = parsed.searchParams.get("url");
      if (real) {
        return real;
      }
    } catch {
      const idx = s.indexOf("?url=");
      if (idx !== -1) {
        return decodeURIComponent(s.slice(idx + 5));
      }
    }
  }
  return s;
}

/**
 * Construct direct S3 URL for a job's GLB file
 * Structure: image/{jobId}/mesh.glb
 */
export function getDirectS3GlbUrl(jobId: string): string {
  const bucket = config.s3.bucket;
  const region = config.s3.region;
  return `https://${bucket}.s3.${region}.amazonaws.com/image/${jobId}/mesh.glb`;
}

/**
 * Construct direct S3 URL for a job's preview image (text-to-image preview)
 * Structure: preview/{jobId}/preview_image.png
 */
export function getDirectS3PreviewImageUrl(jobId: string): string {
  const bucket = config.s3.bucket;
  const region = config.s3.region;
  return `https://${bucket}.s3.${region}.amazonaws.com/preview/${jobId}/preview_image.png`;
}

/**
 * Construct direct S3 URL for a job's processed preview image (from 3D generation)
 * Structure: image/{jobId}/processed_image.png
 */
export function getDirectS3ProcessedImageUrl(jobId: string): string {
  const bucket = config.s3.bucket;
  const region = config.s3.region;
  return `https://${bucket}.s3.${region}.amazonaws.com/image/${jobId}/processed_image.png`;
}

/**
 * Construct direct S3 URL for a job's preview image (tries preview path first, then image path)
 * Structure: preview/{jobId}/preview_image.png or image/{jobId}/processed_image.png
 */
export function getDirectS3PreviewUrl(jobId: string): string {
  // Try preview path first (for text-to-image previews)
  return getDirectS3PreviewImageUrl(jobId);
}

/**
 * Normalize GLB URL - use direct S3 URL if API URL points to our bucket
 * Otherwise construct direct S3 URL based on jobId
 */
export function normalizeGlbUrl(jobId: string, apiUrl: string | null | undefined): string | null {
  if (!apiUrl) return null;
  
  // If the URL already points to our S3 bucket
  if (apiUrl.includes(config.s3.bucket) && apiUrl.includes("/image/")) {
    // Strip query parameters (signed URL params like ?AWSAccessKeyId=...)
    const urlWithoutParams = apiUrl.split('?')[0];
    return urlWithoutParams;
  }
  
  // Otherwise, construct direct S3 URL based on jobId
  return getDirectS3GlbUrl(jobId);
}

/**
 * Normalize preview image URL - use direct S3 URL if API URL points to our bucket
 * Handles: preview/, image/, edit/ paths (S3 or gateway /outputs/ paths); combined/ only for legacy rows.
 * If no URL provided, returns preview path (for text-to-image previews)
 */
export function normalizePreviewUrl(jobId: string, apiUrl: string | null | undefined): string | null {
  if (!apiUrl || !apiUrl.trim()) {
    // If no URL provided, try preview path first (for text-to-image previews)
    return getDirectS3PreviewImageUrl(jobId);
  }

  // Client-captured Code Sculpt thumbnails (data URLs) must not be rewritten to S3.
  if (apiUrl.startsWith("data:") || apiUrl.startsWith("blob:")) {
    return apiUrl;
  }

  const unwrapped = unwrapImageProxyUrl(apiUrl) || apiUrl;
  const urlWithoutParams = unwrapped.split("?")[0];

  // If the URL points to our S3 bucket or legacy buckets
  const isBucketMatch = [config.s3.bucket, ...LEGACY_S3_BUCKETS].some((b) => {
    return Boolean(b && unwrapped.toLowerCase().includes(b.toLowerCase()));
  });

  if (isBucketMatch) {
    if (
      unwrapped.includes("/preview/") ||
      unwrapped.includes("/image/") ||
      unwrapped.includes("/edit/") ||
      unwrapped.includes("/combined/")
    ) {
      return urlWithoutParams;
    }
  }

  // Gateway output URLs — image lives on the GPU disk; do not rewrite to S3.
  if (
    unwrapped.includes("/outputs/preview/") ||
    unwrapped.includes("/outputs/image/") ||
    unwrapped.includes("/outputs/edit/") ||
    unwrapped.includes("/outputs/combined/")
  ) {
    return urlWithoutParams;
  }

  // If it's already an absolute HTTP/HTTPS URL, preserve it
  if (unwrapped.startsWith("http://") || unwrapped.startsWith("https://")) {
    return urlWithoutParams;
  }

  // If URL doesn't match our bucket patterns, try to construct direct S3 URL
  // (preview path for text-to-image previews only)
  return getDirectS3PreviewImageUrl(jobId);
}

