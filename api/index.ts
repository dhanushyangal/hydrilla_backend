import express, { Request, Response } from "express";
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
// Configure CORS to allow all origins (for development and production)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(pinoHttp({ logger }));

// Health check - handle both /api/health and /health
app.get("/api/health", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get("/health", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Test endpoint for history (without database)
app.get("/api/3d/test", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.json({ message: "Backend is accessible", jobs: [] });
});

// Root route
app.get("/", (_req, res) => {
  res.json({ message: "Hydrilla Backend API", status: "ok" });
});

// 3D routes
app.use("/api/3d", async (req, res, next) => {
  // Initialize database in background, don't block the request
  if (!dbInitialized) {
    ensureDb().catch((dbErr: any) => {
      logger.error({ err: dbErr }, "Database initialization failed");
    });
  }
  next();
}, threeDRouter);

// Error handler - must set CORS headers before sending response
app.use((err: any, _req: any, res: any, _next: any) => {
  logger.error(err);
  // Set CORS headers even on error
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.status(500).json({ error: "Internal Server Error" });
});

// 404 handler - must set CORS headers
app.use((_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.status(404).json({ error: "Not Found", code: "NOT_FOUND" });
});

// Vercel serverless function handler

// For Vercel with @vercel/node, exporting the Express app directly works
export default app;

