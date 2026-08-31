import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { clerk } from "../middleware/auth.js";
import { sanitizeBlogHtml } from "../lib/blogSanitize.js";
import { uploadBlogImage } from "../lib/blogImageUpload.js";
import { logger } from "../logger.js";
import {
  createPost,
  deletePost,
  getPostById,
  isSlugTaken,
  listAllPosts,
  listPublishedCategories,
  toAdminPost,
  updatePost,
} from "../repository/blogPosts.js";
import { normalizeBlogPostInput, parseBlogPostBody } from "./blogSchemas.js";

const isVercel =
  process.env.VERCEL === "1" ||
  process.env.VERCEL_ENV ||
  process.cwd().startsWith("/var/task") ||
  process.cwd().startsWith("/var/runtime");

let storage: multer.StorageEngine;
if (isVercel) {
  storage = multer.memoryStorage();
} else {
  const uploadsDir = path.join(process.cwd(), "uploads");
  try {
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    storage = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadsDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `blog-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
      },
    });
  } catch {
    storage = multer.memoryStorage();
  }
}

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const mimetype = (file.mimetype || "").toLowerCase();
    const ext = path.extname(file.originalname || "").toLowerCase();
    const isImageMime = mimetype.startsWith("image/");
    const isGeneric =
      mimetype === "" || mimetype === "application/octet-stream" || mimetype === "binary/octet-stream";
    if (isImageMime || (isGeneric && allowedExt.includes(ext))) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only images are allowed."));
    }
  },
});

export const adminBlogRouter = Router();

adminBlogRouter.get("/posts", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const status =
      req.query.status === "draft" || req.query.status === "published"
        ? req.query.status
        : undefined;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const { posts, total } = await listAllPosts({ page, limit, category, status, search });
    res.json({
      posts: posts.map(toAdminPost),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    logger.error({ err }, "GET /api/admin/blog/posts failed");
    res.status(500).json({ error: "Failed to load blog posts" });
  }
});

adminBlogRouter.get("/posts/:id", async (req, res) => {
  try {
    const post = await getPostById(String(req.params.id || ""));
    if (!post) return res.status(404).json({ error: "Post not found" });
    res.json({ post: toAdminPost(post) });
  } catch (err) {
    logger.error({ err }, "GET /api/admin/blog/posts/:id failed");
    res.status(500).json({ error: "Failed to load blog post" });
  }
});

adminBlogRouter.post("/posts", async (req, res) => {
  try {
    const parsed = parseBlogPostBody(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    let input;
    try {
      input = normalizeBlogPostInput(parsed.data);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid input" });
    }

    input.content = sanitizeBlogHtml(input.content);

    if (await isSlugTaken(input.slug)) {
      return res.status(409).json({ error: "A post with this slug already exists" });
    }

    if (!input.author && req.userId) {
      try {
        const user = await clerk.users.getUser(req.userId);
        const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
        input.author = name || user.emailAddresses[0]?.emailAddress || "Hydrilla";
      } catch {
        input.author = input.author || "Hydrilla";
      }
    }

    const post = await createPost(input);
    res.status(201).json({ post: toAdminPost(post) });
  } catch (err) {
    if (err instanceof Error && err.message === "DUPLICATE_SLUG") {
      return res.status(409).json({ error: "A post with this slug already exists" });
    }
    logger.error({ err }, "POST /api/admin/blog/posts failed");
    res.status(500).json({ error: "Failed to create blog post" });
  }
});

adminBlogRouter.put("/posts/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const existing = await getPostById(id);
    if (!existing) return res.status(404).json({ error: "Post not found" });

    const parsed = parseBlogPostBody(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    let input;
    try {
      input = normalizeBlogPostInput(parsed.data);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid input" });
    }

    input.content = sanitizeBlogHtml(input.content);

    if (input.status === "published" && !input.publishedAt && existing.publishedAt) {
      input.publishedAt = existing.publishedAt;
    }

    if (await isSlugTaken(input.slug, id)) {
      return res.status(409).json({ error: "A post with this slug already exists" });
    }

    const post = await updatePost(id, input);
    res.json({ post: toAdminPost(post) });
  } catch (err) {
    if (err instanceof Error && err.message === "DUPLICATE_SLUG") {
      return res.status(409).json({ error: "A post with this slug already exists" });
    }
    logger.error({ err }, "PUT /api/admin/blog/posts/:id failed");
    res.status(500).json({ error: "Failed to update blog post" });
  }
});

adminBlogRouter.delete("/posts/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const existing = await getPostById(id);
    if (!existing) return res.status(404).json({ error: "Post not found" });
    await deletePost(id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "DELETE /api/admin/blog/posts/:id failed");
    res.status(500).json({ error: "Failed to delete blog post" });
  }
});

adminBlogRouter.get("/categories", async (_req, res) => {
  try {
    const { posts } = await listAllPosts({ limit: 500 });
    const set = new Set<string>(["BlueFox", "Pipeline", "Plans", "General"]);
    for (const post of posts) set.add(post.category);
    const published = await listPublishedCategories();
    for (const c of published) set.add(c);
    res.json({ categories: [...set].sort() });
  } catch (err) {
    logger.error({ err }, "GET /api/admin/blog/categories failed");
    res.status(500).json({ error: "Failed to load categories" });
  }
});

adminBlogRouter.post("/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }
    const fileBuffer =
      req.file.buffer || (req.file.path ? fs.readFileSync(req.file.path) : null);
    if (!fileBuffer) {
      return res.status(500).json({ error: "Failed to read uploaded file" });
    }
    const url = await uploadBlogImage(
      fileBuffer,
      req.file.originalname,
      req.file.mimetype,
      req.file.filename
    );
    if (req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
    }
    res.json({ success: true, url });
  } catch (err) {
    logger.error({ err }, "POST /api/admin/blog/upload-image failed");
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to upload image",
    });
  }
});
