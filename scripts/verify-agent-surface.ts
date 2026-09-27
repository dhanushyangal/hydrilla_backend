/**
 * Guards the seam between the eve agents, the Grok skill pack, and this backend.
 *
 * Three kinds of drift are cheap to introduce and expensive to find later:
 *   1. An eve tool file declaring a dotted id outside the frozen 12.
 *   2. An agent skill directory drifting from the canon ids, or reviving a retired alias.
 *   3. A Cloud agent gaining a Water skill (or vice versa), which the kill list forbids.
 *
 * This reads the actual files on disk rather than a list someone maintains by hand.
 *
 *   npm run verify:agents
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { TOOL_IDS, isToolId } from "../src/lib/create/toolSurface.js";
import { CLOUD_STAGE_ORDER, WATER_STAGE_ORDER } from "../src/lib/create/contracts.js";
import { REQUEST_SCHEMAS } from "../src/routes/createTools.js";

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string) {
  if (condition) passed++;
  else failures.push(detail ? `${label} — ${detail}` : label);
}

/** The eve workspace root: it holds package.json, tsconfig.json and shared/. */
const AGENT_ROOT = join(import.meta.dirname, "..", "..", "..", "agent");

/**
 * eve resolves one root agent per app from the files under `<app>/agent/`, so in an
 * `agents/` workspace each agent's own files live at `agents/<name>/agent/`. Verified
 * against `eve info`, which reports Layout=nested for exactly this shape.
 */
function agentDirOf(name: string): string {
  return join(AGENT_ROOT, "agents", name, "agent");
}

/** Canon skill ids. Stage ids are a subset — these lists include the non-stage skills too. */
const CLOUD_SKILLS = [
  ...CLOUD_STAGE_ORDER,
  "cloud-run-job",
  "cloud-experiment",
].sort();

const WATER_SKILLS = [
  ...WATER_STAGE_ORDER,
  "water-t2i",
  "water-preprocess-ref",
  "water-bake",
  "water-run-job",
  "water-experiment",
].sort();

/** Aliases retired during canon cleanup. Reviving one silently breaks skill routing. */
const RETIRED_IDS = [
  "cloud-i2-3d",
  "cloud-mesh-post-gate",
  "cloud-game-ready-bake",
  "cloud-score-compare",
  "cloud-run-experiment",
  "water-mesh-post-gate",
  "water-game-ready-bake",
  "water-score-compare",
];

if (!existsSync(AGENT_ROOT)) {
  console.error(`agent/ not found at ${AGENT_ROOT} — skipping agent surface verification.`);
  process.exit(0);
}

