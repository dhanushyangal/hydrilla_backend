-- Blog posts for CMS-backed /blog
CREATE TABLE IF NOT EXISTS blog_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  headline        TEXT,
  slug            TEXT NOT NULL UNIQUE,
  excerpt         TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',
  cover_image     TEXT,
  category        TEXT NOT NULL DEFAULT 'General',
  author          TEXT NOT NULL DEFAULT 'Hydrilla',
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published')),
  published_at    TIMESTAMPTZ,
  seo_title       TEXT,
  seo_description TEXT,
  seo_image       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS blog_posts_slug_idx ON blog_posts (slug);
CREATE INDEX IF NOT EXISTS blog_posts_status_idx ON blog_posts (status);
CREATE INDEX IF NOT EXISTS blog_posts_published_at_idx ON blog_posts (published_at DESC);
CREATE INDEX IF NOT EXISTS blog_posts_category_idx ON blog_posts (category);
CREATE INDEX IF NOT EXISTS blog_posts_status_published_at_idx
  ON blog_posts (status, published_at DESC);
