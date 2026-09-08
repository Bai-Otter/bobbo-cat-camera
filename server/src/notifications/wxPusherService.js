function cleanText(value, maxLength = 256) {
  return String(value || "").trim().slice(0, maxLength);
}

function providerError(code, providerCode = 0) {
  const error = new Error(code);
  error.code = code;
  error.providerCode = Number(providerCode) || 0;
  return error;
}

function redactToken(message, appToken) {
  const raw = cleanText(message || "WXPUSHER_REQUEST_FAILED", 240);
  return appToken ? raw.replaceAll(appToken, "[redacted]") : raw;
}

class WxPusherService {
  constructor({
    appToken = "",
    appId = "",
    endpoint = "https://wxpusher.zjiecode.com/api/send/message",
    qrEndpoint = "https://wxpusher.zjiecode.com/api/fun/create/qrcode",
    statusEndpoint = "https://wxpusher.zjiecode.com/api/send/query/status",
    timeoutMs = 5000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.appToken = cleanText(appToken, 256);
    this.appId = cleanText(appId, 64);
    this.endpoint = cleanText(endpoint, 512);
    this.qrEndpoint = cleanText(qrEndpoint, 512);
    this.statusEndpoint = cleanText(statusEndpoint, 512);
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 5000);
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return !!(this.appToken && this.appId && typeof this.fetchImpl === "function");
  }

  getProviderStatus() {
    return { provider: "wxpusher", configured: this.isConfigured() };
  }

  async postJson(url, body) {
    if (!this.isConfigured()) throw providerError("WXPUSHER_NOT_CONFIGURED");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw providerError(`WXPUSHER_HTTP_${response.status}`);
      if (Number(payload.code) !== 1000 || payload.success === false) {
        throw providerError("WXPUSHER_REJECTED", payload.code);
      }
      return payload;
    } catch (error) {
      if (error && error.name === "AbortError") throw providerError("WXPUSHER_TIMEOUT");
      const safe = providerError(redactToken(error && (error.code || error.message), this.appToken), error && error.providerCode);
      throw safe;
    } finally {
      clearTimeout(timer);
    }
  }

  async createBindingQrcode(extraValue, validTimeSeconds = 1800) {
    const extra = cleanText(extraValue, 64);
    if (!extra) throw providerError("WXPUSHER_BINDING_EXTRA_REQUIRED");
    const validTime = Math.max(60, Math.min(30 * 24 * 60 * 60, Number(validTimeSeconds) || 1800));
    const payload = await this.postJson(this.qrEndpoint, {
      appToken: this.appToken,
      extra,
      validTime,
    });
    const data = payload.data && typeof payload.data === "object" ? payload.data : {};
    const qrCodeUrl = cleanText(data.url || data.qrCodeUrl || data.qrcodeUrl || data.qrCodeImgUrl, 1024);
    const followUrl = cleanText(data.shortUrl || data.followUrl || "", 1024);
    const code = cleanText(data.code || "", 128);
    if (!qrCodeUrl && !followUrl) throw providerError("WXPUSHER_QR_RESPONSE_INVALID");
    return { qrCodeUrl: qrCodeUrl || followUrl, followUrl, code };
  }

  async queryDeliveryStatus(sendRecordIdValue) {
    const sendRecordId = cleanText(sendRecordIdValue, 128);
    if (!/^\d+$/.test(sendRecordId)) throw providerError("WXPUSHER_SEND_RECORD_ID_INVALID");
    if (!this.isConfigured()) throw providerError("WXPUSHER_NOT_CONFIGURED");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const target = new URL(this.statusEndpoint);
      target.searchParams.set("sendRecordId", sendRecordId);
      const response = await this.fetchImpl(target.toString(), { method: "GET", signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw providerError(`WXPUSHER_STATUS_HTTP_${response.status}`);
      if (Number(payload.code) !== 1000 || payload.success === false) {
        throw providerError("WXPUSHER_STATUS_REJECTED", payload.code);
      }
      const data = payload.data;
      const providerStatus = cleanText(
        data && typeof data === "object"
          ? data.status ?? data.sendStatus ?? data.message ?? JSON.stringify(data)
          : data,
        160
      );
      const numericStatus = Number(
        data && typeof data === "object"
          ? data.sendStatus ?? data.status
          : data
      );
      const lowerStatus = providerStatus.toLowerCase();
      const failed = numericStatus === 3 || /(失败|错误|不存在|取消|fail|error|reject)/i.test(lowerStatus);
      const delivered = numericStatus === 1 || numericStatus === 2 || /(发送成功|推送成功|已送达|delivered|success)/i.test(lowerStatus);
      return {
        ok: true,
        sendRecordId,
        status: failed ? "failed" : delivered ? "delivered" : "pending",
        providerStatus: providerStatus || "pending",
        providerCode: Number(payload.code) || 0,
      };
    } catch (error) {
      if (error && error.name === "AbortError") throw providerError("WXPUSHER_STATUS_TIMEOUT");
      throw providerError(
        redactToken(error && (error.code || error.message), this.appToken),
        error && error.providerCode
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async send({ uid: uidValue, summary: summaryValue, content: contentValue, url = "" } = {}) {
    const uid = cleanText(uidValue, 128);
    const summary = cleanText(summaryValue, 100);
    const content = cleanText(contentValue, 4000);
    if (!uid.startsWith("UID_") || !content) throw providerError("WXPUSHER_MESSAGE_INVALID");
    const payload = await this.postJson(this.endpoint, {
      appToken: this.appToken,
      content,
      summary,
      contentType: 1,
      uids: [uid],
      verifyPayType: 0,
      ...(url ? { url: cleanText(url, 1024) } : {}),
    });
    const records = Array.isArray(payload.data) ? payload.data : [];
    const record = records.find((item) => cleanText(item && item.uid, 128) === uid);
    if (!record) throw providerError("WXPUSHER_TARGET_RESULT_MISSING");
    if (Number(record.code) !== 1000) {
      throw providerError("WXPUSHER_DELIVERY_REJECTED", record.code);
    }
    const sendRecordId = cleanText(record.sendRecordId, 128);
    if (!sendRecordId) throw providerError("WXPUSHER_SEND_RECORD_ID_MISSING");
    return {
      ok: true,
      status: "pending",
      sendRecordId,
      messageContentId: cleanText(record.messageContentId, 128),
      providerStatus: cleanText(record.status, 160) || "accepted",
    };
  }
}

module.exports = { WxPusherService, providerError };
