import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { createJob, getJob, listJobs, updateJobResult, updateJobStatus } from "../repository/jobs.js";

export const threeDRouter = Router();

// Configure multer for file uploads
// Use memory storage for Vercel (ephemeral filesystem)
// For EC2 deployment, this can be changed to diskStorage
const isVercel = process.env.VERCEL === "1";
const uploadsDir = path.join(process.cwd(), "uploads");

// Create uploads directory only if not on Vercel
if (!isVercel && !fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Use memory storage on Vercel, disk storage otherwise
const storage = isVercel
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (_req: any, _file: any, cb: any) => {
        cb(null, uploadsDir);
      },
      filename: (_req: any, file: any, cb: any) => {
        // Generate unique filename with timestamp
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `image-${uniqueSuffix}${ext}`);
      },
    });

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (_req: any, file: any, cb: any) => {
    // Accept only image files
    const allowedMimes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only images are allowed."));
    }
  },
});

const API_BASE = process.env.HUNYUAN_API_URL || "https://api.hydrilla.co";

// Helper function to make API requests with proper error handling
async function makeApiRequest(url: string, options: RequestInit = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        "User-Agent": "Hydrilla-Backend/1.0",
      },
    });
    return response;
  } catch (err: any) {
    logger.error({ err, url }, "API request failed");
    throw new Error(`Failed to connect to API: ${err.message}`);
  }
}

// Initialize S3 client (if credentials are available)
let s3Client: S3Client | null = null;
let s3Enabled = false;

try {
  // Check if AWS credentials are available
  // AWS SDK will automatically detect from:
  // 1. Environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
  // 2. AWS credentials file: ~/.aws/credentials
  // 3. IAM role (if running on EC2)
  const hasExplicitCredentials = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  
  // Try to initialize S3 client
  // The SDK will throw an error if credentials are truly unavailable
  s3Client = new S3Client({
    region: config.s3.region,
  });
  
  // If we got here, S3 client was created (credentials will be checked on first use)
  s3Enabled = true;
  logger.info({
    bucket: config.s3.bucket,
    region: config.s3.region,
    hasExplicitCredentials,
  }, "S3 client initialized");
} catch (err: any) {
  logger.warn({ err }, "Failed to initialize S3 client. S3 uploads disabled. Images will be stored locally.");
  s3Enabled = false;
  s3Client = null;
}

