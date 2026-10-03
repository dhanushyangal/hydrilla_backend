import { Router, type Request, type Response } from "express";
import { logger } from "../logger.js";
import {
  getUnifiedUsageReport,
  type UsageSourceFilter,
  type UsageTypeFilter,
} from "../repository/imageUsage.js";

export const adminUsageRouter = Router();

const RANGE_DAYS: Record<string, number | null> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

function sinceFor(range: string): string | null {
  const days = RANGE_DAYS[range] ?? RANGE_DAYS["30d"];
  if (days === null) {
    return null;
  }
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function parseSource(val: unknown): UsageSourceFilter {
  if (val === "web" || val === "api") {
    return val;
  }
  return "all";
}

function parseType(val: unknown): UsageTypeFilter {
  if (val === "3d" || val === "image") {
    return val;
  }
  return "all";
}

adminUsageRouter.get("/", async (req: Request, res: Response) => {
  const rawRange = typeof req.query.range === "string" ? req.query.range : "30d";
  const range = Object.prototype.hasOwnProperty.call(RANGE_DAYS, rawRange) ? rawRange : "30d";
  const source = parseSource(req.query.source);
  const type = parseType(req.query.type);
  const userId = typeof req.query.userId === "string" && req.query.userId.trim() ? req.query.userId.trim() : null;
  const since = sinceFor(range);

  try {
    const report = await getUnifiedUsageReport({
      range,
      source,
      type,
      since,
      userId,
    });
    res.json(report);
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMessage }, "GET /api/admin/usage failed");
    res.status(500).json({
      error: "Failed to load usage report",
    });
  }
});
