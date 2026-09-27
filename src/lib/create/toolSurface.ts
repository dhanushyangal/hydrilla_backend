/**
 * Create tool surface — exactly 12 IDs, frozen.
 *
 * Contract: docs/contracts/TOOL_SURFACE.md
 *
 * There is no 13th ID. New capability folds in behind an existing tool as a worker
 * (t2i behind job.submit, remesh behind mesh.post.gate, sheet composition behind
 * asset.score) or it does not ship.
 */

export const TOOL_IDS = [
  "prompt.compile",
  "run.estimate",
  "run.route",
  "image.rembg",
  "job.submit",
  "job.await",
  "mesh.post.gate",
  "mesh.bake",
  "asset.render_views",
  "asset.score",
  "run.checkpoint",
  "experiment.fanout",
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

/** brain decides · hands produce · evaluator promotes · session records. */
export type ToolRole = "brain" | "hands" | "evaluator" | "session" | "lab";

export const TOOL_ROLE: Record<ToolId, ToolRole> = {
  "prompt.compile": "brain",
  "run.estimate": "brain",
  "run.route": "brain",
  "image.rembg": "hands",
  "job.submit": "hands",
  "job.await": "hands",
  "mesh.post.gate": "hands",
  "mesh.bake": "hands",
  "asset.render_views": "hands",
  "asset.score": "evaluator",
  "run.checkpoint": "session",
  "experiment.fanout": "lab",
};

const TOOL_ID_SET = new Set<string>(TOOL_IDS);

export function isToolId(value: string): value is ToolId {
  return TOOL_ID_SET.has(value);
}

/** Throws on anything outside the frozen surface — call this at registration time. */
export function assertToolId(value: string): ToolId {
  if (!isToolId(value)) {
    throw new Error(
      `Unknown tool id "${value}". The Create tool surface is frozen at 12 ids; fold new capability behind an existing tool.`
    );
  }
  return value;
}

/** Only the evaluator may promote. Guards against generator self-promotion. */
export function canPromote(toolId: ToolId): boolean {
  return TOOL_ROLE[toolId] === "evaluator";
}
