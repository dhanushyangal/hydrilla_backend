/**
 * Code Sculpt pipeline — text (or optional reference image) → procedural Three.js factory.
 *
 * Workflow adapted from img2threejs (https://github.com/img2threejs/img2threejs):
 * deterministic code enforces the gates, the model only does the judgement work.
 *
 *   intake gate → assessment + spec → spec gate → blockout codegen → code gate → (one refine) → done
 *
 * Model calls: 2 on the happy path, 3 when the code gate rejects once.
 */

import { callLLM } from "./llmProviders.js";
import type { ApiKeyProvider } from "./userApiKeysCrypto.js";

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

export type PipelineResult = {
  factoryCode: string;
  spec: SculptSpec;
  pass: SculptPass;
  specGate: GateResult;
  codeGate: GateResult;
  refined: boolean;
};

export type GateResult = { ok: boolean; violations: string[] };

/** Minimum component depth per complexity tier — blocks single-blob specs. */
const MIN_COMPONENTS: Record<SculptSpec["complexity"], number> = {
  simple: 3,
  moderate: 6,
  complex: 10,
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

// ---------------------------------------------------------------------------
// Stage 2 — assessment + spec
// ---------------------------------------------------------------------------

const SPEC_SYSTEM = `You are a technical director planning a procedural Three.js reconstruction.

Return ONLY a JSON object (no prose, no markdown fences) with this shape:
{
  "name": string,
  "subjectClass": "object" | "character" | "hybrid" | "environment",
  "complexity": "simple" | "moderate" | "complex",
  "summary": string,
  "scale": { "unit": "m", "approxHeight": number },
  "materials": [{ "name": string, "color": "#rrggbb", "finish": "metal"|"plastic"|"glass"|"rubber"|"wood"|"fabric"|"emissive", "roughness": number, "metalness": number }],
  "components": [{ "name": string, "primitive": "box"|"sphere"|"cylinder"|"cone"|"torus"|"plane"|"lathe"|"extrude", "parent": string|null, "size": [number, number, number], "position": [number, number, number], "rotation": [number, number, number], "material": string, "notes": string }],
  "animation": { "idle": string, "sockets": [string] }
}

Rules:
- Decompose the subject into real parts. Never emit a single-component spec for a compound object.
- simple >= 3 components, moderate >= 6, complex >= 10.
- Every component.material must match a materials[].name.
- Positions/sizes in metres, Y up, object centred near the origin, resting on y = 0.
- Parent names must reference another component or be null for roots.`;

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] || text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found");
  return JSON.parse(raw.slice(start, end + 1));
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

/** Deterministic fallback so a weak free model can never dead-end the run. */
export function fallbackSpec(prompt: string): SculptSpec {
  const name = (prompt || "Object").split(/[.,\n]/)[0].trim().slice(0, 60) || "Object";
  return {
    name,
    subjectClass: "object",
    complexity: "simple",
    summary: prompt || name,
    scale: { unit: "m", approxHeight: 1 },
    materials: [
      { name: "body", color: "#8a8f98", finish: "metal", roughness: 0.4, metalness: 0.8 },
      { name: "accent", color: "#2b2f36", finish: "plastic", roughness: 0.7, metalness: 0 },
    ],
    components: [
      { name: "root", primitive: "box", parent: null, material: "body" },
      { name: "body", primitive: "box", parent: "root", material: "body" },
      { name: "detail", primitive: "cylinder", parent: "body", material: "accent" },
    ],
    animation: { idle: "slow yaw rotation", sockets: [] },
  };
}

export async function buildSculptSpec(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  prompt: string;
  imageUrl?: string | null;
}): Promise<{ spec: SculptSpec; gate: GateResult; usedFallback: boolean }> {
  const subject = params.imageUrl
    ? `Reference image attached. User note: ${params.prompt || "(none)"}`
    : `Subject described by the user: "${params.prompt}"`;

  const userText = `${subject}

Plan the procedural reconstruction. Return the JSON spec only.`;

  let spec: SculptSpec | null = null;
  try {
    const text = await callLLM({
      provider: params.provider,
      modelId: params.modelId,
      apiKey: params.apiKey,
      system: SPEC_SYSTEM,
      userText,
      imageUrl: params.imageUrl,
      maxTokens: 4096,
    });
    spec = extractJson(text) as SculptSpec;
  } catch {
    spec = null;
  }

  if (!spec) {
    const fb = fallbackSpec(params.prompt);
    return { spec: fb, gate: validateSculptSpec(fb), usedFallback: true };
  }

  let gate = validateSculptSpec(spec);
  if (gate.ok) return { spec, gate, usedFallback: false };

  // One bounded repair pass. The model gets deterministic violations instead
  // of being asked to vaguely "improve" the spec.
  try {
    const repairedText = await callLLM({
      provider: params.provider,
      modelId: params.modelId,
      apiKey: params.apiKey,
      system: SPEC_SYSTEM,
      userText: `The following spec failed validation:
${JSON.stringify(spec, null, 2)}

Fix every violation and return the complete JSON spec only:
- ${gate.violations.join("\n- ")}`,
      imageUrl: params.imageUrl,
      maxTokens: 4096,
    });
    const repaired = extractJson(repairedText) as SculptSpec;
    const repairedGate = validateSculptSpec(repaired);
    if (repairedGate.ok) {
      return { spec: repaired, gate: repairedGate, usedFallback: false };
    }
  } catch {
    // Fall through to a deterministic valid scaffold.
  }

  const fb = fallbackSpec(params.prompt);
  gate = validateSculptSpec(fb);
  return { spec: fb, gate, usedFallback: true };
}

