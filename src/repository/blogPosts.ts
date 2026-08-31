import { supabase } from "../db.js";
import { logger } from "../logger.js";
import type { BlogPostInput, BlogPostRecord, BlogPostStatus } from "../types.js";

type BlogPostRow = {
  id: string;
  title: string;
  headline: string | null;
  slug: string;
  excerpt: string;
  content: string;
  cover_image: string | null;
  category: string;
  author: string;
  status: BlogPostStatus;
  published_at: string | null;
  seo_title: string | null;
  seo_description: string | null;
  seo_image: string | null;
  created_at: string;
  updated_at: string;
};

function rowToRecord(row: BlogPostRow): BlogPostRecord {
  return {
    id: row.id,
    title: row.title,
    headline: row.headline,
    slug: row.slug,
    excerpt: row.excerpt,
    content: row.content,
    coverImage: row.cover_image,
    category: row.category,
    author: row.author,
    status: row.status,
    publishedAt: row.published_at,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    seoImage: row.seo_image,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function inputToRow(input: BlogPostInput, now: string) {
  return {
    title: input.title,
    headline: input.headline ?? null,
    slug: input.slug,
    excerpt: input.excerpt,
    content: input.content,
    cover_image: input.coverImage ?? null,
    category: input.category,
    author: input.author,
    status: input.status,
    published_at: input.publishedAt ?? null,
    seo_title: input.seoTitle ?? null,
    seo_description: input.seoDescription ?? null,
    seo_image: input.seoImage ?? null,
    updated_at: now,
  };
}

export type ListPublishedOptions = {
  page?: number;
  limit?: number;
  category?: string;
};

export type ListAllOptions = {
  page?: number;
  limit?: number;
  category?: string;
  status?: BlogPostStatus;
  search?: string;
};

export async function listPublishedPosts(
  opts: ListPublishedOptions = {}
): Promise<{ posts: BlogPostRecord[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 12));
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from("blog_posts")
    .select("*", { count: "exact" })
    .eq("status", "published")
    .order("published_at", { ascending: false, nullsFirst: false });

  if (opts.category) {
    query = query.eq("category", opts.category);
  }

  const { data, error, count } = await query.range(from, to);
  if (error) throw error;

  return {
    posts: (data as BlogPostRow[]).map(rowToRecord),
    total: count ?? 0,
  };
}

export async function getPublishedBySlug(slug: string): Promise<BlogPostRecord | null> {
  const { data, error } = await supabase
    .from("blog_posts")
    .select("*")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return rowToRecord(data as BlogPostRow);
}

export async function listPublishedSlugs(): Promise<Array<{ slug: string; updatedAt: string }>> {
  const { data, error } = await supabase
    .from("blog_posts")
    .select("slug, updated_at")
    .eq("status", "published")
    .order("published_at", { ascending: false });

  if (error) throw error;
  return (data || []).map((row) => ({
    slug: row.slug as string,
    updatedAt: row.updated_at as string,
  }));
}

export async function listPublishedCategories(): Promise<string[]> {
  const { data, error } = await supabase
    .from("blog_posts")
    .select("category")
    .eq("status", "published");

  if (error) throw error;
  const set = new Set<string>();
  for (const row of data || []) {
    if (row.category) set.add(row.category as string);
  }
  return [...set].sort();
}

export async function listAllPosts(
  opts: ListAllOptions = {}
): Promise<{ posts: BlogPostRecord[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from("blog_posts")
    .select("*", { count: "exact" })
    .order("updated_at", { ascending: false });

  if (opts.category) query = query.eq("category", opts.category);
  if (opts.status) query = query.eq("status", opts.status);
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`;
    query = query.or(`title.ilike.${term},slug.ilike.${term},excerpt.ilike.${term}`);
  }

  const { data, error, count } = await query.range(from, to);
  if (error) throw error;

  return {
    posts: (data as BlogPostRow[]).map(rowToRecord),
    total: count ?? 0,
  };
}

export async function getPostById(id: string): Promise<BlogPostRecord | null> {
  const { data, error } = await supabase.from("blog_posts").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return rowToRecord(data as BlogPostRow);
}

export async function isSlugTaken(slug: string, excludeId?: string): Promise<boolean> {
  let query = supabase.from("blog_posts").select("id").eq("slug", slug);
  if (excludeId) query = query.neq("id", excludeId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function createPost(input: BlogPostInput): Promise<BlogPostRecord> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("blog_posts")
    .insert({ ...inputToRow(input, now), created_at: now })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") throw new Error("DUPLICATE_SLUG");
    logger.error({ err: error }, "createPost failed");
    throw error;
  }
  return rowToRecord(data as BlogPostRow);
}

export async function updatePost(id: string, input: BlogPostInput): Promise<BlogPostRecord> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("blog_posts")
    .update(inputToRow(input, now))
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") throw new Error("DUPLICATE_SLUG");
    logger.error({ err: error }, "updatePost failed");
    throw error;
  }
  return rowToRecord(data as BlogPostRow);
}

export async function deletePost(id: string): Promise<void> {
  const { error } = await supabase.from("blog_posts").delete().eq("id", id);
  if (error) throw error;
}

export function toPublicPost(post: BlogPostRecord) {
  return {
    slug: post.slug,
    title: post.title,
    headline: post.headline || post.title,
    excerpt: post.excerpt,
    content: post.content,
    coverImage: post.coverImage,
    category: post.category,
    author: post.author,
    publishedAt: post.publishedAt,
    updatedAt: post.updatedAt,
    seoTitle: post.seoTitle,
    seoDescription: post.seoDescription,
    seoImage: post.seoImage,
  };
}

export function toAdminPost(post: BlogPostRecord) {
  return post;
}
