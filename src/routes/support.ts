import { Router, Request, Response } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { optionalAuth, clerk } from "../middleware/auth.js";
import { createSupportFeedback, SupportType } from "../repository/supportFeedback.js";
import { uploadSupportAttachment } from "../lib/supportUpload.js";
import { logger } from "../logger.js";

const isVercel = Boolean(
  process.env.VERCEL === "1" ||
  process.env.VERCEL_ENV ||
  process.cwd().startsWith("/var/task") ||
  process.cwd().startsWith("/var/runtime")
);

const storage = isVercel
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (_req, _file, cb) => {
        const uploadsDir = path.join(process.cwd(), "uploads", "support");
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        cb(null, uploadsDir);
      },
      filename: (_req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `support-${uniqueSuffix}${ext}`);
      },
    });

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB
  },
});

export const supportRouter = Router();

/**
 * POST /api/support/upload — upload attachment (screenshot, screen recording, image)
 */
supportRouter.post(
  "/upload",
  optionalAuth,
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided" });
      }

      const fileBuffer = req.file.buffer || fs.readFileSync(req.file.path);
      const url = await uploadSupportAttachment(
        fileBuffer,
        req.file.originalname,
        req.file.mimetype,
        req.file.filename
      );

      return res.status(201).json({
        ok: true,
        url,
        filename: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });
    } catch (err: unknown) {
      logger.error({ err }, "[Support] Attachment upload failed");
      const message = err instanceof Error ? err.message : "Failed to upload attachment";
      return res.status(500).json({ error: message });
    }
  }
);

/**
 * POST /api/support — submit issue report or feedback
 */
supportRouter.post("/", optionalAuth, async (req: Request, res: Response) => {
  try {
    const {
      type,
      request_type,
      message,
      attachment_url,
      attachment_name,
      page_url,
      metadata,
      email,
      name,
    } = req.body as {
      type?: string;
      request_type?: string;
      message?: string;
      attachment_url?: string;
      attachment_name?: string;
      page_url?: string;
      metadata?: Record<string, unknown>;
      email?: string;
      name?: string;
    };

    if (!type || (type !== "issue" && type !== "feedback")) {
      return res.status(400).json({
        error: "Invalid type. Must be 'issue' or 'feedback'.",
      });
    }

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        error: "Message is required and cannot be empty.",
      });
    }

    // Try to resolve user details from Clerk if authenticated
    const clerkUser = req.userId
      ? await clerk.users.getUser(req.userId).catch(() => null)
      : null;

    const userEmail =
      req.userEmail ||
      clerkUser?.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ||
      clerkUser?.emailAddresses[0]?.emailAddress ||
      email?.trim() ||
      null;

    const userName =
      [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ") ||
      clerkUser?.username ||
      name?.trim() ||
      null;

    const ticket = await createSupportFeedback({
      type: type as SupportType,
      request_type: request_type?.trim() || (type === "issue" ? "Issue" : "Feedback"),
      message: message.trim(),
      attachment_url: attachment_url?.trim() || null,
      attachment_name: attachment_name?.trim() || null,
      user_id: req.userId || null,
      user_email: userEmail,
      user_name: userName,
      page_url: page_url?.trim() || null,
      metadata: metadata || {},
    });

    return res.status(201).json({
      ok: true,
      ticket,
    });
  } catch (err: unknown) {
    logger.error({ err }, "[Support] Submit ticket failed");
    const errorMsg = err instanceof Error ? err.message : "Failed to submit support request";
    return res.status(500).json({ error: errorMsg });
  }
});
