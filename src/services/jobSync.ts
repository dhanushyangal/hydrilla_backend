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
    // Fetch from API
    const response = await fetch(`${API_BASE}/status/${jobId}`);
    if (!response.ok) {
      if (response.status === 404) {
        logger.debug({ jobId }, "Job not found in API");
        return false;
      }
      throw new Error(`API returned ${response.status}`);
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
      const glbUrl = normalizeGlbUrl(jobId, apiGlbUrl);
      const previewUrl = normalizePreviewUrl(jobId, apiPreviewUrl);

      // Only update if URLs are different
      if (dbJob.resultGlbUrl !== glbUrl || dbJob.previewImageUrl !== previewUrl) {
        await updateJobResult(jobId, {
          resultGlbUrl: glbUrl,
          previewImageUrl: previewUrl,
        });
        logger.info({ jobId, glbUrl, previewUrl }, "Job result updated");
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

    // Sync each job (with small delay to avoid rate limiting)
    for (const job of activeJobs) {
      const success = await syncJobFromApi(job.id);
      if (success) {
        synced++;
      } else {
        failed++;
      }
      // Small delay to avoid overwhelming the API
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    logger.info({ synced, failed }, "Job sync completed");
    return { synced, failed };
  } catch (err: any) {
    logger.error({ err }, "Failed to sync jobs");
    return { synced: 0, failed: 0 };
  }
}



