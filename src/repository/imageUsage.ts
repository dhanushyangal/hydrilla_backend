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
  source?: "web" | "api";
  usage: UsageSummary;
};

export async function recordImageUsage(r: ImageUsageRecord): Promise<void> {
  const insertPayload: Record<string, any> = {
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
    source: r.source || "web",
  };

  let { error } = await supabase.from("image_generation_usage").insert(insertPayload);
  if (error && /source.*schema cache|column.*source/i.test(error.message || "")) {
    delete insertPayload.source;
    const retryResult = await supabase.from("image_generation_usage").insert(insertPayload);
    error = retryResult.error;
  }
  if (error) {
    throw error;
  }
}

export type UsageSourceFilter = "all" | "web" | "api";
export type UsageTypeFilter = "all" | "3d" | "image";

export type UserUsageRow = {
  userId: string;
  email: string | null;
  name: string | null;
  generations: number;
  failed: number;
  generations3d: number;
  failed3d: number;
  credits3d: number;
  generationsImage: number;
  failedImage: number;
  creditsImage: number;
  webCount: number;
  apiCount: number;
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
  category: "3d" | "image";
  source: "web" | "api" | "both";
  generations: number;
  failed: number;
  totalTokens: number;
  creditsCharged: number;
  costUsd: number;
};

export type RecentUsageRow = {
  id: string;
  userId: string;
  email: string | null;
  jobId: string | null;
  category: "3d" | "image";
  source: "web" | "api";
  operation: string;
  provider: string;
  model: string | null;
  quality: string | null;
  status: string;
  errorCode: string | null;
  creditsCharged: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number | null;
  createdAt: string;
};

export type UnifiedUsageReport = {
  range: string;
  source: UsageSourceFilter;
  type: UsageTypeFilter;
  since: string | null;
  totals: {
    costUsd: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    generations: number;
    failed: number;
    generations3d: number;
    failed3d: number;
    credits3d: number;
    generationsImage: number;
    failedImage: number;
    creditsImage: number;
    webCount: number;
    apiCount: number;
    creditsCharged: number;
    activeUsers: number;
  };
  users: UserUsageRow[];
  models: ModelUsageRow[];
  recent: RecentUsageRow[];
};

const THREE_D_TYPES = ["ImageTo3D", "TextTo3D", "Normal", "LowPoly", "Geometry", "Sketch"];

function fullName(first: unknown, last: unknown): string | null {
  const name = [first, last].filter((p) => typeof p === "string" && p.trim()).join(" ").trim();
  return name || null;
}

