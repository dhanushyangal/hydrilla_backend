import type { BuildPassId, QualityTier, WaterSkillId } from "../../waterSkills.js";
import type { GateResult, SculptSpec, TokenPassBreakdown } from "../../codeSculptPipeline.js";
import type { LlmTokenUsage } from "../../llmProviders.js";

export type PassReviewAction = "continue" | "refine-code" | "refine-spec" | "stop";

export type PassReview = {
  passId: BuildPassId;
  action: PassReviewAction;
  fidelity: number;
  summary: string;
  criteriaScores?: Record<string, number>;
  refined: boolean;
};

export type QualityContract = {
  fidelityBar: "blockout" | "production" | "hero";
  mustHaveDetails: string[];
  forbiddenShortcuts: string[];
  notes?: string;
};

export type RichSculptSpec = SculptSpec & {
  qualityContract?: QualityContract;
  detailInventory?: Array<{ id: string; zone: string; detail: string; mapsTo?: string }>;
  featureReviewTargets?: Array<{ id: string; importance: "critical" | "important"; pass: string }>;
  topologyHints?: string[];
};

export type HarnessProgressPass =
  | "intake"
  | "assessment"
  | "planner"
  | "spec"
  | BuildPassId
  | "review"
  | "evaluate"
  | "done"
  | "partial";

export type StudioPipelineResult = {
  factoryCode: string;
  spec: RichSculptSpec;
  pass: HarnessProgressPass;
  completedPasses: BuildPassId[];
  passReviews: PassReview[];
  specGate: GateResult;
  codeGate: GateResult;
  refined: boolean;
  partial: boolean;
  skillId: WaterSkillId;
  qualityTier: QualityTier;
  tokenUsage: LlmTokenUsage;
  tokenPasses: TokenPassBreakdown[];
};

export type SkillPromptPack = {
  id: WaterSkillId;
  plannerSystemExtra: string;
  passExtras: Partial<Record<BuildPassId, string>>;
  evaluatorCriteria: string[];
  strictSpecExtra: string;
};
