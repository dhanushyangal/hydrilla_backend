/**
 * Hidden Water Director — follow-ups only ("move it left", "make it red", "how heavy is it").
 * Never shown in the Create bar; generation itself runs in `harness/run.ts`, not here.
 *
 * Two paths:
 * - AI SDK `ToolLoopAgent` when the provider connector exposes a LanguageModel.
 * - One structured JSON call (`callLLMObject`) for connectors without one (Cursor), which
 *   cannot run a tool loop.
 *
 * WHY THIS STAYS ON THE AI SDK (and not the eve `create-water` agent)
 * - BYOK: every call runs on the customer's own key and model. eve binds a model per agent;
 *   serving arbitrary customer keys would mean handing those keys to the eve runtime, which
 *   ADR 0001 forbids (keys never leave this backend).
 * - Cost: a follow-up is 1–6 short steps. eve's durable checkpoints add latency and an
 *   extra service for work that finishes in seconds.
 * - Deployment: eve is a separate Vercel service; its channel only admits Vercel OIDC callers
 *   or custom auth, which this Express backend does not provide today.
 *
 * WHEN TO REVISIT
 * Move follow-ups to eve if they become long multi-turn sessions that must survive restarts,
 * need human approval mid-run (`ctx.ask`), or need a sandbox to execute factory code. Keep
 * this file's tool contracts (`applyIntent` + the four tools) so the swap is mechanical.
 */

import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import { getConnector } from "../../../providers/index.js";
import { parseWaterModelId } from "../../../providers/ids.js";
import { callLLMObject } from "../../../providers/llm.js";
import type { ApiKeyProvider } from "../../../providers/types.js";
import { assertWaterByokModel } from "../cloudFirewall.js";
import { createWaterToolSurface } from "../tools/surface.js";
import { editWaterScene, composeWaterScene, sceneCameraFromBundle } from "./scene.js";
import { runVisualQa, type VisualQaReport } from "./visualQa.js";
import { runPerformanceQa, type PerformanceQaReport } from "./performanceQa.js";
import type { Vec3 } from "../scene/ir.js";

export type DirectorKind = "talk" | "transform" | "refine" | "qa" | "frame";

export type DirectorResult = {
  kind: DirectorKind;
  reply: string;
  refinePrompt?: string;
  scene?: Awaited<ReturnType<typeof composeWaterScene>>;
  visual?: VisualQaReport;
  performance?: PerformanceQaReport;
};

const intentSchema = z.object({
  kind: z.enum(["talk", "transform", "refine", "qa", "frame"]),
  reply: z.string(),
  refinePrompt: z.string().optional(),
  op: z.enum(["move", "rotate", "scale"]).optional(),
  position: z.tuple([z.number(), z.number(), z.number()]).optional(),
  rotation: z.tuple([z.number(), z.number(), z.number()]).optional(),
  scale: z.tuple([z.number(), z.number(), z.number()]).optional(),
  color: z.string().optional(),
  roughness: z.number().optional(),
  metalness: z.number().optional(),
});

type Intent = z.infer<typeof intentSchema>;

function asVec3(v?: [number, number, number] | null): Vec3 | undefined {
  if (!v) return undefined;
  return [v[0], v[1], v[2]];
}

async function applyIntent(
  intent: Intent,
  ctx: { userId: string; jobId: string; visual?: VisualQaReport | null }
): Promise<DirectorResult> {
  if (intent.kind === "transform") {
    const scene = await editWaterScene({
      userId: ctx.userId,
      jobId: ctx.jobId,
      op: intent.op || "move",
      position: asVec3(intent.position),
      rotation: asVec3(intent.rotation),
      scale: asVec3(intent.scale),
      material:
        intent.color || intent.roughness != null || intent.metalness != null
          ? {
              color: intent.color,
              roughness: intent.roughness,
              metalness: intent.metalness,
            }
          : null,
    });
    return {
      kind: "transform",
      reply: intent.reply || "Updated the instance.",
      scene,
    };
  }
  if (intent.kind === "qa") {
    const scene = await composeWaterScene({ userId: ctx.userId, jobId: ctx.jobId });
    const performance = runPerformanceQa({
      triangleCount: scene?.triangleCount,
      drawCalls: scene?.drawCalls,
      meshNames: scene?.meshNames,
    });
    const visual = ctx.visual || runVisualQa(null);
    return {
      kind: "qa",
      reply: intent.reply || performance.suggestions[0] || "QA complete.",
      scene,
      visual,
      performance,
    };
  }
  if (intent.kind === "frame") {
    const scene = await composeWaterScene({ userId: ctx.userId, jobId: ctx.jobId });
    const exp = sceneCameraFromBundle(scene);
    return {
      kind: "frame",
      reply: intent.reply || "Framed the camera. Pose stays static.",
      scene,
      visual: ctx.visual || undefined,
      performance: runPerformanceQa({
        triangleCount: scene?.triangleCount,
        drawCalls: scene?.drawCalls,
        meshNames: scene?.meshNames || exp.sockets,
      }),
    };
  }
  if (intent.kind === "refine") {
    return {
      kind: "refine",
      reply: intent.reply || "I'll refine the factory from your note.",
      refinePrompt: intent.refinePrompt || intent.reply,
    };
  }
  return { kind: "talk", reply: intent.reply || "Say how to move it, or what to change." };
}

