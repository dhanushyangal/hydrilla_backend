-- Migration 018: Unified Usage & Source Tagging ('web' vs 'api')
-- Safe / additive. Run in Supabase SQL Editor.

-- 1. Add source column to jobs table ('web' for Web Studio, 'api' for Developer API)
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'web';

-- 2. Add source column to image_generation_usage table
ALTER TABLE image_generation_usage
  ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'web';

-- 3. Create helpful indexes for filtering by channel and date
CREATE INDEX IF NOT EXISTS idx_jobs_source_created_at
  ON jobs (source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_image_usage_source_created_at
  ON image_generation_usage (source, created_at DESC);

-- 4. Backfill historical API jobs from developer_api_key_usage logs
UPDATE jobs
SET source = 'api'
WHERE id IN (
  SELECT DISTINCT (details->>'taskId')
  FROM developer_api_key_usage
  WHERE details->>'taskId' IS NOT NULL AND details->>'taskId' != ''
);

UPDATE jobs
SET source = 'api'
WHERE id IN (
  SELECT DISTINCT (details->>'jobId')
  FROM developer_api_key_usage
  WHERE details->>'jobId' IS NOT NULL AND details->>'jobId' != ''
);

-- 5. Reload PostgREST schema cache so Supabase immediately recognizes the new column
NOTIFY pgrst, 'reload schema';
