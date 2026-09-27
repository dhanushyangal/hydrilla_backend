-- Create harness session state: JobCard (total state) + EvidenceManifest captures.
-- Contracts: docs/contracts/JOB_CARD.md, docs/contracts/EVIDENCE_MANIFEST.md
--
-- These tables AUGMENT public.jobs; they do not replace it.
--   jobs        → user-facing status, credits, result URLs, lineage
--   job_cards   → stage machine, gate reports, fail codes, refine counters, next

CREATE TABLE IF NOT EXISTS public.job_cards (
  job_id       TEXT PRIMARY KEY REFERENCES public.jobs (id) ON DELETE CASCADE,
  -- Re-minted on generate, remesh, bake, and each refine iteration.
  run_id       TEXT NOT NULL,
  -- Immutable for the life of the job. No code path may update this.
  engine       TEXT NOT NULL CHECK (engine IN ('cloud', 'water')),
  -- Water only. Chosen inside Water; not an engine switch.
  water_mode   TEXT CHECK (water_mode IN ('threejs', 'mesh')),
  profile      TEXT NOT NULL CHECK (profile IN ('draft', 'balanced', 'quality', 'game_ready')),
  asset_class  TEXT NOT NULL CHECK (asset_class IN ('prop', 'vehicle', 'prop-hero')),
  next_stage   TEXT,
  -- CompiledPrompt from prompt.compile. Persisted so run.route, mesh.post.gate and
  -- asset.score read assetClass / scaleM back from the card instead of trusting a tool
  -- argument. The JobCard is total state.
  compiled     JSONB,
  -- The compiler's confidence. run.route gates on it and fails closed when NULL.
  compile_confidence REAL CHECK (compile_confidence IS NULL
                                 OR (compile_confidence >= 0 AND compile_confidence <= 1)),
  outcome      TEXT NOT NULL DEFAULT 'pending'
                 CHECK (outcome IN ('pending', 'promoted', 'rejected', 'partial', 'failed')),
  -- Caps from thresholds.ts: <=3 per stage, <=6 total.
  refine_total INTEGER NOT NULL DEFAULT 0 CHECK (refine_total >= 0 AND refine_total <= 6),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_cards_water_mode_only_for_water
    CHECK ((engine = 'water') OR (water_mode IS NULL))
);

CREATE TABLE IF NOT EXISTS public.job_card_stages (
  id           BIGSERIAL PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES public.job_cards (job_id) ON DELETE CASCADE,
  -- Canon skill id, e.g. 'cloud-mesh-post'.
  stage_id     TEXT NOT NULL,
  position     INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'done', 'skipped', 'failed')),
  -- Required when skipped; enforced below and in validateCheckpoint().
  skip_reason  TEXT,
  -- Deterministic codes only, never free text.
  fail_codes   JSONB NOT NULL DEFAULT '[]'::jsonb,
  artifacts    JSONB NOT NULL DEFAULT '[]'::jsonb,
  attempt      INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1 AND attempt <= 4),
  started_at   TIMESTAMPTZ,
  ended_at     TIMESTAMPTZ,
  UNIQUE (job_id, stage_id),
  CONSTRAINT job_card_stages_skip_needs_reason
    CHECK (status <> 'skipped' OR skip_reason IS NOT NULL),
  CONSTRAINT job_card_stages_fail_needs_code
    CHECK (status <> 'failed' OR jsonb_array_length(fail_codes) > 0)
);

CREATE INDEX IF NOT EXISTS idx_job_card_stages_job
  ON public.job_card_stages (job_id, position);

-- Evidence captures. Scoped to run_id: a capture from an earlier run is stale and
-- does not count toward promoteEligible.
CREATE TABLE IF NOT EXISTS public.evidence_captures (
  id         BIGSERIAL PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES public.job_cards (job_id) ON DELETE CASCADE,
  run_id     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN (
               'glb', 'gate_report', 'turntable', 'comparison_sheet',
               'admission_report', 'bake_report', 'score_report'
             )),
  uri        TEXT NOT NULL,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_captures_run
  ON public.evidence_captures (job_id, run_id, kind);

-- Exactly one comparison sheet per runId (img2threejs discipline).
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_one_sheet_per_run
  ON public.evidence_captures (job_id, run_id)
  WHERE kind = 'comparison_sheet';

-- Engine is immutable once written.
CREATE OR REPLACE FUNCTION public.job_cards_freeze_engine()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.engine <> OLD.engine THEN
    RAISE EXCEPTION 'job_cards.engine is immutable (% -> %)', OLD.engine, NEW.engine;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_job_cards_freeze_engine ON public.job_cards;
CREATE TRIGGER trg_job_cards_freeze_engine
  BEFORE UPDATE ON public.job_cards
  FOR EACH ROW EXECUTE FUNCTION public.job_cards_freeze_engine();
