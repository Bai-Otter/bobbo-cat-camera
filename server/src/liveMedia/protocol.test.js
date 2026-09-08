const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseControlMessage,
  validateAudioFrame,
  mediaEvent,
  mediaError,
} = require("./protocol");
const { createAppSessionService } = require("../appSession");

test("media protocol accepts only the documented command shapes", () => {
  assert.deepEqual(parseControlMessage('{"type":"record.start","sessionId":"hls-1"}'), {
    type: "record.start",
    sessionId: "hls-1",
  });
  assert.deepEqual(parseControlMessage('{"type":"talk.start"}'), { type: "talk.start" });
  assert.deepEqual(parseControlMessage('{"type":"authorize","token":"session-ok"}'), {
    type: "authorize",
    token: "session-ok",
  });
  assert.deepEqual(parseControlMessage('{"type":"ping"}'), { type: "ping" });
  assert.throws(
    () => parseControlMessage('{"type":"record.start","sourceUrl":"https://evil.test"}'),
    { code: "MEDIA_MESSAGE_INVALID" }
  );
  assert.throws(() => parseControlMessage('{"type":"unknown"}'), { code: "MEDIA_MESSAGE_INVALID" });
});

test("media protocol enforces message and identifier limits", () => {
  assert.throws(() => parseControlMessage("x".repeat(8193)), { code: "MEDIA_MESSAGE_TOO_LARGE" });
  assert.throws(
    () => parseControlMessage(JSON.stringify({ type: "authorize", token: "../unsafe" })),
    { code: "MEDIA_MESSAGE_INVALID" }
  );
  assert.throws(
    () => parseControlMessage(JSON.stringify({ type: "authorize", token: "a".repeat(1025) })),
    { code: "MEDIA_MESSAGE_INVALID" }
  );
  assert.throws(
    () => parseControlMessage(JSON.stringify({ type: "record.start", sessionId: "a".repeat(129) })),
    { code: "MEDIA_MESSAGE_INVALID" }
  );
});

test("media protocol accepts the signed app session token used by real clients", () => {
  const sessions = createAppSessionService({
    secret: "test-session-secret-that-is-at-least-32-bytes",
    ttlMs: 60 * 60 * 1000,
  });
  const token = sessions.issue("o6-zyxeuB-ws7Sngc_LiTqdDF6Lk");

  assert.ok(token.length > 128, "regression requires a production-shaped signed token");
  assert.deepEqual(parseControlMessage(JSON.stringify({ type: "authorize", token })), {
    type: "authorize",
    token,
  });
});

test("media protocol bounds binary AAC frames", () => {
  assert.equal(validateAudioFrame(Buffer.alloc(4096)), 4096);
  assert.throws(() => validateAudioFrame(Buffer.alloc(0)), { code: "AUDIO_FRAME_INVALID" });
  assert.throws(() => validateAudioFrame(Buffer.alloc(65537)), { code: "AUDIO_FRAME_TOO_LARGE" });
  assert.throws(() => validateAudioFrame("not-binary"), { code: "AUDIO_FRAME_INVALID" });
});

test("media protocol emits stable public events and errors", () => {
  assert.deepEqual(mediaEvent("talk", "active", { startedAt: 10 }), {
    type: "talk.active",
    startedAt: 10,
  });
  assert.deepEqual(mediaError("record", "LIVE_SESSION_NOT_FOUND"), {
    type: "record.failed",
    error: "LIVE_SESSION_NOT_FOUND",
  });
});
