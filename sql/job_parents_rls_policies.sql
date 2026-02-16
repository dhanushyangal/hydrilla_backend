-- ============================================
-- RLS POLICIES FOR job_parents
-- Run after add_job_parents_and_source_images.sql
-- Access is scoped by job ownership: user can only manage rows
-- where the child job (job_id) belongs to them.
-- ============================================

DO $$
BEGIN
  DROP POLICY IF EXISTS "Service role can do everything on job_parents" ON job_parents;
  DROP POLICY IF EXISTS "Users can read job_parents for their jobs" ON job_parents;
  DROP POLICY IF EXISTS "Users can insert job_parents for their jobs" ON job_parents;
  DROP POLICY IF EXISTS "Users can update job_parents for their jobs" ON job_parents;
  DROP POLICY IF EXISTS "Users can delete job_parents for their jobs" ON job_parents;
END
$$;

ALTER TABLE job_parents ENABLE ROW LEVEL SECURITY;

-- Policy: Service role bypasses RLS (for backend API)
CREATE POLICY "Service role can do everything on job_parents"
  ON job_parents FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Policy: Users can read rows where the child job belongs to them
CREATE POLICY "Users can read job_parents for their jobs"
  ON job_parents FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = job_parents.job_id
        AND j.user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

-- Policy: Users can insert rows when the child job belongs to them
CREATE POLICY "Users can insert job_parents for their jobs"
  ON job_parents FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = job_parents.job_id
        AND j.user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

-- Policy: Users can update rows when the child job belongs to them
CREATE POLICY "Users can update job_parents for their jobs"
  ON job_parents FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = job_parents.job_id
        AND j.user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = job_parents.job_id
        AND j.user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

-- Policy: Users can delete rows when the child job belongs to them
CREATE POLICY "Users can delete job_parents for their jobs"
  ON job_parents FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = job_parents.job_id
        AND j.user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

-- ============================================
-- Migration complete: job_parents RLS enabled
-- ============================================
