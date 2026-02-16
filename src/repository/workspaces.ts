import { supabase } from "../db.js";
import { logger } from "../logger.js";
import { WorkspaceRecord } from "../types.js";
import { normalizePreviewUrl } from "../utils/s3Urls.js";

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
    return mapRow(data);
  } catch (err: any) {
    logger.error(err, "Failed to get workspace for user");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * List all workspaces for a specific user, with first job preview image
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
    if (!data) return [];

    // For each workspace, get preview info from first job
    const workspacesWithPreview = await Promise.all(
      data.map(async (ws) => {
        const record = mapRow(ws);

        // Get the first job for this workspace
        const { data: firstJob, error: jobError } = await supabase
          .from("jobs")
          .select("preview_image_url, image_url, prompt")
          .eq("workspace_id", ws.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (jobError && jobError.code !== "PGRST116") {
          logger.warn({ err: jobError, workspaceId: ws.id }, "Error fetching first job for workspace");
        }

        // Count total jobs in workspace
        const { count, error: countError } = await supabase
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", ws.id);

        if (countError) {
          logger.warn({ err: countError, workspaceId: ws.id }, "Error counting jobs for workspace");
        }

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
          jobCount: count || 0,
        };
      })
    );

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
 * Jobs in this workspace will have workspace_id set to NULL (ON DELETE SET NULL)
 */
export async function deleteWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("workspaces")
      .delete()
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
