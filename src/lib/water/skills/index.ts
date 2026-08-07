/**
 * Distilled skill prompt packs for Water Studio.
 * Sources: img2threejs pipeline spirit, cloudai-x threejs-* pass guidance,
 * AAA procedural checklists — compacted, no third-party trees vendored.
 */

import type { SkillPromptPack } from "../harness/types.js";
import type { WaterSkillId } from "../../waterSkills.js";

const OBJECT_STUDIO: SkillPromptPack = {
  id: "object-studio",
  plannerSystemExtra: `Domain: hard-surface / prop / product object (not a full scene).
- Prefer topologyClass hints: planar-panel, turned-solid, tube-run, fastener-cluster, soft-organic-accent.
- Enumerate a detailInventory of identity-defining details (bevels, fasteners, seams, gloss zones, wear).
- qualityContract.fidelityBar = "production" for standard/studio, "blockout" only for fast.
- featureReviewTargets: ≤5 critical systems (silhouette, primary volumes, hardware layout, finish zones).
- Never emit a single-root compound object. Decompose into real parts with parents.`,
  passExtras: {
    blockout:
      "Macro volumes only. Named meshes matching the spec. Map-stripped readability: forms must read without fancy materials.",
    structural:
      "Attach children correctly (no floating parts). Add seams, panel splits, thickness, pivots. Hierarchy must match parents.",
    form: "Refine silhouettes: bevels, fillets, lathe/extrude where topologyClass demands. Secondary forms support the role.",
    material:
      "MeshStandardMaterial / MeshPhysicalMaterial with purposeful roughness/metalness/clearcoat contrast. Independent PBR channels — never bake lighting into albedo.",
    surface:
      "Local wear, dirt, micro detail via CanvasTexture/DataTexture you generate — no external loaders. Tertiary detail at intended camera distance.",
    lighting:
      "Ensure materials respond under MeshStandardMaterial defaults. Optional subtle emissive accents. No scene lights required in the factory.",
    interaction:
      "Expose sculptRuntime.nodes and sockets. Named pivots OK for future use — keep everything static in createModel.",
    optimization:
      "Share geometries/materials where repeated. Keep under ~400 lines if possible. Clear disposal ownership on the root Group.",
  },
  evaluatorCriteria: [
    "Silhouette reads from a 3/4 gameplay camera",
    "Primary forms clear before material noise",
    "Named hierarchy matches the spec (≥60% component names present)",
    "No banned APIs (fetch/eval/loaders)",
    "Materials show purposeful PBR contrast (not one flat grey)",
    "root.userData.sculptRuntime exists; pose is static",
  ],
  strictSpecExtra: `Strict quality: for complexity moderate/complex require detailInventory length ≥ 4 / ≥ 8 and at least one repetition or localFeatures note when applicable.`,
};

const CHARACTER: SkillPromptPack = {
  id: "character",
  plannerSystemExtra: `Domain: character or creature (stylized reconstruction, not photoreal likeness).
- subjectClass should be "character" or "hybrid".
- Plan head-unit proportions, facial landmark groups (eyes, nose, mouth), limbs with clear pivots.
- qualityContract must list mustHaveDetails for face silhouette, limb proportions, outfit/palette.
- Prefer soft-organic topology for body; planar-panel for armor/clothing accents.`,
  passExtras: {
    blockout: "Body proportions first (head, torso, limbs). Readable silhouette in T or idle pose.",
    structural: "Limb hierarchy with shoulder/hip/elbow/knee pivots. Neck and head as separate nodes.",
    form: "Facial massing and clothing volumes. Avoid single-blob heads — use eye/nose/mouth groups.",
    material: "Separate materials for skin, hair/cloth, accents. Soft roughness for skin; fabric/metal as needed.",
    surface: "Simple freckle/wear accents optional via CanvasTexture. Keep stylized.",
    lighting: "Skin should not look plastic — roughness ≥ 0.45 unless intentionally glossy.",
    interaction: "Sockets: head, hand_L, hand_R, root. Static rest pose only — no time-based animation in createModel.",
    optimization: "Limit draw complexity; share materials across symmetric limbs.",
  },
  evaluatorCriteria: [
    "Readable humanoid/creature silhouette",
    "Limb hierarchy with named pivots",
    "Face has distinct feature groups (not one sphere)",
    "sculptRuntime sockets include head or root",
    "No banned APIs",
    "Materials differentiate skin vs cloth/armor",
    "Pose is static",
  ],
  strictSpecExtra: `Characters need ≥ 6 components including head and at least two limbs or appendages.`,
};

