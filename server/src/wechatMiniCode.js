const https = require("node:https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { getHttpsProxyUrl } = require("./wechatLogin");

const TOKEN_ENDPOINT = "https://api.weixin.qq.com/cgi-bin/token";
const CODE_ENDPOINT = "https://api.weixin.qq.com/wxa/getwxacodeunlimit";

function miniCodeError(code, providerCode = 0) {
  const error = new Error(code);
  error.code = code;
  if (providerCode) error.providerCode = Number(providerCode);
  return error;
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function requestBuffer(url, options = {}) {
  const method = options.method || "GET";
  const body = options.body ? Buffer.from(JSON.stringify(options.body)) : null;
  const proxyUrl = options.proxyUrl === undefined ? getHttpsProxyUrl() : options.proxyUrl;
  const requestImpl = options.requestImpl || https.request;
  return new Promise((resolve, reject) => {
    const requestOptions = {
      method,
      timeout: Math.max(1000, Number(options.timeoutMs) || 5000),
      headers: body ? {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      } : {},
    };
    if (proxyUrl) requestOptions.agent = new HttpsProxyAgent(proxyUrl);
    const req = requestImpl(url, requestOptions, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 2 * 1024 * 1024) req.destroy(miniCodeError("WECHAT_MINICODE_INVALID_RESPONSE"));
        else chunks.push(bytes);
      });
      res.on("end", () => {
        if (Number(res.statusCode) < 200 || Number(res.statusCode) >= 300) {
          reject(miniCodeError("WECHAT_MINICODE_PROVIDER_UNAVAILABLE"));
          return;
        }
        resolve({ contentType: String(res.headers["content-type"] || ""), body: Buffer.concat(chunks) });
      });
    });
    req.on("timeout", () => req.destroy(miniCodeError("WECHAT_MINICODE_TIMEOUT")));
    req.on("error", (error) => reject(error?.code?.startsWith("WECHAT_")
      ? error
      : miniCodeError("WECHAT_MINICODE_PROVIDER_UNAVAILABLE")));
    if (body) req.write(body);
    req.end();
  });
}

function parseProviderJson(response) {
  try {
    return JSON.parse(response.body.toString("utf8") || "{}");
  } catch {
    throw miniCodeError("WECHAT_MINICODE_INVALID_RESPONSE");
  }
}

function createWechatMiniCodeService(options = {}) {
  const appId = cleanText(options.appId, 128);
  const appSecret = cleanText(options.appSecret, 256);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
	const request = options.request || requestBuffer;
  const defaultEnvVersion = ["release", "trial", "develop"].includes(options.envVersion)
		? options.envVersion
		: "release";
  const defaultCheckPath = options.checkPath === undefined ? true : !!options.checkPath;
  const now = options.now || Date.now;
  let cachedToken = null;

  async function getAccessToken() {
    if (!appId || !appSecret) throw miniCodeError("WECHAT_MINICODE_NOT_CONFIGURED");
    if (cachedToken && cachedToken.expiresAt > now() + 60_000) return cachedToken.value;
    const url = new URL(TOKEN_ENDPOINT);
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set("appid", appId);
    url.searchParams.set("secret", appSecret);
    const payload = parseProviderJson(await request(url, { timeoutMs }));
    if (Number(payload.errcode)) throw miniCodeError("WECHAT_MINICODE_PROVIDER_ERROR", payload.errcode);
    const value = cleanText(payload.access_token, 512);
    if (!value) throw miniCodeError("WECHAT_MINICODE_INVALID_RESPONSE");
    cachedToken = {
      value,
      expiresAt: now() + Math.max(300, Number(payload.expires_in) || 7200) * 1000,
    };
    return value;
  }

  async function create(input = {}) {
    const scene = cleanText(input.scene, 32);
    const page = cleanText(input.page, 128);
    if (!scene || !page) throw miniCodeError("WECHAT_MINICODE_REQUEST_INVALID");
    const accessToken = await getAccessToken();
    const url = new URL(CODE_ENDPOINT);
    url.searchParams.set("access_token", accessToken);
    const response = await request(url, {
      method: "POST",
      timeoutMs,
		body: {
        scene,
        page,
        check_path: input.checkPath === undefined ? defaultCheckPath : !!input.checkPath,
        env_version: input.envVersion || defaultEnvVersion,
        width: 430,
      },
    });
    if (/image\//i.test(response.contentType) && response.body.length > 8) return response.body;
    const payload = parseProviderJson(response);
    throw miniCodeError("WECHAT_MINICODE_PROVIDER_ERROR", payload.errcode);
  }

  return { create, getAccessToken };
}

module.exports = { createWechatMiniCodeService, requestBuffer };
