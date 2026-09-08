const fs = require("fs");
const os = require("os");
const path = require("path");
const { beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { PassThrough } = require("node:stream");
const express = require("express");

const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-devices-"));

process.env.JF_UUID ||= "uuid";
process.env.JF_APPKEY ||= "appKey";
process.env.JF_APPSECRET ||= "appSecret";
process.env.JF_MOVECARD ||= "3";
process.env.JF_DEVICE_SN ||= "SN001";
process.env.JF_DEVICE_USERNAME ||= "admin";
process.env.JF_DEVICE_PASSWORD ||= "device-password";
process.env.JF_ENDPOINT ||= "api-cn.example.test";
process.env.APP_SESSION_SECRET ||= "route-test-session-secret-at-least-32-bytes";
process.env.LEGACY_DEVICE_OWNER_OPENID ||= "openid-owner";
process.env.JF_DEVICE_REGISTRY_FILE = path.join(registryDir, "devices.json");
process.env.APP_DATA_STATE_FILE = path.join(registryDir, "app-data.sqlite");
process.env.ACCOUNT_SYNC_AUDIT_FILE = path.join(registryDir, "account-sync-audit.jsonl");
process.env.LIVE_PLAYBACK_DIAGNOSTIC_SN = "SN001";
process.env.FEED_ANALYSIS_TEST_TOKEN ||= "route-feed-analysis-test-token";

const config = require("./config");
const { createAppSessionService } = require("./appSession");
const cache = require("./tokenCache");
const { DeviceRegistry } = require("./deviceRegistry");
const { JFDevice } = require("./jf/device");
const {
  authorizedDeviceSnapshot,
  authenticateMediaControl,
  recordingStageError,
  resetDeviceStateForTests,
  resolveOwnedLiveSession,
  resolveOwnedMediaDevice,
  resolveOwnedRecordingLiveSource,
  resolveOwnedRecordingWindow,
  resolveOwnedTalkbackUrl,
  router,
  resetAppDataForTests,
  setFeedAnalysisCoordinator,
  setFeedingActivityTestServiceForTests,
  setFoodcastAutomationService,
  setCustomFoodcastService,
  setFoodcastService,
  setLiveRecordingServiceForTests,
  setReplayChannelReleaseDelayForTests,
  setReplayHlsManagerForTests,
  setReplayNativeClientFactoryForTests,
  setWechatLoginServiceForTests,
  setWechatDeviceNotificationCoordinatorForTests,
} = require("./routes");

test("recording stage errors preserve coded failures and classify raw SDK failures", () => {
  const raw = new Error("SDK request failed");
  const classified = recordingStageError("RECORDING_QUERY_FAILED", raw);
  assert.equal(classified.code, "RECORDING_QUERY_FAILED");
  assert.equal(classified.cause, raw);

  const coded = new Error("DEVICE_OFFLINE");
  coded.code = "DEVICE_OFFLINE";
  assert.equal(recordingStageError("RECORDING_QUERY_FAILED", coded), coded);
});

test("authorized recording snapshots require the expected SN without duplicating owner metadata", () => {
  const snapshot = { sn: "SN001", username: "admin", password: "device-password" };
  const sparseSnapshot = { username: "admin", password: "device-password" };

  assert.deepEqual(authorizedDeviceSnapshot(snapshot, "openid-owner", "SN001"), snapshot);
  assert.deepEqual(authorizedDeviceSnapshot(sparseSnapshot, "openid-owner", "SN001"), {
    ...sparseSnapshot,
    sn: "SN001",
  });
  assert.equal(authorizedDeviceSnapshot(snapshot, "openid-owner", "SN002"), null);
  assert.equal(authorizedDeviceSnapshot({ ...snapshot, ownerOpenid: "other-owner" }, "openid-owner", "SN001"), null);
});

test("feed analysis device refresh replaces only the failed device token", async () => {
  let provider = null;
  const originalGetToken = JFDevice.prototype.getToken;
  cache.set("token:SN-REFRESH", "stale-token", cache.TTL_TOKEN);
  cache.set("token:SN-OTHER", "other-token", cache.TTL_TOKEN);
  JFDevice.prototype.getToken = async function getToken() {
    this.deviceToken = "fresh-token";
    return this.deviceToken;
  };
  setFeedAnalysisCoordinator({
    setDeviceProvider(value) { provider = value; },
  });

  try {
    const device = await provider.refreshDevice("SN-REFRESH");
    assert.equal(device.deviceToken, "fresh-token");
    assert.equal(cache.get("token:SN-REFRESH"), "fresh-token");
    assert.equal(cache.get("token:SN-OTHER"), "other-token");
  } finally {
    JFDevice.prototype.getToken = originalGetToken;
    cache.remove("token:SN-REFRESH");
    cache.remove("token:SN-OTHER");
    setFeedAnalysisCoordinator(null);
  }
});

beforeEach(() => {
  fs.writeFileSync(process.env.ACCOUNT_SYNC_AUDIT_FILE, "", "utf8");
  cache.clear();
  resetDeviceStateForTests({ clearStore: true });
  resetAppDataForTests();
  setWechatLoginServiceForTests(null);
  setWechatDeviceNotificationCoordinatorForTests(null);
  setFeedAnalysisCoordinator(null);
  setFeedingActivityTestServiceForTests(null);
  setFoodcastAutomationService(null);
  setCustomFoodcastService(null);
  setFoodcastService(null);
  setLiveRecordingServiceForTests(null);
  setReplayHlsManagerForTests(null);
  setReplayNativeClientFactoryForTests(null);
  setReplayChannelReleaseDelayForTests(null);
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const testSessions = createAppSessionService({ secret: process.env.APP_SESSION_SECRET });

function authenticatedHeaders(openid = "openid-owner") {
  return {
    "x-wx-openid": openid,
    "x-wx-source": "wx_client",
    "x-cat-session": testSessions.issue(openid),
  };
}

test("media-control helpers authenticate a raw upgrade request and enforce owned live sessions", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const headers = authenticatedHeaders();
  const identity = authenticateMediaControl({ headers }, headers["x-cat-session"]);
  assert.deepEqual(identity, { openid: "openid-owner" });

  const device = await resolveOwnedMediaDevice("openid-owner", "SN001");
  assert.equal(device.sn, "SN001");
  assert.equal(await resolveOwnedMediaDevice("openid-other", "SN001"), null);

  setReplayHlsManagerForTests({
    getSessionDescriptor(sessionId) {
      assert.equal(sessionId, "live-1");
      return {
        deviceSn: "SN001",
        ownerOpenid: "openid-owner",
        live: true,
        playUrl: "https://backend.test/api/replay-hls/live-1/index.m3u8",
      };
    },
    async cleanupExpired() { return 0; },
  });
  assert.equal((await resolveOwnedLiveSession("openid-owner", "SN001", "live-1")).live, true);
  assert.equal(await resolveOwnedLiveSession("openid-other", "SN001", "live-1"), null);
  assert.equal(await resolveOwnedLiveSession("openid-owner", "SN002", "live-1"), null);
});

test("media-control talkback URL is resolved only after device ownership and login", async () => {
  resetDeviceStateForTests({ clearStore: false });
  await withMockedDevice(
    {
      ensureDeviceToken: async function ensureDeviceToken() {
        this.deviceToken = "device-token";
        return this.deviceToken;
      },
      login: async () => ({ Ret: 100 }),
      getTalkbackUrl: async (options) => {
        assert.deepEqual(options, { channel: config.channel, audioCode: "aac" });
        return "rtmp://camera.test/talk";
      },
    },
    async () => {
      assert.equal(
        await resolveOwnedTalkbackUrl("openid-owner", "SN001"),
        "rtmp://camera.test/talk"
      );
      await assert.rejects(
        resolveOwnedTalkbackUrl("openid-other", "SN001"),
        { code: "DEVICE_NOT_FOUND" }
      );
    }
  );
});

test("live recording obtains a fresh owned HLS source without closing the viewer stream", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const calls = [];
  await withMockedDevice(
    {
      ensureDeviceToken: async function ensureDeviceToken() {
        this.deviceToken = "device-token";
        return this.deviceToken;
      },
      login: async () => {
        calls.push("login");
        return { Ret: 100 };
      },
      getLivestreamUrl: async (protocol, channel, stream) => {
        calls.push({ protocol, channel, stream });
        return "https://camera.test/recording-live/index.m3u8";
      },
      closeLivestream: async () => {
        calls.push("close");
      },
    },
    async () => {
      assert.equal(
        await resolveOwnedRecordingLiveSource("openid-owner", "SN001"),
        "https://camera.test/recording-live/index.m3u8"
      );
      await assert.rejects(
        resolveOwnedRecordingLiveSource("openid-other", "SN001"),
        { code: "DEVICE_NOT_FOUND" }
      );
    }
  );
  assert.deepEqual(calls, [
    "login",
    { protocol: "hls-ts", channel: config.channel, stream: config.stream },
  ]);
});

test("live recording resolves SD playback windows serially on a single-channel device", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const playbackCalls = [];
  const pauses = [];
  const stoppedSessions = [];
  setFeedAnalysisCoordinator({
    pauseDevice(deviceSn, durationMs) { pauses.push({ deviceSn, durationMs }); },
  });
  setReplayHlsManagerForTests({
    async stopDeviceSessions(deviceSn) {
      stoppedSessions.push(deviceSn);
      return 0;
    },
  });

  await withMockedDevice(
    {
      ensureDeviceToken: async function ensureDeviceToken() {
        this.deviceToken = "device-token";
        return this.deviceToken;
      },
      login: async () => ({ Ret: 100 }),
      queryRecordings: async () => [
        { BeginTime: "2026-07-30 18:00:00", EndTime: "2026-07-30 18:00:08", FileName: "a.h264" },
        { BeginTime: "2026-07-30 18:00:08", EndTime: "2026-07-30 18:00:16", FileName: "b.h264" },
      ],
      getPlaybackUrl: async (record) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        playbackCalls.push(record.FileName);
        try {
          if (inFlight > 1) throw new Error("playback channel is already occupied");
          await new Promise((resolve) => setTimeout(resolve, 5));
          return `https://camera.test/${record.FileName}.m3u8`;
        } finally {
          inFlight -= 1;
        }
      },
    },
    async () => {
      const windows = await resolveOwnedRecordingWindow({
        ownerOpenid: "openid-owner",
        deviceSn: "SN001",
        device: { sn: "SN001", username: "admin", password: "device-password" },
        startedAt: new Date("2026-07-30T10:00:02.000Z").getTime(),
        endedAt: new Date("2026-07-30T10:00:14.000Z").getTime(),
      });
      assert.equal(windows.length, 2);
    }
  );

  assert.equal(maxInFlight, 1);
  assert.deepEqual(playbackCalls, ["a.h264", "b.h264"]);
  assert.deepEqual(stoppedSessions, ["SN001"]);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].deviceSn, "SN001");
});

function request(app, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const body = options.body === undefined ? null : JSON.stringify(options.body);
      const headers = {
        ...(options.auth === false ? {} : authenticatedHeaders(options.openid)),
        ...(options.headers || {}),
        ...(body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            }
          : {}),
      };
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          method: options.method || "GET",
          headers,
        },
        (res) => {
          let raw = "";
          let settled = false;
          const finish = (callback) => {
            if (settled) return;
            settled = true;
            server.close(callback);
          };
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            raw += chunk;
          });
          res.on("end", () => {
            finish(() => {
              let parsed = {};
              try {
                parsed = raw ? JSON.parse(raw) : {};
              } catch (error) {
                parsed = { raw };
              }
              resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed, raw });
            });
          });
          res.on("aborted", () => finish(() => reject(new Error("response aborted"))));
          res.on("error", (error) => finish(() => reject(error)));
        }
      );
      req.on("error", (error) => {
        server.close(() => reject(error));
      });
      req.end(body || undefined);
    });
  });
}

function withMockedDevice(methods, fn) {
  const effectiveMethods = {
    closeLivestream: async () => null,
    ...methods,
  };
  const originals = {};
  for (const [name, impl] of Object.entries(effectiveMethods)) {
    originals[name] = JFDevice.prototype[name];
    JFDevice.prototype[name] = impl;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [name, original] of Object.entries(originals)) {
        JFDevice.prototype[name] = original;
      }
      cache.clear();
      setReplayHlsManagerForTests(null);
    });
}

function assertNoSecrets(payload) {
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /device-password|admin-token|appSecret|JF_APPSECRET/i);
}

test("foodcast preferences are authenticated, validated, and persisted per account", async () => {
  const app = makeApp();
  const initial = await request(app, "/api/foodcasts/preferences");
  const saved = await request(app, "/api/foodcasts/preferences", {
    method: "PUT",
    body: { mode: "natural", durationMode: "rich" },
  });
  const reloaded = await request(app, "/api/foodcasts/preferences");
  const invalid = await request(app, "/api/foodcasts/preferences", {
    method: "PUT",
    body: { mode: "unbounded" },
  });
  const invalidDuration = await request(app, "/api/foodcasts/preferences", {
    method: "PUT",
    body: { durationMode: "endless" },
  });
  const other = await request(app, "/api/foodcasts/preferences", { openid: "openid-other" });

  assert.deepEqual(initial.body.preferences, { mode: "quick_cut", durationMode: "auto", updatedAt: 0 });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.preferences.mode, "natural");
  assert.equal(saved.body.preferences.durationMode, "rich");
  assert.ok(saved.body.preferences.updatedAt > 0);
  assert.equal(reloaded.body.preferences.mode, "natural");
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, "FOODCAST_MODE_INVALID");
  assert.equal(invalidDuration.statusCode, 400);
  assert.equal(invalidDuration.body.error, "FOODCAST_DURATION_MODE_INVALID");
  assert.deepEqual(other.body.preferences, { mode: "quick_cut", durationMode: "auto", updatedAt: 0 });
});

test("ClawBot activation status is authenticated and exposes only the supported WxPusher app flow", async () => {
  const app = makeApp();
  const denied = await request(app, "/api/notifications/wxpusher-clawbot", { auth: false });
  const status = await request(app, "/api/notifications/wxpusher-clawbot");
  const missingDelivery = await request(app, "/api/notifications/wxpusher-clawbot/confirm", {
    method: "POST",
    body: {},
  });

  assert.equal(denied.statusCode, 401);
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.clawBot.bound, false);
  assert.equal(status.body.clawBot.status, "not_bound");
  assert.equal(
    status.body.clawBot.activationUrl,
    "https://wxpusher.zjiecode.com/download/"
  );
  assert.equal(status.body.clawBot.activationMethod, "wxpusher_app");
  assert.equal(status.body.clawBot.activationPath, "/app/#/push-channel");
  assert.doesNotMatch(status.raw, /appToken|openId|session|UID_/i);
  assert.equal(missingDelivery.statusCode, 400);
  assert.equal(missingDelivery.body.error, "NOTIFICATION_DELIVERY_ID_REQUIRED");
});

test("WeChat device subscription APIs use the signed user and accessible device", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const calls = [];
  setWechatDeviceNotificationCoordinatorForTests({
    async getTicket(openid, sn) {
      calls.push(["ticket", openid, sn]);
      return { sn, snTicket: "ticket", modelId: "model-1", tmplIds: ["tmpl-start"], expiresAt: 300000 };
    },
    async getSubscription(openid, sn) {
      calls.push(["get", openid, sn]);
      return { configured: true, enabled: false, templates: [] };
    },
    async saveSubscription(openid, sn, input) {
      calls.push(["save", openid, sn, input]);
      return { configured: true, enabled: true, templates: [] };
    },
    async sendTest(openid, sn, eventType) {
      calls.push(["test", openid, sn, eventType]);
      return { ok: true, eventType };
    },
  });
  const app = makeApp();

  const ticket = await request(app, "/api/devices/SN001/wechat-device-subscription-ticket", {
    method: "POST",
    body: { openid: "forged-openid" },
  });
  const status = await request(app, "/api/devices/SN001/wechat-device-subscription");
  const saved = await request(app, "/api/devices/SN001/wechat-device-subscription", {
    method: "PUT",
    body: { enabled: true, results: { "tmpl-start": "accept" }, openid: "forged-openid" },
  });
  const stranger = await request(app, "/api/devices/SN001/wechat-device-subscription-ticket", {
    method: "POST",
    openid: "openid-stranger",
  });
  const tested = await request(app, "/api/devices/SN001/wechat-device-subscription/test", {
    method: "POST",
    body: { eventType: "feeding_start", openid: "forged-openid" },
  });

  assert.equal(ticket.statusCode, 200);
  assert.equal(ticket.body.ticket.snTicket, "ticket");
  assert.equal(status.statusCode, 200);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.subscription.enabled, true);
  assert.equal(stranger.statusCode, 404);
  assert.equal(tested.statusCode, 200);
  assert.equal(tested.body.eventType, "feeding_start");
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ["ticket", "openid-owner", "SN001"],
    ["get", "openid-owner", "SN001"],
    ["save", "openid-owner", "SN001"],
    ["test", "openid-owner", "SN001"],
  ]);
});

test("notification APIs persist preferences and subscription results for the signed user", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const calls = [];
  setWechatDeviceNotificationCoordinatorForTests({
    async getSettings(openid, sn) {
      calls.push(["get", openid, sn]);
      return { configured: true, enabled: false, totalRemaining: 0, templates: [] };
    },
    async savePreference(openid, sn, enabled) {
      calls.push(["save", openid, sn, enabled]);
      return { configured: true, enabled, totalRemaining: 0, templates: [] };
    },
    async recordSubscriptionResult(openid, sn, results) {
      calls.push(["grant", openid, sn, results]);
      return { configured: true, enabled: true, totalRemaining: 2, templates: [] };
    },
  });
  const app = makeApp();
  const status = await request(app, "/api/devices/SN001/notifications");
  const saved = await request(app, "/api/devices/SN001/notifications", {
    method: "PUT",
    body: { enabled: true, openid: "forged-openid" },
  });
  const granted = await request(app, "/api/devices/SN001/notifications/subscription-result", {
    method: "POST",
    body: { results: { start: "accept", end: "accept" }, openid: "forged-openid" },
  });

  assert.equal(status.statusCode, 200);
  assert.equal(saved.body.notifications.enabled, true);
  assert.equal(granted.body.notifications.totalRemaining, 2);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ["get", "openid-owner", "SN001"],
    ["save", "openid-owner", "SN001"],
    ["grant", "openid-owner", "SN001"],
  ]);
});

