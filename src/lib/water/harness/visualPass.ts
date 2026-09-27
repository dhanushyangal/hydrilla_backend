/**
 * Visual quality loop for Water factories — fold of img2threejs
 * mesh.post.gate + turntable + one comparison sheet behind existing workers.
 * No 13th tool.
 */

import { randomUUID } from "crypto";
import { createJobCard, type EvidenceManifest, type JobCard } from "../../create/contracts.js";
import { runMeshPostGate, type GateReport } from "../../create/mesh/gate.js";
import { renderViews, type RenderViewsResult } from "../../create/mesh/views.js";
import { scoreAsset, type ScoreReport } from "../../create/score.js";
import type { CreateAssetClass, CreateProfile } from "../../create/quality/thresholds.js";
import type { RichSculptSpec } from "./types.js";
import { specToGlb } from "./specToGlb.js";
import { executeFactoryToGlb } from "./factoryExecute.js";
import { inspectStructure } from "./structure.js";
import { interiorDifference } from "./interior.js";
import { pngToDataUrl } from "../../create/mesh/png.js";
import type { ReferenceMask } from "../../create/score.js";
import { logger } from "../../../logger.js";

export type VisualPassResult = {
  glb: Buffer;
  gate: GateReport;
  views: RenderViewsResult;
  score: ScoreReport;
  card: JobCard;
  manifest: EvidenceManifest;
  source: "factory" | "unexecuted";
  meshNames: string[];
  turntables: Array<{ angle: number; dataUrl: string }>;
  sheetDataUrl: string | null;
};

