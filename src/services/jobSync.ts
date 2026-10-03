import { config } from "../config.js";
import { logger } from "../logger.js";
import { getJob, getJobsToSync, updateJobStatus, updateJobResult } from "../repository/jobs.js";
import { JobStatus } from "../types.js";
import { normalizeGlbUrl, normalizePreviewUrl } from "../utils/s3Urls.js";
import { refundCredit } from "./credits.js";

// Circuit breaker state to prevent continuous API calls when API is offline
let circuitBreakerState = {
  isOpen: false, // Circuit is open (API is offline)
  consecutiveFailures: 0,
  lastFailureTime: null as number | null,
  lastSuccessTime: null as number | null,
};

const CIRCUIT_BREAKER_THRESHOLD = 6; // Open after 6 failures so brief gateway busy doesn't trip
const CIRCUIT_BREAKER_RESET_TIME = 60000; // Try again after 60 seconds
const CIRCUIT_BREAKER_SUCCESS_RESET = 1; // Close circuit after 1 successful call
const MAX_JOB_AGE_MS = 16 * 60 * 1000; // 16 minutes timeout cap (allows 12+ min generations when GPU OOM restart occurs)
const HARD_ABORT_MAX_AGE_MS = 25 * 60 * 1000; // 25 minutes absolute hard cap even if gateway still reports pending

/**
 * Check if API is available (circuit breaker closed)
 */
function isApiAvailable(): boolean {
  if (!circuitBreakerState.isOpen) {
    return true; // Circuit is closed, API is available
  }

  // If circuit is open, check if enough time has passed to retry
  if (circuitBreakerState.lastFailureTime) {
    const timeSinceLastFailure = Date.now() - circuitBreakerState.lastFailureTime;
    if (timeSinceLastFailure >= CIRCUIT_BREAKER_RESET_TIME) {
      logger.info("Circuit breaker: Attempting to reconnect to API");
      circuitBreakerState.isOpen = false;
      circuitBreakerState.consecutiveFailures = 0;
      return true;
    }
  }

  return false; // Circuit is open, API is unavailable
}

/**
 * Record API failure. Log only when the circuit transitions from closed to open.
 */
function recordApiFailure(): void {
  const wasOpen = circuitBreakerState.isOpen;
  circuitBreakerState.consecutiveFailures++;
  circuitBreakerState.lastFailureTime = Date.now();

  if (circuitBreakerState.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreakerState.isOpen = true;
    if (!wasOpen) {
      logger.warn(
        { consecutiveFailures: circuitBreakerState.consecutiveFailures },
        "Circuit breaker opened: API appears to be offline. Pausing job sync."
      );
    }
  }
}

/**
 * Record API success
 */
