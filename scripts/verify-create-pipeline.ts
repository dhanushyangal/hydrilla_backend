/**
 * Verifies the decision layers: compile screening, routing, admission, scoring, and the
 * refine controller. Pure logic — no DB, no network, no GPU.
 *
 *   npm run verify:pipeline
 */

import { admitReference, unavailableRembg, type RembgAdapter } from "../src/lib/create/admission.js";
import { screenSubject, validateCompiledPrompt, type RawCompiledPrompt } from "../src/lib/create/compile.js";
import { createJobCard, type EvidenceManifest, type FailCode, type JobCard } from "../src/lib/create/contracts.js";
import { runMeshPostGate, type GateReport } from "../src/lib/create/mesh/gate.js";
import { encodePng } from "../src/lib/create/mesh/png.js";
import { renderViews } from "../src/lib/create/mesh/views.js";
import { estimateRun, planRoute } from "../src/lib/create/route.js";
import { decideRefine } from "../src/lib/create/refine.js";
import { scoreAsset, unavailableVlm, type VlmScorer } from "../src/lib/create/score.js";
import { buildGlb, makeBox, makePlane } from "./fixtures/glbFixtures.js";

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string) {
  if (condition) passed++;
  else failures.push(detail ? `${label} — ${detail}` : label);
}

// ---------------------------------------------------------------------------
// 1. Refusal screen
// ---------------------------------------------------------------------------
{
  const cloudCharacter = screenSubject({ text: "a heroic humanoid warrior with long hair", engine: "cloud" });
  check("screen: Cloud refuses a humanoid", !cloudCharacter.ok);
  check(
    "screen: refusal carries REFUSED_CLASS",
    !cloudCharacter.ok && cloudCharacter.failCodes.includes("REFUSED_CLASS")
  );

  const waterCharacter = screenSubject({ text: "a heroic humanoid warrior", engine: "water" });
  check("screen: Water permits a stylized figure", waterCharacter.ok);
  check(
    "screen: Water warns about likeness",
    waterCharacter.ok && waterCharacter.warnings.some((w) => /stylized/i.test(w))
  );

  check("screen: refuses NSFW on both engines", !screenSubject({ text: "nude figure", engine: "water" }).ok);
  check("screen: passes a prop", screenSubject({ text: "a weathered steel fuel canister", engine: "cloud" }).ok);
  check(
    "screen: Cloud refuses a Three.js factory request",
    !screenSubject({ text: "generate threejs code for a procedural scene", engine: "cloud" }).ok
  );
  check(
    "screen: a sedan is a prop request, not a character",
    screenSubject({ text: "a red sedan, four wheels, chrome grille", engine: "cloud" }).ok
  );
}

// ---------------------------------------------------------------------------
// 2. CompiledPrompt validation
// ---------------------------------------------------------------------------
const GOOD_RAW: RawCompiledPrompt = {
  subject: "steel fuel canister",
  parts: ["body", "cap", "handle"],
  materials: ["painted steel", "rubber"],
  scale_m: 0.35,
  ground_contact: true,
  style_lock: "industrial, weathered, neutral studio",
  asset_class: "prop",
  profile: "balanced",
  t2i_prompt: "single steel fuel canister, studio product shot, neutral grey background",
  i2_3d_intent: {
    geo_brief: "cylindrical body, recessed cap, welded handle",
    texture_brief: "matte painted steel with edge wear",
    poly_budget_hint: 18000,
    needs_transparency: false,
  },
};

