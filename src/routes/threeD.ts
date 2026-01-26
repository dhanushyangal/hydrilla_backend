import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { createJob, getJob, listJobs, listJobsForUser, updateJobResult, updateJobStatus, updateJobName, deleteJob, getJobForUser } from "../repository/jobs.js";
import { createChat, getChat, getChatForUser, listChatsForUser, updateChatName, deleteChat, getOrCreateActiveChat } from "../repository/chats.js";
import { optionalAuth, requireAuth, syncUserToDatabase } from "../middleware/auth.js";
import { normalizeGlbUrl, normalizePreviewUrl } from "../utils/s3Urls.js";
import { JobStatus, JobRecord, ChatRecord } from "../types.js";

export const threeDRouter = Router();

// Global CORS middleware for all routes in this router
threeDRouter.use((req, res, next) => {
  // Set CORS headers for all requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  
  next();
});

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
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req: any, file: any, cb: any) => {
    const allowedMimes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only images are allowed."));
    }
  },
});

const API_BASE = process.env.HUNYUAN_API_URL || "https://api.hydrilla.co";

// Initialize S3 client
let s3Client: S3Client | null = null;
let s3Enabled = false;

try {
  const hasExplicitCredentials = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  s3Client = new S3Client({
    region: config.s3.region,
  });
  s3Enabled = true;
  logger.info({
    bucket: config.s3.bucket,
    region: config.s3.region,
    hasExplicitCredentials,
  }, "S3 client initialized");
} catch (err: any) {
  logger.warn({ err }, "Failed to initialize S3 client. S3 uploads disabled.");
  s3Enabled = false;
  s3Client = null;
}

// Helper functions for status conversion
function convertStatus(apiStatus: string): "WAIT" | "RUN" | "FAIL" | "DONE" {
  switch (apiStatus) {
    case "pending": return "WAIT";
    case "processing": return "RUN";
    case "failed":
    case "cancelled": return "FAIL";
    case "completed": return "DONE";
    default: return "WAIT";
  }
}

