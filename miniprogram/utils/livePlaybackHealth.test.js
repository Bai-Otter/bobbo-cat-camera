const test = require("node:test");
const assert = require("node:assert/strict");

const { createPlaybackHealthTracker } = require("./livePlaybackHealth");

test("playback health distinguishes event noise from real media progress", () => {
  const tracker = createPlaybackHealthTracker({ stallThresholdMs: 3000 });

  tracker.start({ nowMs: 1000, mediaTimeSec: 0 });
  assert.equal(tracker.onProgress({ nowMs: 2000, mediaTimeSec: 0.5 }).advanced, true);
  assert.equal(tracker.onProgress({ nowMs: 3000, mediaTimeSec: 0.5 }).advanced, false);

  const healthy = tracker.snapshot(4500);
  assert.equal(healthy.stalled, false);
  assert.equal(healthy.lastAdvanceAgoMs, 2500);

  const stalled = tracker.snapshot(6000);
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.activeStallMs, 4000);
  assert.equal(stalled.mediaTimeSec, 0.5);
});

test("playback health reports a recovered stall and cumulative duration", () => {
  const tracker = createPlaybackHealthTracker({ stallThresholdMs: 3000 });

  tracker.start({ nowMs: 1000, mediaTimeSec: 0 });
  tracker.onProgress({ nowMs: 2000, mediaTimeSec: 1 });
  tracker.onWaiting(5500);
  const recovered = tracker.onProgress({ nowMs: 7000, mediaTimeSec: 1.5 });

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.stallDurationMs, 5000);
  const snapshot = tracker.snapshot(7500);
  assert.equal(snapshot.stalled, false);
  assert.equal(snapshot.totalStallMs, 5000);
  assert.equal(snapshot.longestStallMs, 5000);
  assert.equal(snapshot.waitingEvents, 1);
});

test("playback health reset clears previous stream history", () => {
  const tracker = createPlaybackHealthTracker({ stallThresholdMs: 1000 });
  tracker.start({ nowMs: 1000, mediaTimeSec: 2 });
  tracker.snapshot(3000);
  tracker.onProgress({ nowMs: 4000, mediaTimeSec: 3 });

  tracker.start({ nowMs: 5000, mediaTimeSec: 0 });
  const snapshot = tracker.snapshot(5500);
  assert.equal(snapshot.totalStallMs, 0);
  assert.equal(snapshot.longestStallMs, 0);
  assert.equal(snapshot.waitingEvents, 0);
  assert.equal(snapshot.mediaTimeSec, 0);
});
