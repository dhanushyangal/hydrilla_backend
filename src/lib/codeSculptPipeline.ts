/**
 * Water factory helpers — intake, spec/code gates, fallback spec, factory rewrite.
 * Generate lives in lib/water/generateWaterAsset.ts (runStudioPipeline).
 */

import type { LlmTokenUsage } from "./llmProviders.js";

export type SculptPass =
  | "intake"
  | "assessment"
  | "spec"
  | "blockout"
  | "review"
  | "done";

export type SculptComponent = {
  name: string;
  primitive: string;
  parent?: string | null;
  size?: number[];
  position?: number[];
  rotation?: number[];
  material?: string;
  notes?: string;
  /** img2threejs: pick topology before the primitive (organic ≠ box). */
  topologyClass?: string;
};

export type SculptSpec = {
  name: string;
  subjectClass: "object" | "character" | "hybrid" | "environment";
  complexity: "simple" | "moderate" | "complex";
  summary: string;
  components: SculptComponent[];
  materials: Array<{ name: string; color?: string; finish?: string; roughness?: number; metalness?: number }>;
  animation?: { idle?: string; sockets?: string[] };
  scale?: { unit?: string; approxHeight?: number };
};

export type TokenPassBreakdown = {
  pass: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type PipelineResult = {
  factoryCode: string;
  spec: SculptSpec;
  pass: SculptPass;
  specGate: GateResult;
  codeGate: GateResult;
  refined: boolean;
  tokenUsage: LlmTokenUsage;
  tokenPasses: TokenPassBreakdown[];
};

export type GateResult = { ok: boolean; violations: string[] };

/** Minimum component depth per complexity tier — blocks single-blob specs. */
const MIN_COMPONENTS: Record<SculptSpec["complexity"], number> = {
  simple: 3,
  moderate: 4,
  complex: 6,
};

const BANNED_CODE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bfetch\s*\(/, why: "network fetch is not allowed" },
  { re: /XMLHttpRequest/, why: "network access is not allowed" },
  { re: /\beval\s*\(/, why: "eval is not allowed" },
  { re: /new\s+Function\s*\(/, why: "dynamic Function is not allowed" },
  { re: /import\s*\(/, why: "dynamic import is not allowed" },
  { re: /TextureLoader|GLTFLoader|FBXLoader|OBJLoader/, why: "external asset loaders are not allowed" },
  { re: /require\s*\(/, why: "CommonJS require is not allowed" },
];

// ---------------------------------------------------------------------------
// Stage 1 — intake gate (deterministic, no tokens)
// ---------------------------------------------------------------------------

export function intakeGate(params: { prompt?: string | null; imageUrl?: string | null }): GateResult {
  const violations: string[] = [];
  const prompt = (params.prompt || "").trim();
  const hasImage = Boolean(params.imageUrl);

  if (!prompt && !hasImage) {
    violations.push("Describe the object you want to build, e.g. \"a vintage folding camera\".");
    return { ok: false, violations };
  }
  if (!hasImage) {
    if (prompt.length < 3) {
      violations.push("Prompt is too short to describe a 3D subject.");
    }
    if (!/[a-z]{3}/i.test(prompt)) {
      violations.push("Prompt needs at least one descriptive word.");
    }
    if (prompt.length > 2000) {
      violations.push("Prompt is too long — keep it under 2000 characters.");
    }
  }
  return { ok: violations.length === 0, violations };
}

export function validateSculptSpec(spec: SculptSpec): GateResult {
  const violations: string[] = [];
  if (!spec || typeof spec !== "object") return { ok: false, violations: ["Spec is not an object"] };
  if (!spec.name) violations.push("Missing name");
  if (!Array.isArray(spec.components) || spec.components.length === 0) {
    violations.push("Missing components");
    return { ok: false, violations };
  }

  const complexity: SculptSpec["complexity"] =
    spec.complexity === "complex" || spec.complexity === "moderate" || spec.complexity === "simple"
      ? spec.complexity
      : "moderate";
  const min = MIN_COMPONENTS[complexity];
  if (spec.components.length < min) {
    violations.push(
      `Spec too shallow: ${spec.components.length} components for "${complexity}" (needs >= ${min}).`
    );
  }

  const names = new Set(spec.components.map((c) => c?.name).filter(Boolean));
  const materialNames = new Set((spec.materials || []).map((m) => m?.name).filter(Boolean));
  for (const c of spec.components) {
    if (!c?.name) violations.push("A component is missing a name");
    if (!c?.primitive) violations.push(`Component "${c?.name || "?"}" is missing a primitive`);
    if (c?.parent && !names.has(c.parent)) {
      violations.push(`Component "${c.name}" references unknown parent "${c.parent}"`);
    }
    if (c?.material && materialNames.size > 0 && !materialNames.has(c.material)) {
      violations.push(`Component "${c.name}" uses undeclared material "${c.material}"`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Deterministic fallback so a weak free model can never dead-end the run.
 *  Shape MUST follow the brief — never the same box + side-pipe for every subject. */
export function fallbackSpec(prompt: string, skillId?: string | null): SculptSpec {
  const name = (prompt || "Object").split(/[.,\n]/)[0].trim().slice(0, 60) || "Object";
  const t = `${prompt || ""} ${skillId || ""}`.toLowerCase();
  const isCharacter =
    skillId === "character" ||
    /\b(human|humanoid|person|character|avatar|npc|creature|girl|boy|man|woman|face|portrait)\b/i.test(
      t
    );
  const isBottle = /\b(bottle|flask|vase|jar|can|cup|mug|thermos)\b/i.test(t);

  if (isCharacter) {
    return {
      name,
      subjectClass: "character",
      complexity: "simple",
      summary: prompt || name,
      scale: { unit: "m", approxHeight: 1.7 },
      materials: [
        { name: "skin", color: "#c68642", finish: "skin", roughness: 0.65, metalness: 0.05 },
        { name: "cloth", color: "#1e3a8a", finish: "fabric", roughness: 0.7, metalness: 0.05 },
      ],
      components: [
        { name: "hips", primitive: "box", parent: null, material: "cloth", size: [0.28, 0.12, 0.18], position: [0, 0.95, 0], notes: "pelvis" },
        { name: "torso", primitive: "cylinder", parent: "hips", material: "cloth", size: [0.22, 0.55, 0.22], position: [0, 0.35, 0], notes: "chest volume" },
        { name: "head", primitive: "sphere", parent: "torso", material: "skin", size: [0.16, 0.16, 0.16], position: [0, 0.42, 0], notes: "head" },
        { name: "arm_L", primitive: "cylinder", parent: "torso", material: "cloth", size: [0.06, 0.45, 0.06], position: [0.28, 0.1, 0], notes: "left arm" },
        { name: "arm_R", primitive: "cylinder", parent: "torso", material: "cloth", size: [0.06, 0.45, 0.06], position: [-0.28, 0.1, 0], notes: "right arm" },
      ],
      animation: { idle: "static rest pose", sockets: ["head", "hand_L", "hand_R", "root"] },
    };
  }

  if (isBottle) {
    return {
      name,
      subjectClass: "object",
      complexity: "simple",
      summary: prompt || name,
      scale: { unit: "m", approxHeight: 0.28 },
      materials: [
        { name: "body", color: "#7eb8c9", finish: "plastic", roughness: 0.25, metalness: 0.05 },
        { name: "cap", color: "#1f2937", finish: "plastic", roughness: 0.5, metalness: 0.1 },
      ],
      components: [
        { name: "body", primitive: "cylinder", parent: null, material: "body", size: [0.07, 0.22, 0.07], position: [0, 0.11, 0], notes: "standing bottle volume on y=0" },
        { name: "neck", primitive: "cylinder", parent: "body", material: "body", size: [0.03, 0.04, 0.03], position: [0, 0.13, 0], notes: "neck, flush on top of body" },
        { name: "cap", primitive: "cylinder", parent: "neck", material: "cap", size: [0.035, 0.025, 0.035], position: [0, 0.032, 0], notes: "cap on neck" },
      ],
      animation: { idle: "static", sockets: [] },
    };
  }

  const isCamera = /\b(camera|camcorder|lens)\b/i.test(t);
  if (isCamera) {
    return {
      name,
      subjectClass: "object",
      complexity: "simple",
      summary: prompt || name,
      scale: { unit: "m", approxHeight: 0.1 },
      materials: [
        { name: "body", color: "#2b2f36", finish: "plastic", roughness: 0.55, metalness: 0.15 },
        { name: "lens", color: "#111827", finish: "metal", roughness: 0.25, metalness: 0.7 },
      ],
      components: [
        { name: "body", primitive: "box", parent: null, material: "body", size: [0.14, 0.09, 0.08], position: [0, 0.045, 0], notes: "camera body sitting on y=0" },
        { name: "lens", primitive: "cylinder", parent: "body", material: "lens", size: [0.035, 0.06, 0.035], position: [0, 0, 0.07], rotation: [1.57, 0, 0], notes: "lens barrel facing −Z" },
        { name: "viewfinder", primitive: "box", parent: "body", material: "body", size: [0.04, 0.03, 0.03], position: [0, 0.055, -0.02], notes: "prism / EVF on top" },
      ],
      animation: { idle: "static", sockets: [] },
    };
  }

  return {
    name,
    subjectClass: "object",
    complexity: "simple",
    summary: prompt || name,
    scale: { unit: "m", approxHeight: 0.3 },
    materials: [
      { name: "body", color: "#8a8f98", finish: "plastic", roughness: 0.5, metalness: 0.2 },
      { name: "accent", color: "#2b2f36", finish: "plastic", roughness: 0.7, metalness: 0 },
    ],
    components: [
      {
        name: "body",
        primitive: "box",
        parent: null,
        material: "body",
        size: [0.24, 0.18, 0.16],
        position: [0, 0.09, 0],
        notes: `main volume of ${name}, sits on y=0`,
      },
      {
        name: "top",
        primitive: "box",
        parent: "body",
        material: "accent",
        size: [0.16, 0.04, 0.12],
        position: [0, 0.11, 0],
        notes: "secondary mass on top of body",
      },
      {
        name: "detail",
        primitive: "cylinder",
        parent: "body",
        material: "accent",
        size: [0.03, 0.08, 0.03],
        position: [0, 0.02, 0.09],
        notes: "forward accent attached to the body",
      },
    ],
    animation: { idle: "static", sockets: [] },
  };
}


export function validateFactoryCode(code: string, spec: SculptSpec): GateResult {
  const violations: string[] = [];
  const src = (code || "").trim();

  if (src.length < 200) violations.push("Generated code is too short to be a real model.");
  if (!/export\s+function\s+createModel\s*\(/.test(src)) {
    violations.push("Missing `export function createModel(): THREE.Group`.");
  }
  if (!/import\s+\*\s+as\s+THREE\s+from\s+['"]three['"]/.test(src)) {
    violations.push("Missing `import * as THREE from 'three'`.");
  }
  if (!/new\s+THREE\.Group\s*\(/.test(src)) {
    violations.push("Model must return a THREE.Group root.");
  }
  // Catch the common LLM slip: bare MeshStandardMaterial instead of THREE.MeshStandardMaterial
  if (/\bnew\s+MeshStandardMaterial\s*\(/.test(src) && !/\bnew\s+THREE\.MeshStandardMaterial\s*\(/.test(src)) {
    violations.push("Use THREE.MeshStandardMaterial (not bare MeshStandardMaterial).");
  }
  if (/\bnew\s+MeshPhysicalMaterial\s*\(/.test(src) && !/\bnew\s+THREE\.MeshPhysicalMaterial\s*\(/.test(src)) {
    violations.push("Use THREE.MeshPhysicalMaterial (not bare MeshPhysicalMaterial).");
  }
  if (/```/.test(src)) violations.push("Code still contains markdown fences.");
  if (!/sculptRuntime/.test(src)) {
    violations.push("Missing root.userData.sculptRuntime = { nodes, sockets }.");
  }
  if (/userData\.tick\s*=/.test(src)) {
    violations.push("Forbidden API: userData.tick — factories must stay static.");
  }

  for (const { re, why } of BANNED_CODE_PATTERNS) {
    if (re.test(src)) violations.push(`Forbidden API: ${why}.`);
  }

  const opens = (src.match(/\{/g) || []).length;
  const closes = (src.match(/\}/g) || []).length;
  if (opens !== closes) violations.push("Unbalanced braces — the module looks truncated.");

  // Component coverage gate: the blockout must actually build the planned parts.
  const planned = (spec.components || []).map((c) => c.name).filter(Boolean);
  if (planned.length >= 3) {
    const missing = planned.filter((n) => !src.includes(n));
    const coverage = 1 - missing.length / planned.length;
    if (coverage < 0.6) {
      violations.push(
        `Only ${Math.round(coverage * 100)}% of planned components appear in the code. Missing: ${missing
          .slice(0, 8)
          .join(", ")}.`
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

export function extractCode(text: string): string {
  const fenced = text.match(/```(?:typescript|ts|javascript|js|tsx)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] || text).trim();
  // Strip stray leading prose before the first import/export statement.
  const firstImport = body.search(/^\s*(import|export|\/\*\*|\/\/)/m);
  let src = firstImport > 0 ? body.slice(firstImport).trim() : body;
  return rewriteBareThreeConstructors(src);
}

/**
 * LLMs often emit `new MeshStandardMaterial(...)` even when they imported `* as THREE`.
 * Rewrite common bare constructors to THREE.* so the sandbox ES module does not crash
 * on refresh / reopen.
 */
export function rewriteBareThreeConstructors(src: string): string {
  if (!src) return src;
  const names = [
    "MeshStandardMaterial",
    "MeshPhysicalMaterial",
    "MeshBasicMaterial",
    "MeshLambertMaterial",
    "MeshPhongMaterial",
    "MeshToonMaterial",
    "MeshNormalMaterial",
    "MeshDepthMaterial",
    "LineBasicMaterial",
    "PointsMaterial",
    "ShaderMaterial",
    "BoxGeometry",
    "SphereGeometry",
    "CylinderGeometry",
    "ConeGeometry",
    "TorusGeometry",
    "PlaneGeometry",
    "CircleGeometry",
    "RingGeometry",
    "CapsuleGeometry",
    "LatheGeometry",
    "ExtrudeGeometry",
    "TubeGeometry",
    "BufferGeometry",
    "Mesh",
    "Group",
    "Object3D",
    "Color",
    "Vector2",
    "Vector3",
    "Vector4",
    "Euler",
    "Quaternion",
    "Matrix4",
    "Box3",
    "CanvasTexture",
    "DataTexture",
    "Shape",
    "Path",
    "CatmullRomCurve3",
  ];
  let out = src;
  for (const name of names) {
    // Skip identifiers already qualified as THREE.Name or property access .Name
    out = out.replace(new RegExp(`(?<![.\\w$])${name}\\b`, "g"), (match, offset, whole) => {
      const before = whole.slice(Math.max(0, offset - 6), offset);
      if (before.endsWith("THREE.")) return match;
      // Don't rewrite inside import { Mesh, Group } from 'three'
      const lineStart = whole.lastIndexOf("\n", offset) + 1;
      const line = whole.slice(lineStart, offset + match.length + 40);
      if (/^\s*import\b/.test(line)) return match;
      return `THREE.${name}`;
    });
  }
  return out;
}
