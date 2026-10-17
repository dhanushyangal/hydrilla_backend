import { supabase } from "../db.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

type CachedEntry = {
  value: string;
  at: number;
};

const settingsCache = new Map<string, CachedEntry>();
const CACHE_TTL_MS = 20_000;

export async function getAppSetting(key: string, envFallback: string = ""): Promise<string> {
  const cached = settingsCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();

    if (error) {
      if ((error as any).code === "PGRST205") {
        settingsCache.set(key, { value: envFallback, at: now });
        return envFallback;
      }
      logger.warn({ key, err: error.message }, "Error fetching app setting from DB");
      return cached?.value ?? envFallback;
    }

    const val = data?.value !== undefined && data?.value !== null ? String(data.value).trim() : envFallback;
    settingsCache.set(key, { value: val, at: now });
    return val;
  } catch (err: any) {
    logger.warn({ key, err: err?.message }, "Failed to fetch app setting");
    return cached?.value ?? envFallback;
  }
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  const trimmed = value.trim();
  settingsCache.set(key, { value: trimmed, at: Date.now() });

  if (key === "gpu_gateway_url") {
    config.gpuGateway.url = trimmed;
    process.env.HYDRILLA_GPU_API_URL = trimmed;
    process.env.HUNYUAN_API_URL = trimmed;
  } else if (key === "gpu_target_instance") {
    config.gcpGpuInstance.instance = trimmed;
    process.env.GCP_GPU_INSTANCE = trimmed;
  }

  try {
    const { error } = await supabase
      .from("app_settings")
      .upsert(
        { key, value: trimmed, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );

    if (error) {
      if ((error as any).code === "PGRST205") {
        logger.warn(
          "Table app_settings does not exist in Supabase yet. Run backend/sql/026_app_settings.sql in Supabase SQL editor.",
        );
      } else {
        logger.error({ key, error: error.message }, "Failed to upsert app setting to Supabase");
      }
    }
  } catch (err: any) {
    logger.error({ key, err: err?.message }, "Exception saving app setting to Supabase");
  }
}

export async function syncAppSettingsFromDb(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("key, value");

    if (error) {
      if ((error as any).code !== "PGRST205") {
        logger.warn({ err: error.message }, "Could not sync app settings from DB");
      }
      return;
    }

    if (Array.isArray(data)) {
      const now = Date.now();
      for (const row of data) {
        if (!row.key) {
          continue;
        }
        const val = String(row.value || "").trim();
        settingsCache.set(row.key, { value: val, at: now });
        if (row.key === "gpu_gateway_url" && val) {
          config.gpuGateway.url = val;
          process.env.HYDRILLA_GPU_API_URL = val;
          process.env.HUNYUAN_API_URL = val;
        } else if (row.key === "gpu_target_instance" && val) {
          config.gcpGpuInstance.instance = val;
          process.env.GCP_GPU_INSTANCE = val;
        }
      }
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, "Exception during syncAppSettingsFromDb");
  }
}
