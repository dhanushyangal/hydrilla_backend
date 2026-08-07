import express from "express";
import cors from "cors";
import { threeDRouter } from "../src/routes/threeD.js";
import { paymentsRouter } from "../src/routes/payments.js";
import { userRouter } from "../src/routes/user.js";
import { codeSculptRouter } from "../src/routes/codeSculpt.js";
import { logger } from "../src/logger.js";
import { initDb } from "../src/db.js";
import { config as appConfig } from "../src/config.js";
import pinoHttp from "pino-http";

// Water can make up to four sequential LLM calls. Keep the HTTP response
// fast; waitUntil owns this function for the full generation (up to 300s).
export const config = {
  maxDuration: 300,
};

// Initialize database connection
let dbInitialized = false;
async function ensureDb() {
  if (!dbInitialized) {
    await initDb();
    dbInitialized = true;
  }
}

const app = express();

// Middleware — CORS allowlist (same as server.ts)
app.use(cors({
  origin(origin, callback) {
    if (!origin || appConfig.corsOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'webhook-id', 'webhook-signature', 'webhook-timestamp', 'X-Hydrilla-Internal'],
  credentials: true
}));

// Raw body parser for webhook signature verification (must be before json parser)
app.use("/api/payments/webhook/dodo", express.raw({ type: "application/json" }));

// JSON parser for all other routes
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(pinoHttp({ logger }));

// Health check endpoints
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Root route
app.get("/", (_req, res) => {
  res.json({ message: "Hydrilla Backend API", status: "ok" });
});

// Initialize database middleware
async function initDbMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!dbInitialized) {
    try {
      await ensureDb();
    } catch (dbErr: any) {
      logger.error({ err: dbErr }, "Database initialization failed");
      // Don't block the request, but log the error
    }
  }
  next();
}

// 3D routes
app.use("/api/3d", initDbMiddleware, threeDRouter);

// Payments routes
app.use("/api/payments", initDbMiddleware, paymentsRouter);

// BYOK keys + Water engine (legacy alias: /api/code-sculpt)
app.use("/api/user", initDbMiddleware, userRouter);
app.use("/api/water", initDbMiddleware, codeSculptRouter);
app.use("/api/code-sculpt", initDbMiddleware, codeSculptRouter);

// Error handler
app.use((err: any, _req: any, res: any, _next: any) => {
  logger.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

// 404 handler (must be last)
app.use((_req, res) => {
  res.status(404).json({ error: "Not Found", code: "NOT_FOUND" });
});

// Vercel serverless function handler
export default app;

