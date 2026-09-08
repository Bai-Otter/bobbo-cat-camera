const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isLivePlaybackDiagnosticDevice,
  normalizeLivePlaybackEvent,
  probeLiveDevice,
  verifyHlsMedia,
} = require("./livePlaybackDiagnostics");

test("live playback events accept only sanitized diagnostic fields", () => {
  assert.deepEqual(normalizeLivePlaybackEvent({
    sessionId: "live-session_12345678",
    event: "device_login_failed",
    source: "SDK",
    errorCode: "code: 4101 / Device offline",
    deviceToken: "must-not-survive",
    url: "https://secret.example/live.m3u8",
  }), {
    sessionId: "live-session_12345678",
    event: "device_login_failed",
    source: "sdk",
    errorCode: "CODE__4101___DEVICE_OFFLINE",
  });
  assert.throws(
    () => normalizeLivePlaybackEvent({ sessionId: "short", event: "video_play", source: "player" }),
    { code: "LIVE_PLAYBACK_SESSION_INVALID" }
  );
  assert.throws(
    () => normalizeLivePlaybackEvent({ sessionId: "live-session_12345678", event: "token_dump", source: "sdk" }),
    { code: "LIVE_PLAYBACK_EVENT_INVALID" }
  );
});

test("diagnostic targeting is disabled unless the exact serial number matches", () => {
  assert.equal(isLivePlaybackDiagnosticDevice("SN-1", "SN-1"), true);
  assert.equal(isLivePlaybackDiagnosticDevice("SN-2", "SN-1"), false);
  assert.equal(isLivePlaybackDiagnosticDevice("SN-1", ""), false);
});

test("HLS verification reads a playlist and real media bytes without exposing URLs", async () => {
  const calls = [];
  const result = await verifyHlsMedia("https://camera.example/live/index.m3u8", {
    attempts: 1,
    pollDelayMs: 0,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, range: options.headers && options.headers.Range });
      if (String(url).endsWith(".m3u8")) {
        return { ok: true, status: 200, text: async () => "#EXTM3U\n#EXTINF:2,\nsegment-1.ts\n" };
      }
      return {
        ok: true,
        status: 206,
        body: {
          getReader() {
            return {
              read: async () => ({ done: false, value: new Uint8Array([0x47, 1, 2, 3]) }),
              cancel: async () => {},
            };
          },
        },
      };
    },
  });
  assert.deepEqual(result, { playlistReady: true, segmentReady: true, segmentBytesRead: 4 });
  assert.deepEqual(calls, [
    { url: "https://camera.example/live/index.m3u8", range: undefined },
    { url: "https://camera.example/live/segment-1.ts", range: "bytes=0-4095" },
  ]);
});

test("live probe separates device status, login, stream and media readiness", async () => {
  const calls = [];
  const device = {
    sn: "SN-1",
    ensureDeviceToken: async () => calls.push("token"),
    status: async () => ({ status: "online", authStatus: 1, channel: [{ id: 0 }] }),
    login: async () => calls.push("login"),
    getLivestreamUrl: async () => "https://camera.example/live/index.m3u8",
    closeLivestream: async () => calls.push("close"),
  };
  const result = await probeLiveDevice({
    device,
    attempts: 1,
    pollDelayMs: 0,
    fetchImpl: async (url) => String(url).endsWith(".m3u8")
      ? { ok: true, status: 200, text: async () => "#EXTM3U\nsegment.ts\n" }
      : {
          ok: true,
          status: 206,
          body: { getReader: () => ({ read: async () => ({ value: new Uint8Array([0x47]) }), cancel: async () => {} }) },
        },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.status, { status: "online", authStatus: 1, channelCount: 1 });
  assert.equal(result.mediaReady, true);
  assert.equal(result.streamClosed, true);
  assert.deepEqual(calls, ["token", "login", "close"]);
  assert.equal(JSON.stringify(result).includes("camera.example"), false);
});

test("offline live probe returns only a safe vendor error code", async () => {
  const result = await probeLiveDevice({
    device: {
      sn: "SN-1",
      ensureDeviceToken: async () => {},
      status: async () => ({ status: "notfound" }),
      login: async () => {
        throw new Error('device login failed: {"code":4101,"msg":"Device offline","token":"secret"}');
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status.status, "notfound");
  assert.equal(result.errorCode, "4101");
  assert.doesNotMatch(JSON.stringify(result), /secret|Device offline/);
});
