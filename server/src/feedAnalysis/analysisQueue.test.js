const test = require("node:test");
const assert = require("node:assert/strict");

const { AnalysisQueue } = require("./analysisQueue");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for queue state");
}

test("AnalysisQueue deduplicates recording tasks and serializes work per device", async () => {
  const blockers = [];
  const started = [];
  const activeByDevice = new Map();
  let maxGlobalActive = 0;
  let sameDeviceOverlap = false;

  const queue = new AnalysisQueue({
    globalConcurrency: 2,
    processTask: async (task) => {
      started.push(`${task.deviceSn}:${task.recordingKey}`);
      activeByDevice.set(task.deviceSn, (activeByDevice.get(task.deviceSn) || 0) + 1);
      if (activeByDevice.get(task.deviceSn) > 1) sameDeviceOverlap = true;
      maxGlobalActive = Math.max(
        maxGlobalActive,
        Array.from(activeByDevice.values()).reduce((sum, value) => sum + value, 0)
      );
      const hold = deferred();
      blockers.push({ task, hold });
      await hold.promise;
      activeByDevice.set(task.deviceSn, activeByDevice.get(task.deviceSn) - 1);
    },
  });

  assert.equal(queue.enqueueRecording({ deviceSn: "A", date: "2026-07-14", recordingKey: "clip-1" }).queued, true);
  assert.equal(queue.enqueueRecording({ deviceSn: "A", date: "2026-07-14", recordingKey: "clip-1" }).queued, false);
  assert.equal(queue.enqueueRecording({ deviceSn: "A", date: "2026-07-14", recordingKey: "clip-2" }).queued, true);
  assert.equal(queue.enqueueRecording({ deviceSn: "B", date: "2026-07-14", recordingKey: "clip-3" }).queued, true);

  await waitFor(() => started.length === 2);
  assert.deepEqual(started.sort(), ["A:clip-1", "B:clip-3"]);
  assert.equal(maxGlobalActive, 2);
  assert.equal(sameDeviceOverlap, false);

  blockers.find((item) => item.task.deviceSn === "A").hold.resolve();
  await waitFor(() => started.includes("A:clip-2"));
  assert.equal(sameDeviceOverlap, false);

  for (const blocker of blockers) blocker.hold.resolve();
  await queue.onIdle();
});

test("AnalysisQueue promotes a coalesced manual task ahead of background backlog", async () => {
  const started = [];
  const firstHold = deferred();
  const queue = new AnalysisQueue({
    globalConcurrency: 1,
    processTask: async (task) => {
      started.push(task.recordingKey);
      if (task.recordingKey === "running") await firstHold.promise;
    },
  });

  queue.enqueueRecording({ deviceSn: "SN", recordingKey: "running" });
  await waitFor(() => started.length === 1);
  queue.enqueueRecording({ deviceSn: "SN", recordingKey: "old-1" });
  queue.enqueueRecording({ deviceSn: "SN", recordingKey: "manual" });
  queue.enqueueRecording({ deviceSn: "SN", recordingKey: "old-2" });
  assert.equal(queue.enqueueRecording({
    deviceSn: "SN",
    recordingKey: "manual",
    priority: 100,
    reason: "manual-sync",
  }).queued, false);

  firstHold.resolve();
  await queue.onIdle();
  assert.deepEqual(started, ["running", "manual", "old-1", "old-2"]);
});

test("AnalysisQueue isolates task failures and keeps processing later tasks", async () => {
  const processed = [];
  const errors = [];
  const queue = new AnalysisQueue({
    globalConcurrency: 1,
    logger: { error: (...args) => errors.push(args) },
    processTask: async (task) => {
      processed.push(task.recordingKey);
      if (task.recordingKey === "bad") {
        throw new Error("DEVICE_OFFLINE");
      }
    },
  });

  queue.enqueueRecording({ deviceSn: "SN1", date: "2026-07-14", recordingKey: "bad" });
  queue.enqueueRecording({ deviceSn: "SN1", date: "2026-07-14", recordingKey: "good" });
  await queue.onIdle();

  assert.deepEqual(processed, ["bad", "good"]);
  assert.equal(errors.length, 1);
  assert.match(JSON.stringify(errors[0]), /SN1.*bad.*DEVICE_OFFLINE/);
  assert.deepEqual(queue.getStatus(), {
    pending: 0,
    running: 0,
    globalConcurrency: 1,
    accepted: 2,
    coalesced: 0,
    completed: 2,
    failed: 1,
    preempted: 0,
    oldestPendingMs: 0,
    longestRunningMs: 0,
    byKind: {
      scan: { pending: 0, running: 0 },
      recording: { pending: 0, running: 0 },
    },
    recentFailures: [{
      deviceSn: "SN1",
      kind: "recording",
      category: "device_auth",
      code: "DEVICE_OFFLINE",
    }],
  });
});

