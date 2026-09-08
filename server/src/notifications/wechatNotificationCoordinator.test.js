const test = require("node:test");
const assert = require("node:assert/strict");

const { AppDataStore } = require("../appDataStore");
const { WechatNotificationCoordinator } = require("./wechatNotificationCoordinator");

function fixture() {
  const store = new AppDataStore(":memory:");
  const access = new Map([["owner", true], ["member", true]]);
  const sends = [];
  const miniService = {
    isConfigured: () => true,
    getTemplates: () => [
      { eventType: "feeding_start", templateId: "tmpl-start" },
      { eventType: "feeding_end", templateId: "tmpl-end" },
    ],
    buildData: (eventType, context) => ({ thing1: { value: `${eventType}:${context.deviceName}` } }),
    send: async (input) => {
      sends.push(input);
      return { ok: true };
    },
  };
  const deviceRegistry = {
    async getAccessible(sn, openid) {
      return sn === "SN001" && access.get(openid)
        ? { sn, ownerOpenid: "owner", nickname: "饭饭" }
        : null;
    },
    async getBySn(sn) {
      return sn === "SN001" ? { sn, nickname: "饭饭" } : null;
    },
  };
  const coordinator = new WechatNotificationCoordinator({
    store,
    deviceRegistry,
    miniService,
    now: () => 1000,
    logger: { warn() {} },
  });
  return { store, access, sends, coordinator };
}

async function grantPair(coordinator, openid) {
  await coordinator.recordSubscriptionResult(openid, "SN001", {
    "tmpl-start": "accept",
    "tmpl-end": "accept",
  });
}

test("mini-program grants are consumed once for a correlated feeding start and end", async () => {
  const f = fixture();
  await grantPair(f.coordinator, "owner");
  const started = await f.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 2000,
    sourceEventId: "alarm-1",
  });
  await f.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 2500,
    sourceEventId: "clip-start",
  });
  await f.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_end",
    occurredAt: 62000,
    sourceEventId: "clip-end",
    sessionId: started.sessionId,
  });
  assert.deepEqual(f.sends.map((item) => item.eventType), ["feeding_start", "feeding_end"]);
  assert.equal((await f.coordinator.getSettings("owner", "SN001")).totalRemaining, 0);
});

test("owner and member opt in independently, and revoked access blocks delivery", async () => {
  const f = fixture();
  await grantPair(f.coordinator, "owner");
  await grantPair(f.coordinator, "member");
  f.access.set("member", false);
  await f.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 120000,
    sourceEventId: "alarm-2",
  });
  assert.deepEqual(f.sends.map((item) => item.openid), ["owner"]);
  assert.equal((await f.coordinator.getSettings("owner", "SN001")).templates[0].remainingCount, 0);
});

test("a transient provider failure restores local quota", async () => {
  const f = fixture();
  f.coordinator.miniService.send = async () => {
    const error = new Error("WECHAT_MINI_PROVIDER_UNAVAILABLE");
    error.code = "WECHAT_MINI_PROVIDER_UNAVAILABLE";
    throw error;
  };
  await grantPair(f.coordinator, "owner");
  await f.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 180000,
    sourceEventId: "alarm-3",
  });
  assert.equal((await f.coordinator.getSettings("owner", "SN001")).templates[0].remainingCount, 1);
});

test("an active official-account binding is preferred without consuming mini quota", async () => {
  const f = fixture();
  const officialSends = [];
  f.store.upsertUser("owner", { unionid: "union-owner" });
  f.store.saveOfficialBinding({
    unionid: "union-owner",
    officialOpenid: "official-owner",
    status: "active",
  });
  await grantPair(f.coordinator, "owner");
  f.coordinator.officialService = {
    isConfigured: () => true,
    getTemplateId: (eventType) => `official-${eventType}`,
    buildData: () => ({}),
    send: async (input) => {
      officialSends.push(input);
      return { ok: true };
    },
  };
  await f.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 240000,
    sourceEventId: "alarm-4",
  });
  assert.equal(officialSends.length, 1);
  assert.equal(f.sends.length, 0);
  assert.equal((await f.coordinator.getSettings("owner", "SN001")).templates[0].remainingCount, 1);
});

test("an active WxPusher binding is preferred over one-time mini quota", async () => {
  const f = fixture();
  const wxPusherSends = [];
  f.store.saveWxPusherBindingChallenge({
    openid: "owner",
    challenge: "bind-owner",
    expiresAt: Date.now() + 60_000,
  });
  f.store.completeWxPusherBindingChallenge({
    challenge: "bind-owner",
    uid: "UID_owner123",
    now: Date.now(),
  });
  await grantPair(f.coordinator, "owner");
  f.coordinator.wxPusherService = {
    isConfigured: () => true,
    async send(input) {
      wxPusherSends.push(input);
      return { ok: true, sendRecordId: "42", providerStatus: "accepted" };
    },
  };

  await f.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 300000,
    sourceEventId: "alarm-wxpusher",
  });

  assert.equal(wxPusherSends.length, 1);
  assert.equal(wxPusherSends[0].uid, "UID_owner123");
  assert.equal(f.sends.length, 0);
  assert.equal((await f.coordinator.getSettings("owner", "SN001")).templates[0].remainingCount, 1);
});

