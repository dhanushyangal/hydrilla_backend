-- ============================================
-- Cleanup: drop unused invite/approval system + dead job columns
-- Run in Supabase SQL Editor (or psql) against production/staging.
-- Safe to re-run (IF EXISTS).
--
-- IMPORTANT: Drop get_job_lineage BEFORE dropping columns it used to return.
-- PostgreSQL cannot change a function's return type with CREATE OR REPLACE.
-- ============================================

-- 0) Drop lineage function first (old OUT columns: face_count, enable_pbr, polygon_type, name)
DROP FUNCTION IF EXISTS public.get_job_lineage(character varying);
DROP FUNCTION IF EXISTS public.get_job_lineage(varchar);

-- 1) Invite / approval tables (remove allowlist gate)
DROP TABLE IF EXISTS public.approved_emails CASCADE;
DROP TABLE IF EXISTS public.invite_tokens CASCADE;

-- 2) Approval flag on users
DROP INDEX IF EXISTS public.idx_users_is_approved;
ALTER TABLE public.users DROP COLUMN IF EXISTS is_approved;

-- 3) Unused jobs columns
ALTER TABLE public.jobs DROP COLUMN IF EXISTS face_count;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS polygon_type;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS name;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS comparison_sheet_url;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS enable_pbr;

DROP INDEX IF EXISTS public.idx_jobs_name;
DROP INDEX IF EXISTS public.idx_jobs_face_count;

-- 4) Unused subscription / webhook columns
ALTER TABLE public.user_subscriptions DROP COLUMN IF EXISTS quantity;
ALTER TABLE public.webhook_events DROP COLUMN IF EXISTS processed_at;

-- 5) Recreate get_job_lineage without dropped columns
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
  result_glb_url  TEXT,
  preview_image_url TEXT,
  error_code      TEXT,
  error_message   TEXT,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ,
  parent_job_ids  VARCHAR(64)[]
)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE ancestors AS (
    SELECT j.id AS job_id
    FROM jobs j
    WHERE j.id = target_job_id

    UNION

    SELECT p.parent_id AS job_id
    FROM (
      SELECT jp.job_id AS child_id, jp.parent_job_id AS parent_id FROM job_parents jp
      UNION ALL
      SELECT j.id AS child_id, j.parent_job_id AS parent_id FROM jobs j WHERE j.parent_job_id IS NOT NULL
    ) p
    JOIN ancestors a ON p.child_id = a.job_id
  ),
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
    j.result_glb_url,
    j.preview_image_url,
    j.error_code,
    j.error_message,
    j.created_at,
    j.updated_at,
    COALESCE(pa.parent_ids,
      CASE WHEN j.parent_job_id IS NOT NULL THEN ARRAY[j.parent_job_id] ELSE ARRAY[]::VARCHAR(64)[] END
    ) AS parent_job_ids
  FROM ancestors a
  JOIN jobs j ON j.id = a.job_id
  LEFT JOIN parents_agg pa ON pa.job_id = j.id
  ORDER BY j.created_at ASC;
$$;
