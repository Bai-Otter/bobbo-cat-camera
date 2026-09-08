const test = require("node:test");
const assert = require("node:assert/strict");

const { AppDataStore } = require("../appDataStore");
const { WechatDeviceNotificationCoordinator } = require("./wechatDeviceNotificationCoordinator");

function createFixture() {
  const store = new AppDataStore(":memory:");
  const access = new Map([
    ["openid-owner", true],
    ["openid-member", true],
  ]);
  const sends = [];
  const service = {
    isConfigured: () => true,
    getTemplateIds: () => ["tmpl-start", "tmpl-end"],
    getTemplateId: (eventType) => eventType === "feeding_end" ? "tmpl-end" : "tmpl-start",
    getEventType: (templateId) => templateId === "tmpl-end" ? "feeding_end" : "feeding_start",
    getSnTicket: async (sn) => ({
      sn,
      snTicket: "ticket",
      modelId: "model-1",
      tmplIds: ["tmpl-start", "tmpl-end"],
      expiresAt: 301_000,
    }),
    buildData: (eventType, context) => ({
      status1: { value: eventType === "feeding_end" ? "结束进食" : "开始进食" },
      time2: { value: context.eventTime },
    }),
    send: async (input) => {
      sends.push(input);
      return { ok: true };
    },
  };
  const deviceRegistry = {
    async getAccessible(sn, openid) {
      return sn === "SN001" && access.get(openid)
        ? { sn, nickname: "食盆摄像头", ownerOpenid: "openid-owner" }
        : null;
    },
    async getBySn(sn) {
      return sn === "SN001" ? { sn, nickname: "食盆摄像头" } : null;
    },
  };
  const coordinator = new WechatDeviceNotificationCoordinator({
    store,
    deviceRegistry,
    messageService: service,
    now: () => 1_000,
    logger: { warn() {} },
  });
  return { store, access, sends, coordinator };
}

test("owner and shared member subscribe independently and each event is sent once", async () => {
  const fixture = createFixture();
  await fixture.coordinator.initialize();
  for (const openid of ["openid-owner", "openid-member"]) {
    await fixture.coordinator.saveSubscription(openid, "SN001", {
      enabled: true,
      results: { "tmpl-start": "accept", "tmpl-end": "acceptWithAudio" },
    });
  }

  const started = await fixture.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 2_000,
    sourceEventId: "alarm-1",
  });
  await fixture.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 2_500,
    sourceEventId: "clip-1-start",
  });
  await fixture.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_end",
    occurredAt: 62_000,
    sourceEventId: "clip-1-end",
    sessionId: started.sessionId,
  });

  assert.equal(fixture.sends.length, 4);
  assert.deepEqual(
    fixture.sends.map((item) => `${item.openid}:${item.templateId}`).sort(),
    [
      "openid-member:tmpl-end",
      "openid-member:tmpl-start",
      "openid-owner:tmpl-end",
      "openid-owner:tmpl-start",
    ]
  );
});

test("revoked family access is checked again before delivery", async () => {
  const fixture = createFixture();
  await fixture.coordinator.initialize();
  for (const openid of ["openid-owner", "openid-member"]) {
    await fixture.coordinator.saveSubscription(openid, "SN001", {
      enabled: true,
      results: { "tmpl-start": "accept", "tmpl-end": "accept" },
    });
  }
  fixture.access.set("openid-member", false);

  await fixture.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 120_000,
    sourceEventId: "alarm-2",
  });

  assert.deepEqual(fixture.sends.map((item) => item.openid), ["openid-owner"]);
});

test("subscription ticket rejects users without current device access", async () => {
  const fixture = createFixture();
  await fixture.coordinator.initialize();
  assert.equal((await fixture.coordinator.getTicket("openid-owner", "SN001")).snTicket, "ticket");
  await assert.rejects(
    fixture.coordinator.getTicket("openid-stranger", "SN001"),
    /DEVICE_NOT_FOUND/
  );
});

test("recording markers automatically notify only the feeding start", async () => {
  const fixture = createFixture();
  await fixture.coordinator.initialize();
  await fixture.coordinator.saveSubscription("openid-owner", "SN001", {
    enabled: true,
    results: { "tmpl-start": "accept", "tmpl-end": "accept" },
  });

  await fixture.coordinator.dispatchFeedingClip({
    deviceSn: "SN001",
    clip: {
      id: "clip-1",
      markers: [
        { markerType: "feeding_start", markerTsMs: 200_000 },
        { markerType: "feeding_end", markerTsMs: 260_000 },
      ],
    },
  });

  assert.deepEqual(fixture.sends.map((item) => item.templateId), ["tmpl-start"]);
});

test("an accepted long-term subscription can be disabled and re-enabled without another prompt", async () => {
  const fixture = createFixture();
  await fixture.coordinator.initialize();
  await fixture.coordinator.saveSubscription("openid-owner", "SN001", {
    enabled: true,
    results: { "tmpl-start": "accept", "tmpl-end": "acceptWithAudio" },
  });

  assert.equal((await fixture.coordinator.saveSubscription("openid-owner", "SN001", {
    enabled: false,
  })).enabled, false);
  assert.equal((await fixture.coordinator.saveSubscription("openid-owner", "SN001", {
    enabled: true,
  })).enabled, true);
});

test("manual tests send only to the authenticated subscriber and are rate limited", async () => {
  const fixture = createFixture();
  await fixture.coordinator.initialize();
  await fixture.coordinator.saveSubscription("openid-owner", "SN001", {
    enabled: true,
    results: { "tmpl-start": "accept", "tmpl-end": "accept" },
  });

  const result = await fixture.coordinator.sendTest("openid-owner", "SN001", "feeding_start");
  assert.equal(result.ok, true);
  assert.equal(fixture.sends.length, 1);
  assert.equal(fixture.sends[0].openid, "openid-owner");
  await assert.rejects(
    fixture.coordinator.sendTest("openid-owner", "SN001", "feeding_start"),
    /WECHAT_DEVICE_TEST_RATE_LIMITED/
  );
});
