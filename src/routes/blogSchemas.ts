import { z } from "zod";

const slugSchema = z
  .string()
  .min(1, "Slug is required")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase letters, numbers, and hyphens");

export const blogPostBodySchema = z.object({
  title: z.string().min(1, "Title is required").max(300),
  headline: z.string().max(300).optional().nullable(),
  slug: slugSchema,
  excerpt: z.string().max(2000).default(""),
  content: z.string().default(""),
  coverImage: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v?.trim() ? v.trim() : null)),
  category: z.string().min(1, "Category is required").max(100),
  author: z.string().min(1, "Author is required").max(200),
  status: z.enum(["draft", "published"]),
  publishedAt: z.string().datetime().optional().nullable(),
  seoTitle: z.string().max(300).optional().nullable(),
  seoDescription: z.string().max(500).optional().nullable(),
  seoImage: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v?.trim() ? v.trim() : null)),
});

export type BlogPostBody = z.infer<typeof blogPostBodySchema>;

export function parseBlogPostBody(body: unknown) {
  return blogPostBodySchema.safeParse(body);
}

export function normalizeBlogPostInput(data: BlogPostBody) {
  const now = new Date().toISOString();
  let publishedAt = data.publishedAt ?? null;
  if (data.status === "published" && !publishedAt) {
    publishedAt = now;
  }
  if (data.status === "draft") {
    publishedAt = null;
  }

  if (data.status === "published") {
    if (!data.title.trim()) throw new Error("Title is required to publish");
    if (!data.excerpt.trim()) throw new Error("Excerpt is required to publish");
    if (!data.content.trim()) throw new Error("Content is required to publish");
  }

  return {
    title: data.title.trim(),
    headline: data.headline?.trim() || null,
    slug: data.slug.trim(),
    excerpt: data.excerpt.trim(),
    content: data.content,
    coverImage: data.coverImage ?? null,
    category: data.category.trim(),
    author: data.author.trim(),
    status: data.status,
    publishedAt,
    seoTitle: data.seoTitle?.trim() || null,
    seoDescription: data.seoDescription?.trim() || null,
    seoImage: data.seoImage ?? null,
  };
}
