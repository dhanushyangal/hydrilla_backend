/**
 * One-time seed: migrate frontend/content/blog/*.md into blog_posts.
 * Run after applying sql/009_blog_posts.sql in Supabase.
 *
 *   cd backend && npx tsx scripts/seed-blog-posts.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

dotenv.config({ path: path.join(root, "backend/.env") });
dotenv.config({ path: path.join(root, "backend/.env.local"), override: true });

type Frontmatter = Record<string, string>;

function parseFrontmatter(raw: string): { data: Frontmatter; content: string } {
  const trimmed = raw.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    return { data: {}, content: trimmed.trim() };
  }
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) return { data: {}, content: trimmed.trim() };
  const fm = trimmed.slice(3, end).trim();
  const content = trimmed.slice(end + 4).replace(/^\s+/, "");
  const data: Frontmatter = {};
  for (const line of fm.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, content };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(text: string) {
  let html = escapeHtml(text);
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g,
    '<a href="$2">$1</a>'
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return html;
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let inList: "ul" | "ol" | null = null;

  const closeList = () => {
    if (inList) {
      out.push(inList === "ul" ? "</ul>" : "</ol>");
      inList = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      i += 1;
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    const ul = trimmed.match(/^[-*]\s+(.+)$/);
    if (ul) {
      if (inList !== "ul") {
        closeList();
        out.push("<ul>");
        inList = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      i += 1;
      continue;
    }
    const ol = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      if (inList !== "ol") {
        closeList();
        out.push("<ol>");
        inList = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      i += 1;
      continue;
    }
    closeList();
    const para: string[] = [trimmed];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("#") &&
      !lines[i].trim().startsWith("- ") &&
      !/^\d+\.\s+/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  closeList();
  return out.join("\n");
}

function clusterFor(slug: string, explicit?: string) {
  if (explicit) return explicit;
  if (
    slug.includes("unity") ||
    slug.includes("unreal") ||
    slug.includes("blender") ||
    slug.includes("export")
  ) {
    return "Pipeline";
  }
  if (slug.includes("pricing")) return "Plans";
  return "BlueFox";
}

/** Canonical metadata for the original 8 blog posts */
const SEED_POSTS: Array<{
  slug: string;
  title: string;
  headline: string;
  description: string;
  date: string;
  cluster?: string;
}> = [
  {
    slug: "how-bluefox-works",
    title: "How BlueFox works in Hydrilla",
    headline: "How does BlueFox 1 generate 3D?",
    description:
      "BlueFox 1, built by Hawan Research Labs and run in Hydrilla, turns a text prompt or reference image into a segmented mesh with PBR maps you can preview and export.",
    date: "2026-08-19",
    cluster: "BlueFox",
  },
  {
    slug: "text-to-3d",
    title: "Text to 3D in Hydrilla",
    headline: "How do I generate 3D from text?",
    description:
      "Write a prompt, run BlueFox 1 in Hydrilla, preview the mesh, then export GLB, FBX, OBJ, or USDZ into Unity, Unreal, or Blender.",
    date: "2026-08-19",
    cluster: "BlueFox",
  },
  {
    slug: "image-to-3d",
    title: "Image to 3D in Hydrilla",
    headline: "How do I generate 3D from an image?",
    description:
      "Drop a reference image into Hydrilla. BlueFox 1 builds a mesh that tracks silhouette and materials, then you export the same GLB, FBX, OBJ, or USDZ path.",
    date: "2026-08-19",
    cluster: "BlueFox",
  },
  {
    slug: "export-formats",
    title: "Hydrilla export formats",
    headline: "Which 3D formats does Hydrilla export?",
    description:
      "Hydrilla exports GLB, FBX, OBJ, and USDZ. GLB is on Free; all four formats are on Creator and Studio.",
    date: "2026-08-19",
    cluster: "Pipeline",
  },
  {
    slug: "hydrilla-for-unity",
    title: "Hydrilla for Unity",
    headline: "How do I use Hydrilla assets in Unity?",
    description:
      "Export FBX or GLB from Hydrilla, import into Unity, and check materials. Hydrilla is not a Unity plugin.",
    date: "2026-08-19",
    cluster: "Pipeline",
  },
  {
    slug: "hydrilla-for-unreal",
    title: "Hydrilla for Unreal",
    headline: "How do I use Hydrilla assets in Unreal?",
    description:
      "Export FBX (or GLB) from Hydrilla and import into Unreal. Hydrilla is not an Unreal plugin.",
    date: "2026-08-19",
    cluster: "Pipeline",
  },
  {
    slug: "hydrilla-for-blender",
    title: "Hydrilla for Blender",
    headline: "How do I use Hydrilla assets in Blender?",
    description:
      "Export GLB, FBX, or OBJ from Hydrilla and open the mesh in Blender. Hydrilla is not a Blender add-on.",
    date: "2026-08-19",
    cluster: "Pipeline",
  },
  {
    slug: "hydrilla-pricing-explained",
    title: "Hydrilla pricing explained",
    headline: "How do Hydrilla plans work?",
    description:
      "Free is $0 with 200 credits and GLB. Creator is $9/mo. Studio is $25/mo with seats and API. Yearly billing is 20% off.",
    date: "2026-08-19",
    cluster: "Plans",
  },
];