test("notification test returns an authenticated persistent delivery for polling", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const calls = [];
  setWechatDeviceNotificationCoordinatorForTests({
    async sendTest(openid, sn, eventType) {
      calls.push([openid, sn, eventType]);
      return {
        ok: true,
        delivery: {
          id: "delivery_test123",
          provider: "pushplus",
          status: "pending",
          deviceSn: sn,
          eventType,
          eventTime: 1000,
          providerStatus: "accepted",
          createdAt: 1000,
          updatedAt: 1000,
          recipientHash: "must-not-leak",
          providerMessageId: "must-not-leak",
        },
      };
    },
  });
  const response = await request(makeApp(), "/api/devices/SN001/notifications/test", {
    method: "POST",
    body: { eventType: "feeding_start", openid: "forged-openid" },
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body.delivery, {
    id: "delivery_test123",
    provider: "pushplus",
    status: "pending",
    deviceSn: "SN001",
    eventType: "feeding_start",
    eventTime: 1000,
    providerStatus: "accepted",
    acceptedAt: 0,
    deliveredAt: 0,
    failedAt: 0,
    createdAt: 1000,
    updatedAt: 1000,
  });
  assert.deepEqual(calls, [["openid-owner", "SN001", "feeding_start"]]);
  assert.doesNotMatch(response.raw, /must-not-leak/);
});

test("official account callback is public but rejects an invalid WeChat signature", async () => {
  const response = await request(
    makeApp(),
    "/api/wechat/official-account/callback?timestamp=1&nonce=2&signature=bad&echostr=x",
    { auth: false }
  );
  assert.equal(response.statusCode, 403);
});

test("foodcast stats aggregate owned and shared devices by their real data owner", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const calls = [];
  setCustomFoodcastService({
    async countAvailableFoodcasts(input) {
      calls.push(input);
      return input.deviceSn === "MEMBER-SN" ? 2 : 3;
    },
  });
  const app = makeApp();

  await withMockedDevice({
    getToken: async function getToken() {
      this.deviceToken = `token-${this.sn}`;
      return this.deviceToken;
    },
    bind: async function bind() {
      throw new Error("bind should not run when token already exists");
    },
  }, async () => {
    const owned = await request(app, "/api/devices", {
      method: "POST",
      openid: "openid-member",
      body: { sn: "MEMBER-SN", username: "admin", password: "", nickname: "Member cam" },
    });
    assert.equal(owned.statusCode, 200);
  });

  const invite = await request(app, "/api/devices/SN001/share-invites", {
    method: "POST",
    openid: "openid-owner",
  });
  await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-member",
    body: { token: invite.body.invite.token },
  });

  const response = await request(app, "/api/foodcasts/stats?ownerOpenid=attacker", {
    openid: "openid-member",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, stats: { availableCount: 5 } });
  assert.deepEqual(calls.sort((left, right) => left.deviceSn.localeCompare(right.deviceSn)), [
    { ownerOpenid: "openid-member", deviceSn: "MEMBER-SN" },
    { ownerOpenid: "openid-owner", deviceSn: "SN001" },
  ]);
  assertNoSecrets(response.body);
});

test("foodcast stats return zero without devices and do not require the renderer", async () => {
  const response = await request(makeApp(), "/api/foodcasts/stats", { openid: "openid-other" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, stats: { availableCount: 0 } });
});

test("owned custom foodcast APIs never accept caller identity or expose another owner's device", async () => {
  const calls = [];
  setCustomFoodcastService({
    async listMaterials(input) {
      calls.push(input);
      return [{ id: "m1", previewUrl: "https://media.test/m1" }];
    },
    async create(input) {
      calls.push(input);
      return { id: "custom-1" };
    },
    async processJob() {},
    async getPublicJob({ ownerOpenid, jobId }) {
      return ownerOpenid === "openid-owner"
        ? { id: jobId, deviceSn: "SN001", status: "queued" }
        : null;
    },
  });
  const app = makeApp();

  const materials = await request(app, "/api/foodcasts/materials?deviceSn=SN001");
  const forbidden = await request(app, "/api/foodcasts/materials?deviceSn=SN001", { openid: "openid-other" });
  const created = await request(app, "/api/foodcasts/custom", {
    method: "POST",
    body: {
      ownerOpenid: "attacker",
      deviceSn: "SN001",
      fileId: "cloud://attacker/file.mp4",
      segments: [{ materialId: "m1", trimStartSec: 0, trimEndSec: 5, url: "https://attacker.test" }],
      frameMode: "source",
      bgmId: "bgm-02",
      bgmVolume: 0.6,
    },
  });

  assert.equal(materials.statusCode, 200);
  assert.equal(forbidden.statusCode, 404);
  assert.equal(created.statusCode, 202);
  assert.equal(calls[0].ownerOpenid, "openid-owner");
  assert.equal(calls[1].ownerOpenid, "openid-owner");
  assert.equal(Object.hasOwn(calls[1], "fileId"), false);
  assert.deepEqual(calls[1].segments, [{ materialId: "m1", trimStartSec: 0, trimEndSec: 5 }]);
});

test("foodcast APIs create jobs, expose status, and restore the latest job", async () => {
  const calls = [];
  const jobs = {
    "job-1": { id: "job-1", deviceSn: "SN001", status: "queued" },
  };
  setFoodcastService({
    async createFoodcast(input) {
      calls.push(input);
      return jobs["job-1"];
    },
    getJob(id) {
      return jobs[id] || null;
    },
    getLatest(input) {
      calls.push({ latest: input });
      return jobs["job-1"];
    },
    getPublicJob(id, baseUrl) {
      const job = jobs[id];
      return job ? { ...job, mediaBaseUrl: baseUrl } : null;
    },
  });
  const app = makeApp();

  const created = await request(app, "/api/foodcasts", {
    method: "POST",
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "cat.example.test" },
    body: {
      deviceSn: "SN001", date: "2026-07-16", scope: "day", mode: "quick_cut",
      frameMode: "center_crop", targetDurationSec: 20, bgmId: "bgm-01",
    },
  });
  const status = await request(app, "/api/foodcasts/job-1");
  const forbiddenStatus = await request(app, "/api/foodcasts/job-1", {
    openid: "openid-other",
  });
  const latest = await request(app, "/api/foodcasts/latest?deviceSn=SN001&date=2026-07-16&scope=day&mode=quick_cut&frameMode=center_crop&targetDurationSec=20&bgmId=bgm-02");

  assert.equal(created.statusCode, 202);
  assert.equal(created.body.job.id, "job-1");
  assert.equal(created.body.job.mediaBaseUrl, "https://cat.example.test");
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.job.id, "job-1");
  assert.equal(forbiddenStatus.statusCode, 404);
  assert.equal(forbiddenStatus.body.error, "DEVICE_NOT_FOUND");
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.body.job.id, "job-1");
  assert.deepEqual(calls[0], {
    deviceSn: "SN001", date: "2026-07-16", scope: "day", mealId: "", mode: "quick_cut",
    frameMode: "center_crop", targetDurationSec: 20, bgmId: "bgm-01",
  });
  assert.equal(calls[1].latest.mode, "quick_cut");
  assert.equal(calls[1].latest.frameMode, "center_crop");
  assert.equal(calls[1].latest.targetDurationSec, "20");
  assert.equal(calls[1].latest.bgmId, "bgm-02");
});

test("Cloud Hosting uses the configured public URL instead of an internal forwarded host for media", async () => {
  const previousCloudHosting = config.cloudHosting;
  const previousPublicBaseUrl = config.publicBaseUrl;
  config.cloudHosting = true;
  config.publicBaseUrl = "https://cat-camera.example.com";

  try {
    setFoodcastService({
      async createFoodcast() {
        return { id: "job-cloud", status: "queued" };
      },
      getPublicJob(id, baseUrl) {
        return { id, mediaBaseUrl: baseUrl };
      },
    });

    const response = await request(makeApp(), "/api/foodcasts", {
      method: "POST",
      headers: {
        "x-forwarded-proto": "http",
        "x-forwarded-host": "10.0.0.8:3000",
      },
      body: { deviceSn: "SN001", date: "2026-07-22" },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.body.job.mediaBaseUrl, "https://cat-camera.example.com");
  } finally {
    config.cloudHosting = previousCloudHosting;
    config.publicBaseUrl = previousPublicBaseUrl;
  }
});

test("foodcast create maps an empty quick cut to a user-correctable response", async () => {
  setFoodcastService({
    async createFoodcast() {
      const error = new Error("NO_CUTE_HIGHLIGHTS");
      error.code = "NO_CUTE_HIGHLIGHTS";
      throw error;
    },
  });

  const response = await request(makeApp(), "/api/foodcasts", {
    method: "POST",
    body: { deviceSn: "SN001", date: "2026-07-16", scope: "day", mode: "quick_cut" },
  });

  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.body, { ok: false, error: "NO_CUTE_HIGHLIGHTS" });
});

test("foodcast create maps insufficient cute material to a user-correctable response", async () => {
  setFoodcastService({
    async createFoodcast() {
      const error = new Error("NO_CUTE_MATERIAL");
      error.code = "NO_CUTE_MATERIAL";
      throw error;
    },
  });

  const response = await request(makeApp(), "/api/foodcasts", {
    method: "POST",
    body: { deviceSn: "SN001", date: "2026-07-16", mode: "quick_cut", targetDurationSec: 120 },
  });

  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.body, { ok: false, error: "NO_CUTE_MATERIAL" });
});

test("foodcast APIs map service validation failures to the standard response", async () => {
  const rejectInvalidTarget = () => {
    const error = new Error("INVALID_FOODCAST_REQUEST");
    error.code = "INVALID_FOODCAST_REQUEST";
    throw error;
  };
  setFoodcastService({ createFoodcast: rejectInvalidTarget, getLatest: rejectInvalidTarget });

  const created = await request(makeApp(), "/api/foodcasts", {
    method: "POST",
    body: { deviceSn: "SN001", date: "2026-07-16", mode: "quick_cut", targetDurationSec: 45 },
  });
  const latest = await request(
    makeApp(),
    "/api/foodcasts/latest?deviceSn=SN001&date=2026-07-16&mode=quick_cut&targetDurationSec=45"
  );

  assert.equal(created.statusCode, 400);
  assert.deepEqual(created.body, { ok: false, error: "INVALID_FOODCAST_REQUEST" });
  assert.equal(latest.statusCode, 400);
  assert.deepEqual(latest.body, { ok: false, error: "INVALID_FOODCAST_REQUEST" });
});

test("foodcast create maps library errors without exposing internals", async () => {
  setFoodcastService({
    async createFoodcast() {
      const error = new Error("private path C:/music");
      error.code = "BGM_LIBRARY_EMPTY";
      throw error;
    },
  });

  const response = await request(makeApp(), "/api/foodcasts", {
    method: "POST",
    body: { deviceSn: "SN001", date: "2026-07-16", scope: "day" },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { ok: false, error: "BGM_LIBRARY_EMPTY" });
});

test("foodcast BGM list returns safe metadata with absolute preview URLs", async () => {
  setFoodcastService({
    listBgmTracks(baseUrl) {
      assert.equal(baseUrl, "https://cat.example.test");
      return [{
        id: "bgm-01",
        title: "One",
        artist: "Artist",
        licenseSource: "Licensed",
        previewUrl: `${baseUrl}/api/foodcasts/bgm/bgm-01/audio`,
      }];
    },
    getJob() {
      throw new Error("BGM list must be registered before the job route");
    },
  });

  const response = await request(makeApp(), "/api/foodcasts/bgm", {
    headers: {
      "x-forwarded-proto": " https, http ",
      "x-forwarded-host": " cat.example.test, proxy.internal ",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    tracks: [{
      id: "bgm-01",
      title: "One",
      artist: "Artist",
      licenseSource: "Licensed",
      previewUrl: "https://cat.example.test/api/foodcasts/bgm/bgm-01/audio",
    }],
  });
  assert.equal(response.body.tracks[0].filePath, undefined);
});

test("foodcast BGM audio endpoint streams full and ranged previews", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-route-bgm-"));
  const filePath = path.join(dir, "bgm-01.m4a");
  fs.writeFileSync(filePath, "0123456789");
  setFoodcastService({
    resolveBgmPreview(id) {
      assert.equal(id, "bgm-01");
      return filePath;
    },
  });
  const app = makeApp();

  const full = await request(app, "/api/foodcasts/bgm/bgm-01/audio");
  const ranged = await request(app, "/api/foodcasts/bgm/bgm-01/audio", {
    headers: { Range: "bytes=2-5" },
  });

  assert.equal(full.statusCode, 200);
  assert.equal(full.raw, "0123456789");
  assert.equal(full.headers["content-type"], "audio/mp4");
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.equal(full.headers["content-length"], "10");
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.raw, "2345");
  assert.equal(ranged.headers["content-type"], "audio/mp4");
  assert.equal(ranged.headers["accept-ranges"], "bytes");
  assert.equal(ranged.headers["content-range"], "bytes 2-5/10");
  assert.equal(ranged.headers["content-length"], "4");
});

test("foodcast BGM audio endpoint rejects invalid ranges", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-route-bgm-range-"));
  const filePath = path.join(dir, "bgm-01.m4a");
  fs.writeFileSync(filePath, "0123456789");
  setFoodcastService({ resolveBgmPreview: () => filePath });

  const cases = [
    { range: "bytes=-4", status: 206, body: "6789", contentRange: "bytes 6-9/10" },
    { range: "bytes=-10", status: 206, body: "0123456789", contentRange: "bytes 0-9/10" },
    { range: "bytes=5-999", status: 206, body: "56789", contentRange: "bytes 5-9/10" },
    { range: "bytes=4-", status: 206, body: "456789", contentRange: "bytes 4-9/10" },
    { range: "bytes=-0", status: 416, body: "", contentRange: "bytes */10" },
    { range: "bytes=-", status: 416, body: "", contentRange: "bytes */10" },
    { range: "bytes=10-20", status: 416, body: "", contentRange: "bytes */10" },
    { range: "bytes=0-1,4-5", status: 416, body: "", contentRange: "bytes */10" },
  ];

  const responses = await Promise.all(cases.map(({ range }) => request(
    makeApp(),
    "/api/foodcasts/bgm/bgm-01/audio",
    { headers: { Range: range } }
  )));

  responses.forEach((response, index) => {
    const expected = cases[index];
    assert.equal(response.statusCode, expected.status, expected.range);
    assert.equal(response.raw, expected.body, expected.range);
    assert.equal(response.headers["content-range"], expected.contentRange, expected.range);
    assert.equal(response.headers["content-type"], "audio/mp4", expected.range);
    if (expected.status === 206) {
      assert.equal(response.headers["content-length"], String(expected.body.length), expected.range);
    }
  });
});

test("foodcast range streaming handles empty files safely", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-route-bgm-empty-"));
  const filePath = path.join(dir, "empty.m4a");
  fs.writeFileSync(filePath, "");
  setFoodcastService({ resolveBgmPreview: () => filePath });

  const [full, ranged] = await Promise.all([
    request(makeApp(), "/api/foodcasts/bgm/empty/audio"),
    request(makeApp(), "/api/foodcasts/bgm/empty/audio", {
      headers: { Range: "bytes=0-" },
    }),
  ]);

  assert.equal(full.statusCode, 200);
  assert.equal(full.raw, "");
  assert.equal(full.headers["content-length"], "0");
  assert.equal(ranged.statusCode, 416);
  assert.equal(ranged.headers["content-range"], "bytes */0");
});

test("foodcast BGM previews use extension-specific content types", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-route-bgm-types-"));
  const files = {
    m4a: path.join(dir, "track.m4a"),
    mp3: path.join(dir, "track.mp3"),
    wav: path.join(dir, "track.wav"),
    bin: path.join(dir, "track.bin"),
  };
  Object.values(files).forEach((filePath) => fs.writeFileSync(filePath, "audio"));
  setFoodcastService({ resolveBgmPreview: (id) => files[id] });

  const ids = Object.keys(files);
  const responses = await Promise.all(ids.map((id) => (
    request(makeApp(), `/api/foodcasts/bgm/${id}/audio`)
  )));

  assert.deepEqual(
    responses.map((response) => response.headers["content-type"]),
    ["audio/mp4", "audio/mpeg", "audio/wav", "application/octet-stream"]
  );
});

test("foodcast streaming returns a standard error when opening the file throws", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-route-bgm-open-error-"));
  const filePath = path.join(dir, "track.m4a");
  fs.writeFileSync(filePath, "audio");
  setFoodcastService({ resolveBgmPreview: () => filePath });
  const originalCreateReadStream = fs.createReadStream;
  t.after(() => {
    fs.createReadStream = originalCreateReadStream;
  });
  fs.createReadStream = () => {
    throw Object.assign(new Error("forced open failure"), { code: "READ_FAILED" });
  };

  const response = await request(makeApp(), "/api/foodcasts/bgm/error/audio");

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { ok: false, error: "READ_FAILED" });
});

test("foodcast streaming handles asynchronous read errors after headers are sent", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-route-bgm-read-error-"));
  const filePath = path.join(dir, "track.m4a");
  fs.writeFileSync(filePath, "audio");
  setFoodcastService({ resolveBgmPreview: () => filePath });
  const originalCreateReadStream = fs.createReadStream;
  t.after(() => {
    fs.createReadStream = originalCreateReadStream;
  });
  fs.createReadStream = () => {
    const stream = new PassThrough();
    setImmediate(() => stream.destroy(Object.assign(
      new Error("forced async read failure"),
      { code: "EIO" }
    )));
    return stream;
  };

  await assert.rejects(
    request(makeApp(), "/api/foodcasts/bgm/error/audio"),
    /response aborted|socket hang up/
  );
});

test("foodcast BGM audio endpoint maps unknown tracks to 404", async () => {
  setFoodcastService({
    resolveBgmPreview() {
      throw Object.assign(new Error("private catalog path"), { code: "BGM_NOT_FOUND" });
    },
  });

  const response = await request(makeApp(), "/api/foodcasts/bgm/missing/audio");

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { ok: false, error: "BGM_NOT_FOUND" });
});

