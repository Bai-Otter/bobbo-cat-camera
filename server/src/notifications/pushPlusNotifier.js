function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanErrorMessage(error, token) {
  const raw = String((error && error.message) || error || "PUSHPLUS_REQUEST_FAILED");
  return (token ? raw.replaceAll(token, "[redacted]") : raw).slice(0, 240);
}

class PushPlusNotifier {
  constructor({
    token = "",
    endpoint = "https://www.pushplus.plus/send",
    channel = "wechat",
    timeoutMs = 5000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.token = String(token || "").trim();
    this.endpoint = String(endpoint || "https://www.pushplus.plus/send").trim();
    this.channel = String(channel || "wechat").trim() || "wechat";
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 5000);
    this.fetchImpl = fetchImpl;
    this.status = {
      provider: "pushplus",
      configured: !!this.token,
      status: this.token ? "idle" : "not_configured",
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      lastError: "",
      lastMessageId: "",
    };
  }

  isConfigured() {
    return !!this.token;
  }

  getStatus() {
    return { ...this.status };
  }

  buildContent(notification = {}) {
    const rows = [
      notification.message || "\u68c0\u6d4b\u5230\u732b\u54aa\u5f00\u59cb\u8fdb\u98df",
      notification.deviceSn ? `\u8bbe\u5907\uff1a${notification.deviceSn}` : "",
      notification.startTime ? `\u65f6\u95f4\uff1a${notification.startTime}` : "",
    ].filter(Boolean);
    return rows.map((row) => `<p>${escapeHtml(row)}</p>`).join("");
  }

  async sendFeedingNotification(notification = {}) {
    if (!this.isConfigured()) {
      return {
        ok: false,
        skipped: true,
        reason: "PUSHPLUS_NOT_CONFIGURED",
      };
    }
    if (typeof this.fetchImpl !== "function") {
      throw new Error("PUSHPLUS_FETCH_UNAVAILABLE");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.status = {
      ...this.status,
      status: "sending",
      lastAttemptAt: Date.now(),
      lastError: "",
    };

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: this.token,
          title: notification.title || "\u732b\u54aa\u6765\u5403\u996d\u4e86",
          content: this.buildContent(notification),
          template: "html",
          channel: this.channel,
          ...(notification.friendToken ? { to: String(notification.friendToken) } : {}),
          ...(notification.callbackUrl ? { callbackUrl: String(notification.callbackUrl) } : {}),
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`PUSHPLUS_HTTP_${response.status}`);
      }
      if (Number(body.code) !== 200) {
        throw new Error(`PUSHPLUS_REJECTED: ${String(body.msg || body.code || "unknown error")}`);
      }
      const messageId = String(
        body.data && typeof body.data === "object"
          ? body.data.shortCode || body.data.messageId || ""
          : body.data || ""
      ).trim();
      if (!messageId) throw new Error("PUSHPLUS_MESSAGE_ID_MISSING");
      const result = {
        ok: true,
        status: "pending",
        messageId,
        providerStatus: String(body.msg || "accepted").slice(0, 160),
      };
      this.status = {
        ...this.status,
        status: "accepted",
        lastSuccessAt: Date.now(),
        lastError: "",
        lastMessageId: result.messageId,
      };
      return result;
    } catch (error) {
      const normalized = error && error.name === "AbortError"
        ? new Error("PUSHPLUS_TIMEOUT")
        : error;
      const safeError = new Error(cleanErrorMessage(normalized, this.token));
      this.status = {
        ...this.status,
        status: "error",
        lastError: safeError.message,
      };
      throw safeError;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  PushPlusNotifier,
  escapeHtml,
};
