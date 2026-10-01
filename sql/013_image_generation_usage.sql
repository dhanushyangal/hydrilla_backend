-- Token usage + provider cost (USD) per image generation request (OpenAI / Gemini).
-- One row per request, including failed ones (prompt-rewriter and blocked attempts still bill).
-- Safe / additive. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS image_generation_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  job_id VARCHAR(64),
  operation TEXT NOT NULL CHECK (operation IN ('text-to-image', 'edit')),
  provider TEXT NOT NULL,
  model TEXT,
  quality TEXT,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error_code TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  credits_charged INTEGER NOT NULL DEFAULT 0,
  calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_image_usage_user_created
  ON image_generation_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_usage_created
  ON image_generation_usage (created_at DESC);

ALTER TABLE image_generation_usage ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS "Service role can do everything on image_generation_usage" ON image_generation_usage;
END
$$;

CREATE POLICY "Service role can do everything on image_generation_usage"
  ON image_generation_usage FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Per-user totals for the admin panel. p_since NULL = all time.
CREATE OR REPLACE FUNCTION admin_image_usage_by_user(p_since TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE (
  user_id TEXT,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  generations BIGINT,
  failed BIGINT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  total_tokens BIGINT,
  cost_usd NUMERIC,
  credits_charged BIGINT,
  last_used_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    g.user_id,
    u.email,
    u.first_name,
    u.last_name,
    COUNT(*) FILTER (WHERE g.status = 'succeeded'),
    COUNT(*) FILTER (WHERE g.status = 'failed'),
    COALESCE(SUM(g.input_tokens), 0),
    COALESCE(SUM(g.output_tokens), 0),
    COALESCE(SUM(g.total_tokens), 0),
    COALESCE(SUM(g.cost_usd), 0),
    COALESCE(SUM(g.credits_charged) FILTER (WHERE g.status = 'succeeded'), 0),
    MAX(g.created_at)
  FROM image_generation_usage g
  LEFT JOIN users u ON u.id = g.user_id
  WHERE p_since IS NULL OR g.created_at >= p_since
  GROUP BY g.user_id, u.email, u.first_name, u.last_name
  ORDER BY COALESCE(SUM(g.cost_usd), 0) DESC;
$$;

-- Per provider/model totals for the admin panel.
CREATE OR REPLACE FUNCTION admin_image_usage_by_model(p_since TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE (
  provider TEXT,
  model TEXT,
  generations BIGINT,
  failed BIGINT,
  total_tokens BIGINT,
  cost_usd NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    g.provider,
    COALESCE(g.model, 'unknown'),
    COUNT(*) FILTER (WHERE g.status = 'succeeded'),
    COUNT(*) FILTER (WHERE g.status = 'failed'),
    COALESCE(SUM(g.total_tokens), 0),
    COALESCE(SUM(g.cost_usd), 0)
  FROM image_generation_usage g
  WHERE p_since IS NULL OR g.created_at >= p_since
  GROUP BY g.provider, COALESCE(g.model, 'unknown')
  ORDER BY COALESCE(SUM(g.cost_usd), 0) DESC;
$$;

REVOKE EXECUTE ON FUNCTION admin_image_usage_by_user(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION admin_image_usage_by_model(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_image_usage_by_user(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION admin_image_usage_by_model(TIMESTAMPTZ) TO service_role;
