const crypto = require("crypto");

function cleanText(value, maxLength = 256) {
  return String(value || "").trim().slice(0, maxLength);
}

function traceHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function eventTimestamp(value) {
  if (Number(value) > 0) return Number(value);
  const parsed = new Date(String(value || "").replace(/-/g, "/"));
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function formatChinaDateTime(timestamp) {
  const shifted = new Date(Number(timestamp) + 8 * 60 * 60_000);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-") + " " + [
    String(shifted.getUTCHours()).padStart(2, "0"),
    String(shifted.getUTCMinutes()).padStart(2, "0"),
    String(shifted.getUTCSeconds()).padStart(2, "0"),
  ].join(":");
}

function publicSubscriptionStatus(messageService, subscriptions = []) {
  const byTemplate = new Map(subscriptions.map((item) => [item.templateId, item]));
  const templates = messageService.getTemplateIds().map((templateId) => {
    const stored = byTemplate.get(templateId);
    return {
      templateId,
      eventType: messageService.getEventType(templateId),
      status: stored ? stored.status : "unknown",
      enabled: !!(stored && stored.enabled),
    };
  });
  const enabledCount = templates.filter((item) => item.enabled).length;
  return {
    configured: messageService.isConfigured(),
    enabled: templates.length > 0 && enabledCount === templates.length,
    partiallyEnabled: enabledCount > 0 && enabledCount < templates.length,
    templates,
  };
}

class WechatDeviceNotificationCoordinator {
  constructor(options = {}) {
    this.store = options.store;
    this.deviceRegistry = options.deviceRegistry;
    this.messageService = options.messageService;
    this.now = options.now || Date.now;
    this.logger = options.logger || console;
    this.activationMetaKey = "wechat_device_notifications_activated_at";
    this.activationAt = 0;
    this.ensureAnalysisEnabled = typeof options.ensureAnalysisEnabled === "function"
      ? options.ensureAnalysisEnabled
      : async () => {};
  }

  async initialize() {
    const stored = Number(this.store.getMeta(this.activationMetaKey)) || 0;
    this.activationAt = stored || this.now();
    if (!stored) this.store.setMeta(this.activationMetaKey, this.activationAt);
    return { configured: this.messageService.isConfigured(), activationAt: this.activationAt };
  }

  async requireAccess(openid, deviceSn) {
    const profile = await this.deviceRegistry.getAccessible(deviceSn, openid);
    if (!profile) {
      const error = new Error("DEVICE_NOT_FOUND");
      error.code = "DEVICE_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    }
    return profile;
  }

  getProviderStatus() {
    return {
      provider: "wechat-device-message",
      configured: this.messageService.isConfigured(),
      status: this.messageService.isConfigured() ? "ready" : "awaiting_hardware_approval",
      templateCount: this.messageService.getTemplateIds().length,
    };
  }

  async getTicket(openidValue, deviceSnValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    await this.requireAccess(openid, deviceSn);
    const ticket = await this.messageService.getSnTicket(deviceSn);
    this.logger.info?.("[wechat-device-message] ticket issued", {
      accountHash: traceHash(openid),
      deviceHash: traceHash(deviceSn),
      templateCount: ticket.tmplIds.length,
    });
    return ticket;
  }

  async getSubscription(openidValue, deviceSnValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    await this.requireAccess(openid, deviceSn);
    return publicSubscriptionStatus(
      this.messageService,
      this.store.getWechatDeviceSubscriptions(openid, deviceSn)
    );
  }

  async saveSubscription(openidValue, deviceSnValue, input = {}) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    await this.requireAccess(openid, deviceSn);
    const results = input.results && typeof input.results === "object" ? input.results : {};
    const allowedTemplateIds = new Set(this.messageService.getTemplateIds());
    for (const [templateId, status] of Object.entries(results)) {
      if (!allowedTemplateIds.has(templateId)) continue;
      this.store.saveWechatDeviceSubscription(openid, {
        deviceSn,
        templateId,
        eventType: this.messageService.getEventType(templateId),
        status,
        enabled: input.enabled !== false,
      });
    }
    if (Object.prototype.hasOwnProperty.call(input, "enabled")) {
      this.store.setWechatDeviceSubscriptionsEnabled(openid, deviceSn, input.enabled !== false);
    }
    const status = await this.getSubscription(openid, deviceSn);
    if (status.enabled) await this.ensureAnalysisEnabled(deviceSn);
    this.logger.info?.("[wechat-device-message] subscription saved", {
      accountHash: traceHash(openid),
      deviceHash: traceHash(deviceSn),
      enabled: status.enabled,
      partiallyEnabled: status.partiallyEnabled,
    });
    return status;
  }

