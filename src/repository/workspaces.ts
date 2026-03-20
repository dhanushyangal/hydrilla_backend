import { supabase } from "../db.js";
import { logger } from "../logger.js";
import { WorkspaceRecord } from "../types.js";
import { normalizePreviewUrl } from "../utils/s3Urls.js";

// Soft-delete marker.
// We keep the workspace row so jobs.workspace_id does NOT become NULL (DB uses ON DELETE SET NULL),
// which would otherwise affect credits calculations.
const DELETED_WORKSPACE_NAME_PREFIX = "__DELETED_WORKSPACE__:";

function isSoftDeletedWorkspaceName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(DELETED_WORKSPACE_NAME_PREFIX);
}

/**
 * Create a new workspace
 */
export async function createWorkspace(params: {
  userId: string;
  name?: string;
}): Promise<WorkspaceRecord> {
  const { userId, name = "Untitled Workspace" } = params;

  try {
    const { data, error } = await supabase
      .from("workspaces")
      .insert({
        user_id: userId,
        name: name,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205" ||
          error.message?.includes("relation") || error.message?.includes("does not exist")) {
        const tableNotFoundError = new Error("Workspaces table does not exist. Please run the migration.");
        (tableNotFoundError as any).code = "TABLE_NOT_FOUND";
        throw tableNotFoundError;
      }
      if (error.code === "23503") {
        logger.error({ error, userId }, "User does not exist - cannot create workspace");
        throw new Error(`User ${userId} does not exist.`);
      }
      logger.error({ error, userId }, "Error creating workspace");
      throw error;
    }
    if (!data) throw new Error("Failed to create workspace");

    return mapRow(data);
  } catch (err: any) {
    if (err.code === "TABLE_NOT_FOUND") throw err;
    logger.error(err, "Failed to create workspace in database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Get a workspace by ID
 */
export async function getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
  try {
    const { data, error } = await supabase
      .from("workspaces")
      .select("*")
      .eq("id", workspaceId)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    if (!data) return null;
    if (isSoftDeletedWorkspaceName((data as any).name)) return null;
    return mapRow(data);
  } catch (err: any) {
    logger.error(err, "Failed to get workspace from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Get a workspace that belongs to a specific user
 */
export async function getWorkspaceForUser(workspaceId: string, userId: string): Promise<WorkspaceRecord | null> {
  try {
    const { data, error } = await supabase
      .from("workspaces")
      .select("*")
      .eq("id", workspaceId)
      .eq("user_id", userId)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    if (!data) return null;
    if (isSoftDeletedWorkspaceName((data as any).name)) return null;
    return mapRow(data);
  } catch (err: any) {
    logger.error(err, "Failed to get workspace for user");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * List all workspaces for a specific user, with first job preview image.
 * Uses batched queries (2 extra queries total) instead of N+1 for better performance.
 */
export async function listWorkspacesForUser(userId: string, limit = 50): Promise<(WorkspaceRecord & { firstJobPreviewImageUrl?: string | null; firstJobPrompt?: string | null; jobCount?: number })[]> {
  try {
    const { data, error } = await supabase
      .from("workspaces")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205" ||
          error.message?.includes("relation") || error.message?.includes("does not exist")) {
        const tableNotFoundError = new Error("Workspaces table does not exist. Please run the migration.");
        (tableNotFoundError as any).code = "TABLE_NOT_FOUND";
        throw tableNotFoundError;
      }
      throw error;
    }
    if (!data || data.length === 0) return [];

    // Hide soft-deleted workspaces (so "deleted workspace" doesn't reappear in My Library).
    const activeWorkspaces = data.filter((ws) => !isSoftDeletedWorkspaceName((ws as any).name));
    if (activeWorkspaces.length === 0) return [];

    const workspaceIds = activeWorkspaces.map((ws) => ws.id);

    // Single batched query: all jobs in these workspaces, ordered by created_at (for "first job" per workspace)
    const { data: jobsData, error: jobsError } = await supabase
      .from("jobs")
      .select("workspace_id, preview_image_url, image_url, prompt, created_at")
      .in("workspace_id", workspaceIds)
      .order("created_at", { ascending: true });

    if (jobsError) {
      logger.warn({ err: jobsError }, "Error fetching jobs for workspaces batch");
    }

    // First job per workspace (already ordered by created_at asc)
    const firstJobByWorkspace: Record<string, { preview_image_url?: string; image_url?: string; prompt?: string }> = {};
    if (jobsData) {
      for (const job of jobsData) {
        const wid = job.workspace_id;
        if (wid && !firstJobByWorkspace[wid]) {
          firstJobByWorkspace[wid] = {
            preview_image_url: job.preview_image_url,
            image_url: job.image_url,
            prompt: job.prompt,
          };
        }
      }
    }

    // Job counts per workspace (single query then group in memory)
    const jobCountByWorkspace: Record<string, number> = {};
    if (jobsData) {
      for (const job of jobsData) {
        const wid = job.workspace_id;
        if (wid) jobCountByWorkspace[wid] = (jobCountByWorkspace[wid] || 0) + 1;
      }
    }

    const workspacesWithPreview = activeWorkspaces.map((ws) => {
      const record = mapRow(ws);
      const firstJob = firstJobByWorkspace[ws.id];
      let previewImageUrl = firstJob?.preview_image_url || firstJob?.image_url || null;
      if (previewImageUrl) {
        const jobIdMatch = previewImageUrl.match(/\/(preview|image|edit|combined)\/([^\/\?]+)/);
        if (jobIdMatch && jobIdMatch[2]) {
          previewImageUrl = normalizePreviewUrl(jobIdMatch[2], previewImageUrl);
        } else if (previewImageUrl.includes("amazonaws.com")) {
          previewImageUrl = previewImageUrl.split("?")[0];
        }
      }
      return {
        ...record,
        firstJobPreviewImageUrl: previewImageUrl,
        firstJobPrompt: firstJob?.prompt || null,
        jobCount: jobCountByWorkspace[ws.id] ?? 0,
      };
    });

    return workspacesWithPreview;
  } catch (err: any) {
    if (err.code === "TABLE_NOT_FOUND") throw err;
    logger.error(err, "Failed to list workspaces for user");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * List all jobs for a specific workspace
 */
export async function listJobsForWorkspace(workspaceId: string, userId: string, limit = 100): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (!data) return [];
    return data;
  } catch (err: any) {
    logger.error(err, "Failed to list jobs for workspace");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Update workspace name
 */
export async function updateWorkspaceName(workspaceId: string, name: string, userId: string): Promise<void> {
  try {
    // Prevent updates to soft-deleted workspaces (otherwise they could be "resurrected").
    const { data: current } = await supabase
      .from("workspaces")
      .select("name")
      .eq("id", workspaceId)
      .eq("user_id", userId)
      .maybeSingle();

    if (current && isSoftDeletedWorkspaceName((current as any).name)) {
      throw new Error("Workspace is deleted");
    }

    const { error } = await supabase
      .from("workspaces")
      .update({
        name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", workspaceId)
      .eq("user_id", userId);

    if (error) throw error;
  } catch (err: any) {
    logger.error(err, "Failed to update workspace name");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Touch workspace's updated_at
 */
export async function updateWorkspaceUpdatedAt(workspaceId: string): Promise<void> {
  try {
    const { error } = await supabase
      .from("workspaces")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", workspaceId);

    if (error) throw error;
  } catch (err: any) {
    logger.error(err, "Failed to update workspace updated_at");
    // Non-fatal
  }
}

/**
 * Delete a workspace (only if it belongs to the user)
 * Soft-deletes (renames) instead of deleting to avoid ON DELETE SET NULL on jobs.workspace_id,
 * which can otherwise cause credits to appear restored.
 */
export async function deleteWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  try {
    // Soft-delete to avoid ON DELETE SET NULL on jobs.workspace_id.
    // Real deletion would detach jobs from the workspace and can lead to credits appearing restored.
    const { error } = await supabase
      .from("workspaces")
      .update({
        name: `${DELETED_WORKSPACE_NAME_PREFIX}${workspaceId}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", workspaceId)
      .eq("user_id", userId);

    if (error) throw error;
    return true;
  } catch (err: any) {
    logger.error(err, "Failed to delete workspace");
    throw new Error(`Database error: ${err.message}`);
  }
}

function mapRow(row: any): WorkspaceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
