/**
 * Source of truth for Water pack ids, quality tiers, and the passes each tier unlocks.
 * Packs are bound by the orchestrator (`lib/water/orchestrator/packs.ts`), never by the UI.
 * The frontend mirrors only `QualityTier`, `BuildPassId`, and `TIER_PASS_UNLOCK` for its
 * progress rail — update `lib/waterSkills.ts` in hyd-f when a tier or pass changes.
 */

export type WaterSkillId =
  | "object-studio"
  | "character"
  | "animation"
  | "game";

export type QualityTier = "fast" | "standard" | "studio";

export type BuildPassId =
  | "blockout"
  | "structural"
  | "form"
  | "material"
  | "surface"
  | "lighting"
  | "interaction"
  | "optimization";

export const BUILD_PASS_ORDER: BuildPassId[] = [
  "blockout",
  "structural",
  "form",
  "material",
  "surface",
  "lighting",
  "interaction",
  "optimization",
];

export const TIER_PASS_UNLOCK: Record<QualityTier, BuildPassId[]> = {
  fast: ["blockout"],
  standard: ["blockout", "structural", "form", "material"],
  studio: [...BUILD_PASS_ORDER],
};

export const DEFAULT_QUALITY_TIER: QualityTier = "standard";

export const WATER_SKILL_IDS = [
  "object-studio",
  "character",
  "animation",
  "game",
] as const;

const TIER_IDS = new Set(["fast", "standard", "studio"] as QualityTier[]);
const SKILL_IDS = new Set(WATER_SKILL_IDS as readonly string[]);

export function parseQualityTier(value?: string | null): QualityTier {
  if (value && TIER_IDS.has(value as QualityTier)) {
    return value as QualityTier;
  }
  return DEFAULT_QUALITY_TIER;
}

export function parseWaterSkillId(value?: string | null): WaterSkillId | null {
  if (value && SKILL_IDS.has(value)) {
    return value as WaterSkillId;
  }
  return null;
}

export function passesForTier(tier: QualityTier): BuildPassId[] {
  return TIER_PASS_UNLOCK[tier] || TIER_PASS_UNLOCK.standard;
}

