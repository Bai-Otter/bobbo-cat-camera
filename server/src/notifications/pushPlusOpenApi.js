function redactMessage(error, secrets = []) {
  let message = String((error && error.message) || error || "PUSHPLUS_OPEN_API_FAILED");
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, "[redacted]");
  return message.slice(0, 240);
}

class PushPlusOpenApi {
  constructor({
    token = "",
    secretKey = "",
    baseUrl = "https://www.pushplus.plus",
    timeoutMs = 5000,
    fetchImpl = globalThis.fetch,
    nowProvider = () => Date.now(),
  } = {}) {
    this.token = String(token || "").trim();
    this.secretKey = String(secretKey || "").trim();
    this.baseUrl = String(baseUrl || "https://www.pushplus.plus").replace(/\/+$/, "");
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 5000);
    this.fetchImpl = fetchImpl;
    this.nowProvider = nowProvider;
    this.accessKey = "";
    this.accessKeyExpiresAt = 0;
  }

  isConfigured() {
    return !!(this.token && this.secretKey);
  }

  async requestJson(url, options = {}) {
    if (typeof this.fetchImpl !== "function") throw new Error("PUSHPLUS_FETCH_UNAVAILABLE");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...options, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`PUSHPLUS_OPEN_API_HTTP_${response.status}`);
      if (Number(body.code) !== 200) {
        throw new Error(`PUSHPLUS_OPEN_API_REJECTED: ${String(body.msg || body.code || "unknown error")}`);
      }
      return body.data;
    } catch (error) {
      const normalized = error && error.name === "AbortError"
        ? new Error("PUSHPLUS_OPEN_API_TIMEOUT")
        : error;
      throw new Error(redactMessage(normalized, [this.token, this.secretKey, this.accessKey]));
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccessKey() {
    if (!this.isConfigured()) throw new Error("PUSHPLUS_OPEN_API_NOT_CONFIGURED");
    const now = Number(this.nowProvider()) || Date.now();
    if (this.accessKey && now < this.accessKeyExpiresAt) return this.accessKey;
    const data = await this.requestJson(`${this.baseUrl}/api/common/openApi/getAccessKey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, secretKey: this.secretKey }),
    });
    const accessKey = String((data && data.accessKey) || "").trim();
    if (!accessKey) throw new Error("PUSHPLUS_ACCESS_KEY_MISSING");
    const expiresInMs = Math.max(60, Number(data.expiresIn) || 7200) * 1000;
    this.accessKey = accessKey;
    this.accessKeyExpiresAt = now + Math.max(1000, expiresInMs - 60_000);
    return accessKey;
  }

  async getFriendQrCode({ content = "", second = 2_592_000, scanCount = 1 } = {}) {
    if (!this.isConfigured()) throw new Error("PUSHPLUS_OPEN_API_NOT_CONFIGURED");
    const accessKey = await this.getAccessKey();
    const url = new URL(`${this.baseUrl}/api/open/friend/getQrCode`);
    url.searchParams.set("content", String(content || ""));
    url.searchParams.set("second", String(second));
    url.searchParams.set("scanCount", String(scanCount));
    const data = await this.requestJson(url.toString(), {
      method: "GET",
      headers: { "access-key": accessKey },
    });
    const qrCodeImgUrl = String((data && data.qrCodeImgUrl) || "").trim();
    if (!qrCodeImgUrl) throw new Error("PUSHPLUS_FRIEND_QR_MISSING");
    return { qrCodeImgUrl };
  }
}

module.exports = { PushPlusOpenApi, redactMessage };
