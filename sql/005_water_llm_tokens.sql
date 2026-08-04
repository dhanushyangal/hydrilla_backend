-- Water LLM token columns on jobs (nullable; written by Water pipeline only)
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS llm_input_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS llm_output_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS llm_total_tokens INTEGER;

CREATE INDEX IF NOT EXISTS idx_jobs_user_water_tokens
  ON public.jobs (user_id, created_at DESC)
  WHERE engine IN ('water', 'code_sculpt') OR id LIKE 'wt_%' OR id LIKE 'cs_%';
