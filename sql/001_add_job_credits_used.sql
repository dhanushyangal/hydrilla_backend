-- Add credits_used to jobs table (credits consumed by this job)
-- Run in Supabase SQL Editor

ALTER TABLE jobs
ADD COLUMN IF NOT EXISTS credits_used integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN jobs.credits_used IS 'Number of credits consumed for this job (e.g. 10 for 3D, 0 for preview-only)';
