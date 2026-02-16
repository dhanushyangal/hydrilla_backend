-- ============================================
-- Migration: Add parent_job_id to jobs table
-- Enables iterative prompting lineage tracking
-- for both images and 3D models.
-- ============================================

-- Add parent_job_id column (self-referencing FK)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS parent_job_id VARCHAR(64) REFERENCES jobs(id);

-- Index for fast lookups by parent
CREATE INDEX IF NOT EXISTS idx_jobs_parent_job_id ON jobs (parent_job_id);