{
  const result = validateCompiledPrompt({ raw: GOOD_RAW, engine: "cloud", needsT2i: true });
  check("compile: valid contract accepted", result.ok);
  if (result.ok) {
    check("compile: asset class from contract", result.compiled.assetClass === "prop");
    check("compile: scale preserved", result.compiled.scaleM === 0.35);
    check("compile: poly hint preserved", result.compiled.i2_3dIntent.polyBudgetHint === 18000);
  }

  const noSubject = validateCompiledPrompt({ raw: { ...GOOD_RAW, subject: "" }, engine: "cloud", needsT2i: true });
  check("compile: missing subject rejected", !noSubject.ok);
  check("compile: rejection is a CONTRACT fail", !noSubject.ok && noSubject.failCodes.includes("CONTRACT"));

  const badScale = validateCompiledPrompt({ raw: { ...GOOD_RAW, scale_m: 40 }, engine: "cloud", needsT2i: true });
  check("compile: 40m prop rejected at compile, before any spend", !badScale.ok);

  const noT2i = validateCompiledPrompt({ raw: { ...GOOD_RAW, t2i_prompt: "" }, engine: "cloud", needsT2i: true });
  check("compile: missing t2i prompt rejected when needs_t2i", !noT2i.ok);
  const waterNoT2i = validateCompiledPrompt({ raw: { ...GOOD_RAW, t2i_prompt: "" }, engine: "water", needsT2i: false });
  check("compile: Water does not require a t2i prompt", waterNoT2i.ok);

  // A vehicle declared at 6m is legal; the same 6m as a prop is not.
  const vehicle = validateCompiledPrompt({
    raw: { ...GOOD_RAW, asset_class: "vehicle", scale_m: 4.6 },
    engine: "cloud",
    needsT2i: true,
  });
  check("compile: 4.6m vehicle accepted", vehicle.ok);
  const propAt4600 = validateCompiledPrompt({
    raw: { ...GOOD_RAW, asset_class: "prop", scale_m: 6 },
    engine: "cloud",
    needsT2i: true,
  });
  check("compile: 6m prop rejected", !propAt4600.ok);

  // An absent class must NOT be guessed from the subject text.
  const noClass = validateCompiledPrompt({
    raw: { ...GOOD_RAW, subject: "sports car hero vehicle", asset_class: undefined },
    engine: "cloud",
    needsT2i: true,
  });
  check(
    "compile: absent class defaults to prop, never inferred from the subject text",
    noClass.ok && noClass.compiled.assetClass === "prop"
  );
  check(
    "compile: warns when class was defaulted",
    noClass.ok && noClass.warnings.some((w) => /asset_class/.test(w))
  );
}

const compiled = (() => {
  const result = validateCompiledPrompt({ raw: GOOD_RAW, engine: "cloud", needsT2i: true });
  if (!result.ok) throw new Error("fixture compile should be valid");
  return result.compiled;
})();

