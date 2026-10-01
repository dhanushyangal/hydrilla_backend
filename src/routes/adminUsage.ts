import { Router } from "express";
import { logger } from "../logger.js";
import { recentUsage, usageByModel, usageByUser } from "../repository/imageUsage.js";

export const adminUsageRouter = Router();

const RANGE_DAYS: Record<string, number | null> = { "1d": 1, "7d": 7, "30d": 30, "90d": 90, all: null };

function sinceFor(range: string): string | null {
  const days = RANGE_DAYS[range] ?? RANGE_DAYS["30d"];
  return days === null ? null : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function roundUsd(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

adminUsageRouter.get("/", async (req, res) => {
  const range =
    typeof req.query.range === "string" && Object.prototype.hasOwnProperty.call(RANGE_DAYS, req.query.range) ? req.query.range : "30d";
  const userId = typeof req.query.userId === "string" && req.query.userId.trim() ? req.query.userId.trim() : null;
  const since = sinceFor(range);
  try {
    const [users, models, recent] = await Promise.all([
      usageByUser(since),
      usageByModel(since),
      recentUsage(since, userId, 50),
    ]);
    res.json({
      range,
      since,
      totals: {
        costUsd: roundUsd(users.reduce((sum, u) => sum + u.costUsd, 0)),
        totalTokens: users.reduce((sum, u) => sum + u.totalTokens, 0),
        inputTokens: users.reduce((sum, u) => sum + u.inputTokens, 0),
        outputTokens: users.reduce((sum, u) => sum + u.outputTokens, 0),
        generations: users.reduce((sum, u) => sum + u.generations, 0),
        failed: users.reduce((sum, u) => sum + u.failed, 0),
        creditsCharged: users.reduce((sum, u) => sum + u.creditsCharged, 0),
        activeUsers: users.length,
      },
      users,
      models,
      recent,
    });
  } catch (err: any) {
    logger.error({ err: err?.message ?? err }, "GET /api/admin/usage failed");
    const missingTable = /image_generation_usage|admin_image_usage/i.test(String(err?.message || ""));
    res.status(500).json({
      error: missingTable
        ? "Usage tables are missing. Run backend/sql/013_image_generation_usage.sql in Supabase."
        : "Failed to load usage",
    });
  }
});
