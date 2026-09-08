function cleanText(value, maxLength = 256) {
  return String(value || "").trim().slice(0, maxLength);
}

function eventTimestamp(value) {
  if (Number(value) > 0) return Number(value);
  const parsed = new Date(String(value || "").replace(/-/g, "/"));
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

class WechatHybridNotificationCoordinator {
  constructor(options = {}) {
    this.store = options.store;
    this.deviceRegistry = options.deviceRegistry;
    this.deviceMessageService = options.deviceMessageService;
    this.deviceCoordinator = options.deviceCoordinator;
    this.fallbackCoordinator = options.fallbackCoordinator;
  }

  async initialize() {
    await this.deviceCoordinator?.initialize?.();
    await this.fallbackCoordinator?.initialize?.();
  }

  getTicket(...args) {
    return this.deviceCoordinator.getTicket(...args);
  }

  getSubscription(...args) {
    return this.deviceCoordinator.getSubscription(...args);
  }

  saveSubscription(...args) {
    return this.deviceCoordinator.saveSubscription(...args);
  }

  async sendTest(openid, deviceSn, eventType) {
    if (this.deviceMessageService?.isConfigured?.()) {
      const subscription = await this.deviceCoordinator.getSubscription(openid, deviceSn);
      if (subscription?.enabled) return this.deviceCoordinator.sendTest(openid, deviceSn, eventType);
    }
    return this.fallbackCoordinator.sendTest(openid, deviceSn, eventType);
  }

  getProviderStatus() {
    return {
      longTerm: this.deviceCoordinator?.getProviderStatus?.() || { configured: false },
      fallback: {
        configured: !!this.fallbackCoordinator?.miniService?.isConfigured?.(),
      },
      wxPusher: this.fallbackCoordinator?.wxPusherService?.getProviderStatus?.() || {
        provider: "wxpusher",
        configured: false,
      },
      pushPlus: this.fallbackCoordinator?.pushPlusNotifier?.getStatus?.() || {
        provider: "pushplus",
        configured: false,
      },
    };
  }

  getSettings(...args) {
    return this.fallbackCoordinator.getSettings(...args);
  }

  savePreference(...args) {
    return this.fallbackCoordinator.savePreference(...args);
  }

  recordSubscriptionResult(...args) {
    return this.fallbackCoordinator.recordSubscriptionResult(...args);
  }

  async getLongTermRecipients(deviceSnValue, eventTypeValue) {
    if (!this.deviceMessageService?.isConfigured?.()) return [];
    const deviceSn = cleanText(deviceSnValue, 128);
    const eventType = eventTypeValue === "feeding_end" ? "feeding_end" : "feeding_start";
    const templateId = this.deviceMessageService.getTemplateId(eventType);
    if (!deviceSn || !templateId) return [];
    const recipients = this.store.listEnabledWechatDeviceSubscriptions(deviceSn, templateId);
    const accessible = [];
    for (const subscription of recipients) {
      if (await this.deviceRegistry.getAccessible(deviceSn, subscription.openid)) {
        accessible.push(subscription.openid);
      }
    }
    return accessible;
  }

  async dispatchFeedingEvent(input = {}) {
    let deviceResult = { ok: false, skipped: true, reason: "WECHAT_DEVICE_NOT_CONFIGURED", delivered: 0 };
    let excludeOpenids = [];
    if (this.deviceMessageService?.isConfigured?.()) {
      excludeOpenids = await this.getLongTermRecipients(input.deviceSn, input.eventType);
      deviceResult = await this.deviceCoordinator.dispatchFeedingEvent(input);
      if (deviceResult && deviceResult.reason === "HISTORICAL_EVENT") {
        return { ...deviceResult, device: deviceResult, fallback: null };
      }
    }

    const fallbackResult = await this.fallbackCoordinator.dispatchFeedingEvent({
      ...input,
      sessionId: cleanText(input.sessionId || deviceResult.sessionId, 128),
      excludeOpenids,
    });
    return {
      ok: !!(deviceResult.ok || fallbackResult.ok),
      sessionId: deviceResult.sessionId || fallbackResult.sessionId || "",
      delivered: (Number(deviceResult.delivered) || 0) + (Number(fallbackResult.delivered) || 0),
      skipped: (Number(deviceResult.skipped) || 0) + (Number(fallbackResult.skipped) || 0),
      device: deviceResult,
      fallback: fallbackResult,
    };
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
      const result = await this.dispatchFeedingEvent({
        deviceSn,
        eventType: item.marker.markerType,
        occurredAt: item.occurredAt,
        sourceEventId: cleanText(
          item.marker.eventId || `${clip.id || clip.recordingKey || "clip"}:${item.index}:${item.occurredAt}`,
          200
        ),
        sessionId: item.marker.markerType === "feeding_end" ? sessionId : "",
      });
      results.push(result);
      if (item.marker.markerType === "feeding_start") sessionId = result.sessionId || sessionId;
      if (item.marker.markerType === "feeding_end") sessionId = "";
    }
    return results;
  }
}

module.exports = { WechatHybridNotificationCoordinator, eventTimestamp };
