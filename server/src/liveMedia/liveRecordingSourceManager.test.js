const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const { LiveRecordingSourceManager } = require("./liveRecordingSourceManager");

test("recording sources expose only an opaque session while retaining the direct stream server-side", async () => {
  let now = 1000;
  let releases = 0;
  const manager = new LiveRecordingSourceManager({
    now: () => now,
    idFactory: () => "record-source-1",
    tokenFactory: () => "relay-access-1",
    ttlMs: 5000,
  });
  const created = manager.createSource({
    ownerOpenid: "owner-1",
    deviceSn: "SN-1",
    playUrl: "https://camera.test/live/index.m3u8?token=secret",
    httpProxy: "http://127.0.0.1:7897",
    relayBaseUrl: "http://192.168.8.25:8000",
    releaseSource: async () => { releases += 1; },
  });

  assert.deepEqual(created, {
    ok: true,
    sessionId: "record-source-1",
    transport: "official-hls-recording-source",
    recordingSource: true,
  });
  assert.equal(JSON.stringify(created).includes("camera.test"), false);
  assert.deepEqual(manager.getSessionMetadata("record-source-1"), {
    sessionId: "record-source-1",
    ownerOpenid: "owner-1",
    deviceSn: "SN-1",
    live: true,
    createdAt: 1000,
  });
  assert.equal(
    manager.getSessionDescriptor("record-source-1").playUrl,
    "http://192.168.8.25:8000/api/live-recording-sources/"
      + "record-source-1/index.m3u8?access=relay-access-1"
  );
  assert.equal(manager.getSessionDescriptor("record-source-1").playUrl.includes("camera.test"), false);
  assert.equal(manager.getSessionDescriptor("record-source-1").httpProxy, "");

  now += 5000;
  assert.equal(await manager.cleanupExpired(), 1);
  assert.equal(releases, 1);
  assert.equal(await manager.stopSession("record-source-1"), false);
  assert.equal(releases, 1);
});

test("recording source relay fetches through the proxy and hides upstream playlist URLs", async () => {
  const upstreamCalls = [];
  const manager = new LiveRecordingSourceManager({
    idFactory: () => "record-source-2",
    tokenFactory: () => "relay-access-2",
    openUpstream: async (targetUrl, options) => {
      upstreamCalls.push({ targetUrl, options });
      const response = Readable.from([
        "#EXTM3U\n",
        "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n",
        "#EXTINF:2,\nsegment-1.ts\n",
      ]);
      response.statusCode = 200;
      response.headers = { "content-type": "application/vnd.apple.mpegurl" };
      return { response, finalUrl: targetUrl };
    },
  });
  manager.createSource({
    ownerOpenid: "owner-2",
    deviceSn: "SN-2",
    playUrl: "https://camera.test:9011/live/index.m3u8?token=secret",
    httpProxy: "http://127.0.0.1:7897",
    relayBaseUrl: "http://127.0.0.1:8000",
  });
  const result = { statusCode: 0, headers: {}, body: "" };
  const res = {
    status(code) {
      result.statusCode = code;
      return this;
    },
    set(name, value) {
      if (typeof name === "object") Object.assign(result.headers, name);
      else result.headers[name] = value;
      return this;
    },
    end(value) {
      result.body = String(value || "");
    },
  };
  await manager.attachHttpResponse(
    "record-source-2",
    "index.m3u8",
    { query: { access: "relay-access-2" }, get: () => "" },
    res
  );

  assert.equal(result.statusCode, 200);
  assert.equal(upstreamCalls[0].targetUrl.includes("token=secret"), true);
  assert.equal(upstreamCalls[0].options.proxyUrl, "http://127.0.0.1:7897");
  assert.equal(result.body.includes("camera.test"), false);
  assert.equal(result.body.includes("token=secret"), false);
  assert.match(result.body, /asset-[A-Za-z0-9_-]+\.bin\?access=relay-access-2/);
  assert.equal((result.body.match(/access=relay-access-2/g) || []).length, 2);
  await assert.rejects(
    () => manager.attachHttpResponse(
      "record-source-2",
      "index.m3u8",
      { query: { access: "wrong" }, get: () => "" },
      res
    ),
    /RECORDING_SOURCE_NOT_FOUND/
  );
});

