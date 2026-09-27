/**
 * Verify the Create harness contracts (Phase 0).
 *
 * Pure in-memory checks — no DB, no network, no API keys. Run with:
 *   npm run verify:create
 *
 * Guards asserted here are the ones the rest of the harness depends on. If any fail,
 * a later phase can silently promote a broken mesh.
 *
 * Contracts: docs/contracts/{TOOL_SURFACE,JOB_CARD,EVIDENCE_MANIFEST}.md
 */

import {
  canRefine,
  checkEvidence,
  createJobCard,
  isHardGeoFail,
  nextStage,
  validateCheckpoint,
  type EvidenceManifest,
  type JobCard,
  type StageId,
} from "../src/lib/create/contracts.js";
import {
  TOOL_IDS,
  assertToolId,
  canPromote,
} from "../src/lib/create/toolSurface.js";
import {
  PROFILE_FIDELITY_FLOOR,
  REFINE,
  resolveFloors,
} from "../src/lib/create/quality/thresholds.js";

let failures = 0;

function check(name: string, condition: boolean) {
  if (!condition) failures++;
  console.log(`${condition ? "  ok  " : " FAIL "} ${name}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

const now = new Date().toISOString();

/** A complete, fresh evidence set for the given run. */
function fullManifest(runId: string): EvidenceManifest {
  return {
    jobId: "job_test",
    runId,
    captures: [
      { kind: "glb", uri: "glb", runId, createdAt: now },
      { kind: "gate_report", uri: "gate", runId, createdAt: now },
      { kind: "comparison_sheet", uri: "sheet", runId, createdAt: now },
      { kind: "score_report", uri: "score", runId, createdAt: now },
      ...[0, 90, 180, 270].map((angle) => ({
        kind: "turntable" as const,
        uri: `view_${angle}`,
        runId,
        createdAt: now,
      })),
    ],
  };
}

section("Tool surface — frozen at 12");
check("exactly 12 tool ids", TOOL_IDS.length === 12);
check(
  "a 13th id throws",
  (() => {
    try {
      assertToolId("mesh.magic");
      return false;
    } catch {
      return true;
    }
  })()
);
check("only the evaluator promotes", canPromote("asset.score") && !canPromote("job.submit"));

section("Thresholds — class raises floors, never lowers");
check("draft floor is 0.70", PROFILE_FIDELITY_FLOOR.draft === 0.7);
check("vehicle raises a draft floor to 0.85", resolveFloors("draft", "vehicle").fidelity === 0.85);
check("prop cannot soften a quality floor", resolveFloors("quality", "prop").fidelity === 0.85);
check("refine caps are 3 per stage / 6 total", REFINE.maxPerStage === 3 && REFINE.maxTotal === 6);

section("JobCard — Cloud stage machine");
const cloud = createJobCard({
  jobId: "job_test",
  runId: "run_1",
  engine: "cloud",
  profile: "balanced",
  assetClass: "vehicle",
});
check("card seeds all 9 Cloud stages as pending",
  cloud.stages.length === 9 && cloud.stages.every((s) => s.status === "pending"));
check("resume points at the first stage", nextStage(cloud) === "cloud-compile-prompt");
check("cloud-mesh-post can never be skipped",
  validateCheckpoint(cloud, { stageId: "cloud-mesh-post", status: "skipped", skipReason: "fast path" }).ok === false);
check("cloud-evaluate can never be skipped",
  validateCheckpoint(cloud, { stageId: "cloud-evaluate", status: "skipped", skipReason: "trust it" }).ok === false);
check("cloud-t2i may be skipped with a reason",
  validateCheckpoint(cloud, { stageId: "cloud-t2i", status: "done", next: "cloud-preprocess-ref" }).ok === true);
check("skipping without a reason is rejected",
  validateCheckpoint(cloud, { stageId: "cloud-t2i", status: "skipped" }).ok === false);
check("failing without a fail code is rejected",
  validateCheckpoint(cloud, { stageId: "cloud-run-pixal", status: "failed" }).ok === false);
check("failing with a code is accepted",
  validateCheckpoint(cloud, { stageId: "cloud-run-pixal", status: "failed", failCodes: ["EMPTY_GLB"] }).ok === true);
check("next must name a stage on this card",
  validateCheckpoint(cloud, { stageId: "cloud-t2i", status: "done", next: "water-evaluate" as StageId }).ok === false);

section("JobCard — stage-aware gating");
check("cannot jump to evaluate before the geo gate passes",
  validateCheckpoint(cloud, { stageId: "cloud-run-pixal", status: "done", next: "cloud-evaluate" }).ok === false);
check("cannot jump to bake before the geo gate passes",
  validateCheckpoint(cloud, { stageId: "cloud-run-pixal", status: "done", next: "cloud-bake" }).ok === false);
check("advancing to the gate itself is allowed",
  validateCheckpoint(cloud, { stageId: "cloud-run-pixal", status: "done", next: "cloud-mesh-post" }).ok === true);
cloud.stages.find((s) => s.id === "cloud-mesh-post")!.status = "done";
check("evaluate is allowed once the gate has passed",
  validateCheckpoint(cloud, { stageId: "cloud-bake", status: "done", next: "cloud-evaluate" }).ok === true);

section("JobCard — Water stage machine");
const water = createJobCard({
  jobId: "wt_test",
  runId: "run_1",
  engine: "water",
  waterMode: "threejs",
  profile: "balanced",
  assetClass: "prop",
});
check("card seeds all 6 Water stages", water.stages.length === 6);
check("Water defaults to the shipped threejs mode", water.waterMode === "threejs");
check("water-mesh-post can never be skipped",
  validateCheckpoint(water, { stageId: "water-mesh-post", status: "skipped", skipReason: "sandbox looked fine" }).ok === false);
check("Water cards reject Cloud stage ids",
  validateCheckpoint(water, { stageId: "cloud-run-pixal", status: "done" }).ok === false);

section("Refine caps");
const capped: JobCard = {
  ...cloud,
  refine: { perStage: { "cloud-evaluate": 3 }, total: 3 },
};
check("per-stage cap blocks a 4th refine", canRefine(capped, "cloud-evaluate").allowed === false);
check("a different stage may still refine", canRefine(capped, "cloud-bake").allowed === true);
check("total ceiling blocks everything",
  canRefine({ ...cloud, refine: { perStage: {}, total: 6 } }, "cloud-bake").allowed === false);

section("Fail codes");
check("HARD geo fail is detected inside a mixed list", isHardGeoFail(["IOU", "NON_MANIFOLD"]));
check("a soft score code alone is not a HARD fail", !isHardGeoFail(["IOU"]));

section("EvidenceManifest — the promote gate");
check("complete + fresh + gate pass + above floor promotes",
  checkEvidence({ manifest: fullManifest("run_1"), card: cloud, gatePassed: true, fidelity: 0.9 }).promoteEligible === true);
check("a stale runId blocks promote",
  checkEvidence({ manifest: fullManifest("run_0"), card: cloud, gatePassed: true, fidelity: 0.9 }).promoteEligible === false);
check("a HARD gate fail blocks promote even at 0.99 fidelity",
  checkEvidence({ manifest: fullManifest("run_1"), card: cloud, gatePassed: false, fidelity: 0.99 }).promoteEligible === false);
check("below the vehicle floor blocks promote",
  checkEvidence({ manifest: fullManifest("run_1"), card: cloud, gatePassed: true, fidelity: 0.82 }).promoteEligible === false);

const twoSheets = fullManifest("run_1");
twoSheets.captures.push({ kind: "comparison_sheet", uri: "sheet_2", runId: "run_1", createdAt: now });
check("two comparison sheets in one run blocks promote",
  checkEvidence({ manifest: twoSheets, card: cloud, gatePassed: true, fidelity: 0.9 }).promoteEligible === false);

const missingView = fullManifest("run_1");
missingView.captures = missingView.captures.filter((c) => c.uri !== "view_270");
check("a missing turntable angle blocks promote",
  checkEvidence({ manifest: missingView, card: cloud, gatePassed: true, fidelity: 0.9 }).promoteEligible === false);

const noScore = fullManifest("run_1");
noScore.captures = noScore.captures.filter((c) => c.kind !== "score_report");
check("a missing score_report is reported as missing",
  checkEvidence({ manifest: noScore, card: cloud, gatePassed: true }).missing.includes("score_report"));

check("game_ready additionally requires a bake_report",
  checkEvidence({
    manifest: fullManifest("run_1"),
    card: { ...cloud, profile: "game_ready" },
    gatePassed: true,
    fidelity: 0.9,
  }).missing.includes("bake_report"));

check("Cloud with a reference image requires an admission_report",
  checkEvidence({
    manifest: fullManifest("run_1"),
    card: cloud,
    hasReferenceImage: true,
    gatePassed: true,
    fidelity: 0.9,
  }).missing.includes("admission_report"));

check("blocked promotes always explain why",
  checkEvidence({ manifest: fullManifest("run_0"), card: cloud, gatePassed: false }).reasons.length > 0);

console.log(
  failures === 0
    ? "\nAll Create contract guards hold."
    : `\n${failures} guard(s) FAILED — do not build on top of this.`
);
process.exit(failures === 0 ? 0 : 1);
