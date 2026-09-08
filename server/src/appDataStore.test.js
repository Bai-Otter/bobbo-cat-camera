const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

const { AppDataStore } = require("./appDataStore");

test("app data store persists profiles across restarts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbo-app-data-"));
  const filePath = path.join(dir, "app-data.sqlite");
  const first = new AppDataStore(filePath);

  first.upsertUser("openid-owner", { nickname: "布丁", avatar: "avatar.jpg" });
  first.close();

  const second = new AppDataStore(filePath);
  assert.deepEqual(second.getUser("openid-owner"), {
    openid: "openid-owner",
    unionid: "",
    nickname: "布丁",
    avatar: "avatar.jpg",
    createdAt: second.getUser("openid-owner").createdAt,
    updatedAt: second.getUser("openid-owner").updatedAt,
  });
  second.close();
});

test("app data store persists UnionID and subscription quotas independently per device", () => {
  const store = new AppDataStore(":memory:");
  store.upsertUser("openid-owner", { unionid: "union-owner" });
  assert.equal(store.getUserByUnionid("union-owner").openid, "openid-owner");

  store.saveNotificationPreference("openid-owner", "SN001", true);
  store.addMiniSubscriptionGrant("openid-owner", {
    deviceSn: "SN001",
    eventType: "feeding_start",
    templateId: "tmpl-start",
    status: "accept",
  });
  store.addMiniSubscriptionGrant("openid-owner", {
    deviceSn: "SN001",
    eventType: "feeding_start",
    templateId: "tmpl-start",
    status: "accept",
  });
  store.addMiniSubscriptionGrant("openid-owner", {
    deviceSn: "SN001",
    eventType: "feeding_end",
    templateId: "tmpl-end",
    status: "reject",
  });

  assert.equal(store.listMiniSubscriptionRecipients("SN001", "feeding_start")[0].remainingCount, 2);
  assert.equal(store.claimMiniSubscriptionGrant("openid-owner", "SN001", "feeding_start"), true);
  assert.equal(store.claimMiniSubscriptionGrant("openid-owner", "SN001", "feeding_start"), true);
  assert.equal(store.claimMiniSubscriptionGrant("openid-owner", "SN001", "feeding_start"), false);
  assert.equal(store.listMiniSubscriptionRecipients("SN001", "feeding_start").length, 0);
  store.close();
});

test("motion alert presentation preference is independent from feeding notifications", () => {
  const store = new AppDataStore(":memory:");
  store.saveNotificationPreference("openid-owner", "SN001", false);

  assert.equal(store.getMotionAlertPreference("openid-owner", "SN001").enabled, true);
  store.saveMotionAlertPreference("openid-owner", "SN001", false);

  assert.equal(store.getMotionAlertPreference("openid-owner", "SN001").enabled, false);
  assert.equal(store.getNotificationPreference("openid-owner", "SN001").enabled, false);
  store.saveNotificationPreference("openid-owner", "SN001", true);
  assert.equal(store.getMotionAlertPreference("openid-owner", "SN001").enabled, false);
  store.close();
});

test("app data store isolates feedback and device covers by openid", () => {
  const store = new AppDataStore(":memory:");
  store.addFeedback("openid-owner", {
    type: "建议",
    content: "希望增加提醒",
    contact: "owner@example.test",
    deviceSn: "SN001",
  });
  store.saveDeviceCover("openid-owner", {
    sn: "SN001",
    coverUrl: "https://example.test/owner.jpg",
    capturedAt: 1710000000000,
  });
  store.saveDeviceCover("openid-other", {
    sn: "SN001",
    coverUrl: "https://example.test/other.jpg",
    capturedAt: 1710000001000,
  });

  assert.equal(store.listFeedback("openid-owner").length, 1);
  assert.equal(store.listFeedback("openid-other").length, 0);
  assert.deepEqual(store.getDeviceCovers("openid-owner", ["SN001"]), {
    SN001: {
      sn: "SN001",
      fileId: "",
      coverUrl: "https://example.test/owner.jpg",
      capturedAt: 1710000000000,
      updatedAt: 1710000000000,
    },
  });
  assert.equal(store.deleteDeviceCover("openid-owner", "SN001"), true);
  assert.deepEqual(store.getDeviceCovers("openid-owner", ["SN001"]), {});
  assert.equal(store.getDeviceCovers("openid-other", ["SN001"]).SN001.coverUrl, "https://example.test/other.jpg");
  store.close();
});

