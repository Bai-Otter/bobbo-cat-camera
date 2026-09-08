function cleanText(value, maxLength = 256) {
  return String(value || "").trim().slice(0, maxLength);
}

function hashText(value) {
  return require("node:crypto").createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

function eventTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatChinaDateTime(value) {
  const timestamp = eventTimestamp(value) || Date.now();
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp)).replace(/\//g, "-");
}

class WechatNotificationCoordinator {
  constructor({ store, deviceRegistry, miniService, officialService, wxPusherService, pushPlusNotifier, ensureAnalysisEnabled, now = Date.now, logger = console } = {}) {
    this.store = store;
    this.deviceRegistry = deviceRegistry;
    this.miniService = miniService;
    this.officialService = officialService || null;
    this.wxPusherService = wxPusherService || null;
    this.pushPlusNotifier = pushPlusNotifier || null;
    this.ensureAnalysisEnabled = typeof ensureAnalysisEnabled === "function"
      ? ensureAnalysisEnabled
      : async () => {};
    this.now = now;
    this.logger = logger;
  }

  async initialize() {}

  getWxPusherClawBotWarning(openid) {
    if (typeof this.store?.getWxPusherClawBotStatus !== "function") return "";
    const status = this.store.getWxPusherClawBotStatus(openid, this.now());
    if (!status || status.status !== "active") return "";
    if (Number(status.estimatedRemaining) <= 1) {
      return "微信直达额度即将用完：请在 ClawBot 对话发送任意消息续期，再回小程序确认。";
    }
    if (Number(status.estimatedRemaining) === 2) {
      return "微信直达接近本轮上限，可提前在 ClawBot 对话发送任意消息续期。";
    }
    return "";
  }

