const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createDefaultLiveMediaServices } = require("./factory");

function fakeRoutes() {
  return {
    authenticateMediaControl() { return { openid: "owner" }; },
    async resolveOwnedMediaDevice(openid, sn) { return { ownerOpenid: openid, sn }; },
    async resolveOwnedLiveSession(openid, sn) {
      return { ownerOpenid: openid, deviceSn: sn, live: true, playUrl: "https://backend.test/live.m3u8" };
    },
    async resolveOwnedTalkbackUrl() { return "rtmp://camera.test/talk"; },
    async resolveOwnedRecordingLiveSource() { return "https://camera.test/second-live.m3u8"; },
  };
}

test("local live-media factory shares durable storage and recovers interrupted jobs", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-media-factory-"));
  const stateFile = path.join(rootDir, "live-recordings.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    jobs: [{
      id: "record-1",
      ownerOpenid: "owner",
      deviceSn: "SN-1",
      status: "recording",
      accessToken: "token",
      createdAt: 10,
      updatedAt: 10,
    }],
  }));
  const services = createDefaultLiveMediaServices({
    config: {
      cloudHosting: false,
      replay: { ffmpegPath: "ffmpeg" },
      liveMedia: {
        stateFile,
        tempDir: path.join(rootDir, "temp"),
        outputDir: path.join(rootDir, "media"),
        collection: "cat_live_recordings",
        maxDurationSec: 300,
      },
    },
    routes: fakeRoutes(),
    logger: { warn() {} },
  });

  assert.equal(services.gateway.constructor.name, "MediaControlGateway");
  assert.equal(services.store.constructor.name, "LiveRecordingStore");
  assert.equal(services.mediaStorage.constructor.name, "LocalMediaStorage");
  assert.equal(await services.initialize(), 1);
  assert.equal((await services.store.getOwnedJob("owner", "record-1")).status, "failed");
});

test("Cloud Hosting live-media factory initializes metadata before recovery", async () => {
  const collection = { get: async () => ({ data: [] }) };
  const created = [];
  const app = {
    database() {
      return {
        async createCollection(name) { created.push(name); },
        collection: (name) => {
          assert.equal(name, "live-recordings-test");
          return collection;
        },
      };
    },
  };
  const initCalls = [];
  const services = createDefaultLiveMediaServices({
    config: {
      cloudHosting: true,
      cloudbaseEnvId: "env-test",
      cloudbaseCredentials: { secretId: "id", secretKey: "key" },
      replay: { ffmpegPath: "ffmpeg" },
      liveMedia: {
        stateFile: "unused.json",
        tempDir: "C:/temp/live-media",
        outputDir: "C:/temp/media",
        collection: "live-recordings-test",
        maxDurationSec: 300,
      },
    },
    routes: fakeRoutes(),
    cloudbase: {
      init(options) {
        initCalls.push(options);
        return app;
      },
    },
  });

  assert.deepEqual(initCalls, [{ env: "env-test", secretId: "id", secretKey: "key" }]);
  assert.equal(services.store.constructor.name, "CloudLiveRecordingStore");
  assert.equal(services.mediaStorage.constructor.name, "CloudMediaStorage");
  assert.equal(await services.initialize(), 0);
  assert.deepEqual(created, ["live-recordings-test"]);
});

test("live-media factory creates direct live recording with pinned authorization context", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-media-device-context-"));
  let resolverInput = null;
  const routes = fakeRoutes();
  routes.resolveOwnedRecordingLiveSource = async (openid, deviceSn) => {
    const input = { ownerOpenid: openid, deviceSn };
    resolverInput = input;
    return "https://camera.test/second-live.m3u8";
  };
  const services = createDefaultLiveMediaServices({
    config: {
      cloudHosting: false,
      replay: { ffmpegPath: "ffmpeg" },
      liveMedia: {
        stateFile: path.join(rootDir, "live-recordings.json"),
        tempDir: path.join(rootDir, "temp"),
        outputDir: path.join(rootDir, "media"),
        collection: "cat_live_recordings",
        maxDurationSec: 300,
      },
    },
    routes,
    logger: { warn() {} },
  });
  await services.initialize();

  const device = { sn: "SN-1", username: "camera-user", token: "device-token" };
  const session = services.gateway.createRecording({
    ownerOpenid: "owner",
    deviceSn: "SN-1",
    device,
  });
  assert.equal(session.constructor.name, "LiveRecordingSession");
  assert.equal(
    await session.resolveSourceUrl({ ownerOpenid: "ignored", deviceSn: "ignored" }),
    "https://camera.test/second-live.m3u8"
  );

  assert.deepEqual(resolverInput, { ownerOpenid: "owner", deviceSn: "SN-1" });
});