test("WxPusher appends a ClawBot renewal warning to the ninth and tenth estimated messages", async () => {
  const f = fixture();
  const wxPusherSends = [];
  f.store.saveWxPusherBindingChallenge({
    openid: "owner",
    challenge: "bind-owner-warning",
    expiresAt: Date.now() + 60_000,
  });
  f.store.completeWxPusherBindingChallenge({
    challenge: "bind-owner-warning",
    uid: "UID_owner123",
    now: Date.now(),
  });
  f.store.getWxPusherClawBotStatus = () => ({ status: "active", estimatedRemaining: 2 });
  f.coordinator.wxPusherService = {
    isConfigured: () => true,
    async send(input) {
      wxPusherSends.push(input);
      return { ok: true, sendRecordId: "99", providerStatus: "accepted" };
    },
  };
  f.store.saveNotificationPreference("owner", "SN001", true);

  await f.coordinator.dispatchFeedingEvent({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 360000,
    sourceEventId: "alarm-wxpusher-warning",
  });

  assert.equal(wxPusherSends.length, 1);
  assert.match(wxPusherSends[0].content, /接近本轮上限/);
  assert.doesNotMatch(wxPusherSends[0].summary, /上限|续期/);
});

test("a followed legacy PushPlus friend remains a fallback and tests are rate limited", async () => {
  const f = fixture();
  f.store.savePushPlusBindingChallenge({
    openid: "owner",
    code: "pushplus-owner",
    qrCodeUrl: "https://image.pushplus.plus/friend.png",
    expiresAt: Date.now() + 60_000,
  });
  f.store.completePushPlusBinding("pushplus-owner", {
    token: "friend-owner",
    friendId: 1,
    isFollow: 1,
  });
  const pushPlusSends = [];
  f.coordinator.pushPlusNotifier = {
    isConfigured: () => true,
    getStatus: () => ({ provider: "pushplus", configured: true }),
    async sendFeedingNotification(input) {
      pushPlusSends.push(input);
      return { ok: true, status: "pending", messageId: "short-code-owner", providerStatus: "accepted" };
    },
  };

  const result = await f.coordinator.sendTest("owner", "SN001", "feeding_start");
  assert.equal(result.delivery.provider, "pushplus");
  assert.equal(result.delivery.status, "pending");
  assert.equal(result.delivery.providerMessageId, "short-code-owner");
  assert.equal(result.delivery.recipientHash.length, 64);
  assert.equal(JSON.stringify(result.delivery).includes("friend-owner"), false);
  assert.equal(pushPlusSends.length, 1);
  await assert.rejects(
    () => f.coordinator.sendTest("owner", "SN001", "feeding_start"),
    (error) => error.code === "NOTIFICATION_TEST_RATE_LIMITED" && error.statusCode === 429
  );
});

test("WxPusher wins when an account also has a legacy PushPlus binding", async () => {
  const f = fixture();
  f.store.savePushPlusBindingChallenge({
    openid: "owner",
    code: "legacy-pushplus-owner",
    qrCodeUrl: "https://image.pushplus.plus/friend.png",
    expiresAt: Date.now() + 60_000,
  });
  f.store.completePushPlusBinding("legacy-pushplus-owner", {
    token: "friend-owner",
    friendId: 1,
    isFollow: 1,
  });
  f.store.saveWxPusherBindingChallenge({
    openid: "owner",
    challenge: "preferred-wxpusher-owner",
    expiresAt: Date.now() + 60_000,
  });
  f.store.completeWxPusherBindingChallenge({
    challenge: "preferred-wxpusher-owner",
    uid: "UID_owner123",
    now: Date.now(),
  });
  const pushPlusSends = [];
  const wxPusherSends = [];
  f.coordinator.pushPlusNotifier = {
    isConfigured: () => true,
    async sendFeedingNotification(input) {
      pushPlusSends.push(input);
      return { ok: true, messageId: "legacy-message", providerStatus: "accepted" };
    },
  };
  f.coordinator.wxPusherService = {
    isConfigured: () => true,
    async send(input) {
      wxPusherSends.push(input);
      return { ok: true, sendRecordId: "77", providerStatus: "accepted" };
    },
  };

  const result = await f.coordinator.sendTest("owner", "SN001", "feeding_start");

  assert.equal(result.delivery.provider, "wxpusher");
  assert.equal(wxPusherSends.length, 1);
  assert.equal(wxPusherSends[0].uid, "UID_owner123");
  assert.equal(pushPlusSends.length, 0);
});