// ---------------------------------------------------------------------------
// 3. Routing + estimate
// ---------------------------------------------------------------------------
{
  const lowConfidence = planRoute({
    engine: "cloud",
    compiled,
    hasReferenceImage: false,
    compileConfidence: 0.7,
  });
  check("route: stops below the confidence floor", !lowConfidence.ok);
  check(
    "route: low confidence emits ROUTE_CONFIDENCE",
    !lowConfidence.ok && lowConfidence.failCodes.includes("ROUTE_CONFIDENCE")
  );

  const textOnly = planRoute({ engine: "cloud", compiled, hasReferenceImage: false, compileConfidence: 0.9 });
  check("route: text-only Cloud sets needs_t2i", textOnly.ok && textOnly.plan.needsT2i);
  check("route: Cloud adapter is bluefox", textOnly.ok && textOnly.plan.adapter === "bluefox");
  check("route: echoes the session engine", textOnly.ok && textOnly.plan.engine === "cloud");

  const withImage = planRoute({ engine: "cloud", compiled, hasReferenceImage: true, compileConfidence: 0.9 });
  check("route: an image input skips t2i", withImage.ok && !withImage.plan.needsT2i);
  check("route: admission still runs on a supplied image", withImage.ok && withImage.plan.needsPreprocess);

  const waterFactory = planRoute({ engine: "water", waterMode: "threejs", compiled, hasReferenceImage: false, compileConfidence: 0.9 });
  check("route: Water threejs mode selects the factory", waterFactory.ok && waterFactory.plan.adapter === "threejs-factory");
  check("route: Water never sets needs_t2i on the factory path", waterFactory.ok && !waterFactory.plan.needsT2i);
  check("route: Water echoes water", waterFactory.ok && waterFactory.plan.engine === "water");

  const waterMesh = planRoute({ engine: "water", waterMode: "mesh", compiled, hasReferenceImage: false, compileConfidence: 0.9 });
  check("route: Water mesh mode picks a BYOK adapter", waterMesh.ok && waterMesh.plan.adapter === "meshy");

  const gameReady = planRoute({
    engine: "cloud",
    compiled: { ...compiled, profile: "game_ready" },
    hasReferenceImage: true,
    compileConfidence: 0.95,
  });
  check("route: game_ready schedules the bake", gameReady.ok && gameReady.plan.needsBake);
  check("route: balanced does not bake", withImage.ok && !withImage.plan.needsBake);
  check(
    "route: poly hint is clamped to the class budget",
    textOnly.ok && textOnly.plan.polyBudget <= 16_000,
    textOnly.ok ? `budget ${textOnly.plan.polyBudget}` : undefined
  );

  if (textOnly.ok) {
    const rich = estimateRun({ plan: textOnly.plan, availableCredits: 100 });
    check("estimate: funded run is allowed", rich.ok);
    check("estimate: t2i is billed on a text-only Cloud run", rich.ok && rich.breakdown.some((b) => b.stage === "t2i"));
    const broke = estimateRun({ plan: textOnly.plan, availableCredits: 2 });
    check("estimate: underfunded run is a hard stop", !broke.ok);
  }
  if (waterMesh.ok) {
    const byok = estimateRun({ plan: waterMesh.plan, availableCredits: 5 });
    check(
      "estimate: Water mesh generation is not billed to platform credits",
      byok.ok && !byok.breakdown.some((b) => b.stage === "generate")
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Admission
// ---------------------------------------------------------------------------
function rgbaPng(width: number, height: number, paint: (x: number, y: number) => boolean): Buffer {
  // encodePng only writes gray/rgb, so build an alpha-bearing PNG by hand via a gray
  // image plus a separate mask adapter. Here we exercise the background-estimate path.
  const pixels = new Uint8Array(width * height * 3).fill(250);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!paint(x, y)) continue;
      const at = (y * width + x) * 3;
      pixels[at] = 30;
      pixels[at + 1] = 40;
      pixels[at + 2] = 50;
    }
  }
  return encodePng(pixels, width, height, "rgb");
}

{
  // A centred subject filling roughly a quarter of a 256px frame.
  const good = rgbaPng(256, 256, (x, y) => x > 64 && x < 192 && y > 64 && y < 192);
  const goodReport = await admitReference({ bytes: good, contentType: "image/png" });
  check("admission: clean studio ref admitted", goodReport.admitted, goodReport.reasons.join(" "));
  check("admission: records provenance", goodReport.maskSource === "png_background_estimate");
  check(
    "admission: foreground ratio ≈ 25%",
    Math.abs((goodReport.foregroundRatio ?? 0) - 0.25) < 0.02,
    `got ${goodReport.foregroundRatio}`
  );

  // Too small.
  const tiny = rgbaPng(32, 32, (x, y) => x > 8 && x < 24 && y > 8 && y < 24);
  const tinyReport = await admitReference({ bytes: tiny });
  check("admission: rejects a 32px image", !tinyReport.admitted);
  check("admission: emits ADMISSION_SIZE", tinyReport.failCodes.includes("ADMISSION_SIZE"));

  // Subject too small in frame.
  const speck = rgbaPng(256, 256, (x, y) => x > 120 && x < 130 && y > 120 && y < 130);
  const speckReport = await admitReference({ bytes: speck });
  check("admission: rejects a subject under 5% of frame", !speckReport.admitted);
  check("admission: emits ADMISSION_FG", speckReport.failCodes.includes("ADMISSION_FG"));

  // Clutter: two equal blobs, so the largest is only ~50% of the foreground.
  const clutter = rgbaPng(256, 256, (x, y) => (x > 20 && x < 100 && y > 80 && y < 170) || (x > 150 && x < 230 && y > 80 && y < 170));
  const clutterReport = await admitReference({ bytes: clutter });
  check("admission: rejects two subjects in frame", !clutterReport.admitted);
  check("admission: emits ADMISSION_BLOB", clutterReport.failCodes.includes("ADMISSION_BLOB"));

  // Unmeasurable input fails closed rather than being admitted.
  const jpegish = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const jpegReport = await admitReference({ bytes: jpegish, contentType: "image/jpeg", rembg: unavailableRembg });
  check("admission: unmeasurable image is not admitted", !jpegReport.admitted);
  check("admission: explains that it failed closed", jpegReport.reasons.some((r) => /fails closed/i.test(r)));

  // A configured adapter takes precedence and is recorded as the provenance.
  const stubAdapter: RembgAdapter = async () => ({
    available: true,
    mask: (() => {
      const mask = new Uint8Array(128 * 128);
      for (let y = 32; y < 96; y++) for (let x = 32; x < 96; x++) mask[y * 128 + x] = 1;
      return { mask, width: 128, height: 128 };
    })(),
  });
  const viaAdapter = await admitReference({ bytes: jpegish, contentType: "image/jpeg", rembg: stubAdapter });
  check("admission: adapter mask is used when available", viaAdapter.admitted, viaAdapter.reasons.join(" "));
  check("admission: adapter provenance recorded", viaAdapter.maskSource === "rembg_adapter");
}

