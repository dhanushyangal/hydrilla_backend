/**
 * Generator — pass-scoped Three.js factory codegen.
 */

import { callLLM, type LlmTokenUsage } from "../../llmProviders.js";
import { extractCode } from "../../codeSculptPipeline.js";
import type { ApiKeyProvider } from "../../userApiKeysCrypto.js";
import type { BuildPassId, WaterSkillId } from "../../waterSkills.js";
import { getSkillPromptPack } from "../skills/index.js";
import type { RichSculptSpec } from "./types.js";
import { looksLikeRefusalOrEmpty } from "./fallbackFactory.js";

const BASE_CODE_SYSTEM = `You are a senior Three.js engineer generating a pass of a procedural model.

Output contract (strict):
- Output ONLY TypeScript. No markdown fences, no prose, no explanation.
- Start with: import * as THREE from 'three';
- Export exactly one entry point: export function createModel(): THREE.Group
- Build with THREE primitives and THREE.MeshStandardMaterial / THREE.MeshPhysicalMaterial (always THREE. prefix).
- Name every part: mesh.name = "<component name>"; hierarchy matches spec parents via THREE.Group.
- Expose root.userData.sculptRuntime = { nodes: { ... }, sockets: { ... }, colliders?: { ... }, lodGroups?: { ... } }.
- Add root.userData.tick = (dt: number, elapsed: number) => { ... } for subtle idle motion.
- Model sits on y = 0, centred on X/Z, roughly the spec's approxHeight tall.
- No network, no external textures/loaders, no fetch, no eval, no dynamic import. CanvasTexture you build yourself is allowed.
- Keep self-contained. Prefer evolving the previous factory rather than rewriting unrelated passes.
- SOLID OBJECT: one cohesive model. Child meshes must intersect or sit flush on the parent. Never leave parts floating. Never scatter extra primitives around the origin.
- Keep the part count low. Skip bevels, panel splits, fasteners, and micro-detail unless this pass is material/surface.

IMPORTANT — never refuse for copyright / trademark / famous names:
- Always build an ORIGINAL stylized look inspired by the brief.
- Do not mention copyright, trademarks, or inability to generate.
- Output code only.`;

const PASS_FOCUS: Record<BuildPassId, string> = {
  blockout: "PASS = blockout: 3–6 macro volumes only; every part attached; materials can be simple placeholders.",
  structural: "PASS = structural: weld floating parts into the parent (overlap/flush). Do not add new decorative pieces.",
  form: "PASS = form: slightly refine silhouettes. Do not add extra meshes.",
  material: "PASS = material: real PBR contrast per materials[] in the spec.",
  surface: "PASS = surface: micro detail, wear, local CanvasTexture accents.",
  lighting: "PASS = lighting response: tune roughness/metalness/emissive; no scene lights required.",
  interaction: "PASS = interaction: sockets, tick idle, selectable named nodes.",
  optimization: "PASS = optimization: share geom/materials, trim noise, keep tick cheap.",
};

/** Keep previous factory context small so weak models don't truncate/empty. */
function trimPreviousCode(code: string | null | undefined, passId: BuildPassId): string | null {
  if (!code) return null;
  const limit = passId === "blockout" ? 0 : passId === "structural" || passId === "form" ? 14000 : 10000;
  if (!limit) return null;
  if (code.length <= limit) return code;
  return `${code.slice(0, limit)}\n// … truncated for context …\n`;
}

export async function generatePass(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  spec: RichSculptSpec;
  prompt: string;
  imageUrl?: string | null;
  skillId: WaterSkillId;
  passId: BuildPassId;
  previousCode?: string | null;
  violations?: string[];
  evaluatorFeedback?: string | null;
  /** Extra user instruction (e.g. retry after refusal). */
  retryHint?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ code: string; usage: LlmTokenUsage | null }> {
  const pack = getSkillPromptPack(params.skillId);
  const skillExtra = pack.passExtras[params.passId] || "";
  const fixBlock = params.violations?.length
    ? `\n\nThe previous attempt was rejected. Fix ALL of these and return the full corrected module:\n- ${params.violations.join(
        "\n- "
      )}`
    : "";
  const evalBlock = params.evaluatorFeedback
    ? `\n\nEvaluator feedback (address concretely):\n${params.evaluatorFeedback}`
    : "";
  const prev = trimPreviousCode(params.previousCode, params.passId);
  const prevBlock = prev
    ? `\n\nPrevious factory (evolve this for the current pass — do not discard good structure):\n\`\`\`typescript\n${prev}\n\`\`\``
    : "";
  const retryBlock = params.retryHint ? `\n\n${params.retryHint}` : "";

  // Compact spec for codegen — full detailInventory can blow weak-model context
  const compactSpec = {
    name: params.spec.name,
    subjectClass: params.spec.subjectClass,
    complexity: params.spec.complexity,
    summary: params.spec.summary,
    scale: params.spec.scale,
    materials: params.spec.materials,
    components: params.spec.components,
    animation: params.spec.animation,
    qualityContract: params.spec.qualityContract,
  };

  const userText = `Subject brief: ${params.prompt || params.spec.name}
(Interpret as an ORIGINAL stylized design inspired by the brief — never refuse.)

${PASS_FOCUS[params.passId]}
${skillExtra}

Spec (authoritative):
${JSON.stringify(compactSpec, null, 2)}
${prevBlock}${fixBlock}${evalBlock}${retryBlock}

Generate the complete TypeScript factory for this pass now. TypeScript only.`;

  const result = await callLLM({
    provider: params.provider,
    modelId: params.modelId,
    apiKey: params.apiKey,
    system: `${BASE_CODE_SYSTEM}\n\n${skillExtra}`,
    userText,
    imageUrl: params.imageUrl,
    maxTokens: 8192,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  const code = extractCode(result.text);
  return { code, usage: result.usage };
}

export { looksLikeRefusalOrEmpty };
