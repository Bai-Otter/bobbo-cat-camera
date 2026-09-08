const test = require("node:test");
const assert = require("node:assert/strict");

const {
  COVER_STALE_MS,
  buildDeviceCards,
  buildLivestreamPlan,
  classifyLivestreamFailure,
  isTransientLivestreamFailure,
  shouldFallbackToSdkLive,
  shouldPromptTimeSync,
  getTimeDriftSeconds,
  buildOwnedDeviceCards,
  canUseDirectLiveSdk,
  selectDirectLiveSdkDevices,
} = require("./deviceMediaState.js");

test("device lists prefetch direct SDK tokens only for owned devices", () => {
  const owner = { sn: "OWNER-1", role: "owner" };
  const sharedLive = { sn: "SHARED-1", role: "member", permissions: ["live", "replay"] };
  const sharedReplayOnly = { sn: "SHARED-2", role: "member", permissions: ["replay"] };

  assert.equal(canUseDirectLiveSdk(owner, { sharedAccessFresh: false }), true);
  assert.equal(canUseDirectLiveSdk(sharedLive, { sharedAccessFresh: false }), false);
  assert.equal(canUseDirectLiveSdk(sharedLive, { sharedAccessFresh: true }), false);
  assert.equal(canUseDirectLiveSdk(sharedReplayOnly, { sharedAccessFresh: true }), false);
  assert.deepEqual(
    selectDirectLiveSdkDevices([owner, sharedLive, sharedReplayOnly], { sharedAccessFresh: true }).map((item) => item.sn),
    ["OWNER-1"]
  );
});

test("buildDeviceCards merges cloud cover info into device cards", () => {
  const cards = buildDeviceCards({
    devices: [
      { sn: "SN001", nickname: "客厅猫眼", token: "tok-1", _online: true },
      { sn: "SN002", nickname: "厨房猫眼", token: "", _online: false },
    ],
    coversBySn: {
      SN001: {
        coverUrl: "https://example.test/sn001.jpg",
        capturedAt: 1710000000000,
        updatedAt: 1710000001000,
      },
    },
    now: 1710000001000,
  });

  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    sn: "SN001",
    nickname: "客厅猫眼",
    token: "tok-1",
    _online: true,
    coverUrl: "https://example.test/sn001.jpg",
    coverUpdatedAt: 1710000001000,
    isCoverStale: false,
    streamReadyState: "ready",
  });
  assert.equal(cards[1].coverUrl, "");
  assert.equal(cards[1].streamReadyState, "idle");
});

test("buildDeviceCards marks a cover stale when it is older than the configured threshold", () => {
  const cards = buildDeviceCards({
    devices: [{ sn: "SN001", token: "tok-1", _online: true }],
    coversBySn: {
      SN001: {
        coverUrl: "https://example.test/sn001.jpg",
        updatedAt: 1710000000000,
      },
    },
    now: 1710000000000 + COVER_STALE_MS + 1,
  });

  assert.equal(cards[0].isCoverStale, true);
});

test("buildDeviceCards preserves the last known cover when cloud refresh is unavailable", () => {
  const cards = buildDeviceCards({
    devices: [{
      sn: "SN001",
      token: "tok-1",
      coverUrl: "https://cached.test/sn001.jpg",
      coverUpdatedAt: 1710000000000,
    }],
    coversBySn: {},
    now: 1710000001000,
  });

  assert.equal(cards[0].coverUrl, "https://cached.test/sn001.jpg");
  assert.equal(cards[0].coverUpdatedAt, 1710000000000);
});

test("buildOwnedDeviceCards keeps backend-owned devices and enriches them with SDK state and covers", () => {
  const cards = buildOwnedDeviceCards({
    devices: [
      {
        sn: "SN001",
        nickname: "Kitchen cam",
        username: "admin",
        deviceToken: "backend-token-1",
        password: "pw",
        adminToken: "admin-token",
      },
      { sn: "SN002", nickname: "Desk cam", username: "admin" },
    ],
    tokenRows: [
      { sn: "SN002", token: "sdk-token-2" },
      { sn: "SN404", token: "sdk-token-404" },
    ],
    statusRows: [
      { uuid: "SN001", status: "online" },
      { sn: "SN002", status: "offLine" },
      { sn: "SN404", status: "online" },
    ],
    coversBySn: {
      SN001: {
        coverUrl: "https://example.test/sn001.jpg",
        updatedAt: 1710000000000,
      },
    },
    now: 1710000000000,
  });

  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((item) => item.sn), ["SN001", "SN002"]);
  assert.equal(cards[0].token, "backend-token-1");
  assert.equal(cards[0].deviceToken, "backend-token-1");
  assert.equal(cards[0]._online, true);
  assert.equal(cards[0].coverUrl, "https://example.test/sn001.jpg");
  assert.equal(cards[0].password, undefined);
  assert.equal(cards[0].adminToken, undefined);
  assert.equal(cards[1].token, "sdk-token-2");
  assert.equal(cards[1]._online, false);
});

test("a fresh offline SDK status overrides a cached online state", () => {
  const [card] = buildOwnedDeviceCards({
    devices: [{ sn: "SN001", _online: true }],
    statusRows: [{ sn: "SN001", status: "offLine" }],
  });

  assert.equal(card._online, false);
  assert.equal(card.status.status, "offLine");
});