test("app data store persists supported foodcast edit and duration modes per user", () => {
  const store = new AppDataStore(":memory:");
  assert.deepEqual(store.getFoodcastPreferences("openid-owner"), {
    mode: "quick_cut",
    durationMode: "auto",
    updatedAt: 0,
  });
  const saved = store.saveFoodcastPreferences("openid-owner", { mode: "natural", durationMode: "rich" });
  assert.equal(saved.mode, "natural");
  assert.equal(saved.durationMode, "rich");
  assert.ok(saved.updatedAt > 0);
  assert.throws(
    () => store.saveFoodcastPreferences("openid-owner", { mode: "slow" }),
    /FOODCAST_MODE_INVALID/
  );
  assert.throws(
    () => store.saveFoodcastPreferences("openid-owner", { durationMode: "forever" }),
    /FOODCAST_DURATION_MODE_INVALID/
  );
  assert.equal(store.getFoodcastPreferences("openid-other").mode, "quick_cut");
  assert.equal(store.getFoodcastPreferences("openid-other").durationMode, "auto");
  store.close();
});

test("app data store keeps WeChat device subscriptions isolated per user and device", () => {
  const store = new AppDataStore(":memory:");
  store.saveWechatDeviceSubscription("openid-owner", {
    deviceSn: "SN001",
    templateId: "tmpl-start",
    eventType: "feeding_start",
    status: "accept",
    enabled: true,
  });
  store.saveWechatDeviceSubscription("openid-member", {
    deviceSn: "SN001",
    templateId: "tmpl-start",
    eventType: "feeding_start",
    status: "reject",
    enabled: false,
  });

  assert.equal(store.getWechatDeviceSubscriptions("openid-owner", "SN001")[0].enabled, true);
  assert.equal(store.getWechatDeviceSubscriptions("openid-member", "SN001")[0].status, "reject");
  assert.deepEqual(
    store.listEnabledWechatDeviceSubscriptions("SN001", "tmpl-start").map((item) => item.openid),
    ["openid-owner"]
  );
  store.close();
});

test("app data store persists notification delivery claims and feeding session correlation", () => {
  const store = new AppDataStore(":memory:");
  const first = store.resolveWechatFeedingSession({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 1_000_000,
    sourceKey: "alarm-1",
    dedupeWindowMs: 30 * 60_000,
  });
  const duplicate = store.resolveWechatFeedingSession({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 1_005_000,
    sourceKey: "clip-1-start",
    dedupeWindowMs: 30 * 60_000,
  });
  const ended = store.resolveWechatFeedingSession({
    deviceSn: "SN001",
    eventType: "feeding_end",
    occurredAt: 1_060_000,
    sourceKey: "clip-1-end",
    sessionId: first.sessionId,
  });
  const next = store.resolveWechatFeedingSession({
    deviceSn: "SN001",
    eventType: "feeding_start",
    occurredAt: 1_070_000,
    sourceKey: "alarm-2",
    dedupeWindowMs: 30 * 60_000,
  });

  assert.equal(first.sessionId, duplicate.sessionId);
  assert.equal(ended.state, "closed");
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(store.claimWechatNotificationDelivery({
    deliveryKey: `${first.sessionId}:feeding_start:openid-owner:tmpl-start`,
    openid: "openid-owner",
    deviceSn: "SN001",
    templateId: "tmpl-start",
    eventType: "feeding_start",
    eventTime: 1_000_000,
  }), true);
  store.markWechatNotificationDeliverySent(`${first.sessionId}:feeding_start:openid-owner:tmpl-start`);
  assert.equal(store.claimWechatNotificationDelivery({
    deliveryKey: `${first.sessionId}:feeding_start:openid-owner:tmpl-start`,
    openid: "openid-owner",
    deviceSn: "SN001",
    templateId: "tmpl-start",
    eventType: "feeding_start",
    eventTime: 1_000_000,
  }), false);
  store.close();
});