  async requireAccess(openidValue, deviceSnValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    const profile = openid && deviceSn && this.deviceRegistry &&
      await this.deviceRegistry.getAccessible(deviceSn, openid);
    if (!profile) {
      const error = new Error("DEVICE_NOT_FOUND");
      error.code = "DEVICE_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    }
    return profile;
  }

  getTemplates() {
    return this.miniService && typeof this.miniService.getTemplates === "function"
      ? this.miniService.getTemplates()
      : [];
  }

  async getSettings(openid, deviceSn) {
    await this.requireAccess(openid, deviceSn);
    const preference = this.store.getNotificationPreference(openid, deviceSn);
    const grants = this.store.getMiniSubscriptionGrants(openid, deviceSn);
    const templates = this.getTemplates().map((template) => {
      const grant = grants.find((item) => item.eventType === template.eventType);
      return {
        ...template,
        remainingCount: Number(grant && grant.remainingCount) || 0,
        status: grant && grant.status || "unknown",
      };
    });
    const officialBinding = this.store.getOfficialBindingForOpenid(openid);
    const wxPusherBinding = this.store.getWxPusherBinding(openid);
    const pushPlusBinding = this.store.getPushPlusBinding?.(openid);
    const officialConfigured = !!(this.officialService && this.officialService.isConfigured());
    const wxPusherConfigured = !!this.wxPusherService?.isConfigured?.();
    const pushPlusConfigured = !!this.pushPlusNotifier?.isConfigured?.();
    const officialBound = !!(officialBinding && officialBinding.status === "active");
    const wxPusherBound = !!(wxPusherBinding && wxPusherBinding.status === "active");
    const pushPlusBound = !!(
      pushPlusBinding && pushPlusBinding.status !== "disabled" &&
      pushPlusBinding.friendToken && pushPlusBinding.isFollow
    );
    return {
      configured: !!(this.miniService && this.miniService.isConfigured()) || officialConfigured || wxPusherConfigured || pushPlusConfigured,
      enabled: preference.enabled,
      templates,
      totalRemaining: templates.reduce((sum, item) => sum + item.remainingCount, 0),
      needsRenewal: templates.some((item) => item.remainingCount < 1),
      provider: pushPlusConfigured && pushPlusBound
        ? "pushplus"
        : officialConfigured && officialBound
          ? "official_account"
          : wxPusherConfigured && wxPusherBound
          ? "wxpusher"
          : "mini_subscription",
      pushPlus: {
        configured: pushPlusConfigured,
        bound: pushPlusBound,
        isFollow: !!(pushPlusBinding && pushPlusBinding.isFollow),
        status: pushPlusBinding && pushPlusBinding.status || "not_bound",
      },
      officialAccount: {
        configured: officialConfigured,
        bound: officialBound,
      },
      wxPusher: {
        configured: wxPusherConfigured,
        bound: wxPusherBound,
        status: wxPusherBinding && wxPusherBinding.status || "not_bound",
      },
    };
  }

  async savePreference(openid, deviceSn, enabled) {
    await this.requireAccess(openid, deviceSn);
    this.store.saveNotificationPreference(openid, deviceSn, enabled);
    if (enabled) await this.ensureAnalysisEnabled(deviceSn);
    return this.getSettings(openid, deviceSn);
  }

  async recordSubscriptionResult(openid, deviceSn, results = {}) {
    await this.requireAccess(openid, deviceSn);
    if (!this.miniService || !this.miniService.isConfigured()) {
      const error = new Error("WECHAT_MINI_NOT_CONFIGURED");
      error.code = "WECHAT_MINI_NOT_CONFIGURED";
      error.statusCode = 503;
      throw error;
    }
    let accepted = 0;
    for (const template of this.getTemplates()) {
      const status = cleanText(results && results[template.templateId], 32) || "unknown";
      this.store.addMiniSubscriptionGrant(openid, {
        deviceSn,
        eventType: template.eventType,
        templateId: template.templateId,
        status,
      });
      if (status === "accept") accepted += 1;
    }
    if (accepted > 0) this.store.saveNotificationPreference(openid, deviceSn, true);
    if (accepted > 0) await this.ensureAnalysisEnabled(deviceSn);
    return this.getSettings(openid, deviceSn);
  }

  async dispatchFeedingEvent(input = {}) {
    const deviceSn = cleanText(input.deviceSn, 128);
    const eventType = input.eventType === "feeding_end" ? "feeding_end" : "feeding_start";
    const occurredAt = eventTimestamp(input.occurredAt) || this.now();
    const sourceEventId = cleanText(input.sourceEventId, 200);
    if (!deviceSn || !sourceEventId) return { ok: false, skipped: true, reason: "EVENT_INVALID" };
    if ((!this.miniService || !this.miniService.isConfigured()) &&
      (!this.officialService || !this.officialService.isConfigured()) &&
      (!this.wxPusherService || !this.wxPusherService.isConfigured()) &&
      (!this.pushPlusNotifier || !this.pushPlusNotifier.isConfigured())) {
      return { ok: false, skipped: true, reason: "WECHAT_NOTIFICATIONS_NOT_CONFIGURED" };
    }
    const session = this.store.resolveWechatFeedingSession({
      deviceSn,
      eventType,
      occurredAt,
      sourceKey: `notification:${sourceEventId}:${eventType}`,
      sessionId: cleanText(input.sessionId, 128),
      dedupeWindowMs: 30 * 60_000,
    });
    const device = await this.deviceRegistry.getBySn(deviceSn);
    const deviceName = cleanText(device && device.nickname, 40) || "食盆摄像头";
    const recipients = this.store.listNotificationRecipients(deviceSn);
    const excludedOpenids = new Set(
      Array.isArray(input.excludeOpenids) ? input.excludeOpenids.map((item) => cleanText(item, 128)) : []
    );
    let delivered = 0;
    let skipped = 0;
    for (const recipient of recipients) {
      if (excludedOpenids.has(recipient.openid)) {
        skipped += 1;
        continue;
      }
      const accessible = await this.deviceRegistry.getAccessible(deviceSn, recipient.openid);
      if (!accessible) {
        skipped += 1;
        continue;
      }
      const wxPusherBinding = this.store.getWxPusherBinding(recipient.openid);
      const useWxPusher = !!(
        this.wxPusherService?.isConfigured?.() && wxPusherBinding && wxPusherBinding.status === "active"
      );
      const pushPlusBinding = !useWxPusher ? this.store.getPushPlusBinding?.(recipient.openid) : null;
      const usePushPlus = !!(
        !useWxPusher && this.pushPlusNotifier?.isConfigured?.() &&
        pushPlusBinding && pushPlusBinding.status !== "disabled" &&
        pushPlusBinding.friendToken && pushPlusBinding.isFollow
      );
      const binding = !useWxPusher && !usePushPlus ? this.store.getOfficialBindingForOpenid(recipient.openid) : null;
      const useOfficial = !!(
        !useWxPusher && !usePushPlus && this.officialService && this.officialService.isConfigured() &&
        binding && binding.status === "active"
      );
      const grant = !usePushPlus && !useOfficial && !useWxPusher
        ? this.store.getMiniSubscriptionGrants(recipient.openid, deviceSn)
          .find((item) => item.eventType === eventType && item.remainingCount > 0)
        : null;
      if (!usePushPlus && !useOfficial && !useWxPusher && !grant) {
        skipped += 1;
        continue;
      }
      const provider = useWxPusher ? "wxpusher" : usePushPlus ? "pushplus" : useOfficial ? "official_account" : "mini_subscription";
      const templateId = useWxPusher
        ? `wxpusher:${eventType}`
        : usePushPlus ? `pushplus:${eventType}`
        : useOfficial
        ? this.officialService.getTemplateId(eventType)
        : grant.templateId;
      const target = useWxPusher
        ? wxPusherBinding.uid
        : usePushPlus ? pushPlusBinding.friendToken
        : useOfficial ? binding.officialOpenid : recipient.openid;
      const deliveryKey = [provider, session.sessionId, eventType, hashText(target), templateId].join(":");
      const claimedDelivery = this.store.claimWechatNotificationDelivery({
        deliveryKey,
        openid: recipient.openid,
        recipient: target,
        deviceSn,
        templateId,
        eventType,
        eventTime: occurredAt,
        provider,
      });
      if (!claimedDelivery) {
        skipped += 1;
        continue;
      }
      if (!usePushPlus && !useOfficial && !useWxPusher && !this.store.claimMiniSubscriptionGrant(recipient.openid, deviceSn, eventType)) {
        this.store.markWechatNotificationDeliveryFailed(deliveryKey, { code: "MINI_SUBSCRIPTION_QUOTA_EMPTY" });
        skipped += 1;
        continue;
      }
      try {
        const context = {
            eventTime: formatChinaDateTime(occurredAt),
            deviceName,
            eventName: eventType === "feeding_end" ? "结束进食" : "开始进食",
        };
        let providerResult = null;
        if (useWxPusher) {
          const clawBotWarning = this.getWxPusherClawBotWarning(recipient.openid);
          providerResult = await this.wxPusherService.send({
            uid: wxPusherBinding.uid,
            summary: eventType === "feeding_end" ? "猫咪结束进食" : "猫咪开始进食",
            content: [
              `布卜布卜提醒：${context.eventName}`,
              `设备：${context.deviceName}`,
              `时间：${context.eventTime}`,
              ...(clawBotWarning ? ["", clawBotWarning] : []),
            ].join("\n"),
          });
        } else if (usePushPlus) {
          providerResult = await this.pushPlusNotifier.sendFeedingNotification({
            eventId: sourceEventId,
            friendToken: pushPlusBinding.friendToken,
            title: eventType === "feeding_end" ? "猫咪结束进食" : "猫咪开始进食",
            message: `布卜布卜提醒：${context.eventName}`,
            deviceSn: context.deviceName,
            startTime: context.eventTime,
          });
        } else if (useOfficial) {
          await this.officialService.send({
            officialOpenid: binding.officialOpenid,
            eventType,
            miniprogram: {
              appid: this.officialService.miniProgramAppId || "",
              pagepath: `pages/today/index?device=${encodeURIComponent(deviceSn)}`,
            },
            data: this.officialService.buildData(eventType, context),
          });
        } else {
          await this.miniService.send({
            openid: recipient.openid,
            eventType,
            page: `pages/today/index?device=${encodeURIComponent(deviceSn)}`,
            data: this.miniService.buildData(eventType, context),
          });
        }
        if (usePushPlus || useWxPusher) {
          this.store.markWechatNotificationDeliveryPending(deliveryKey, {
            providerMessageId: useWxPusher ? providerResult.sendRecordId : providerResult.messageId,
            providerStatus: providerResult.providerStatus || "accepted",
          });
        } else {
          this.store.markWechatNotificationDeliveryDelivered(deliveryKey, { providerStatus: "delivered" });
        }
        delivered += 1;
      } catch (error) {
        this.store.markWechatNotificationDeliveryFailed(deliveryKey, error);
        if (!usePushPlus && !useOfficial && !useWxPusher && Number(error && error.providerCode) !== 43101) {
          this.store.restoreMiniSubscriptionGrant(recipient.openid, deviceSn, eventType);
        }
        this.logger.warn?.("[wechat-notification] delivery failed", {
          code: cleanText(error && (error.code || error.message), 80),
          providerCode: Number(error && error.providerCode) || 0,
          eventType,
        });
      }
    }
    return { ok: true, sessionId: session.sessionId, delivered, skipped };
  }

  async sendTest(openidValue, deviceSnValue, eventTypeValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    const eventType = eventTypeValue === "feeding_end" ? "feeding_end" : "feeding_start";
    await this.requireAccess(openid, deviceSn);
    const wxPusherBinding = this.store.getWxPusherBinding(openid);
    const useWxPusher = !!(
      this.wxPusherService?.isConfigured?.() && wxPusherBinding && wxPusherBinding.status === "active"
    );
    const pushPlusBinding = !useWxPusher ? this.store.getPushPlusBinding?.(openid) : null;
    const usePushPlus = !!(
      !useWxPusher && this.pushPlusNotifier?.isConfigured?.() && pushPlusBinding &&
      pushPlusBinding.status !== "disabled" && pushPlusBinding.friendToken && pushPlusBinding.isFollow
    );
    if (!usePushPlus && !useWxPusher) {
      const error = new Error("PERSISTENT_NOTIFICATION_BINDING_REQUIRED");
      error.code = "PERSISTENT_NOTIFICATION_BINDING_REQUIRED";
      error.statusCode = 409;
      throw error;
    }
    const device = await this.deviceRegistry.getBySn(deviceSn);
    const deviceName = cleanText(device && device.nickname, 40) || "食盆摄像头";
    const now = this.now();
    const provider = useWxPusher ? "wxpusher" : "pushplus";
    const target = useWxPusher ? wxPusherBinding.uid : pushPlusBinding.friendToken;
    const windowId = Math.floor(now / 30_000);
    const deliveryKey = [provider, "manual-test", openid, deviceSn, eventType, windowId].join(":");
    const claimed = this.store.claimWechatNotificationDelivery({
      deliveryKey,
      openid,
      recipient: target,
      deviceSn,
      templateId: `${provider}:${eventType}:test`,
      eventType,
      eventTime: now,
      provider,
    });
    if (!claimed) {
      const error = new Error("NOTIFICATION_TEST_RATE_LIMITED");
      error.code = "NOTIFICATION_TEST_RATE_LIMITED";
      error.statusCode = 429;
      throw error;
    }
    try {
      const clawBotWarning = useWxPusher ? this.getWxPusherClawBotWarning(openid) : "";
      const result = useWxPusher
        ? await this.wxPusherService.send({
            uid: wxPusherBinding.uid,
            summary: eventType === "feeding_end" ? "测试：猫咪结束进食" : "测试：猫咪开始进食",
            content: [
              `布卜布卜测试提醒：${eventType === "feeding_end" ? "结束进食" : "开始进食"}`,
              `设备：${deviceName}`,
              `时间：${formatChinaDateTime(now)}`,
              ...(clawBotWarning ? ["", clawBotWarning] : []),
            ].join("\n"),
          })
        : await this.pushPlusNotifier.sendFeedingNotification({
            eventId: deliveryKey,
            friendToken: pushPlusBinding.friendToken,
            title: eventType === "feeding_end" ? "测试：猫咪结束进食" : "测试：猫咪开始进食",
            message: `布卜布卜测试提醒：${eventType === "feeding_end" ? "结束进食" : "开始进食"}`,
            deviceSn: deviceName,
            startTime: formatChinaDateTime(now),
          });
      this.store.markWechatNotificationDeliveryPending(deliveryKey, {
        providerMessageId: useWxPusher ? result.sendRecordId : result.messageId,
        providerStatus: result.providerStatus || "accepted",
      });
      return { ok: true, delivery: this.store.getWechatNotificationDeliveryByKey(deliveryKey) };
    } catch (error) {
      this.store.markWechatNotificationDeliveryFailed(deliveryKey, error);
      throw error;
    }
  }

  async dispatchFeedingClip({ deviceSn, clip } = {}) {
    const markers = (Array.isArray(clip && clip.markers) ? clip.markers : [])
      .filter((marker) => marker && marker.markerType === "feeding_start")
      .map((marker, index) => ({ marker, index, occurredAt: eventTimestamp(marker.markerTsMs || marker.beginTime) }))
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

module.exports = { WechatNotificationCoordinator, eventTimestamp, formatChinaDateTime };