// ============================================
// Generate 3D Model Endpoint (requires auth)
// ============================================
threeDRouter.post("/generate", requireAuth, async (req, res) => {
  try {
    const body = req.body as { prompt?: string; imageUrl?: string; imageBase64?: string };
    const userId = req.userId!;

    // Sync user to database on first request
    await syncUserToDatabase(userId);

    let jobId: string;

    if (body.prompt) {
      // Text-to-3D
      const formData = new URLSearchParams();
      formData.append("prompt", body.prompt);
      formData.append("user_id", userId);  // Pass user_id to Python API

      const response = await fetch(`${API_BASE}/text-to-3d`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      if (!response.ok) {
        let errorText: string;
        try {
          const errorData = await response.json();
          errorText = errorData.error || "Failed to submit text-to-3d job";
        } catch {
          errorText = await response.text() || "Failed to submit text-to-3d job";
        }
        throw new Error(errorText);
      }

      const data = await response.json();
      jobId = data.job_id;
    } else if (body.imageUrl || body.imageBase64) {
      // Image-to-3D
      const formData = new URLSearchParams();
      if (body.imageUrl) {
        formData.append("image_url", body.imageUrl);
      } else if (body.imageBase64) {
        return res.status(400).json({ error: "Please provide imageUrl instead of imageBase64" });
      }
      formData.append("user_id", userId);  // Pass user_id to Python API

      const response = await fetch(`${API_BASE}/image-to-3d`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      if (!response.ok) {
        let errorText: string;
        try {
          const errorData = await response.json();
          errorText = errorData.error || "Failed to submit image-to-3d job";
        } catch {
          errorText = await response.text() || "Failed to submit image-to-3d job";
        }
        throw new Error(errorText);
      }

      const data = await response.json();
      jobId = data.job_id;
    } else {
      return res.status(400).json({ error: "Either prompt or imageUrl is required" });
    }

    // Create job in database with user_id
    await createJob({
      id: jobId,
      userId,
      prompt: body.prompt || null,
      imageUrl: body.imageUrl || null,
      generateType: "Normal",
      faceCount: null,
      enablePBR: true,
      polygonType: null,
    });

    res.json({ jobId });
  } catch (err: any) {
    logger.error(err, "failed to submit job");
    res.status(400).json({ error: err.message || "Failed to submit job" });
  }
});

// ============================================
// Get Job Status (optional auth for viewing)
// ============================================
threeDRouter.get("/status/:jobId", optionalAuth, async (req, res) => {
  const { jobId } = req.params;
  const userId = req.userId;

  try {
    // First, try to get job from database
    let job = await getJob(jobId);

    // If job exists and is completed, return it immediately (no need to check external API)
    // Also return immediately for preview-only jobs (they don't exist in Python API)
    if (job && (job.status === "DONE" || job.status === "FAIL" || (job.previewImageUrl && !job.resultGlbUrl))) {
      // Check ownership
      if (userId && job.userId && job.userId !== userId) {
        return res.status(403).json({ error: "You don't have permission to view this job" });
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

    // For pending/processing jobs or if job doesn't exist, try to fetch from external API
    // But if API is unreachable and we have the job in DB, return the DB version
    let apiJob = null;
    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
      
      const response = await fetch(`${API_BASE}/status/${jobId}`, {
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
        // If we have it in DB but API says not found, return DB version
        if (userId && job.userId && job.userId !== userId) {
          return res.status(403).json({ error: "You don't have permission to view this job" });
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
        if (userId && job.userId && job.userId !== userId) {
          return res.status(403).json({ error: "You don't have permission to view this job" });
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
      
      // If no job in DB and API is unreachable, return error
      return res.status(503).json({ 
        error: "External service unavailable. Please try again later." 
      });
    }

    // If we got data from API, process it
    if (!apiJob) {
      // Should not reach here, but handle it
      if (job) {
        if (userId && job.userId && job.userId !== userId) {
          return res.status(403).json({ error: "You don't have permission to view this job" });
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
        generateType: "Normal",
        faceCount: null,
        enablePBR: true,
        polygonType: null,
      });
      job = await getJob(jobId);
    }

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Check ownership (allow viewing if no userId or if user owns the job or if job has no owner)
    if (userId && job.userId && job.userId !== userId) {
      return res.status(403).json({ error: "You don't have permission to view this job" });
    }

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
      await updateJobStatus(jobId, {
        status,
        errorCode: null,
        errorMessage: apiJob.error || "Job failed",
      });
      job.errorMessage = apiJob.error || "Job failed";
    }

    job.status = status;
    
    // Normalize URLs to ensure they're direct S3 URLs (not expired signed URLs)
    if (job.resultGlbUrl) {
      job.resultGlbUrl = normalizeGlbUrl(jobId, job.resultGlbUrl);
    }
    if (job.previewImageUrl) {
      job.previewImageUrl = normalizePreviewUrl(jobId, job.previewImageUrl);
    }
    
    // Include queue info from Python API for accurate time estimation
    const response_data: any = { job };
    if (apiJob.queue) {
      response_data.queue = apiJob.queue;
    }
    
    res.json(response_data);
  } catch (err: any) {
    logger.error(err, "failed to query job");
    res.status(500).json({ error: err.message || "Failed to query job" });
  }
});

// ============================================
// Get Job Result
// ============================================
threeDRouter.get("/result/:jobId", optionalAuth, async (req, res) => {
  const { jobId } = req.params;
  const userId = req.userId;

  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    // Check ownership
    if (userId && job.userId && job.userId !== userId) {
      return res.status(403).json({ error: "You don't have permission to view this job" });
    }

    // Fetch from API for latest result
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(`${API_BASE}/status/${jobId}`, {
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
    res.status(500).json({ error: err.message || "Failed to fetch result" });
  }
});

// ============================================
// Get Queue Info (for accurate time estimation)
// ============================================
threeDRouter.get("/queue/info", async (_req, res) => {
  try {
    // Fetch queue info from Python API with shorter timeout for faster failure detection
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // Reduced to 3 seconds
    
    const response = await fetch(`${API_BASE}/queue/info`, {
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const queueInfo = await response.json();
      return res.json({
        ...queueInfo,
        api_available: true, // Flag to indicate API is working
      });
    } else {
      // API returned error status - mark as unavailable
      logger.warn({ status: response.status }, "Python API returned error status for queue info");
      return res.status(503).json({
        error: "GPU API is currently unavailable",
        api_available: false,
        queue_length: 0,
        currently_processing: false,
        waiting_jobs: 0,
        estimated_wait_for_new_job_seconds: 130,
        estimated_time_per_job_seconds: 130,
        preview_queue_length: 0,
        currently_generating_preview: false,
        preview_waiting: 0,
        estimated_wait_for_preview_seconds: 0,
        estimated_preview_time_seconds: 20
      });
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Failed to fetch queue info from Python API");
    // Return 503 status to indicate service unavailable
    return res.status(503).json({
      error: "GPU API is currently unavailable",
      api_available: false,
      queue_length: 0,
      currently_processing: false,
      waiting_jobs: 0,
      estimated_wait_for_new_job_seconds: 130,
      estimated_time_per_job_seconds: 130,
      preview_queue_length: 0,
      currently_generating_preview: false,
      preview_waiting: 0,
      estimated_wait_for_preview_seconds: 0,
      estimated_preview_time_seconds: 20
    });
  }
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
      return res.status(404).json({ error: "Job not found" });
    }

    // Check ownership
    if (userId && job.userId && job.userId !== userId) {
      return res.status(403).json({ error: "You don't have permission to view this job" });
    }

    // Get GLB URL
    const glbUrl = job.resultGlbUrl;
    if (!glbUrl) {
      return res.status(404).json({ error: "GLB file not found for this job" });
    }

    // If it's an S3 URL, try to fetch from S3 directly
    if (glbUrl.includes(config.s3.bucket) && s3Enabled && s3Client) {
      try {
        // Extract S3 key from URL
        const urlParts = glbUrl.split(`${config.s3.bucket}/`);
        if (urlParts.length > 1) {
          const s3Key = urlParts[1].split('?')[0]; // Remove query params
          
          // Fetch from S3
          const command = new GetObjectCommand({
            Bucket: config.s3.bucket,
            Key: s3Key,
          });
          
          const s3Response = await s3Client.send(command);
          
          // Get content length for progress tracking
          const contentLength = s3Response.ContentLength || s3Response.ContentLength || 0;
          
          // Set CORS headers
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
          res.setHeader("Content-Type", "model/gltf-binary");
          res.setHeader("Content-Disposition", `inline; filename="mesh.glb"`);
          if (contentLength > 0) {
            res.setHeader("Content-Length", contentLength.toString());
          }
          
          // Stream the file
          if (s3Response.Body) {
            // Convert stream to buffer
            const stream = s3Response.Body as Readable;
            const chunks: Buffer[] = [];
            
            stream.on('data', (chunk: Buffer) => {
              chunks.push(chunk);
            });
            
            stream.on('end', () => {
              const buffer = Buffer.concat(chunks);
              res.send(buffer);
            });
            
            stream.on('error', (err: Error) => {
              logger.error({ jobId, err: err.message }, "Error streaming from S3");
              if (!res.headersSent) {
                res.status(500).json({ error: "Failed to stream GLB file" });
              }
            });
            
            return;
          }
        }
      } catch (s3Err: any) {
        logger.warn({ jobId, err: s3Err.message }, "Failed to fetch from S3, trying direct URL");
      }
    }

    // Fallback: proxy through backend by fetching the URL
    try {
      const response = await fetch(glbUrl);
      if (!response.ok) {
        return res.status(response.status).json({ error: "Failed to fetch GLB file" });
      }

      // Get content length from response headers
      const contentLength = response.headers.get("content-length");
      
      // Set CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Content-Type", "model/gltf-binary");
      res.setHeader("Content-Disposition", `inline; filename="mesh.glb"`);
      if (contentLength) {
        res.setHeader("Content-Length", contentLength);
      }

      // Stream the response
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
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
// Get User's Job History (optional auth - returns empty if not authenticated)
// ============================================
threeDRouter.get("/history", optionalAuth, async (req, res) => {
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
// Update Job Name (requires auth)
// ============================================
threeDRouter.patch("/jobs/:jobId/name", requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const userId = req.userId!;
  const { name } = req.body as { name?: string };

  try {
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Name is required and must be a string" });
    }

    const job = await getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Check ownership
    if (job.userId && job.userId !== userId) {
      return res.status(403).json({ error: "You don't have permission to update this job" });
    }

    await updateJobName(jobId, name.trim(), userId);
    res.json({ success: true, message: "Job name updated" });
  } catch (err: any) {
    logger.error(err, "failed to update job name");
    res.status(500).json({ error: err.message || "Failed to update job name" });
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
        faceCount: row.face_count,
        enablePBR: row.enable_pbr,
        polygonType: row.polygon_type,
        resultGlbUrl: resultGlbUrl,
        previewImageUrl: previewImageUrl,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        name: row.name || null,
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
threeDRouter.post("/register-job", optionalAuth, async (req, res) => {
  try {
    const { job_id, prompt, imageUrl, previewImageUrl, previewJobId, chatId } = req.body as {
      job_id: string;
      prompt?: string;
      imageUrl?: string;
      previewImageUrl?: string;
      previewJobId?: string;
      chatId?: string;
    };
    const userId = req.userId;
    
    // Get or create active chat if user is authenticated and no chatId provided
    let finalChatId: string | null = chatId || null;
    if (userId && !finalChatId) {
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

    // If previewJobId is provided, fetch the preview job to copy name and prompt
    let previewJob: JobRecord | null = null;
    let finalPrompt = prompt || null;
    let finalName: string | null = null;
    
    logger.info({ jobId: job_id, previewJobId, hasPrompt: !!prompt, hasImageUrl: !!imageUrl }, "Register job request received");
    
    if (previewJobId) {
      logger.info({ jobId: job_id, previewJobId }, "Preview job ID provided, fetching preview job");
      previewJob = await getJob(previewJobId);
      if (previewJob) {
        logger.info({ jobId: job_id, previewJobId, previewJobPrompt: previewJob.prompt?.slice(0, 50), previewJobName: previewJob.name }, "Preview job found");
        // Copy name and prompt from preview job (preview job prompt takes priority)
        if (previewJob.prompt !== null && previewJob.prompt !== undefined) {
          finalPrompt = previewJob.prompt;
          logger.info({ jobId: job_id, previewJobId, prompt: finalPrompt?.slice(0, 50) }, "Copied prompt from preview job");
        } else {
          logger.warn({ jobId: job_id, previewJobId }, "Preview job has no prompt to copy");
        }
        if (previewJob.name !== null && previewJob.name !== undefined) {
          finalName = previewJob.name;
          logger.info({ jobId: job_id, previewJobId, name: finalName }, "Copied name from preview job");
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
            .select("id, prompt, name")
            .eq("preview_image_url", imageUrl)
            .eq("user_id", userId)
            .is("result_glb_url", null) // Only preview jobs (no 3D result)
            .limit(1);
          
          if (!previewError && previewJobs && previewJobs.length > 0) {
            const foundPreviewJob = previewJobs[0];
            logger.info({ jobId: job_id, foundPreviewJobId: foundPreviewJob.id, prompt: foundPreviewJob.prompt?.slice(0, 50) }, "Found preview job by matching imageUrl");
            
            // Use the found preview job's prompt and name
            if (foundPreviewJob.prompt !== null && foundPreviewJob.prompt !== undefined) {
              finalPrompt = foundPreviewJob.prompt;
            }
            if (foundPreviewJob.name !== null && foundPreviewJob.name !== undefined) {
              finalName = foundPreviewJob.name;
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

    const existingJob = await getJob(job_id);
    if (existingJob) {
      // Check ownership - don't allow updating jobs owned by other users
      if (existingJob.userId && userId && existingJob.userId !== userId) {
        return res.status(403).json({ error: "You don't have permission to update this job" });
      }
      
      // Update user_id and chat_id if job exists but has no owner and we have a userId
      if (!existingJob.userId && userId) {
        try {
          const updateData: any = { user_id: userId };
          if (finalChatId && !existingJob.chatId) {
            updateData.chat_id = finalChatId;
          }
          await supabase
            .from("jobs")
            .update(updateData)
            .eq("id", job_id);
          logger.info({ jobId: job_id, userId, chatId: finalChatId }, "Updated job with user_id and chat_id");
        } catch (updateErr) {
          logger.warn({ err: updateErr }, "Failed to update job with user_id/chat_id");
        }
      } else if (finalChatId && !existingJob.chatId && userId) {
        // Update chat_id if not set
        try {
          await supabase
            .from("jobs")
            .update({ chat_id: finalChatId })
            .eq("id", job_id);
          logger.info({ jobId: job_id, chatId: finalChatId }, "Updated job with chat_id");
        } catch (updateErr) {
          logger.warn({ err: updateErr }, "Failed to update job with chat_id");
        }
      }
      
      // Update prompt and name from preview job if provided
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
          
          if (finalName !== null && finalName !== undefined) {
            updateData.name = finalName;
            hasUpdates = true;
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
            
            logger.info({ jobId: job_id, name: finalName, prompt: finalPrompt?.slice(0, 50) }, "Successfully updated existing job with preview job name/prompt");
          } else {
            logger.warn({ jobId: job_id, previewJobId }, "No updates to apply from preview job");
          }
        } catch (updateErr: any) {
          logger.error({ err: updateErr, jobId: job_id, previewJobId, finalPrompt: finalPrompt?.slice(0, 50) }, "Failed to update job with preview job name/prompt");
        }
      } else if (previewJobId) {
        logger.warn({ jobId: job_id, previewJobId }, "Preview job not found, cannot copy prompt/name");
      }
      
      // Update preview image if provided
      if (previewImageUrl) {
        await updateJobResult(job_id, { previewImageUrl });
        // If preview is provided and job doesn't have 3D result, set status to DONE
        if (!existingJob.resultGlbUrl) {
          await updateJobStatus(job_id, { status: "DONE" });
        }
      }
      
      return res.json({ success: true, job_id, message: "Job already exists" });
    }

    // If previewImageUrl is provided, this is a preview-only job (image already generated)
    // Set status to DONE since the preview is complete
    const initialStatus: JobStatus = previewImageUrl ? "DONE" : "WAIT";
    
    await createJob({
      id: job_id,
      userId: userId || null,
      chatId: finalChatId,
      prompt: finalPrompt,
      imageUrl: imageUrl || null,
      generateType: "Normal",
      faceCount: null,
      enablePBR: true,
      polygonType: null,
      status: initialStatus,
    });
    
    // Update name if we got it from preview job
    if (finalName) {
      await updateJobName(job_id, finalName, userId || undefined);
    }
    
    // Update preview image if provided
    if (previewImageUrl) {
      await updateJobResult(job_id, { previewImageUrl });
    }

    logger.info({ jobId: job_id, userId, prompt: finalPrompt?.slice(0, 50), name: finalName }, "Job registered successfully");
    res.json({ success: true, job_id });
  } catch (err: any) {
    logger.error(err, "failed to register job");
    res.status(500).json({ error: err.message || "Failed to register job" });
  }
});

// ============================================
// Webhook for job updates (no auth - internal use)
// ============================================
threeDRouter.post("/webhook/job-update", async (req, res) => {
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
        generateType: "Normal",
        faceCount: null,
        enablePBR: true,
        polygonType: null,
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
              job.name || null,
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
// Image Upload (with optional auth)
// ============================================
threeDRouter.post("/upload-image", optionalAuth, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }

    let imageUrl: string;
    const fileBuffer = req.file.buffer || (req.file.path ? fs.readFileSync(req.file.path) : null);

    if (!fileBuffer) {
      return res.status(500).json({ error: "Failed to read uploaded file" });
    }

    if (s3Enabled && s3Client) {
      try {
        const fileExtension = path.extname(req.file.originalname).toLowerCase();
        const contentType = req.file.mimetype || `image/${fileExtension.slice(1)}`;
        const s3Key = `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}${fileExtension}`;

        await s3Client.send(
          new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: s3Key,
            Body: fileBuffer,
            ContentType: contentType,
            ACL: "public-read",
          })
        );

        imageUrl = `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${s3Key}`;
        
        // Clean up local file if it exists (disk storage)
        if (req.file.path && fs.existsSync(req.file.path)) {
          try {
            fs.unlinkSync(req.file.path);
          } catch (unlinkErr) {
            logger.warn({ err: unlinkErr }, "Failed to delete temporary file");
          }
        }
        
        logger.info({ s3Key, url: imageUrl }, "Image uploaded to S3");
      } catch (s3Err: any) {
        logger.error({ err: s3Err }, "S3 upload failed");
        // In serverless, we can't serve local files, so S3 is required
        if (isVercel) {
          return res.status(500).json({ error: "S3 upload failed. S3 is required in serverless environment." });
        }
        const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
        imageUrl = `${baseUrl}/uploads/${req.file.filename}`;
      }
    } else {
      // In serverless/Vercel, we need S3 for file storage
      if (isVercel) {
        return res.status(500).json({ error: "S3 storage is required in serverless environment. Please configure S3." });
      }
      const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
      imageUrl = `${baseUrl}/uploads/${req.file.filename}`;
    }

    res.json({ success: true, url: imageUrl });
  } catch (err: any) {
    logger.error(err, "failed to upload image");
    res.status(500).json({ error: err.message || "Failed to upload image" });
  }
});

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
threeDRouter.post("/notify-gpu-offline", optionalAuth, async (req, res) => {
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
