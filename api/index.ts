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

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
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

// Vercel serverless function handler
export default app;

