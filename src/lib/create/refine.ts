/**
 * `*-refine-loop` — the correction controller. Coordinates only; it never generates.
 *
 * The whole reason this is a separate pure module is that the stopping rules are where
 * agent loops burn money. Every decision here is a function of the JobCard and the last
 * report, so it can be tested without a GPU and cannot be argued with by a model.
 *
 * Stage-aware laws (Gwen must-fold):
 *   - Nothing is scheduled past the geometry gate until the gate is green on the CURRENT runId.
 *   - A geometry HARD fail routes to geometry repair or reject. A VLM never overrides it.
 *   - An objectness probe is a request for a targeted look, not a pass grant.
 *   - Re-entry stays inside the session's engine. "Try the other engine" is not an option.
 *
 * Spec: agent-skills/.../skills/cloud/cloud-refine-loop/SKILL.md
 */

import {
  canRefine,
  isHardGeoFail,
  type CreateEngine,
  type FailCode,
  type JobCard,
  type StageId,
} from "./contracts.js";
import type { GateReport } from "./mesh/gate.js";
import type { ScoreReport } from "./score.js";
import { REFINE } from "./quality/thresholds.js";

export type RefineAction =
  /** Promote — the evaluator cleared every floor. */
  | { kind: "promote"; reason: string }
  /** Give up. Terminal. */
  | { kind: "reject"; reason: string; failCodes: FailCode[] }
  /** Re-enter a stage. A new runId is minted when generation or bake output changes. */
  | {
      kind: "reenter";
      stage: StageId;
      reason: string;
      /** True when existing evidence is invalidated and the runId must be re-minted. */
      bumpRunId: boolean;
      /** Narrow instruction for the stage, e.g. which feature to look at. */
      directive: string;
    };

export type RefineDecision = {
  action: RefineAction;
  /** Every rule that fired, in order — this is the audit trail for a rejection. */
  trace: string[];
};

/** Stage ids for the current engine, so re-entry can never name the other engine's stage. */
function stagesFor(engine: CreateEngine) {
  return engine === "cloud"
    ? {
        generate: "cloud-run-pixal" as StageId,
        meshPost: "cloud-mesh-post" as StageId,
        evaluate: "cloud-evaluate" as StageId,
        upstream: "cloud-t2i" as StageId,
      }
    : {
        generate: "water-generate-3d" as StageId,
        meshPost: "water-mesh-post" as StageId,
        evaluate: "water-evaluate" as StageId,
        upstream: "water-generate-3d" as StageId,
      };
}

/**
 * Decide what happens after a gate + score cycle.
 *
 * `previousFidelity` enables the plateau rule: two passes that barely move the number are
 * not worth a third.
 */
