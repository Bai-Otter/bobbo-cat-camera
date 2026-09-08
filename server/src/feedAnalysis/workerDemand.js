const crypto = require("crypto");

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createWorkerDemandHandler(options = {}) {
  const token = String(options.token || "");
  const getQueueStatus = options.getQueueStatus;
  if (!token) throw new Error("WORKER_CONTROL_TOKEN_REQUIRED");
  if (typeof getQueueStatus !== "function") throw new Error("QUEUE_STATUS_PROVIDER_REQUIRED");
  return (request, response) => {
    const authorization = String(request.headers.authorization || "");
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!safeEqual(supplied, token)) {
      response.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    const status = getQueueStatus() || {};
    const pending = Math.max(0, Number(status.pending) || 0);
    const running = Math.max(0, Number(status.running) || 0);
    response.json({
      desired: pending + running > 0,
      pending,
      running,
      oldestPendingMs: Math.max(0, Number(status.oldestPendingMs) || 0),
      longestRunningMs: Math.max(0, Number(status.longestRunningMs) || 0),
    });
  };
}

module.exports = { createWorkerDemandHandler };
