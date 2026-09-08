const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REPLAY_PLAYBACK_RATES,
  normalizeReplayPlaybackRate,
  formatReplayPlaybackRate,
} = require("./replayPlaybackRate.js");

test("replay playback rates stay within WeChat VideoContext supported options", () => {
  assert.deepEqual(REPLAY_PLAYBACK_RATES, [0.5, 1, 1.5, 2]);
  assert.equal(normalizeReplayPlaybackRate("1.5"), 1.5);
  assert.equal(normalizeReplayPlaybackRate(4), 1);
  assert.equal(normalizeReplayPlaybackRate(undefined), 1);
});

test("replay playback rate label is concise", () => {
  assert.equal(formatReplayPlaybackRate(0.5), "0.5x");
  assert.equal(formatReplayPlaybackRate(2), "2x");
});
