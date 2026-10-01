import { supabase } from "../db.js";
import type { UsageSummary } from "../services/imageProviders/index.js";

export type ImageUsageRecord = {
  userId: string;
  jobId: string | null;
  operation: "text-to-image" | "edit";
  provider: string;
  model: string | null;
  quality: string;
  status: "succeeded" | "failed";
  errorCode: string | null;
  creditsCharged: number;
  usage: UsageSummary;
};

export async function recordImageUsage(r: ImageUsageRecord): Promise<void> {
  const { error } = await supabase.from("image_generation_usage").insert({
    user_id: r.userId,
    job_id: r.jobId,
    operation: r.operation,
    provider: r.provider,
    model: r.model,
    quality: r.quality,
    status: r.status,
    error_code: r.errorCode,
    input_tokens: r.usage.inputTokens,
    output_tokens: r.usage.outputTokens,
    total_tokens: r.usage.totalTokens,
    cost_usd: r.usage.costUsd,
    credits_charged: r.creditsCharged,
    calls: r.usage.calls,
  });
  if (error) {
    throw error;
  }
}

export type UserUsageRow = {
  userId: string;
  email: string | null;
  name: string | null;
  generations: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  creditsCharged: number;
  lastUsedAt: string | null;
};

export type ModelUsageRow = {
  provider: string;
  model: string;
  generations: number;
  failed: number;
  totalTokens: number;
  costUsd: number;
};

export type RecentUsageRow = {
  id: string;
  userId: string;
  email: string | null;
  jobId: string | null;
  operation: string;
  provider: string;
  model: string | null;
  quality: string | null;
  status: string;
  errorCode: string | null;
  totalTokens: number;
  costUsd: number;
  createdAt: string;
};

function fullName(first: unknown, last: unknown): string | null {
  const name = [first, last].filter((p) => typeof p === "string" && p.trim()).join(" ").trim();
  return name || null;
}

export async function usageByUser(since: string | null): Promise<UserUsageRow[]> {
  const { data, error } = await supabase.rpc("admin_image_usage_by_user", { p_since: since });
  if (error) {
    throw error;
  }
  return ((data as any[]) ?? []).map((r) => ({
    userId: String(r.user_id),
    email: r.email ?? null,
    name: fullName(r.first_name, r.last_name),
    generations: Number(r.generations) || 0,
    failed: Number(r.failed) || 0,
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    totalTokens: Number(r.total_tokens) || 0,
    costUsd: Number(r.cost_usd) || 0,
    creditsCharged: Number(r.credits_charged) || 0,
    lastUsedAt: r.last_used_at ?? null,
  }));
}

export async function usageByModel(since: string | null): Promise<ModelUsageRow[]> {
  const { data, error } = await supabase.rpc("admin_image_usage_by_model", { p_since: since });
  if (error) {
    throw error;
  }
  return ((data as any[]) ?? []).map((r) => ({
    provider: String(r.provider),
    model: String(r.model),
    generations: Number(r.generations) || 0,
    failed: Number(r.failed) || 0,
    totalTokens: Number(r.total_tokens) || 0,
    costUsd: Number(r.cost_usd) || 0,
  }));
}

export async function recentUsage(since: string | null, userId: string | null, limit: number): Promise<RecentUsageRow[]> {
  const base = supabase
    .from("image_generation_usage")
    .select("id,user_id,job_id,operation,provider,model,quality,status,error_code,total_tokens,cost_usd,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  const withSince = since ? base.gte("created_at", since) : base;
  const query = userId ? withSince.eq("user_id", userId) : withSince;
  const { data, error } = await query;
  if (error) {
    throw error;
  }
  const rows = (data as any[]) ?? [];
  const userIds = [...new Set(rows.map((r) => String(r.user_id)))];
  const emails = await emailsFor(userIds);
  return rows.map((r) => ({
    id: String(r.id),
    userId: String(r.user_id),
    email: emails.get(String(r.user_id)) ?? null,
    jobId: r.job_id ?? null,
    operation: String(r.operation),
    provider: String(r.provider),
    model: r.model ?? null,
    quality: r.quality ?? null,
    status: String(r.status),
    errorCode: r.error_code ?? null,
    totalTokens: Number(r.total_tokens) || 0,
    costUsd: Number(r.cost_usd) || 0,
    createdAt: String(r.created_at),
  }));
}

async function emailsFor(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }
  const { data, error } = await supabase.from("users").select("id,email").in("id", userIds);
  if (error) {
    throw error;
  }
  return new Map(
    ((data as any[]) ?? []).filter((u) => u.email).map((u) => [String(u.id), String(u.email)] as [string, string])
  );
}
