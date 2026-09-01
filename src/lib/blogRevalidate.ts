import { logger } from "../logger.js";

const BLOG_PATHS = ["/blog", "/blog/page/2", "/blog/page/3"];

export async function revalidateBlogFrontend(extraPaths: string[] = []): Promise<void> {
  const secret = process.env.BLOG_REVALIDATE_SECRET;
  const frontendUrl = (
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    ""
  ).replace(/\/+$/, "");

  if (!secret || !frontendUrl) {
    logger.debug("Blog revalidation skipped (missing BLOG_REVALIDATE_SECRET or FRONTEND_URL)");
    return;
  }

  const paths = [...new Set([...BLOG_PATHS, ...extraPaths])];

  try {
    const res = await fetch(`${frontendUrl}/api/revalidate/blog`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Blog revalidation request failed");
    }
  } catch (err) {
    logger.warn({ err }, "Blog revalidation request error");
  }
}

export function blogRevalidatePathsForPost(slug: string, category?: string): string[] {
  const paths = [`/blog/${slug}`, "/blog"];
  if (category) {
    const segment = category.toLowerCase().replace(/\s+/g, "-");
    paths.push(`/blog/category/${segment}`);
  }
  return paths;
}
