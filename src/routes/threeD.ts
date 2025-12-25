import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { createJob, getJob, listJobs, listJobsForUser, updateJobResult, updateJobStatus, deleteJob, getJobForUser } from "../repository/jobs.js";
import { optionalAuth, requireAuth, syncUserToDatabase } from "../middleware/auth.js";

export const threeDRouter = Router();

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
    // Fetch from API
    const response = await fetch(`${API_BASE}/status/${jobId}`);
    if (!response.ok) {
      if (response.status === 404) {
        return res.status(404).json({ error: "Job not found" });
      }
      throw new Error("Failed to fetch job status");
    }

    const apiJob = await response.json();

    // Get or create job in database
    let job = await getJob(jobId);
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
      const glbUrl = apiJob.result.mesh_url || apiJob.result.output;
      const previewUrl = apiJob.result.processed_image_url || apiJob.result.generated_image_url || apiJob.result.processed_image || apiJob.result.generated_image;
      await updateJobResult(jobId, {
        resultGlbUrl: glbUrl || null,
        previewImageUrl: previewUrl || null,
      });
      job.resultGlbUrl = glbUrl || null;
      job.previewImageUrl = previewUrl || null;
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
    res.json({ job });
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
      const response = await fetch(`${API_BASE}/status/${jobId}`);
      if (response.ok) {
        const apiJob = await response.json();
        if (apiJob.status === "completed" && apiJob.result) {
          const glbUrl = apiJob.result.mesh_url || apiJob.result.output;
          const previewUrl = apiJob.result.processed_image_url || apiJob.result.generated_image_url || apiJob.result.processed_image || apiJob.result.generated_image;
          if (glbUrl || previewUrl) {
            await updateJobResult(jobId, {
              resultGlbUrl: glbUrl || null,
              previewImageUrl: previewUrl || null,
            });
            job.resultGlbUrl = glbUrl || null;
            job.previewImageUrl = previewUrl || null;
          }
        }
      }
    } catch (err) {
      logger.error(err, "failed to fetch from API, using cached result");
    }

    res.json({ job });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch result" });
  }
});

// ============================================
// Get User's Job History (requires auth)
// ============================================
threeDRouter.get("/history", optionalAuth, async (req, res) => {
  try {
    const userId = req.userId;
    
    // If authenticated, return only user's jobs
    // If not authenticated, return empty array (for security)
    if (userId) {
      const jobs = await listJobsForUser(userId, 100);
      res.json({ jobs: jobs || [] });
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
// Register Job (with optional auth)
// ============================================
threeDRouter.post("/register-job", optionalAuth, async (req, res) => {
  try {
    const { job_id, prompt, imageUrl } = req.body as {
      job_id: string;
      prompt?: string;
      imageUrl?: string;
    };
    const userId = req.userId;

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

    const existingJob = await getJob(job_id);
    if (existingJob) {
      // Update user_id if job exists but has no owner and we have a userId
      if (!existingJob.userId && userId) {
        try {
          await supabase
            .from("jobs")
            .update({ user_id: userId })
            .eq("id", job_id);
          logger.info({ jobId: job_id, userId }, "Updated job with user_id");
        } catch (updateErr) {
          logger.warn({ err: updateErr }, "Failed to update job with user_id");
        }
      }
      return res.json({ success: true, job_id, message: "Job already exists" });
    }

    await createJob({
      id: job_id,
      userId: userId || null,
      prompt: prompt || null,
      imageUrl: imageUrl || null,
      generateType: "Normal",
      faceCount: null,
      enablePBR: true,
      polygonType: null,
    });

    logger.info({ jobId: job_id, userId, prompt: prompt?.slice(0, 50) }, "Job registered successfully");
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
      const glbUrl = result.mesh_url || result.output;
      const previewUrl = result.processed_image_url || result.generated_image_url || result.processed_image || result.generated_image;
      await updateJobResult(job_id, {
        resultGlbUrl: glbUrl || null,
        previewImageUrl: previewUrl || null,
      });
    }

    res.json({ success: true, job_id });
  } catch (err: any) {
    logger.error(err, "webhook job update failed");
    res.status(500).json({ error: err.message || "Failed to update job" });
  }
});

// ============================================
// GLB Proxy (no auth - for public access)
// ============================================
threeDRouter.get("/glb-proxy", async (req, res) => {
  try {
    const url = req.query.url as string;
    if (!url) {
      return res.status(400).json({ error: "URL parameter is required" });
    }

    try {
      const urlObj = new URL(url);
      if (!["https:", "http:"].includes(urlObj.protocol)) {
        return res.status(400).json({ error: "Invalid URL protocol" });
      }
    } catch {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "*/*",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.error({ url, status: response.status }, "Failed to fetch GLB");
        return res.status(response.status).json({ error: `Failed to fetch GLB: ${response.statusText}` });
      }

      res.setHeader("Content-Type", "model/gltf-binary");
      res.setHeader("Content-Disposition", `attachment; filename="model.glb"`);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Cache-Control", "public, max-age=3600");

      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
    } catch (fetchErr: any) {
      clearTimeout(timeoutId);
      if (fetchErr.name === "AbortError") {
        return res.status(504).json({ error: "Request timeout" });
      }
      throw fetchErr;
    }
  } catch (err: any) {
    logger.error({ err, url: req.query.url }, "failed to proxy GLB");
    res.status(500).json({ error: err.message || "Failed to proxy GLB file" });
  }
});

threeDRouter.options("/glb-proxy", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
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
      res.status(500).json({ error: "Failed to sync user" });
    }
  } catch (err: any) {
    logger.error(err, "failed to sync user");
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
      return res.status(500).json({ error: "Failed to fetch user" });
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
