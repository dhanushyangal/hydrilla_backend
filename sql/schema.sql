CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(64) PRIMARY KEY,
  status VARCHAR(8) NOT NULL,
  prompt TEXT,
  image_url TEXT,
  generate_type VARCHAR(16) NOT NULL DEFAULT 'Normal',
  face_count INTEGER,
  enable_pbr BOOLEAN NOT NULL DEFAULT TRUE,
  polygon_type VARCHAR(16),
  result_glb_url TEXT,
  preview_image_url TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);

-- Enable Row Level Security (RLS) on the jobs table
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- Policy: Allow service_role to perform all operations (for backend API)
-- Service role bypasses RLS by default, but this makes it explicit
CREATE POLICY "Service role can do everything on jobs"
  ON jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Policy: Allow authenticated users to read their own jobs (if you add user_id later)
-- For now, this allows all authenticated users to read all jobs
-- You can modify this later to restrict by user_id if you add that column
CREATE POLICY "Authenticated users can read all jobs"
  ON jobs
  FOR SELECT
  TO authenticated
  USING (true);

-- Policy: Allow authenticated users to insert jobs
CREATE POLICY "Authenticated users can insert jobs"
  ON jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Policy: Allow authenticated users to update jobs
CREATE POLICY "Authenticated users can update jobs"
  ON jobs
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Policy: Allow public (anon) users to read jobs (for viewing/public library)
-- Remove this if you want to restrict to authenticated users only
CREATE POLICY "Public can read jobs"
  ON jobs
  FOR SELECT
  TO anon
  USING (true);

