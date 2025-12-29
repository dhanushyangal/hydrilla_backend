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
 * Handles both preview/{jobId}/preview_image.png and image/{jobId}/processed_image.png paths
 * If no URL provided, returns preview path (for text-to-image previews)
 */
export function normalizePreviewUrl(jobId: string, apiUrl: string | null | undefined): string | null {
  if (!apiUrl) {
    // If no URL provided, try preview path first (for text-to-image previews)
    return getDirectS3PreviewImageUrl(jobId);
  }
  
  // If the URL already points to our S3 bucket
  if (apiUrl.includes(config.s3.bucket)) {
    // Check if it's a preview path (preview/{jobId}/preview_image.png)
    if (apiUrl.includes("/preview/")) {
      // Strip query parameters (signed URL params like ?AWSAccessKeyId=...)
      const urlWithoutParams = apiUrl.split('?')[0];
      return urlWithoutParams;
    }
    
    // Check if it's an image path (image/{jobId}/processed_image.png)
    if (apiUrl.includes("/image/")) {
      // Strip query parameters (signed URL params like ?AWSAccessKeyId=...)
      const urlWithoutParams = apiUrl.split('?')[0];
      return urlWithoutParams;
    }
  }
  
  // If URL doesn't match our bucket patterns, try to construct direct S3 URL
  // Try preview path first (for text-to-image previews)
  return getDirectS3PreviewImageUrl(jobId);
}