export function decideRefine(params: {
  card: JobCard;
  gate: GateReport;
  score: ScoreReport | null;
  previousFidelity?: number | null;
  /** Defect signatures seen on earlier attempts, for the repeated-defect stop. */
  previousFailCodes?: FailCode[][];
}): RefineDecision {
  const trace: string[] = [];
  const stages = stagesFor(params.card.engine);
  const { card, gate, score } = params;

  // --- Geometry first. Always. ---------------------------------------------------
  const gateCodes = gate.findings.filter((f) => f.severity === "hard").map((f) => f.code);
  if (!gate.passed || isHardGeoFail(gateCodes)) {
    trace.push(`Geometry gate HARD fail: ${gateCodes.join(", ") || "gate did not pass"}.`);

    if (score?.scored) {
      // Should be impossible — scoreAsset refuses. Recorded loudly if it ever happens.
      trace.push("WARNING: a score exists for a HARD-failed gate. Ignoring it; a score never overrides geometry.");
    }

    const repeated = countRepeats(params.previousFailCodes ?? [], gateCodes);
    if (repeated >= 2) {
      return {
        action: {
          kind: "reject",
          reason: `The same geometry defect (${gateCodes.join(", ")}) survived ${repeated} correction attempts. Repeated defect — stopping.`,
          failCodes: gateCodes,
        },
        trace,
      };
    }

    // A remeshable defect gets one geometry repair pass before regeneration.
    const target = gate.remeshCandidate ? stages.meshPost : stages.generate;
    const allowed = canRefine(card, target);
    if (!allowed.allowed) {
      return {
        action: {
          kind: "reject",
          reason: `${allowed.reason} Geometry still fails (${gateCodes.join(", ")}).`,
          failCodes: gateCodes,
        },
        trace,
      };
    }

    trace.push(
      gate.remeshCandidate
        ? "Defect is remeshable — one AutoRemesher pass before falling back to regeneration."
        : "Defect is not remeshable — regenerating."
    );
    return {
      action: {
        kind: "reenter",
        stage: target,
        // Remesh and regeneration both change the mesh, so existing evidence is stale.
        bumpRunId: true,
        reason: `Repairing geometry: ${gateCodes.join(", ")}.`,
        directive: gate.findings
          .filter((f) => f.severity === "hard")
          .map((f) => `${f.code}: ${f.detail}`)
          .join(" | "),
      },
      trace,
    };
  }

  trace.push("Geometry gate is green.");

  if (!score) {
    return {
      action: {
        kind: "reenter",
        stage: stages.evaluate,
        bumpRunId: false,
        reason: "Geometry passed but no score exists yet.",
        directive: "Run the evaluator.",
      },
      trace,
    };
  }

  if (score.promoteEligible) {
    trace.push(`Every floor cleared at fidelity ${score.fidelity?.toFixed(2) ?? "n/a"}.`);
    return { action: { kind: "promote", reason: "Evidence complete and all floors met." }, trace };
  }

  trace.push(`Score rejected: ${score.failCodes.join(", ") || "floors not met"}.`);

  // --- Missing evidence is a capture problem, not a quality problem ----------------
  if (score.failCodes.includes("EVIDENCE_INCOMPLETE") && score.failCodes.length === 1) {
    const allowed = canRefine(card, stages.evaluate);
    if (!allowed.allowed) {
      return {
        action: { kind: "reject", reason: `${allowed.reason} Evidence is still incomplete.`, failCodes: score.failCodes },
        trace,
      };
    }
    trace.push("The only problem is evidence coverage — recapturing rather than regenerating.");
    return {
      action: {
        kind: "reenter",
        stage: stages.evaluate,
        bumpRunId: false,
        reason: "Evidence incomplete for the current runId.",
        directive: score.reasons.join(" "),
      },
      trace,
    };
  }

  // --- Plateau --------------------------------------------------------------------
  if (
    typeof params.previousFidelity === "number" &&
    typeof score.fidelity === "number" &&
    Math.abs(score.fidelity - params.previousFidelity) < REFINE.minDelta
  ) {
    return {
      action: {
        kind: "reject",
        reason:
          `Fidelity moved from ${params.previousFidelity.toFixed(3)} to ${score.fidelity.toFixed(3)}, ` +
          `less than the ${REFINE.minDelta} minimum improvement. Plateau — further passes are not worth the spend.`,
        failCodes: score.failCodes,
      },
      trace,
    };
  }

  // --- Not worth refining ---------------------------------------------------------
  if (!score.worthRefining) {
    return {
      action: {
        kind: "reject",
        reason:
          score.fidelity === null
            ? "Fidelity could not be computed — critical evidence is missing and cannot be recovered by refining."
            : `Fidelity ${score.fidelity.toFixed(2)} is below the continue floor ${score.floors.continueAt.toFixed(2)}. Not worth another pass.`,
        failCodes: score.failCodes,
      },
      trace,
    };
  }

  // --- Targeted refine -------------------------------------------------------------
  // An objectness probe asks for a closer look, not for a pass. It re-enters the
  // evaluator, never the promote path.
  const probeOnly = score.tier1?.objectnessProbe === true && score.failCodes.every((c) => c !== "IOU");
  const target = probeOnly ? stages.evaluate : stages.upstream;
  const allowed = canRefine(card, target);
  if (!allowed.allowed) {
    return {
      action: { kind: "reject", reason: `${allowed.reason} Quality floors are still unmet.`, failCodes: score.failCodes },
      trace,
    };
  }

  if (probeOnly) {
    trace.push("IoU is soft-failed but objectness clears the probe floor — requesting a targeted look, not a pass.");
  }

  return {
    action: {
      kind: "reenter",
      stage: target,
      // Re-entering the evaluator reuses the same mesh, so evidence stays valid.
      bumpRunId: !probeOnly,
      reason: `Refining for: ${score.failCodes.join(", ")}.`,
      directive: score.reasons.slice(0, 4).join(" "),
    },
    trace,
  };
}

/** How many earlier attempts carried the same defect signature. */
function countRepeats(history: FailCode[][], current: FailCode[]): number {
  const signature = [...current].sort().join(",");
  let count = 0;
  for (const attempt of history) {
    if ([...attempt].sort().join(",") === signature) count++;
  }
  // The current attempt counts too.
  return count + 1;
}
