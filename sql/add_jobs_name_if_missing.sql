-- Fixes: get_job_lineage RPC error "column j.name does not exist" (PostgreSQL 42703).
-- Apply in Supabase SQL editor or psql against the same DB as the app.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS name TEXT;