test("foodcast video endpoint validates its token through the service and supports byte ranges", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-route-media-"));
  const filePath = path.join(dir, "job-1.mp4");
  fs.writeFileSync(filePath, "0123456789");
  setFoodcastService({
    resolveMedia(id, token) {
      assert.equal(id, "job-1");
      assert.equal(token, "media-token");
      return filePath;
    },
  });

  const response = await request(makeApp(), "/api/foodcasts/job-1/video?token=media-token", {
    headers: { Range: "bytes=2-5" },
  });

  assert.equal(response.statusCode, 206);
  assert.equal(response.raw, "2345");
  assert.equal(response.headers["content-range"], "bytes 2-5/10");
  assert.equal(response.headers["accept-ranges"], "bytes");
  assert.equal(response.headers["content-type"], "video/mp4");
  assert.equal(response.headers["content-length"], "4");
  assert.equal(response.headers["cache-control"], "private, max-age=300");
});

test("live recording APIs recover owned status without exposing storage fields", async () => {
  const mediaPath = path.join(registryDir, "live-recording.mp4");
  fs.writeFileSync(mediaPath, "0123456789");
  const jobs = [
    {
      id: "live-record-1",
      ownerOpenid: "openid-owner",
      deviceSn: "SN001",
      status: "ready",
      accessToken: "record-token",
      fileId: "cloud://private-file-id",
      outputSize: 10,
      durationSec: 8,
      createdAt: 100,
      updatedAt: 108,
      expiresAt: 999,
    },
    {
      id: "live-record-other",
      ownerOpenid: "openid-other",
      deviceSn: "SN001",
      status: "ready",
      accessToken: "other-token",
      fileId: "cloud://other-private-file-id",
      createdAt: 90,
      updatedAt: 99,
    },
  ];
  setLiveRecordingServiceForTests({
    store: {
      async findLatest(openid, deviceSn) {
        return jobs.find((job) => job.ownerOpenid === openid && job.deviceSn === deviceSn) || null;
      },
      async getOwnedJob(openid, id) {
        return jobs.find((job) => job.ownerOpenid === openid && job.id === id) || null;
      },
      async getJob(id) {
        return jobs.find((job) => job.id === id) || null;
      },
    },
    mediaStorage: {
      async getReadUrl(fileId) {
        assert.equal(fileId, "cloud://private-file-id");
        return mediaPath;
      },
    },
  });
  const app = makeApp();

  const latest = await request(app, "/api/devices/SN001/live-recordings/latest");
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.body.recording.id, "live-record-1");
  assert.equal(latest.body.recording.accessToken, "record-token");
  assert.equal(latest.body.recording.fileId, undefined);
  assertNoSecrets(latest.body);

  const status = await request(app, "/api/live-recordings/live-record-1");
  assert.equal(status.statusCode, 200);
  assert.match(status.body.recording.videoUrl, /live-record-1\/video\?token=record-token$/);
  assert.equal(status.body.recording.ownerOpenid, undefined);
  assert.equal(status.body.recording.fileId, undefined);

  const invite = await request(app, "/api/devices/SN001/share-invites", {
    method: "POST",
    openid: "openid-owner",
  });
  await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-member",
    body: { token: invite.body.invite.token },
  });
  const sharedStatus = await request(app, "/api/live-recordings/live-record-1", {
    openid: "openid-member",
  });
  assert.equal(sharedStatus.statusCode, 200);
  assert.match(sharedStatus.body.recording.videoUrl, /live-record-1\/video\?token=record-token$/);

  assert.equal((await request(app, "/api/live-recordings/missing")).statusCode, 404);
  assert.equal((await request(app, "/api/live-recordings/live-record-other")).statusCode, 404);
  assert.equal((await request(app, "/api/devices/SN001/live-recordings/latest", {
    openid: "openid-other",
  })).statusCode, 404);

  const wrongToken = await request(
    app,
    "/api/live-recordings/live-record-1/video?token=wrong-token",
    { auth: false }
  );
  assert.equal(wrongToken.statusCode, 404);

  const full = await request(
    app,
    "/api/live-recordings/live-record-1/video?token=record-token",
    { auth: false }
  );
  assert.equal(full.statusCode, 200);
  assert.equal(full.raw, "0123456789");
  assert.equal(full.headers["content-type"], "video/mp4");

  const ranged = await request(
    app,
    "/api/live-recordings/live-record-1/video?token=record-token",
    { auth: false, headers: { Range: "bytes=2-5" } }
  );
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.raw, "2345");
  assert.equal(ranged.headers["content-range"], "bytes 2-5/10");
});

test("POST /api/auth/wechat-login exchanges a code and ignores forged identity headers", async () => {
  setWechatLoginServiceForTests({
    async exchange(code) {
      assert.equal(code, "one-time-code");
      return { openid: "openid-owner", unionid: "" };
    },
  });
  const res = await request(makeApp(), "/api/auth/wechat-login", {
    method: "POST",
    headers: { "x-wx-openid": "openid-owner", "x-wx-source": "wx_client" },
    body: {
      openid: "openid-attacker",
      code: "one-time-code",
      nickname: "Mimi",
      avatar: "https://example.test/cat.png",
      adminToken: "admin-token",
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.doesNotMatch(res.body.sessionToken, /openid-owner|openid-attacker/);
  assert.equal(testSessions.verify(res.body.sessionToken, "openid-owner").openid, "openid-owner");
  assert.deepEqual(res.body.user, {
    id: "openid-owner",
    openid: "openid-owner",
    nickname: "Mimi",
    avatar: "https://example.test/cat.png",
  });
  assert.match(res.headers["x-bobbo-request-id"], /^[A-Za-z0-9_-]{8,80}$/);
  const auditText = fs.readFileSync(process.env.ACCOUNT_SYNC_AUDIT_FILE, "utf8");
  assert.match(auditText, /wechat_login_received/);
  assert.match(auditText, /wechat_login_succeeded/);
  assert.doesNotMatch(auditText, /one-time-code|openid-owner|openid-attacker|admin-token/);
  assertNoSecrets(res.body);
});

test("POST /api/auth/wechat-login audits provider failures without persisting credentials", async () => {
  setWechatLoginServiceForTests({
    async exchange(code) {
      assert.equal(code, "expired-one-time-code");
      const error = new Error("provider rejected the credential");
      error.code = "WECHAT_LOGIN_PROVIDER_ERROR";
      error.providerCode = 40029;
      throw error;
    },
  });
  const requestId = "login_failure_12345678";
  const res = await request(makeApp(), "/api/auth/wechat-login", {
    method: "POST",
    auth: false,
    headers: { "x-bobbo-request-id": requestId },
    body: {
      code: "expired-one-time-code",
      openid: "forged-openid",
      sessionToken: "forged-session-token",
    },
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.headers["x-bobbo-request-id"], requestId);
  const auditText = fs.readFileSync(process.env.ACCOUNT_SYNC_AUDIT_FILE, "utf8");
  assert.match(auditText, /wechat_login_received/);
  assert.match(auditText, /wechat_login_failed/);
  assert.match(auditText, /WECHAT_LOGIN_PROVIDER_ERROR_40029/);
  assert.doesNotMatch(auditText, /expired-one-time-code|forged-openid|forged-session-token/);
});

test("family share invite is single-use and shared member can access but cannot unbind", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const app = makeApp();
  const created = await request(app, "/api/devices/SN001/share-invites", {
    method: "POST",
    openid: "openid-owner",
  });
  assert.equal(created.statusCode, 201);
  assert.ok(created.body.invite.token);
  assert.equal(created.body.invite.expiresAt > Date.now(), true);

  const redeemed = await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-member",
    body: { token: created.body.invite.token },
  });
  assert.equal(redeemed.statusCode, 200);
  assert.equal(redeemed.body.device.role, "member");

  const repeated = await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-member",
    body: { token: created.body.invite.token },
  });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.body.device.role, "member");

  const sharing = await request(app, "/api/devices/SN001/sharing", { openid: "openid-owner" });
  assert.equal(sharing.body.members.length, 1);

  const duplicate = await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-other",
    body: { token: created.body.invite.token },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.error, "SHARE_INVITE_USED");

  const list = await request(app, "/api/devices", { openid: "openid-member" });
  assert.equal(list.body.devices[0].sn, "SN001");
  assert.equal(list.body.devices[0].role, "member");
  assert.equal(list.body.devices[0].token, undefined);
  assert.equal(list.body.devices[0].deviceToken, undefined);
  assert.equal(list.body.devices[0].permissions.includes("talkback"), true);
  assert.equal(list.body.devices[0].permissions.includes("settings"), false);

  const unbind = await request(app, "/api/devices/SN001", {
    method: "DELETE",
    openid: "openid-member",
  });
  assert.equal(unbind.statusCode, 404);
});

test("shared member receives an access-gated direct live token without backend device login", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const app = makeApp();
  const created = await request(app, "/api/devices/SN001/share-invites", {
    method: "POST",
    openid: "openid-owner",
  });
  await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-member",
    body: { token: created.body.invite.token },
  });

  let tokenCalls = 0;
  let loginCalls = 0;
  await withMockedDevice(
    {
      getToken: async function getToken() {
        tokenCalls += 1;
        this.deviceToken = "shared-direct-device-token";
        return this.deviceToken;
      },
      login: async function login() {
        loginCalls += 1;
        throw new Error("direct live access must not log in through the backend");
      },
    },
    async () => {
      const granted = await request(app, "/api/devices/SN001/direct-live-access", {
        method: "POST",
        openid: "openid-member",
      });
      assert.equal(granted.statusCode, 200);
      assert.equal(granted.body.ok, true);
      assert.equal(granted.body.deviceToken, "shared-direct-device-token");
      assert.equal(tokenCalls, 1);
      assert.equal(loginCalls, 0);

      const stranger = await request(app, "/api/devices/SN001/direct-live-access", {
        method: "POST",
        openid: "openid-other",
      });
      assert.equal(stranger.statusCode, 404);
      assert.equal(stranger.body.error, "DEVICE_NOT_FOUND");

      await request(app, "/api/devices/SN001/members/openid-member", {
        method: "DELETE",
        openid: "openid-owner",
      });
      const revoked = await request(app, "/api/devices/SN001/direct-live-access", {
        method: "POST",
        openid: "openid-member",
      });
      assert.equal(revoked.statusCode, 404);
      assert.equal(revoked.body.error, "DEVICE_NOT_FOUND");
    }
  );

  const auditText = fs.readFileSync(process.env.ACCOUNT_SYNC_AUDIT_FILE, "utf8");
  assert.match(auditText, /direct_live_access_granted/);
  assert.match(auditText, /direct_live_access_denied/);
  assert.doesNotMatch(auditText, /shared-direct-device-token/);
});

test("targeted live playback diagnostics derive account role and never persist client secrets", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const app = makeApp();
  const created = await request(app, "/api/devices/SN001/share-invites", {
    method: "POST",
    openid: "openid-owner",
  });
  await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-member",
    body: { token: created.body.invite.token },
  });

  const ownerList = await request(app, "/api/devices", { openid: "openid-owner" });
  const memberList = await request(app, "/api/devices", { openid: "openid-member" });
  assert.equal(ownerList.body.devices[0].liveDiagnosticsEnabled, true);
  assert.equal(memberList.body.devices[0].liveDiagnosticsEnabled, true);

  const sessionId = "live_diag_member_12345678";
  const reported = await request(app, "/api/devices/SN001/live-playback-events", {
    method: "POST",
    openid: "openid-member",
    body: {
      sessionId,
      event: "device_login_failed",
      source: "sdk",
      errorCode: "4101",
      token: "raw-device-token-must-not-be-logged",
      url: "https://secret.example/live.m3u8",
      openid: "spoofed-owner",
      role: "owner",
    },
  });
  assert.equal(reported.statusCode, 204);

  const stranger = await request(app, "/api/devices/SN001/live-playback-events", {
    method: "POST",
    openid: "openid-other",
    body: { sessionId: "live_diag_other_12345678", event: "video_play", source: "player" },
  });
  assert.equal(stranger.statusCode, 404);

  const invalid = await request(app, "/api/devices/SN001/live-playback-events", {
    method: "POST",
    openid: "openid-member",
    body: { sessionId, event: "dump_token", source: "sdk" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, "LIVE_PLAYBACK_EVENT_INVALID");

  const auditText = fs.readFileSync(process.env.ACCOUNT_SYNC_AUDIT_FILE, "utf8");
  assert.match(auditText, /live_playback_device_login_failed/);
  assert.match(auditText, /member-sdk/);
  assert.match(auditText, /"errorCode":"4101"/);
  assert.doesNotMatch(auditText, /raw-device-token|secret\.example|spoofed-owner|openid-member/);
});

test("family share redeem failures are audited without exposing the invite token", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const app = makeApp();
  const token = "missing-share-token-1234567890";
  const response = await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-member",
    body: { token },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error, "SHARE_INVITE_NOT_FOUND");
  const auditText = fs.readFileSync(process.env.ACCOUNT_SYNC_AUDIT_FILE, "utf8");
  assert.match(auditText, /share_invite_redeem_failed/);
  assert.match(auditText, /SHARE_INVITE_NOT_FOUND/);
  assert.doesNotMatch(auditText, new RegExp(token));
});

test("owner can list and revoke a shared family member", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const app = makeApp();
  const created = await request(app, "/api/devices/SN001/share-invites", {
    method: "POST",
    openid: "openid-owner",
  });
  await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-member",
    body: { token: created.body.invite.token },
  });

  const sharing = await request(app, "/api/devices/SN001/sharing", { openid: "openid-owner" });
  assert.equal(sharing.statusCode, 200);
  assert.equal(sharing.body.members[0].openid, "openid-member");

  const revoked = await request(app, "/api/devices/SN001/members/openid-member", {
    method: "DELETE",
    openid: "openid-owner",
  });
  assert.equal(revoked.statusCode, 200);
  const memberList = await request(app, "/api/devices", { openid: "openid-member" });
  assert.deepEqual(memberList.body.devices, []);
  const oldInvite = await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-member",
    body: { token: created.body.invite.token },
  });
  assert.equal(oldInvite.statusCode, 409);
  assert.equal(oldInvite.body.error, "SHARE_INVITE_USED");
});

test("cat profiles sync to the backend and shared members receive assigned read-only profiles", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const app = makeApp();
  const imported = await request(app, "/api/cats/import", {
    method: "POST",
    openid: "openid-owner",
    body: { cats: [{
      id: "xiaobu",
      name: "小布",
      avatar: "https://expired-tunnel.trycloudflare.com/media/cat-avatars/xiaobu.jpg",
      health: "过敏",
    }] },
  });
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.body.cats[0].name, "小布");
  assert.match(imported.body.cats[0].avatar, /^http:\/\/127\.0\.0\.1:\d+\/media\/cat-avatars\/xiaobu\.jpg$/);
  const assigned = await request(app, "/api/devices/SN001/primary-cat", {
    method: "PUT",
    openid: "openid-owner",
    body: { catId: "xiaobu" },
  });
  assert.equal(assigned.statusCode, 200);

  const invite = await request(app, "/api/devices/SN001/share-invites", {
    method: "POST",
    openid: "openid-owner",
  });
  await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-member",
    body: { token: invite.body.invite.token },
  });
  const sharedCats = await request(app, "/api/cats", { openid: "openid-member" });
  assert.equal(sharedCats.body.cats[0].id, "xiaobu");
  assert.equal(sharedCats.body.cats[0].readOnly, true);
  assert.equal(sharedCats.body.cats[0].source, "shared");
  assert.match(sharedCats.body.cats[0].catRef, /^cat_[a-f0-9]{24}$/);
  assert.equal(sharedCats.body.cats[0].ownerOpenid, undefined);
  assert.match(sharedCats.body.cats[0].avatar, /^http:\/\/127\.0\.0\.1:\d+\/media\/cat-avatars\/xiaobu\.jpg$/);

  const ownImport = await request(app, "/api/cats/import", {
    method: "POST",
    openid: "openid-member",
    body: { cats: [{ id: "member-cat", name: "自己的猫", avatar: "https://example.test/member-cat.jpg" }] },
  });
  assert.equal(ownImport.statusCode, 200);
  assert.deepEqual(ownImport.body.cats.map((cat) => [cat.name, cat.source, cat.readOnly]), [
    ["自己的猫", "owned", false],
    ["小布", "shared", true],
  ]);
});

test("POST /api/auth/wechat-login preserves an existing profile when fields are omitted", async () => {
  const app = makeApp();
  const saved = await request(app, "/api/profile", {
    method: "PATCH",
    body: { nickname: "陈柏希", avatar: "https://example.test/avatar.jpg" },
  });
  assert.equal(saved.statusCode, 200);

  setWechatLoginServiceForTests({
    async exchange(code) {
      assert.equal(code, "repeat-login-code");
      return { openid: "openid-owner" };
    },
  });
  const loggedIn = await request(app, "/api/auth/wechat-login", {
    method: "POST",
    auth: false,
    body: { code: "repeat-login-code" },
  });

  assert.equal(loggedIn.statusCode, 200);
  assert.equal(loggedIn.body.user.nickname, "陈柏希");
  assert.equal(loggedIn.body.user.avatar, "https://example.test/avatar.jpg");
});

test("profile ignores local-only avatar paths and accepts a persisted replacement", async () => {
  const app = makeApp();
  const localOnly = await request(app, "/api/profile", {
    method: "PATCH",
    body: { nickname: "陈柏希", avatar: "wxfile://store/avatar.jpg" },
  });
  assert.equal(localOnly.statusCode, 200);
  assert.equal(localOnly.body.profile.avatar, "");

  const fetched = await request(app, "/api/profile");
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.body.profile.avatar, "");

  const persisted = await request(app, "/api/profile", {
    method: "PATCH",
    body: { avatar: "https://example.test/persisted-avatar.jpg" },
  });
  assert.equal(persisted.statusCode, 200);
  assert.equal(persisted.body.profile.avatar, "https://example.test/persisted-avatar.jpg");
});