export async function runFactoryVisualPass(params: {
  jobId: string;
  runId: string;
  spec: RichSculptSpec;
  factoryCode: string;
  profile: CreateProfile;
  assetClass: CreateAssetClass;
  expectedScaleM?: number | null;
  reference?: ReferenceMask | null;
  /** Fast may still score a spec proxy when the factory does not execute. */
  allowSpecProxy?: boolean;
}): Promise<VisualPassResult> {
  const executed = executeFactoryToGlb(params.factoryCode);
  let glb: Buffer;
  let source: "factory" | "unexecuted" = "unexecuted";
  let meshNames: string[] = [];
  if (executed.ok) {
    glb = executed.glb;
    source = "factory";
    meshNames = executed.meshNames;
  } else if (params.allowSpecProxy) {
    logger.warn({ err: executed.error, jobId: params.jobId }, "Water factory did not execute — Fast spec proxy");
    glb = specToGlb(params.spec, params.factoryCode);
    meshNames = (params.spec.components || []).map((c) => c.name || "").filter(Boolean);
  } else {
    logger.warn({ err: executed.error, jobId: params.jobId }, "Water factory did not execute — fail-closed visual");
    glb = specToGlb({ components: [] }, null);
  }

  const gate = runMeshPostGate(glb, {
    engine: "water",
    profile: params.profile,
    assetClass: params.assetClass,
    expectedScaleM: params.expectedScaleM,
    // Factories are CSG-less overlapping prims; self-intersect of parent/child is expected.
    factoryOverlappingPrims: true,
  });
  if (source === "unexecuted" && !params.allowSpecProxy) {
    gate.passed = false;
    gate.findings = [
      {
        code: "CONTRACT",
        severity: "hard",
        detail: executed.ok ? "Factory did not execute." : executed.error,
      },
      ...gate.findings,
    ];
  }
  const views = renderViews(glb, { size: 256 });

  const card =
    createJobCard({
      jobId: params.jobId,
      runId: params.runId,
      engine: "water",
      waterMode: "threejs",
      profile: params.profile,
      assetClass: params.assetClass,
    });
  // Pretend mesh-post passed or failed so scoreAsset can run the evidence rules.
  const meshPost = card.stages.find((s) => s.id === "water-mesh-post");
  if (meshPost) meshPost.status = gate.passed ? "done" : "failed";
  const evalStage = card.stages.find((s) => s.id === "water-evaluate");
  if (evalStage) evalStage.status = "running";

  const namedParts = meshNames.length
    ? meshNames
    : (params.spec.components || []).map((c) => c.name).filter(Boolean);
  const materialCount = Math.max(1, (params.spec.materials || []).length);
  const structure = inspectStructure({
    glb,
    specComponents: params.spec.components,
    executedNames: meshNames,
  });
  const front = views.views.find((v) => v.angle === 0) || views.views[0];
  const interior = front
    ? interiorDifference(
        { mask: front.mask, width: front.width, height: front.height, shade: null },
        params.reference
          ? {
              mask: params.reference.mask,
              width: params.reference.width,
              height: params.reference.height,
            }
          : null
      )
    : { score: null, cellsCompared: 0, passed: false, notes: ["No turntable view for interior difference."] };

  const now = new Date().toISOString();
  const captures: EvidenceManifest["captures"] = [
    { kind: "glb", uri: `job://${params.jobId}/${params.runId}/factory.glb`, runId: params.runId, createdAt: now },
    { kind: "gate_report", uri: `job://${params.jobId}/${params.runId}/gate.json`, runId: params.runId, createdAt: now },
  ];
  for (const view of views.views) {
    captures.push({
      kind: "turntable",
      uri: `job://${params.jobId}/${params.runId}/turntable/${view.angle}`,
      runId: params.runId,
      createdAt: now,
      meta: { angle: view.angle },
    });
  }
  captures.push({
    kind: "comparison_sheet",
    uri: `job://${params.jobId}/${params.runId}/sheet.png`,
    runId: params.runId,
    createdAt: now,
  });
  captures.push({
    kind: "score_report",
    uri: `job://${params.jobId}/${params.runId}/score.json`,
    runId: params.runId,
    createdAt: now,
  });

  const score = await scoreAsset({
    card,
    gate,
    views,
    reference: params.reference ?? null,
    manifest: { jobId: params.jobId, runId: params.runId, captures },
    expectedScaleM: params.expectedScaleM,
    materialCount,
    namedParts,
    bakeRan: false,
    structure,
    interior,
  });

  const turntables = views.views.map((view) => ({
    angle: view.angle,
    dataUrl: pngToDataUrl(view.png),
  }));
  const sheetDataUrl = score.comparisonSheet ? pngToDataUrl(score.comparisonSheet) : null;

  const manifest: EvidenceManifest = {
    jobId: params.jobId,
    runId: params.runId,
    captures,
  };

  logger.info(
    {
      jobId: params.jobId,
      source,
      gatePassed: gate.passed,
      hard: gate.findings.filter((f) => f.severity === "hard").map((f) => f.code),
      fidelity: score.fidelity,
      promoteEligible: score.promoteEligible,
      meshNames: meshNames.slice(0, 12),
    },
    "Water factory visual pass"
  );

  return { glb, gate, views, score, card, manifest, source, meshNames, turntables, sheetDataUrl };
}

export function newRunId(): string {
  return `wr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export type WaterVisualJson = {
  gatePassed: boolean;
  fidelity: number | null;
  failCodes: string[];
  promoteEligible: boolean;
  reasons: string[];
  source: "factory" | "unexecuted";
  meshNames: string[];
  turntables: Array<{ angle: number; dataUrl: string }>;
  sheetDataUrl: string | null;
};

export function packWaterVisual(
  vis: Pick<
    VisualPassResult,
    "gate" | "score" | "source" | "meshNames" | "turntables" | "sheetDataUrl"
  >
): WaterVisualJson {
  return {
    gatePassed: vis.gate.passed,
    fidelity: vis.score.fidelity,
    failCodes: vis.score.failCodes,
    promoteEligible: vis.score.promoteEligible,
    reasons: vis.score.reasons.slice(0, 8),
    source: vis.source,
    meshNames: vis.meshNames.slice(0, 16),
    turntables: vis.turntables,
    sheetDataUrl: vis.sheetDataUrl,
  };
}
