import type { StudioPipelineResult } from "../harness/types.js";

export type VisualQaReport = {
  gatePassed: boolean | null;
  fidelity: number | null;
  failCodes: string[];
  promoteEligible: boolean;
  reasons: string[];
  meshNames: string[];
  stillCount: number;
  source: "factory" | "unexecuted" | "none";
};

export function runVisualQa(visual?: StudioPipelineResult["visual"] | null): VisualQaReport {
  if (!visual) {
    return {
      gatePassed: null,
      fidelity: null,
      failCodes: [],
      promoteEligible: false,
      reasons: ["No stills yet. Generate first."],
      meshNames: [],
      stillCount: 0,
      source: "none",
    };
  }
  return {
    gatePassed: visual.gatePassed,
    fidelity: visual.fidelity,
    failCodes: visual.failCodes || [],
    promoteEligible: visual.promoteEligible,
    reasons: visual.reasons || [],
    meshNames: visual.meshNames || [],
    stillCount: visual.turntables?.length || 0,
    source: visual.source,
  };
}