async function loadMarkdownBody(slug: string): Promise<string> {
  const localPath = path.join(root, "frontend/content/blog", `${slug}.md`);
  if (fs.existsSync(localPath)) {
    const raw = fs.readFileSync(localPath, "utf8");
    const { content } = parseFrontmatter(raw);
    return content;
  }

  const mirrorUrl = `https://hydrilla.ai/blog/${slug}.md`;
  console.log(`  Fetching body from ${mirrorUrl}`);
  const res = await fetch(mirrorUrl);
  if (!res.ok) throw new Error(`Failed to fetch ${mirrorUrl}: ${res.status}`);
  const md = await res.text();
  const lines = md.split("\n");
  const bodyStart = lines.findIndex((line, i) => i > 0 && line.trim() && !line.startsWith("#"));
  return bodyStart === -1 ? md : lines.slice(bodyStart).join("\n").trim();
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const blogDir = path.join(root, "frontend/content/blog");
  const localFiles = fs.existsSync(blogDir)
    ? fs.readdirSync(blogDir).filter((f) => f.endsWith(".md"))
    : [];

  const postsToSeed =
    localFiles.length > 0
      ? localFiles.map((file) => {
          const slug = file.replace(/\.md$/, "");
          const raw = fs.readFileSync(path.join(blogDir, file), "utf8");
          const { data, content } = parseFrontmatter(raw);
          return {
            slug,
            title: data.title || slug,
            headline: data.headline || data.title || slug,
            description: data.description || "",
            date: data.date || data.datePublished || "2026-08-19",
            cluster: data.cluster,
            markdown: content,
          };
        })
      : await Promise.all(
          SEED_POSTS.map(async (meta) => ({
            ...meta,
            markdown: await loadMarkdownBody(meta.slug),
          }))
        );

  console.log(`Seeding ${postsToSeed.length} blog posts`);

  for (const post of postsToSeed) {
    const slug = post.slug;
    const title = post.title;
    const headline = post.headline;
    const excerpt = post.description;
    const category = clusterFor(slug, post.cluster);
    const date = post.date;
    const publishedAt = new Date(date).toISOString();
    const html = markdownToHtml(post.markdown);

    const { data: existing } = await supabase
      .from("blog_posts")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    const row = {
      title,
      headline,
      slug,
      excerpt,
      content: html,
      cover_image: null,
      category,
      author: "Hydrilla",
      status: "published",
      published_at: publishedAt,
      seo_title: title,
      seo_description: excerpt,
      seo_image: null,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      const { error } = await supabase.from("blog_posts").update(row).eq("id", existing.id);
      if (error) {
        console.error(`Failed to update ${slug}:`, error.message);
      } else {
        console.log(`Updated: ${slug}`);
      }
    } else {
      const { error } = await supabase.from("blog_posts").insert({ ...row, created_at: publishedAt });
      if (error) {
        console.error(`Failed to insert ${slug}:`, error.message);
      } else {
        console.log(`Inserted: ${slug}`);
      }
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
