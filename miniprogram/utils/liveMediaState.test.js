const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canStartRecording,
  canStartTalk,
  createRecordingSaveLedger,
  formatElapsed,
  mediaActionAcknowledgements,
  initialState,
  reduceMediaState,
} = require("./liveMediaState.js");

test("live media state enters custom UI only for horizontal fullscreen", () => {
  const portrait = reduceMediaState(initialState(), {
    type: "fullscreen",
    fullScreen: true,
    direction: "vertical",
  });
  assert.equal(portrait.landscape, false);
  const landscape = reduceMediaState(portrait, {
    type: "fullscreen",
    fullScreen: true,
    direction: "horizontal",
  });
  assert.equal(landscape.landscape, true);
});

test("record and talk transitions are independent, idempotent, and talk unmutes playback", () => {
  let state = reduceMediaState(initialState(), { type: "playback", playState: "playing" });
  state = reduceMediaState(state, { type: "mute.set", muted: true });
  assert.equal(canStartRecording(state), true);
  assert.equal(canStartTalk(state), true);
  state = reduceMediaState(state, { type: "record.starting" });
  state = reduceMediaState(state, { type: "record.active", startedAt: 10, id: "record-1" });
  state = reduceMediaState(state, { type: "record.active", startedAt: 10, id: "record-1" });
  assert.equal(state.record, "recording");
  assert.equal(state.recordStartedAt, 10);
  state = reduceMediaState(state, { type: "talk.active" });
  assert.equal(state.talk, "talking");
  assert.equal(state.record, "recording");
  assert.equal(state.muted, false);
  assert.equal(canStartRecording(state), false);
  assert.equal(canStartTalk(state), false);
});

test("ready and failed states retain retry metadata while fullscreen exit cleans active media", () => {
  let state = reduceMediaState(initialState(), {
    type: "record.ready",
    recording: { id: "record-1", accessToken: "token" },
  });
  assert.equal(state.record, "ready");
  assert.equal(state.recording.id, "record-1");
  state = reduceMediaState(state, { type: "record.failed", error: "RECORDING_FAILED" });
  assert.equal(state.record, "failed");
  assert.equal(state.recording.id, "record-1");
  state = reduceMediaState(state, { type: "talk.active" });
  state = reduceMediaState(state, { type: "fullscreen", fullScreen: false, direction: "vertical" });
  assert.equal(state.landscape, false);
  assert.equal(state.record, "idle");
  assert.equal(state.talk, "idle");
  assert.equal(state.recordStartedAt, 0);
});

test("elapsed formatter is stable for counters and invalid input", () => {
  assert.equal(formatElapsed(65_000), "01:05");
  assert.equal(formatElapsed(3_600_000), "60:00");
  assert.equal(formatElapsed(-1), "00:00");
  assert.equal(formatElapsed(Number.NaN), "00:00");
});

test("recording and talkback can start again after their terminal events", () => {
  let state = reduceMediaState(initialState(), { type: "playback", playState: "playing" });
  state = reduceMediaState(state, { type: "record.active", startedAt: 10, id: "record-1" });
  state = reduceMediaState(state, { type: "record.ready", recording: { id: "record-1" } });
  state = reduceMediaState(state, { type: "record.idle" });
  assert.equal(canStartRecording(state), true);

  state = reduceMediaState(state, { type: "talk.active" });
  state = reduceMediaState(state, { type: "talk.idle" });
  assert.equal(canStartTalk(state), true);
});

test("finalizing recording stays pending and cannot start a second stream", () => {
  let state = reduceMediaState(initialState(), { type: "playback", playState: "playing" });
  state = reduceMediaState(state, { type: "record.active", startedAt: 10, id: "record-1" });
  state = reduceMediaState(state, { type: "record.stopping" });
  state = reduceMediaState(state, { type: "record.finalizing", id: "record-1" });

  assert.equal(state.record, "finalizing");
  assert.equal(canStartRecording(state), false);
});

test("a generic media failure releases pending recording and talk actions", () => {
  let state = reduceMediaState(initialState(), { type: "record.active", startedAt: 10, id: "record-1" });
  state = reduceMediaState(state, { type: "record.stopping" });
  state = reduceMediaState(state, { type: "talk.active" });

  state = reduceMediaState(state, { type: "media.failed", error: "MEDIA_CONTROL_FAILED" });

  assert.equal(state.record, "failed");
  assert.equal(state.recordStartedAt, 0);
  assert.equal(state.talk, "idle");
  assert.equal(state.error, "MEDIA_CONTROL_FAILED");
});

test("media action acknowledgements end only the matching short command watchdog", () => {
  assert.deepEqual(mediaActionAcknowledgements("record.stopping"), ["record"]);
  assert.deepEqual(mediaActionAcknowledgements("record.finalizing"), ["record"]);
  assert.deepEqual(mediaActionAcknowledgements("record.ready"), ["record"]);
  assert.deepEqual(mediaActionAcknowledgements("talk.stopping"), ["talk"]);
  assert.deepEqual(mediaActionAcknowledgements("talk.idle"), ["talk"]);
  assert.deepEqual(mediaActionAcknowledgements("media.failed"), ["record", "talk"]);
  assert.deepEqual(mediaActionAcknowledgements("record.starting"), []);
});

test("recording save ledger deduplicates successful saves but permits retry after failure", () => {
  const ledger = createRecordingSaveLedger();
  assert.equal(ledger.begin("record-1"), true);
  assert.equal(ledger.begin("record-1"), false);
  ledger.succeed("record-1");
  assert.equal(ledger.begin("record-1"), false);

  assert.equal(ledger.begin("record-2"), true);
  ledger.fail("record-2");
  assert.equal(ledger.begin("record-2"), true);
});
