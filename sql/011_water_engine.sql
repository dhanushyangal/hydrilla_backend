-- Water production tables. Additive. Does not alter Cloud job shape.
-- jobs remains the library row for wt_* (engine=water). sculpt_spec stays nullable; stop growing it.

CREATE TABLE IF NOT EXISTS public.water_projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  workspace_id  UUID REFERENCES public.workspaces (id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT 'Water',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id)
);

CREATE TABLE IF NOT EXISTS public.water_scenes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES public.water_projects (id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ir            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_water_scenes_project ON public.water_scenes (project_id);

CREATE TABLE IF NOT EXISTS public.water_assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES public.water_projects (id) ON DELETE CASCADE,
  job_id          TEXT NOT NULL REFERENCES public.jobs (id) ON DELETE CASCADE,
  quality_tier    TEXT NOT NULL CHECK (quality_tier IN ('fast', 'standard', 'studio')),
  pack            TEXT NOT NULL DEFAULT 'object-studio',
  spec            JSONB,
  factory_code    TEXT,
  glb_uri         TEXT,
  mesh_names      JSONB NOT NULL DEFAULT '[]'::jsonb,
  triangle_count  INTEGER,
  draw_calls      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_water_assets_project ON public.water_assets (project_id);

CREATE TABLE IF NOT EXISTS public.water_scene_nodes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id      UUID NOT NULL REFERENCES public.water_scenes (id) ON DELETE CASCADE,
  asset_id      UUID NOT NULL REFERENCES public.water_assets (id) ON DELETE CASCADE,
  parent_id     UUID REFERENCES public.water_scene_nodes (id) ON DELETE SET NULL,
  name          TEXT NOT NULL DEFAULT 'asset',
  position      JSONB NOT NULL DEFAULT '[0,0,0]'::jsonb,
  rotation      JSONB NOT NULL DEFAULT '[0,0,0]'::jsonb,
  scale         JSONB NOT NULL DEFAULT '[1,1,1]'::jsonb,
  material      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_water_scene_nodes_scene ON public.water_scene_nodes (scene_id);

CREATE TABLE IF NOT EXISTS public.water_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          TEXT NOT NULL REFERENCES public.jobs (id) ON DELETE CASCADE,
  scene_id        UUID REFERENCES public.water_scenes (id) ON DELETE SET NULL,
  run_id          TEXT NOT NULL,
  quality_tier    TEXT NOT NULL CHECK (quality_tier IN ('fast', 'standard', 'studio')),
  model_id        TEXT,
  duration_ms     INTEGER,
  token_input     INTEGER,
  token_output    INTEGER,
  token_total     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id)
);

CREATE INDEX IF NOT EXISTS idx_water_runs_job ON public.water_runs (job_id);

CREATE TABLE IF NOT EXISTS public.water_pass_reviews (
  id            BIGSERIAL PRIMARY KEY,
  run_uuid      UUID NOT NULL REFERENCES public.water_runs (id) ON DELETE CASCADE,
  pass_id       TEXT NOT NULL,
  action        TEXT NOT NULL,
  fidelity      REAL,
  summary       TEXT,
  refined       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_water_pass_reviews_run ON public.water_pass_reviews (run_uuid);

CREATE TABLE IF NOT EXISTS public.water_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        TEXT NOT NULL REFERENCES public.jobs (id) ON DELETE CASCADE,
  scene_id      UUID REFERENCES public.water_scenes (id) ON DELETE SET NULL,
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_water_messages_job ON public.water_messages (job_id, created_at);

CREATE TABLE IF NOT EXISTS public.water_scene_ops (
  id            BIGSERIAL PRIMARY KEY,
  scene_id      UUID NOT NULL REFERENCES public.water_scenes (id) ON DELETE CASCADE,
  node_id       UUID REFERENCES public.water_scene_nodes (id) ON DELETE SET NULL,
  op            TEXT NOT NULL CHECK (op IN ('move', 'rotate', 'scale', 'duplicate', 'delete')),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_water_scene_ops_scene ON public.water_scene_ops (scene_id, id);

CREATE INDEX IF NOT EXISTS idx_jobs_engine ON public.jobs (engine);
CREATE INDEX IF NOT EXISTS idx_water_assets_job ON public.water_assets (job_id);

ALTER TABLE public.water_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_scene_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_pass_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_scene_ops ENABLE ROW LEVEL SECURITY;
