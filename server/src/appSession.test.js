const test = require("node:test");
const assert = require("node:assert/strict");

const { createAppSessionService } = require("./appSession");

test("signed sessions bind a token to the trusted WeChat identity", () => {
  const sessions = createAppSessionService({
    secret: "test-secret-with-at-least-32-bytes",
    ttlMs: 60_000,
    now: () => 1_000_000,
    randomId: () => "session-id",
  });

  const token = sessions.issue("openid-owner");

  assert.equal(sessions.verify(token, "openid-owner").openid, "openid-owner");
  assert.throws(
    () => sessions.verify(token, "openid-other"),
    /SESSION_IDENTITY_MISMATCH/
  );
  assert.throws(() => sessions.verify(`${token}x`, "openid-owner"), /SESSION_INVALID/);
});

test("signed sessions expire at the configured deadline", () => {
  let currentTime = 1_000_000;
  const sessions = createAppSessionService({
    secret: "test-secret-with-at-least-32-bytes",
    ttlMs: 60_000,
    now: () => currentTime,
    randomId: () => "session-id",
  });

  const token = sessions.issue("openid-owner");
  currentTime = 1_060_001;

  assert.throws(() => sessions.verify(token, "openid-owner"), /SESSION_EXPIRED/);
});

test("signed sessions default to thirty days for long-running mini-program use", () => {
  const now = 1_000_000;
  const sessions = createAppSessionService({
    secret: "test-secret-with-at-least-32-bytes",
    now: () => now,
    randomId: () => "session-id",
  });

  const payload = sessions.verify(sessions.issue("openid-owner"), "openid-owner");
  assert.equal(payload.expiresAt - payload.issuedAt, 30 * 24 * 60 * 60 * 1000);
});
