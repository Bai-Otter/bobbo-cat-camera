const test = require("node:test");
const assert = require("node:assert/strict");

const { AppDataStore } = require("../appDataStore");
const { WechatHybridNotificationCoordinator } = require("./wechatHybridNotificationCoordinator");

function fixture({ configured = true } = {}) {
  const store = new AppDataStore(":memory:");
  store.saveWechatDeviceSubscription("owner", {
    deviceSn: "SN001",
    templateId: "tmpl-start",
    eventType: "feeding_start",
    status: "accept",
    enabled: true,
  });
  const deviceCalls = [];
  const fallbackCalls = [];
  const deviceCoordinator = {
    async initialize() {},
    async dispatchFeedingEvent(input) {
      deviceCalls.push(input);
      return { ok: true, sessionId: "session-1", delivered: configured ? 1 : 0 };
    },
  };
  const fallbackCoordinator = {
    async initialize() {},
    async dispatchFeedingEvent(input) {
      fallbackCalls.push(input);
      return { ok: true, sessionId: input.sessionId || "fallback-session", delivered: 1, skipped: 0 };
    },
  };
  const coordinator = new WechatHybridNotificationCoordinator({
    store,
    deviceRegistry: {
      async getAccessible(sn, openid) {
        return sn === "SN001" && openid === "owner" ? { sn } : null;
      },
    },
    deviceMessageService: {
      isConfigured: () => configured,
      getTemplateId: () => "tmpl-start",
    },
    deviceCoordinator,
    fallbackCoordinator,
  });
  return { coordinator, deviceCalls, fallbackCalls };
}

test("long-term recipients are excluded from the one-time fallback", async () => {
  const f = fixture();
  const result = await f.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 2_000,
    sourceEventId: "event-1",
  });

  assert.equal(f.deviceCalls.length, 1);
  assert.deepEqual(f.fallbackCalls[0].excludeOpenids, ["owner"]);
  assert.equal(f.fallbackCalls[0].sessionId, "session-1");
  assert.equal(result.delivered, 2);
});

test("one-time fallback remains active while hardware messages are unconfigured", async () => {
  const f = fixture({ configured: false });
  await f.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 3_000,
    sourceEventId: "event-2",
  });

  assert.equal(f.deviceCalls.length, 0);
  assert.deepEqual(f.fallbackCalls[0].excludeOpenids, []);
});

test("hybrid clip dispatch automatically sends only feeding start", async () => {
  const f = fixture({ configured: false });
  await f.coordinator.dispatchFeedingClip({
    deviceSn: "SN001",
    clip: {
      id: "clip-1",
      markers: [
        { markerType: "feeding_start", markerTsMs: 10_000 },
        { markerType: "feeding_end", markerTsMs: 70_000 },
      ],
    },
  });

  assert.equal(f.fallbackCalls.length, 1);
  assert.equal(f.fallbackCalls[0].eventType, "feeding_start");
});
