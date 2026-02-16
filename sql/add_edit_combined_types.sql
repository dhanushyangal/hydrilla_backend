-- ============================================
-- Migration: Support EditImage and Combined generate types
-- ============================================
-- The generate_type column is VARCHAR(16) so no ALTER needed.
-- "EditImage" (9 chars) and "Combined" (8 chars) both fit.
--
-- This migration just adds a composite index to speed up
-- queries filtering by user + generate_type (e.g. showing
-- only edited images or combined edits in the library).
-- ============================================

-- Index for filtering jobs by generate_type per user
CREATE INDEX IF NOT EXISTS idx_jobs_user_generate_type
  ON jobs (user_id, generate_type)
  WHERE generate_type IN ('EditImage', 'Combined');

-- ============================================
-- VERIFICATION: Check that the column can hold the new values
-- ============================================
-- Run this SELECT to verify after migration:
--   SELECT column_name, data_type, character_maximum_length
--   FROM information_schema.columns
--   WHERE table_name = 'jobs' AND column_name = 'generate_type';
--
-- Expected: varchar, 16 (both "EditImage" and "Combined" fit)
-- ============================================

-- ============================================
-- SUCCESS MESSAGE
-- ============================================
-- Migration completed successfully!
-- New generate_type values supported: "EditImage", "Combined"
-- No column changes required (VARCHAR(16) already sufficient)