// Helper to convert our status to API status
function convertStatus(apiStatus: string): "WAIT" | "RUN" | "FAIL" | "DONE" {
  switch (apiStatus) {
    case "pending":
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

// Helper to convert API status to our status
function convertFromApiStatus(apiStatus: string): "pending" | "processing" | "completed" | "failed" | "cancelled" {
  switch (apiStatus) {
    case "WAIT":
      return "pending";
    case "RUN":
      return "processing";
    case "DONE":
      return "completed";
    case "FAIL":
      return "failed";
    default:
      return "pending";
  }
}

threeDRouter.post("/generate", async (req, res) => {
  try {
    const body = req.body as { prompt?: string; imageUrl?: string; imageBase64?: string };

    let jobId: string;
    let mode: "text-to-3d" | "image-to-3d";

    // Determine mode and submit to API
    if (body.prompt) {
      // Text-to-3D - use URLSearchParams for form data
      const formData = new URLSearchParams();
      formData.append("prompt", body.prompt);

      const response = await makeApiRequest(`${API_BASE}/text-to-3d`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
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
      mode = "text-to-3d";
    } else if (body.imageUrl || body.imageBase64) {
      // Image-to-3D - use URLSearchParams for form data
      const formData = new URLSearchParams();
      if (body.imageUrl) {
        formData.append("image_url", body.imageUrl);
      } else if (body.imageBase64) {
        // For base64, we need to upload it as a file or convert to URL
        // For now, we'll reject base64 and require URL
        return res.status(400).json({ error: "Please provide imageUrl instead of imageBase64 for image-to-3d" });
      }

      const response = await makeApiRequest(`${API_BASE}/image-to-3d`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
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
      mode = "image-to-3d";
    } else {
      return res.status(400).json({ error: "Either prompt or imageUrl/imageBase64 is required" });
    }

    // Create job in database
    await createJob({
      id: jobId,
      prompt: body.prompt || null,
      imageUrl: body.imageUrl || null,
      generateType: "Normal", // Default for compatibility
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

threeDRouter.get("/status/:jobId", async (req, res) => {
  const { jobId } = req.params;
  try {
    // Fetch from API
    const response = await makeApiRequest(`${API_BASE}/status/${jobId}`);
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
      // Create job if it doesn't exist
      await createJob({
        id: jobId,
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

    // Update job status from API
    const status = convertStatus(apiJob.status);
    await updateJobStatus(jobId, { status });

    // Update result if completed
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

    // Update error if failed
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

threeDRouter.get("/result/:jobId", async (req, res) => {
  const { jobId } = req.params;
  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    // Also fetch from API to get latest result
    try {
      const response = await makeApiRequest(`${API_BASE}/status/${jobId}`);
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

threeDRouter.get("/history", async (_req, res) => {
  try {
    const jobs = await listJobs(100);
    res.json({ jobs });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to fetch history" });
  }
});

// Endpoint to register a job that was created directly via API
// This allows frontend to create jobs in Supabase when calling API directly
threeDRouter.post("/register-job", async (req, res) => {
  try {
    const { job_id, prompt, imageUrl } = req.body as {
      job_id: string;
      prompt?: string;
      imageUrl?: string;
    };

    if (!job_id) {
      return res.status(400).json({ error: "job_id is required" });
    }

    // Check if job already exists
    const existingJob = await getJob(job_id);
    if (existingJob) {
      return res.json({ success: true, job_id, message: "Job already exists" });
    }

    // Create job in database
    await createJob({
      id: job_id,
      prompt: prompt || null,
      imageUrl: imageUrl || null,
      generateType: "Normal",
      faceCount: null,
      enablePBR: true,
      polygonType: null,
    });

    res.json({ success: true, job_id });
  } catch (err: any) {
    logger.error(err, "failed to register job");
    res.status(500).json({ error: err.message || "Failed to register job" });
  }
});

// Webhook endpoint for API to notify backend when jobs complete
// This allows the API to update Supabase directly
threeDRouter.post("/webhook/job-update", async (req, res) => {
  try {
    const { job_id, status, result, error } = req.body as {
      job_id: string;
      status: string;
      result?: any;
      error?: string;
    };

    if (!job_id) {
      return res.status(400).json({ error: "job_id is required" });
    }

    // Get or create job in database
    let job = await getJob(job_id);
    if (!job) {
      // Create job if it doesn't exist
      await createJob({
        id: job_id,
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

    // Update job status
    const dbStatus = convertStatus(status);
    await updateJobStatus(job_id, {
      status: dbStatus,
      errorCode: null,
      errorMessage: error || null,
    });

    // Update result if completed
    if (status === "completed" && result) {
      const glbUrl = result.mesh_url || result.output;
      const previewUrl =
        result.processed_image_url ||
        result.generated_image_url ||
        result.processed_image ||
        result.generated_image;

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

// Proxy endpoint to fetch GLB files (bypasses CORS)
threeDRouter.get("/glb-proxy", async (req, res) => {
  try {
    const url = req.query.url as string;
    if (!url) {
      return res.status(400).json({ error: "URL parameter is required" });
    }

    // Validate URL (allow S3 URLs and other valid URLs)
    try {
      const urlObj = new URL(url);
      // Allow S3 URLs, Tencent CDN, or any HTTPS URL
      if (!["https:", "http:"].includes(urlObj.protocol)) {
        return res.status(400).json({ error: "Invalid URL protocol" });
      }
    } catch {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    // Fetch the GLB file with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 seconds
    
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
        logger.error({ url, status: response.status, statusText: response.statusText }, "Failed to fetch GLB from URL");
        return res.status(response.status).json({ error: `Failed to fetch GLB: ${response.statusText}` });
      }

      // Set proper headers for GLB file
      res.setHeader("Content-Type", "model/gltf-binary");
      res.setHeader("Content-Disposition", `attachment; filename="model.glb"`);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Cache-Control", "public, max-age=3600");

      // Stream the file
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
    } catch (fetchErr: any) {
      clearTimeout(timeoutId);
      if (fetchErr.name === "AbortError") {
        logger.error({ url }, "GLB fetch timeout");
        return res.status(504).json({ error: "Request timeout - file too large or network issue" });
      }
      throw fetchErr;
    }
  } catch (err: any) {
    logger.error({ err, url: req.query.url }, "failed to proxy GLB");
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return res.status(504).json({ error: "Request timeout - file too large or network issue" });
    }
    res.status(500).json({ error: err.message || "Failed to proxy GLB file" });
  }
});

// Handle OPTIONS for CORS preflight
threeDRouter.options("/glb-proxy", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

// Image upload endpoint - uploads to S3 and returns public URL
threeDRouter.post("/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }

    let imageUrl: string;
    const isVercel = process.env.VERCEL === "1";

    // Try to upload to S3 first (if enabled)
    if (s3Enabled && s3Client) {
      try {
        const fileExtension = path.extname(req.file.originalname).toLowerCase();
        const contentType = req.file.mimetype || `image/${fileExtension.slice(1)}`;
        const s3Key = `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}${fileExtension}`;

        // Get file buffer - from memory (Vercel) or disk (EC2)
        const fileBuffer = isVercel && req.file.buffer 
          ? req.file.buffer 
          : fs.readFileSync(req.file.path);

        // Upload to S3
        await s3Client.send(
          new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: s3Key,
            Body: fileBuffer,
            ContentType: contentType,
            ACL: "public-read", // Make file publicly accessible
          })
        );

        // Generate public S3 URL
        imageUrl = `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${s3Key}`;

        // Clean up local file after successful S3 upload (only if not on Vercel)
        if (!isVercel && req.file.path) {
          fs.unlinkSync(req.file.path);
        }

        logger.info({ s3Key, url: imageUrl }, "Image uploaded to S3 successfully");
      } catch (s3Err: any) {
        logger.error({ err: s3Err }, "S3 upload failed");
        // On Vercel, S3 is required since we can't store files locally
        if (isVercel) {
          return res.status(500).json({ error: "S3 upload failed. S3 configuration is required on Vercel." });
        }
        // Fall back to local storage (EC2 only)
        const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
        imageUrl = `${baseUrl}/uploads/${req.file.filename}`;
        logger.warn({ url: imageUrl }, "Using local storage URL (S3 unavailable)");
      }
    } else {
      // S3 not available
      if (isVercel) {
        return res.status(500).json({ error: "S3 configuration is required for file uploads on Vercel." });
      }
      // Use local storage (EC2 only)
      const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
      imageUrl = `${baseUrl}/uploads/${req.file.filename}`;
      logger.warn({ url: imageUrl }, "S3 not configured, using local storage URL");
    }

    res.json({ success: true, url: imageUrl });
  } catch (err: any) {
    logger.error(err, "failed to upload image");
    res.status(500).json({ error: err.message || "Failed to upload image" });
  }
});
