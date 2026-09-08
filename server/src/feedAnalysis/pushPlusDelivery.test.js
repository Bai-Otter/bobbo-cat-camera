const test = require("node:test");
const assert = require("node:assert/strict");

const { FeedAnalysisCoordinator } = require("./coordinator");

function makeStore() {
  const state = {
    settings: {
      openid: "openid-1",
      deviceSn: "SN001",
      analysisEnabled: true,
      notifyEnabled: true,
      officialConfigStatus: "ready",
      officialAlarmStatus: "ready",
      lastOfficialAlarmAt: 0,
      bowlRoi: null,
    },
    pendingNotifications: [],
  };
  return {
    getSettings() {
      return { ...state.settings };
    },
    updateSettings(patch) {
      state.settings = { ...state.settings, ...patch };
      return this.getSettings();
    },
    hasProcessed() {
      return false;
    },
    getPushPlusBinding(openid) {
      return openid === "openid-1"
        ? { openid, friendToken: "friend-token-1", isFollow: true }
        : null;
    },
    enqueueFeedingNotification(payload) {
      const existing = state.pendingNotifications.find((item) => item.eventId === payload.eventId);
      if (existing) return existing;
      state.pendingNotifications.push(payload);
      return payload;
    },
    get state() {
      return state;
    },
  };
}

function makeAlarmDevice() {
  return {
    async queryAlarmMessages() {
      return [{
        AlarmID: "alarm-push-1",
        AlarmType: "HumanDetect",
        AlarmTime: "2026-07-04 12:00:08",
        Message: "live object",
        PicUrl: "https://example.test/alarm.jpg",
      }];
    },
    async getAlarmPicUrl(alarm) {
      return alarm.snapshotUrl;
    },
  };
}

function makeFeedingAnalyzer() {
  return {
    async analyzeSnapshot() {
      return {
        hasCat: true,
        hasFeeding: true,
        analysisConfidence: 0.94,
        markers: [{
          markerType: "feeding_start",
          beginTime: "2026-07-04 12:00:08",
          endTime: "2026-07-04 12:00:08",
        }],
      };
    },
  };
}

test("FeedAnalysisCoordinator does not dispatch notifications from historical alarm reconciliation", async () => {
  const deliveries = [];
  const deliveredIds = new Set();
  const store = makeStore();
  store.updateSettings({ officialAlarmError: "stale alarm error" });
  const device = makeAlarmDevice();
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: makeFeedingAnalyzer(),
    deviceNotificationDispatcher: {
      async dispatchFeedingEvent(notification) {
        if (deliveredIds.has(notification.sourceEventId)) return { ok: true, skipped: true };
        deliveredIds.add(notification.sourceEventId);
        deliveries.push(notification);
        return { ok: true };
      },
    },
    nowProvider: () => new Date("2026-07-04 12:10:00"),
  });

  await coordinator.syncNow({ force: true });
  await coordinator.syncNow({ force: true });

  assert.equal(deliveries.length, 0);
  assert.equal(store.state.settings.officialAlarmError, "");
});

test("FeedAnalysisCoordinator does not queue historical feeding notifications without a WeChat dispatcher", async () => {
  let deliveryAttempts = 0;
  const store = makeStore();
  store.getPushPlusBinding = () => null;
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => makeAlarmDevice(),
    analyzer: makeFeedingAnalyzer(),
    notifier: {
      isConfigured: () => true,
      async sendFeedingNotification() {
        deliveryAttempts += 1;
        return { ok: true };
      },
    },
    nowProvider: () => new Date("2026-07-04 12:10:00"),
  });

  await coordinator.syncNow({ force: true });

  assert.equal(deliveryAttempts, 0);
  assert.equal(store.state.pendingNotifications.length, 0);
});

test("FeedAnalysisCoordinator does not use the legacy notifier even for its former owner fallback", async () => {
  const deliveries = [];
  const store = makeStore();
  store.getPushPlusBinding = () => null;
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => makeAlarmDevice(),
    analyzer: makeFeedingAnalyzer(),
    notificationOwnerOpenid: "openid-1",
    notifier: {
      isConfigured: () => true,
      async sendFeedingNotification(notification) {
        deliveries.push(notification);
        return { ok: true, messageId: "owner-message-1" };
      },
    },
    nowProvider: () => new Date("2026-07-04 12:10:00"),
  });

  await coordinator.syncNow({ force: true });

  assert.equal(coordinator.canDeliverNotificationTo("openid-1"), true);
  assert.equal(coordinator.canDeliverNotificationTo("openid-2"), false);
  assert.equal(deliveries.length, 0);
});

test("FeedAnalysisCoordinator keeps successful historical analysis without attempting WeChat delivery", async () => {
  let deliveryAttempts = 0;
  const store = makeStore();
  const device = makeAlarmDevice();
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: makeFeedingAnalyzer(),
    deviceNotificationDispatcher: {
      async dispatchFeedingEvent() {
        deliveryAttempts += 1;
        throw new Error("provider unavailable");
      },
    },
    nowProvider: () => new Date("2026-07-04 12:10:00"),
  });

  const result = await coordinator.syncNow({ force: true });

  assert.equal(result.ok, true);
  assert.equal(result.snapshots, 1);
  assert.equal(deliveryAttempts, 0);
  assert.equal(store.state.pendingNotifications.length, 0);
});

test("FeedAnalysisCoordinator does not call the legacy notifier when notifications are disabled", async () => {
  let deliveryAttempts = 0;
  const store = makeStore();
  store.updateSettings({ notifyEnabled: false });
  const device = makeAlarmDevice();
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: makeFeedingAnalyzer(),
    notifier: {
      isConfigured: () => true,
      async sendFeedingNotification() {
        deliveryAttempts += 1;
        return { ok: true };
      },
    },
    nowProvider: () => new Date("2026-07-04 12:10:00"),
  });

  await coordinator.syncNow({ force: true });

  assert.equal(deliveryAttempts, 0);
});

test("FeedAnalysisCoordinator processes cloud alarm pictures while the camera is offline", async () => {
  const store = makeStore();
  store.updateSettings({ notifyEnabled: false });
  const device = makeAlarmDevice();
  device.login = async () => {
    throw new Error("Device offline");
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: makeFeedingAnalyzer(),
    nowProvider: () => new Date("2026-07-04 12:10:00"),
  });

  const result = await coordinator.processScanTask({
    date: "2026-07-04",
    device,
    deviceSn: "SN001",
    force: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshots, 1);
  assert.equal(store.state.pendingNotifications.length, 0);
});
