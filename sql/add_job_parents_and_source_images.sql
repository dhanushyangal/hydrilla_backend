-- ============================================
-- Migration: Add job_parents junction table + source_images column
-- Enables multi-parent lineage tracking (e.g. combined edits from 2 images)
-- and stores the actual source image URLs used as input.
-- ============================================

-- 1. Junction table for N-parent relationships (scalable)
CREATE TABLE IF NOT EXISTS job_parents (
  job_id       VARCHAR(64) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  parent_job_id VARCHAR(64) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  slot         INT NOT NULL DEFAULT 1,   -- 1 = image1, 2 = image2, etc.
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, parent_job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_parents_job_id ON job_parents (job_id);
CREATE INDEX IF NOT EXISTS idx_job_parents_parent_job_id ON job_parents (parent_job_id);

-- 2. Store the actual source image URLs used as input (JSONB array)
--    e.g. ["https://...image1.png", "https://...image2.png"]
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_images JSONB DEFAULT NULL;