  async sendTest(openidValue, deviceSnValue, eventTypeValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    const eventType = eventTypeValue === "feeding_end" ? "feeding_end" : "feeding_start";
    await this.requireAccess(openid, deviceSn);
    if (!this.messageService.isConfigured()) {
      const error = new Error("WECHAT_DEVICE_NOT_CONFIGURED");
      error.code = "WECHAT_DEVICE_NOT_CONFIGURED";
      error.statusCode = 503;
      throw error;
    }
    const templateId = this.messageService.getTemplateId(eventType);
    const subscription = this.store.getWechatDeviceSubscriptions(openid, deviceSn)
      .find((item) => item.templateId === templateId && item.enabled);
    if (!subscription) {
      const error = new Error("WECHAT_DEVICE_SUBSCRIPTION_REQUIRED");
      error.code = "WECHAT_DEVICE_SUBSCRIPTION_REQUIRED";
      error.statusCode = 409;
      throw error;
    }
    const occurredAt = this.now();
    const windowId = Math.floor(occurredAt / 30_000);
    const deliveryKey = ["wechat-device-test", openid, deviceSn, eventType, windowId].join(":");
    const claimed = this.store.claimWechatNotificationDelivery({
      deliveryKey,
      openid,
      deviceSn,
      templateId,
      eventType,
      eventTime: occurredAt,
      provider: "wechat-device-message-test",
    });
    if (!claimed) {
      const error = new Error("WECHAT_DEVICE_TEST_RATE_LIMITED");
      error.code = "WECHAT_DEVICE_TEST_RATE_LIMITED";
      error.statusCode = 429;
      throw error;
    }
    const profile = await this.deviceRegistry.getBySn(deviceSn) || {};
    const eventTime = formatChinaDateTime(occurredAt);
    try {
      await this.messageService.send({
        openid,
        sn: deviceSn,
        templateId,
        page: this.buildPage(deviceSn, occurredAt, "manual-test", eventType),
        data: this.messageService.buildData(eventType, {
          eventStatus: eventType === "feeding_end" ? "结束进食" : "开始进食",
          eventTime,
          deviceName: cleanText(profile.nickname || "食盆摄像头", 80),
          durationMinutes: "",
          sessionId: "manual-test",
        }),
      });
      this.store.markWechatNotificationDeliverySent(deliveryKey);
      this.logger.info?.("[wechat-device-message] test sent", {
        accountHash: traceHash(openid),
        deviceHash: traceHash(deviceSn),
        eventType,
      });
      return {
        ok: true,
        eventType,
        delivery: this.store.getWechatNotificationDeliveryByKey?.(deliveryKey) || null,
      };
    } catch (error) {
      this.store.markWechatNotificationDeliveryFailed(deliveryKey, error);
      throw error;
    }
  }

