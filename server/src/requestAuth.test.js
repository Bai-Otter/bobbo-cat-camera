const test = require("node:test");
const assert = require("node:assert/strict");

const { createAppSessionService } = require("./appSession");
const { createRequestAuth } = require("./requestAuth");

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

const sessions = createAppSessionService({
  secret: "request-auth-test-secret-at-least-32-bytes",
  now: () => 1_000_000,
});

test("trusted identity ignores body claims", () => {
  const auth = createRequestAuth({ sessions });
  const req = {
    headers: { "x-wx-openid": "openid-owner", "x-wx-source": "wx_client" },
    body: { openid: "openid-attacker" },
    get(name) { return this.headers[name.toLowerCase()] || ""; },
  };
  const res = responseRecorder();
  let called = false;

  auth.requireTrustedIdentity(req, res, () => { called = true; });

  assert.equal(called, true);
  assert.deepEqual(req.auth, { openid: "openid-owner" });
});

test("trusted identity rejects an openid without a CloudBase source marker", () => {
  const auth = createRequestAuth({ sessions });
  const req = {
    headers: { "x-wx-openid": "openid-attacker" },
    get(name) { return this.headers[name.toLowerCase()] || ""; },
  };
  const res = responseRecorder();

  auth.requireTrustedIdentity(req, res, () => assert.fail("spoofed identity must not continue"));

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.payload, { ok: false, error: "AUTH_REQUIRED" });
});

test("business auth requires matching trusted identity and signed session", () => {
  const auth = createRequestAuth({ sessions });
  const token = sessions.issue("openid-owner");
  const req = {
    headers: { "x-wx-openid": "openid-other", "x-wx-source": "wx_client", "x-cat-session": token },
    get(name) { return this.headers[name.toLowerCase()] || ""; },
  };
  const res = responseRecorder();

  auth.requireSession(req, res, () => assert.fail("mismatched identity must not continue"));

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.payload, { ok: false, error: "SESSION_INVALID" });
});

test("development identity header is opt-in and disabled in production", () => {
  const req = {
    headers: { "x-cat-dev-openid": "openid-dev" },
    get(name) { return this.headers[name.toLowerCase()] || ""; },
  };
  const enabled = createRequestAuth({ sessions, allowDevelopmentIdentity: true, nodeEnv: "development" });
  const production = createRequestAuth({ sessions, allowDevelopmentIdentity: true, nodeEnv: "production" });
  const enabledRes = responseRecorder();
  const productionRes = responseRecorder();

  enabled.requireTrustedIdentity(req, enabledRes, () => {});
  assert.deepEqual(req.auth, { openid: "openid-dev" });

  delete req.auth;
  production.requireTrustedIdentity(req, productionRes, () => assert.fail("production dev identity must fail"));
  assert.equal(productionRes.statusCode, 401);
  assert.equal(productionRes.payload.error, "AUTH_REQUIRED");
});

test("throwing authenticator verifies the trusted identity and explicit session token", () => {
  const auth = createRequestAuth({ sessions });
  const token = sessions.issue("openid-owner");
  const req = {
    headers: { "x-wx-openid": "openid-owner", "x-wx-source": "wx_client" },
    get(name) { return this.headers[name.toLowerCase()] || ""; },
  };

  assert.deepEqual(auth.authenticate(req, token), { openid: "openid-owner" });
  assert.throws(() => auth.authenticate(req, "bad-session"), { code: "SESSION_INVALID" });
  assert.throws(() => auth.authenticate({ get: () => "" }, token), { code: "AUTH_REQUIRED" });
});

test("self-hosted authentication recovers identity from the signed session only", () => {
  const auth = createRequestAuth({
    sessions,
    allowSessionIdentity: true,
    trustCloudHeaders: false,
  });
  const token = sessions.issue("openid-owner");
  const noCloudHeaders = {
    headers: { "x-cat-session": token },
    get(name) { return this.headers[name.toLowerCase()] || ""; },
  };
  const forgedHeaders = {
    headers: {
      "x-cat-session": token,
      "x-wx-openid": "openid-attacker",
      "x-wx-source": "wx_client",
    },
    get(name) { return this.headers[name.toLowerCase()] || ""; },
  };

  assert.deepEqual(auth.authenticate(noCloudHeaders, token), { openid: "openid-owner" });
  assert.deepEqual(auth.authenticate(forgedHeaders, token), { openid: "openid-owner" });
});
