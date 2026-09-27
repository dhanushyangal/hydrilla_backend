/**
 * Asset generate seam. Fast / Standard / Studio stay locked in runStudioPipeline.
 * Cloud callers must not import this module.
 */

import { runStudioPipeline } from "./harness/run.js";

export async function generateWaterAsset(
  params: Parameters<typeof runStudioPipeline>[0]
): Promise<Awaited<ReturnType<typeof runStudioPipeline>>> {
  return runStudioPipeline(params);
}

export type { StudioPipelineResult } from "./harness/types.js";
