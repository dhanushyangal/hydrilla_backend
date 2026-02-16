-- ============================================
-- Migration: Add Workspaces Table
-- ============================================
-- Workspaces group jobs into visual workspace sessions.
-- Each workspace has a name, and jobs can belong to a workspace.

-- ============================================
-- WORKSPACES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled Workspace',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces (user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_updated_at ON workspaces (updated_at DESC);

-- ============================================
-- ADD workspace_id COLUMN TO JOBS TABLE
-- ============================================
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_workspace_id ON jobs (workspace_id) WHERE workspace_id IS NOT NULL;

-- ============================================
-- RLS POLICIES FOR WORKSPACES
-- ============================================
DO $$
BEGIN
  DROP POLICY IF EXISTS "Service role can do everything on workspaces" ON workspaces;
  DROP POLICY IF EXISTS "Users can read their own workspaces" ON workspaces;
  DROP POLICY IF EXISTS "Users can insert their own workspaces" ON workspaces;
  DROP POLICY IF EXISTS "Users can update their own workspaces" ON workspaces;
  DROP POLICY IF EXISTS "Users can delete their own workspaces" ON workspaces;
END
$$;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can do everything on workspaces"
  ON workspaces FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users can read their own workspaces"
  ON workspaces FOR SELECT
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can insert their own workspaces"
  ON workspaces FOR INSERT
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can update their own workspaces"
  ON workspaces FOR UPDATE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub')
  WITH CHECK (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can delete their own workspaces"
  ON workspaces FOR DELETE
  USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- ============================================
-- TRIGGER: Update updated_at for workspaces
-- ============================================
DROP TRIGGER IF EXISTS update_workspaces_updated_at ON workspaces;
CREATE TRIGGER update_workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- MIGRATION COMPLETE
-- ============================================
-- Workspaces table created with RLS policies
-- Jobs table now has workspace_id column
-- All existing jobs will have workspace_id = NULL
