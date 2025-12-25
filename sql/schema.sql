-- ============================================
-- Hydrilla 3D - Database Schema
-- With User Authentication and Row Level Security
-- ============================================

-- ============================================
-- USERS TABLE (synced from Clerk)
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,  -- Clerk user ID (e.g., user_2abc123)
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- ============================================
-- JOBS TABLE (with user ownership)
-- ============================================
CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(64) PRIMARY KEY,
  user_id TEXT REFERENCES users(id),  -- Owner of the job
  status VARCHAR(16) NOT NULL DEFAULT 'WAIT',
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
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

-- ============================================
-- ASSETS TABLE (for storing 3D models and images)
-- ============================================
CREATE TABLE IF NOT EXISTS assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id),
  job_id VARCHAR(64) REFERENCES jobs(id),
  type VARCHAR(16) NOT NULL,  -- 'model', 'image', 'preview'
  name TEXT,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  mime_type VARCHAR(64),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assets_user_id ON assets (user_id);
CREATE INDEX IF NOT EXISTS idx_assets_job_id ON assets (job_id);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets (type);

-- ============================================
-- FUNCTION: Update updated_at timestamp
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Drop existing policies (safe - checks if they exist)
-- ============================================
DO $$
BEGIN
  -- Drop users policies
  DROP POLICY IF EXISTS "Users can read their own data" ON users;
  DROP POLICY IF EXISTS "Users can update their own data" ON users;
  DROP POLICY IF EXISTS "Service role can manage all users" ON users;
  
  -- Drop jobs policies
  DROP POLICY IF EXISTS "Service role can do everything on jobs" ON jobs;
  DROP POLICY IF EXISTS "Authenticated users can read all jobs" ON jobs;
  DROP POLICY IF EXISTS "Authenticated users can insert jobs" ON jobs;
  DROP POLICY IF EXISTS "Authenticated users can update jobs" ON jobs;
  DROP POLICY IF EXISTS "Public can read jobs" ON jobs;
  DROP POLICY IF EXISTS "Users can read their own jobs" ON jobs;
  DROP POLICY IF EXISTS "Users can insert their own jobs" ON jobs;
  DROP POLICY IF EXISTS "Users can update their own jobs" ON jobs;
  DROP POLICY IF EXISTS "Users can delete their own jobs" ON jobs;
  
  -- Drop assets policies
  DROP POLICY IF EXISTS "Service role can do everything on assets" ON assets;
  DROP POLICY IF EXISTS "Users can read their own assets" ON assets;
  DROP POLICY IF EXISTS "Users can insert their own assets" ON assets;
  DROP POLICY IF EXISTS "Users can delete their own assets" ON assets;
END
$$;

-- ============================================
-- Enable Row Level Security
-- ============================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

-- ============================================
-- RLS POLICIES FOR USERS
-- ============================================

-- Users can read their own data
CREATE POLICY "Users can read their own data"
  ON users
  FOR SELECT
  USING (id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Users can update their own data
CREATE POLICY "Users can update their own data"
  ON users
  FOR UPDATE
  USING (id = current_setting('request.jwt.claims', true)::json->>'sub')
  WITH CHECK (id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Service role can do everything (for backend operations)
CREATE POLICY "Service role can manage all users"
  ON users
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================
-- RLS POLICIES FOR JOBS
-- ============================================

-- Policy: Service role bypasses RLS (for backend API)
CREATE POLICY "Service role can do everything on jobs"
  ON jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Policy: Users can read their own jobs
CREATE POLICY "Users can read their own jobs"
  ON jobs
  FOR SELECT
  USING (
    user_id IS NULL  -- Allow reading legacy jobs without user_id
    OR user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  );

-- Policy: Users can insert jobs for themselves
CREATE POLICY "Users can insert their own jobs"
  ON jobs
  FOR INSERT
  WITH CHECK (
    user_id IS NULL  -- Allow inserting jobs without user_id (legacy support)
    OR user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  );

-- Policy: Users can update their own jobs
CREATE POLICY "Users can update their own jobs"
  ON jobs
  FOR UPDATE
  USING (
    user_id IS NULL  -- Allow updating legacy jobs without user_id
    OR user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  )
  WITH CHECK (
    user_id IS NULL
    OR user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  );

-- Policy: Users can delete their own jobs
CREATE POLICY "Users can delete their own jobs"
  ON jobs
  FOR DELETE
  USING (
    user_id IS NULL
    OR user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  );

-- ============================================
-- RLS POLICIES FOR ASSETS
-- ============================================

CREATE POLICY "Service role can do everything on assets"
  ON assets
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can read their own assets"
  ON assets
  FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can insert their own assets"
  ON assets
  FOR INSERT
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can delete their own assets"
  ON assets
  FOR DELETE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- ============================================
-- TRIGGERS
-- ============================================
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_jobs_updated_at ON jobs;
CREATE TRIGGER update_jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- SUCCESS MESSAGE
-- ============================================
-- Schema created successfully!
-- Tables: users, jobs, assets
-- RLS policies applied for user-specific access
