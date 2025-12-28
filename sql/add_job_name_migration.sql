-- ============================================
-- Migration: Add name column to jobs table
-- ============================================

-- Add name column to jobs table (nullable, can be set later)
ALTER TABLE jobs 
ADD COLUMN IF NOT EXISTS name TEXT;

-- Create index for faster searches by name
CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs (name) WHERE name IS NOT NULL;

-- Update existing jobs to use prompt as name if name is null
UPDATE jobs 
SET name = prompt 
WHERE name IS NULL AND prompt IS NOT NULL;

-- For jobs without prompts, set a default name
UPDATE jobs 
SET name = 'Untitled Generation'
WHERE name IS NULL;

-- ============================================
-- SUCCESS MESSAGE
-- ============================================
-- Migration completed successfully!
-- Added 'name' column to jobs table
-- Existing jobs have been updated with default names

