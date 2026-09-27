/**
 * Dual-write Water engine tables. Library row remains public.jobs (engine=water).
 * Swallow errors — generate must still succeed if water_* is mid-migrate.
 */

import { supabase } from "../db.js";
import { logger } from "../logger.js";
import type { PassReview } from "../lib/water/harness/types.js";
import type { QualityTier, WaterSkillId } from "../lib/waterSkills.js";
import {
  DEFAULT_SCENE_IR,
  parseMaterialPatch,
  parsePartMaterials,
  parseSceneIR,
  vec3,
  type SceneIR,
  type SceneInstance,
  type SceneMaterialPatch,
  type Vec3,
} from "../lib/water/scene/ir.js";

export type WaterSceneBundle = {
  jobId: string;
  projectId: string;
  sceneId: string;
  assetId: string;
  nodeId: string;
  ir: SceneIR;
  /** This job's instance (resolved by nodeId, not position in the shared scene). */
  instance: SceneInstance;
  meshNames: string[];
  triangleCount: number | null;
  drawCalls: number | null;
  qualityTier: QualityTier | null;
  pack: string | null;
};

async function ensureProject(userId: string, workspaceId?: string | null): Promise<string | null> {
  if (workspaceId) {
    const { data: existing } = await supabase
      .from("water_projects")
      .select("id")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (existing?.id) return existing.id as string;
  } else {
    const { data: existing } = await supabase
      .from("water_projects")
      .select("id")
      .eq("user_id", userId)
      .is("workspace_id", null)
      .maybeSingle();
    if (existing?.id) return existing.id as string;
  }

  const { data, error } = await supabase
    .from("water_projects")
    .insert({
      user_id: userId,
      workspace_id: workspaceId || null,
      name: "Water",
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data?.id as string) || null;
}

type WaterAssetInput = {
  userId: string;
  workspaceId?: string | null;
  jobId: string;
  qualityTier: QualityTier;
  pack: WaterSkillId;
  factoryCode: string;
  spec: unknown;
  meshNames?: string[];
  triangleCount?: number | null;
  drawCalls?: number | null;
};

type SceneNodeRow = {
  id: string;
  name: string | null;
  position: unknown;
  rotation: unknown;
  scale: unknown;
  material: unknown;
};

const NODE_COLUMNS = "id, scene_id, name, position, rotation, scale, material";

/** Node row is the per-job source of truth; `material.parts` holds per-mesh overrides. */
function instanceFromNode(node: SceneNodeRow, assetId: string): SceneInstance {
  const raw =
    node.material && typeof node.material === "object" ? (node.material as Record<string, unknown>) : {};
  const { parts, ...base } = raw;
  return {
    nodeId: node.id,
    assetId,
    name: node.name || "asset",
    position: vec3(node.position, [0, 0, 0]),
    rotation: vec3(node.rotation, [0, 0, 0]),
    scale: vec3(node.scale, [1, 1, 1]),
    material: parseMaterialPatch(base),
    partMaterials: parsePartMaterials(parts),
  };
}

function nodeMaterialJson(instance: SceneInstance): Record<string, unknown> | null {
  const parts = instance.partMaterials || {};
  if (!instance.material && Object.keys(parts).length === 0) return null;
  return { ...(instance.material || {}), parts };
}

function withInstance(ir: SceneIR, instance: SceneInstance, replaceAll: boolean): SceneIR {
  if (replaceAll) return { ...ir, instances: [instance] };
  const exists = ir.instances.some((i) => i.nodeId === instance.nodeId);
  return {
    ...ir,
    instances: exists
      ? ir.instances.map((i) => (i.nodeId === instance.nodeId ? instance : i))
      : [...ir.instances, instance],
  };
}

/**
 * Upsert asset → project scene → node for a job. `replaceInstances` makes this job the
 * scene's only instance (fresh generate); otherwise it is merged in by nodeId.
 */
async function upsertWaterAssetNode(
  params: WaterAssetInput & { replaceInstances: boolean }
): Promise<WaterSceneBundle | null> {
  const projectId = await ensureProject(params.userId, params.workspaceId);
  if (!projectId) return null;

  const meshNames = params.meshNames || [];

  const { data: asset, error: assetErr } = await supabase
    .from("water_assets")
    .upsert(
      {
        project_id: projectId,
        job_id: params.jobId,
        quality_tier: params.qualityTier,
        pack: params.pack,
        spec: params.spec ?? null,
        factory_code: params.factoryCode,
        mesh_names: meshNames,
        triangle_count: params.triangleCount ?? null,
        draw_calls: params.drawCalls ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "job_id" }
    )
    .select("id")
    .single();
  if (assetErr) throw assetErr;
  const assetId = asset.id as string;

  let sceneId: string;
  const { data: existingScene } = await supabase
    .from("water_scenes")
    .select("id, ir")
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let ir = existingScene?.ir ? parseSceneIR(existingScene.ir) : { ...DEFAULT_SCENE_IR, instances: [] };

  if (existingScene?.id) {
    sceneId = existingScene.id as string;
  } else {
    const { data: scene, error: sceneErr } = await supabase
      .from("water_scenes")
      .insert({ project_id: projectId, revision: 1, ir })
      .select("id")
      .single();
    if (sceneErr) throw sceneErr;
    sceneId = scene.id as string;
  }

  const { data: existingNode } = await supabase
    .from("water_scene_nodes")
    .select(NODE_COLUMNS)
    .eq("scene_id", sceneId)
    .eq("asset_id", assetId)
    .maybeSingle();

  let node = existingNode as SceneNodeRow | null;
  if (!node) {
    const { data: inserted, error: nodeErr } = await supabase
      .from("water_scene_nodes")
      .insert({
        scene_id: sceneId,
        asset_id: assetId,
        name: "asset",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      })
      .select(NODE_COLUMNS)
      .single();
    if (nodeErr) throw nodeErr;
    node = inserted as SceneNodeRow;
  }

  const instance = instanceFromNode(node, assetId);
  ir = withInstance(ir, instance, params.replaceInstances);
  const { error: irErr } = await supabase
    .from("water_scenes")
    .update({ ir, updated_at: new Date().toISOString() })
    .eq("id", sceneId);
  if (irErr) throw irErr;

  return {
    jobId: params.jobId,
    projectId,
    sceneId,
    assetId,
    nodeId: node.id,
    ir,
    instance,
    meshNames,
    triangleCount: params.triangleCount ?? null,
    drawCalls: params.drawCalls ?? null,
    qualityTier: params.qualityTier,
    pack: params.pack,
  };
}

export async function persistWaterGenerate(
  params: WaterAssetInput & {
    runId: string;
    modelId: string;
    passReviews: PassReview[];
    durationMs?: number | null;
    tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  }
): Promise<WaterSceneBundle | null> {
  try {
    const bundle = await upsertWaterAssetNode({ ...params, replaceInstances: true });
    if (!bundle) return null;

    const { data: run, error: runErr } = await supabase
      .from("water_runs")
      .upsert(
        {
          job_id: params.jobId,
          scene_id: bundle.sceneId,
          run_id: params.runId,
          quality_tier: params.qualityTier,
          model_id: params.modelId,
          duration_ms: params.durationMs ?? null,
          token_input: params.tokenUsage?.inputTokens ?? null,
          token_output: params.tokenUsage?.outputTokens ?? null,
          token_total: params.tokenUsage?.totalTokens ?? null,
        },
        { onConflict: "run_id" }
      )
      .select("id")
      .single();
    if (runErr) throw runErr;

    if (params.passReviews.length > 0) {
      await supabase.from("water_pass_reviews").insert(
        params.passReviews.map((r) => ({
          run_uuid: run.id,
          pass_id: r.passId,
          action: r.action,
          fidelity: r.fidelity,
          summary: r.summary,
          refined: r.refined,
        }))
      );
    }

    return bundle;
  } catch (err: any) {
    logger.warn({ err: err?.message, jobId: params.jobId }, "water_* persist skipped");
    return null;
  }
}

export async function loadWaterSceneForJob(
  jobId: string,
  userId: string
): Promise<WaterSceneBundle | null> {
  const { data: job } = await supabase.from("jobs").select("id, user_id").eq("id", jobId).maybeSingle();
  if (!job || job.user_id !== userId) return null;

  const { data: asset } = await supabase
    .from("water_assets")
    .select("id, project_id, mesh_names, triangle_count, draw_calls, quality_tier, pack")
    .eq("job_id", jobId)
    .maybeSingle();
  if (!asset) return null;

  const { data: node } = await supabase
    .from("water_scene_nodes")
    .select(NODE_COLUMNS)
    .eq("asset_id", asset.id)
    .maybeSingle();
  if (!node) return null;

  const { data: scene } = await supabase
    .from("water_scenes")
    .select("id, ir")
    .eq("id", node.scene_id)
    .maybeSingle();
  if (!scene) return null;

  const instance = instanceFromNode(node as SceneNodeRow, asset.id);

  return {
    jobId,
    projectId: asset.project_id,
    sceneId: scene.id,
    assetId: asset.id,
    nodeId: node.id,
    ir: withInstance(parseSceneIR(scene.ir), instance, false),
    instance,
    meshNames: Array.isArray(asset.mesh_names) ? (asset.mesh_names as string[]) : [],
    triangleCount: asset.triangle_count ?? null,
    drawCalls: asset.draw_calls ?? null,
    qualityTier: (asset.quality_tier as QualityTier) || null,
    pack: asset.pack || null,
  };
}

const QUALITY_TIERS: QualityTier[] = ["fast", "standard", "studio"];
const WATER_PACKS: WaterSkillId[] = ["object-studio", "character", "animation", "game"];

/** Backfills asset/scene/node rows for jobs generated before the water_* tables existed. */
export async function ensureWaterSceneForJob(
  jobId: string,
  userId: string
): Promise<WaterSceneBundle | null> {
  const existing = await loadWaterSceneForJob(jobId, userId);
  if (existing) return existing;

  const { data: job } = await supabase
    .from("jobs")
    .select("id, user_id, workspace_id, factory_code, sculpt_spec")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || job.user_id !== userId) return null;

  const spec =
    job.sculpt_spec && typeof job.sculpt_spec === "object"
      ? (job.sculpt_spec as Record<string, unknown>)
      : {};
  const qualityRaw = String(spec.qualityTier || spec.quality_tier || "standard");
  const packRaw = String(spec.skillId || spec.pack || "object-studio");
  const visual = spec.visual && typeof spec.visual === "object" ? (spec.visual as { meshNames?: string[] }) : null;

  try {
    return await upsertWaterAssetNode({
      userId,
      workspaceId: (job.workspace_id as string | null) || null,
      jobId,
      qualityTier: (QUALITY_TIERS.includes(qualityRaw as QualityTier) ? qualityRaw : "standard") as QualityTier,
      pack: (WATER_PACKS.includes(packRaw as WaterSkillId) ? packRaw : "object-studio") as WaterSkillId,
      factoryCode: (job.factory_code as string) || "",
      spec,
      meshNames: Array.isArray(visual?.meshNames) ? visual.meshNames : [],
      replaceInstances: false,
    });
  } catch (err: any) {
    logger.warn({ err: err?.message, jobId }, "ensureWaterSceneForJob failed");
    return null;
  }
}

