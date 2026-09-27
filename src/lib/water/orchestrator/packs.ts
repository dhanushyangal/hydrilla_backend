/**
 * Water pack registry — the only place a new domain pack is wired.
 *
 * UI no longer picks Object / Character / Anim / Game. The Create orchestrator
 * binds a brief to a prompt pack here. Adding a pack:
 *   1. Add a prompt pack in `lib/water/skills/index.ts`
 *   2. Append a binding below (first match wins; keep the default last)
 *   3. Add the matching eve skill under `agent/agents/create-water/agent/skills/`
 * The HTTP route and workspace Create bar do not change.
 */

import type { CreateProfile } from "../../create/quality/thresholds.js";
import type { QualityTier, WaterSkillId } from "../../waterSkills.js";

export type WaterPackBinding = {
  id: WaterSkillId;
  /** First matching rule wins. */
  test: (prompt: string) => boolean;
  profile: CreateProfile | ((prompt: string) => CreateProfile);
};

export function inferProfileFromBrief(prompt: string): CreateProfile {
  const t = prompt.trim();
  if (/\b(quick|rough|blockout|draft)\b/i.test(t)) return "draft";
  if (/\b(hero|studio|production|high[- ]quality|film|cinematic|detailed)\b/i.test(t)) {
    return "quality";
  }
  return "balanced";
}

export function tierToProfile(tier: QualityTier, packProfile: CreateProfile): CreateProfile {
  if (tier === "fast") return "draft";
  if (tier === "studio") return packProfile === "game_ready" ? "game_ready" : "quality";
  return packProfile === "game_ready" ? "game_ready" : "balanced";
}

export const WATER_PACK_BINDINGS: WaterPackBinding[] = [
  {
    id: "game",
    test: (t) =>
      /\b(game[- ]ready|collider|unity|unreal|lod\b|exportable|meters?\b)\b/i.test(t),
    profile: "game_ready",
  },
  {
    id: "animation",
    test: (t) =>
      /\b(rig|socket|mixamo|joint|rest pose|animation[- ]ready|pivot hierarch)\b/i.test(t),
    profile: (t) => inferProfileFromBrief(t),
  },
  {
    id: "character",
    test: (t) =>
      /\b(human|humanoid|person|character|avatar|npc|creature|monster|hero|girl|boy|man|woman|face|portrait|anime)\b/i.test(
        t
      ),
    profile: (t) => inferProfileFromBrief(t),
  },
  {
    id: "object-studio",
    test: () => true,
    profile: (t) => inferProfileFromBrief(t),
  },
];

export function bindWaterPack(prompt: string): {
  skillId: WaterSkillId;
  profile: CreateProfile;
} {
  const text = prompt || "";
  for (const rule of WATER_PACK_BINDINGS) {
    if (!rule.test(text)) continue;
    const profile = typeof rule.profile === "function" ? rule.profile(text) : rule.profile;
    return { skillId: rule.id, profile };
  }
  return { skillId: "object-studio", profile: inferProfileFromBrief(text) };
}

export function profileToQualityTier(profile: CreateProfile): QualityTier {
  if (profile === "draft") return "fast";
  if (profile === "balanced") return "standard";
  return "studio";
}