function recordApiSuccess(): void {
  if (circuitBreakerState.isOpen) {
    logger.info("Circuit breaker closed: API is back online");
  }
  circuitBreakerState.isOpen = false;
  circuitBreakerState.consecutiveFailures = 0;
  circuitBreakerState.lastSuccessTime = Date.now();
}

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
    // Get job from database first
    const dbJob = await getJob(jobId);
    if (!dbJob) {
      logger.debug({ jobId }, "Job not found in database, skipping sync");
      return false;
    }

    if (
      dbJob.engine === "code_sculpt" ||
      dbJob.engine === "water" ||
      dbJob.generateType === "CodeSculpt" ||
      dbJob.generateType === "Water" ||
      dbJob.resultKind === "three_factory"
    ) {
      return true;
    }

    // Image jobs are produced by OpenAI/Gemini in-request and never exist on the GPU VM.
    const generateType = String(dbJob.generateType);
    if (generateType === "TextToImage" || generateType === "EditImage" || generateType === "Combined") {
      return true;
    }
    
    // Skip syncing preview-only jobs (jobs with preview but no 3D result)
    // These jobs don't exist in Python API, they're only in our database
    if (dbJob.previewImageUrl && !dbJob.resultGlbUrl && dbJob.status === "DONE") {
      logger.debug({ jobId }, "Preview-only job, skipping API sync");
      return true; // Return true since job is already in correct state
    }

    const jobAgeMs = Date.now() - new Date(dbJob.createdAt).getTime();
    if ((dbJob.status === "WAIT" || dbJob.status === "RUN") && jobAgeMs >= HARD_ABORT_MAX_AGE_MS) {
      const refundAmount = Boolean(dbJob.userId) && (dbJob.creditsUsed ?? 0) > 0 ? dbJob.creditsUsed : 0;
      const timeoutMessage = "Generation timed out. Your credits have been automatically refunded.";
      await updateJobStatus(jobId, {
        status: "FAIL",
        errorCode: "GENERATION_TIMEOUT",
        errorMessage: timeoutMessage,
        creditsUsed: refundAmount > 0 ? 0 : undefined,
      });
      if (refundAmount > 0 && dbJob.userId) {
        await refundCredit(dbJob.userId, refundAmount);
        logger.info(
          { jobId, userId: dbJob.userId, amount: refundAmount, jobAgeMs },
          "Refunded credits for job exceeding hard abort limit"
        );
      }
      return true;
    }
    
    // Fetch from the GPU VM with timeout (generous when it is busy processing another job).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 second timeout

    const path = `/status/${jobId}`;
    const url = `${config.gpuGateway.url}${path}`;

    let response: Response | null = null;
    let lastErr: unknown = null;

    try {
      try {
        const headers: Record<string, string> = {};
        if (config.internalApiSecret) {
          headers["X-Hydrilla-Internal"] = config.internalApiSecret;
        }
        const res = await fetch(url, { signal: controller.signal, headers });
        response = res;
      } catch (err) {
        lastErr = err;
        throw err;
      }
      clearTimeout(timeoutId);
      if (!response) {
        throw lastErr || new Error("Gateway request failed");
      }
      
      if (!response.ok) {
        if (response.status === 404) {
          // If job not found in API but is a preview-only job, that's OK
          if (dbJob.previewImageUrl && !dbJob.resultGlbUrl) {
            logger.debug({ jobId }, "Preview-only job not in API (expected)");
            return true;
          }
          // Job is WAIT/RUN but not on API (e.g. GPU server restarted). Mark failed only after 90s or MAX_JOB_AGE_MS.
          if ((dbJob.status === "WAIT" || dbJob.status === "RUN") && (jobAgeMs >= 90_000 || jobAgeMs >= MAX_JOB_AGE_MS)) {
            const shouldRefund = Boolean(dbJob.userId) && (dbJob.creditsUsed ?? 0) > 0;
            const restartErrorMessage = "Job not found on GPU (server may have restarted). Your credits have been automatically refunded.";
            await updateJobStatus(jobId, {
              status: "FAIL",
              errorCode: null,
              errorMessage: restartErrorMessage,
              creditsUsed: shouldRefund ? 0 : undefined,
            });
            if (shouldRefund && dbJob.userId) {
              await refundCredit(dbJob.userId, dbJob.creditsUsed);
              logger.info(
                { jobId, userId: dbJob.userId, amount: dbJob.creditsUsed },
                "Refunded credits for lost job after GPU restart"
              );
            }
            logger.info({ jobId }, "Job not on API, marked failed to stop repeated sync");
          }
          return true; // Handled; don't count as sync failure
        }
        // 502/503/504 = gateway/API temporarily unavailable - don't spam ERROR logs
        if (response.status === 502 || response.status === 503 || response.status === 504) {
          recordApiFailure();
          logger.debug({ jobId, status: response.status }, "External API temporarily unavailable");
          // If gateway is unavailable and job has exceeded MAX_JOB_AGE_MS, timeout and refund
          if ((dbJob.status === "WAIT" || dbJob.status === "RUN") && jobAgeMs >= MAX_JOB_AGE_MS) {
            const refundAmount = Boolean(dbJob.userId) && (dbJob.creditsUsed ?? 0) > 0 ? dbJob.creditsUsed : 0;
            const timeoutMessage = "Generation timed out. Your credits have been automatically refunded.";
            await updateJobStatus(jobId, {
              status: "FAIL",
              errorCode: "GENERATION_TIMEOUT",
              errorMessage: timeoutMessage,
              creditsUsed: refundAmount > 0 ? 0 : undefined,
            });
            if (refundAmount > 0 && dbJob.userId) {
              await refundCredit(dbJob.userId, refundAmount);
            }
          }
          return false;
        }
        throw new Error(`API returned ${response.status}`);
      }
    } catch (fetchErr: any) {
      try { clearTimeout(timeoutId); } catch (_) {}
      if (fetchErr.name === "AbortError") {
        logger.warn({ jobId }, "API request timeout");
        // Record API failure for circuit breaker
        recordApiFailure();
        // For preview-only jobs, timeout is OK
        if (dbJob.previewImageUrl && !dbJob.resultGlbUrl && dbJob.status === "DONE") {
          return true;
        }
        // If timed out and job is past MAX_JOB_AGE_MS, fail and refund
        if ((dbJob.status === "WAIT" || dbJob.status === "RUN") && jobAgeMs >= MAX_JOB_AGE_MS) {
          const refundAmount = Boolean(dbJob.userId) && (dbJob.creditsUsed ?? 0) > 0 ? dbJob.creditsUsed : 0;
          const timeoutMessage = "Generation timed out. Your credits have been automatically refunded.";
          await updateJobStatus(jobId, {
            status: "FAIL",
            errorCode: "GENERATION_TIMEOUT",
            errorMessage: timeoutMessage,
            creditsUsed: refundAmount > 0 ? 0 : undefined,
          });
          if (refundAmount > 0 && dbJob.userId) {
            await refundCredit(dbJob.userId, refundAmount);
          }
        }
        return false;
      }
      // Record other network errors
      if (fetchErr.message?.includes("fetch") || fetchErr.message?.includes("network") || fetchErr.message?.includes("ECONNREFUSED")) {
        recordApiFailure();
        if ((dbJob.status === "WAIT" || dbJob.status === "RUN") && jobAgeMs >= MAX_JOB_AGE_MS) {
          const refundAmount = Boolean(dbJob.userId) && (dbJob.creditsUsed ?? 0) > 0 ? dbJob.creditsUsed : 0;
          const timeoutMessage = "Generation timed out. Your credits have been automatically refunded.";
          await updateJobStatus(jobId, {
            status: "FAIL",
            errorCode: "GENERATION_TIMEOUT",
            errorMessage: timeoutMessage,
            creditsUsed: refundAmount > 0 ? 0 : undefined,
          });
          if (refundAmount > 0 && dbJob.userId) {
            await refundCredit(dbJob.userId, refundAmount);
          }
        }
      }
      throw fetchErr;
    }

    const apiJob = await response.json();

    // Record API success (circuit breaker)
    recordApiSuccess();

    // Convert API status to database status
    const dbStatus = convertStatus(apiJob.status);

    // Update status if changed
    if (dbJob.status !== dbStatus) {
      const shouldRefund =
        dbStatus === "FAIL" &&
        Boolean(dbJob.userId) &&
        (dbJob.creditsUsed ?? 0) > 0;
      const rawError = apiJob.error || (dbStatus === "FAIL" ? "Generation failed" : null);
      const formattedErrorMessage = dbStatus === "FAIL"
        ? (rawError && rawError.includes("refunded") ? rawError : `${rawError || "Generation failed"}. Your credits have been automatically refunded.`)
        : null;
      await updateJobStatus(jobId, {
        status: dbStatus,
        errorCode: null,
        errorMessage: formattedErrorMessage,
        creditsUsed: shouldRefund ? 0 : undefined,
      });
      if (shouldRefund && dbJob.userId) {
        await refundCredit(dbJob.userId, dbJob.creditsUsed);
        logger.info(
          { jobId, userId: dbJob.userId, amount: dbJob.creditsUsed },
          "Refunded credits for failed GPU job during background sync"
        );
      }
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
        const hadGlbUrlBefore = !!dbJob.resultGlbUrl;
        
        await updateJobResult(jobId, {
          resultGlbUrl: glbUrl,
          previewImageUrl: previewUrl,
        });
        logger.info({ jobId, glbUrl, previewUrl }, "Job result updated");
        
        // Send completion email if this is the first time we're getting the GLB URL
        // and the job has a user (not anonymous)
        if (!hadGlbUrlBefore && glbUrl && dbJob.userId) {
          // Import email service here to avoid circular dependency
          import("./email.js")
            .then(({ sendCompletionEmailForJob }) => {
              sendCompletionEmailForJob(
                jobId,
                dbJob.userId,
                dbJob.prompt || null,
                glbUrl,
                previewUrl
              ).catch((err) => {
                // Log error but don't fail job completion
                logger.error({ err: err.message, jobId }, "Failed to send completion email (non-critical)");
              });
            })
            .catch((err) => {
              logger.error({ err: err.message, jobId }, "Failed to import email service");
            });
        }
      }
    }

    return true;
  } catch (err: any) {
    // Check if it's a network error or transient API error (502/503/504)
    const isNetworkError = err.message?.includes("fetch") || 
                          err.message?.includes("network") || 
                          err.message?.includes("ECONNREFUSED") ||
                          err.message?.includes("ETIMEDOUT") ||
                          err.name === "TypeError";
    const isTransientApiError = err.message?.includes("API returned 50"); // 502, 503, 504

    if (isNetworkError || isTransientApiError) {
      recordApiFailure();
    }

    // Don't log transient/unavailable as ERROR to avoid log spam when GPU API is down
    if (isTransientApiError) {
      logger.debug({ jobId, err: err.message }, "Sync skipped (API unavailable)");
    } else {
      logger.error({ err, jobId }, "Failed to sync job from API");
    }
    return false;
  }
}