test("POST /api/auth/wechat-login rejects a missing one-time code", async () => {
  setWechatLoginServiceForTests({
    async exchange(code) {
      if (!code) {
        const error = new Error("WECHAT_LOGIN_CODE_REQUIRED");
        error.code = "WECHAT_LOGIN_CODE_REQUIRED";
        throw error;
      }
      return { openid: "openid-owner" };
    },
  });
  const res = await request(makeApp(), "/api/auth/wechat-login", {
    method: "POST",
    auth: false,
    body: { nickname: "Mimi" },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "WECHAT_LOGIN_CODE_REQUIRED");
});

test("self-hosted profile, feedback, and covers stay isolated by signed session", async () => {
  const profile = await request(makeApp(), "/api/profile", {
    method: "PATCH",
    body: { nickname: "布丁", avatar: "avatar.jpg" },
  });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.body.profile.nickname, "布丁");

  const feedback = await request(makeApp(), "/api/feedback", {
    method: "POST",
    body: { type: "建议", content: "希望增加提醒", deviceSn: "SN001" },
  });
  assert.equal(feedback.statusCode, 201);

  const saved = await request(makeApp(), "/api/device-covers", {
    method: "POST",
    body: {
      sn: "SN001",
      coverUrl: "https://example.test/owner.jpg",
      capturedAt: 1710000000000,
    },
  });
  assert.equal(saved.statusCode, 200);

  const ownerCovers = await request(makeApp(), "/api/device-covers?sns=SN001");
  const otherCovers = await request(makeApp(), "/api/device-covers?sns=SN001", {
    openid: "openid-other",
  });
  assert.equal(ownerCovers.body.coversBySn.SN001.coverUrl, "https://example.test/owner.jpg");
  assert.deepEqual(otherCovers.body.coversBySn, {});
});

test("GET /api/devices rejects anonymous requests", async () => {
  const res = await request(makeApp(), "/api/devices", { auth: false });

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { ok: false, error: "AUTH_REQUIRED" });
});

test("GET /api/devices returns the configured device without password fields", async () => {
  const res = await request(makeApp(), "/api/devices");

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.devices.length, 1);
  assert.equal(res.body.devices[0].sn, config.device.sn);
  assert.equal(res.body.devices[0].username, config.device.username);
  assert.equal(res.body.devices[0].password, undefined);
  assertNoSecrets(res.body);
});

test("GET /api/devices/:sn/token refreshes a temporary token only for the owner", async () => {
  let tokenCalls = 0;
  const app = makeApp();
  const result = await withMockedDevice(
    {
      ensureDeviceToken: async function ensureDeviceToken() {
        tokenCalls += 1;
        this.deviceToken = "refreshed-device-token";
        return this.deviceToken;
      },
    },
    async () => ({
      owner: await request(app, `/api/devices/${config.device.sn}/token`),
      other: await request(app, `/api/devices/${config.device.sn}/token`, { openid: "openid-other" }),
    })
  );

  assert.equal(result.owner.statusCode, 200);
  assert.deepEqual(result.owner.body, { ok: true, deviceToken: "refreshed-device-token" });
  assert.equal(result.other.statusCode, 404);
  assert.equal(result.other.body.error, "DEVICE_NOT_FOUND");
  assert.equal(tokenCalls, 1);
});

test("GET /api/devices/:sn/token reports JF 29013 as an other-account conflict", async () => {
  const response = await withMockedDevice(
    {
      ensureDeviceToken: async function ensureDeviceToken() {
        throw new Error('获取 token 失败: {"code":29013,"msg":"DEV_SUPPORT_TOKEN_ONLY_ONE_ACCOUNT_ADD"}');
      },
    },
    () => request(makeApp(), `/api/devices/${config.device.sn}/token`)
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, "DEVICE_ALREADY_BOUND_TO_OTHER_ACCOUNT");
  assert.equal(response.body.details.code, 29013);
  assert.equal(response.body.details.message, "设备已绑定到其他账户");
});

test("device list and status are isolated by WeChat owner", async () => {
  let statusCalls = 0;
  const [ownerList, otherList, otherStatus] = await withMockedDevice(
    {
      status: async () => {
        statusCalls += 1;
        return { status: "online" };
      },
    },
    () => Promise.all([
      request(makeApp(), "/api/devices", { openid: "openid-owner" }),
      request(makeApp(), "/api/devices", { openid: "openid-other" }),
      request(makeApp(), `/api/devices/${config.device.sn}/status`, { openid: "openid-other" }),
    ])
  );

  assert.deepEqual(ownerList.body.devices.map((item) => item.sn), [config.device.sn]);
  assert.deepEqual(otherList.body.devices, []);
  assert.equal(otherStatus.statusCode, 404);
  assert.equal(otherStatus.body.error, "DEVICE_NOT_FOUND");
  assert.equal(statusCalls, 0);
});

test("DELETE /api/devices/:sn removes only the owner's device and its cover", async () => {
  const app = makeApp();
  await request(app, "/api/device-covers", {
    method: "POST",
    body: { sn: config.device.sn, coverUrl: "https://example.test/latest.jpg" },
  });

  const forbidden = await request(app, `/api/devices/${config.device.sn}`, {
    method: "DELETE",
    openid: "openid-other",
  });
  assert.equal(forbidden.statusCode, 404);

  const removed = await request(app, `/api/devices/${config.device.sn}`, { method: "DELETE" });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.body, { ok: true, sn: config.device.sn });

  const devices = await request(app, "/api/devices");
  const covers = await request(app, `/api/device-covers?sns=${config.device.sn}`);
  assert.deepEqual(devices.body.devices, []);
  assert.deepEqual(covers.body.coversBySn, {});
});

test("PUT /api/devices/:sn/nickname persists the owner's nickname for owner and shared member views", async () => {
  const app = makeApp();
  const invite = await request(app, `/api/devices/${config.device.sn}/share-invites`, {
    method: "POST",
  });
  await request(app, "/api/share-invites/redeem", {
    method: "POST",
    openid: "openid-member",
    body: { token: invite.body.invite.token },
  });

  const renamed = await request(app, `/api/devices/${config.device.sn}/nickname`, {
    method: "PUT",
    headers: {
      "x-bobbo-request-id": "rename_test_12345678",
      "x-bobbo-sync-source": "device-manager",
    },
    body: { nickname: "  餐桌摄像头  " },
  });

  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.body.device.nickname, "餐桌摄像头");
  assert.equal(renamed.body.requestId, "rename_test_12345678");
  assertNoSecrets(renamed.body);
  const ownerList = await request(app, "/api/devices");
  const memberList = await request(app, "/api/devices", { openid: "openid-member" });
  assert.equal(ownerList.body.devices[0].nickname, "餐桌摄像头");
  assert.equal(memberList.body.devices[0].nickname, "餐桌摄像头");
  assert.equal(memberList.body.devices[0].role, "member");

  const auditText = fs.readFileSync(process.env.ACCOUNT_SYNC_AUDIT_FILE, "utf8");
  assert.match(auditText, /device_nickname_updated/);
  assert.match(auditText, /rename_test_12345678/);
  assert.doesNotMatch(auditText, /餐桌摄像头|openid-owner/);
});

test("PUT /api/devices/:sn/nickname rejects shared members and invalid nicknames", async () => {
  const app = makeApp();
  const initialNickname = (await request(app, "/api/devices")).body.devices[0].nickname;
  const forbidden = await request(app, `/api/devices/${config.device.sn}/nickname`, {
    method: "PUT",
    openid: "openid-other",
    body: { nickname: "Other name" },
  });
  const empty = await request(app, `/api/devices/${config.device.sn}/nickname`, {
    method: "PUT",
    body: { nickname: "   " },
  });
  const tooLong = await request(app, `/api/devices/${config.device.sn}/nickname`, {
    method: "PUT",
    body: { nickname: "x".repeat(81) },
  });

  assert.equal(forbidden.statusCode, 404);
  assert.equal(forbidden.body.error, "DEVICE_NOT_FOUND");
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.body.error, "DEVICE_NICKNAME_REQUIRED");
  assert.equal(tooLong.statusCode, 400);
  assert.equal(tooLong.body.error, "DEVICE_NICKNAME_TOO_LONG");
  assert.equal((await request(app, "/api/devices")).body.devices[0].nickname, initialNickname);
});

test("another WeChat user cannot take over an owned camera", async () => {
  let vendorCalls = 0;
  const response = await withMockedDevice(
    {
      ensureDeviceToken: async () => {
        vendorCalls += 1;
        return "should-not-be-issued";
      },
    },
    () => request(makeApp(), "/api/devices", {
      method: "POST",
      openid: "openid-other",
      body: { sn: config.device.sn, username: "admin" },
    })
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, "DEVICE_ALREADY_OWNED");
  assert.equal(vendorCalls, 0);
  assertNoSecrets(response.body);
});

test("POST /api/devices stores a nickname for the configured device without echoing adminToken", async () => {
  let bindChecked = false;
  const res = await withMockedDevice(
    {
      getToken: async function getToken() {
        bindChecked = true;
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
      bind: async function bind() {
        throw new Error("bind should not run when token already exists");
      },
    },
    () =>
      request(makeApp(), "/api/devices", {
        method: "POST",
        headers: {
          "x-bobbo-request-id": "bind_test_12345678",
          "x-bobbo-sync-source": "ble-pairing",
        },
        body: {
          sn: config.device.sn,
          username: config.device.username,
          password: "device-password",
          nickname: "Kitchen cam",
          adminToken: "admin-token",
        },
      })
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.device.sn, config.device.sn);
  assert.equal(res.body.device.nickname, "Kitchen cam");
  assert.equal(res.body.requestId, "bind_test_12345678");
  assert.equal(bindChecked, true);
  assertNoSecrets(res.body);
  const auditText = fs.readFileSync(process.env.ACCOUNT_SYNC_AUDIT_FILE, "utf8");
  assert.match(auditText, /device_bind_received/);
  assert.match(auditText, /device_bind_succeeded/);
  assert.match(auditText, /bind_test_12345678/);
  assert.doesNotMatch(auditText, /device-password|admin-token|openid-owner/);
});

test("an account without an owned device can save a private cat with a traceable request id", async () => {
  const response = await request(makeApp(), "/api/cats/private-cat-id", {
    method: "PUT",
    openid: "openid-without-device",
    headers: {
      "x-bobbo-request-id": "cat_test_12345678",
      "x-bobbo-sync-source": "cat-editor",
    },
    body: { name: "private-cat-name", avatar: "cloud://private/avatar.jpg" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.cat.name, "private-cat-name");
  assert.equal(response.body.cat.source, undefined);
  assert.equal(response.body.requestId, "cat_test_12345678");
  const auditText = fs.readFileSync(process.env.ACCOUNT_SYNC_AUDIT_FILE, "utf8");
  assert.match(auditText, /cat_save_succeeded/);
  assert.match(auditText, /cat_test_12345678/);
  assert.doesNotMatch(auditText, /private-cat-id|private-cat-name|openid-without-device/);
});

test("POST /api/devices records a newly bound SN and makes it active", async () => {
  const app = makeApp();
  const bindCalls = [];
  const bind = await withMockedDevice(
    {
      getToken: async function getToken() {
        bindCalls.push({
          sn: this.sn,
          username: this.username,
          password: this.password,
          nickname: this.nickname,
          ip: this.ip,
          port: this.port,
          adminToken: this.adminToken,
        });
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
      bind: async function bind() {
        throw new Error("bind should not run when token already exists");
      },
    },
    () =>
      request(app, "/api/devices", {
        method: "POST",
        body: {
          sn: "BLE-SN-002",
          username: "admin",
          password: "ble-password",
          nickname: "New BLE cam",
          adminToken: "admin-token",
          ip: "192.168.2.88",
          port: "",
        },
      })
  );

  assert.equal(bind.statusCode, 200);
  assert.equal(bind.body.ok, true);
  assert.equal(bind.body.device.sn, "BLE-SN-002");
  assert.equal(bind.body.device.nickname, "New BLE cam");
  assertNoSecrets(bind.body);
  assert.deepEqual(bindCalls[0], {
    sn: "BLE-SN-002",
    username: "admin",
    password: "ble-password",
    nickname: "New BLE cam",
    ip: "192.168.2.88",
    port: "",
    adminToken: "admin-token",
  });

  const devices = await request(app, "/api/devices");
  assert.equal(devices.statusCode, 200);
  assert.equal(devices.body.devices.length, 2);
  assert.equal(devices.body.devices[0].sn, "BLE-SN-002");
  assert.equal(devices.body.devices[0].active, true);
  assert.equal(devices.body.devices[0].username, "admin");
  assert.equal(devices.body.devices[1].sn, config.device.sn);
  assertNoSecrets(devices.body);
});

test("device registry persists active bound devices across a backend restart", async () => {
  const app = makeApp();
  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
      bind: async function bind() {
        throw new Error("bind should not run when token already exists");
      },
    },
    () =>
      request(app, "/api/devices", {
        method: "POST",
        body: {
          sn: "BLE-PERSIST-001",
          username: "admin",
          password: "",
          nickname: "Persisted cam",
          ip: "192.168.2.101",
        },
      })
  );

  resetDeviceStateForTests({ clearStore: false });

  const devices = await request(makeApp(), "/api/devices");
  assert.equal(devices.statusCode, 200);
  assert.equal(devices.body.devices.length, 2);
  assert.equal(devices.body.devices[0].sn, "BLE-PERSIST-001");
  assert.equal(devices.body.devices[0].nickname, "Persisted cam");
  assert.equal(devices.body.devices[0].active, true);
  assert.equal(devices.body.devices[0].password, undefined);
  assert.equal(devices.body.devices[0].adminToken, undefined);
});

test("POST /api/devices returns conflict and keeps the old active device when cloud binding is owned elsewhere", async () => {
  const app = makeApp();
  await withMockedDevice(
    {
      getToken: async function getToken() {
        if (this.sn === "ACTIVE-OK") {
          this.deviceToken = "token-active";
          return this.deviceToken;
        }
        throw new Error('获取 token 失败: {"code":29010,"msg":"DEV_NOTEXIT","data":[]}');
      },
      bind: async function bind() {
        throw new Error('设备绑定失败: {"code":29013,"msg":"DEV_SUPPORT_TOKEN_ONLY_ONE_ACCOUNT_ADD","data":"6a********************d4"}');
      },
    },
    async () => {
      const ok = await request(app, "/api/devices", {
        method: "POST",
        body: { sn: "ACTIVE-OK", username: "admin", password: "", nickname: "Active cam" },
      });
      assert.equal(ok.statusCode, 200);

      const rejected = await request(app, "/api/devices", {
        method: "POST",
        body: { sn: "TAKEN-SN", username: "admin", password: "", nickname: "Taken cam" },
      });

      assert.equal(rejected.statusCode, 409);
      assert.equal(rejected.body.ok, false);
      assert.equal(rejected.body.error, "DEVICE_ALREADY_BOUND_TO_OTHER_ACCOUNT");
      assertNoSecrets(rejected.body);

      const devices = await request(app, "/api/devices");
      assert.equal(devices.body.devices[0].sn, "ACTIVE-OK");
    }
  );
});

test("device APIs use the active bound device credentials instead of the .env fallback", async () => {
  const constructed = [];
  let bindCalls = 0;
  await withMockedDevice(
    {
      bind: async function bind() {
        bindCalls += 1;
      },
      getToken: async function getToken() {
        constructed.push({
          sn: this.sn,
          username: this.username,
          password: this.password,
          nickname: this.nickname,
          ip: this.ip,
          port: this.port,
          adminToken: this.adminToken,
        });
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
      login: async function login() {
        return { Ret: 100 };
      },
      getLivestreamUrl: async function getLivestreamUrl(protocol, channel, stream) {
        return `https://example.test/${this.sn}/${protocol}/${channel}/${stream}`;
      },
    },
    async () => {
      const app = makeApp();
      await request(app, "/api/devices", {
        method: "POST",
        body: {
          sn: "BLE-SN-003",
          username: "admin",
          password: "ble-password",
          nickname: "BLE cam",
          ip: "192.168.2.99",
          port: "",
          adminToken: "admin-token",
        },
      });

      const live = await request(app, "/api/devices/BLE-SN-003/livestream", {
        method: "POST",
        body: { mediaType: "hls", protocol: "ts", channel: 0, stream: "1" },
      });

      assert.equal(live.statusCode, 200);
      assert.equal(live.body.ok, true);
      assert.equal(live.body.url, "https://example.test/BLE-SN-003/hls-ts/0/1");
    }
  );

  assert.deepEqual(constructed[0], {
    sn: "BLE-SN-003",
    username: "admin",
    password: "ble-password",
    nickname: "BLE cam",
    ip: "192.168.2.99",
    port: "",
    adminToken: "admin-token",
  });
  assert.equal(bindCalls, 0);
});

test("feed analysis sync enqueues the active bound device instead of running analysis inline", async () => {
  const constructed = [];
  const enqueueCalls = [];
  let syncNowCalled = false;
  await withMockedDevice(
    {
      bind: async function bind() {
        throw new Error("bind should not run for the active token-backed device");
      },
      getToken: async function getToken() {
        constructed.push({
          sn: this.sn,
          username: this.username,
          password: this.password,
          nickname: this.nickname,
          ip: this.ip,
          port: this.port,
          adminToken: this.adminToken,
        });
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
      login: async function login() {
        return { Ret: 100 };
      },
    },
    async () => {
      const app = makeApp();
      await request(app, "/api/devices", {
        method: "POST",
        body: {
          sn: "BLE-SN-FEED",
          username: "admin",
          password: "",
          nickname: "Feed cam",
          ip: "192.168.2.44",
          adminToken: "admin-token",
        },
      });

      setFeedAnalysisCoordinator({
        store: {
          getDiary: () => null,
          getReplayMarkers: () => [
            {
              recordingKey: "2026-07-13 10:00:00__face.h264",
              markerType: "face_enter",
              offsetSec: 3,
            },
          ],
          listPendingNotifications: () => [],
          updateSettings: () => ({}),
        },
        enqueueDeviceDate(options) {
          enqueueCalls.push(options);
          return { ok: true, queued: true, jobKey: `${options.deviceSn}:${options.date}` };
        },
        async syncNow(options) {
          syncNowCalled = true;
          return { ok: true, processed: 0, records: 0, options };
        },
      });

      const sync = await request(app, "/api/feed-analysis/sync", {
        method: "POST",
        body: { deviceSn: "BLE-SN-FEED", date: "2026-07-13", force: true },
      });

      assert.equal(sync.statusCode, 200);
      assert.equal(sync.body.ok, true);
      assert.equal(sync.body.queued, true);
      assert.equal(sync.body.jobKey, "BLE-SN-FEED:2026-07-13");
      assert.equal(sync.body.markers, undefined);
    }
  );

  assert.equal(syncNowCalled, false);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].force, true);
  assert.equal(enqueueCalls[0].date, "2026-07-13");
  assert.equal(enqueueCalls[0].deviceSn, "BLE-SN-FEED");
  assert.equal(enqueueCalls[0].device.sn, "BLE-SN-FEED");
  assert.equal(enqueueCalls[0].device.deviceToken, "token-for-BLE-SN-FEED");
  assert.deepEqual(constructed[0], {
    sn: "BLE-SN-FEED",
    username: "admin",
    password: "",
    nickname: "Feed cam",
    ip: "192.168.2.44",
    port: "",
    adminToken: "admin-token",
  });
});

test("feeding detection setting keeps analysis and notification switches coupled", async () => {
  let storedSettings = {};
  const persisted = [];
  setFeedAnalysisCoordinator({
    store: {
      updateSettings(patch) {
        storedSettings = { ...storedSettings, ...patch };
        return { ...storedSettings };
      },
    },
    async persistSettings(settings) {
      persisted.push(settings);
      return settings;
    },
  });
  const app = makeApp();

  const enabled = await request(app, "/api/feed-analysis/settings", {
    method: "POST",
    body: {
      deviceSn: config.device.sn,
      feedingDetectionEnabled: true,
      analysisEnabled: false,
      notifyEnabled: false,
    },
  });

  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.body.settings.feedingDetectionEnabled, true);
  assert.equal(enabled.body.settings.analysisEnabled, true);
  assert.equal(enabled.body.settings.notifyEnabled, true);
  assert.equal(persisted[0].analysisEnabled, true);

  const disabled = await request(app, "/api/feed-analysis/settings", {
    method: "POST",
    body: {
      deviceSn: config.device.sn,
      feedingDetectionEnabled: false,
      analysisEnabled: true,
      notifyEnabled: true,
    },
  });

  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.body.settings.feedingDetectionEnabled, false);
  assert.equal(disabled.body.settings.analysisEnabled, false);
  assert.equal(disabled.body.settings.notifyEnabled, false);
  assert.equal(persisted[1].analysisEnabled, false);
});

