const test = require("node:test");
const assert = require("node:assert/strict");

const { PushPlusBindingService } = require("./pushPlusBindingService");

function makeStore() {
  const state = { bindings: new Map(), challenges: new Map() };
  return {
    getPushPlusBinding(openid) {
      return state.bindings.get(openid) || null;
    },
    getActivePushPlusBindingChallenge(openid, now) {
      const item = state.challenges.get(openid);
      return item && item.expiresAt > now ? item : null;
    },
    savePushPlusBindingChallenge(item) {
      state.challenges.set(item.openid, item);
      return item;
    },
    completePushPlusBinding(code, friendInfo) {
      const challenge = [...state.challenges.values()].find((item) => item.code === code);
      if (!challenge) return null;
      const binding = {
        openid: challenge.openid,
        friendToken: friendInfo.token,
        friendId: friendInfo.friendId,
        isFollow: friendInfo.isFollow,
      };
      state.bindings.set(challenge.openid, binding);
      state.challenges.delete(challenge.openid);
      return binding;
    },
  };
}

test("PushPlusBindingService creates a temporary friend QR without exposing credentials", async () => {
  const store = makeStore();
  const calls = [];
  const service = new PushPlusBindingService({
    store,
    openApi: {
      isConfigured: () => true,
      async getFriendQrCode(payload) {
        calls.push(payload);
        return { qrCodeImgUrl: "https://mp.weixin.qq.com/private-friend-qr" };
      },
    },
    codeProvider: () => "binding-code-1",
    nowProvider: () => 1_000,
  });

  const status = await service.getBindingStatus("openid-1");

  assert.equal(status.configured, true);
  assert.equal(status.bound, false);
  assert.equal(status.friendQrCode, "binding-code-1");
  assert.equal(status.friendQrSourceUrl, undefined);
  assert.equal(JSON.stringify(status).includes("private-friend-qr"), false);
  assert.deepEqual(calls, [{ content: "binding-code-1", second: 2_592_000, scanCount: 1 }]);
  assert.equal(service.getFriendQrSourceUrl("binding-code-1"), "https://mp.weixin.qq.com/private-friend-qr");
});

test("PushPlusBindingService completes an add_friend callback for the matching mini-program user", async () => {
  const store = makeStore();
  const service = new PushPlusBindingService({
    store,
    openApi: {
      isConfigured: () => true,
      async getFriendQrCode() {
        return { qrCodeImgUrl: "https://mp.weixin.qq.com/private-friend-qr" };
      },
    },
    codeProvider: () => "binding-code-2",
    nowProvider: () => 1_000,
  });
  await service.getBindingStatus("openid-2");

  const result = service.handleCallback({
    event: "add_friend",
    qrCode: "binding-code-2",
    friendInfo: { token: "friend-token-2", friendId: 22, isFollow: 1 },
  });

  assert.equal(result.ok, true);
  assert.equal(service.getFriendToken("openid-2"), "friend-token-2");
  const status = await service.getBindingStatus("openid-2");
  assert.deepEqual(status, {
    configured: true,
    bound: true,
    isFollow: true,
  });
});

test("PushPlusBindingService acknowledges provider add_friend validation without creating a binding", () => {
  const store = makeStore();
  const service = new PushPlusBindingService({
    store,
    openApi: { isConfigured: () => true },
  });

  const result = service.handleCallback({
    event: "add_friend",
    friendInfo: { token: "5709******ddf", friendId: 5, isFollow: 1 },
  });

  assert.deepEqual(result, { ok: true, ignored: true });
  assert.equal(service.getFriendToken("openid-unknown"), "");
});

test("PushPlusBindingService requires the friend to follow the WeChat account", async () => {
  const store = makeStore();
  const service = new PushPlusBindingService({
    store,
    openApi: {
      isConfigured: () => true,
      async getFriendQrCode() {
        return { qrCodeImgUrl: "https://mp.weixin.qq.com/private-friend-qr" };
      },
    },
    codeProvider: () => "binding-code-follow",
    nowProvider: () => 1_000,
  });
  await service.getBindingStatus("openid-follow");
  const result = service.handleCallback({
    event: "add_friend",
    qrCode: "binding-code-follow",
    friendInfo: { token: "friend-token-follow", friendId: 23, isFollow: 0 },
  });
  assert.deepEqual(result, { ok: false, error: "PUSHPLUS_WECHAT_FOLLOW_REQUIRED" });
  assert.equal(service.getFriendToken("openid-follow"), "");
});
