/**
 * Create quality thresholds — the ONLY place these numbers live.
 *
 * Ported from the Grok orchestration pack (`docs/IMG2THREEJS_DELTA.md`, which folds
 * the img2threejs QUALITY_BAR defaults). Never duplicate a number in prose or in a
 * skill body — import from here.
 *
 * Two laws encoded below:
 *   1. Asset class comes from the compile contract, never from a filename or prompt
 *      keyword. See `assetClassFromContract`.
 *   2. Class profiles may only RAISE floors, never lower them. See `resolveFloors`.
 */

/** Routing / render profile. Chosen by `run.route`, recorded on the JobCard. */
export type CreateProfile = "draft" | "balanced" | "quality" | "game_ready";

/** Declared asset class. v1 is props / hard-surface only. */
export type CreateAssetClass = "prop" | "vehicle" | "prop-hero";

/** Reference admission (`image.rembg` → `cloud-preprocess-ref`). */
export const ADMISSION = {
  /** Foreground coverage as a fraction of frame. */
  minForegroundRatio: 0.05,
  maxForegroundRatio: 0.97,
  /** Shortest image side, pixels. */
  minShortSidePx: 64,
  /** Largest connected blob as a fraction of total foreground — rejects clutter. */
  minLargestBlobRatio: 0.6,
} as const;

/** Routing confidence floor (`run.route`). Below this, do not spend. */
export const ROUTE_CONFIDENCE_MIN = 0.82;

/** Deterministic geometry HARD gate (`mesh.post.gate`). No aesthetics here. */
export const MESH_POST = {
  /** Non-manifold edges tolerated. Zero. */
  maxNonManifoldEdges: 0,
  /** Self-intersection is always a HARD fail. */
  allowSelfIntersection: false,
  /** Triangle ceiling on the draft path; game_ready tiers come from `mesh.bake`. */
  maxTrianglesDraft: 50_000,
  /**
   * Silhouette area / bbox area across the turntable orbit. Below this the mesh has
   * collapsed even though it may still load.
   */
  minOrbitAreaRatio: 0.15,
} as const;

/** Turntable angles, in degrees. Exactly four captures — see EVIDENCE_MANIFEST.md. */
export const TURNTABLE_ANGLES = [0, 90, 180, 270] as const;

/** Tier1 geometric comparison vs the reference (`asset.score`, before any VLM). */
export const TIER1 = {
  /** Silhouette IoU. HARD floor. */
  minIou: 0.85,
  /** Fractional scale error. */
  maxScaleError: 0.08,
  /** Aspect-ratio error. */
  maxAspectError: 0.05,
  /**
   * Objectness rescue: a gen-vs-photo comparison may fail IoU for reasons that are not
   * geometry. Above this, route to probe + microscope patches instead of rejecting on
   * IoU alone. Never rescues past a geometry HARD fail.
   */
  reconObjMin: 0.48,
} as const;

/** Aesthetic scoring floors. Applied AFTER a geo HARD pass. */
export const SCORE = {
  /** Below this, stop — not worth refining. */
  continueMin: 0.7,
  /** Identity features: at most this many, each must clear `criticalFeatureMin`. */
  maxCriticalFeatures: 5,
  criticalFeatureMin: 0.8,
  /** Mean of non-critical features. */
  importantAvgMin: 0.65,
  /** VLM per-criterion floor, and max spread across samples before re-sampling. */
  vlmCriteriaMin: 0.8,
  vlmMaxSpread: 0.2,
} as const;

/** Per-profile fidelity floor for "quality complete". */
export const PROFILE_FIDELITY_FLOOR: Record<CreateProfile, number> = {
  draft: 0.7,
  balanced: 0.8,
  quality: 0.85,
  game_ready: 0.85,
};

/**
 * Class augmentation. Values here may only RAISE a profile floor — merging clamps
 * upward. A draft run never inherits hero floors without an explicit profile.
 */
export const CLASS_FLOOR_RAISE: Record<CreateAssetClass, Partial<FloorSet>> = {
  prop: {},
  vehicle: { fidelity: 0.85, criticalFeature: 0.8 },
  "prop-hero": { fidelity: 0.85, criticalFeature: 0.85 },
};

/** Refine controller caps (`*-refine-loop`). Counters live on the JobCard. */
export const REFINE = {
  maxPerStage: 3,
  maxTotal: 6,
  /** Score improvement below this counts as a plateau — stop. */
  minDelta: 0.02,
} as const;

export type FloorSet = {
  fidelity: number;
  criticalFeature: number;
  importantAvg: number;
  continueAt: number;
};

/**
 * Resolve the floors for a run. Class augmentation raises; it can never soften a
 * profile floor.
 */
export function resolveFloors(
  profile: CreateProfile,
  assetClass: CreateAssetClass
): FloorSet {
  const base: FloorSet = {
    fidelity: PROFILE_FIDELITY_FLOOR[profile],
    criticalFeature: SCORE.criticalFeatureMin,
    importantAvg: SCORE.importantAvgMin,
    continueAt: SCORE.continueMin,
  };
  const raise = CLASS_FLOOR_RAISE[assetClass] || {};
  return {
    fidelity: Math.max(base.fidelity, raise.fidelity ?? 0),
    criticalFeature: Math.max(base.criticalFeature, raise.criticalFeature ?? 0),
    importantAvg: Math.max(base.importantAvg, raise.importantAvg ?? 0),
    continueAt: Math.max(base.continueAt, raise.continueAt ?? 0),
  };
}

const PROFILES = new Set<CreateProfile>(["draft", "balanced", "quality", "game_ready"]);
const ASSET_CLASSES = new Set<CreateAssetClass>(["prop", "vehicle", "prop-hero"]);

export function parseProfile(value?: string | null): CreateProfile {
  return value && PROFILES.has(value as CreateProfile)
    ? (value as CreateProfile)
    : "balanced";
}

/**
 * Asset class must arrive from the compile contract. Filenames and prompt keywords are
 * NOT inputs — img2threejs removed keyword domain detection because name tokens
 * silently applied specialty floors.
 */
export function assetClassFromContract(declared?: string | null): CreateAssetClass {
  return declared && ASSET_CLASSES.has(declared as CreateAssetClass)
    ? (declared as CreateAssetClass)
    : "prop";
}
