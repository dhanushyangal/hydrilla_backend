import express from "express";
import cors from "cors";
import { threeDRouter } from "../src/routes/threeD.js";
import { logger } from "../src/logger.js";
import { initDb } from "../src/db.js";
import pinoHttp from "pino-http";

// Initialize database connection
let dbInitialized = false;
async function ensureDb() {
  if (!dbInitialized) {
    await initDb();
    dbInitialized = true;
  }
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(pinoHttp({ logger }));

// Health check - handle both /api/health and /health
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Root route
app.get("/", (_req, res) => {
  res.json({ message: "Hydrilla Backend API", status: "ok" });
});

// 3D routes
app.use("/api/3d", async (req, res, next) => {
  await ensureDb();
  next();
}, threeDRouter);

// Error handler
app.use((err: any, _req: any, res: any, _next: any) => {
  logger.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not Found", code: "NOT_FOUND" });
});

// Vercel serverless function handler
export default app;

