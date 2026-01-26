import { supabase } from "../db.js";
import { logger } from "../logger.js";
import { ChatRecord } from "../types.js";
import { normalizePreviewUrl, getDirectS3PreviewImageUrl, getDirectS3ProcessedImageUrl } from "../utils/s3Urls.js";

/**
 * Create a new chat
 */
export async function createChat(params: {
  userId: string;
  name?: string;
}): Promise<ChatRecord> {
  const { userId, name = "New Chat" } = params;

  try {
    const { data, error } = await supabase
      .from("chats")
      .insert({
        user_id: userId,
        name: name,
      })
      .select()
      .single();

    if (error) {
      // Check if table doesn't exist (Supabase error codes: PGRST205, PGRST116, or PostgreSQL 42P01)
      if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST116" || 
          error.message?.includes("relation") || error.message?.includes("does not exist") ||
          error.message?.toLowerCase().includes("table") && error.message?.toLowerCase().includes("not found")) {
        const tableNotFoundError = new Error("Chats table does not exist. Please run the migration.");
        (tableNotFoundError as any).code = "TABLE_NOT_FOUND";
        throw tableNotFoundError;
      }
      // Check if user doesn't exist (foreign key violation)
      if (error.code === "23503" || error.message?.includes("foreign key") || error.message?.includes("violates foreign key constraint")) {
        logger.error({ error, userId }, "User does not exist in users table - cannot create chat");
        throw new Error(`User ${userId} does not exist. Please ensure the user is synced to the database.`);
      }
      // Log the error for debugging
      logger.error({ 
        error, 
        userId, 
        errorCode: error.code, 
        errorMessage: error.message,
        errorDetails: error.details,
        errorHint: error.hint
      }, "Error creating chat");
      throw error;
    }
    if (!data) throw new Error("Failed to create chat");

    return mapRow(data);
  } catch (err: any) {
    // Re-throw table not found errors as-is
    if (err.code === "TABLE_NOT_FOUND") {
      throw err;
    }
    logger.error(err, "Failed to create chat in database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Get a chat by ID
 */
export async function getChat(chatId: string): Promise<ChatRecord | null> {
  try {
    const { data, error } = await supabase
      .from("chats")
      .select("*")
      .eq("id", chatId)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null; // Not found
      throw error;
    }
    if (!data) return null;
    return mapRow(data);
  } catch (err: any) {
    logger.error(err, "Failed to get chat from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Get a chat that belongs to a specific user
 */
export async function getChatForUser(chatId: string, userId: string): Promise<ChatRecord | null> {
  try {
    const { data, error } = await supabase
      .from("chats")
      .select("*")
      .eq("id", chatId)
      .eq("user_id", userId)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    if (!data) return null;
    return mapRow(data);
  } catch (err: any) {
    logger.error(err, "Failed to get chat for user from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * List all chats for a specific user with first job preview
 */
export async function listChatsForUser(userId: string, limit = 50): Promise<(ChatRecord & { firstJobPreviewImageUrl?: string | null; firstJobPrompt?: string | null })[]> {
  try {
    const { data, error } = await supabase
      .from("chats")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) {
      // Check if table doesn't exist
      if (error.code === "42P01" || error.code === "PGRST205" || 
          error.message?.includes("relation") || error.message?.includes("does not exist") ||
          error.message?.toLowerCase().includes("table") && error.message?.toLowerCase().includes("not found")) {
        const tableNotFoundError = new Error("Chats table does not exist. Please run the migration.");
        (tableNotFoundError as any).code = "TABLE_NOT_FOUND";
        throw tableNotFoundError;
      }
      throw error;
    }
    if (!data) return [];
    
    // For each chat, get the first job's preview image and prompt
    const chatsWithPreview = await Promise.all(
      data.map(async (chat) => {
        const chatRecord = mapRow(chat);
        
        // Get the first job for this chat (ordered by created_at)
        const { data: firstJob, error: jobError } = await supabase
          .from("jobs")
          .select("preview_image_url, image_url, prompt")
          .eq("chat_id", chat.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        
        // Ignore errors - chat might not have jobs yet
        if (jobError && jobError.code !== "PGRST116") {
          logger.warn({ err: jobError, chatId: chat.id }, "Error fetching first job for chat");
        }
        
        // Use preview_image_url if available, otherwise fall back to image_url
        let previewImageUrl = firstJob?.preview_image_url || firstJob?.image_url || null;
        
        // Normalize URL to remove expired signed URL parameters and use direct S3 URL
        if (previewImageUrl) {
          // Try to extract jobId from the URL
          const jobIdMatch = previewImageUrl.match(/\/(preview|image)\/([^\/\?]+)/);
          if (jobIdMatch && jobIdMatch[2]) {
            const jobId = jobIdMatch[2];
            // Use normalizePreviewUrl which handles both preview and image paths
            previewImageUrl = normalizePreviewUrl(jobId, previewImageUrl);
          } else if (previewImageUrl.includes('amazonaws.com')) {
            // If we can't extract jobId, at least strip query params
            previewImageUrl = previewImageUrl.split('?')[0];
          }
        }
        
        return {
          ...chatRecord,
          firstJobPreviewImageUrl: previewImageUrl,
          firstJobPrompt: firstJob?.prompt || null,
        };
      })
    );
    
    return chatsWithPreview;
  } catch (err: any) {
    // Re-throw table not found errors as-is
    if (err.code === "TABLE_NOT_FOUND") {
      throw err;
    }
    logger.error(err, "Failed to list chats for user from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Update chat name
 */
export async function updateChatName(chatId: string, name: string, userId: string): Promise<void> {
  try {
    const { error } = await supabase
      .from("chats")
      .update({
        name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", chatId)
      .eq("user_id", userId);

    if (error) throw error;
  } catch (err: any) {
    logger.error(err, "Failed to update chat name");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Delete a chat (only if it belongs to the user)
 */
export async function deleteChat(chatId: string, userId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("chats")
      .delete()
      .eq("id", chatId)
      .eq("user_id", userId);

    if (error) throw error;
    return true;
  } catch (err: any) {
    logger.error(err, "Failed to delete chat from database");
    throw new Error(`Database error: ${err.message}`);
  }
}

/**
 * Get or create the current active chat for a user
 * If no active chat exists, creates a new one
 */
export async function getOrCreateActiveChat(userId: string): Promise<ChatRecord> {
  try {
    // Try to get the most recently updated chat
    const { data, error } = await supabase
      .from("chats")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      // PGRST116 = no rows returned (not found) - this is OK, we'll create a new chat
      if (error.code === "PGRST116") {
        // No chat exists, create a new one
        try {
          return await createChat({ userId, name: "New Chat" });
        } catch (createErr: any) {
          // If createChat fails, log the error and re-throw with more context
          logger.error({ createErr, userId }, "Failed to create chat in getOrCreateActiveChat");
          // Re-throw table not found errors as-is
          if (createErr.code === "TABLE_NOT_FOUND" || createErr.message?.includes("does not exist")) {
            throw createErr;
          }
          throw new Error(`Failed to create chat: ${createErr.message}`);
        }
      }
      // Check if table doesn't exist (Supabase error codes: PGRST205, or PostgreSQL 42P01)
      if (error.code === "42P01" || error.code === "PGRST205" || 
          error.message?.includes("relation") || error.message?.includes("does not exist") ||
          error.message?.toLowerCase().includes("table") && error.message?.toLowerCase().includes("not found")) {
        const tableNotFoundError = new Error("Chats table does not exist. Please run the migration.");
        (tableNotFoundError as any).code = "TABLE_NOT_FOUND";
        throw tableNotFoundError;
      }
      // Log other errors for debugging
      logger.error({ error, userId, errorCode: error.code, errorMessage: error.message }, "Unexpected error querying chats");
      throw error;
    }

    if (data) {
      return mapRow(data);
    }

    // No chat exists, create a new one
    try {
      return await createChat({ userId, name: "New Chat" });
    } catch (createErr: any) {
      // If createChat fails, log the error and re-throw with more context
      logger.error({ createErr, userId }, "Failed to create chat in getOrCreateActiveChat (no data path)");
      // Re-throw table not found errors as-is
      if (createErr.code === "TABLE_NOT_FOUND" || createErr.message?.includes("does not exist")) {
        throw createErr;
      }
      throw new Error(`Failed to create chat: ${createErr.message}`);
    }
  } catch (err: any) {
    // Re-throw table not found errors as-is so route handler can catch them
    if (err.code === "TABLE_NOT_FOUND" || err.message?.includes("does not exist")) {
      throw err;
    }
    logger.error({ err, userId, errorMessage: err.message, errorStack: err.stack }, "Failed to get or create active chat");
    throw new Error(`Database error: ${err.message}`);
  }
}

function mapRow(row: any): ChatRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