// ---------------------------------------------------------------------------
// Stage 3 — blockout codegen
// ---------------------------------------------------------------------------

const CODE_SYSTEM = `You are a senior Three.js engineer generating the BLOCKOUT pass of a procedural model.

Output contract (strict):
- Output ONLY TypeScript. No markdown fences, no prose, no explanation.
- Start with: import * as THREE from 'three';
- Export exactly one entry point: export function createModel(): THREE.Group
- Build every component from the spec using THREE primitives (THREE.BoxGeometry, THREE.SphereGeometry, THREE.CylinderGeometry, THREE.ConeGeometry, THREE.TorusGeometry, THREE.PlaneGeometry, THREE.LatheGeometry, THREE.ExtrudeGeometry) and THREE.MeshStandardMaterial / THREE.MeshPhysicalMaterial. Always qualify constructors with the THREE. prefix (never bare MeshStandardMaterial).
- Name every part: mesh.name = "<component name>", and group parts with THREE.Group so the hierarchy matches the spec parents.
- Expose runtime handles: root.userData.sculptRuntime = { nodes: { ... }, sockets: { ... } }.
- Add root.userData.tick = (dt: number, elapsed: number) => { ... } for a subtle idle motion.
- Model sits on y = 0, centred on X/Z, roughly the spec's approxHeight tall.
- No network access, no external textures, no loaders, no fetch, no eval, no dynamic import. CanvasTexture you build yourself is allowed.
- Keep it self-contained and under ~320 lines.`;

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

async function generateBlockout(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  spec: SculptSpec;
  prompt: string;
  imageUrl?: string | null;
  violations?: string[];
}): Promise<string> {
  const fixBlock = params.violations?.length
    ? `\n\nThe previous attempt was rejected by the build gate. Fix ALL of these and return the full corrected module:\n- ${params.violations.join(
        "\n- "
      )}`
    : "";

  const userText = `Subject: ${params.prompt || params.spec.name}

Spec (authoritative — build every component):
${JSON.stringify(params.spec, null, 2)}

Generate the blockout pass factory now. TypeScript only.${fixBlock}`;

  const text = await callLLM({
    provider: params.provider,
    modelId: params.modelId,
    apiKey: params.apiKey,
    system: CODE_SYSTEM,
    userText,
    imageUrl: params.imageUrl,
    maxTokens: 8192,
  });
  return extractCode(text);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runCodeSculptPipeline(params: {
  provider: ApiKeyProvider;
  modelId: string;
  apiKey: string;
  prompt: string;
  imageUrl?: string | null;
  onPass?: (pass: SculptPass) => void | Promise<void>;
}): Promise<PipelineResult> {
  const note = async (pass: SculptPass) => {
    try {
      await params.onPass?.(pass);
    } catch {
      // progress reporting must never fail the run
    }
  };

  await note("assessment");
  const { spec, gate: specGate } = await buildSculptSpec({
    provider: params.provider,
    modelId: params.modelId,
    apiKey: params.apiKey,
    prompt: params.prompt,
    imageUrl: params.imageUrl,
  });

  await note("spec");
  await note("blockout");
  let factoryCode = await generateBlockout({
    provider: params.provider,
    modelId: params.modelId,
    apiKey: params.apiKey,
    spec,
    prompt: params.prompt,
    imageUrl: params.imageUrl,
  });

  await note("review");
  let codeGate = validateFactoryCode(factoryCode, spec);
  let refined = false;

  if (!codeGate.ok) {
    refined = true;
    const retry = await generateBlockout({
      provider: params.provider,
      modelId: params.modelId,
      apiKey: params.apiKey,
      spec,
      prompt: params.prompt,
      imageUrl: params.imageUrl,
      violations: codeGate.violations,
    });
    const retryGate = validateFactoryCode(retry, spec);
    // Keep the better of the two attempts.
    if (retryGate.violations.length <= codeGate.violations.length) {
      factoryCode = retry;
      codeGate = retryGate;
    }
  }

  if (!codeGate.ok) {
    const blocking = codeGate.violations.filter(
      (v) => v.startsWith("Missing") || v.startsWith("Forbidden") || v.includes("too short")
    );
    if (blocking.length) {
      throw new Error(
        `Model could not produce a valid Three.js module: ${blocking.join(" ")} Try a stronger model.`
      );
    }
  }

  await note("done");
  return { factoryCode, spec, pass: "blockout", specGate, codeGate, refined };
}
