const test = require("node:test");
const assert = require("node:assert/strict");

const { createWorkerDemandHandler } = require("./workerDemand");

function responseDouble() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("worker demand endpoint is authenticated and exposes only queue capacity data", () => {
  const handler = createWorkerDemandHandler({
    token: "control-secret",
    getQueueStatus: () => ({ pending: 2, running: 1, oldestPendingMs: 9000, longestRunningMs: 3000, recentFailures: [{ secret: true }] }),
  });
  const denied = responseDouble();
  handler({ headers: {} }, denied);
  assert.equal(denied.statusCode, 401);

  const allowed = responseDouble();
  handler({ headers: { authorization: "Bearer control-secret" } }, allowed);
  assert.deepEqual(allowed.body, {
    desired: true,
    pending: 2,
    running: 1,
    oldestPendingMs: 9000,
    longestRunningMs: 3000,
  });
});
