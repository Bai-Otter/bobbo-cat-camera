function cleanOpenid(value) {
  return String(value || "").trim().slice(0, 128);
}

function sendAuthError(res, error) {
  return res.status(401).json({ ok: false, error });
}

function authError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function createRequestAuth(options = {}) {
  if (!options.sessions) throw new Error("APP_SESSION_SERVICE_REQUIRED");
  const sessions = options.sessions;
  const nodeEnv = options.nodeEnv || process.env.NODE_ENV || "development";
  const allowDevelopmentIdentity =
    !!options.allowDevelopmentIdentity && nodeEnv !== "production";
  const allowSessionIdentity = !!options.allowSessionIdentity;
  const trustCloudHeaders = options.trustCloudHeaders !== false;

  function resolveTrustedOpenid(req) {
    const cloudSource = String(req.get("x-wx-source") || "").trim().toLowerCase();
    const authMethod = String(req.get("x-authmethod") || "").trim().toUpperCase();
    const isTrustedCloudRequest = trustCloudHeaders && (
      cloudSource === "wx_client" ||
      cloudSource === "wx_devtools" ||
      authMethod === "WX_SERVER_AUTH"
    );
    const cloudOpenid = cleanOpenid(req.get("x-wx-openid"));
    if (isTrustedCloudRequest && cloudOpenid) return cloudOpenid;
    if (allowDevelopmentIdentity) return cleanOpenid(req.get("x-cat-dev-openid"));
    return "";
  }

  function requireTrustedIdentity(req, res, next) {
    const openid = resolveTrustedOpenid(req);
    if (!openid) return sendAuthError(res, "AUTH_REQUIRED");
    req.auth = { openid };
    return next();
  }

  function authenticate(req, tokenValue) {
    const openid = resolveTrustedOpenid(req);
    const token = String(tokenValue || "").trim();
    if (!token || (!openid && !allowSessionIdentity)) throw authError("AUTH_REQUIRED");
    try {
      const payload = sessions.verify(token, openid || undefined);
      return { openid: openid || payload.openid };
    } catch {
      throw authError("SESSION_INVALID");
    }
  }

  function requireSession(req, res, next) {
    try {
      req.auth = authenticate(req, req.get("x-cat-session"));
    } catch (error) {
      return sendAuthError(res, error.code || "SESSION_INVALID");
    }
    return next();
  }

  return { authenticate, requireTrustedIdentity, requireSession, resolveTrustedOpenid };
}

module.exports = { createRequestAuth };
