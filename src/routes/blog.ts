import { Router } from "express";
import { logger } from "../logger.js";
import {
  getPublishedBySlug,
  listContinuePosts,
  listPublishedCategories,
  listPublishedPosts,
  listPublishedSlugs,
  toPublicListPost,
  toPublicPost,
} from "../repository/blogPosts.js";

export const blogRouter = Router();

blogRouter.get("/posts", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 12;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const { posts, total } = await listPublishedPosts({ page, limit, category });
    res.json({
      posts: posts.map(toPublicListPost),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    logger.error({ err }, "GET /api/blog/posts failed");
    res.status(500).json({ error: "Failed to load blog posts" });
  }
});

blogRouter.get("/posts/:slug", async (req, res) => {
  try {
    const post = await getPublishedBySlug(String(req.params.slug || ""));
    if (!post) return res.status(404).json({ error: "Post not found" });
    res.json({ post: toPublicPost(post) });
  } catch (err) {
    logger.error({ err }, "GET /api/blog/posts/:slug failed");
    res.status(500).json({ error: "Failed to load blog post" });
  }
});

blogRouter.get("/categories", async (_req, res) => {
  try {
    const categories = await listPublishedCategories();
    res.json({ categories });
  } catch (err) {
    logger.error({ err }, "GET /api/blog/categories failed");
    res.status(500).json({ error: "Failed to load categories" });
  }
});

blogRouter.get("/continue", async (req, res) => {
  try {
    const exclude =
      typeof req.query.exclude === "string" && req.query.exclude.trim()
        ? req.query.exclude.trim()
        : undefined;
    const items = await listContinuePosts(exclude);
    res.json({ items });
  } catch (err) {
    logger.error({ err }, "GET /api/blog/continue failed");
    res.status(500).json({ error: "Failed to load continue links" });
  }
});

blogRouter.get("/slugs", async (_req, res) => {
  try {
    const slugs = await listPublishedSlugs();
    res.json({ slugs });
  } catch (err) {
    logger.error({ err }, "GET /api/blog/slugs failed");
    res.status(500).json({ error: "Failed to load slugs" });
  }
});