test("AnalysisQueue reports unsuccessful task results", async () => {
  const errors = [];
  const queue = new AnalysisQueue({
    logger: { error: (...args) => errors.push(args) },
    processTask: async () => ({ ok: false, error: "VISION_ANALYSIS_FAILED" }),
  });

  queue.enqueueRecording({ deviceSn: "SN2", date: "2026-07-27", recordingKey: "clip-failed" });
  await queue.onIdle();

  assert.equal(errors.length, 1);
  assert.match(JSON.stringify(errors[0]), /SN2.*clip-failed.*VISION_ANALYSIS_FAILED/);
  assert.deepEqual(queue.getStatus().recentFailures, [{
    deviceSn: "SN2",
    kind: "recording",
    category: "vision",
    code: "VISION_ANALYSIS_FAILED",
  }]);
});

test("AnalysisQueue exposes completion for one scan job", async () => {
  const recordingHold = deferred();
  const queue = new AnalysisQueue({
    globalConcurrency: 1,
    processTask: async (task) => {
      if (!task.recordingKey) {
        queue.enqueueRecording({
          deviceSn: task.deviceSn,
          date: task.date,
          recordingKey: "record-1",
        });
        return { ok: true, queued: 1, records: 1 };
      }
      await recordingHold.promise;
      return { ok: true };
    },
  });

  const scan = queue.enqueueDeviceDate({ deviceSn: "SN1", date: "2026-07-29" });
  const outcome = await scan.completion;

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, { ok: true, queued: 1, records: 1 });
  assert.equal(queue.getStatus().byKind.recording.running, 1);
  recordingHold.resolve();
  await queue.onIdle();
});

test("AnalysisQueue reports timing, outcomes, and device-scoped capacity safely", async () => {
  const now = { value: 1_000 };
  const started = [];
  const holds = new Map();
  const queue = new AnalysisQueue({
    globalConcurrency: 1,
    nowProvider: () => now.value,
    processTask: async (task) => {
      started.push(task.jobKey);
      const hold = deferred();
      holds.set(task.jobKey, hold);
      await hold.promise;
    },
  });

  queue.enqueueDeviceDate({ deviceSn: "SN-A", date: "2026-07-28" });
  await waitFor(() => started.length === 1);
  assert.equal(queue.enqueueDeviceDate({ deviceSn: "SN-A", date: "2026-07-28" }).queued, false);
  queue.enqueueRecording({ deviceSn: "SN-B", date: "2026-07-28", recordingKey: "clip-b" });

  now.value = 7_000;
  assert.deepEqual(queue.getStatus({ deviceSn: "SN-A" }), {
    pending: 1,
    running: 1,
    globalConcurrency: 1,
    accepted: 2,
    coalesced: 1,
    completed: 0,
    failed: 0,
    preempted: 0,
    oldestPendingMs: 6_000,
    longestRunningMs: 6_000,
    byKind: {
      scan: { pending: 0, running: 1 },
      recording: { pending: 1, running: 0 },
    },
    activeDevice: { pending: 0, running: true },
  });

  holds.get("SN-A:date:2026-07-28").resolve();
  await waitFor(() => started.includes("SN-B:recording:clip-b"));
  holds.get("SN-B:recording:clip-b").resolve();
  await queue.onIdle();
  assert.equal(queue.getStatus().completed, 2);
  assert.equal(queue.getStatus().failed, 0);
});

test("AnalysisQueue preempts background work for a realtime feeding task", async () => {
  const started = [];
  const queue = new AnalysisQueue({
    globalConcurrency: 1,
    processTask: async (task) => {
      started.push(task.recordingKey);
      if (task.recordingKey === "background") {
        await new Promise((resolve) => task.signal.addEventListener("abort", resolve, { once: true }));
        return { ok: false, deferred: true, preempted: true };
      }
      return { ok: true };
    },
  });

  queue.enqueueRecording({ deviceSn: "SN", recordingKey: "background", priority: 0 });
  await waitFor(() => started.length === 1);
  queue.enqueueRecording({ deviceSn: "SN", recordingKey: "feeding-start", priority: 100 });
  await queue.onIdle();

  assert.deepEqual(started, ["background", "feeding-start"]);
  assert.equal(queue.getStatus().preempted, 1);
  assert.equal(queue.getStatus().failed, 0);
});

test("AnalysisQueue keeps seven device scans bounded by global concurrency", async () => {
  const holds = [];
  const started = [];
  let active = 0;
  let maxActive = 0;
  const queue = new AnalysisQueue({
    globalConcurrency: 2,
    processTask: async (task) => {
      started.push(task.deviceSn);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const hold = deferred();
      holds.push(hold);
      await hold.promise;
      active -= 1;
    },
  });

  for (let index = 1; index <= 7; index += 1) {
    queue.enqueueDeviceDate({ deviceSn: `SN-${index}`, date: "2026-07-28" });
  }

  await waitFor(() => started.length === 2);
  assert.equal(maxActive, 2);
  assert.equal(queue.getStatus().pending, 5);

  while (holds.length > 0 || started.length < 7) {
    const hold = holds.shift();
    if (hold) hold.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await queue.onIdle();
  assert.equal(maxActive, 2);
  assert.equal(queue.getStatus().completed, 7);
});