// ---------------------------------------------------------------------------
// 5. Scoring
// ---------------------------------------------------------------------------
const GOOD_GLB = buildGlb(makeBox({ min: [-0.1, 0, -0.1], max: [0.1, 0.35, 0.1] }));

function manifestFor(card: JobCard, kinds: Array<EvidenceManifest["captures"][number]["kind"]>): EvidenceManifest {
  return {
    jobId: card.jobId,
    runId: card.runId,
    captures: kinds.map((kind, i) => ({
      kind,
      uri: `s3://evidence/${card.runId}/${kind}-${i}.bin`,
      runId: card.runId,
      createdAt: new Date().toISOString(),
    })),
  };
}

// Cloud requires an admission report whenever a reference image was in the loop.
const FULL_EVIDENCE: Array<EvidenceManifest["captures"][number]["kind"]> = [
  "glb", "gate_report", "turntable", "turntable", "turntable", "turntable",
  "comparison_sheet", "score_report", "admission_report",
];

{
  const card = createJobCard({
    jobId: "job_score_1",
    runId: "run_1",
    engine: "cloud",
    profile: "balanced",
    assetClass: "prop",
  });

  const gate = runMeshPostGate(GOOD_GLB, { engine: "cloud", profile: "balanced", assetClass: "prop", viewSize: 96 });
  check("score fixture: gate passes", gate.passed, JSON.stringify(gate.findings));
  const views = renderViews(GOOD_GLB, { size: 96 });
  check("render_views: four PNG captures", views.views.length === 4);
  check("render_views: PNGs are non-empty", views.views.every((v) => v.png.length > 100));
  check("render_views: orbit consistency reported", views.orbitConsistency > 0);

  // The candidate's own 0° silhouette as the reference: a perfect-agreement upper bound.
  const selfReference = {
    mask: views.views[0]!.mask,
    width: views.views[0]!.width,
    height: views.views[0]!.height,
    source: "t2i" as const,
  };

  const report = await scoreAsset({
    card,
    gate,
    views,
    reference: selfReference,
    manifest: manifestFor(card, FULL_EVIDENCE),
    expectedScaleM: 0.35,
    materialCount: 3,
    namedParts: ["body", "cap", "handle"],
  });

  check("score: ran past the gate", report.scored);
  check("score: Tier1 IoU is 1 against itself", (report.tier1?.iou ?? 0) > 0.99, `got ${report.tier1?.iou}`);
  check("score: scale error ~0", (report.tier1?.scaleError ?? 1) < 0.02, `got ${report.tier1?.scaleError}`);
  check("score: produced a comparison sheet", report.comparisonSheet !== null);
  check("score: VLM was attempted", report.vlm.attempted);
  check("score: VLM unavailable by default", !report.vlm.available);
  check(
    "score: records that unmeasured criteria are not a pass",
    report.reasons.some((r) => /Unmeasured is not a pass/i.test(r))
  );
  // For a prop the VLM criteria are non-critical, so a clean deterministic run may
  // promote without one — the skill spec calls the VLM optional. Vehicles differ, below.
  check(
    "score: a clean prop can promote on deterministic evidence alone",
    report.promoteEligible,
    `codes [${report.failCodes.join(", ")}] reasons: ${report.reasons.join(" ")}`
  );

  // With a VLM, the same asset can clear the floors.
  const generousVlm: VlmScorer = async ({ criteria }) => ({
    available: true,
    samples: [{ criteria: Object.fromEntries(criteria.map((c) => [c, 0.92])) }],
  });
  const withVlm = await scoreAsset({
    card,
    gate,
    views,
    reference: selfReference,
    manifest: manifestFor(card, FULL_EVIDENCE),
    expectedScaleM: 0.35,
    materialCount: 3,
    namedParts: ["body", "cap", "handle"],
    vlm: generousVlm,
  });
  check("score: promotes with a VLM and full evidence", withVlm.promoteEligible, `codes [${withVlm.failCodes.join(", ")}] reasons: ${withVlm.reasons.join(" ")}`);
  check("score: fidelity computed", typeof withVlm.fidelity === "number");

  // A disagreeing VLM must not be averaged into a pass.
  const noisyVlm: VlmScorer = async ({ criteria }) => ({
    available: true,
    samples: [
      { criteria: Object.fromEntries(criteria.map((c) => [c, 0.95])) },
      { criteria: Object.fromEntries(criteria.map((c) => [c, 0.4])) },
    ],
  });
  const noisy = await scoreAsset({
    card, gate, views, reference: selfReference,
    manifest: manifestFor(card, FULL_EVIDENCE),
    expectedScaleM: 0.35, materialCount: 3, namedParts: ["body"], vlm: noisyVlm,
  });
  check("score: wide VLM spread is a fail", noisy.failCodes.includes("VLM_SPREAD"), `codes [${noisy.failCodes.join(", ")}]`);
  check("score: wide spread blocks promotion", !noisy.promoteEligible);

  // Incomplete evidence blocks promotion even with a perfect score.
  const thin = await scoreAsset({
    card, gate, views, reference: selfReference,
    manifest: manifestFor(card, ["glb", "gate_report"]),
    expectedScaleM: 0.35, materialCount: 3, namedParts: ["body"], vlm: generousVlm,
  });
  check("score: thin evidence blocks promotion", !thin.promoteEligible);
  check("score: emits EVIDENCE_INCOMPLETE", thin.failCodes.includes("EVIDENCE_INCOMPLETE"));

  // Two sheets for one runId is a contract violation.
  const twoSheets = await scoreAsset({
    card, gate, views, reference: selfReference,
    manifest: manifestFor(card, [...FULL_EVIDENCE, "comparison_sheet"]),
    expectedScaleM: 0.35, materialCount: 3, namedParts: ["body"], vlm: generousVlm,
  });
  check("score: two comparison sheets rejected", !twoSheets.promoteEligible);
  check(
    "score: explains the one-sheet rule",
    twoSheets.reasons.some((r) => /one comparison_sheet/i.test(r))
  );

  // Stale captures do not count.
  const staleManifest = manifestFor(card, FULL_EVIDENCE);
  staleManifest.captures = staleManifest.captures.map((c) => ({ ...c, runId: "run_0" }));
  const stale = await scoreAsset({
    card, gate, views, reference: selfReference, manifest: staleManifest,
    expectedScaleM: 0.35, materialCount: 3, namedParts: ["body"], vlm: generousVlm,
  });
  check("score: stale captures block promotion", !stale.promoteEligible);
  check("score: explains staleness", stale.reasons.some((r) => /earlier runId/i.test(r)));

  // Scale far off the compiled contract is a Tier1 fail.
  const wrongScale = await scoreAsset({
    card, gate, views, reference: selfReference,
    manifest: manifestFor(card, FULL_EVIDENCE),
    expectedScaleM: 2.0, materialCount: 3, namedParts: ["body"], vlm: generousVlm,
  });
  check("score: wrong scale is a Tier1 SCALE fail", wrongScale.failCodes.includes("SCALE"));

  // A quality profile raises the floor above what balanced accepts.
  const qualityCard = { ...card, profile: "quality" as const };
  check(
    "score: quality floor is above balanced",
    (await scoreAsset({
      card: qualityCard, gate, views, reference: selfReference,
      manifest: manifestFor(qualityCard, FULL_EVIDENCE),
      expectedScaleM: 0.35, materialCount: 3, namedParts: ["body"],
      vlm: async ({ criteria }) => ({ available: true, samples: [{ criteria: Object.fromEntries(criteria.map((c) => [c, 0.81])) }] }),
    })).floors.fidelity > report.floors.fidelity
  );
}

