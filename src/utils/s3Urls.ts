import { config } from "../config.js";

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
 * Construct direct S3 URL for a job's preview image
 * Structure: image/{jobId}/processed_image.png
 */
export function getDirectS3PreviewUrl(jobId: string): string {
  const bucket = config.s3.bucket;
  const region = config.s3.region;
  return `https://${bucket}.s3.${region}.amazonaws.com/image/${jobId}/processed_image.png`;
}

/**
 * Normalize GLB URL - use direct S3 URL if API URL points to our bucket
 * Otherwise construct direct S3 URL based on jobId
 */
export function normalizeGlbUrl(jobId: string, apiUrl: string | null | undefined): string | null {
  if (!apiUrl) return null;
  
  // If the URL already points to our S3 bucket, use it directly
  if (apiUrl.includes(config.s3.bucket) && apiUrl.includes("/image/")) {
    return apiUrl;
  }
  
  // Otherwise, construct direct S3 URL based on jobId
  return getDirectS3GlbUrl(jobId);
}

/**
 * Normalize preview image URL - use direct S3 URL if API URL points to our bucket
 * Otherwise construct direct S3 URL based on jobId
 */
export function normalizePreviewUrl(jobId: string, apiUrl: string | null | undefined): string | null {
  if (!apiUrl) return null;
  
  // If the URL already points to our S3 bucket, use it directly
  if (apiUrl.includes(config.s3.bucket) && apiUrl.includes("/image/")) {
    return apiUrl;
  }
  
  // Otherwise, construct direct S3 URL based on jobId
  return getDirectS3PreviewUrl(jobId);
}