test("feeding detection settings save and clear a device-specific ROI", async () => {
  const calls = [];
  let storedSettings = {};
  setFeedAnalysisCoordinator({
    store: {
      updateSettings(patch) {
        storedSettings = { ...storedSettings, ...patch };
        return { ...storedSettings };
      },
      setBowlRoi(deviceSn, bowlRoi) {
        calls.push([deviceSn, bowlRoi]);
        storedSettings = { ...storedSettings, bowlRoi };
        return { ...storedSettings };
      },
    },
  });
  const app = makeApp();

  const saved = await request(app, "/api/feed-analysis/settings", {
    method: "POST",
    body: {
      deviceSn: config.device.sn,
      feedingDetectionEnabled: true,
      bowlRoi: { x: 120.4, y: 240.6, width: 200, height: 160 },
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(calls[0], [config.device.sn, { x: 120, y: 241, width: 200, height: 160 }]);

  const cleared = await request(app, "/api/feed-analysis/settings", {
    method: "POST",
    body: {
      deviceSn: config.device.sn,
      feedingDetectionEnabled: true,
      bowlRoi: null,
    },
  });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(calls[1], [config.device.sn, null]);
});

test("feeding detection settings reject an invalid ROI", async () => {
  setFeedAnalysisCoordinator({
    store: {
      updateSettings: () => ({}),
      setBowlRoi() {
        throw new Error("should not store invalid ROI");
      },
    },
  });

  const response = await request(makeApp(), "/api/feed-analysis/settings", {
    method: "POST",
    body: {
      deviceSn: config.device.sn,
      feedingDetectionEnabled: true,
      bowlRoi: { x: -1, y: 20, width: 0, height: 90 },
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "BOWL_ROI_INVALID");
});

test("feeding detection allows the configured notification owner without a friend binding", async () => {
  let storedSettings = {};
  setFeedAnalysisCoordinator({
    store: {
      getPushPlusBinding() {
        return null;
      },
      updateSettings(patch) {
        storedSettings = { ...storedSettings, ...patch };
        return { ...storedSettings };
      },
    },
    canDeliverNotificationTo(openid) {
      return openid === "openid-owner";
    },
  });

  const response = await request(makeApp(), "/api/feed-analysis/settings", {
    method: "POST",
    body: {
      openid: "owner-openid",
      deviceSn: config.device.sn,
      feedingDetectionEnabled: true,
      requirePushPlusBinding: true,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.settings.feedingDetectionEnabled, true);
});

test("feed analysis sync can enqueue without requiring cloud device login", async () => {
  const enqueueCalls = [];
  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
      login: async function login() {
        throw new Error('设备登录失败: {"code":4101,"msg":"Device offline","data":null}');
      },
    },
    async () => {
      setFeedAnalysisCoordinator({
        store: {
          updateSettings: () => ({}),
        },
        enqueueDeviceDate(options) {
          enqueueCalls.push(options);
          return { ok: true, queued: true, jobKey: `${options.deviceSn}:${options.date}` };
        },
      });

      const res = await request(makeApp(), "/api/feed-analysis/sync", {
        method: "POST",
        body: { deviceSn: config.device.sn, date: "2026-07-14", force: true },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.queued, true);
      assert.equal(enqueueCalls.length, 1);
      assert.equal(enqueueCalls[0].device.deviceToken, `token-for-${config.device.sn}`);
    }
  );
});

test("feed analysis sync can enqueue one recording without scanning the full date", async () => {
  const enqueueCalls = [];
  const queuedRows = [];
  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
    },
    async () => {
      setFeedAnalysisCoordinator({
        store: {
          updateSettings: () => ({}),
          markRecordingQueued(row) {
            queuedRows.push(row);
          },
        },
        enqueueRecording(options) {
          enqueueCalls.push(options);
          return { ok: true, queued: true, taskKey: options.recordingKey };
        },
        enqueueDeviceDate() {
          throw new Error("full-date scan should not run");
        },
      });

      const recording = {
        beginTime: "2026-07-08 08:28:17",
        endTime: "2026-07-08 08:29:31",
        fileName: "/idea0/08.28.17-08.29.31.h264",
        durationSec: 74,
      };
      const response = await request(makeApp(), "/api/feed-analysis/sync", {
        method: "POST",
        body: {
          deviceSn: config.device.sn,
          date: "2026-07-08",
          force: true,
          recording,
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.queued, true);
      assert.equal(enqueueCalls.length, 1);
      assert.equal(enqueueCalls[0].force, true);
      assert.equal(enqueueCalls[0].deviceSn, config.device.sn);
      assert.equal(enqueueCalls[0].recording.beginTime, recording.beginTime);
      assert.equal(queuedRows.length, 1);
      assert.equal(queuedRows[0].date, "2026-07-08");
      assert.equal(queuedRows[0].recordingKey, enqueueCalls[0].recordingKey);
    }
  );
});

test("feed analysis markers are read-only and do not start analysis", async () => {
  let syncNowCalled = false;
  setFeedAnalysisCoordinator({
    store: {
      getReplayMarkers: (date, deviceSn) => [
        null,
        {
          eventId: { sourceUrl: "https://secret.example.test/event" },
          recordingKey: `${date} 10:00:00__cat.h264`,
          markerType: "cat_enter",
          target: "cat",
          offsetSec: 6,
          offsetMs: [6000],
          confidence: [1],
          modelConfidence: 0.92,
          cuteScore: 1.2,
          cuteReasons: ["head_up", "head_up", null],
          markerLabel: { rawFrame: "must-not-leak" },
          sourceUrl: "https://secret.example.test/replay.m3u8",
          playbackParams: {
            startTime: { sourceUrl: "https://secret.example.test/start" },
            endTime: `${date} 10:01:00`,
            fileName: "cat.h264",
            targetSec: [6],
          },
          deviceSn,
        },
      ],
      getAnalysisStatus: () => [
        {
          status: "failed",
          recordingKey: "rk",
          failureCount: 1,
          lastError: "failed https://secret.example.test/replay.m3u8?token=temporary-token password=device-password adminToken=admin-token",
        },
      ],
    },
    async syncNow() {
      syncNowCalled = true;
      throw new Error("markers should not trigger syncNow");
    },
  });

  const res = await request(makeApp(), "/api/feed-analysis/markers?deviceSn=SN001&date=2026-07-13&sync=1");

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(syncNowCalled, false);
  assert.equal(res.body.markers.length, 1);
  assert.equal(res.body.markers[0].offsetSec, 6);
  assert.equal(res.body.markers[0].offsetMs, 0);
  assert.equal(res.body.markers[0].confidence, 0);
  assert.equal(res.body.markers[0].modelConfidence, 0.92);
  assert.equal(res.body.markers[0].cuteScore, 1);
  assert.deepEqual(res.body.markers[0].cuteReasons, ["head_up"]);
  assert.equal(res.body.markers[0].eventId, undefined);
  assert.equal(res.body.markers[0].markerLabel, undefined);
  assert.equal(res.body.markers[0].playbackParams.startTime, "");
  assert.equal(res.body.markers[0].playbackParams.targetSec, 0);
  assert.equal(res.body.analysisStatus.length, 1);
  assert.equal(res.body.analysisStatus[0].lastError.includes("secret.example"), false);
  assert.equal(res.body.analysisStatus[0].lastError.includes("temporary-token"), false);
  assert.doesNotMatch(JSON.stringify(res.body.markers), /secret\.example|sourceUrl|rawFrame/);
  assertNoSecrets(res.body);
});

test("device timeline returns one sanitized snapshot and supports revision polling", async () => {
  setFeedAnalysisCoordinator({
    store: {
      getReplayMarkers: (date) => [{
        recordingKey: `${date} 10:00:00__cat.h264`,
        markerType: "cat_present",
        markerTsMs: new Date(`${date}T10:00:10+08:00`).getTime(),
        beginTime: `${date} 10:00:10`,
        endTime: `${date} 10:00:30`,
        sourceUrl: "https://secret.example.test/replay.m3u8",
      }],
      getDiary: (date) => ({ date, clipCount: 1, clips: [] }),
      getAnalysisStatus: () => [{ status: "ready", recordingKey: "recording-1" }],
      getSettings: () => ({
        officialAlarmStatus: "ready",
        officialAlarmSource: "cloud+device-log",
        officialAlarmCheckedAt: 123456,
        motionDeliveryEnabled: true,
        motionDeliveryStatus: "ready",
        motionDeliveryCheckedAt: 123450,
        lastMotionAlarmAt: 123400,
        lastPetAlarmAt: 123300,
      }),
    },
  });

  const first = await request(makeApp(), "/api/devices/SN001/timeline?date=2026-09-01");
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.unchanged, false);
  assert.equal(first.body.markers.length, 1);
  assert.equal(first.body.markers[0].sourceUrl, undefined);
  assert.equal(first.body.sourceHealth.motionDeliveryEnabled, true);
  assert.match(first.body.revision, /^[a-f0-9]{40}$/);

  const second = await request(
    makeApp(),
    `/api/devices/SN001/timeline?date=2026-09-01&since=${first.body.revision}`
  );
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.unchanged, true);
  assert.equal(second.body.markers, undefined);
  assert.equal(second.body.diary, undefined);
});

test("playback-url requests the vendor default replay transport directly", async () => {
  const playbackCalls = [];
  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
      login: async function login() {
        return { Ret: 100 };
      },
      getPlaybackUrl: async function getPlaybackUrl(record, options) {
        playbackCalls.push(options);
        if (options.mediaType || options.protocol) {
          throw new Error("Param error");
        }
        return "https://example.test/sdk-default-playback.m3u8";
      },
    },
    async () => {
      const app = makeApp();
      const sn = encodeURIComponent(config.device.sn);
      const playback = await request(app, `/api/devices/${sn}/playback-url`, {
        method: "POST",
        body: {
          beginTime: "2026-07-11 10:00:00",
          endTime: "2026-07-11 10:01:00",
          fileName: "clip.h264",
          mediaType: "hls",
          protocol: "ts",
        },
      });

      assert.equal(playback.statusCode, 200);
      assert.equal(playback.body.ok, true);
      assert.match(playback.body.url, /\/api\/live-recording-sources\/.+\/index\.m3u8\?access=/);
      assert.equal(playback.body.transport, "official-default-vod-manifest");
      assert.match(playback.body.manifestSessionId, /^[0-9a-f-]{36}$/);
    }
  );

  assert.equal(playbackCalls.length, 1);
  assert.equal(Object.hasOwn(playbackCalls[0], "mediaType"), false);
  assert.equal(Object.hasOwn(playbackCalls[0], "protocol"), false);
});

test("signed foodcast material media supports byte ranges and legacy cover generation", async () => {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-media-"));
  const videoPath = path.join(mediaDir, "meal.mp4");
  const coverPath = path.join(mediaDir, "cover.jpg");
  fs.writeFileSync(videoPath, "0123456789");
  fs.writeFileSync(coverPath, "JPEG");
  let coverBuilds = 0;
  const stored = {
    id: "meal-legacy",
    kind: "meal",
    ownerOpenid: "openid-owner",
    deviceSn: "SN001",
    date: "2026-07-26",
    status: "ready",
    fileId: "video-file",
    coverFileId: "",
    durationSec: 10,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    hasCover: true,
  };
  setCustomFoodcastService({
    async listMaterials() { return [{ ...stored }]; },
    async getMaterial() { return { ...stored }; },
    async ensureMaterialCover() {
      coverBuilds += 1;
      return { ...stored, coverFileId: "cover-file" };
    },
    mediaStorage: {
      async getReadUrl(fileId) { return fileId === "cover-file" ? coverPath : videoPath; },
    },
  });
  try {
    const app = makeApp();
    const catalog = await request(app, "/api/foodcasts/materials?deviceSn=SN001&date=2026-07-26");
    const material = catalog.body.materials[0];
    const videoUrl = new URL(material.previewUrl);
    const coverUrl = new URL(material.coverUrl);
    const partial = await request(app, `${videoUrl.pathname}${videoUrl.search}`, {
      auth: false,
      headers: { Range: "bytes=2-5" },
    });
    const cover = await request(app, `${coverUrl.pathname}${coverUrl.search}`, { auth: false });

    assert.equal(partial.statusCode, 206);
    assert.equal(partial.raw, "2345");
    assert.equal(partial.headers["accept-ranges"], "bytes");
    assert.equal(cover.statusCode, 200);
    assert.equal(cover.raw, "JPEG");
    assert.equal(coverBuilds, 1);
  } finally {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

test("playback-url releases the background analysis stream before requesting user replay", async () => {
  const calls = [];
  setFeedAnalysisCoordinator({
    pauseAll() { calls.push(["pauseAll"]); },
    pauseDevice(deviceSn) { calls.push(["pauseDevice", deviceSn]); },
  });

  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
      login: async function login() {
        calls.push(["login"]);
        return { Ret: 100 };
      },
      closeLivestream: async function closeLivestream(channel, streamType) {
        calls.push(["closeLivestream", channel, streamType]);
      },
      getPlaybackUrl: async function getPlaybackUrl() {
        calls.push(["getPlaybackUrl"]);
        return "https://example.test/user-playback.m3u8";
      },
    },
    async () => {
      const playback = await request(
        makeApp(),
        `/api/devices/${encodeURIComponent(config.device.sn)}/playback-url`,
        {
          method: "POST",
          body: {
            beginTime: "2026-07-11 10:00:00",
            endTime: "2026-07-11 10:01:00",
            fileName: "clip.h264",
            mediaType: "hls",
            protocol: "ts",
          },
        }
      );
      assert.equal(playback.statusCode, 200);
    }
  );

  const closeIndex = calls.findIndex((call) => call[0] === "closeLivestream");
  const playbackIndex = calls.findIndex((call) => call[0] === "getPlaybackUrl");
  assert.ok(closeIndex >= 0);
  assert.ok(playbackIndex > closeIndex);
  assert.deepEqual(calls[closeIndex], ["closeLivestream", Number(config.channel) || 0, config.analysis.playbackStreamType]);
});

test("motion alert preference is user-scoped while device detection stays enabled", async () => {
  const app = makeApp();
  const initial = await request(app, "/api/devices/SN001/motion-alerts/preference");
  const disabled = await request(app, "/api/devices/SN001/motion-alerts/preference", {
    method: "PUT",
    body: { enabled: false },
  });
  const reloaded = await request(app, "/api/devices/SN001/motion-alerts/preference");
  const otherUser = await request(app, "/api/devices/SN001/motion-alerts/preference", {
    openid: "openid-other",
  });

  assert.equal(initial.statusCode, 200);
  assert.equal(initial.body.preference.enabled, true);
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.body.preference.enabled, false);
  assert.equal(disabled.body.deviceDetectionEnabled, true);
  assert.equal(reloaded.body.preference.enabled, false);
  assert.equal(otherUser.statusCode, 404);
});

test("vendor alarm callback is capability-authenticated, persisted, and queued without a user push", async () => {
  let ingested = null;
  setFeedAnalysisCoordinator({
    setMotionAlarmSink() {},
    async ingestOfficialAlarmCallback(input) {
      ingested = input;
      return { ok: true, queued: true };
    },
  });
  const app = makeApp();
  const denied = await request(app, "/api/vendor/alarms/callback/wrong-token/SN001", {
    method: "POST",
    auth: false,
    body: { AlarmID: "alarm-denied", AlarmType: "Motion", AlarmTime: "2026-08-31 10:29:00" },
  });
  const accepted = await request(
    app,
    `/api/vendor/alarms/callback/${encodeURIComponent(config.vendorAlarms.callbackToken)}/SN001`,
    {
      method: "POST",
      auth: false,
      body: { AlarmID: "alarm-callback-1", AlarmType: "Motion", AlarmTime: "2026-08-31 10:30:00" },
    }
  );

  assert.equal(denied.statusCode, 403);
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.body, { ok: true, accepted: 1, queued: true });
  assert.equal(ingested.deviceSn, "SN001");
  assert.equal(ingested.rawAlarms[0].AlarmID, "alarm-callback-1");

  await withMockedDevice(
    {
      login: async () => ({ Ret: 100 }),
      queryAlarmMessages: async () => {
        const error = new Error("vendor history unavailable");
        error.code = "ALARM_QUERY_UNAVAILABLE";
        throw error;
      },
    },
    async () => {
      const history = await request(makeApp(), "/api/devices/SN001/motion-alerts?date=2026-08-31&refresh=1");
      assert.equal(history.statusCode, 200);
      assert.equal(history.body.stale, true);
      assert.deepEqual(history.body.alarms.map((alarm) => alarm.id), ["alarm-callback-1"]);
    }
  );
});

test("foreground sync checks real online state and updates device time only for online cameras", async () => {
  const calls = [];
  setFeedAnalysisCoordinator({
    setDeviceProvider() {},
    setMotionAlarmSink() {},
    setDeviceNotificationDispatcher() {},
    async bootstrapOfficialConfig(device, sn) {
      calls.push(["bootstrapOfficialConfig", device.sn, sn]);
    },
  });
  await withMockedDevice(
    {
      ensureDeviceToken: async function ensureDeviceToken() {
        this.deviceToken = "device-token";
        return this.deviceToken;
      },
      status: async () => {
        calls.push(["status"]);
        return { status: "online" };
      },
      login: async () => {
        calls.push(["login"]);
        return { Ret: 100 };
      },
      opdev: async function opdev(payload) {
        calls.push(["opdev", payload]);
        if (payload.Name === "OPTimeQuery") {
          return { Ret: 100, OPTimeQuery: this._deviceTime };
        }
        this._deviceTime = payload.OPTimeSetting;
        return { Ret: 100 };
      },
    },
    async () => {
      const response = await request(makeApp(), "/api/app/foreground-sync", { method: "POST" });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.results[0].sn, "SN001");
      assert.equal(response.body.results[0].status, "online");
      assert.equal(response.body.results[0].synced, true);
      assert.equal(response.body.results[0].motionAlarmReady, true);
      assert.match(response.body.results[0].deviceTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
  );
  assert.deepEqual(calls[0], ["status"]);
  assert.deepEqual(calls[1], ["login"]);
  assert.equal(calls[2][0], "opdev");
  assert.equal(calls[2][1].Name, "OPTimeSetting");
  assert.match(calls[2][1].OPTimeSetting, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(calls[3], ["opdev", { Name: "OPTimeQuery" }]);
  assert.deepEqual(calls[4], ["bootstrapOfficialConfig", "SN001", "SN001"]);
});

test("device settings summary returns real storage and recording data without credentials", async () => {
  await withMockedDevice(
    {
      ensureDeviceToken: async function ensureDeviceToken() {
        this.deviceToken = "device-token";
        return this.deviceToken;
      },
      status: async () => ({ status: "online" }),
      login: async () => ({ Ret: 100 }),
      getInfo: async (name) => {
        assert.equal(name, "StorageInfo");
        return { Ret: 100, StorageInfo: [{ Partition: [{ TotalSpace: 61058, RemainSpace: 21058 }] }] };
      },
      getConfig: async (name) => {
        if (name === "Storage.StoragePosition") return { StoragePosition: { SATA: true } };
        if (name === "Record") return { Record: { RecordMask: "0x00000001", PacketLength: 30 } };
        if (name === "Storage.Snapshot") return { Snapshot: { SnapShotMask: "0x00000001" } };
        if (name === "AVEnc.Encode") return { Encode: { MainFormat: { Video: { Resolution: "1080P", FPS: 20 } } } };
        throw new Error("UNEXPECTED_CONFIG");
      },
    },
    async () => {
      const response = await request(makeApp(), "/api/devices/SN001/settings-summary");
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.status, "online");
      assert.equal(response.body.summary.storage.type, "存储卡");
      assert.equal(response.body.summary.storage.available, true);
      assert.equal(response.body.summary.recording.continuous, true);
      assert.equal(response.body.summary.picture.resolution, "1080P");
      assert.doesNotMatch(JSON.stringify(response.body), /device-password|admin-token/i);
    }
  );
});

test("motion alert history returns backend-hosted image URLs usable by the mini program", async () => {
  resetDeviceStateForTests({ clearStore: false });
  const originalFetch = global.fetch;
  const fetched = [];
  global.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(Buffer.from("image-bytes"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  };

  try {
    await withMockedDevice(
      {
		ensureDeviceToken: async function ensureDeviceToken() {
			this.deviceToken = "device-token";
			return this.deviceToken;
		},
        login: async () => ({ Ret: 100 }),
        queryAlarmMessages: async () => [{
          AlarmID: "alarm-1",
          AlarmTime: "2026-08-31 10:30:00",
          AlarmType: "Motion",
        }],
        getAlarmPicUrl: async () => "https://media.vendor.test/alarm-1.jpg",
      },
      async () => {
        const app = makeApp();
        const history = await request(app, "/api/devices/SN001/motion-alerts?date=2026-08-31&refresh=1");
        assert.equal(history.statusCode, 200);
        assert.equal(history.body.alarms.length, 1);
        assert.match(history.body.alarms[0].imageUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/motion-alert-images\/[a-f0-9]{48}$/);

        const imagePath = new URL(history.body.alarms[0].imageUrl).pathname;
        const image = await request(app, imagePath, { auth: false });
        assert.equal(image.statusCode, 200);
        assert.equal(image.headers["content-type"], "image/jpeg");
        assert.equal(image.raw, "image-bytes");
        assert.deepEqual(fetched, ["https://media.vendor.test/alarm-1.jpg"]);
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("POST replay-clips exports an authorized historical interval as a recording job", async () => {
  let exportInput = null;
  setLiveRecordingServiceForTests({
    async startReplayExport(input) {
      exportInput = input;
      return {
        id: "history-clip-1",
        ownerOpenid: input.ownerOpenid,
        actorOpenid: input.actorOpenid,
        deviceSn: input.deviceSn,
        status: "finalizing",
        accessToken: "history-token",
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationSec: (input.endedAt - input.startedAt) / 1000,
      };
    },
  });
  const response = await request(makeApp(), "/api/devices/SN001/replay-clips", {
    method: "POST",
    body: {
      startTime: "2026-08-24 07:30:00",
      endTime: "2026-08-24 07:47:09",
      startOffsetSec: 12,
      endOffsetSec: 28,
    },
  });

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.recording.id, "history-clip-1");
  assert.equal(response.body.recording.status, "finalizing");
  assert.equal(response.body.recording.durationSec, 16);
  assert.equal(exportInput.actorOpenid, "openid-owner");
  assert.equal(exportInput.deviceSn, "SN001");
  assert.equal(exportInput.endedAt - exportInput.startedAt, 16_000);
  assert.equal(response.body.recording.ownerOpenid, undefined);
});

test("POST replay-clips rejects empty and overlong historical intervals", async () => {
  setLiveRecordingServiceForTests({ startReplayExport() { throw new Error("should not run"); } });
  const invalid = await request(makeApp(), "/api/devices/SN001/replay-clips", {
    method: "POST",
    body: { startTime: "2026-08-24 07:30:00", startOffsetSec: 5, endOffsetSec: 5 },
  });
  const overlong = await request(makeApp(), "/api/devices/SN001/replay-clips", {
    method: "POST",
    body: { startTime: "2026-08-24 07:30:00", startOffsetSec: 0, endOffsetSec: 301 },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, "RECORDING_WINDOW_INVALID");
  assert.equal(overlong.statusCode, 400);
  assert.equal(overlong.body.error, "RECORDING_DURATION_EXCEEDED");
});

test("playback-url returns a cached VOD manifest without creating a media relay", async () => {
  const playbackCalls = [];
  const closeCalls = [];
  setReplayHlsManagerForTests({
    async cleanupExpired() { return 0; },
    async stopDeviceSessions() { return 0; },
    reuseSession() {
      throw new Error("direct HLS must not reuse a relay session");
    },
    async createSession() {
      throw new Error("direct HLS must not create a relay session");
    },
    async stopSession() { return false; },
  });

  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
      login: async () => ({ Ret: 100 }),
      getPlaybackUrl: async (record, options) => {
        playbackCalls.push(options);
        assert.equal(options.mediaType, "hls");
        assert.equal(options.protocol, "hls");
        return "https://vendor.example.test/direct-replay.m3u8?token=short-lived";
      },
      closeLivestream: async (channel, streamType) => {
        closeCalls.push({ channel, streamType });
      },
    },
    async () => {
      const playback = await request(
        makeApp(),
        `/api/devices/${encodeURIComponent(config.device.sn)}/playback-url`,
        {
          method: "POST",
          body: {
            beginTime: "2026-07-11 10:00:00",
            endTime: "2026-07-11 10:01:00",
            fileName: "clip.h264",
            mediaType: "hls",
            protocol: "hls",
            preferDirectHls: true,
          },
        }
      );

      assert.equal(playback.statusCode, 200);
      assert.equal(playback.body.direct, true);
      assert.equal(playback.body.playbackType, "hls");
      assert.equal(playback.body.transport, "hls-hls-vod-manifest");
      assert.equal(playback.body.sessionId, undefined);
      assert.match(playback.body.manifestSessionId, /^[0-9a-f-]{36}$/);
      assert.match(playback.body.playUrl, /\/api\/live-recording-sources\/.+\/index\.m3u8\?access=/);
      assert.equal(playback.body.playUrl.includes("vendor.example.test"), false);

      const stopped = await request(
        makeApp(),
        `/api/replay-sessions/${encodeURIComponent(playback.body.manifestSessionId)}`,
        { method: "DELETE" }
      );
      assert.equal(stopped.statusCode, 200);
      assert.equal(stopped.body.stopped, true);
    }
  );

  assert.equal(playbackCalls.length, 1);
  assert.deepEqual(closeCalls, [
    { channel: Number(config.channel) || 0, streamType: config.analysis.playbackStreamType },
    { channel: 0, streamType: 0 },
  ]);
});

test("playback-url normalizes RTSP replay sources into a mini-program playable HLS relay", async () => {
  assert.equal(typeof setReplayHlsManagerForTests, "function");
  const relayCalls = [];
  const readyCalls = [];
  setReplayHlsManagerForTests({
    async createSession(options) {
      relayCalls.push(options);
      return {
        ok: true,
        sessionId: "hls-session-1",
        playUrl: `${options.baseUrl}/api/replay-hls/hls-session-1/index.m3u8`,
        streamUrl: `${options.baseUrl}/api/replay-hls/hls-session-1/index.m3u8`,
        durationSec: options.durationSec,
        currentSec: options.currentSec,
        playbackType: "hls",
        transport: "rtsp-hls-relay",
        fallback: true,
      };
    },
    async stopDeviceSessions() {
      return 0;
    },
    async waitUntilReady(sessionId) {
      readyCalls.push(sessionId);
      return { sessionId, transport: "rtsp-hls-relay" };
    },
    async cleanupExpired() {
      return 0;
    },
  });

  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
      login: async function login() {
        return { Ret: 100 };
      },
      getPlaybackUrl: async function getPlaybackUrl() {
        return "rtsp://camera.example.test/replay.sdp";
      },
    },
    async () => {
      const app = makeApp();
      const sn = encodeURIComponent(config.device.sn);
      const playback = await request(app, `/api/devices/${sn}/playback-url`, {
        method: "POST",
        body: {
          beginTime: "2026-07-11 10:00:00",
          endTime: "2026-07-11 10:01:00",
          fileName: "clip.h264",
          mediaType: "hls",
          protocol: "ts",
          targetSec: 12,
        },
      });

      assert.equal(playback.statusCode, 200);
      assert.equal(playback.body.ok, true);
      assert.equal(playback.body.transport, "rtsp-hls-relay");
      assert.equal(playback.body.playbackType, "hls");
      assert.match(playback.body.url, /\/api\/replay-hls\/hls-session-1\/index\.m3u8$/);
      assert.equal(playback.body.currentSec, 12);
      assert.equal(playback.body.durationSec, 60);
    }
  );

  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].sourceUrl, "rtsp://camera.example.test/replay.sdp");
  assert.equal(relayCalls[0].deviceSn, config.device.sn);
  assert.equal(relayCalls[0].currentSec, 12);
  assert.deepEqual(readyCalls, ["hls-session-1"]);
});

test("playback-url returns a bounded startup error when the HLS relay exits early", async () => {
  const stoppedSessions = [];
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    stopDeviceSessions: async () => 0,
    createSession: async ({ baseUrl }) => ({
      ok: true,
      sessionId: "hls-start-failed",
      playUrl: `${baseUrl}/api/replay-hls/hls-start-failed/index.m3u8`,
      streamUrl: `${baseUrl}/api/replay-hls/hls-start-failed/index.m3u8`,
      playbackType: "hls",
      transport: "rtsp-hls-remux",
    }),
    async waitUntilReady() {
      const error = new Error("REPLAY_HLS_START_FAILED");
      error.code = "REPLAY_HLS_START_FAILED";
      throw error;
    },
    async stopSession(sessionId) {
      stoppedSessions.push(sessionId);
      return true;
    },
  });

  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = `token-for-${this.sn}`;
        return this.deviceToken;
      },
      login: async () => ({ Ret: 100 }),
      getPlaybackUrl: async () => "rtsp://camera.example.test/replay.sdp",
    },
    async () => {
      const response = await request(
        makeApp(),
        `/api/devices/${encodeURIComponent(config.device.sn)}/playback-url`,
        {
          method: "POST",
          body: {
            beginTime: "2026-07-11 10:00:00",
            endTime: "2026-07-11 10:01:00",
            fileName: "clip.h264",
          },
        }
      );

      assert.equal(response.statusCode, 502);
      assert.equal(response.body.error, "REPLAY_HLS_START_FAILED");
      assert.deepEqual(stoppedSessions, ["hls-start-failed"]);
    }
  );
});

