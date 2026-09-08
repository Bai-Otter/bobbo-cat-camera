const TOKEN_ENDPOINT = "https://api.weixin.qq.com/cgi-bin/stable_token";
const SUBSCRIBE_MESSAGE_ENDPOINT = "https://api.weixin.qq.com/cgi-bin/message/subscribe/send";
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

function normalizeMiniProgramState(value) {
  const state = cleanText(value, 20).toLowerCase();
  if (state === "trial") return "trial";
  if (state === "developer" || state === "develop") return "developer";
  return "formal";
}

function replaceTemplateValues(value, context = {}) {
  if (Array.isArray(value)) return value.map((item) => replaceTemplateValues(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceTemplateValues(item, context)])
    );
  }
  if (typeof value !== "string") return value;
  return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => (
    context[key] === undefined || context[key] === null ? "" : String(context[key])
  ));
}

class WechatMiniSubscriptionService {
  constructor(options = {}) {
    this.appId = cleanText(options.appId, 128);
    this.appSecret = cleanText(options.appSecret, 256);
    this.startTemplateId = cleanText(options.startTemplateId, 128);
    this.endTemplateId = cleanText(options.endTemplateId, 128);
    this.startData = options.startData && typeof options.startData === "object" ? options.startData : {};
    this.endData = options.endData && typeof options.endData === "object" ? options.endData : {};
    this.page = cleanText(options.page, 1024) || "pages/today/index";
    this.miniProgramState = normalizeMiniProgramState(options.miniProgramState);
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || Date.now;
    this.cachedToken = null;
  }

  isConfigured() {
    return !!(
      this.appId && this.appSecret && this.startTemplateId && this.endTemplateId &&
      typeof this.fetchImpl === "function"
    );
  }

  getTemplates() {
    return [
      { eventType: "feeding_start", templateId: this.startTemplateId },
      { eventType: "feeding_end", templateId: this.endTemplateId },
    ].filter((item) => item.templateId);
  }

  getTemplateId(eventType) {
    return eventType === "feeding_end" ? this.endTemplateId : this.startTemplateId;
  }

  buildData(eventType, context = {}) {
    return replaceTemplateValues(
      eventType === "feeding_end" ? this.endData : this.startData,
      context
    );
  }

  async requestJson(url, body) {
    if (typeof this.fetchImpl !== "function") throw providerError("WECHAT_MINI_FETCH_UNAVAILABLE");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
      if (!response || !response.ok) {
        throw providerError("WECHAT_MINI_PROVIDER_UNAVAILABLE", Number(response && response.status));
      }
      return await response.json();
    } catch (error) {
      if (error && error.code && String(error.code).startsWith("WECHAT_MINI_")) throw error;
      if (error && error.name === "AbortError") throw providerError("WECHAT_MINI_TIMEOUT");
      throw providerError("WECHAT_MINI_PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccessToken({ force = false } = {}) {
    if (!this.appId || !this.appSecret) throw providerError("WECHAT_MINI_NOT_CONFIGURED");
    if (!force && this.cachedToken && this.cachedToken.expiresAt > this.now() + 60_000) {
      return this.cachedToken.value;
    }
    const payload = await this.requestJson(TOKEN_ENDPOINT, {
      grant_type: "client_credential",
      appid: this.appId,
      secret: this.appSecret,
      force_refresh: !!force,
    });
    if (Number(payload && payload.errcode)) {
      throw providerError("WECHAT_MINI_TOKEN_REJECTED", payload.errcode, payload.errmsg);
    }
    const value = cleanText(payload && payload.access_token, 1024);
    if (!value) throw providerError("WECHAT_MINI_TOKEN_INVALID_RESPONSE");
    this.cachedToken = {
      value,
      expiresAt: this.now() + Math.max(300, Number(payload.expires_in) || 7200) * 1000,
    };
    return value;
  }

  async callWithToken(body, retryToken = true) {
    const token = await this.getAccessToken();
    const url = new URL(SUBSCRIBE_MESSAGE_ENDPOINT);
    url.searchParams.set("access_token", token);
    const payload = await this.requestJson(url, body);
    const providerCode = Number(payload && payload.errcode) || 0;
    if (providerCode && retryToken && TOKEN_ERROR_CODES.has(providerCode)) {
      this.cachedToken = null;
      return this.callWithToken(body, false);
    }
    if (providerCode) {
      throw providerError("WECHAT_MINI_PROVIDER_REJECTED", providerCode, payload.errmsg);
    }
    return payload || {};
  }

  async send(input = {}) {
    if (!this.isConfigured()) throw providerError("WECHAT_MINI_NOT_CONFIGURED");
    const openid = cleanText(input.openid, 128);
    const eventType = input.eventType === "feeding_end" ? "feeding_end" : "feeding_start";
    const templateId = this.getTemplateId(eventType);
    if (!openid || !templateId) throw providerError("WECHAT_MINI_SEND_INVALID");
    await this.callWithToken({
      touser: openid,
      template_id: templateId,
      page: cleanText(input.page, 1024) || this.page,
      miniprogram_state: this.miniProgramState,
      lang: "zh_CN",
      data: input.data && typeof input.data === "object" ? input.data : {},
    });
    return { ok: true, provider: "mini_subscription" };
  }
}

module.exports = {
  WechatMiniSubscriptionService,
  normalizeMiniProgramState,
  replaceTemplateValues,
};