test("notification deliveries persist pending and final provider state without raw recipients", () => {
  const store = new AppDataStore(":memory:");
  const deliveryKey = "pushplus:manual-test:openid-owner:SN001:feeding_start:1";
  assert.equal(store.claimWechatNotificationDelivery({
    deliveryKey,
    openid: "openid-owner",
    recipient: "friend-token-secret",
    deviceSn: "SN001",
    templateId: "pushplus:feeding_start:test",
    eventType: "feeding_start",
    provider: "pushplus",
  }), true);
  store.markWechatNotificationDeliveryPending(deliveryKey, {
    providerMessageId: "short-code-1",
    providerStatus: "accepted",
  });
  const pending = store.getWechatNotificationDeliveryByKey(deliveryKey);
  assert.match(pending.id, /^delivery_[a-f0-9]{32}$/);
  assert.equal(pending.status, "pending");
  assert.equal(pending.providerMessageId, "short-code-1");
  assert.equal(pending.recipientHash.length, 64);
  assert.notEqual(pending.recipientHash, "friend-token-secret");
  assert.equal(JSON.stringify(pending).includes("friend-token-secret"), false);

  assert.equal(store.updateWechatNotificationDeliveryByProviderMessageId("pushplus", "short-code-1", {
    status: "delivered",
    providerStatus: "sendStatus:2",
    providerCode: 2,
  }), 1);
  const delivered = store.getWechatNotificationDelivery(pending.id, "openid-owner");
  assert.equal(delivered.status, "delivered");
  assert.ok(delivered.deliveredAt > 0);
  assert.equal(store.getWechatNotificationDelivery(pending.id, "openid-other"), null);
  store.close();
});

test("PushPlus bindings require a followed friend and can be disabled account-wide", () => {
  const store = new AppDataStore(":memory:");
  const expiresAt = Date.now() + 60_000;
  store.savePushPlusBindingChallenge({
    openid: "openid-owner",
    code: "pushplus-code-1",
    qrCodeUrl: "https://image.pushplus.plus/friend.png",
    expiresAt,
  });
  assert.equal(store.completePushPlusBinding("pushplus-code-1", {
    token: "friend-token-1",
    isFollow: 0,
  }), null);
  const bound = store.completePushPlusBinding("pushplus-code-1", {
    token: "friend-token-1",
    friendId: 7,
    isFollow: 1,
  });
  assert.equal(bound.isFollow, true);
  assert.equal(bound.status, "active");
  assert.equal(store.disablePushPlusBinding("openid-owner"), true);
  assert.equal(store.getPushPlusBinding("openid-owner").status, "disabled");
  store.close();
});

function bindWxPusher(store, openid, uid, now = Date.now()) {
  const challenge = `challenge-${openid}-${now}`;
  store.saveWxPusherBindingChallenge({ openid, challenge, expiresAt: now + 60_000 });
  return store.completeWxPusherBindingChallenge({ challenge, uid, now });
}

function acceptWxPusherTest(store, openid, deviceSn, providerMessageId, { delivered = true } = {}) {
  const deliveryKey = `wxpusher:manual-test:${openid}:${deviceSn}:${providerMessageId}`;
  store.claimWechatNotificationDelivery({
    deliveryKey,
    openid,
    recipient: `UID_${openid}`,
    deviceSn,
    templateId: "wxpusher:feeding_start:test",
    eventType: "feeding_start",
    provider: "wxpusher",
  });
  store.markWechatNotificationDeliveryPending(deliveryKey, {
    providerMessageId,
    providerStatus: "accepted",
  });
  if (delivered) {
    store.updateWechatNotificationDeliveryByProviderMessageId("wxpusher", providerMessageId, {
      status: "delivered",
      providerStatus: "发送成功",
    });
  }
  return store.getWechatNotificationDeliveryByKey(deliveryKey);
}

test("WxPusher ClawBot confirmation rejects a test that is only accepted or has failed", () => {
  const store = new AppDataStore(":memory:");
  const now = Date.now();
  bindWxPusher(store, "owner", "UID_owner", now);
  const pending = acceptWxPusherTest(store, "owner", "SN001", "9001", { delivered: false });

  assert.throws(
    () => store.confirmWxPusherClawBot("owner", pending.id, now + 1),
    /WXPUSHER_CLAWBOT_TEST_PENDING/
  );
  store.updateWechatNotificationDeliveryByProviderMessageId("wxpusher", "9001", {
    status: "failed",
    providerStatus: "发送失败",
  });
  assert.throws(
    () => store.confirmWxPusherClawBot("owner", pending.id, now + 2),
    /WXPUSHER_CLAWBOT_TEST_FAILED/
  );
  store.close();
});

