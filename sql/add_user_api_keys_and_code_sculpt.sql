-- ============================================
-- Migration: BYOK API keys + Code Sculpt job fields
-- Safe for existing Hydrilla Supabase (additive only)
-- Run in Supabase SQL Editor after review.
-- ============================================
-- Does NOT drop/alter existing mesh job columns.
-- Existing jobs keep working: engine defaults to 'trilles'.

-- --------------------------------------------
-- 1) user_api_keys (Mike-style encrypted BYOK)
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS user_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (
    provider IN ('anthropic', 'openai', 'gemini', 'openrouter')
  ),
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  last4 TEXT,
  status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (status IN ('unchecked', 'valid', 'invalid')),
  last_error TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_api_keys_user_id
  ON user_api_keys (user_id);

ALTER TABLE user_api_keys ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS "Service role can do everything on user_api_keys" ON user_api_keys;
  DROP POLICY IF EXISTS "Users can read their own api key metadata" ON user_api_keys;
END
$$;

-- Backend uses service_role; no client policies that expose ciphertext.
CREATE POLICY "Service role can do everything on user_api_keys"
  ON user_api_keys FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- --------------------------------------------
-- 2) user_model_prefs (optional defaults)
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS user_model_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_mesh_model TEXT DEFAULT 'trilles',
  default_code_model TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_model_prefs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS "Service role can do everything on user_model_prefs" ON user_model_prefs;
END
$$;

CREATE POLICY "Service role can do everything on user_model_prefs"
  ON user_model_prefs FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- --------------------------------------------
-- 3) jobs: engine + code sculpt artifacts
-- --------------------------------------------
-- Widen generate_type if still short (idempotent).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'jobs'
      AND column_name = 'generate_type'
      AND character_maximum_length IS NOT NULL
      AND character_maximum_length < 32
  ) THEN
    ALTER TABLE jobs ALTER COLUMN generate_type TYPE VARCHAR(32);
  END IF;
END
$$;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS engine TEXT DEFAULT 'trilles',
  ADD COLUMN IF NOT EXISTS result_kind TEXT DEFAULT 'glb',
  ADD COLUMN IF NOT EXISTS llm_model TEXT,
  ADD COLUMN IF NOT EXISTS llm_provider TEXT,
  ADD COLUMN IF NOT EXISTS factory_code TEXT,
  ADD COLUMN IF NOT EXISTS sculpt_spec JSONB,
  ADD COLUMN IF NOT EXISTS sculpt_pass TEXT,
  ADD COLUMN IF NOT EXISTS comparison_sheet_url TEXT;

-- Backfill only nulls — never overwrite existing values.
UPDATE jobs SET engine = 'trilles' WHERE engine IS NULL;
UPDATE jobs SET result_kind = 'glb' WHERE result_kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_engine ON jobs (engine);
CREATE INDEX IF NOT EXISTS idx_jobs_result_kind ON jobs (result_kind);

COMMENT ON COLUMN jobs.engine IS
  'Generation engine: trilles (Aggregator mesh) | hunyuan | water | code_sculpt (legacy Water). Null/trilles = Aggregator mesh.';
COMMENT ON COLUMN jobs.result_kind IS
  'glb for Aggregator mesh jobs; three_factory for Water TypeScript factories.';
COMMENT ON COLUMN jobs.factory_code IS
  'Generated Three.js factory source for Water jobs (text). Legacy engine id: code_sculpt.';

-- --------------------------------------------
-- DONE
-- Existing mesh workspaces/jobs unchanged.
-- ============================================
