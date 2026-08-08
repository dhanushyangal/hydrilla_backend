/**
 * Water Skills + quality tiers — mirror of frontend lib/waterSkills.ts.
 * Keep in sync when adding skills or pass unlocks.
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

export type WaterSkillStatus = "live" | "partial" | "stub";

export type WaterSkillDef = {
  id: WaterSkillId;
  label: string;
  shortLabel: string;
  description: string;
  status: WaterSkillStatus;
  badge?: string;
  roadmapTheme?: string;
};

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

export const WATER_SKILLS: WaterSkillDef[] = [
  {
    id: "object-studio",
    label: "Object Studio",
    shortLabel: "Object",
    description: "Hard-surface / prop reconstruction — full quality pipeline",
    status: "live",
  },
  {
    id: "character",
    label: "Character",
    shortLabel: "Character",
    description: "Anatomy-aware track — proportions, features, stylized likeness",
    status: "live",
    roadmapTheme: "v1.5 Character",
  },
  {
    id: "animation",
    label: "Animation Ready",
    shortLabel: "Anim",
    description: "Sockets, pivot hierarchy — static rest pose",
    status: "partial",
    badge: "Partial",
    roadmapTheme: "v1.8 Animation",
  },
  {
    id: "game",
    label: "Game Ready",
    shortLabel: "Game",
    description: "Named parts, colliders, LOD hooks — export GLB/GLTF/OBJ/STL from viewer",
    status: "partial",
    badge: "Partial",
    roadmapTheme: "v1.7 Game Pipeline",
  },
];

export const DEFAULT_WATER_SKILL: WaterSkillId = "object-studio";
export const DEFAULT_QUALITY_TIER: QualityTier = "fast";

const SKILL_IDS = new Set(WATER_SKILLS.map((s) => s.id));
const TIER_IDS = new Set(["fast", "standard", "studio"] as QualityTier[]);

export function parseWaterSkillId(value?: string | null): WaterSkillId {
  if (value && SKILL_IDS.has(value as WaterSkillId)) {
    return value as WaterSkillId;
  }
  return DEFAULT_WATER_SKILL;
}

export function parseQualityTier(value?: string | null): QualityTier {
  if (value && TIER_IDS.has(value as QualityTier)) return value as QualityTier;
  return DEFAULT_QUALITY_TIER;
}

export function passesForTier(tier: QualityTier): BuildPassId[] {
  return TIER_PASS_UNLOCK[tier] || TIER_PASS_UNLOCK.standard;
}

export function getWaterSkill(id: WaterSkillId): WaterSkillDef {
  return WATER_SKILLS.find((s) => s.id === id) || WATER_SKILLS[0]!;
}