export type WaterSceneOp = "move" | "rotate" | "scale" | "material";

export async function applyWaterSceneOp(params: {
  userId: string;
  jobId: string;
  op: WaterSceneOp;
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  material?: SceneMaterialPatch | null;
  /** Mesh name; when set, `material` is stored as that part's override. */
  partName?: string | null;
}): Promise<WaterSceneBundle | null> {
  const bundle = await ensureWaterSceneForJob(params.jobId, params.userId);
  if (!bundle) return null;

  const instance: SceneInstance = { ...bundle.instance };
  if (params.position) instance.position = params.position;
  if (params.rotation) instance.rotation = params.rotation;
  if (params.scale) instance.scale = params.scale;

  const material = parseMaterialPatch(params.material);
  if (material && params.partName) {
    const parts = instance.partMaterials || {};
    instance.partMaterials = {
      ...parts,
      [params.partName]: { ...parts[params.partName], ...material },
    };
  } else if (material) {
    instance.material = { ...(instance.material || {}), ...material };
  }

  const ir = withInstance(bundle.ir, instance, false);
  const now = new Date().toISOString();

  const { error: nodeErr } = await supabase
    .from("water_scene_nodes")
    .update({
      position: instance.position,
      rotation: instance.rotation,
      scale: instance.scale,
      material: nodeMaterialJson(instance),
      updated_at: now,
    })
    .eq("id", bundle.nodeId);
  if (nodeErr) throw nodeErr;

  const { error: sceneErr } = await supabase
    .from("water_scenes")
    .update({ ir, updated_at: now })
    .eq("id", bundle.sceneId);
  if (sceneErr) throw sceneErr;

  const { error: opErr } = await supabase.from("water_scene_ops").insert({
    scene_id: bundle.sceneId,
    node_id: bundle.nodeId,
    op: params.op,
    payload: {
      partName: params.partName || null,
      position: instance.position,
      rotation: instance.rotation,
      scale: instance.scale,
      material: material || null,
    },
  });
  if (opErr) logger.warn({ err: opErr.message, jobId: params.jobId, op: params.op }, "water_scene_ops insert skipped");

  return { ...bundle, ir, instance };
}

export async function insertWaterMessage(params: {
  jobId: string;
  sceneId?: string | null;
  role: "user" | "assistant";
  content: string;
}): Promise<void> {
  const { error } = await supabase.from("water_messages").insert({
    job_id: params.jobId,
    scene_id: params.sceneId || null,
    role: params.role,
    content: params.content,
  });
  if (error) logger.warn({ error, jobId: params.jobId }, "water_messages insert skipped");
}

export async function listWaterMessages(jobId: string, userId: string) {
  const { data: job } = await supabase.from("jobs").select("id, user_id").eq("id", jobId).maybeSingle();
  if (!job || job.user_id !== userId) return [];
  const { data } = await supabase
    .from("water_messages")
    .select("id, role, content, created_at")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true })
    .limit(80);
  return data || [];
}