for (const [agentDir, expectedSkills, ownPrefix, foreignPrefix] of [
  ["create-cloud", CLOUD_SKILLS, "cloud-", "water-"],
  ["create-water", WATER_SKILLS, "water-", "cloud-"],
] as const) {
  const base = agentDirOf(agentDir);
  check(`${agentDir}: directory exists`, existsSync(base));
  if (!existsSync(base)) continue;

  check(`${agentDir}: has instructions.md`, existsSync(join(base, "instructions.md")));
  check(`${agentDir}: has agent.ts`, existsSync(join(base, "agent.ts")));

  // --- Tools ---------------------------------------------------------------------
  const toolsDir = join(base, "tools");
  const toolFiles = existsSync(toolsDir)
    ? readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))
    : [];
  check(
    `${agentDir}: has exactly ${TOOL_IDS.length} tool files`,
    toolFiles.length === TOOL_IDS.length,
    `found ${toolFiles.length}`
  );

  const declaredIds: string[] = [];
  for (const file of toolFiles) {
    const source = readFileSync(join(toolsDir, file), "utf8");
    const match = /assertToolId\(\s*["']([^"']+)["']\s*\)/.exec(source);
    check(`${agentDir}/${file}: declares a dotted tool id`, match !== null);
    if (!match) continue;
    const id = match[1]!;
    declaredIds.push(id);
    check(`${agentDir}/${file}: "${id}" is on the frozen surface`, isToolId(id));
    // Filename must be the dotted id with dots as underscores.
    check(
      `${agentDir}/${file}: filename matches its id`,
      file === `${id.replace(/\./g, "_")}.ts`,
      `expected ${id.replace(/\./g, "_")}.ts`
    );
  }

  const missingTools = TOOL_IDS.filter((id) => !declaredIds.includes(id));
  check(`${agentDir}: covers every frozen tool id`, missingTools.length === 0, `missing ${missingTools.join(", ")}`);
  check(
    `${agentDir}: no duplicate tool ids`,
    new Set(declaredIds).size === declaredIds.length
  );

  // --- Skills --------------------------------------------------------------------
  const skillsDir = join(base, "skills");
  const skillFiles = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort()
    : [];

  check(
    `${agentDir}: skills match canon`,
    JSON.stringify(skillFiles) === JSON.stringify([...expectedSkills].sort()),
    `on disk [${skillFiles.join(", ")}]`
  );

  for (const skill of skillFiles) {
    check(`${agentDir}: "${skill}" belongs to this engine`, skill.startsWith(ownPrefix));
    check(`${agentDir}: "${skill}" is not a retired alias`, !RETIRED_IDS.includes(skill));
  }
  // The kill list requires that neither agent can discover the other's skills.
  check(
    `${agentDir}: cannot discover a ${foreignPrefix}* skill`,
    !skillFiles.some((s) => s.startsWith(foreignPrefix))
  );

  // Every skill needs frontmatter with a description, or eve cannot decide when to load it.
  for (const skill of skillFiles) {
    const source = readFileSync(join(skillsDir, `${skill}.md`), "utf8");
    check(`${agentDir}/${skill}.md: has frontmatter`, source.startsWith("---"));
    check(`${agentDir}/${skill}.md: frontmatter has a description`, /^description:/m.test(source));
  }

  // --- Cross-engine leakage in prose ------------------------------------------------
  const instructions = readFileSync(join(base, "instructions.md"), "utf8");
  if (agentDir === "create-water") {
    // Mentioning the Cloud generator is fine — required, even — but only to forbid it. Every
    // line naming it must also carry a negation, or the instruction reads as permission.
    const offending = instructions
      .split("\n")
      .filter((line) => /\b(pixal|bluefox|trellis)\b/i.test(line))
      .filter((line) => !/\b(never|not|no|forbidden|refuse|instead of|cannot)\b/i.test(line));
    check(
      "create-water/instructions.md: only ever names the Cloud generator to forbid it",
      offending.length === 0,
      offending.length ? `unnegated mention: "${offending[0]!.trim().slice(0, 90)}"` : undefined
    );
  }
  check(
    `${agentDir}/instructions.md: states the engine lock`,
    new RegExp(`engine\\s*[=:]\\s*${ownPrefix.replace("-", "")}`, "i").test(instructions) ||
      /immutable/i.test(instructions)
  );
}

// The shared client must be the only network egress.
{
  const shared = join(AGENT_ROOT, "shared", "runApi.ts");
  check("shared/runApi.ts exists", existsSync(shared));
  if (existsSync(shared)) {
    const source = readFileSync(shared, "utf8");
    check("shared/runApi.ts: posts to /api/create/tools/", source.includes("/api/create/tools/"));
    check("shared/runApi.ts: reads the bearer token from env", /HYDRILLA_RUN_API_TOKEN/.test(source));
  }

  for (const agentDir of ["create-cloud", "create-water"]) {
    const toolsDir = join(agentDirOf(agentDir), "tools");
    if (!existsSync(toolsDir)) continue;
    for (const file of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(toolsDir, file), "utf8");
      // A tool reaching a provider directly would bypass BYOK handling and the kill list.
      check(
        `${agentDir}/${file}: no direct fetch outside runApi`,
        !/\bfetch\s*\(/.test(source),
        "tools must funnel through callRunApi"
      );
      check(
        `${agentDir}/${file}: no provider SDK import`,
        !/@ai-sdk|openai|anthropic|replicate|fal-ai/i.test(source)
      );
    }
  }
}

