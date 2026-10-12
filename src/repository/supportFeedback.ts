import { supabase } from "../db.js";
import { logger } from "../logger.js";

export type SupportType = "issue" | "feedback";
export type SupportStatus = "open" | "in_progress" | "resolved" | "closed";

export type SupportFeedbackRow = {
  id: string;
  type: SupportType;
  request_type: string | null;
  message: string;
  attachment_url: string | null;
  attachment_name: string | null;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  page_url: string | null;
  metadata: Record<string, unknown> | null;
  status: SupportStatus;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateSupportFeedbackParams = {
  type: SupportType;
  request_type?: string | null;
  message: string;
  attachment_url?: string | null;
  attachment_name?: string | null;
  user_id?: string | null;
  user_email?: string | null;
  user_name?: string | null;
  page_url?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ListSupportFeedbackOptions = {
  type?: string | null;
  status?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
};

export type SupportStats = {
  total: number;
  issuesCount: number;
  feedbackCount: number;
  openCount: number;
  resolvedCount: number;
};

function isTableMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: string; message?: string };
  if (err.code === "42P01" || err.code === "PGRST205") {
    return true;
  }
  const msg = (err.message || "").toLowerCase();
  if (msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("relation")) {
    return true;
  }
  return false;
}

export async function createSupportFeedback(
  params: CreateSupportFeedbackParams
): Promise<SupportFeedbackRow> {
  const insertPayload = {
    type: params.type,
    request_type: params.request_type ?? null,
    message: params.message.trim(),
    attachment_url: params.attachment_url ?? null,
    attachment_name: params.attachment_name ?? null,
    user_id: params.user_id ?? null,
    user_email: params.user_email?.trim() ?? null,
    user_name: params.user_name?.trim() ?? null,
    page_url: params.page_url ?? null,
    metadata: params.metadata ?? {},
    status: "open" as SupportStatus,
  };

  const { data, error } = await supabase
    .from("support_feedback")
    .insert(insertPayload)
    .select()
    .single();

  if (!error && data) {
    return data as SupportFeedbackRow;
  }

  if (isTableMissingError(error)) {
    logger.warn(
      { error },
      "[Support] Table 'support_feedback' does not exist yet. Using 'contact_messages' fallback. Run sql/018_support_feedback.sql in Supabase."
    );

    const fallbackFormattedMessage = `[${params.type.toUpperCase()}${params.request_type ? ` - ${params.request_type}` : ""}] ${params.message}${params.attachment_url ? `\n\nAttachment: ${params.attachment_url}` : ""}${params.page_url ? `\nPage: ${params.page_url}` : ""}`;

    const fallbackInsert = await supabase
      .from("contact_messages")
      .insert({
        full_name: params.user_name?.trim() || (params.type === "issue" ? "Hydrilla Issue Report" : "Hydrilla Feedback"),
        work_email: params.user_email?.trim() || "anonymous@hydrilla.ai",
        company: null,
        use_case: "Other",
        studio_size: null,
        message: fallbackFormattedMessage,
      })
      .select()
      .single();

    if (fallbackInsert.error) {
      logger.error({ err: fallbackInsert.error }, "[Support] Fallback insert into contact_messages failed");
      throw new Error("Failed to save support feedback in database");
    }

    const fallbackRow = fallbackInsert.data;
    return {
      id: fallbackRow.id,
      type: params.type,
      request_type: params.request_type ?? null,
      message: params.message,
      attachment_url: params.attachment_url ?? null,
      attachment_name: params.attachment_name ?? null,
      user_id: params.user_id ?? null,
      user_email: params.user_email ?? null,
      user_name: params.user_name ?? null,
      page_url: params.page_url ?? null,
      metadata: params.metadata ?? {},
      status: "open",
      admin_notes: null,
      created_at: fallbackRow.created_at || new Date().toISOString(),
      updated_at: fallbackRow.created_at || new Date().toISOString(),
    };
  }

  logger.error({ error }, "[Support] Insert into support_feedback failed");
  throw new Error(error?.message || "Failed to save support feedback");
}

