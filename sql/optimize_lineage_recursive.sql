-- ============================================
-- Optimization: Recursive lineage query function
-- Replaces N+1 individual SELECTs with a single recursive CTE.
-- Returns the full DAG (all ancestors) for a given job in topological order.
-- ============================================

CREATE OR REPLACE FUNCTION get_job_lineage(target_job_id VARCHAR(64))
RETURNS TABLE (
  id              VARCHAR(64),
  user_id         TEXT,
  chat_id         UUID,
  workspace_id    UUID,
  parent_job_id   VARCHAR(64),
  status          VARCHAR(16),
  prompt          TEXT,
  image_url       TEXT,
  source_images   JSONB,
  generate_type   VARCHAR(32),
  face_count      INTEGER,
  enable_pbr      BOOLEAN,
  polygon_type    VARCHAR(16),
  result_glb_url  TEXT,
  preview_image_url TEXT,
  error_code      TEXT,
  error_message   TEXT,
  name            TEXT,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ,
  parent_job_ids  VARCHAR(64)[]
)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE ancestors AS (
    -- Non-recursive term: seed with the target job
    SELECT j.id AS job_id
    FROM jobs j
    WHERE j.id = target_job_id

    UNION

    -- Single recursive term: parents from job_parents OR jobs.parent_job_id (reference CTE once)
    SELECT p.parent_id AS job_id
    FROM (
      SELECT jp.job_id AS child_id, jp.parent_job_id AS parent_id FROM job_parents jp
      UNION ALL
      SELECT j.id AS child_id, j.parent_job_id AS parent_id FROM jobs j WHERE j.parent_job_id IS NOT NULL
    ) p
    JOIN ancestors a ON p.child_id = a.job_id
  ),
  -- Gather all parent IDs per job from junction table
  parents_agg AS (
    SELECT jp.job_id,
           ARRAY_AGG(jp.parent_job_id ORDER BY jp.slot) AS parent_ids
    FROM job_parents jp
    WHERE jp.job_id IN (SELECT job_id FROM ancestors)
    GROUP BY jp.job_id
  )
  SELECT
    j.id,
    j.user_id,
    j.chat_id,
    j.workspace_id,
    j.parent_job_id,
    j.status,
    j.prompt,
    j.image_url,
    j.source_images,
    j.generate_type,
    j.face_count,
    j.enable_pbr,
    j.polygon_type,
    j.result_glb_url,
    j.preview_image_url,
    j.error_code,
    j.error_message,
    j.name,
    j.created_at,
    j.updated_at,
    COALESCE(pa.parent_ids,
      CASE WHEN j.parent_job_id IS NOT NULL THEN ARRAY[j.parent_job_id] ELSE ARRAY[]::VARCHAR(64)[] END
    ) AS parent_job_ids
  FROM ancestors a
  JOIN jobs j ON j.id = a.job_id
  LEFT JOIN parents_agg pa ON pa.job_id = j.id
  ORDER BY j.created_at ASC;  -- Roots first (oldest), target last
$$;
