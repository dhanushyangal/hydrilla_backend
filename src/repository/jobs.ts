import { supabase } from "../db.js";
import { GenerateType, JobRecord, JobStatus, PolygonType } from "../types.js";
import { logger } from "../logger.js";
import { normalizeGlbUrl, normalizePreviewUrl } from "../utils/s3Urls.js";

export async function createJob(params: {
  id: string;
  userId?: string | null;  // Owner of the job
  chatId?: string | null;  // Chat this job belongs to
  workspaceId?: string | null;  // Workspace this job belongs to
  parentJobId?: string | null;  // Primary parent job for iterative prompting lineage
  parentJobIds?: string[];       // All parent IDs (for multi-parent merges like combined edits)
  prompt?: string | null;
  imageUrl?: string | null;
  sourceImages?: string[] | null; // Actual source image URLs used as input
  generateType: GenerateType;
  faceCount?: number | null;
  enablePBR?: boolean;
  polygonType?: PolygonType | null;
  status?: JobStatus;  // Optional initial status (defaults to "WAIT")
}) {
  const {
    id,
    userId = null,
    chatId = null,
    workspaceId = null,
    parentJobId = null,
    parentJobIds = [],
    prompt = null,
    imageUrl = null,
    sourceImages = null,
    generateType,
    faceCount = null,
    enablePBR = true,
    polygonType = null,
    status = "WAIT",
  } = params;

  try {
    // Canonical parent list: explicit array > single parent > empty
    const allParentIds = parentJobIds.length > 0 ? parentJobIds : (parentJobId ? [parentJobId] : []);
    // Denormalized first-parent for legacy compat (column kept for simple queries)
    const firstParentId = allParentIds.length > 0 ? allParentIds[0] : null;

    const { error } = await supabase.from("jobs").insert({
      id,
      user_id: userId,
      chat_id: chatId,
      workspace_id: workspaceId,
      parent_job_id: firstParentId,
      status: status,
      prompt,
      image_url: imageUrl,
      source_images: sourceImages && sourceImages.length > 0 ? JSON.stringify(sourceImages) : null,
      generate_type: generateType,
      face_count: faceCount,
      enable_pbr: enablePBR,
      polygon_type: polygonType,
    });

    if (error) throw error;

    // Junction table is the source of truth for all parent relationships
    if (allParentIds.length > 0) {
      await upsertJobParents(id, allParentIds);
    }
  } catch (err: any) {
    logger.error(err, "Failed to create job in database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Insert/update parent relationships in the job_parents junction table.
 */
export async function upsertJobParents(jobId: string, parentIds: string[]): Promise<void> {
  if (!parentIds || parentIds.length === 0) return;
  try {
    const rows = parentIds.map((pid, idx) => ({
      job_id: jobId,
      parent_job_id: pid,
      slot: idx + 1,
    }));
    const { error } = await supabase
      .from("job_parents")
      .upsert(rows, { onConflict: "job_id,parent_job_id" });
    if (error) throw error;
  } catch (err: any) {
    // Non-critical: log and continue (table may not exist yet if migration hasn't run)
    logger.warn({ err, jobId, parentIds }, "Failed to upsert job_parents (non-critical)");
  }
}

/**
 * Get all parent job IDs for a given job from the junction table.
 */
export async function getJobParentIds(jobId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("job_parents")
      .select("parent_job_id, slot")
      .eq("job_id", jobId)
      .order("slot", { ascending: true });
    if (error) throw error;
    return (data || []).map((r: any) => r.parent_job_id);
  } catch {
    // Table may not exist yet — return empty
    return [];
  }
}

export async function updateJobStatus(jobId: string, data: { status: JobStatus; errorCode?: string | null; errorMessage?: string | null }) {
  const { status, errorCode = null, errorMessage = null } = data;
  try {
    const { error } = await supabase
      .from("jobs")
      .update({
        status,
        error_code: errorCode,
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    if (error) throw error;
  } catch (err: any) {
    logger.error(err, "Failed to update job status");
    throw new Error(`Database error: ${err.message}`);
  }
}

export async function updateJobResult(jobId: string, data: { resultGlbUrl?: string | null; previewImageUrl?: string | null }) {
  const { resultGlbUrl = null, previewImageUrl = null } = data;
  try {
    const { error } = await supabase
      .from("jobs")
      .update({
        result_glb_url: resultGlbUrl,
        preview_image_url: previewImageUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    if (error) throw error;
  } catch (err: any) {
    logger.error(err, "Failed to update job result");
    throw new Error(`Database error: ${err.message}`);
  }
}

export async function updateJobName(jobId: string, name: string, userId?: string | null): Promise<void> {
  try {
    const updateData: any = {
      name,
      updated_at: new Date().toISOString(),
    };

    // If userId is provided, ensure the job belongs to the user
    const query = supabase
      .from("jobs")
      .update(updateData)
      .eq("id", jobId);

    if (userId) {
      query.eq("user_id", userId);
    }

    const { error } = await query;

    if (error) throw error;
  } catch (err: any) {
    logger.error(err, "Failed to update job name");
    throw new Error(`Database error: ${err.message}`);
  }
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  try {
    const { data, error } = await supabase.from("jobs").select("*").eq("id", jobId).single();
    if (error) {
      if (error.code === "PGRST116") return null; // Not found
      throw error;
    }
    if (!data) return null;
    return mapRow(data);
  } catch (err: any) {
    logger.error(err, "Failed to get job from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Get a job that belongs to a specific user
 */
export async function getJobForUser(jobId: string, userId: string): Promise<JobRecord | null> {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("id", jobId)
      .or(`user_id.eq.${userId},user_id.is.null`)  // User's jobs or legacy jobs without user_id
      .single();
      
    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    if (!data) return null;
    return mapRow(data);
  } catch (err: any) {
    logger.error(err, "Failed to get job for user from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * List all jobs (for admin or service role)
 */
export async function listJobs(limit = 50): Promise<JobRecord[]> {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (!data) return [];
    return data.map(mapRow);
  } catch (err: any) {
    logger.error(err, "Failed to list jobs from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * List jobs for a specific user
 */
export async function listJobsForUser(userId: string, limit = 50): Promise<JobRecord[]> {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (!data) return [];
    return data.map(mapRow);
  } catch (err: any) {
    logger.error(err, "Failed to list jobs for user from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Get jobs that need status sync (pending or running jobs)
 */
export async function getJobsToSync(): Promise<JobRecord[]> {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .in("status", ["WAIT", "RUN"])
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;
    if (!data) return [];
    return data.map(mapRow);
  } catch (err: any) {
    logger.error(err, "Failed to get jobs to sync from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Delete a job (only if it belongs to the user)
 */
export async function deleteJob(jobId: string, userId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("jobs")
      .delete()
      .eq("id", jobId)
      .eq("user_id", userId);

    if (error) throw error;
    return true;
  } catch (err: any) {
    logger.error(err, "Failed to delete job from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

function mapRow(row: any): JobRecord {
  // Normalize URLs to remove expired signed URL parameters
  let imageUrl = row.image_url;
  let previewImageUrl = row.preview_image_url;
  let resultGlbUrl = row.result_glb_url;
  
  // Normalize image URLs
  if (imageUrl && imageUrl.includes('amazonaws.com')) {
    imageUrl = imageUrl.split('?')[0]; // Strip query params
  }
  if (previewImageUrl) {
    previewImageUrl = normalizePreviewUrl(row.id, previewImageUrl);
  }
  if (resultGlbUrl) {
    resultGlbUrl = normalizeGlbUrl(row.id, resultGlbUrl);
  }

  // Parse source_images JSONB
  let sourceImages: string[] | null = null;
  if (row.source_images) {
    try {
      sourceImages = typeof row.source_images === "string" ? JSON.parse(row.source_images) : row.source_images;
    } catch { sourceImages = null; }
  }
  
  return {
    id: row.id,
    userId: row.user_id || null,
    chatId: row.chat_id || null,
    workspaceId: row.workspace_id || null,
    parentJobId: row.parent_job_id || null,
    parentJobIds: [],  // Populated separately via getJobParentIds when needed
    status: row.status,
    prompt: row.prompt,
    imageUrl: imageUrl,
    sourceImages,
    generateType: row.generate_type,
    faceCount: row.face_count,
    enablePBR: row.enable_pbr,
    polygonType: row.polygon_type,
    resultGlbUrl: resultGlbUrl,
    previewImageUrl: previewImageUrl,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    name: row.name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Get the full lineage DAG for a job (from all roots to the given job).
 * Uses a single recursive SQL function (get_job_lineage) instead of N+1 queries.
 * Returns jobs in topological order (roots first, target last).
 */
export async function getJobLineage(jobId: string): Promise<JobRecord[]> {
  try {
    // Use the recursive Postgres function — 1 query instead of N+1
    const { data, error } = await supabase.rpc("get_job_lineage", {
      target_job_id: jobId,
    });

    if (!error && data && data.length > 0) {
      return data.map((row: any) => {
        const job = mapRow(row);
        // The RPC returns parent_job_ids as an array already
        job.parentJobIds = row.parent_job_ids || (job.parentJobId ? [job.parentJobId] : []);
        return job;
      });
    }

    // Fallback: if RPC fails (function not deployed yet), use the old N+1 approach
    if (error) {
      logger.warn({ err: error, jobId }, "get_job_lineage RPC failed, falling back to N+1 queries");
    }
    return getJobLineageFallback(jobId);
  } catch (err: any) {
    logger.warn({ err, jobId }, "getJobLineage exception, falling back to N+1 queries");
    return getJobLineageFallback(jobId);
  }
}

/**
 * Fallback N+1 lineage traversal (used when the recursive SQL function isn't deployed yet).
 */
async function getJobLineageFallback(jobId: string): Promise<JobRecord[]> {
  const visited = new Map<string, JobRecord>();
  const queue: string[] = [jobId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;

    const job = await getJob(currentId);
    if (!job) continue;

    const parentIds = await getJobParentIds(currentId);
    job.parentJobIds = parentIds.length > 0 ? parentIds : (job.parentJobId ? [job.parentJobId] : []);
    visited.set(currentId, job);

    for (const pid of job.parentJobIds) {
      if (!visited.has(pid)) queue.push(pid);
    }
    if (job.parentJobId && !visited.has(job.parentJobId)) {
      queue.push(job.parentJobId);
    }
  }

  // Topological sort (roots first)
  const sorted: JobRecord[] = [];
  const inSorted = new Set<string>();

  function addJob(id: string) {
    if (inSorted.has(id)) return;
    const job = visited.get(id);
    if (!job) return;
    for (const pid of job.parentJobIds) addJob(pid);
    inSorted.add(id);
    sorted.push(job);
  }

  addJob(jobId);
  return sorted;
}
