/**
 * `prompt.compile` — the contract layer in front of every Create job.
 *
 * This module holds the deterministic half: the refusal screen and CompiledPrompt
 * validation. The creative half (writing the t2i prompt, naming parts) is an LLM call the
 * caller supplies; this module validates whatever comes back, so a malformed or
 * out-of-scope compile can never reach a paid GPU stage.
 *
 * Spec: agent-skills/.../skills/cloud/cloud-compile-prompt/SKILL.md
 *       agent-skills/.../skills/water/water-compile-prompt/SKILL.md
 */

import type { CompiledPrompt, CreateEngine, FailCode } from "./contracts.js";
import {
  assetClassFromContract,
  parseProfile,
  type CreateAssetClass,
} from "./quality/thresholds.js";

/** The compiled contract lives in `contracts.ts` because it is persisted on the JobCard. */
export type { CompiledPrompt };

export type CompileRefusal = {
  ok: false;
  refuseReason: string;
  failCodes: FailCode[];
};

export type CompileSuccess = {
  ok: true;
  compiled: CompiledPrompt;
  /** Non-blocking observations for the caller to surface. */
  warnings: string[];
};

export type CompileResult = CompileSuccess | CompileRefusal;

/**
 * Create v1 is props and hard-surface only. Characters are refused on Cloud outright and
 * allowed on Water as stylized-only (DECISIONS_LOCKED D1/D2).
 *
 * This is a PRE-SCREEN, not a classifier. It never sets `assetClass` — doing that from
 * keywords is the exact mistake img2threejs removed, because a name token like "hero" or
 * "car" silently applied specialty floors. Class comes from the compile contract only.
 */
const CHARACTER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(human|humanoid|person|people|man|woman|boy|girl|child)\b/i, label: "a human figure" },
  { pattern: /\b(character|avatar|hero character|npc|villain)\b/i, label: "a character" },
  { pattern: /\b(face|portrait|head bust|bust of)\b/i, label: "a face as the core subject" },
  { pattern: /\b(hair|hairstyle|ponytail|braid)\b/i, label: "hair as the core subject" },
  { pattern: /\b(creature|monster|dragon|beast|animal|dog|cat|horse|bird)\b/i, label: "a creature" },
  { pattern: /\b(thor|spider-?man|batman|goku|anime girl|anime boy)\b/i, label: "a named character" },
];

const PROHIBITED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(nsfw|nude|naked|porn|explicit)\b/i, label: "prohibited content" },
  { pattern: /\b(gore|dismember|beheading)\b/i, label: "prohibited content" },
];

/** Requests that misunderstand what each engine delivers. */
const CLOUD_DELIVERABLE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /\b(three\.?js|threejs)\b.*\b(code|factory|script|scene)\b|\b(procedural|csg)\b.*\bcode\b/i,
    label: "Three.js factory code",
  },
];

export type ScreenResult =
  | { ok: true; warnings: string[] }
  | { ok: false; refuseReason: string; failCodes: FailCode[] };

/**
 * Screen raw user text before spending a compile call.
 *
 * Cloud refuses characters. Water permits them stylized-only, so the same text yields a
 * warning rather than a refusal there.
 */
export function screenSubject(params: {
  text: string;
  engine: CreateEngine;
}): ScreenResult {
  const text = params.text || "";
  const warnings: string[] = [];

  for (const rule of PROHIBITED_PATTERNS) {
    if (rule.pattern.test(text)) {
      return {
        ok: false,
        refuseReason: `Refused: ${rule.label}.`,
        failCodes: ["REFUSED_CLASS"],
      };
    }
  }

  for (const rule of CHARACTER_PATTERNS) {
    if (!rule.pattern.test(text)) continue;
    if (params.engine === "cloud") {
      return {
        ok: false,
        refuseReason:
          `Refused: this reads as ${rule.label}. Create v1 on Cloud covers props and hard-surface subjects only. ` +
          `Rephrase as a prop, or use Water for a stylized figure.`,
        failCodes: ["REFUSED_CLASS"],
      };
    }
    warnings.push(
      `Reads as ${rule.label}. Water permits stylized figures only — no photoreal likeness of a real person.`
    );
  }

  if (params.engine === "cloud") {
    for (const rule of CLOUD_DELIVERABLE_PATTERNS) {
      if (rule.pattern.test(text)) {
        return {
          ok: false,
          refuseReason:
            `Refused: Cloud delivers a mesh (GLB), not ${rule.label}. Switch the request to Water for procedural Three.js output.`,
          failCodes: ["CONTRACT"],
        };
      }
    }
  }

  return { ok: true, warnings };
}

