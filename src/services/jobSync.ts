import { config } from "../config.js";
import { logger } from "../logger.js";
import { getJob, listJobs, updateJobStatus, updateJobResult } from "../repository/jobs.js";
import { JobStatus } from "../types.js";
import { normalizeGlbUrl, normalizePreviewUrl } from "../utils/s3Urls.js";

const API_BASE = config.hunyuanApi.url;

// Helper to convert API status to database status
function convertStatus(apiStatus: string): JobStatus {
  switch (apiStatus) {
    case "pending":
      return "WAIT";
    case "processing":
      return "RUN";
    case "completed":
      return "DONE";
    case "failed":
    case "cancelled":
      return "FAIL";
    default:
      return "WAIT";
  }
}

/**
 * Sync a single job from API to Supabase
 */
export async function syncJobFromApi(jobId: string): Promise<boolean> {
  try {
    // Fetch from API with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    let response: Response;
    try {
      response = await fetch(`${API_BASE}/status/${jobId}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        if (response.status === 404) {
          logger.debug({ jobId }, "Job not found in API");
          return false;
        }
        throw new Error(`API returned ${response.status}`);
      }
    } catch (fetchErr: any) {
      clearTimeout(timeoutId);
      if (fetchErr.name === "AbortError") {
        logger.warn({ jobId }, "API request timeout");
        return false;
      }
      throw fetchErr;
    }

    const apiJob = await response.json();

    // Get job from database
    const dbJob = await getJob(jobId);
    if (!dbJob) {
      logger.debug({ jobId }, "Job not found in database, skipping sync");
      return false;
    }

    // Convert API status to database status
    const dbStatus = convertStatus(apiJob.status);

    // Update status if changed
    if (dbJob.status !== dbStatus) {
      await updateJobStatus(jobId, {
        status: dbStatus,
        errorCode: null,
        errorMessage: apiJob.error || null,
      });
      logger.info({ jobId, oldStatus: dbJob.status, newStatus: dbStatus }, "Job status updated");
    }

    // Update result if completed
    if (apiJob.status === "completed" && apiJob.result) {
      const apiGlbUrl = apiJob.result.mesh_url || apiJob.result.output;
      const apiPreviewUrl =
        apiJob.result.processed_image_url ||
        apiJob.result.generated_image_url ||
        apiJob.result.processed_image ||
        apiJob.result.generated_image;

      // Use direct S3 URLs (public bucket, no expiration)
      const glbUrl = apiGlbUrl ? normalizeGlbUrl(jobId, apiGlbUrl) : null;
      const previewUrl = apiPreviewUrl ? normalizePreviewUrl(jobId, apiPreviewUrl) : null;

      // Update only the fields that are provided
      // If job already has preview, don't overwrite it unless new one is provided
      const updateData: { resultGlbUrl?: string | null; previewImageUrl?: string | null } = {};
      
      if (glbUrl && dbJob.resultGlbUrl !== glbUrl) {
        updateData.resultGlbUrl = glbUrl;
      }
      
      // Only update preview if it's not already set or if new one is provided
      if (previewUrl && (!dbJob.previewImageUrl || dbJob.previewImageUrl !== previewUrl)) {
        updateData.previewImageUrl = previewUrl;
      }
      
      // Only update if there are changes
      if (Object.keys(updateData).length > 0) {
        await updateJobResult(jobId, updateData);
        logger.info({ jobId, ...updateData }, "Job result updated");
      }
    }

    return true;
  } catch (err: any) {
    logger.error({ err, jobId }, "Failed to sync job from API");
    return false;
  }
}

/**
 * Sync all pending/processing jobs from API to Supabase
 */
export async function syncAllJobs(): Promise<{ synced: number; failed: number }> {
  try {
    // Get all jobs that are still processing
    const jobs = await listJobs(1000); // Get up to 1000 jobs
    const activeJobs = jobs.filter((job) => job.status === "WAIT" || job.status === "RUN");

    if (activeJobs.length === 0) {
      return { synced: 0, failed: 0 };
    }

    logger.info({ count: activeJobs.length }, "Syncing active jobs from API");

    let synced = 0;
    let failed = 0;

    // Sync jobs in parallel batches to improve performance
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 200;
    
    for (let i = 0; i < activeJobs.length; i += BATCH_SIZE) {
      const batch = activeJobs.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((job) => syncJobFromApi(job.id))
      );
      
      results.forEach((result) => {
        if (result.status === "fulfilled" && result.value) {
          synced++;
        } else {
          failed++;
        }
      });
      
      // Small delay between batches to avoid overwhelming the API
      if (i + BATCH_SIZE < activeJobs.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    logger.info({ synced, failed }, "Job sync completed");
    return { synced, failed };
  } catch (err: any) {
    logger.error({ err }, "Failed to sync jobs");
    return { synced: 0, failed: 0 };
  }
}



