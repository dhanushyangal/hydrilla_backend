/**
 * The Create tool surface, over HTTP: `POST /api/create/tools/:toolId`.
 *
 * This is the only door the eve agents knock on. Because the surface is frozen at 12 ids,
 * an unknown id is a 400 with the list — there is no dynamic registration and no 13th tool.
 *
 * Division of labour, enforced here rather than trusted to a prompt:
 *   - The agent decides WHICH tool to call and in what order.
 *   - This router decides WHETHER the call is legal for the JobCard's current state.
 *   - Gate and score logic lives in `lib/create/*` and returns fail codes, not opinions.
 *
 * Contracts: docs/contracts/TOOL_SURFACE.md · docs/contracts/JOB_CARD.md
 */

import { Router } from "express";
import { z } from "zod";

import { logger } from "../logger.js";
import { config, timingSafeEqualString } from "../config.js";
import {
  addEvidenceCapture,
  bumpRunId,
  checkpointStage,
  insertJobCard,
  loadEvidenceManifest,
  loadJobCard,
  recordRefineAttempt,
  saveCompiledPrompt,
  setJobCardOutcome,
} from "../repository/jobCards.js";
import { admitReference } from "../lib/create/admission.js";
import { screenSubject, validateCompiledPrompt } from "../lib/create/compile.js";
import {
  canRefine,
  type CaptureKind,
  type FailCode,
  type StageId,
  type StageStatus,
} from "../lib/create/contracts.js";
import { hardFailCodes, runMeshPostGate } from "../lib/create/mesh/gate.js";
import { supabase } from "../db.js";
import { parseGlb } from "../lib/create/mesh/glb.js";
import { renderViews } from "../lib/create/mesh/views.js";
import { decideRefine } from "../lib/create/refine.js";
import { estimateRun, planRoute } from "../lib/create/route.js";
import { scoreAsset } from "../lib/create/score.js";
import { TOOL_IDS, assertToolId, type ToolId } from "../lib/create/toolSurface.js";
import {
  assetClassFromContract,
  parseProfile,
  type CreateAssetClass,
  type CreateProfile,
} from "../lib/create/quality/thresholds.js";

export const createToolsRouter = Router();

/**
 * Agents are trusted infrastructure, not end users, so they authenticate with the shared
 * internal secret rather than a Clerk session. A user-scoped Create surface would need
 * `requireAuth` plus per-job ownership checks.
 */
