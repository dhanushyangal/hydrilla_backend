-- ============================================
-- Migration: Copy existing parent_job_id values into job_parents junction table
-- This is a one-time migration to consolidate the two parent-tracking mechanisms.
-- After running this, the junction table is the single source of truth.
-- The parent_job_id column is kept for backward compatibility but will no longer
-- be the primary source — it becomes a denormalized cache.
-- ============================================

-- Copy any parent_job_id that doesn't already exist in job_parents
INSERT INTO job_parents (job_id, parent_job_id, slot)
SELECT id, parent_job_id, 1
FROM jobs
WHERE parent_job_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM job_parents jp
    WHERE jp.job_id = jobs.id
      AND jp.parent_job_id = jobs.parent_job_id
  )
ON CONFLICT (job_id, parent_job_id) DO NOTHING;

-- ============================================
-- VERIFICATION: Check counts match
-- ============================================
-- Run this after migration to verify:
--   SELECT
--     (SELECT COUNT(*) FROM jobs WHERE parent_job_id IS NOT NULL) AS jobs_with_parent,
--     (SELECT COUNT(DISTINCT job_id) FROM job_parents) AS jobs_in_junction;
-- Both numbers should be equal (or junction >= jobs_with_parent)