test("livestream serves the trusted cute preset through backend HLS", async () => {
  let hlsOptions = null;
  let hlsCreateCount = 0;
  let livestreamUrlCount = 0;
  const calls = [];
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    stopSession: async () => false,
    stopDeviceSessions: async () => 0,
    attachHttpResponse: async () => {},
    async createSession(options) {
      hlsCreateCount += 1;
      hlsOptions = options;
      return {
        ok: true,
        sessionId: "live-cute-1",
        playUrl: `${options.baseUrl}/api/replay-hls/live-cute-1/index.m3u8`,
        streamUrl: `${options.baseUrl}/api/replay-hls/live-cute-1/index.m3u8`,
        playbackType: "hls",
        transport: options.transport,
      };
    },
  });

  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = "token-live-filter";
        return this.deviceToken;
      },
      login: async () => ({ Ret: 100 }),
      getLivestreamUrl: async () => {
        livestreamUrlCount += 1;
        return "https://camera.test/live.m3u8";
      },
      closeLivestream: async function closeLivestream(channel, stream) {
        calls.push(["closeLivestream", channel, stream]);
      },
    },
    async () => {
      const path = `/api/devices/${encodeURIComponent(config.device.sn)}/livestream`;
      const response = await request(makeApp(), path, {
        method: "POST",
        headers: { "x-forwarded-proto": "http", "x-forwarded-host": "backend.test" },
        body: { mediaType: "hls", protocol: "ts", stream: "0", videoFilter: "cute-v1" },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(hlsOptions.live, true);
      assert.match(hlsOptions.videoFilter, /^curves=/);
      assert.equal(response.body.filterPreset, "cute-v1");
      assert.match(response.body.url, /\/api\/replay-hls\/live-cute-1\/index\.m3u8$/);
      await hlsOptions.releaseSource();
      assert.deepEqual(calls, [["closeLivestream", "0", "0"]]);

      const debug = await request(makeApp(), path, {
        method: "POST",
        body: { mediaType: "hls", protocol: "ts", videoFilter: "cute-debug-max" },
      });
      assert.equal(debug.statusCode, 200);
      assert.match(hlsOptions.videoFilter, /^eq=/);
      assert.equal(debug.body.filterPreset, "cute-debug-max");
      assert.equal(hlsCreateCount, 2);
      assert.equal(livestreamUrlCount, 2);

      const recordingSource = await request(makeApp(), path, {
        method: "POST",
        headers: { "x-forwarded-proto": "http", "x-forwarded-host": "192.168.8.25:8000" },
        body: { mediaType: "hls", protocol: "ts", recordingSource: true },
      });
      assert.equal(recordingSource.statusCode, 200);
      assert.equal(typeof recordingSource.body.sessionId, "string");
      assert.ok(recordingSource.body.sessionId.length > 0);
      assert.equal(recordingSource.body.recordingSource, true);
      assert.equal(recordingSource.body.transport, "official-hls-recording-source");
      assert.equal(recordingSource.body.url, undefined);
      assert.equal(recordingSource.body.playUrl, undefined);
      assert.equal(hlsCreateCount, 2);
      const stoppedRecordingSource = await request(
        makeApp(),
        `/api/replay-sessions/${encodeURIComponent(recordingSource.body.sessionId)}`,
        { method: "DELETE" }
      );
      assert.equal(stoppedRecordingSource.statusCode, 200);
      assert.equal(stoppedRecordingSource.body.stopped, true);

      const playbackSource = await request(makeApp(), path, {
        method: "POST",
        headers: { "x-forwarded-proto": "http", "x-forwarded-host": "192.168.8.25:8000" },
        body: { mediaType: "hls", protocol: "ts", stream: "0", playbackSource: true },
      });
      assert.equal(playbackSource.statusCode, 200);
      assert.equal(playbackSource.body.ok, true);
      assert.equal(typeof playbackSource.body.sessionId, "string");
      assert.equal(playbackSource.body.playbackSource, true);
      assert.equal(playbackSource.body.transport, "official-hls-playback-source");
      assert.equal(typeof playbackSource.body.url, "string");
      assert.match(playbackSource.body.url, /^https?:\/\//);
      if (!playbackSource.body.url.includes("camera.test")) {
        assert.match(playbackSource.body.url, /\/api\/live-recording-sources\//);
      }
      assert.equal(hlsCreateCount, 2);

      const stoppedPlaybackSource = await request(
        makeApp(),
        `/api/replay-sessions/${encodeURIComponent(playbackSource.body.sessionId)}`,
        { method: "DELETE" }
      );
      assert.equal(stoppedPlaybackSource.statusCode, 200);
      assert.equal(stoppedPlaybackSource.body.stopped, true);

      cache.set(
        `hlsUrl:${config.device.sn}:0:0`,
        "https://camera.test/stale-live.m3u8",
        cache.TTL_URL
      );
      const livestreamCountBeforeShared = livestreamUrlCount;
      const sharedSource = await request(makeApp(), path, {
        method: "POST",
        headers: { "x-forwarded-proto": "http", "x-forwarded-host": "192.168.8.25:8000" },
        body: { mediaType: "hls", protocol: "ts", stream: "0", sharedSource: true },
      });
      assert.equal(sharedSource.statusCode, 200);
      assert.equal(sharedSource.body.ok, true);
      assert.equal(typeof sharedSource.body.sessionId, "string");
      assert.ok(sharedSource.body.sessionId.length > 0);
      assert.equal(sharedSource.body.sharedSource, true);
      assert.equal(sharedSource.body.recordingSource, true);
      assert.equal(sharedSource.body.transport, "official-hls-shared-stable");
      assert.match(sharedSource.body.url, /\/api\/live-recording-sources\//);
      assert.equal(livestreamUrlCount, livestreamCountBeforeShared + 1);

      const stoppedSharedSource = await request(
        makeApp(),
        `/api/replay-sessions/${encodeURIComponent(sharedSource.body.sessionId)}`,
        { method: "DELETE" }
      );
      assert.equal(stoppedSharedSource.statusCode, 200);
      assert.equal(stoppedSharedSource.body.stopped, true);
      assert.deepEqual(calls, [
        ["closeLivestream", "0", "0"],
        ["closeLivestream", "0", "1"],
        ["closeLivestream", "0", "0"],
        ["closeLivestream", "0", "0"],
      ]);

      const injected = await request(makeApp(), path, {
        method: "POST",
        body: { mediaType: "hls", protocol: "ts", videoFilter: "scale=1:1" },
      });
      assert.equal(injected.body.url, "https://camera.test/live.m3u8");
      assert.equal(hlsCreateCount, 2);
    }
  );
});

test("live priority pauses analysis and preempts replay transcodes for the owned device", async () => {
  const pauses = [];
  const stoppedDevices = [];
  setFeedAnalysisCoordinator({
    pauseDevice(deviceSn, durationMs) {
      pauses.push([deviceSn, durationMs]);
      return { ok: true, paused: true, until: Date.now() + durationMs };
    },
  });
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    stopSession: async () => false,
    attachHttpResponse: async () => {},
    async stopDeviceSessions(deviceSn) {
      stoppedDevices.push(deviceSn);
      return 1;
    },
  });
  setReplayChannelReleaseDelayForTests(0);

  const response = await request(
    makeApp(),
    `/api/devices/${encodeURIComponent(config.device.sn)}/live-priority`,
    { method: "POST", body: { holdMs: 90000 } }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.stoppedReplaySessions, 1);
  assert.deepEqual(pauses, [[config.device.sn, 90000]]);
  assert.deepEqual(stoppedDevices, [config.device.sn]);

  const forbidden = await request(
    makeApp(),
    `/api/devices/${encodeURIComponent(config.device.sn)}/live-priority`,
    { method: "POST", openid: "openid-other", body: { holdMs: 90000 } }
  );
  assert.equal(forbidden.statusCode, 404);
});