// A HARD geometry fail is never scored, no matter how generous the VLM.
{
  const card = createJobCard({
    jobId: "job_score_2", runId: "run_1", engine: "cloud", profile: "balanced", assetClass: "prop",
  });
  const badGlb = buildGlb(makePlane(0.4));
  const gate = runMeshPostGate(badGlb, { engine: "cloud", profile: "balanced", assetClass: "prop", viewSize: 96 });
  check("score: fixture gate fails", !gate.passed);

  const report = await scoreAsset({
    card, gate, views: renderViews(badGlb, { size: 96 }), reference: null,
    manifest: manifestFor(card, FULL_EVIDENCE), expectedScaleM: 0.4,
    materialCount: 3, namedParts: ["body"],
    vlm: async ({ criteria }) => ({ available: true, samples: [{ criteria: Object.fromEntries(criteria.map((c) => [c, 1])) }] }),
  });
  check("score: refuses to score a HARD geo fail", !report.scored);
  check("score: no promotion on a HARD geo fail", !report.promoteEligible);
  check("score: no VLM attempted on a HARD geo fail", !report.vlm.attempted);
  check("score: explains the refusal", report.reasons.some((r) => /refusing to score/i.test(r)));
}

// Vehicle identity features (cabin, glass, grille) are critical and VLM-measured, so a
// vehicle cannot promote without a working VLM — unmeasured is never a pass.
{
  const card = createJobCard({
    jobId: "job_score_3", runId: "run_1", engine: "cloud", profile: "quality", assetClass: "vehicle",
  });
  const carGlb = buildGlb(makeBox({ min: [0, 0, 0], max: [4.4, 1.45, 1.8] }));
  const gate = runMeshPostGate(carGlb, { engine: "cloud", profile: "quality", assetClass: "vehicle", viewSize: 96 });
  check("score/vehicle: gate passes", gate.passed, JSON.stringify(gate.findings));
  const views = renderViews(carGlb, { size: 96 });
  const reference = { mask: views.views[0]!.mask, width: views.views[0]!.width, height: views.views[0]!.height, source: "t2i" as const };

  const noVlm = await scoreAsset({
    card, gate, views, reference, manifest: manifestFor(card, FULL_EVIDENCE),
    expectedScaleM: 4.4, materialCount: 4, namedParts: ["body", "glass", "wheel_fl", "wheel_fr"],
    vlm: unavailableVlm,
  });
  check("score/vehicle: no VLM blocks promotion", !noVlm.promoteEligible);
  check(
    "score/vehicle: unmeasured critical features are reported",
    noVlm.failCodes.includes("IDENTITY_FEATURE"),
    `codes [${noVlm.failCodes.join(", ")}]`
  );
  check("score/vehicle: fidelity is null rather than partial", noVlm.fidelity === null);

  const withVlm = await scoreAsset({
    card, gate, views, reference, manifest: manifestFor(card, FULL_EVIDENCE),
    expectedScaleM: 4.4, materialCount: 4, namedParts: ["body", "glass", "wheel_fl", "wheel_fr"],
    vlm: async ({ criteria }) => ({ available: true, samples: [{ criteria: Object.fromEntries(criteria.map((c) => [c, 0.9])) }] }),
  });
  check("score/vehicle: promotes once the VLM measures identity", withVlm.promoteEligible, `codes [${withVlm.failCodes.join(", ")}] ${withVlm.reasons.join(" ")}`);

  // A vehicle raises the critical-feature floor above the prop default.
  const weakVlm = await scoreAsset({
    card, gate, views, reference, manifest: manifestFor(card, FULL_EVIDENCE),
    expectedScaleM: 4.4, materialCount: 4, namedParts: ["body"],
    vlm: async ({ criteria }) => ({ available: true, samples: [{ criteria: Object.fromEntries(criteria.map((c) => [c, 0.6])) }] }),
  });
  check("score/vehicle: a weak identity score is rejected", !weakVlm.promoteEligible);
  check("score/vehicle: names the failing feature", weakVlm.reasons.some((r) => /Critical feature/.test(r)));
}