const ANIMATION: SkillPromptPack = {
  id: "animation",
  plannerSystemExtra: `Domain: animation-ready prop or character (static pose in preview).
- Spec animation.sockets must list every pivot that could move later.
- Prefer clear joint hierarchy for later Mixamo-style retarget (topology only — no auto-skin in v1).
- qualityContract.mustHaveDetails include named sockets and a clear static rest pose.
- createModel must not animate; preview is a frozen pose.`,
  passExtras: {
    blockout: "Hierarchy-first blockout with empty pivot Groups where joints will live. Static rest pose.",
    structural: "Joints as THREE.Group pivots; meshes as children. No skinned mesh required yet.",
    form: "Keep joint pivots at anatomically/mechanically sensible origins.",
    material: "Stable materials with clear part readability in a static pose.",
    surface: "Avoid heavy displacement that breaks silhouette.",
    lighting: "Keep shading readable under default Orbit view.",
    interaction:
      "Document sockets in sculptRuntime.sockets. Optionally stub AnimationClip-style tracks as comments or userData.clipHints. Do not animate in createModel.",
    optimization: "No per-frame animation work inside the factory.",
  },
  evaluatorCriteria: [
    "sculptRuntime.sockets is non-empty",
    "Pose is static (no time-based animation in createModel)",
    "Pivot Groups exist for future moving parts",
    "createModel contract holds",
    "No banned APIs",
  ],
  strictSpecExtra: `animation.sockets must include at least 2 named sockets.`,
};

const GAME: SkillPromptPack = {
  id: "game",
  plannerSystemExtra: `Domain: game-ready browser asset.
- Named selectable parts; plan collider proxies as box/sphere hints in notes.
- LOD: mark primary vs secondary detail in component notes (lod0 / lod1).
- Exporters (Unity/Unreal/Blender) are out of scope for codegen — only runtime hooks.`,
  passExtras: {
    blockout: "Readable silhouette from gameplay camera. Centered pivot at origin, resting on y=0.",
    structural: "Explodable named parts. Add userData.collider hints on major volumes (type+size).",
    form: "Secondary game-read detail (panels, trims) without noise.",
    material: "High-contrast PBR for readability at distance.",
    surface: "Decal-like accents via CanvasTexture if needed.",
    lighting: "Emissive only for gameplay callouts.",
    interaction:
      "sculptRuntime must include nodes, sockets, and colliders: { [name]: { type, size } }. Optional lodGroups: { lod0: string[], lod1: string[] }.",
    optimization: "Instance repeated bolts/panels. Keep triangle intent modest for browser.",
  },
  evaluatorCriteria: [
    "Named meshes for major parts",
    "sculptRuntime.colliders or collider userData present",
    "Origin-centered, y=0 ground",
    "Silhouette readable",
    "No banned APIs",
  ],
  strictSpecExtra: `At least one component note should mention collider or lod.`,
};

const PACKS: Record<WaterSkillId, SkillPromptPack> = {
  "object-studio": OBJECT_STUDIO,
  character: CHARACTER,
  animation: ANIMATION,
  game: GAME,
};

export function getSkillPromptPack(skillId: WaterSkillId): SkillPromptPack {
  return PACKS[skillId] || OBJECT_STUDIO;
}
