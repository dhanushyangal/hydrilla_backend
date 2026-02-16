-- ============================================
-- Optimization: Widen generate_type + improve indexes
-- ============================================

-- 1. Widen generate_type from VARCHAR(16) to VARCHAR(32)
--    Prevents hitting the 16-char limit with future types
--    (e.g. "TextToImage", "ImageToVideo", "CombinedMulti")
ALTER TABLE jobs ALTER COLUMN generate_type TYPE VARCHAR(32);

-- 2. Drop the overly restrictive partial index
--    (only covered EditImage and Combined rows)
DROP INDEX IF EXISTS idx_jobs_user_generate_type;

-- 3. Create a full composite index on (user_id, generate_type)
--    This helps ALL workspace/library queries that filter by user
CREATE INDEX IF NOT EXISTS idx_jobs_user_id_generate_type
  ON jobs (user_id, generate_type);

-- 4. Add composite index for workspace job listing (very common query)
--    Covers: SELECT * FROM jobs WHERE workspace_id = X AND user_id = Y ORDER BY created_at
CREATE INDEX IF NOT EXISTS idx_jobs_workspace_user_created
  ON jobs (workspace_id, user_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;

-- 5. Add composite index for lineage lookups
--    The recursive CTE joins on job_parents + jobs frequently
CREATE INDEX IF NOT EXISTS idx_jobs_parent_created
  ON jobs (parent_job_id, created_at ASC)
  WHERE parent_job_id IS NOT NULL;
