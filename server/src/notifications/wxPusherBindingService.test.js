const test = require("node:test");
const assert = require("node:assert/strict");

const { AppDataStore } = require("../appDataStore");
const { WxPusherBindingService } = require("./wxPusherBindingService");

function fixture() {
  const store = new AppDataStore(":memory:");
  const wxPusherService = {
    appId: "123",
    isConfigured: () => true,
    async createBindingQrcode(extra, validTime) {
      return {
        qrCodeUrl: `https://wxpusher.zjiecode.com/qrcode/${extra}.png`,
        followUrl: "https://wxpusher.zjiecode.com/follow/test",
        validTime,
      };
    },
  };
  const service = new WxPusherBindingService({
    store,
    wxPusherService,
    challengeProvider: () => "challenge-safe-1",
    now: () => 10_000,
    challengeTtlSeconds: 600,
  });
  return { store, service };
}

test("parameter qrcode challenge binds exactly one account and hides UID in status", async () => {
  const f = fixture();
  const challenge = await f.service.createChallenge("openid-1");
  assert.equal(challenge.expiresAt, 610_000);
  assert.equal(f.service.getBindingStatus("openid-1").bound, false);

  const callback = f.service.handleCallback({
    action: "app_subscribe",
    data: { appId: 123, uid: "UID_target123", extra: "challenge-safe-1" },
  });
  assert.equal(callback.ok, true);
  assert.deepEqual(f.service.getBindingStatus("openid-1"), {
    configured: true,
    bound: true,
    status: "active",
    uidPreview: "UID_tar...t123",
    boundAt: 10000,
  });
  assert.equal(f.store.getWxPusherBinding("openid-1").uid, "UID_target123");
});

test("binding callback validates appId, UID and one-time challenge", async () => {
  const f = fixture();
  await f.service.createChallenge("openid-1");
  assert.deepEqual(
    f.service.handleCallback({ action: "app_subscribe", data: { appId: 999, uid: "UID_target123", extra: "challenge-safe-1" } }),
    { ok: false, error: "WXPUSHER_APP_ID_INVALID" }
  );
  assert.deepEqual(
    f.service.handleCallback({ action: "app_subscribe", data: { appId: 123, uid: "bad", extra: "challenge-safe-1" } }),
    { ok: false, error: "WXPUSHER_CALLBACK_INVALID" }
  );
  assert.equal(f.service.handleCallback({
    action: "app_subscribe",
    data: { appId: 123, uid: "UID_target123", extra: "challenge-safe-1" },
  }).ok, true);
  assert.deepEqual(
    f.service.handleCallback({
      action: "app_subscribe",
      data: { appId: 123, uid: "UID_other123", extra: "challenge-safe-1" },
    }),
    { ok: false, error: "WXPUSHER_CHALLENGE_INVALID" }
  );
});

test("binding can be disabled account-wide", async () => {
  const f = fixture();
  await f.service.createChallenge("openid-1");
  f.service.handleCallback({
    action: "app_subscribe",
    data: { appId: 123, uid: "UID_target123", extra: "challenge-safe-1" },
  });
  assert.equal(f.service.removeBinding("openid-1").status, "disabled");
  assert.equal(f.service.getBindingStatus("openid-1").bound, false);
});