function assertAgentAuth(req: any, res: any): boolean {
  const expected = config.internalApiSecret;
  if (!expected) {
    res.status(503).json({ error: "Create tool surface is not configured (missing internal secret)." });
    return false;
  }
  const header = String(req.headers["authorization"] || "");
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const provided = bearer || String(req.headers["x-hydrilla-internal"] || "");
  if (!timingSafeEqualString(provided, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const engineSchema = z.enum(["cloud", "water"]);
const profileSchema = z.enum(["draft", "balanced", "quality", "game_ready"]);
const assetClassSchema = z.enum(["prop", "vehicle", "prop-hero"]);

/**
 * `runId` is asserted by the agent and verified against the card. A mismatch means the agent
 * is working from a stale view — better a 409 than evidence written under the wrong run.
 */
const runAssertion = z.string().min(1).optional();

/** Reject a call whose asserted runId is not the card's current run. */
function runIdMismatch(cardRunId: string, asserted?: string): string | null {
  if (asserted && asserted !== cardRunId) {
    return `Asserted runId "${asserted}" is not the card's current run "${cardRunId}". Reload the JobCard before continuing.`;
  }
  return null;
}

const promptCompileSchema = z.object({
  jobId: z.string().min(1),
  engine: engineSchema,
  text: z.string().min(1),
  /**
   * Compiler output, snake_case per the contract. Untrusted and fully validated.
   * Absent on the first call: the agent screens the request, then calls again with fields.
   */
  compiled: z.record(z.string(), z.unknown()).optional(),
  /** The compiling model's confidence. `run.route` fails closed without it. */
  confidence: z.number().min(0).max(1).optional(),
  /** Contract-declared class from the UI. A legitimate contract input, not keyword inference. */
  declaredAssetClass: assetClassSchema.optional(),
  profileHint: profileSchema.optional(),
  refImageUris: z.array(z.string().url()).max(8).optional(),
  needsT2i: z.boolean().default(false),
});

/**
 * `run.route` takes only what the agent legitimately knows at call time. The CompiledPrompt
 * comes off the card, not off the wire — an agent re-sending it could send a different one
 * than the gate will later measure against.
 */
const routeSchema = z.object({
  jobId: z.string().min(1),
  engine: engineSchema,
  waterMode: z.enum(["threejs", "mesh"]).optional(),
  runId: runAssertion,
  hasReferenceImage: z.boolean().default(false),
  /** Overrides the card's stored confidence when the agent has a fresher number. */
  compileConfidence: z.number().min(0).max(1).optional(),
  estimatedCredits: z.number().nonnegative().optional(),
  /** Accepted for symmetry with `prompt.compile`; the card's class still wins. */
  assetClass: assetClassSchema.optional(),
  profileHint: profileSchema.optional(),
});

/** `run.estimate` re-derives the plan from the card so an agent cannot understate a cost. */
const estimateSchema = z.object({
  jobId: z.string().min(1),
  runId: runAssertion,
  needsT2i: z.boolean().optional(),
  hasReferenceImage: z.boolean().default(false),
  availableCredits: z.number().min(0).optional(),
  /** Escape hatch for callers that already hold a plan (tests, the bench harness). */
  plan: z.record(z.string(), z.unknown()).optional(),
});

const checkpointSchema = z.object({
  jobId: z.string().min(1),
  stageId: z.string().min(1),
  status: z.enum(["pending", "running", "done", "skipped", "failed"]),
  skipReason: z.string().nullable().optional(),
  failCodes: z.array(z.string()).optional(),
  artifacts: z.array(z.string()).optional(),
  next: z.string().nullable().optional(),
});

/**
 * The eve tools name artifact fields `*Uri`; earlier internal callers used `*Url`. Both are
 * accepted and normalised here rather than renaming 24 tool files, and a missing value is a
 * validation error rather than a silent `undefined` fetch.
 */
function artifactRef(field: string) {
  return z
    .object({
      [`${field}Uri`]: z.string().url().optional(),
      [`${field}Url`]: z.string().url().optional(),
    })
    .transform((value, ctx) => {
      const resolved = value[`${field}Uri`] ?? value[`${field}Url`];
      if (!resolved) {
        ctx.addIssue({ code: "custom", message: `${field}Uri (or ${field}Url) is required.` });
        return z.NEVER;
      }
      return resolved;
    });
}

const gateSchema = z.object({
  jobId: z.string().min(1),
  runId: runAssertion,
  expectedScaleM: z.number().positive().nullable().optional(),
  glbUri: z.string().url().optional(),
  glbUrl: z.string().url().optional(),
}).transform((value) => ({
  jobId: value.jobId,
  runId: value.runId,
  expectedScaleM: value.expectedScaleM,
  glb: value.glbUri ?? value.glbUrl ?? null,
}));

const jobSubmitSchema = z.object({
  jobId: z.string().min(1),
  runId: runAssertion,
  engine: engineSchema.optional(),
  stageId: z.string().min(1),
  kind: z.enum(["t2i", "text_to_3d", "image_to_3d"]).optional(),
  adapter: z.string().min(1).optional(),
  prompt: z.string().optional(),
  imageUri: z.string().url().optional(),
  profile: profileSchema.optional(),
});

const jobAwaitSchema = z.object({
  jobId: z.string().min(1),
  runId: runAssertion,
  stageId: z.string().min(1),
  providerJobId: z.string().min(1),
  timeoutMs: z.number().int().positive().max(3_600_000).default(900_000),
  pollIntervalMs: z.number().int().positive().max(60_000).default(5_000),
});

const scoreSchema = z.object({
  jobId: z.string().min(1),
  runId: runAssertion,
  referenceUri: z.string().url().nullable().optional(),
  referenceUrl: z.string().url().nullable().optional(),
  expectedScaleM: z.number().positive().nullable().optional(),
  bakeRan: z.boolean().default(false),
  glbUri: z.string().url().optional(),
  glbUrl: z.string().url().optional(),
}).transform((value) => ({
  ...value,
  glb: value.glbUri ?? value.glbUrl ?? null,
}));

const rembgSchema = z.intersection(
  z.object({ jobId: z.string().min(1), runId: runAssertion }),
  artifactRef("image").transform((image) => ({ image }))
);

/** Bytes cap for a server-side fetch of agent-supplied URLs. */
const MAX_FETCH_BYTES = 64 * 1024 * 1024;

async function fetchBytes(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_FETCH_BYTES) {
    throw new Error(`Artifact is ${declared} bytes, over the ${MAX_FETCH_BYTES} limit.`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FETCH_BYTES) {
    throw new Error(`Artifact is ${buffer.length} bytes, over the ${MAX_FETCH_BYTES} limit.`);
  }
  return { bytes: buffer, contentType: response.headers.get("content-type") || "application/octet-stream" };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * The request schemas, exported for `verify-agent-surface.ts`.
 *
 * The eve tools and these schemas are two halves of one wire contract written in two
 * packages, so they can drift silently — an agent field the backend never reads is invisible
 * until a live run. The verify script parses a representative payload for each tool through
 * these, which turns that drift into a failing check.
 */
export const REQUEST_SCHEMAS = {
  "prompt.compile": promptCompileSchema,
  "run.route": routeSchema,
  "run.estimate": estimateSchema,
  "run.checkpoint": checkpointSchema,
  "mesh.post.gate": gateSchema,
  "asset.score": scoreSchema,
  "image.rembg": rembgSchema,
  "job.submit": jobSubmitSchema,
  "job.await": jobAwaitSchema,
} as const;

type Handler = (body: unknown) => Promise<{ status: number; payload: unknown }>;

const handlers: Partial<Record<ToolId, Handler>> = {
  "prompt.compile": async (body) => {
    const input = promptCompileSchema.parse(body);

    // Screen before validating: refusing early costs nothing.
    const screen = screenSubject({ text: input.text, engine: input.engine });
    if (!screen.ok) {
      return {
        status: 200,
        payload: { ok: false, refuseReason: screen.refuseReason, failCodes: screen.failCodes },
      };
    }

    if (!input.compiled) {
      // The agent is the brain: it writes the structured fields, this endpoint validates
      // them. Rather than inventing values, tell the caller exactly what the contract needs
      // and let it call again. `needsCompile` distinguishes this from a real refusal.
      return {
        status: 200,
        payload: {
          ok: false,
          needsCompile: true,
          warnings: screen.warnings,
          requiredFields: {
            subject: "string",
            parts: "string[]",
            materials: "string[]",
            scale_m: "number, metres, longest dimension",
            ground_contact: "boolean",
            style_lock: "string",
            asset_class: "prop | vehicle | prop-hero — declared, never inferred from keywords",
            profile: "draft | balanced | quality | game_ready",
            t2i_prompt: "string, required on Cloud when needs_t2i",
            i2_3d_intent: {
              geo_brief: "string",
              texture_brief: "string",
              poly_budget_hint: "number",
              needs_transparency: "boolean",
              needs_thin_shell: "boolean",
              needs_liquid_volume: "boolean",
            },
          },
          confidence: "number 0..1 — required; run.route fails closed without it",
        },
      };
    }

    // A class or profile declared by the UI is a contract input, so it fills a gap the
    // compiler left. This is not keyword inference — it never reads the prompt text.
    const raw: Record<string, unknown> = { ...input.compiled };
    if (raw.asset_class === undefined && input.declaredAssetClass) {
      raw.asset_class = input.declaredAssetClass;
    }
    if (raw.profile === undefined && input.profileHint) {
      raw.profile = input.profileHint;
    }

    const validated = validateCompiledPrompt({
      raw: raw as any,
      engine: input.engine,
      needsT2i: input.needsT2i,
    });
    if (!validated.ok) {
      return {
        status: 200,
        payload: { ok: false, refuseReason: validated.refuseReason, failCodes: validated.failCodes },
      };
    }

    // The card is created here because compile is the first stage on both engines, and the
    // asset class it declares is what every later gate reads.
    const existing = await loadJobCard(input.jobId);
    if (!existing) {
      await insertJobCard({
        jobId: input.jobId,
        runId: `${input.jobId}-r1`,
        engine: input.engine,
        profile: validated.compiled.profile,
        assetClass: validated.compiled.assetClass,
      });
    } else if (existing.engine !== input.engine) {
      return {
        status: 409,
        payload: {
          ok: false,
          refuseReason: `Job ${input.jobId} is already bound to engine "${existing.engine}". Engine is immutable.`,
          failCodes: ["CONTRACT"],
        },
      };
    }

    // Persist it: every later stage reads assetClass and scaleM from the card, not the wire.
    await saveCompiledPrompt({
      jobId: input.jobId,
      compiled: validated.compiled,
      confidence: input.confidence ?? null,
    });

    const warnings = [...screen.warnings, ...validated.warnings];
    if (input.confidence === undefined) {
      warnings.push(
        "No confidence supplied. run.route will fail closed rather than assume the compile was understood."
      );
    }

    return { status: 200, payload: { ok: true, compiled: validated.compiled, warnings } };
  },

  "run.route": async (body) => {
    const input = routeSchema.parse(body);
    const card = await loadJobCard(input.jobId);
    if (!card) return { status: 404, payload: { ok: false, error: `No JobCard for ${input.jobId}.` } };
    // Route echoes the card's engine, never the request's — a request cannot switch engines.
    if (card.engine !== input.engine) {
      return {
        status: 409,
        payload: {
          ok: false,
          error: `Job ${input.jobId} is bound to "${card.engine}"; refusing a "${input.engine}" route.`,
          failCodes: ["CONTRACT"],
        },
      };
    }

    const mismatch = runIdMismatch(card.runId, input.runId);
    if (mismatch) return { status: 409, payload: { ok: false, error: mismatch } };

    if (!card.compiled) {
      return {
        status: 409,
        payload: {
          ok: false,
          error: "No CompiledPrompt on the card. Call prompt.compile before routing.",
          failCodes: ["CONTRACT"],
        },
      };
    }

    // Unknown confidence is not high confidence.
    const confidence = input.compileConfidence ?? card.compileConfidence;
    if (typeof confidence !== "number") {
      return {
        status: 200,
        payload: {
          ok: false,
          reason:
            "No compile confidence is recorded for this job. Routing fails closed — re-run prompt.compile with a confidence.",
          failCodes: ["ROUTE_CONFIDENCE"],
          confidence: null,
        },
      };
    }

    const result = planRoute({
      engine: card.engine,
      waterMode: input.waterMode ?? card.waterMode,
      compiled: card.compiled,
      hasReferenceImage: input.hasReferenceImage,
      compileConfidence: confidence,
    });
    return { status: 200, payload: result };
  },

  "run.estimate": async (body) => {
    const input = estimateSchema.parse(body);

    // An explicit plan is honoured for tests and the bench; otherwise the plan is rebuilt
    // from the card so the estimate cannot be based on a cheaper plan than the one that runs.
    if (input.plan) {
      return {
        status: 200,
        payload: estimateRun({
          plan: input.plan as any,
          availableCredits: input.availableCredits ?? Number.POSITIVE_INFINITY,
        }),
      };
    }

    const card = await loadJobCard(input.jobId);
    if (!card) return { status: 404, payload: { ok: false, error: `No JobCard for ${input.jobId}.` } };
    const mismatch = runIdMismatch(card.runId, input.runId);
    if (mismatch) return { status: 409, payload: { ok: false, error: mismatch } };
    if (!card.compiled) {
      return {
        status: 409,
        payload: {
          ok: false,
          error: "No CompiledPrompt on the card. Call prompt.compile before estimating.",
          failCodes: ["CONTRACT"],
        },
      };
    }

    // Estimating is upstream of the confidence gate, so a provisional confidence is used
    // here purely to build a plan. `run.route` still enforces the real floor.
    const planned = planRoute({
      engine: card.engine,
      waterMode: card.waterMode,
      compiled: card.compiled,
      hasReferenceImage: input.hasReferenceImage,
      compileConfidence: card.compileConfidence ?? 1,
    });
    if (!planned.ok) return { status: 200, payload: planned };

    const plan = input.needsT2i === undefined
      ? planned.plan
      : { ...planned.plan, needsT2i: input.needsT2i };

    const estimate = estimateRun({
      plan,
      availableCredits: input.availableCredits ?? Number.POSITIVE_INFINITY,
    });
    return {
      status: 200,
      payload:
        input.availableCredits === undefined
          ? {
              ...estimate,
              affordabilityChecked: false,
              warning:
                "No availableCredits supplied, so this is a cost estimate only. The spend path still checks the balance before submitting.",
            }
          : { ...estimate, affordabilityChecked: true },
    };
  },

  "image.rembg": async (body) => {
    const input = rembgSchema.parse(body);
    const card = await loadJobCard(input.jobId);
    if (!card) return { status: 404, payload: { ok: false, error: `No JobCard for ${input.jobId}.` } };
    const mismatch = runIdMismatch(card.runId, input.runId);
    if (mismatch) return { status: 409, payload: { ok: false, error: mismatch } };

    const { bytes, contentType } = await fetchBytes(input.image);
    const report = await admitReference({ bytes, contentType });

    await addEvidenceCapture({
      jobId: card.jobId,
      runId: card.runId,
      kind: "admission_report",
      uri: input.image,
      meta: {
        admitted: report.admitted,
        maskSource: report.maskSource,
        foregroundRatio: report.foregroundRatio,
        largestBlobRatio: report.largestBlobRatio,
        shortSidePx: report.shortSidePx,
        failCodes: report.failCodes,
      },
    });

    // The mask itself is not returned: it is large, and only the server needs it.
    const { mask: _mask, ...summary } = report;
    return { status: 200, payload: { ok: report.admitted, report: summary } };
  },

  "job.submit": async (body) => {
    const input = jobSubmitSchema.parse(body);
    const card = await loadJobCard(input.jobId);
    if (!card) return { status: 404, payload: { ok: false, error: `No JobCard for ${input.jobId}.` } };
    const mismatch = runIdMismatch(card.runId, input.runId);
    if (mismatch) return { status: 409, payload: { ok: false, error: mismatch } };
    return {
      status: 501,
      payload: {
        ok: false,
        error:
          card.engine === "water"
            ? "Water generate runs as POST /api/water/generate (Clerk + BYOK). That route now compiles, routes, and binds a pack in-process. This tool does not start user jobs."
            : "Cloud job.submit still uses POST /api/3d/generate.",
      },
    };
  },

  "job.await": async (body) => {
    const input = jobAwaitSchema.parse(body);
    const card = await loadJobCard(input.jobId);
    if (!card) return { status: 404, payload: { ok: false, error: `No JobCard for ${input.jobId}.` } };
    const mismatch = runIdMismatch(card.runId, input.runId);
    if (mismatch) return { status: 409, payload: { ok: false, error: mismatch } };
    return {
      status: 501,
      payload: {
        ok: false,
        error:
          card.engine === "water"
            ? "Water jobs are polled via GET /api/water/jobs/:id. This tool surface does not await generation."
            : "Cloud job.await still uses /api/3d polling.",
      },
    };
  },

  "mesh.post.gate": async (body) => {
    const input = gateSchema.parse(body);
    const card = await loadJobCard(input.jobId);
    if (!card) return { status: 404, payload: { ok: false, error: `No JobCard for ${input.jobId}.` } };
    const mismatch = runIdMismatch(card.runId, input.runId);
    if (mismatch) return { status: 409, payload: { ok: false, error: mismatch } };

    if (!input.glb) {
      return { status: 400, payload: { ok: false, error: "glbUri is required." } };
    }

    const { bytes } = await fetchBytes(input.glb);
    const report = runMeshPostGate(bytes, {
      engine: card.engine,
      profile: card.profile,
      assetClass: card.assetClass,
      expectedScaleM: input.expectedScaleM ?? null,
    });

    const codes = hardFailCodes(report);
    await addEvidenceCapture({
      jobId: card.jobId,
      runId: card.runId,
      kind: "gate_report",
      uri: input.glb,
      meta: {
        passed: report.passed,
        findings: report.findings,
        measurements: report.measurements,
        remeshCandidate: report.remeshCandidate,
      },
    });

    const stageId = `${card.engine}-mesh-post` as StageId;
    await checkpointStage(card.jobId, {
      stageId,
      status: report.passed ? "done" : "failed",
      failCodes: report.passed ? undefined : codes,
      artifacts: [input.glb],
    });

    return {
      status: 200,
      payload: {
        ok: report.passed,
        passed: report.passed,
        failCodes: codes,
        findings: report.findings,
        measurements: report.measurements,
        remeshCandidate: report.remeshCandidate,
      },
    };
  },

  "asset.render_views": async (body) => {
    const input = gateSchema.parse(body);
    const card = await loadJobCard(input.jobId);
    if (!card) return { status: 404, payload: { ok: false, error: `No JobCard for ${input.jobId}.` } };
    const mismatch = runIdMismatch(card.runId, input.runId);
    if (mismatch) return { status: 409, payload: { ok: false, error: mismatch } };

    // Capture is illegal before the geometry gate is green — otherwise a reviewer sees
    // pretty turntables of a broken mesh.
    const gate = card.stages.find((s) => s.id === `${card.engine}-mesh-post`);
    if (gate?.status !== "done") {
      return {
        status: 409,
        payload: {
          ok: false,
          error: `${card.engine}-mesh-post has not passed (status: ${gate?.status ?? "unknown"}). Refusing to capture turntables for an ungated mesh.`,
        },
      };
    }

    if (!input.glb) {
      return { status: 400, payload: { ok: false, error: "glbUri is required to render views." } };
    }

    const { bytes } = await fetchBytes(input.glb);
    const result = renderViews(bytes);
    if (result.views.length === 0) {
      return { status: 200, payload: { ok: false, error: result.error ?? "Nothing rendered." } };
    }

    // Persisting the PNGs is the caller's job (S3); the manifest records one row per angle.
    return {
      status: 200,
      payload: {
        ok: true,
        orbitConsistency: result.orbitConsistency,
        meanObjectness: result.meanObjectness,
        views: result.views.map((view) => ({
          angle: view.angle,
          orbitRatio: view.orbitRatio,
          areaRatio: view.areaRatio,
          objectness: view.objectness,
          pngBase64: view.png.toString("base64"),
        })),
      },
    };
  },

  "asset.score": async (body) => {
    const input = scoreSchema.parse(body);
    const card = await loadJobCard(input.jobId);
    if (!card) return { status: 404, payload: { ok: false, error: `No JobCard for ${input.jobId}.` } };
    const mismatch = runIdMismatch(card.runId, input.runId);
    if (mismatch) return { status: 409, payload: { ok: false, error: mismatch } };

    if (!input.glb) {
      return { status: 400, payload: { ok: false, error: "glbUri is required." } };
    }

    const { bytes } = await fetchBytes(input.glb);
    const gate = runMeshPostGate(bytes, {
      engine: card.engine,
      profile: card.profile,
      assetClass: card.assetClass,
      expectedScaleM: input.expectedScaleM ?? null,
    });

    const views = renderViews(bytes);

    let reference = null as Parameters<typeof scoreAsset>[0]["reference"];
    const referenceUri = input.referenceUri ?? input.referenceUrl;
    if (referenceUri) {
      const image = await fetchBytes(referenceUri);
      const admission = await admitReference({ bytes: image.bytes, contentType: image.contentType });
      if (admission.mask) {
        reference = { ...admission.mask, source: "rembg" };
      }
    }

    const manifest = await loadEvidenceManifest(card.jobId, card.runId);
    // Material and part counts feed the part-separation feature.
    const parsedForMeta = (() => {
      try {
        const parsed = parseGlb(bytes);
        return { materialCount: parsed.materials.length, namedParts: parsed.nodeNames };
      } catch {
        return { materialCount: 0, namedParts: [] as string[] };
      }
    })();

    const report = await scoreAsset({
      card,
      gate,
      views,
      reference,
      manifest,
      expectedScaleM: input.expectedScaleM ?? null,
      materialCount: parsedForMeta.materialCount,
      namedParts: parsedForMeta.namedParts,
      bakeRan: input.bakeRan,
      // No VLM adapter is wired: unavailable, which blocks promotion for classes whose
      // identity features are VLM-measured. Fail-closed by design.
    });

    const stageId = `${card.engine}-evaluate` as StageId;
    await checkpointStage(card.jobId, {
      stageId,
      status: report.promoteEligible ? "done" : "failed",
      failCodes: report.promoteEligible ? undefined : (report.failCodes.length ? report.failCodes : ["FIDELITY_FLOOR"]),
      artifacts: [input.glb],
    });
    await setJobCardOutcome(card.jobId, report.promoteEligible ? "promoted" : "rejected");

    const decision = decideRefine({ card, gate, score: report });

    const { comparisonSheet, ...rest } = report;
    return {
      status: 200,
      payload: {
        ok: report.promoteEligible,
        report: rest,
        comparisonSheetBase64: comparisonSheet ? comparisonSheet.toString("base64") : null,
        decision,
      },
    };
  },

  "run.checkpoint": async (body) => {
    const input = checkpointSchema.parse(body);
    const result = await checkpointStage(input.jobId, {
      stageId: input.stageId as StageId,
      status: input.status as StageStatus,
      skipReason: input.skipReason ?? null,
      failCodes: input.failCodes as FailCode[] | undefined,
      artifacts: input.artifacts,
      next: (input.next ?? undefined) as StageId | null | undefined,
    });
    if (result.ok) {
      await supabase.from("jobs").update({ sculpt_pass: input.stageId }).eq("id", input.jobId);
    }
    return result.ok
      ? { status: 200, payload: { ok: true, card: result.card } }
      : { status: 409, payload: { ok: false, error: result.reason } };
  },
};

/** Tools that need a worker this repo does not run yet. Explicit 501 beats a silent stub. */
const NOT_IMPLEMENTED: Partial<Record<ToolId, string>> = {
  "mesh.bake": "The bake worker (reduce → uv → bake → pack → qa) is not built. game_ready cannot be served yet.",
  "experiment.fanout": "Lab fanout is not wired. Run benches manually until it is.",
};

async function handleCreateTool(req: any, res: any) {
  if (!assertAgentAuth(req, res)) return;

  let toolId: ToolId;
  try {
    toolId = assertToolId(req.params.toolId);
  } catch {
    return res.status(400).json({
      error: `Unknown tool id "${req.params.toolId}". The Create tool surface is frozen at 12 ids.`,
      toolIds: TOOL_IDS,
    });
  }

  const notImplemented = NOT_IMPLEMENTED[toolId];
  if (notImplemented) {
    return res.status(501).json({ error: notImplemented, toolId });
  }

  const handler = handlers[toolId];
  if (!handler) {
    return res.status(501).json({ error: `Tool "${toolId}" has no handler yet.`, toolId });
  }

  try {
    const { status, payload } = await handler(req.body);
    return res.status(status).json(payload);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input.", issues: err.issues, toolId });
    }
    logger.error({ err, toolId }, "Create tool call failed");
    return res.status(500).json({ error: err?.message || "Tool call failed.", toolId });
  }
}

/** Canonical path used by eve `callRunApi`: POST /api/create/tools/:toolId */
createToolsRouter.post("/:toolId", handleCreateTool);
/** Alias if a caller still prefixes /tools */
createToolsRouter.post("/tools/:toolId", handleCreateTool);

/** Resume: the JobCard is total state, so a resuming session reads this and nothing else. */
createToolsRouter.get("/jobs/:jobId/card", async (req, res) => {
  if (!assertAgentAuth(req, res)) return;
  try {
    const card = await loadJobCard(req.params.jobId);
    if (!card) return res.status(404).json({ error: `No JobCard for ${req.params.jobId}.` });
    const manifest = await loadEvidenceManifest(card.jobId, card.runId);
    return res.json({ card, manifest });
  } catch (err: any) {
    logger.error({ err }, "Failed to load JobCard");
    return res.status(500).json({ error: err?.message || "Failed to load JobCard." });
  }
});

/** Mint a new runId. Called when generate, remesh, or bake invalidates existing evidence. */
createToolsRouter.post("/jobs/:jobId/run", async (req, res) => {
  if (!assertAgentAuth(req, res)) return;
  try {
    const parsed = z.object({ stageId: z.string().optional() }).parse(req.body ?? {});
    const card = await loadJobCard(req.params.jobId);
    if (!card) return res.status(404).json({ error: `No JobCard for ${req.params.jobId}.` });

    if (parsed.stageId) {
      const allowed = canRefine(card, parsed.stageId as StageId);
      if (!allowed.allowed) return res.status(409).json({ error: allowed.reason });
      await recordRefineAttempt(card.jobId, parsed.stageId as StageId);
    }

    const runId = `${card.jobId}-r${Date.now()}`;
    await bumpRunId(card.jobId, runId);
    return res.json({ ok: true, runId });
  } catch (err: any) {
    logger.error({ err }, "Failed to mint runId");
    return res.status(500).json({ error: err?.message || "Failed to mint runId." });
  }
});

/** Record an evidence capture after the caller has uploaded the bytes. */
createToolsRouter.post("/jobs/:jobId/evidence", async (req, res) => {
  if (!assertAgentAuth(req, res)) return;
  try {
    const parsed = z
      .object({
        kind: z.enum([
          "glb", "gate_report", "turntable", "comparison_sheet",
          "admission_report", "bake_report", "score_report",
        ]),
        uri: z.string().min(1),
        meta: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(req.body);
    const card = await loadJobCard(req.params.jobId);
    if (!card) return res.status(404).json({ error: `No JobCard for ${req.params.jobId}.` });

    await addEvidenceCapture({
      jobId: card.jobId,
      runId: card.runId,
      kind: parsed.kind as CaptureKind,
      uri: parsed.uri,
      meta: parsed.meta,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input.", issues: err.issues });
    }
    logger.error({ err }, "Failed to record evidence");
    return res.status(500).json({ error: err?.message || "Failed to record evidence." });
  }
});

/** Helpers that keep the profile/class parsers reachable from one import site. */
export const createToolParsers = {
  parseProfile,
  assetClassFromContract,
};
export type { CreateProfile, CreateAssetClass };