/**
 * The eve workspace layout.
 *
 * eve assembles ONE root agent per app from `<app>/agent/`, so two agents means an `agents/`
 * workspace and each agent's files sit at `agents/<name>/agent/`. The first version of this
 * scaffold put them at `agent/<name>/`, which typechecked fine and then failed with
 * "Invalid eve project: found no agent files". These checks make that a test failure.
 */
{
  for (const name of ["create-cloud", "create-water"]) {
    const dir = agentDirOf(name);
    for (const required of ["agent.ts", "instructions.md", "channels/eve.ts"]) {
      check(`layout: agents/${name}/agent/${required} exists`, existsSync(join(dir, ...required.split("/"))));
    }
    check(`layout: no stale agent/${name}/ directory`, !existsSync(join(AGENT_ROOT, name)));

    // A gateway model id string routes through AI Gateway, which the kill list bans. A
    // provider-authored LanguageModel calls the provider directly.
    const agentSource = readFileSync(join(dir, "agent.ts"), "utf8");
    check(
      `layout: agents/${name} uses a direct provider model, not a gateway id`,
      /model:\s*anthropic\(/.test(agentSource) && !/model:\s*["']\w+\//.test(agentSource),
      "a bare \"provider/model-id\" string routes through AI Gateway"
    );
  }

  // Shared code is imported through the package's `#shared/*` subpath, not a relative path
  // that climbs out of the agent root.
  for (const name of ["create-cloud", "create-water"]) {
    const toolsDir = join(agentDirOf(name), "tools");
    for (const file of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(toolsDir, file), "utf8");
      check(
        `layout: ${name}/tools/${file} imports shared via #shared/`,
        !/from "\.\.\/\.\.\//.test(source),
        "use #shared/runApi so the path survives a layout change"
      );
    }
  }
}

/**
 * The wire contract.
 *
 * The eve tools declare their payload in `agent/`, the router validates it in `src/routes/`,
 * and nothing forces the two to agree. This section posts exactly what each eve tool posts
 * and requires the backend schema to accept it. It caught `glbUri` vs `glbUrl` and a
 * `prompt.compile` that could never succeed because it never sent `compiled`.
 */
{
  const sample = {
    "prompt.compile": {
      jobId: "job_1",
      runId: "run_1",
      engine: "cloud",
      text: "a wooden crate",
      refImageUris: ["https://example.com/a.png"],
      profileHint: "balanced",
      declaredAssetClass: "prop",
      confidence: 0.9,
      compiled: {
        subject: "wooden crate",
        parts: ["body", "lid"],
        materials: ["wood"],
        scale_m: 0.6,
        ground_contact: true,
        style_lock: "weathered pine",
        asset_class: "prop",
        profile: "balanced",
        t2i_prompt: "studio product shot of a weathered pine crate",
        i2_3d_intent: {
          geo_brief: "boxy crate with plank seams",
          texture_brief: "worn pine grain",
          poly_budget_hint: 20000,
          needs_transparency: false,
          needs_thin_shell: false,
          needs_liquid_volume: false,
        },
      },
    },
    "run.route": {
      jobId: "job_1",
      runId: "run_1",
      engine: "cloud",
      assetClass: "prop",
      profileHint: "balanced",
      hasReferenceImage: true,
      estimatedCredits: 12,
    },
    "run.estimate": {
      jobId: "job_1",
      runId: "run_1",
      engine: "cloud",
      profile: "balanced",
      assetClass: "prop",
      needsT2i: false,
      hasReferenceImage: true,
    },
    "run.checkpoint": {
      jobId: "job_1",
      runId: "run_1",
      engine: "cloud",
      stageId: "cloud-mesh-post",
      status: "done",
      artifacts: ["s3://gate_report.json"],
      next: "cloud-evaluate",
      attempt: 1,
    },
    "mesh.post.gate": {
      jobId: "job_1",
      runId: "run_1",
      engine: "cloud",
      glbUri: "https://example.com/a.glb",
      assetClass: "prop",
      profile: "balanced",
      scaleM: 0.6,
      groundContact: true,
    },
    "asset.score": {
      jobId: "job_1",
      runId: "run_1",
      engine: "cloud",
      glbUri: "https://example.com/a.glb",
      assetClass: "prop",
      profile: "balanced",
    },
    "image.rembg": {
      jobId: "job_1",
      runId: "run_1",
      engine: "cloud",
      imageUri: "https://example.com/a.png",
    },
    "job.submit": {
      jobId: "job_1",
      runId: "run_1",
      engine: "water",
      stageId: "water-generate-3d",
      kind: "text_to_3d",
      adapter: "water-threejs",
      profile: "balanced",
    },
    "job.await": {
      jobId: "job_1",
      runId: "run_1",
      stageId: "water-generate-3d",
      providerJobId: "wt_abc",
      timeoutMs: 60000,
      pollIntervalMs: 2000,
    },
  } as const;

  for (const [toolId, payload] of Object.entries(sample)) {
    const schema = REQUEST_SCHEMAS[toolId as keyof typeof REQUEST_SCHEMAS];
    const result = schema.safeParse(payload);
    check(
      `wire contract: backend accepts the agent payload for ${toolId}`,
      result.success,
      result.success ? undefined : JSON.stringify(result.error.issues.slice(0, 3))
    );
  }

  // Every live tool must appear above, or a payload could drift unchecked.
  const LIVE = Object.keys(REQUEST_SCHEMAS);
  for (const toolId of LIVE) {
    check(`wire contract: ${toolId} has a sample payload`, toolId in sample);
  }

  // prompt.compile is useless to an agent that cannot send the compiled fields.
  for (const agentDir of ["create-cloud", "create-water"]) {
    const source = readFileSync(join(agentDirOf(agentDir), "tools", "prompt_compile.ts"), "utf8");
    check(
      `${agentDir}/prompt_compile.ts sends compiled + confidence`,
      /compiled:/.test(source) && /confidence:/.test(source),
      "without these the backend can only ever return a CONTRACT error"
    );
  }
}

console.log(`\nagent surface verification: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("eve agent surface matches the frozen tool ids and canon skills\n");