function roundUsd(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function format3DOperation(generateType: string): string {
  if (generateType === "TextTo3D") {
    return "Text to 3D";
  }
  if (generateType === "ImageTo3D") {
    return "Image to 3D";
  }
  if (generateType === "LowPoly") {
    return "Low Poly 3D";
  }
  if (generateType === "Geometry") {
    return "Geometry 3D";
  }
  if (generateType === "Sketch") {
    return "Sketch 3D";
  }
  return "3D Reconstruction";
}

function formatImageOperation(op: string): string {
  if (op === "edit") {
    return "Edit";
  }
  return "Text to image";
}

export async function getUnifiedUsageReport(params: {
  range: string;
  source: UsageSourceFilter;
  type: UsageTypeFilter;
  since: string | null;
  userId: string | null;
}): Promise<UnifiedUsageReport> {
  const { range, source, type, since, userId } = params;

  // 1. Fetch 2D image usage rows
  const shouldFetchImages = type === "all" || type === "image";
  const imageRowsPromise = shouldFetchImages
    ? (async () => {
        const fetchImagesWithSource = async () => {
          let q: any = supabase
            .from("image_generation_usage")
            .select("id,user_id,job_id,operation,provider,model,quality,status,error_code,input_tokens,output_tokens,total_tokens,cost_usd,credits_charged,source,created_at");
          if (since) q = q.gte("created_at", since);
          if (userId) q = q.eq("user_id", userId);
          if (source !== "all") q = q.eq("source", source);
          return await q.order("created_at", { ascending: false });
        };

        const fetchImagesLegacy = async () => {
          let q: any = supabase
            .from("image_generation_usage")
            .select("id,user_id,job_id,operation,provider,model,quality,status,error_code,input_tokens,output_tokens,total_tokens,cost_usd,credits_charged,created_at");
          if (since) q = q.gte("created_at", since);
          if (userId) q = q.eq("user_id", userId);
          return await q.order("created_at", { ascending: false });
        };

        const res = await fetchImagesWithSource();
        if (res.error && /source.*schema cache|column.*source/i.test(res.error.message || "")) {
          const fallback = await fetchImagesLegacy();
          return ((fallback.data || []) as Record<string, any>[]);
        }
        if (res.error) {
          return [];
        }
        return ((res.data || []) as Record<string, any>[]);
      })()
    : Promise.resolve([]);

  // 2. Fetch 3D model jobs
  const shouldFetch3D = type === "all" || type === "3d";
  const threeDRowsPromise = shouldFetch3D
    ? (async () => {
        const fetch3DWithSource = async () => {
          let q: any = supabase
            .from("jobs")
            .select("id,user_id,status,generate_type,credits_used,llm_model,llm_provider,duration_ms,error_code,error_message,source,created_at")
            .in("generate_type", THREE_D_TYPES);
          if (since) q = q.gte("created_at", since);
          if (userId) q = q.eq("user_id", userId);
          if (source !== "all") q = q.eq("source", source);
          return await q.order("created_at", { ascending: false });
        };

        const fetch3DLegacy = async () => {
          let q: any = supabase
            .from("jobs")
            .select("id,user_id,status,generate_type,credits_used,llm_model,llm_provider,duration_ms,error_code,error_message,created_at")
            .in("generate_type", THREE_D_TYPES);
          if (since) q = q.gte("created_at", since);
          if (userId) q = q.eq("user_id", userId);
          return await q.order("created_at", { ascending: false });
        };

        const res = await fetch3DWithSource();
        if (res.error && /source.*schema cache|column.*source/i.test(res.error.message || "")) {
          const fallback = await fetch3DLegacy();
          return ((fallback.data || []) as Record<string, any>[]);
        }
        if (res.error) {
          return [];
        }
        return ((res.data || []) as Record<string, any>[]);
      })()
    : Promise.resolve([]);

  const [rawImages, raw3D] = await Promise.all([imageRowsPromise, threeDRowsPromise]);

  // 3. Collect unique user IDs and fetch user profiles
  const allUserIds = Array.from(
    new Set([
      ...rawImages.map((r) => String(r.user_id)).filter(Boolean),
      ...raw3D.map((r) => String(r.user_id)).filter(Boolean),
    ])
  );

  const usersMapPromise = (async () => {
    if (allUserIds.length === 0) {
      return new Map<string, { email: string | null; name: string | null }>();
    }
    const { data } = await supabase
      .from("users")
      .select("id,email,first_name,last_name")
      .in("id", allUserIds);

    const map = new Map<string, { email: string | null; name: string | null }>();
    (data || []).forEach((u: any) => {
      map.set(String(u.id), {
        email: u.email || null,
        name: fullName(u.first_name, u.last_name),
      });
    });
    return map;
  })();

  const usersMap = await usersMapPromise;

  // 4. Per-User Aggregations
  const userStats = new Map<
    string,
    {
      userId: string;
      email: string | null;
      name: string | null;
      generations3d: number;
      failed3d: number;
      credits3d: number;
      generationsImage: number;
      failedImage: number;
      creditsImage: number;
      webCount: number;
      apiCount: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      costUsd: number;
      lastUsedAt: string | null;
    }
  >();

  const getOrCreateUser = (uId: string) => {
    const existing = userStats.get(uId);
    if (existing) {
      return existing;
    }
    const profile = usersMap.get(uId);
    const created = {
      userId: uId,
      email: profile?.email ?? null,
      name: profile?.name ?? null,
      generations3d: 0,
      failed3d: 0,
      credits3d: 0,
      generationsImage: 0,
      failedImage: 0,
      creditsImage: 0,
      webCount: 0,
      apiCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      lastUsedAt: null,
    };
    userStats.set(uId, created);
    return created;
  };

  rawImages.forEach((img) => {
    const uId = String(img.user_id || "anonymous");
    const u = getOrCreateUser(uId);
    const isSuccess = img.status === "succeeded";
    const imgSource = (img.source === "api" ? "api" : "web") as "web" | "api";

    if (isSuccess) {
      u.generationsImage += 1;
      u.creditsImage += Number(img.credits_charged) || 0;
    } else {
      u.failedImage += 1;
    }

    if (imgSource === "api") {
      u.apiCount += 1;
    } else {
      u.webCount += 1;
    }

    u.inputTokens += Number(img.input_tokens) || 0;
    u.outputTokens += Number(img.output_tokens) || 0;
    u.totalTokens += Number(img.total_tokens) || 0;
    u.costUsd += Number(img.cost_usd) || 0;

    const createdAt = String(img.created_at || "");
    if (!u.lastUsedAt || createdAt > u.lastUsedAt) {
      u.lastUsedAt = createdAt;
    }
  });

  raw3D.forEach((j) => {
    const uId = String(j.user_id || "anonymous");
    const u = getOrCreateUser(uId);
    const isSuccess = j.status === "DONE";
    const isFail = j.status === "FAIL";
    const jSource = (j.source === "api" ? "api" : "web") as "web" | "api";

    if (isSuccess) {
      u.generations3d += 1;
      u.credits3d += Number(j.credits_used) || 0;
    } else if (isFail) {
      u.failed3d += 1;
    }

    if (jSource === "api") {
      u.apiCount += 1;
    } else {
      u.webCount += 1;
    }

    const createdAt = String(j.created_at || "");
    if (!u.lastUsedAt || createdAt > u.lastUsedAt) {
      u.lastUsedAt = createdAt;
    }
  });

  const users: UserUsageRow[] = Array.from(userStats.values())
    .map((u) => ({
      userId: u.userId,
      email: u.email,
      name: u.name,
      generations: u.generations3d + u.generationsImage,
      failed: u.failed3d + u.failedImage,
      generations3d: u.generations3d,
      failed3d: u.failed3d,
      credits3d: u.credits3d,
      generationsImage: u.generationsImage,
      failedImage: u.failedImage,
      creditsImage: u.creditsImage,
      webCount: u.webCount,
      apiCount: u.apiCount,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      totalTokens: u.totalTokens,
      costUsd: roundUsd(u.costUsd),
      creditsCharged: u.credits3d + u.creditsImage,
      lastUsedAt: u.lastUsedAt,
    }))
    .sort((a, b) => b.creditsCharged - a.creditsCharged || b.costUsd - a.costUsd);

  // 5. Model Breakdowns
  const modelMap = new Map<
    string,
    {
      provider: string;
      model: string;
      category: "3d" | "image";
      sources: Set<string>;
      generations: number;
      failed: number;
      totalTokens: number;
      creditsCharged: number;
      costUsd: number;
    }
  >();

  rawImages.forEach((img) => {
    const provider = String(img.provider || "OpenAI");
    const model = String(img.model || provider);
    const key = `image:${provider}:${model}`;
    const entry = modelMap.get(key) || {
      provider,
      model,
      category: "image" as const,
      sources: new Set<string>(),
      generations: 0,
      failed: 0,
      totalTokens: 0,
      creditsCharged: 0,
      costUsd: 0,
    };

    entry.sources.add(img.source === "api" ? "api" : "web");
    if (img.status === "succeeded") {
      entry.generations += 1;
      entry.creditsCharged += Number(img.credits_charged) || 0;
    } else {
      entry.failed += 1;
    }
    entry.totalTokens += Number(img.total_tokens) || 0;
    entry.costUsd += Number(img.cost_usd) || 0;

    modelMap.set(key, entry);
  });

  raw3D.forEach((j) => {
    const provider = "BlueFox 3D";
    const model = j.llm_model ? String(j.llm_model) : "Cascade 1536";
    const key = `3d:${provider}:${model}`;
    const entry = modelMap.get(key) || {
      provider,
      model,
      category: "3d" as const,
      sources: new Set<string>(),
      generations: 0,
      failed: 0,
      totalTokens: 0,
      creditsCharged: 0,
      costUsd: 0,
    };

    entry.sources.add(j.source === "api" ? "api" : "web");
    if (j.status === "DONE") {
      entry.generations += 1;
      entry.creditsCharged += Number(j.credits_used) || 0;
    } else if (j.status === "FAIL") {
      entry.failed += 1;
    }

    modelMap.set(key, entry);
  });

  const models: ModelUsageRow[] = Array.from(modelMap.values())
    .map((m) => {
      const sourceVal: "web" | "api" | "both" =
        m.sources.has("web") && m.sources.has("api")
          ? "both"
          : m.sources.has("api")
          ? "api"
          : "web";
      return {
        provider: m.provider,
        model: m.model,
        category: m.category,
        source: sourceVal,
        generations: m.generations,
        failed: m.failed,
        totalTokens: m.totalTokens,
        creditsCharged: m.creditsCharged,
        costUsd: roundUsd(m.costUsd),
      };
    })
    .sort((a, b) => b.creditsCharged - a.creditsCharged || b.generations - a.generations);

  // 6. Recent Activity Feed
  const recentImages: RecentUsageRow[] = rawImages.slice(0, 50).map((r) => {
    const uId = String(r.user_id || "");
    const profile = usersMap.get(uId);
    return {
      id: String(r.id),
      userId: uId,
      email: profile?.email ?? null,
      jobId: r.job_id ?? null,
      category: "image" as const,
      source: r.source === "api" ? "api" : "web",
      operation: formatImageOperation(String(r.operation)),
      provider: String(r.provider),
      model: r.model ?? null,
      quality: r.quality ?? null,
      status: String(r.status),
      errorCode: r.error_code ?? null,
      creditsCharged: Number(r.credits_charged) || 0,
      totalTokens: Number(r.total_tokens) || 0,
      costUsd: Number(r.cost_usd) || 0,
      durationMs: null,
      createdAt: String(r.created_at),
    };
  });

  const recent3D: RecentUsageRow[] = raw3D.slice(0, 50).map((r) => {
    const uId = String(r.user_id || "");
    const profile = usersMap.get(uId);
    const isSuccess = r.status === "DONE";
    return {
      id: String(r.id),
      userId: uId,
      email: profile?.email ?? null,
      jobId: String(r.id),
      category: "3d" as const,
      source: r.source === "api" ? "api" : "web",
      operation: format3DOperation(String(r.generate_type)),
      provider: "BlueFox 3D",
      model: r.llm_model ?? "Cascade 1536",
      quality: "High (1536)",
      status: isSuccess ? "succeeded" : r.status === "FAIL" ? "failed" : String(r.status).toLowerCase(),
      errorCode: r.error_code ?? null,
      creditsCharged: Number(r.credits_used) || 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs: typeof r.duration_ms === "number" ? r.duration_ms : null,
      createdAt: String(r.created_at),
    };
  });

  const combinedRecent = [...recentImages, ...recent3D]
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0))
    .slice(0, 50);

  // 7. Overall Totals
  const totalCostUsd = roundUsd(users.reduce((sum, u) => sum + u.costUsd, 0));
  const totalTokens = users.reduce((sum, u) => sum + u.totalTokens, 0);
  const totalInputTokens = users.reduce((sum, u) => sum + u.inputTokens, 0);
  const totalOutputTokens = users.reduce((sum, u) => sum + u.outputTokens, 0);
  const totalGenerations = users.reduce((sum, u) => sum + u.generations, 0);
  const totalFailed = users.reduce((sum, u) => sum + u.failed, 0);
  const total3DGenerations = users.reduce((sum, u) => sum + u.generations3d, 0);
  const total3DFailed = users.reduce((sum, u) => sum + u.failed3d, 0);
  const total3DCredits = users.reduce((sum, u) => sum + u.credits3d, 0);
  const totalImageGenerations = users.reduce((sum, u) => sum + u.generationsImage, 0);
  const totalImageFailed = users.reduce((sum, u) => sum + u.failedImage, 0);
  const totalImageCredits = users.reduce((sum, u) => sum + u.creditsImage, 0);
  const totalWebCount = users.reduce((sum, u) => sum + u.webCount, 0);
  const totalApiCount = users.reduce((sum, u) => sum + u.apiCount, 0);
  const totalCredits = total3DCredits + totalImageCredits;

  return {
    range,
    source,
    type,
    since,
    totals: {
      costUsd: totalCostUsd,
      totalTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      generations: totalGenerations,
      failed: totalFailed,
      generations3d: total3DGenerations,
      failed3d: total3DFailed,
      credits3d: total3DCredits,
      generationsImage: totalImageGenerations,
      failedImage: totalImageFailed,
      creditsImage: totalImageCredits,
      webCount: totalWebCount,
      apiCount: totalApiCount,
      creditsCharged: totalCredits,
      activeUsers: users.length,
    },
    users,
    models,
    recent: combinedRecent,
  };
}
