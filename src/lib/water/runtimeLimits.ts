/**
 * Wall-clock limits for one Water generation.
 *
 * WHY THESE NUMBERS
 * A generation runs inside the HTTP function that accepted it (`waitUntil` in
 * routes/codeSculpt.ts). On Vercel that function is killed at `maxDuration`, and a killed
 * run leaves the job in RUN until the stale check below expires it. So the harness budget
 * must always finish *inside* the function limit, with time left to persist the result.
 *
 * - 800 s is the generally-available maximum on Pro/Enterprise with Fluid compute.
 *   1800 s exists but is beta (per-function only, not with Secure Compute / Static IPs).
 * - Fluid compute bills Active CPU only while code runs; time spent waiting on the LLM
 *   (almost all of a Water run) is not billed as CPU, only as cheap provisioned memory.
 *   A long `maxDuration` therefore does not make a Water run expensive — CPU work does.
 *
 * KEEP IN SYNC
 * `FUNCTION_MAX_DURATION_S` must equal `config.maxDuration` in `api/index.ts`. Vercel reads
 * that export statically, so it has to stay a literal there and cannot import this file.
 *
 * WHEN TO CHANGE THIS
 * Move the pass loop onto Vercel Workflow (`"use workflow"` / `"use step"`) once a single
 * run needs more than ~13 minutes, or when a crash mid-run must resume instead of fail.
 * Each pass then becomes a durable step with its own function budget, and these limits
 * only apply per step. That needs a build step for the Workflow SWC transform, which this
 * backend's plain `tsc` build does not have yet.
 */

export const FUNCTION_MAX_DURATION_S = 800;

/** Reserved after the harness returns: GLB checks, DB writes, thumbnail, response log. */
const PERSIST_RESERVE_S = 40;

export const HARNESS_WALL_BUDGET_MS = (FUNCTION_MAX_DURATION_S - PERSIST_RESERVE_S) * 1000;

/**
 * A RUN job with no progress write for this long is treated as dead. Must exceed the
 * longest single stage (Cursor stage cap, 210 s) so a slow but healthy pass is never
 * expired while it is still working.
 */
export const STALE_RUN_MS = 8 * 60 * 1000;
