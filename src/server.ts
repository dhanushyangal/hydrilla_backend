import express from "express";
import cors from "cors";
import path from "path";
import { threeDRouter } from "./routes/threeD.js";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { initDb } from "./db.js";
import pinoHttp from "pino-http";
import { syncAllJobs } from "./services/jobSync.js";

async function main() {
  await initDb();
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use(pinoHttp({ logger }));

  // Serve uploaded images statically
  const uploadsDir = path.join(process.cwd(), "uploads");
  app.use("/uploads", express.static(uploadsDir));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/3d", threeDRouter);

  app.use((err: any, _req: any, res: any, _next: any) => {
    logger.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  });

  // Start background job sync service
  const syncInterval = setInterval(async () => {
    try {
      await syncAllJobs();
    } catch (err: any) {
      logger.error({ err }, "Background job sync failed");
    }
  }, config.pollIntervalMs);

  // Cleanup on shutdown
  process.on("SIGTERM", () => {
    clearInterval(syncInterval);
  });
  process.on("SIGINT", () => {
    clearInterval(syncInterval);
  });

  app.listen(config.port, () => {
    logger.info(`Backend listening on port ${config.port}`);
    logger.info(`Background job sync started (interval: ${config.pollIntervalMs}ms)`);
  });
}

main().catch((err) => {
  logger.error(err, "fatal error");
  process.exit(1);
});