/** Raw compiler output, before validation. Every field is untrusted. */
export type RawCompiledPrompt = Partial<{
  subject: unknown;
  parts: unknown;
  materials: unknown;
  scale_m: unknown;
  ground_contact: unknown;
  style_lock: unknown;
  asset_class: unknown;
  profile: unknown;
  t2i_prompt: unknown;
  i2_3d_intent: Partial<{
    geo_brief: unknown;
    texture_brief: unknown;
    poly_budget_hint: unknown;
    needs_transparency: unknown;
    needs_thin_shell: unknown;
    needs_liquid_volume: unknown;
  }>;
}>;

/** Coerce an untrusted value into a list of non-empty strings. */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Scale sanity by class, so an obviously wrong scale_m is caught at compile rather than at the gate. */
const SCALE_SANITY: Record<CreateAssetClass, { min: number; max: number }> = {
  prop: { min: 0.05, max: 5 },
  "prop-hero": { min: 0.05, max: 5 },
  vehicle: { min: 0.5, max: 12 },
};

/**
 * Validate compiler output into a CompiledPrompt.
 *
 * Missing structure is a CONTRACT failure, not something to paper over with defaults —
 * every downstream gate depends on these fields being real.
 */
export function validateCompiledPrompt(params: {
  raw: RawCompiledPrompt;
  engine: CreateEngine;
  needsT2i: boolean;
}): CompileResult {
  const { raw } = params;
  const problems: string[] = [];
  const warnings: string[] = [];

  const subject = typeof raw.subject === "string" ? raw.subject.trim() : "";
  if (!subject) problems.push("`subject` is missing.");

  const parts = asStringArray(raw.parts);
  if (parts.length === 0) problems.push("`parts` must name at least one part.");

  const materials = asStringArray(raw.materials);
  if (materials.length === 0) problems.push("`materials` must name at least one material.");

  const assetClass = assetClassFromContract(
    typeof raw.asset_class === "string" ? raw.asset_class : null
  );
  if (typeof raw.asset_class !== "string") {
    warnings.push("`asset_class` was absent; defaulted to prop. Specialty floors will not apply.");
  }

  const profile = parseProfile(typeof raw.profile === "string" ? raw.profile : null);

  const scaleM = typeof raw.scale_m === "number" ? raw.scale_m : Number(raw.scale_m);
  if (!Number.isFinite(scaleM) || scaleM <= 0) {
    problems.push("`scale_m` must be a positive number in metres.");
  } else {
    const sanity = SCALE_SANITY[assetClass];
    if (scaleM < sanity.min || scaleM > sanity.max) {
      problems.push(
        `\`scale_m\` ${scaleM} m is outside the ${assetClass} envelope [${sanity.min}, ${sanity.max}] m — the mesh gate would reject any asset built to it.`
      );
    }
  }

  const styleLock = typeof raw.style_lock === "string" ? raw.style_lock.trim() : "";
  if (!styleLock) problems.push("`style_lock` is missing.");

  const intent = raw.i2_3d_intent ?? {};
  const geoBrief = typeof intent.geo_brief === "string" ? intent.geo_brief.trim() : "";
  const textureBrief = typeof intent.texture_brief === "string" ? intent.texture_brief.trim() : "";
  if (!geoBrief) problems.push("`i2_3d_intent.geo_brief` is missing.");
  // Geometry and texture briefs stay separate; merging them is how texture detail ends up
  // baked into silhouette expectations.
  if (!textureBrief) {
    warnings.push("`i2_3d_intent.texture_brief` is absent; the worker will use a neutral texture brief.");
  }

  const t2iPrompt = typeof raw.t2i_prompt === "string" ? raw.t2i_prompt.trim() : "";
  if (params.engine === "cloud" && params.needsT2i && !t2iPrompt) {
    problems.push("`t2i_prompt` is required when the route sets needs_t2i.");
  }

  if (problems.length > 0) {
    return {
      ok: false,
      refuseReason: `CompiledPrompt failed contract validation: ${problems.join(" ")}`,
      failCodes: ["CONTRACT"],
    };
  }

  const polyHint = Number(intent.poly_budget_hint);

  return {
    ok: true,
    warnings,
    compiled: {
      subject,
      parts,
      materials,
      scaleM,
      groundContact: raw.ground_contact !== false,
      styleLock,
      assetClass,
      profile,
      t2iPrompt: t2iPrompt || null,
      i2_3dIntent: {
        geoBrief,
        textureBrief: textureBrief || "Neutral studio materials; no baked lighting.",
        polyBudgetHint: Number.isFinite(polyHint) && polyHint > 0 ? Math.round(polyHint) : 20_000,
        needsTransparency: intent.needs_transparency === true,
        needsThinShell: intent.needs_thin_shell === true,
        needsLiquidVolume: intent.needs_liquid_volume === true,
      },
    },
  };
}