/**
 * Sync all pending/processing jobs from API to Supabase
 */
export async function syncAllJobs(): Promise<{ synced: number; failed: number }> {
  try {
    // Check circuit breaker - if API is offline, still expire timed-out jobs
    if (!isApiAvailable()) {
      // Only log once per minute to avoid spam
      const shouldLog = !circuitBreakerState.lastFailureTime || 
                       (Date.now() - circuitBreakerState.lastFailureTime) > 60000;
      if (shouldLog) {
        logger.debug("Skipping API sync: API is offline (circuit breaker open). Checking for timed-out jobs.");
      }
      const jobs = await getJobsToSync();
      const now = Date.now();
      await Promise.allSettled(
        jobs.map(async (job) => {
          const age = now - new Date(job.createdAt).getTime();
          if (age >= MAX_JOB_AGE_MS && (job.status === "WAIT" || job.status === "RUN")) {
            const refundAmount = Boolean(job.userId) && (job.creditsUsed ?? 0) > 0 ? job.creditsUsed : 0;
            const timeoutMessage = "Generation timed out. Your credits have been automatically refunded.";
            await updateJobStatus(job.id, {
              status: "FAIL",
              errorCode: "GENERATION_TIMEOUT",
              errorMessage: timeoutMessage,
              creditsUsed: refundAmount > 0 ? 0 : undefined,
            });
            if (refundAmount > 0 && job.userId) {
              await refundCredit(job.userId, refundAmount);
              logger.info(
                { jobId: job.id, userId: job.userId, amount: refundAmount },
                "Refunded credits for timed-out job while API offline"
              );
            }
          }
        })
      );
      return { synced: 0, failed: 0 };
    }

    // Repository filtering excludes Code Sculpt and other non-GPU jobs.
    const jobs = await getJobsToSync();
    // Filter out preview-only jobs (they don't exist in Python API)
    const activeJobs = jobs.filter((job) => 
      (job.status === "WAIT" || job.status === "RUN") && 
      !(job.previewImageUrl && !job.resultGlbUrl) // Exclude preview-only jobs
    );

    if (activeJobs.length === 0) {
      return { synced: 0, failed: 0 };
    }

    logger.debug({ count: activeJobs.length }, "Syncing active jobs from API");

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

    if (failed > 0) {
      // When all attempts failed (API likely unavailable), log at DEBUG to avoid spam
      if (synced === 0) {
        logger.debug({ synced, failed }, "Job sync skipped: API unavailable (all attempts failed)");
      } else {
        logger.info({ synced, failed }, "Job sync completed with failures");
      }
    } else {
      logger.debug({ synced, failed }, "Job sync completed");
    }
    return { synced, failed };
  } catch (err: any) {
    logger.error({ err }, "Failed to sync jobs");
    return { synced: 0, failed: 0 };
  }
}