test("device status, livestream, recordings, playback, and time APIs proxy through JFDevice", async () => {
  const calls = [];
  await withMockedDevice(
    {
      bind: async function bind() {
        calls.push(["bind"]);
      },
      getToken: async function getToken() {
        calls.push(["getToken"]);
        this.deviceToken = "token-1";
        return "token-1";
      },
      login: async function login() {
        calls.push(["login"]);
        return { Ret: 100 };
      },
      status: async function status() {
        calls.push(["status"]);
        return { status: "online" };
      },
      getLivestreamUrl: async function getLivestreamUrl(protocol, channel, stream) {
        calls.push(["getLivestreamUrl", protocol, channel, stream]);
        return "https://example.test/live.m3u8";
      },
      queryRecordings: async function queryRecordings(query) {
        calls.push(["queryRecordings", query]);
        return [
          {
            BeginTime: "2026-07-11 10:00:00",
            EndTime: "2026-07-11 10:01:00",
            FileName: "clip.h264",
          },
        ];
      },
      getPlaybackUrl: async function getPlaybackUrl(record, options) {
        calls.push(["getPlaybackUrl", record, options]);
        return "https://example.test/playback.m3u8";
      },
      opdev: async function opdev(payload) {
        calls.push(["opdev", payload]);
        if (payload.Name === "OPTimeQuery") {
          return { Name: payload.Name, OPTimeQuery: this._deviceTime || "2026-07-11 10:00:00", Ret: 100 };
        }
        if (payload.Name === "OPTimeSetting") this._deviceTime = payload.OPTimeSetting;
        return { Ret: 100 };
      },
    },
    async () => {
      const app = makeApp();
      const sn = encodeURIComponent(config.device.sn);

      const status = await request(app, `/api/devices/${sn}/status`);
      assert.equal(status.statusCode, 200);
      assert.equal(status.body.status.status, "online");
      assert.equal(status.body.device.online, true);

      const live = await request(app, `/api/devices/${sn}/livestream`, {
        method: "POST",
        body: { mediaType: "hls", protocol: "ts", channel: 0, stream: "1" },
      });
      assert.equal(live.statusCode, 200);
      assert.equal(live.body.ok, true);
      assert.equal(live.body.url, "https://example.test/live.m3u8");
      assert.equal(live.body.deviceToken, undefined);

      const recordings = await request(
        app,
        `/api/devices/${sn}/recordings?beginTime=2026-07-11%2000%3A00%3A00&endTime=2026-07-11%2023%3A59%3A59`
      );
      assert.equal(recordings.statusCode, 200);
      assert.equal(recordings.body.recordings[0].beginTime, "2026-07-11 10:00:00");
      assert.equal(recordings.body.recordings[0].durationSec, 60);

      const playback = await request(app, `/api/devices/${sn}/playback-url`, {
        method: "POST",
        body: {
          beginTime: "2026-07-11 10:00:00",
          endTime: "2026-07-11 10:01:00",
          fileName: "clip.h264",
          mediaType: "hls",
          protocol: "ts",
        },
      });
      assert.equal(playback.statusCode, 200);
      assert.match(playback.body.url, /\/api\/live-recording-sources\/.+\/index\.m3u8\?access=/);
      assert.equal(playback.body.transport, "official-default-vod-manifest");

      const time = await request(app, `/api/devices/${sn}/time`);
      assert.equal(time.statusCode, 200);
      assert.equal(time.body.deviceTime, "2026-07-11 10:00:00");

      const sync = await request(app, `/api/devices/${sn}/time-sync`, {
        method: "POST",
        body: { mode: "local", deviceTime: "2026-07-11 10:02:00" },
      });
      assert.equal(sync.statusCode, 200);
      assert.equal(sync.body.ok, true);
    }
  );

  assert.ok(calls.some((call) => call[0] === "getLivestreamUrl" && call[1] === "hls-ts"));
  assert.ok(calls.some((call) => call[0] === "queryRecordings"));
  assert.ok(calls.some((call) => call[0] === "getPlaybackUrl"));
  assert.ok(calls.some((call) => call[0] === "opdev" && call[1].Name === "OPTimeSetting"));
});

test("POST /api/devices/:sn/playback-url bypasses the rejected explicit HLS params", async () => {
  const calls = [];
  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = "token-1";
        return "token-1";
      },
      login: async function login() {
        return { Ret: 100 };
      },
      getPlaybackUrl: async function getPlaybackUrl(record, options) {
        calls.push({ record, options });
        if (options.mediaType === "hls" && options.protocol === "ts") {
          throw new Error('playback param error: {"code":4000,"msg":"Param error"}');
        }
        return "https://example.test/sdk-default-playback.m3u8";
      },
    },
    async () => {
      const app = makeApp();
      const sn = encodeURIComponent(config.device.sn);
      const playback = await request(app, `/api/devices/${sn}/playback-url`, {
        method: "POST",
        body: {
          beginTime: "2026-07-11 10:00:00",
          endTime: "2026-07-11 10:01:00",
          fileName: "clip.h264",
          mediaType: "hls",
          protocol: "ts",
        },
      });

      assert.equal(playback.statusCode, 200);
      assert.equal(playback.body.ok, true);
      assert.match(playback.body.url, /\/api\/live-recording-sources\/.+\/index\.m3u8\?access=/);
      assert.equal(playback.body.transport, "official-default-vod-manifest");
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.mediaType, undefined);
  assert.equal(calls[0].options.protocol, undefined);
});

test("POST /api/devices/:sn/playback-url relays RTSP playback as HLS for mini programs", async () => {
  const hlsCalls = [];
  const stoppedDevices = [];
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    stopSession: async () => false,
    stopDeviceSessions: async (deviceSn) => {
      stoppedDevices.push(deviceSn);
      return 0;
    },
    attachHttpResponse: async () => {},
    createSession: async ({ sourceUrl, baseUrl, durationSec, currentSec, deviceSn }) => {
      hlsCalls.push({ sourceUrl, baseUrl, durationSec, currentSec, deviceSn });
      return {
        ok: true,
        sessionId: "hls-1",
        playUrl: `${baseUrl}/api/replay-hls/hls-1/index.m3u8`,
        streamUrl: `${baseUrl}/api/replay-hls/hls-1/index.m3u8`,
        durationSec,
        currentSec,
        playbackType: "hls",
        transport: "rtsp-hls-relay",
        fallback: true,
      };
    },
  });

  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = "token-1";
        return "token-1";
      },
      login: async function login() {
        return { Ret: 100 };
      },
      getPlaybackUrl: async function getPlaybackUrl(record, options) {
        assert.equal(options.mediaType, undefined);
        assert.equal(options.protocol, undefined);
        assert.equal(options.startTime, "2026-07-11 10:00:42");
        assert.equal(options.endTime, "2026-07-11 10:01:00");
        return "rtsp://example.test/replay.sdp";
      },
    },
    async () => {
      const app = makeApp();
      const sn = encodeURIComponent(config.device.sn);
      const playback = await request(app, `/api/devices/${sn}/playback-url`, {
        method: "POST",
        headers: {
          "x-forwarded-proto": "http",
          "x-forwarded-host": "192.168.63.215:8000",
        },
        body: {
          beginTime: "2026-07-11 10:00:00",
          endTime: "2026-07-11 10:01:00",
          fileName: "clip.h264",
          mediaType: "hls",
          protocol: "ts",
          targetSec: 42,
        },
      });

      assert.equal(playback.statusCode, 200);
      assert.equal(playback.body.ok, true);
      assert.equal(playback.body.transport, "rtsp-hls-relay");
      assert.equal(playback.body.playbackType, "hls");
      assert.equal(playback.body.durationSec, 60);
      assert.equal(playback.body.currentSec, 42);
      assert.equal(playback.body.url, "http://192.168.63.215:8000/api/replay-hls/hls-1/index.m3u8");
      assert.doesNotMatch(JSON.stringify(playback.body), /rtsp:\/\//);
    }
  );

  assert.deepEqual(hlsCalls, [
    {
      sourceUrl: "rtsp://example.test/replay.sdp",
      baseUrl: "http://192.168.63.215:8000",
      durationSec: 60,
      currentSec: 42,
      deviceSn: config.device.sn,
    },
  ]);
  assert.deepEqual(stoppedDevices, [config.device.sn]);
});

test("POST /api/devices/:sn/playback-url gives RTSP HLS sessions a cloud seek source", async () => {
  let seekSource = null;
  const playbackRequests = [];
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    stopSession: async () => false,
    stopDeviceSessions: async () => 0,
    attachHttpResponse: async () => {},
    createSession: async (options) => {
      seekSource = options.seekSource;
      return {
        ok: true,
        sessionId: "hls-cloud-seek",
        playUrl: `${options.baseUrl}/api/replay-hls/hls-cloud-seek/index.m3u8`,
        streamUrl: `${options.baseUrl}/api/replay-hls/hls-cloud-seek/index.m3u8`,
        durationSec: options.durationSec,
        currentSec: options.currentSec,
        playbackType: "hls",
        transport: "rtsp-hls-relay",
      };
    },
  });

  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = "token-cloud-seek";
        return this.deviceToken;
      },
      login: async () => ({ Ret: 100 }),
      getPlaybackUrl: async (record, options) => {
        playbackRequests.push(options);
        return `rtsp://example.test/replay-${options.startTime}.sdp`;
      },
    },
    async () => {
      const response = await request(
        makeApp(),
        `/api/devices/${encodeURIComponent(config.device.sn)}/playback-url`,
        {
          method: "POST",
          body: {
            beginTime: "2026-07-11 10:00:00",
            endTime: "2026-07-11 10:01:00",
            fileName: "clip.h264",
            targetSec: 0,
          },
        }
      );
      assert.equal(response.statusCode, 200);
      assert.equal(typeof seekSource, "function");

      const refreshed = await seekSource(24);
      assert.equal(refreshed.currentSec, 24);
      assert.equal(refreshed.durationSec, 60);
      assert.match(refreshed.sourceUrl, /10:00:24/);
    }
  );

  assert.equal(playbackRequests.length, 2);
  assert.equal(playbackRequests[0].startTime, "2026-07-11 10:00:00");
  assert.equal(playbackRequests[1].startTime, "2026-07-11 10:00:24");
});

test("POST /api/devices/:sn/playback-url can force an official HLS source into a seekable relay", async () => {
  let sessionOptions = null;
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    stopSession: async () => false,
    stopDeviceSessions: async () => 0,
    attachHttpResponse: async () => {},
    createSession: async (options) => {
      sessionOptions = options;
      return {
        ok: true,
        sessionId: "hls-forced-seek",
        playUrl: `${options.baseUrl}/api/replay-hls/hls-forced-seek/index.m3u8`,
        streamUrl: `${options.baseUrl}/api/replay-hls/hls-forced-seek/index.m3u8`,
        durationSec: options.durationSec,
        currentSec: options.currentSec,
        playbackType: "hls",
        transport: "hls-hls-relay",
      };
    },
  });

  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = "token-forced-seek";
        return this.deviceToken;
      },
      login: async () => ({ Ret: 100 }),
      getPlaybackUrl: async (record, options) => `https://example.test/replay-${encodeURIComponent(options.startTime)}.m3u8`,
    },
    async () => {
      const response = await request(
        makeApp(),
        `/api/devices/${encodeURIComponent(config.device.sn)}/playback-url`,
        {
          method: "POST",
          headers: {
            "x-forwarded-proto": "http",
            "x-forwarded-host": "192.168.63.215:8000",
          },
          body: {
            beginTime: "2026-07-11 10:00:00",
            endTime: "2026-07-11 10:01:00",
            fileName: "clip.h264",
            targetSec: 12,
            forceSeekableHls: true,
          },
        }
      );
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.sessionId, "hls-forced-seek");
      assert.equal(response.body.currentSec, 12);
      assert.equal(typeof sessionOptions.seekSource, "function");
      const refreshed = await sessionOptions.seekSource(35);
      assert.equal(refreshed.currentSec, 35);
      assert.match(refreshed.sourceUrl, /10%3A00%3A35/);
    }
  );
});

test("POST /api/devices/:sn/playback-url only uses native playback after explicit server opt-in", async () => {
  const nativeCalls = [];
  let hlsOptions = null;
  setReplayNativeClientFactoryForTests(({ deviceSn, lanHost }) => ({
    async startPlayback(options) {
      nativeCalls.push(["start", deviceSn, lanHost, options]);
    },
    async pausePlayback() {},
    async seekTo() {},
    async resumePlayback() {},
    async stopPlayback() {},
  }));
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    stopSession: async () => false,
    stopDeviceSessions: async () => 0,
    attachHttpResponse: async () => {},
    async createSession(options) {
      hlsOptions = options;
      await options.sourceController.start({ write() {}, onError() {}, onClose() {} });
      return {
        ok: true,
        sessionId: "native-hls-1",
        playUrl: `${options.baseUrl}/api/replay-hls/native-hls-1/index.m3u8`,
        streamUrl: `${options.baseUrl}/api/replay-hls/native-hls-1/index.m3u8`,
        durationSec: options.durationSec,
        currentSec: options.currentSec,
        playbackType: "hls",
        transport: options.transport,
      };
    },
  });

  const previousNativeLanEnabled = config.replay.nativeLanEnabled;
  config.replay.nativeLanEnabled = true;
  let playback;
  try {
    const app = makeApp();
    playback = await request(app, `/api/devices/${encodeURIComponent(config.device.sn)}/playback-url`, {
      method: "POST",
      headers: {
        "x-forwarded-proto": "http",
        "x-forwarded-host": "192.168.63.215:8000",
      },
      body: {
        beginTime: "2026-07-11 10:00:00",
        endTime: "2026-07-11 10:01:00",
        fileName: "clip.h264",
        durationSec: 60,
        targetSec: 12,
        lanHost: "192.168.63.88",
        videoFilter: "cute-v1",
      },
    });
  } finally {
    config.replay.nativeLanEnabled = previousNativeLanEnabled;
  }

  assert.equal(playback.statusCode, 200);
  assert.equal(playback.body.transport, "device-pri-hls-relay");
  assert.equal(playback.body.playbackType, "hls");
  assert.equal(hlsOptions.sourceUrl, undefined);
  assert.match(hlsOptions.videoFilter, /^curves=/);
  assert.equal(typeof hlsOptions.sourceController.seek, "function");
  assert.equal(nativeCalls[0][0], "start");
  assert.equal(nativeCalls[0][1], config.device.sn);
  assert.equal(nativeCalls[0][2], "192.168.63.88");
  assert.equal(nativeCalls[0][3].beginTime, "2026-07-11 10:00:00");
  assert.equal(nativeCalls[0][3].targetSec, 12);
});

