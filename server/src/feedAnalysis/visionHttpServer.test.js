const test = require("node:test");
const assert = require("node:assert/strict");

const { createVisionHttpApp } = require("./visionHttpServer");

async function withApp(app, callback) {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("vision worker health is public while analysis requires bearer auth", async () => {
  const analyzer = {
    analyzeRecording: async (payload) => ({ recordingKey: payload.recordingKey, frames: payload.frames || [] }),
    analyzeSnapshot: async () => ({ hasCat: true }),
  };
  await withApp(createVisionHttpApp({ analyzer, token: "secret" }), async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.pipeline, "vision-worker-v3.2-compatible");

    const denied = await fetch(`${baseUrl}/analyze-recording`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${baseUrl}/analyze-recording`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify({ recordingKey: "clip-a", recording: { BeginTime: "2026-08-22 10:00:00" } }),
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).recordingKey, "clip-a");
  });
});

test("vision worker rejects overlapping analysis instead of exceeding concurrency", async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const analyzer = {
    analyzeRecording: async () => { await blocker; return { ok: true }; },
    analyzeSnapshot: async () => ({ ok: true }),
  };
  await withApp(createVisionHttpApp({ analyzer, token: "secret", maxConcurrent: 1 }), async (baseUrl) => {
    const first = fetch(`${baseUrl}/analyze-recording`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: "{}",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await fetch(`${baseUrl}/analyze-recording`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: "{}",
    });
    assert.equal(second.status, 503);
    assert.equal(second.headers.get("retry-after"), "5");
    release();
    assert.equal((await first).status, 200);
  });
});
