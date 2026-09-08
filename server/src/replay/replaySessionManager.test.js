const test = require("node:test");
const assert = require("node:assert/strict");

const { ReplaySessionManager, normalizeReplayRecord } = require("./replaySessionManager");

test("normalizeReplayRecord extracts native replay fields and duration", () => {
  const record = normalizeReplayRecord({
    BeginTime: "2026-07-11 10:00:00",
    EndTime: "2026-07-11 10:02:30",
    FileName: "/idea0/clip.h264",
  });

  assert.deepEqual(record, {
    beginTime: "2026-07-11 10:00:00",
    endTime: "2026-07-11 10:02:30",
    fileName: "/idea0/clip.h264",
    durationSec: 150,
  });
});

test("createSession starts native playback and returns a backend FLV URL", async () => {
  const nativeClients = [];
  const factoryArgs = [];
  const manager = new ReplaySessionManager({
    idFactory: () => "session-1",
    createNativeClient: (args) => {
      factoryArgs.push(args);
      const client = makeNativeClient();
      nativeClients.push(client);
      return client;
    },
    createRelay: () => makeRelay(),
  });

  const result = await manager.createSession({
    baseUrl: "https://backend.test",
    deviceSn: "SN001",
    ownerOpenid: "openid-owner",
    channel: 0,
    stream: "Main",
    record: {
      beginTime: "2026-07-11 10:00:00",
      endTime: "2026-07-11 10:01:00",
      fileName: "/idea0/clip.h264",
    },
    lanHost: "192.168.63.88",
    targetSec: 12,
  });

  assert.deepEqual(result, {
    ok: true,
    sessionId: "session-1",
    streamUrl: "https://backend.test/api/replay-sessions/session-1/live.flv",
    durationSec: 60,
    currentSec: 12,
    transport: "device-pri-flv",
  });
  assert.equal(nativeClients[0].started[0].channel, 0);
  assert.equal(nativeClients[0].started[0].stream, "Main");
  assert.equal(nativeClients[0].started[0].beginTime, "2026-07-11 10:00:00");
  assert.equal(nativeClients[0].started[0].fileName, "/idea0/clip.h264");
  assert.equal(nativeClients[0].started[0].targetSec, 12);
  assert.equal(typeof nativeClients[0].started[0].onData, "function");
  assert.deepEqual(factoryArgs[0], { deviceSn: "SN001", lanHost: "192.168.63.88" });
  assert.deepEqual(manager.getSessionMetadata("session-1"), {
    deviceSn: "SN001",
    ownerOpenid: "openid-owner",
  });
  assert.equal(result.ownerOpenid, undefined);
});

test("createSession stops an existing session for the same device", async () => {
  const nativeClients = [];
  let id = 0;
  const manager = new ReplaySessionManager({
    idFactory: () => "session-" + ++id,
    createNativeClient: () => {
      const client = makeNativeClient();
      nativeClients.push(client);
      return client;
    },
    createRelay: () => makeRelay(),
  });

  await manager.createSession({
    baseUrl: "https://backend.test",
    deviceSn: "SN001",
    record: baseRecord(),
  });
  await manager.createSession({
    baseUrl: "https://backend.test",
    deviceSn: "SN001",
    record: baseRecord(),
  });

  assert.equal(nativeClients[0].stopped, 1);
  assert.equal(nativeClients[1].stopped, 0);
});

test("seekSession delegates to native Locate and updates current position", async () => {
  let nativeClient;
  const manager = new ReplaySessionManager({
    idFactory: () => "session-1",
    createNativeClient: () => {
      nativeClient = makeNativeClient();
      return nativeClient;
    },
    createRelay: () => makeRelay(),
  });

  await manager.createSession({
    baseUrl: "https://backend.test",
    deviceSn: "SN001",
    record: baseRecord(),
  });
  const result = await manager.seekSession("session-1", 42);

  assert.deepEqual(nativeClient.seeks[0], {
    channel: 0,
    stream: "Main",
    beginTime: "2026-07-11 10:00:00",
    targetSec: 42,
  });
  assert.deepEqual(result, { ok: true, currentSec: 42, transport: "device-pri-flv" });
});

test("cleanupExpired stops stale sessions", async () => {
  let now = 1000;
  let nativeClient;
  const manager = new ReplaySessionManager({
    ttlMs: 500,
    now: () => now,
    idFactory: () => "session-1",
    createNativeClient: () => {
      nativeClient = makeNativeClient();
      return nativeClient;
    },
    createRelay: () => makeRelay(),
  });

  await manager.createSession({
    baseUrl: "https://backend.test",
    deviceSn: "SN001",
    record: baseRecord(),
  });
  now = 1601;
  await manager.cleanupExpired();

  assert.equal(nativeClient.stopped, 1);
  assert.equal(manager.getSession("session-1"), null);
});

function baseRecord() {
  return {
    beginTime: "2026-07-11 10:00:00",
    endTime: "2026-07-11 10:01:00",
    fileName: "/idea0/clip.h264",
  };
}

function makeNativeClient() {
  return {
    started: [],
    seeks: [],
    paused: 0,
    resumed: 0,
    stopped: 0,
    async startPlayback(options) {
      this.started.push(options);
    },
    async seekTo(options) {
      this.seeks.push(options);
    },
    async pausePlayback() {
      this.paused += 1;
    },
    async resumePlayback() {
      this.resumed += 1;
    },
    async stopPlayback() {
      this.stopped += 1;
    },
  };
}

function makeRelay() {
  return {
    transport: "device-pri-flv",
    attachSource() {},
    attachHttpResponse() {},
    close() {
      this.closed = true;
    },
  };
}