test("POST /api/devices/:sn/replay-sessions uses filtered HLS instead of unfiltered FLV", async () => {
  const nativeCalls = [];
  let hlsOptions = null;
  setReplayNativeClientFactoryForTests(({ deviceSn, lanHost }) => ({
    async startPlayback(options) {
      nativeCalls.push(["start", deviceSn, lanHost, options]);
    },
    async pausePlayback() {},
    async seekTo() {},
    async resumePlayback() {},
    async stopPlayback() {},
  }));
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    stopSession: async () => false,
    stopDeviceSessions: async () => 0,
    attachHttpResponse: async () => {},
    async createSession(options) {
      hlsOptions = options;
      await options.sourceController?.start({ write() {}, onError() {}, onClose() {} });
      return {
        ok: true,
        sessionId: "filtered-replay-legacy",
        playUrl: `${options.baseUrl}/api/replay-hls/filtered-replay-legacy/index.m3u8`,
        streamUrl: `${options.baseUrl}/api/replay-hls/filtered-replay-legacy/index.m3u8`,
        durationSec: options.durationSec,
        currentSec: options.currentSec,
        playbackType: "hls",
        transport: options.transport,
      };
    },
  });

  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = "token-filtered-replay";
        return this.deviceToken;
      },
      login: async () => ({ Ret: 100 }),
      getPlaybackUrl: async () => "https://camera.test/replay.m3u8",
    },
    async () => {
      const response = await request(
        makeApp(),
        `/api/devices/${encodeURIComponent(config.device.sn)}/replay-sessions`,
        {
          method: "POST",
          body: {
            beginTime: "2026-07-11 10:00:00",
            endTime: "2026-07-11 10:01:00",
            fileName: "clip.h264",
            durationSec: 60,
            targetSec: 12,
            lanHost: "192.168.63.88",
            videoFilter: "cute-v1",
          },
        }
      );

      assert.equal(response.statusCode, 200);
      assert.equal(response.body.playbackType, "hls");
      assert.equal(typeof hlsOptions.sourceController, "object");
      assert.match(hlsOptions.videoFilter, /^curves=/);
      assert.equal(nativeCalls[0][0], "start");
    }
  );
});

test("POST /api/replay-sessions/:sessionId/seek controls an HLS-backed native session", async () => {
  const calls = [];
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    stopSession: async () => false,
    stopDeviceSessions: async () => 0,
    attachHttpResponse: async () => {},
    hasSession: (sessionId) => sessionId === "native-hls-1",
    getSessionMetadata: (sessionId) => sessionId === "native-hls-1"
      ? { deviceSn: config.device.sn, ownerOpenid: "openid-owner" }
      : null,
    async seekSession(sessionId, targetSec) {
      calls.push([sessionId, targetSec]);
      return {
        ok: true,
        sessionId,
        currentSec: targetSec,
        playUrl: `http://backend.test/api/replay-hls/${sessionId}/index.m3u8?v=1`,
      };
    },
  });

  const playback = await request(makeApp(), "/api/replay-sessions/native-hls-1/seek", {
    method: "POST",
    body: { targetSec: 24 },
  });
  const forbidden = await request(makeApp(), "/api/replay-sessions/native-hls-1/seek", {
    method: "POST",
    openid: "openid-other",
    body: { targetSec: 30 },
  });

  assert.equal(playback.statusCode, 200);
  assert.equal(playback.body.currentSec, 24);
  assert.match(playback.body.playUrl, /\?v=1$/);
  assert.deepEqual(calls, [["native-hls-1", 24]]);
  assert.equal(forbidden.statusCode, 404);
  assert.equal(forbidden.body.error, "REPLAY_SESSION_NOT_FOUND");
});

test("GET /api/replay-sessions/:sessionId/status exposes HLS recovery state to its owner", async () => {
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    stopSession: async () => false,
    stopDeviceSessions: async () => 0,
    attachHttpResponse: async () => {},
    getSessionMetadata: (sessionId) => sessionId === "recovering-hls-1"
      ? { deviceSn: config.device.sn, ownerOpenid: "openid-owner" }
      : null,
    getSessionStatus: (sessionId) => sessionId === "recovering-hls-1"
      ? {
        ok: true,
        sessionId,
        state: "recovering",
        generation: 1,
        currentSec: 18,
        playUrl: `http://backend.test/api/replay-hls/${sessionId}/index.m3u8?v=1`,
      }
      : null,
  });

  const status = await request(makeApp(), "/api/replay-sessions/recovering-hls-1/status");
  const forbidden = await request(makeApp(), "/api/replay-sessions/recovering-hls-1/status", {
    openid: "openid-other",
  });

  assert.equal(status.statusCode, 200);
  assert.equal(status.body.state, "recovering");
  assert.equal(status.body.generation, 1);
  assert.match(status.body.playUrl, /\?v=1$/);
  assert.equal(forbidden.statusCode, 404);
});

test("POST /api/devices/:sn/playback-url starts the replacement without an artificial release delay", async () => {
  const events = [];
  setReplayChannelReleaseDelayForTests(25, async (ms) => {
    events.push(["sleep", ms]);
  });
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    stopSession: async () => false,
    stopDeviceSessions: async (deviceSn) => {
      events.push(["stop", deviceSn]);
      return 1;
    },
    attachHttpResponse: async () => {},
    createSession: async () => {
      events.push(["createHls"]);
      return {
        ok: true,
        sessionId: "hls-wait",
        playUrl: "http://backend.test/api/replay-hls/hls-wait/index.m3u8",
        streamUrl: "http://backend.test/api/replay-hls/hls-wait/index.m3u8",
        durationSec: 20,
        currentSec: 0,
        playbackType: "hls",
        transport: "rtsp-hls-relay",
      };
    },
  });

  await withMockedDevice(
    {
      getToken: async function getToken() {
        this.deviceToken = "token-1";
        return "token-1";
      },
      login: async function login() {
        return { Ret: 100 };
      },
      getPlaybackUrl: async function getPlaybackUrl() {
        events.push(["getPlaybackUrl"]);
        return "rtsp://example.test/replay.sdp";
      },
    },
    async () => {
      const app = makeApp();
      const playback = await request(app, `/api/devices/${encodeURIComponent(config.device.sn)}/playback-url`, {
        method: "POST",
        body: {
          beginTime: "2026-07-11 10:00:00",
          endTime: "2026-07-11 10:00:20",
          fileName: "short-clip.h264",
          mediaType: "hls",
          protocol: "ts",
        },
      });

      assert.equal(playback.statusCode, 200);
    }
  );

  assert.deepEqual(events.slice(0, 3), [
    ["stop", config.device.sn],
    ["getPlaybackUrl"],
    ["createHls"],
  ]);
});

test("automation recovery tick requires its dedicated secret and starts both recovery paths", async () => {
  const originalAutomation = config.automation;
  const calls = [];
  config.automation = { ...originalAutomation, tickSecret: "automation-test-secret" };
  setFeedAnalysisCoordinator({
    async enqueueDueScans(date, options) {
      calls.push(["scan", date, options]);
      return {
        devices: 3,
        queued: 2,
        jobs: [
          { queued: true },
          { queued: true },
          { queued: false, skipped: true },
        ],
      };
    },
    getQueueStatus() {
      return { pending: 1, running: 1 };
    },
  });
  setFoodcastAutomationService({
    async reconcile() {
      calls.push("foodcast");
      return [];
    },
  });

  try {
    const missing = await request(makeApp(), "/api/internal/automation/tick", {
      method: "POST",
      auth: false,
      body: {},
    });
    const rejected = await request(makeApp(), "/api/internal/automation/tick", {
      method: "POST",
      auth: false,
      headers: { "x-automation-tick-secret": "wrong-secret" },
      body: {},
    });
    const accepted = await request(makeApp(), "/api/internal/automation/tick", {
      method: "POST",
      auth: false,
      headers: { "x-automation-tick-secret": "automation-test-secret" },
      body: {},
    });

    assert.equal(missing.statusCode, 403);
    assert.deepEqual(missing.body, { ok: false, error: "AUTOMATION_TICK_FORBIDDEN" });
    assert.equal(rejected.statusCode, 403);
    assert.deepEqual(rejected.body, { ok: false, error: "AUTOMATION_TICK_FORBIDDEN" });
    assert.equal(accepted.statusCode, 202);
    assert.deepEqual(accepted.body, {
      ok: true,
      scanDevices: 3,
      scanQueued: 2,
      scanSkipped: 1,
      scanCoalesced: 0,
      scanQueue: { pending: 1, running: 1 },
      foodcastTriggered: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [["scan", "", { waitForDiscovery: false }], "foodcast"]);
  } finally {
    config.automation = originalAutomation;
  }
});

test("feed analysis status exposes PushPlus health without secrets", async () => {
  setFeedAnalysisCoordinator({
    store: {
      getSettings() {
        return { analysisEnabled: true, notifyEnabled: true };
      },
    },
    getNotificationStatus() {
      return {
        provider: "pushplus",
        configured: true,
        status: "accepted",
        lastSuccessAt: 123,
        token: "must-not-leak",
      };
    },
  });

  const response = await request(makeApp(), "/api/feed-analysis/status");
  const forbidden = await request(makeApp(), "/api/feed-analysis/status", {
    openid: "openid-other",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(forbidden.statusCode, 404);
  assert.equal(forbidden.body.error, "DEVICE_NOT_FOUND");
  assert.deepEqual(response.body.notificationProvider, {
    provider: "pushplus",
    configured: true,
    status: "accepted",
    lastSuccessAt: 123,
  });
  assert.doesNotMatch(response.raw, /must-not-leak/);
});

test("POST /api/devices/:sn/playback-url reuses a warm recording before touching the device channel", async () => {
  let reuseOptions = null;
  setReplayHlsManagerForTests({
    cleanupExpired: async () => 0,
    attachHttpResponse: async () => {},
    reuseSession(options) {
      reuseOptions = options;
      return {
        ok: true,
        sessionId: "warm-hls",
        playUrl: "http://backend.test/api/replay-hls/warm-hls/index.m3u8",
        streamUrl: "http://backend.test/api/replay-hls/warm-hls/index.m3u8",
        playbackType: "hls",
        transport: "rtsp-hls-remux",
        reused: true,
      };
    },
    stopDeviceSessions() {
      throw new Error("warm replay must not stop the active session");
    },
  });

  const playback = await request(
    makeApp(),
    `/api/devices/${encodeURIComponent(config.device.sn)}/playback-url`,
    {
      method: "POST",
      body: {
        beginTime: "2026-07-11 10:00:00",
        endTime: "2026-07-11 10:01:00",
        fileName: "clip.h264",
        targetSec: 0,
      },
    }
  );

  assert.equal(playback.statusCode, 200);
  assert.equal(playback.body.reused, true);
  assert.equal(reuseOptions.deviceSn, config.device.sn);
  assert.equal(reuseOptions.ownerOpenid, "openid-owner");
  assert.match(reuseOptions.reuseKey, /^[a-f0-9]{32}$/);
});

test("internal feeding activity test requires its dedicated token and returns a reviewable bundle", async () => {
  const calls = [];
  setFeedingActivityTestServiceForTests({
    async analyze(input) {
      calls.push(input);
      return {
        jobId: "job-1",
        fileName: "meal.mp4",
        orientation: "clockwise-90",
        analyzedDurationSec: 120,
        elapsedMs: 900,
        summary: {
          hasCat: true, hasFeeding: true, analysisConfidence: 0.8,
          candidateSeconds: 8, verifiedSeconds: 6, maxConfidence: 0.9,
          rejectionReasons: {}, framesSampled: 20, durationMs: 800,
          detectorBackend: "yolo", detectorError: "", error: "",
        },
        artifacts: [{ name: "annotated.mp4", sizeBytes: 123 }],
      };
    },
  });
  const app = makeApp();
  const unauthorized = await request(app, "/api/internal/feeding-activity-test", {
    method: "POST", auth: false, headers: { "x-feed-analysis-test-token": "wrong" },
    body: { fileName: "meal.mp4" },
  });
  const accepted = await request(app, "/api/internal/feeding-activity-test", {
    method: "POST", auth: false,
    headers: { "x-feed-analysis-test-token": process.env.FEED_ANALYSIS_TEST_TOKEN },
    body: { fileName: "meal.mp4", durationSec: 120, detectorBackend: "yolo" },
  });

  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.body.error, "FEED_ANALYSIS_TEST_UNAUTHORIZED");
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.summary.hasFeeding, true);
  assert.equal(Object.hasOwn(accepted.body.summary, "frames"), false);
  assert.equal(Object.hasOwn(accepted.body.summary, "markers"), false);
  assert.equal(accepted.body.artifacts[0].downloadPath, "/api/internal/feeding-activity-test/job-1/annotated.mp4");
  assert.deepEqual(calls, [{
    fileName: "meal.mp4", durationSec: 120, detectorBackend: "yolo", autoBowlDetection: undefined,
  }]);
});

test("internal feeding activity test maps service validation errors without leaking details", async () => {
  setFeedingActivityTestServiceForTests({
    async analyze() {
      const error = new Error("private filesystem path");
      error.code = "FEED_ANALYSIS_TEST_FILE_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    },
  });
  const response = await request(makeApp(), "/api/internal/feeding-activity-test", {
    method: "POST", auth: false,
    headers: { "x-feed-analysis-test-token": process.env.FEED_ANALYSIS_TEST_TOKEN },
    body: { fileName: "missing.mp4" },
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { ok: false, error: "FEED_ANALYSIS_TEST_FILE_NOT_FOUND" });
  assert.doesNotMatch(response.raw, /private filesystem path/);
});

test("feed analysis status scopes queue state to the authorized active device", async () => {
  const requestedDeviceSns = [];
  setFeedAnalysisCoordinator({
    store: {
      getSettings() {
        return { analysisEnabled: true, notifyEnabled: true };
      },
    },
    getQueueStatus(deviceSn) {
      requestedDeviceSns.push(deviceSn);
      return {
        pending: 5,
        running: 2,
        globalConcurrency: 2,
        oldestPendingMs: 301_000,
        activeDevice: { pending: 1, running: false },
      };
    },
  });

  const response = await request(makeApp(), "/api/feed-analysis/status");

  assert.equal(response.statusCode, 200);
  assert.deepEqual(requestedDeviceSns, ["SN001"]);
  assert.deepEqual(response.body.queueStatus.activeDevice, { pending: 1, running: false });
  assert.doesNotMatch(response.raw, /SN002|recordingKey|clip-/);
});

test("feed analysis can send a manual PushPlus test notification", async () => {
  const calls = [];
  setFeedAnalysisCoordinator({
    store: {
      getSettings() {
        return { analysisEnabled: false, notifyEnabled: false };
      },
    },
    async sendTestNotification() {
      calls.push("send");
      return { ok: true, messageId: "test-message-1" };
    },
  });

  const response = await request(makeApp(), "/api/feed-analysis/notifications/test", {
    method: "POST",
    body: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, messageId: "test-message-1" });
  assert.deepEqual(calls, ["send"]);
});

test("feed analysis exposes a sanitized per-user PushPlus binding setup", async () => {
  const calls = [];
  setFeedAnalysisCoordinator({
    canDeliverNotificationTo(openid) {
      return openid === "openid-owner";
    },
    async getPushPlusBindingStatus(openid) {
      calls.push(openid);
      return {
        configured: true,
        bound: false,
        friendQrCode: "binding-code-1",
        friendQrSourceUrl: "https://must-not-leak.example/friend.png",
        expiresAt: 123456,
      };
    },
  });

  const response = await request(
    makeApp(),
    "/api/feed-analysis/notifications/binding?openid=openid-1"
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ["openid-owner"]);
  assert.deepEqual(response.body, {
    ok: true,
    configured: true,
    bound: false,
    deliveryReady: true,
    expiresAt: 123456,
    serviceQrImageUrl: "/api/feed-analysis/notifications/service-qr-image",
    friendQrImageUrl:
      "/api/feed-analysis/notifications/friend-qr-image?code=binding-code-1",
  });
  assert.doesNotMatch(response.raw, /must-not-leak|friendToken|secret/i);
});

test("PushPlus callback requires the configured callback secret and binds the friend", async () => {
  const previousSecret = config.pushPlus.callbackSecret;
  config.pushPlus.callbackSecret = "callback-secret";
  const calls = [];
  setFeedAnalysisCoordinator({
    handlePushPlusCallback(payload) {
      calls.push(payload);
      return { ok: true };
    },
  });
  try {
    const denied = await request(makeApp(), "/api/feed-analysis/notifications/pushplus-callback?key=wrong", {
      method: "POST",
      body: { event: "add_friend", qrCode: "code-1", friendInfo: { token: "friend-1" } },
    });
    const accepted = await request(
      makeApp(),
      "/api/feed-analysis/notifications/pushplus-callback?key=callback-secret",
      {
        method: "POST",
        body: { event: "add_friend", qrCode: "code-1", friendInfo: { token: "friend-1" } },
      }
    );

    assert.equal(denied.statusCode, 403);
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.body, { code: 200, msg: "success" });
    assert.equal(calls.length, 1);
  } finally {
    config.pushPlus.callbackSecret = previousSecret;
  }
});

test("manual PushPlus test ignores a caller-provided OpenID", async () => {
  const calls = [];
  setFeedAnalysisCoordinator({
    async sendTestNotification(openid) {
      calls.push(openid);
      return { ok: true, messageId: "test-message-user" };
    },
  });

  const response = await request(makeApp(), "/api/feed-analysis/notifications/test", {
    method: "POST",
    body: { openid: "openid-target" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ["openid-owner"]);
});

test("PushPlus service QR proxy uses the official-site referer required by the image host", async () => {
  const previousFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/jpeg" },
      async arrayBuffer() {
        return Buffer.from("qr-image");
      },
    };
  };
  setFeedAnalysisCoordinator({
    getPushPlusQrSourceUrl() {
      return "https://image.pushplus.plus/pc/image/pushplus_mp.jpg";
    },
  });
  try {
    const response = await request(
      makeApp(),
      "/api/feed-analysis/notifications/service-qr-image"
    );

    assert.equal(response.statusCode, 200);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.Referer, "https://www.pushplus.plus/");
  } finally {
    global.fetch = previousFetch;
  }
});