export async function listSupportFeedback(options: ListSupportFeedbackOptions): Promise<{
  stats: SupportStats;
  items: SupportFeedbackRow[];
  total: number;
}> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);

  // Try querying support_feedback first
  const baseQuery = supabase.from("support_feedback").select("*", { count: "exact" });

  const queryWithType = options.type && options.type !== "all"
    ? baseQuery.eq("type", options.type)
    : baseQuery;

  const queryWithStatus = options.status && options.status !== "all"
    ? queryWithType.eq("status", options.status)
    : queryWithType;

  const queryWithSearch = options.search && options.search.trim().length > 0
    ? queryWithStatus.or(`message.ilike.%${options.search.trim()}%,user_email.ilike.%${options.search.trim()}%,user_name.ilike.%${options.search.trim()}%,request_type.ilike.%${options.search.trim()}%`)
    : queryWithStatus;

  const { data, count, error } = await queryWithSearch
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (!error && data) {
    const statsQuery = await supabase.from("support_feedback").select("type, status");
    const statsData = statsQuery.data || [];

    const stats: SupportStats = {
      total: statsData.length,
      issuesCount: statsData.filter((i) => i.type === "issue").length,
      feedbackCount: statsData.filter((i) => i.type === "feedback").length,
      openCount: statsData.filter((i) => i.status === "open").length,
      resolvedCount: statsData.filter((i) => i.status === "resolved" || i.status === "closed").length,
    };

    return {
      stats,
      items: data as SupportFeedbackRow[],
      total: count ?? data.length,
    };
  }

  if (isTableMissingError(error)) {
    logger.warn("[Support] Table 'support_feedback' does not exist yet. Reading from 'contact_messages' fallback.");
    const fallbackRes = await supabase
      .from("contact_messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    const fallbackRows = fallbackRes.data || [];
    const mapped: SupportFeedbackRow[] = fallbackRows.map((msg: any) => {
      const isIssue = msg.message?.startsWith("[ISSUE");
      const isFeedback = msg.message?.startsWith("[FEEDBACK");
      const derivedType: SupportType = isFeedback ? "feedback" : "issue";
      return {
        id: msg.id,
        type: derivedType,
        request_type: msg.use_case || "Support",
        message: msg.message || "",
        attachment_url: null,
        attachment_name: null,
        user_id: null,
        user_email: msg.work_email || null,
        user_name: msg.full_name || null,
        page_url: null,
        metadata: {},
        status: "open",
        admin_notes: null,
        created_at: msg.created_at,
        updated_at: msg.created_at,
      };
    });

    const filtered = mapped.filter((item) => {
      if (options.type && options.type !== "all" && item.type !== options.type) {
        return false;
      }
      if (options.search && options.search.trim()) {
        const q = options.search.trim().toLowerCase();
        const matchesMsg = item.message.toLowerCase().includes(q);
        const matchesEmail = (item.user_email || "").toLowerCase().includes(q);
        const matchesName = (item.user_name || "").toLowerCase().includes(q);
        if (!matchesMsg && !matchesEmail && !matchesName) {
          return false;
        }
      }
      return true;
    });

    return {
      stats: {
        total: mapped.length,
        issuesCount: mapped.filter((i) => i.type === "issue").length,
        feedbackCount: mapped.filter((i) => i.type === "feedback").length,
        openCount: mapped.length,
        resolvedCount: 0,
      },
      items: filtered,
      total: filtered.length,
    };
  }

  logger.error({ error }, "[Support] listSupportFeedback query failed");
  throw new Error("Failed to load support feedback items");
}

export async function getSupportFeedbackById(id: string): Promise<SupportFeedbackRow | null> {
  const { data, error } = await supabase
    .from("support_feedback")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!error && data) {
    return data as SupportFeedbackRow;
  }

  if (isTableMissingError(error)) {
    const fallbackRes = await supabase
      .from("contact_messages")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (fallbackRes.data) {
      const msg = fallbackRes.data;
      return {
        id: msg.id,
        type: msg.message?.startsWith("[FEEDBACK") ? "feedback" : "issue",
        request_type: msg.use_case || "Support",
        message: msg.message || "",
        attachment_url: null,
        attachment_name: null,
        user_id: null,
        user_email: msg.work_email || null,
        user_name: msg.full_name || null,
        page_url: null,
        metadata: {},
        status: "open",
        admin_notes: null,
        created_at: msg.created_at,
        updated_at: msg.created_at,
      };
    }
  }

  return null;
}

export async function updateSupportFeedback(
  id: string,
  updates: { status?: SupportStatus; admin_notes?: string }
): Promise<SupportFeedbackRow | null> {
  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (updates.status) {
    payload.status = updates.status;
  }
  if (typeof updates.admin_notes === "string") {
    payload.admin_notes = updates.admin_notes;
  }

  const { data, error } = await supabase
    .from("support_feedback")
    .update(payload)
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) {
    if (isTableMissingError(error)) {
      const fallbackTicket = await getSupportFeedbackById(id);
      if (fallbackTicket) {
        return {
          ...fallbackTicket,
          status: updates.status || fallbackTicket.status,
          admin_notes: typeof updates.admin_notes === "string" ? updates.admin_notes : fallbackTicket.admin_notes,
          updated_at: new Date().toISOString(),
        };
      }
      return null;
    }
    logger.error({ error, id }, "[Support] updateSupportFeedback failed");
    throw new Error(error.message || "Failed to update support ticket");
  }

  return (data as SupportFeedbackRow) ?? null;
}

export async function deleteSupportFeedback(id: string): Promise<boolean> {
  const { error } = await supabase
    .from("support_feedback")
    .delete()
    .eq("id", id);

  if (error) {
    if (isTableMissingError(error)) {
      await supabase.from("contact_messages").delete().eq("id", id);
      return true;
    }
    logger.error({ error, id }, "[Support] deleteSupportFeedback failed");
    throw new Error(error.message || "Failed to delete support ticket");
  }

  return true;
}