test("buildLivestreamPlan skips low-latency candidates for mp-weixin and keeps hls-ts fallback", () => {
  const plan = buildLivestreamPlan({
    platform: "mp-weixin",
    quality: "0",
    username: "admin",
    password: "pw",
  });

  assert.deepEqual(plan.primary, {
    key: "hls-ts",
    mediaType: "hls",
    protocol: "ts",
    stream: "0",
    channel: "0",
    username: "admin",
    password: "pw",
  });
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.fallback.key, "hls-ts");
});

test("classifyLivestreamFailure separates token, login, stream and playback failures", () => {
  assert.equal(classifyLivestreamFailure("missing-token"), "missing-token");
  assert.equal(classifyLivestreamFailure("device-login"), "device-login");
  assert.equal(classifyLivestreamFailure("requesting-stream"), "stream-request");
  assert.equal(classifyLivestreamFailure("playing"), "playback");
});

test("shouldFallbackToSdkLive only retries a failed backend stream once with a device token", () => {
  assert.equal(
    shouldFallbackToSdkLive({ source: "backend", deviceToken: "device-token", attempted: false }),
    true
  );
  assert.equal(
    shouldFallbackToSdkLive({ source: "backend", deviceToken: "device-token", attempted: true }),
    false
  );
  assert.equal(
    shouldFallbackToSdkLive({ source: "sdk", deviceToken: "device-token", attempted: false }),
    false
  );
  assert.equal(
    shouldFallbackToSdkLive({ source: "backend", deviceToken: "", attempted: false }),
    false
  );
});

test("isTransientLivestreamFailure recognizes only xmts route timeouts", () => {
  assert.equal(
    isTransientLivestreamFailure({ code: -99991, msg: "Time out [xmts hittest failed]" }),
    true
  );
  assert.equal(
    isTransientLivestreamFailure({ data: { code: -99991, msg: "xmts hittest failed" } }),
    true
  );
  assert.equal(isTransientLivestreamFailure({ code: 29013, msg: "device is offline" }), false);
  assert.equal(isTransientLivestreamFailure(new Error("livestream timeout")), false);
});

test("time drift helpers only prompt once the 2 minute threshold is exceeded", () => {
  const nowMs = new Date(2026, 6, 4, 12, 2, 0).getTime();
  const deviceIso = "2026-07-04 12:00:00";

  assert.equal(getTimeDriftSeconds(deviceIso, nowMs), 120);
  assert.equal(
    shouldPromptTimeSync({
      deviceTime: deviceIso,
      nowMs,
      promptShown: false,
      thresholdSeconds: 120,
    }),
    false
  );
  assert.equal(
    shouldPromptTimeSync({
      deviceTime: deviceIso,
      nowMs: nowMs + 1000,
      promptShown: false,
      thresholdSeconds: 120,
    }),
    true
  );
  assert.equal(
    shouldPromptTimeSync({
      deviceTime: deviceIso,
      nowMs: nowMs + 1000,
      promptShown: true,
      thresholdSeconds: 120,
    }),
    false
  );
});

test("time drift helpers prompt by default only after 2 minutes is exceeded", () => {
  const baseMs = new Date(2026, 6, 4, 12, 0, 0).getTime();
  const deviceIso = "2026-07-04 12:00:00";

  assert.equal(
    shouldPromptTimeSync({
      deviceTime: deviceIso,
      nowMs: baseMs + 120000,
      promptShown: false,
    }),
    false
  );
  assert.equal(
    shouldPromptTimeSync({
      deviceTime: deviceIso,
      nowMs: baseMs + 121000,
      promptShown: false,
    }),
    true
  );
  assert.equal(
    shouldPromptTimeSync({
      deviceTime: deviceIso,
      nowMs: baseMs + 121000,
      promptShown: true,
    }),
    false
  );
});

test("getTimeDriftSeconds treats device timestamp strings as local wall-clock time", () => {
  const nowMs = new Date(2026, 6, 4, 18, 20, 0).getTime();
  const deviceIso = "2026-07-04 18:20:19";

  assert.equal(getTimeDriftSeconds(deviceIso, nowMs), 19);
});

test("extractDeviceTime finds nested OPTimeQuery values", () => {
  const { extractDeviceTime } = require("./deviceMediaState.js");

  assert.equal(
    extractDeviceTime({
      code: 2000,
      data: {
        Ret: 100,
        OPTimeQuery: {
          Time: "2026-07-04 18:20:19",
        },
      },
    }),
    "2026-07-04 18:20:19"
  );
});

test("buildTimeSyncPayload creates local and UTC device time payloads", () => {
  const { buildTimeSyncPayload } = require("./deviceMediaState.js");
  const date = new Date(2026, 6, 4, 18, 20, 19);

  assert.deepEqual(buildTimeSyncPayload("local", date), {
    Name: "OPTimeSetting",
    OPTimeSetting: "2026-07-04 18:20:19",
  });
  assert.deepEqual(buildTimeSyncPayload("utc", date), {
    Name: "OPUTCTimeSetting",
    OPUTCTimeSetting: "2026-07-04 18:20:19",
  });
});
