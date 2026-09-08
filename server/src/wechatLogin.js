const https = require("node:https");
const { HttpsProxyAgent } = require("https-proxy-agent");

const LOGIN_ENDPOINT = "https://api.weixin.qq.com/sns/jscode2session";

function loginError(code, providerCode = 0) {
  const error = new Error(code);
  error.code = code;
  if (providerCode) error.providerCode = Number(providerCode);
  return error;
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function getHttpsProxyUrl(env = process.env) {
  return cleanText(
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy,
    2048
  );
}

function defaultRequestJson(
  url,
  {
    timeoutMs = 5000,
    proxyUrl = getHttpsProxyUrl(),
    requestGet = https.get,
  } = {}
) {
  return new Promise((resolve, reject) => {
    const requestOptions = { timeout: timeoutMs };
    if (proxyUrl) requestOptions.agent = new HttpsProxyAgent(proxyUrl);

    const req = requestGet(url, requestOptions, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 32 * 1024) req.destroy(loginError("WECHAT_LOGIN_INVALID_RESPONSE"));
      });
      res.on("end", () => {
        if (Number(res.statusCode) < 200 || Number(res.statusCode) >= 300) {
          reject(loginError("WECHAT_LOGIN_PROVIDER_UNAVAILABLE"));
          return;
        }
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          reject(loginError("WECHAT_LOGIN_INVALID_RESPONSE"));
        }
      });
    });
    req.on("timeout", () => req.destroy(loginError("WECHAT_LOGIN_TIMEOUT")));
    req.on("error", (error) => {
      reject(error && error.code && String(error.code).startsWith("WECHAT_")
        ? error
        : loginError("WECHAT_LOGIN_PROVIDER_UNAVAILABLE"));
    });
  });
}

function createWechatLoginService(options = {}) {
  const appId = cleanText(options.appId, 128);
  const appSecret = cleanText(options.appSecret, 256);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
  const requestJson = options.requestJson || defaultRequestJson;

  async function exchange(codeValue) {
    if (!appId || !appSecret) throw loginError("WECHAT_LOGIN_NOT_CONFIGURED");
    const code = cleanText(codeValue, 256);
    if (!code) throw loginError("WECHAT_LOGIN_CODE_REQUIRED");

    const url = new URL(LOGIN_ENDPOINT);
    url.searchParams.set("appid", appId);
    url.searchParams.set("secret", appSecret);
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");

    const payload = await requestJson(url, { timeoutMs });
    if (Number(payload && payload.errcode)) {
      throw loginError("WECHAT_LOGIN_PROVIDER_ERROR", payload.errcode);
    }
    const openid = cleanText(payload && payload.openid, 128);
    if (!openid) throw loginError("WECHAT_LOGIN_INVALID_RESPONSE");
    return {
      openid,
      unionid: cleanText(payload && payload.unionid, 128),
    };
  }

  return { exchange };
}

module.exports = {
  createWechatLoginService,
  defaultRequestJson,
  getHttpsProxyUrl,
};