test("manifest-only replay sources cache a completed VOD playlist while media stays direct", async () => {
  let upstreamCalls = 0;
  const manager = new LiveRecordingSourceManager({
    idFactory: () => "vod-manifest-1",
    tokenFactory: () => "vod-access-1",
    openUpstream: async (targetUrl) => {
      upstreamCalls += 1;
      const response = Readable.from([
        "#EXTM3U\n",
        "#EXT-X-TARGETDURATION:2\n",
        "#EXTINF:2,\nsegment-1.ts?token=media-secret\n",
        "#EXT-X-ENDLIST\n",
      ]);
      response.statusCode = 200;
      response.headers = { "content-type": "application/vnd.apple.mpegurl" };
      return { response, finalUrl: targetUrl };
    },
  });
  manager.createSource({
    ownerOpenid: "owner-vod",
    deviceSn: "SN-VOD",
    playUrl: "https://camera.test/replay/index.m3u8?token=playlist-secret",
    relayBaseUrl: "https://mini-api.example.test",
    relayMode: "manifest",
    vodPlaylist: true,
    live: false,
  });
  const makeResponse = () => {
    const result = { statusCode: 0, headers: {}, body: "" };
    return {
      result,
      status(code) { result.statusCode = code; return this; },
      set(name, value) {
        if (typeof name === "object") Object.assign(result.headers, name);
        else result.headers[name] = value;
        return this;
      },
      end(value) { result.body = String(value || ""); },
    };
  };
  const req = { query: { access: "vod-access-1" }, get: () => "" };
  const first = makeResponse();
  await manager.attachHttpResponse("vod-manifest-1", "index.m3u8", req, first);
  const second = makeResponse();
  await manager.attachHttpResponse("vod-manifest-1", "index.m3u8", req, second);

  assert.equal(upstreamCalls, 1);
  assert.equal(manager.getSessionMetadata("vod-manifest-1").live, false);
  assert.match(first.result.body, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(first.result.body, /https:\/\/camera\.test\/replay\/segment-1\.ts\?token=media-secret/);
  assert.equal(first.result.body.includes("api/live-recording-sources/vod-manifest-1/asset-"), false);
  assert.equal(second.result.body, first.result.body);
  assert.equal(second.result.headers["Cache-Control"], "private, max-age=300, immutable");
});

test("device playback cleanup stops only non-live sources and releases their vendor channel", async () => {
  let releases = 0;
  let id = 0;
  const manager = new LiveRecordingSourceManager({
    idFactory: () => `source-${++id}`,
    tokenFactory: () => `token-${id}`,
  });
  manager.createSource({
    ownerOpenid: "owner-a",
    deviceSn: "SN-1",
    playUrl: "https://camera.test/live.m3u8",
    live: true,
    releaseSource: async () => { releases += 100; },
  });
  manager.createSource({
    ownerOpenid: "owner-a",
    deviceSn: "SN-1",
    playUrl: "https://camera.test/replay-a.m3u8",
    live: false,
    releaseSource: async () => { releases += 1; },
  });
  manager.createSource({
    ownerOpenid: "owner-b",
    deviceSn: "SN-2",
    playUrl: "https://camera.test/replay-b.m3u8",
    live: false,
    releaseSource: async () => { releases += 10; },
  });

  assert.equal(await manager.stopDeviceSessions("SN-1", { live: false }), 1);
  assert.equal(releases, 1);
  assert.equal(manager.hasSession("source-1"), true);
  assert.equal(manager.hasSession("source-2"), false);
  assert.equal(manager.hasSession("source-3"), true);
});