export async function runWaterDirector(params: {
  userId: string;
  jobId: string;
  message: string;
  modelId: string;
  apiKey: string;
  visual?: VisualQaReport | null;
}): Promise<DirectorResult> {
  assertWaterByokModel(params.modelId);
  const parsed = parseWaterModelId(params.modelId);
  if (!parsed) {
    throw new Error("Select a bring-your-own model for Water");
  }
  const connector = getConnector(parsed.provider as ApiKeyProvider);
  const surface = createWaterToolSurface({ userId: params.userId });

  const applyTransform = tool({
    description: "Move, rotate, or scale the scene instance. Does not rewrite factory source.",
    inputSchema: z.object({
      op: z.enum(["move", "rotate", "scale"]),
      position: z.tuple([z.number(), z.number(), z.number()]).optional(),
      rotation: z.tuple([z.number(), z.number(), z.number()]).optional(),
      scale: z.tuple([z.number(), z.number(), z.number()]).optional(),
      color: z.string().optional(),
      roughness: z.number().min(0).max(1).optional(),
      metalness: z.number().min(0).max(1).optional(),
      reply: z.string(),
    }),
    execute: async (input) =>
      applyIntent({ kind: "transform", ...input }, { userId: params.userId, jobId: params.jobId }),
  });

  const inspectQa = tool({
    description: "Read visual stills and performance (triangles, draw calls). Never skip this for QA questions.",
    inputSchema: z.object({ reply: z.string() }),
    execute: async ({ reply }) =>
      applyIntent({ kind: "qa", reply }, { userId: params.userId, jobId: params.jobId, visual: params.visual }),
  });

  const requestRefine = tool({
    description: "Ask for a factory refine (color, extra parts). Client re-runs generateWaterAsset.",
    inputSchema: z.object({
      refinePrompt: z.string(),
      reply: z.string(),
    }),
    execute: async ({ refinePrompt, reply }) =>
      applyIntent(
        { kind: "refine", refinePrompt, reply },
        { userId: params.userId, jobId: params.jobId }
      ),
  });

  const frameCamera = tool({
    description: "Frame camera on named sockets. Pose stays static — no idle tick.",
    inputSchema: z.object({ reply: z.string() }),
    execute: async ({ reply }) =>
      applyIntent({ kind: "frame", reply }, { userId: params.userId, jobId: params.jobId }),
  });

  const instructions = `You coordinate Water follow-ups. Hidden from the user.
Classify: transform (move/rotate/scale/color scalars on the instance), refine (new geometry or materials that need a factory pass), qa (how it looks / how heavy), frame (camera), talk.
Do not regenerate the whole asset for "move it left".
Do not skip inspectQa when the user asks about quality or performance.
Never mention Director, Scene IR, JobCard, or tool names. Say Follow up, Parts, Move, Time.
Pose is static.`;

  if (connector.generateTextDirect) {
    const { output } = await callLLMObject({
      provider: parsed.provider,
      modelId: params.modelId,
      apiKey: params.apiKey,
      system: instructions + "\nReturn ONLY JSON matching the intent schema.",
      userText: params.message,
      schema: intentSchema,
      maxTokens: 800,
      timeoutMs: 45_000,
    });
    return applyIntent(output, {
      userId: params.userId,
      jobId: params.jobId,
      visual: params.visual,
    });
  }

  const model = connector.createModel(params.apiKey, parsed.nativeId);
  const agent = new ToolLoopAgent({
    model,
    instructions,
    tools: {
      applyTransform,
      inspectQa,
      requestRefine,
      frameCamera,
      "prompt.compile": surface["prompt.compile"],
      "run.route": surface["run.route"],
    },
    stopWhen: isStepCount(6),
    prepareStep: async ({ stepNumber }) => {
      if (stepNumber === 0) {
        return { toolChoice: "required" as const };
      }
      return {};
    },
  });

  const result = await agent.generate({ prompt: params.message });
  // AI SDK v5+ returns a tool's value on `.output` (it was `.result` before v5). Only the four
  // director tools return a DirectorResult; prompt.compile / run.route outputs are skipped.
  const toolOut = result.steps
    .flatMap((step) => step.toolResults)
    .map((toolResult) => toolResult.output as Partial<DirectorResult> | undefined)
    .reverse()
    .find((output): output is DirectorResult => typeof output?.kind === "string" && typeof output.reply === "string");
  if (toolOut) return toolOut;

  return {
    kind: "talk",
    reply: result.text?.trim() || "Say how to move it, or what to change.",
  };
}