test("WxPusher ClawBot confirmation is user-owned and quota is shared across that user's devices", () => {
  const store = new AppDataStore(":memory:");
  const now = Date.now();
  bindWxPusher(store, "owner", "UID_owner", now);
  bindWxPusher(store, "member", "UID_member", now);
  const ownerTest = acceptWxPusherTest(store, "owner", "SN001", "1001");
  const memberTest = acceptWxPusherTest(store, "member", "SN001", "2001");

  assert.throws(
    () => store.confirmWxPusherClawBot("member", ownerTest.id, Date.now()),
    /WXPUSHER_CLAWBOT_TEST_INVALID/
  );
  const ownerStatus = store.confirmWxPusherClawBot("owner", ownerTest.id, Date.now());
  const memberStatus = store.confirmWxPusherClawBot("member", memberTest.id, Date.now());
  assert.equal(ownerStatus.status, "active");
  assert.equal(ownerStatus.estimatedUsed, 1);
  assert.equal(ownerStatus.estimatedRemaining, 9);
  assert.equal(memberStatus.estimatedRemaining, 9);

  for (let index = 0; index < 8; index += 1) {
    acceptWxPusherTest(store, "owner", index % 2 === 0 ? "SN001" : "SN002", String(1100 + index));
  }
  const sharedQuota = store.getWxPusherClawBotStatus("owner", Date.now());
  assert.equal(sharedQuota.estimatedUsed, 9);
  assert.equal(sharedQuota.estimatedRemaining, 1);
  assert.equal(store.getWxPusherClawBotStatus("member", Date.now()).estimatedRemaining, 9);
  acceptWxPusherTest(store, "owner", "SN002", "1199");
  const exhausted = store.getWxPusherClawBotStatus("owner", Date.now());
  assert.equal(exhausted.estimatedRemaining, 0);
  assert.equal(exhausted.status, "reactivation_required");
  store.close();
});

test("WxPusher ClawBot state expires and can be confirmed again with a fresh owned test", () => {
  const store = new AppDataStore(":memory:");
  const now = Date.now();
  bindWxPusher(store, "owner", "UID_owner", now);
  const first = acceptWxPusherTest(store, "owner", "SN001", "3001");
  const active = store.confirmWxPusherClawBot("owner", first.id, first.deliveredAt + 1);
  const expiredAt = active.activeUntil + 1;
  assert.equal(store.getWxPusherClawBotStatus("owner", expiredAt).status, "reactivation_required");

  const second = acceptWxPusherTest(store, "owner", "SN002", "3002");
  store.db.prepare(`
    UPDATE wechat_notification_deliveries SET accepted_at = ?, delivered_at = ?, created_at = ?, updated_at = ?
    WHERE delivery_id = ?
  `).run(expiredAt, expiredAt, expiredAt, expiredAt, second.id);
  const renewed = store.confirmWxPusherClawBot("owner", second.id, expiredAt + 1);
  assert.equal(renewed.status, "active");
  assert.equal(renewed.confirmedAt, expiredAt);
  assert.equal(renewed.estimatedUsed, 1);
  store.close();
});

test("legacy WxPusher binding databases migrate ClawBot state columns without losing the binding", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbo-wxpusher-migration-"));
  const filePath = path.join(dir, "app-data.sqlite");
  const legacy = new DatabaseSync(filePath);
  legacy.exec(`
    CREATE TABLE wxpusher_bindings (
      openid TEXT PRIMARY KEY,
      uid TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      bound_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO wxpusher_bindings (openid, uid, status, bound_at, updated_at)
    VALUES ('owner', 'UID_owner', 'active', 1, 1);
  `);
  legacy.close();

  const store = new AppDataStore(filePath);
  const binding = store.getWxPusherBinding("owner");
  assert.equal(binding.uid, "UID_owner");
  assert.equal(binding.clawBotConfirmedAt, 0);
  assert.equal(binding.clawBotActiveUntil, 0);
  assert.equal(store.getWxPusherClawBotStatus("owner").status, "pending_confirmation");
  store.close();
});
