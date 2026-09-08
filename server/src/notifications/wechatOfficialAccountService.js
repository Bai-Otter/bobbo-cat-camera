const crypto = require("node:crypto");

const TOKEN_ENDPOINT = "https://api.weixin.qq.com/cgi-bin/stable_token";
const USER_INFO_ENDPOINT = "https://api.weixin.qq.com/cgi-bin/user/info";
const TEMPLATE_SEND_ENDPOINT = "https://api.weixin.qq.com/cgi-bin/message/template/send";
const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001]);

function cleanText(value, maxLength = 512) {
  return String(value || "").trim().slice(0, maxLength);
}

function providerError(code, providerCode = 0, providerMessage = "") {
  const error = new Error(code);
  error.code = code;
  error.providerCode = Number(providerCode) || 0;
  error.providerMessage = cleanText(providerMessage, 160);
  return error;
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyWechatSignature({ token, timestamp, nonce, signature } = {}) {
  if (!token || !timestamp || !nonce || !signature) return false;
  const expected = crypto.createHash("sha1")
    .update([String(token), String(timestamp), String(nonce)].sort().join(""))
    .digest("hex");
  return safeEqual(expected, signature);
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseWechatEventXml(xmlValue) {
  const xml = String(xmlValue || "");
  if (!xml || Buffer.byteLength(xml) > 64 * 1024) throw new Error("WECHAT_OFFICIAL_XML_INVALID");
  if (/<!DOCTYPE|<!ENTITY|SYSTEM\s+['"]|PUBLIC\s+['"]/i.test(xml)) {
    throw new Error("WECHAT_OFFICIAL_XML_UNSAFE");
  }
  const read = (name) => {
    const match = xml.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${name}>`, "i"));
    return cleanText(decodeXml(match && (match[1] !== undefined ? match[1] : match[2])), 1024);
  };
  return {
    toUserName: read("ToUserName"),
    fromUserName: read("FromUserName"),
    messageType: read("MsgType").toLowerCase(),
    event: read("Event").toLowerCase(),
    eventKey: read("EventKey"),
  };
}

function replaceTemplateValues(value, context = {}) {
  if (Array.isArray(value)) return value.map((item) => replaceTemplateValues(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTemplateValues(item, context)]));
  }
  if (typeof value !== "string") return value;
  return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => (
    context[key] === undefined || context[key] === null ? "" : String(context[key])
  ));
}

class WechatOfficialAccountService {
  constructor(options = {}) {
    this.appId = cleanText(options.appId, 128);
    this.appSecret = cleanText(options.appSecret, 256);
    this.callbackToken = cleanText(options.callbackToken, 256);
    this.encodingAesKey = cleanText(options.encodingAesKey, 256);
    this.miniProgramAppId = cleanText(options.miniProgramAppId, 128);
    this.startTemplateId = cleanText(options.startTemplateId, 128);
    this.endTemplateId = cleanText(options.endTemplateId, 128);
    this.startData = options.startData && typeof options.startData === "object" ? options.startData : {};
    this.endData = options.endData && typeof options.endData === "object" ? options.endData : {};
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || Date.now;
    this.cachedToken = null;
  }

  isConfigured() {
    return !!(this.appId && this.appSecret && this.startTemplateId && this.endTemplateId && typeof this.fetchImpl === "function");
  }

  isCallbackConfigured() {
    return !!this.callbackToken;
  }

  verifyCallback(query = {}) {
    if (query.encrypt_type === "aes" || query.msg_signature) {
      return { ok: false, error: "WECHAT_OFFICIAL_AES_CALLBACK_NOT_ENABLED" };
    }
    return {
      ok: verifyWechatSignature({
        token: this.callbackToken,
        timestamp: query.timestamp,
        nonce: query.nonce,
        signature: query.signature,
      }),
    };
  }

  getTemplateId(eventType) {
    return eventType === "feeding_end" ? this.endTemplateId : this.startTemplateId;
  }

  buildData(eventType, context = {}) {
    return replaceTemplateValues(eventType === "feeding_end" ? this.endData : this.startData, context);
  }

  async requestJson(url, options = {}) {
    if (typeof this.fetchImpl !== "function") throw providerError("WECHAT_OFFICIAL_FETCH_UNAVAILABLE");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...options, signal: controller.signal });
      if (!response || !response.ok) {
        throw providerError("WECHAT_OFFICIAL_PROVIDER_UNAVAILABLE", Number(response && response.status));
      }
      return await response.json();
    } catch (error) {
      if (error && error.code && String(error.code).startsWith("WECHAT_OFFICIAL_")) throw error;
      if (error && error.name === "AbortError") throw providerError("WECHAT_OFFICIAL_TIMEOUT");
      throw providerError("WECHAT_OFFICIAL_PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccessToken({ force = false } = {}) {
    if (!this.appId || !this.appSecret) throw providerError("WECHAT_OFFICIAL_NOT_CONFIGURED");
    if (!force && this.cachedToken && this.cachedToken.expiresAt > this.now() + 60_000) {
      return this.cachedToken.value;
    }
    const payload = await this.requestJson(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credential",
        appid: this.appId,
        secret: this.appSecret,
        force_refresh: !!force,
      }),
    });
    if (Number(payload && payload.errcode)) {
      throw providerError("WECHAT_OFFICIAL_TOKEN_REJECTED", payload.errcode, payload.errmsg);
    }
    const value = cleanText(payload && payload.access_token, 1024);
    if (!value) throw providerError("WECHAT_OFFICIAL_TOKEN_INVALID_RESPONSE");
    this.cachedToken = { value, expiresAt: this.now() + Math.max(300, Number(payload.expires_in) || 7200) * 1000 };
    return value;
  }

  async callWithToken(endpoint, optionsFactory, retry = true) {
    const token = await this.getAccessToken();
    const url = new URL(endpoint);
    url.searchParams.set("access_token", token);
    const payload = await this.requestJson(url, optionsFactory());
    const providerCode = Number(payload && payload.errcode) || 0;
    if (providerCode && retry && TOKEN_ERROR_CODES.has(providerCode)) {
      this.cachedToken = null;
      return this.callWithToken(endpoint, optionsFactory, false);
    }
    if (providerCode) throw providerError("WECHAT_OFFICIAL_PROVIDER_REJECTED", providerCode, payload.errmsg);
    return payload || {};
  }

  async getFollower(officialOpenidValue, retry = true) {
    const officialOpenid = cleanText(officialOpenidValue, 128);
    if (!officialOpenid) throw providerError("WECHAT_OFFICIAL_OPENID_REQUIRED");
    const token = await this.getAccessToken();
    const url = new URL(USER_INFO_ENDPOINT);
    url.searchParams.set("access_token", token);
    url.searchParams.set("openid", officialOpenid);
    url.searchParams.set("lang", "zh_CN");
    const payload = await this.requestJson(url, { method: "GET" });
    const providerCode = Number(payload && payload.errcode) || 0;
    if (providerCode && retry && TOKEN_ERROR_CODES.has(providerCode)) {
      this.cachedToken = null;
      return this.getFollower(officialOpenid, false);
    }
    if (providerCode) throw providerError("WECHAT_OFFICIAL_PROVIDER_REJECTED", providerCode, payload.errmsg);
    return {
      officialOpenid,
      unionid: cleanText(payload.unionid, 128),
      subscribed: Number(payload.subscribe) === 1,
    };
  }

  async send(input = {}) {
    if (!this.isConfigured()) throw providerError("WECHAT_OFFICIAL_NOT_CONFIGURED");
    const officialOpenid = cleanText(input.officialOpenid, 128);
    const eventType = input.eventType === "feeding_end" ? "feeding_end" : "feeding_start";
    if (!officialOpenid) throw providerError("WECHAT_OFFICIAL_SEND_INVALID");
    await this.callWithToken(TEMPLATE_SEND_ENDPOINT, () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: officialOpenid,
        template_id: this.getTemplateId(eventType),
        url: cleanText(input.url, 2048),
        miniprogram: input.miniprogram || undefined,
        data: input.data && typeof input.data === "object" ? input.data : {},
      }),
    }));
    return { ok: true, provider: "official_account" };
  }
}

module.exports = {
  WechatOfficialAccountService,
  parseWechatEventXml,
  verifyWechatSignature,
};
