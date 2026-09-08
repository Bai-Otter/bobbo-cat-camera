const crypto = require("crypto");

const TOKEN_VERSION = "v1";
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sessionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cleanOpenid(value) {
  return String(value || "").trim().slice(0, 128);
}

function createAppSessionService(options = {}) {
  const secret = String(options.secret || "");
  if (Buffer.byteLength(secret) < 32) throw sessionError("SESSION_SECRET_INVALID");

  const ttlMs = Math.max(1, Number(options.ttlMs) || DEFAULT_TTL_MS);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const randomId = typeof options.randomId === "function"
    ? options.randomId
    : () => crypto.randomUUID();

  function sign(encodedPayload) {
    return crypto
      .createHmac("sha256", secret)
      .update(`${TOKEN_VERSION}.${encodedPayload}`)
      .digest("base64url");
  }

  function issue(openid) {
    const trustedOpenid = cleanOpenid(openid);
    if (!trustedOpenid) throw sessionError("SESSION_IDENTITY_REQUIRED");
    const issuedAt = Number(now());
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      sid: String(randomId()),
      openid: trustedOpenid,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
    })).toString("base64url");
    return `${TOKEN_VERSION}.${payload}.${sign(payload)}`;
  }

  function verify(token, expectedOpenid) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !safeEqual(parts[2], sign(parts[1]))) {
      throw sessionError("SESSION_INVALID");
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch (error) {
      throw sessionError("SESSION_INVALID");
    }
    if (
      !payload ||
      payload.v !== 1 ||
      !cleanOpenid(payload.openid) ||
      !Number.isFinite(Number(payload.expiresAt))
    ) {
      throw sessionError("SESSION_INVALID");
    }
    if (Number(now()) > Number(payload.expiresAt)) throw sessionError("SESSION_EXPIRED");

    const trustedOpenid = cleanOpenid(expectedOpenid);
    if (trustedOpenid && payload.openid !== trustedOpenid) {
      throw sessionError("SESSION_IDENTITY_MISMATCH");
    }
    return { ...payload };
  }

  return { issue, verify };
}

module.exports = { createAppSessionService };