// ---------------------------------------------------------------------------
// 6. Refine controller
// ---------------------------------------------------------------------------
function fakeGate(overrides: Partial<GateReport>): GateReport {
  return {
    engine: "cloud", profile: "balanced", assetClass: "prop",
    passed: true, findings: [], remeshCandidate: false, stats: null, views: [],
    measurements: {
      triangleCount: 5000, longestEdgeM: 0.35, volume: 0.01, nonManifoldEdges: 0,
      boundaryEdges: 0, componentCount: 1, minOrbitAreaRatio: 0.8, uvCoverage: 1, hasNormals: true,
    },
    ...overrides,
  };
}

function fakeScore(overrides: Partial<import("../src/lib/create/score.js").ScoreReport>) {
  return {
    runId: "run_1", engine: "cloud" as const, profile: "balanced" as const, assetClass: "prop" as const,
    scored: true, tier1: null, features: [], fidelity: 0.75,
    floors: { fidelity: 0.8, criticalFeature: 0.8, importantAvg: 0.65, continueAt: 0.7 },
    vlm: { attempted: true, available: true }, promoteEligible: false, worthRefining: true,
    failCodes: [] as FailCode[], reasons: [], comparisonSheet: null,
    ...overrides,
  };
}

{
  const card = createJobCard({ jobId: "j", runId: "run_1", engine: "cloud", profile: "balanced", assetClass: "prop" });

  // Geometry HARD fail wins over a perfect score.
  const geoFail = decideRefine({
    card,
    gate: fakeGate({
      passed: false,
      findings: [{ code: "NON_MANIFOLD", severity: "hard", detail: "12 non-manifold edges" }],
      remeshCandidate: true,
    }),
    score: fakeScore({ promoteEligible: true, fidelity: 0.99 }),
  });
  check("refine: geometry fail overrides a passing score", geoFail.action.kind === "reenter");
  check(
    "refine: remeshable defect routes to the mesh stage",
    geoFail.action.kind === "reenter" && geoFail.action.stage === "cloud-mesh-post"
  );
  check("refine: geometry repair bumps the runId", geoFail.action.kind === "reenter" && geoFail.action.bumpRunId);
  check("refine: logs that a score never overrides geometry", geoFail.trace.some((t) => /never overrides geometry/i.test(t)));

  // Non-remeshable geometry defect regenerates instead.
  const regen = decideRefine({
    card,
    gate: fakeGate({ passed: false, findings: [{ code: "NOT_GROUNDED", severity: "hard", detail: "hovering" }], remeshCandidate: false }),
    score: null,
  });
  check(
    "refine: non-remeshable defect regenerates",
    regen.action.kind === "reenter" && regen.action.stage === "cloud-run-pixal"
  );

  // Repeated defect stops.
  const repeated = decideRefine({
    card,
    gate: fakeGate({ passed: false, findings: [{ code: "NON_MANIFOLD", severity: "hard", detail: "x" }], remeshCandidate: true }),
    score: null,
    previousFailCodes: [["NON_MANIFOLD"], ["NON_MANIFOLD"]],
  });
  check("refine: repeated defect is a reject", repeated.action.kind === "reject");
  check(
    "refine: reject explains the repeat",
    repeated.action.kind === "reject" && /survived/i.test(repeated.action.reason)
  );

  // Refine ceiling.
  const exhausted: JobCard = { ...card, refine: { perStage: {}, total: 6 } };
  const capped = decideRefine({
    card: exhausted,
    gate: fakeGate({ passed: false, findings: [{ code: "FLOATER", severity: "hard", detail: "island" }], remeshCandidate: true }),
    score: null,
  });
  check("refine: total ceiling forces a reject", capped.action.kind === "reject");

  // Per-stage cap.
  const stageCapped: JobCard = { ...card, refine: { perStage: { "cloud-mesh-post": 3 }, total: 3 } };
  const stageStop = decideRefine({
    card: stageCapped,
    gate: fakeGate({ passed: false, findings: [{ code: "FLOATER", severity: "hard", detail: "island" }], remeshCandidate: true }),
    score: null,
  });
  check("refine: per-stage cap forces a reject", stageStop.action.kind === "reject");

  // Promote.
  const promote = decideRefine({ card, gate: fakeGate({}), score: fakeScore({ promoteEligible: true, fidelity: 0.9 }) });
  check("refine: promotes when every floor is met", promote.action.kind === "promote");

  // Plateau.
  const plateau = decideRefine({
    card, gate: fakeGate({}),
    score: fakeScore({ fidelity: 0.755, failCodes: ["FIDELITY_FLOOR"] }),
    previousFidelity: 0.75,
  });
  check("refine: plateau stops the loop", plateau.action.kind === "reject");
  check("refine: plateau reason names the delta", plateau.action.kind === "reject" && /Plateau/.test(plateau.action.reason));

  // Below the continue floor.
  const hopeless = decideRefine({
    card, gate: fakeGate({}),
    score: fakeScore({ fidelity: 0.4, worthRefining: false, failCodes: ["FIDELITY_FLOOR"] }),
  });
  check("refine: below the continue floor is a reject", hopeless.action.kind === "reject");

  // Evidence-only failure recaptures instead of regenerating.
  const evidenceOnly = decideRefine({
    card, gate: fakeGate({}),
    score: fakeScore({ failCodes: ["EVIDENCE_INCOMPLETE"], fidelity: 0.9 }),
  });
  check(
    "refine: evidence gap recaptures instead of regenerating",
    evidenceOnly.action.kind === "reenter" && evidenceOnly.action.stage === "cloud-evaluate"
  );
  check(
    "refine: recapture does not bump the runId",
    evidenceOnly.action.kind === "reenter" && !evidenceOnly.action.bumpRunId
  );

  // Objectness probe is a look, not a pass.
  const probe = decideRefine({
    card, gate: fakeGate({}),
    score: fakeScore({
      failCodes: ["IDENTITY_FEATURE"], fidelity: 0.78,
      tier1: { iou: 0.8, bestAngle: 0, scaleError: 0.01, aspectError: 0.01, objectness: 0.6, passed: false, objectnessProbe: true, failCodes: [], notes: [] },
    }),
  });
  check("refine: objectness probe is not a promote", probe.action.kind !== "promote");
  check(
    "refine: probe re-enters the evaluator",
    probe.action.kind === "reenter" && probe.action.stage === "cloud-evaluate"
  );

  // Water never escapes to Cloud.
  const waterCard = createJobCard({ jobId: "jw", runId: "run_1", engine: "water", waterMode: "threejs", profile: "balanced", assetClass: "prop" });
  const waterDecision = decideRefine({
    card: waterCard,
    gate: fakeGate({ engine: "water", passed: false, findings: [{ code: "NOT_GROUNDED", severity: "hard", detail: "hovering" }] }),
    score: null,
  });
  check(
    "refine: Water re-entry stays on a Water stage",
    waterDecision.action.kind === "reenter" && waterDecision.action.stage.startsWith("water-"),
    waterDecision.action.kind === "reenter" ? waterDecision.action.stage : undefined
  );
}

// ---------------------------------------------------------------------------

console.log(`\ncreate pipeline verification: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("all create pipeline assertions passed\n");
