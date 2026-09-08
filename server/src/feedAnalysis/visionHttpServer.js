const crypto = require("crypto");
const express = require("express");

const { VisionWorkerAnalyzer } = require("./visionWorker");

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(request) {
  const value = String(request.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function createVisionHttpApp(options = {}) {
  const analyzer = options.analyzer;
  const token = String(options.token || "");
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 1);
  const logger = options.logger || console;
  if (!analyzer) throw new Error("VISION_ANALYZER_REQUIRED");
  if (!token) throw new Error("VISION_WORKER_TOKEN_REQUIRED");

  const app = express();
  app.use(express.json({ limit: "8mb" }));
  let active = 0;

  app.get("/health", (request, response) => {
    response.json({
      ok: true,
      ready: active < maxConcurrent,
      active,
      maxConcurrent,
      pipeline: "vision-worker-v3.2-compatible",
    });
  });

  app.use((request, response, next) => {
    if (!safeEqual(bearerToken(request), token)) {
      response.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    next();
  });

  const analyze = (kind) => async (request, response) => {
    if (active >= maxConcurrent) {
      response.set("Retry-After", "5");
      response.status(503).json({ error: "WORKER_BUSY" });
      return;
    }
    active += 1;
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", () => {
      if (!response.writableEnded) abort();
    });
    try {
      const payload = { ...(request.body || {}), signal: controller.signal };
      const result = kind === "snapshot"
        ? await analyzer.analyzeSnapshot(payload)
        : payload.screenOnly && typeof analyzer.screenRecording === "function"
          ? await analyzer.screenRecording(payload)
          : await analyzer.analyzeRecording(payload);
      if (!response.headersSent) response.json(result);
    } catch (error) {
      logger.warn?.("[vision-worker] request failed", {
        requestId,
        kind,
        error: error?.code || error?.message || "VISION_WORKER_FAILED",
      });
      if (!response.headersSent) {
        response.status(error?.code === "ANALYSIS_PREEMPTED" ? 499 : 500).json({
          error: error?.code || "VISION_WORKER_FAILED",
        });
      }
    } finally {
      active = Math.max(0, active - 1);
    }
  };

  app.post("/analyze-recording", analyze("recording"));
  app.post("/analyze-snapshot", analyze("snapshot"));
  return app;
}

async function start() {
  const port = Number(process.env.VISION_WORKER_PORT) || 3100;
  const host = process.env.VISION_WORKER_HOST || "0.0.0.0";
  const analyzer = new VisionWorkerAnalyzer({
    pythonPath: process.env.FEED_ANALYSIS_PYTHON || process.env.PYTHON_PATH || "python",
    workerScript: process.env.FEED_ANALYSIS_WORKER_SCRIPT,
    fineWorkerScript: process.env.FEED_ANALYSIS_V32_WORKER_SCRIPT,
    minConfidence: Number(process.env.FEED_ANALYSIS_MIN_CONFIDENCE) || 0.35,
    timeoutMs: Number(process.env.FEED_ANALYSIS_VISION_TIMEOUT_MS) || 12 * 60 * 1000,
  });
  const app = createVisionHttpApp({
    analyzer,
    token: process.env.VISION_WORKER_TOKEN,
    maxConcurrent: Number(process.env.VISION_WORKER_CONCURRENCY) || 1,
  });
  const server = app.listen(port, host, () => {
    console.log(`[vision-worker] ready on http://${host}:${port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (require.main === module) {
  start().catch((error) => {
    console.error("[vision-worker] failed to start", error.message);
    process.exit(1);
  });
}

module.exports = { createVisionHttpApp, safeEqual };