  buildPage(deviceSn, occurredAt, sessionId, eventType) {
    const date = formatChinaDateTime(occurredAt).slice(0, 10);
    return "pages/today/index?" + [
      ["deviceSn", deviceSn],
      ["date", date],
      ["feedingEvent", sessionId],
      ["eventType", eventType],
    ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  }

  async dispatchFeedingEvent(input = {}) {
    if (!this.messageService.isConfigured()) {
      return { ok: false, skipped: true, reason: "WECHAT_DEVICE_NOT_CONFIGURED" };
    }
    const deviceSn = cleanText(input.deviceSn, 128);
    const eventType = input.eventType === "feeding_end" ? "feeding_end" : "feeding_start";
    const occurredAt = eventTimestamp(input.occurredAt || input.startTime || input.endTime);
    const sourceEventId = cleanText(input.sourceEventId || input.eventId, 200);
    if (!deviceSn || !occurredAt || !sourceEventId) {
      return { ok: false, skipped: true, reason: "WECHAT_FEEDING_EVENT_INVALID" };
    }
    if (occurredAt < this.activationAt) {
      return { ok: true, skipped: true, reason: "HISTORICAL_EVENT" };
    }
    const session = this.store.resolveWechatFeedingSession({
      deviceSn,
      eventType,
      occurredAt,
      sourceKey: `${deviceSn}:${eventType}:${sourceEventId}`,
      sessionId: input.sessionId,
      dedupeWindowMs: 30 * 60_000,
    });
    const templateId = this.messageService.getTemplateId(eventType);
    if (!templateId) return { ok: true, skipped: true, reason: "EVENT_TEMPLATE_NOT_CONFIGURED", sessionId: session.sessionId };
    const profile = await this.deviceRegistry.getBySn(deviceSn) || {};
    const eventTime = formatChinaDateTime(occurredAt);
    const data = this.messageService.buildData(eventType, {
      eventStatus: eventType === "feeding_end" ? "结束进食" : "开始进食",
      eventTime,
      deviceName: cleanText(profile.nickname || "食盆摄像头", 80),
      durationMinutes: input.durationSec ? Math.max(1, Math.round(Number(input.durationSec) / 60)) : "",
      sessionId: session.sessionId,
    });
    const page = this.buildPage(deviceSn, occurredAt, session.sessionId, eventType);
    let delivered = 0;
    const subscribers = this.store.listEnabledWechatDeviceSubscriptions(deviceSn, templateId);
    for (const subscription of subscribers) {
      const access = await this.deviceRegistry.getAccessible(deviceSn, subscription.openid);
      if (!access) continue;
      const deliveryKey = [session.sessionId, eventType, subscription.openid, templateId].join(":");
      const claimed = this.store.claimWechatNotificationDelivery({
        deliveryKey,
        openid: subscription.openid,
        deviceSn,
        templateId,
        eventType,
        eventTime: occurredAt,
      });
      if (!claimed) continue;
      try {
        await this.messageService.send({
          openid: subscription.openid,
          sn: deviceSn,
          templateId,
          page,
          data,
        });
        this.store.markWechatNotificationDeliverySent(deliveryKey);
        this.logger.info?.("[wechat-device-message] sent", {
          accountHash: traceHash(subscription.openid),
          deviceHash: traceHash(deviceSn),
          eventType,
        });
        delivered += 1;
      } catch (error) {
        this.store.markWechatNotificationDeliveryFailed(deliveryKey, error);
        if (Number(error && error.providerCode) === 43101) {
          this.store.saveWechatDeviceSubscription(subscription.openid, {
            deviceSn,
            templateId,
            eventType,
            status: "reject",
            enabled: false,
          });
        }
        this.logger.warn?.("[wechat-device-message] delivery failed", {
          code: cleanText(error && (error.code || error.message), 80),
          providerCode: Number(error && error.providerCode) || 0,
          eventType,
        });
      }
    }
    return { ok: true, sessionId: session.sessionId, delivered };
  }

  async dispatchFeedingClip({ deviceSn, clip } = {}) {
    const markers = (Array.isArray(clip && clip.markers) ? clip.markers : [])
      .filter((marker) => marker && marker.markerType === "feeding_start")
      .map((marker, index) => ({
        marker,
        index,
        occurredAt: eventTimestamp(marker.markerTsMs || marker.beginTime),
      }))
      .filter((item) => item.occurredAt > 0)
      .sort((left, right) => left.occurredAt - right.occurredAt || left.index - right.index);
    let sessionId = "";
    const results = [];
    for (const item of markers) {
      const sourceEventId = cleanText(
        item.marker.eventId || `${clip.id || clip.recordingKey || "clip"}:${item.index}:${item.occurredAt}`,
        200
      );
      const result = await this.dispatchFeedingEvent({
        deviceSn,
        eventType: item.marker.markerType,
        occurredAt: item.occurredAt,
        sourceEventId,
        sessionId: item.marker.markerType === "feeding_end" ? sessionId : "",
      });
      results.push(result);
      if (item.marker.markerType === "feeding_start") sessionId = result.sessionId || sessionId;
      if (item.marker.markerType === "feeding_end") sessionId = "";
    }
    return results;
  }
}

module.exports = {
  WechatDeviceNotificationCoordinator,
  eventTimestamp,
  formatChinaDateTime,
  publicSubscriptionStatus,
  traceHash,
};
