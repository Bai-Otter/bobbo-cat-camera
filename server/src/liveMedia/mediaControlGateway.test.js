const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { MediaControlGateway } = require("./mediaControlGateway");

function fakeSocket() {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.closed = [];
  socket.send = (value) => socket.sent.push(JSON.parse(String(value)));
  socket.close = (code, reason) => socket.closed.push({ code, reason });
  return socket;
}

function fakeSession(kind, calls) {
  const session = new EventEmitter();
  session.start = async (input) => {
    calls.push([`${kind}.start`, input]);
    return kind === "record"
      ? { id: "record-1", deviceSn: "SN-1", status: "recording", accessToken: "token", fileId: "private" }
      : { active: true };
  };
  session.stop = async () => {
    calls.push([`${kind}.stop`]);
    return kind === "record"
      ? { id: "record-1", deviceSn: "SN-1", status: "ready", accessToken: "token", fileId: "private" }
      : undefined;
  };
  session.writeAudio = (frame) => {
    calls.push([`${kind}.audio`, frame.length]);
    return frame.length;
  };
  return session;
}

function makeGateway(overrides = {}) {
  const calls = [];
  const gateway = new MediaControlGateway({
    authenticate: (req, token) => {
      calls.push(["authenticate", token]);
      if (token !== "session-ok") throw Object.assign(new Error("SESSION_INVALID"), { code: "SESSION_INVALID" });
      return { openid: "openid-owner" };
    },
    resolveOwnedDevice: async (openid, sn) => {
      calls.push(["device", openid, sn]);
      return overrides.device === null ? null : {
        sn,
        username: "admin",
        role: overrides.role || "owner",
        ownerOpenid: overrides.role === "member" ? "openid-device-owner" : openid,
      };
    },
    resolveLiveSession: (openid, sn, sessionId) => {
      calls.push(["live", openid, sn, sessionId]);
      return overrides.live === null
        ? null
        : { deviceSn: sn, ownerOpenid: openid, live: true, playUrl: "https://backend.test/hls/index.m3u8" };
    },
    createTalkback: () => fakeSession("talk", calls),
    createRecording: overrides.createRecording || (() => fakeSession("record", calls)),
    webSocketServer: overrides.webSocketServer,
    logger: { warn() {} },
  });
  return { gateway, calls };
}

async function settle(gateway) {
  await new Promise((resolve) => setImmediate(resolve));
  await gateway.idle();
}

test("media gateway upgrades only the owned device media-control path", async () => {
  const server = new EventEmitter();
  const accepted = fakeSocket();
  const upgrades = [];
  const webSocketServer = {
    handleUpgrade(req, socket, head, done) {
      upgrades.push({ req, socket, head });
      done(accepted);
    },
    close(done) { done?.(); },
  };
  const { gateway } = makeGateway({ webSocketServer });
  gateway.attach(server);
  const validTransport = { destroy() { assert.fail("valid upgrade must not be destroyed"); } };
  server.emit("upgrade", { url: "/api/devices/SN-1/media-control", headers: {} }, validTransport, Buffer.alloc(0));
  assert.equal(upgrades.length, 1);
  assert.equal(gateway.connectionCount, 1);

  let destroyed = false;
  server.emit("upgrade", { url: "/api/other", headers: {} }, { destroy() { destroyed = true; } }, Buffer.alloc(0));
  assert.equal(destroyed, true);
  await gateway.close();
});

test("media gateway authenticates ownership before allowing talk and recording to coexist", async () => {
  const { gateway, calls } = makeGateway();
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");

  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);
  assert.equal(ws.sent.at(-1).type, "authorized");

  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-1"}'), false);
  ws.emit("message", Buffer.from('{"type":"talk.start"}'), false);
  await settle(gateway);
  assert.ok(ws.sent.some((event) => event.type === "record.active"));
  assert.ok(ws.sent.some((event) => event.type === "talk.active"));
  assert.equal(ws.sent.some((event) => Object.hasOwn(event, "fileId")), false);

  ws.emit("message", Buffer.alloc(4096), true);
  ws.emit("message", Buffer.from('{"type":"ping"}'), false);
  await settle(gateway);
  assert.ok(calls.some((call) => call[0] === "talk.audio" && call[1] === 4096));
  assert.equal(ws.sent.at(-1).type, "pong");

  ws.emit("close");
  await settle(gateway);
  assert.ok(calls.some((call) => call[0] === "talk.stop"));
  assert.ok(calls.some((call) => call[0] === "record.stop"));
});

test("media gateway records for a shared member under the device owner", async () => {
  const { gateway, calls } = makeGateway({ role: "member" });
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");

  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-1"}'), false);
  await settle(gateway);

  assert.ok(ws.sent.some((event) => event.type === "record.active"));
  const start = calls.find((call) => call[0] === "record.start");
  assert.equal(start[1].ownerOpenid, "openid-device-owner");
  assert.equal(start[1].actorOpenid, "openid-owner");
  await gateway.close();
});

test("media gateway rejects pre-auth commands, non-owned devices, and binary audio outside talk mode", async () => {
  const preAuth = makeGateway();
  const ws1 = fakeSocket();
  preAuth.gateway.acceptConnection(ws1, { headers: {} }, "SN-1");
  ws1.emit("message", Buffer.from('{"type":"talk.start"}'), false);
  await settle(preAuth.gateway);
  assert.equal(ws1.sent.at(-1).error, "AUTH_REQUIRED");
  assert.equal(ws1.closed.at(-1).code, 1008);

  const wrongOwner = makeGateway({ device: null });
  const ws2 = fakeSocket();
  wrongOwner.gateway.acceptConnection(ws2, { headers: {} }, "SN-1");
  ws2.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(wrongOwner.gateway);
  assert.equal(ws2.sent.at(-1).error, "DEVICE_NOT_FOUND");

  const noTalk = makeGateway();
  const ws3 = fakeSocket();
  noTalk.gateway.acceptConnection(ws3, { headers: {} }, "SN-1");
  ws3.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(noTalk.gateway);
  ws3.emit("message", Buffer.alloc(4), true);
  await settle(noTalk.gateway);
  assert.equal(ws3.sent.at(-1).error, "TALKBACK_NOT_ACTIVE");
});

test("media gateway lets stop cancel a talk start that is still pending", async () => {
  let releaseStart;
  const order = [];
  const talk = new EventEmitter();
  talk.start = () => new Promise((resolve) => {
    order.push("start.begin");
    releaseStart = () => { order.push("start.end"); resolve({ active: true }); };
  });
  talk.stop = async () => { order.push("stop"); };
  talk.writeAudio = () => {};
  const { gateway } = makeGateway();
  gateway.createTalkback = () => talk;
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"talk.start"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  ws.emit("message", Buffer.from('{"type":"talk.stop"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start.begin", "stop"]);
  releaseStart();
  await settle(gateway);
  assert.deepEqual(order, ["start.begin", "stop", "start.end"]);
  assert.equal(ws.sent.some((event) => event.type === "talk.active"), false);
  assert.equal(ws.sent.at(-1).type, "talk.idle");
});

test("media gateway cancels recording while timestamp session start is pending", async () => {
  let releaseStart;
  const { gateway, calls } = makeGateway();
  const recording = fakeSession("record", calls);
  recording.start = () => new Promise((resolve) => {
    releaseStart = () => resolve({ id: "record-1", status: "recording" });
  });
  gateway.createRecording = () => recording;
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-1"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ws.sent.at(-1).type, "record.idle");
  releaseStart();
  await settle(gateway);
  assert.equal(calls.some((call) => call[0] === "record.start"), false);
  assert.equal(ws.sent.some((event) => event.type === "record.active"), false);
});

test("media gateway accepts a second recording and talkback cycle after both stop", async () => {
  const { gateway, calls } = makeGateway();
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);

  for (let cycle = 0; cycle < 2; cycle += 1) {
    ws.emit("message", Buffer.from(`{"type":"record.start","sessionId":"hls-${cycle + 1}"}`), false);
    await settle(gateway);
    assert.equal(ws.sent.at(-1).type, "record.active");
    ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
    await settle(gateway);
    assert.equal(ws.sent.at(-1).type, "record.finalizing");

    ws.emit("message", Buffer.from('{"type":"talk.start"}'), false);
    await settle(gateway);
    assert.equal(ws.sent.at(-1).type, "talk.active");
    ws.emit("message", Buffer.from('{"type":"talk.stop"}'), false);
    await settle(gateway);
    assert.equal(ws.sent.at(-1).type, "talk.idle");
  }

  assert.equal(calls.filter((call) => call[0] === "record.start").length, 2);
  assert.equal(calls.filter((call) => call[0] === "record.stop").length, 2);
  assert.equal(calls.filter((call) => call[0] === "talk.start").length, 2);
  assert.equal(calls.filter((call) => call[0] === "talk.stop").length, 2);
});

test("media gateway keeps unexpected stop failures scoped to the requested control", async () => {
  const { gateway } = makeGateway();
  const recording = fakeSession("record", []);
  recording.stop = async () => { throw new Error("cloud upload unavailable"); };
  const talk = fakeSession("talk", []);
  talk.stop = async () => { throw new Error("device close unavailable"); };
  gateway.createRecording = () => recording;
  gateway.createTalkback = () => talk;
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);

  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-1"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
  await settle(gateway);
  assert.equal(ws.sent.at(-1).type, "record.failed");

  ws.emit("message", Buffer.from('{"type":"talk.start"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"talk.stop"}'), false);
  await settle(gateway);
  assert.equal(ws.sent.at(-1).type, "talk.failed");
  assert.equal(ws.sent.some((event) => event.type === "media.failed"), false);
});

test("media gateway releases a failed recording start so the next attempt can succeed", async () => {
  const { gateway } = makeGateway();
  let attempts = 0;
  gateway.createRecording = () => {
    const recording = fakeSession("record", []);
    recording.start = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary timestamp store failure");
      return { id: "record-1", status: "recording" };
    };
    return recording;
  };
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);

  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-1"}'), false);
  await settle(gateway);
  assert.equal(ws.sent.at(-1).type, "record.failed");

  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-2"}'), false);
  await settle(gateway);
  assert.equal(ws.sent.at(-1).type, "record.active");
  assert.equal(attempts, 2);
});

test("media gateway scopes binary talkback write failures without interrupting recording", async () => {
  const { gateway } = makeGateway();
  const talk = fakeSession("talk", []);
  talk.writeAudio = () => { throw new Error("microphone frame rejected"); };
  gateway.createTalkback = () => talk;
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-1"}'), false);
  ws.emit("message", Buffer.from('{"type":"talk.start"}'), false);
  await settle(gateway);

  ws.emit("message", Buffer.alloc(4), true);
  await settle(gateway);

  assert.equal(ws.sent.at(-1).type, "talk.failed");
  assert.equal(ws.sent.some((event) => event.type === "media.failed"), false);
  ws.emit("message", Buffer.from('{"type":"talk.start"}'), false);
  await settle(gateway);
  assert.equal(ws.sent.at(-1).type, "talk.active");
  ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
  await settle(gateway);
  assert.equal(ws.sent.at(-1).type, "record.finalizing");
});

test("media gateway emits one recording failure when a session both emits and rejects", async () => {
  const { gateway } = makeGateway();
  const recording = fakeSession("record", []);
  recording.stop = async () => {
    const error = Object.assign(new Error("upload failed"), { code: "RECORDING_UPLOAD_FAILED" });
    recording.emit("failed", error);
    throw error;
  };
  gateway.createRecording = () => recording;
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-1"}'), false);
  await settle(gateway);

  ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
  await settle(gateway);

  assert.equal(ws.sent.filter((event) => event.type === "record.failed").length, 1);
});

test("media gateway treats a repeated stop after ready as an idempotent acknowledgement", async () => {
  const { gateway } = makeGateway();
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-1"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
  await settle(gateway);
  assert.equal(ws.sent.at(-1).type, "record.finalizing");

  ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
  await settle(gateway);

  assert.equal(ws.sent.at(-1).type, "record.finalizing");
  assert.equal(ws.sent.some((event) => event.type === "record.failed"), false);
});

test("media gateway treats repeated stops during a pending recording start as idempotent", async () => {
  let releaseStart;
  const { gateway } = makeGateway();
  const recording = fakeSession("record", []);
  recording.start = () => new Promise((resolve) => {
    releaseStart = () => resolve({ id: "record-1", status: "recording" });
  });
  gateway.createRecording = () => recording;
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-1"}'), false);
  await new Promise((resolve) => setImmediate(resolve));

  ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ws.sent.some((event) => event.type === "record.failed"), false);
  releaseStart();
  await settle(gateway);
  assert.equal(ws.sent.at(-1).type, "record.ready");
});

test("media gateway deduplicates an emitted recording start failure after cancellation", async () => {
  let rejectStart;
  const { gateway } = makeGateway();
  const recording = fakeSession("record", []);
  recording.start = () => new Promise((resolve, reject) => {
    rejectStart = () => {
      const error = Object.assign(new Error("start failed"), { code: "RECORDING_START_FAILED" });
      recording.emit("failed", error);
      reject(error);
    };
  });
  gateway.createRecording = () => recording;
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-1"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
  await new Promise((resolve) => setImmediate(resolve));

  rejectStart();
  await settle(gateway);

  assert.equal(ws.sent.filter((event) => event.type === "record.failed").length, 1);
});

test("media gateway suppresses a stale ready event after a newer recording starts", async () => {
  let releaseOldStart;
  let created = 0;
  const { gateway } = makeGateway();
  gateway.createRecording = () => {
    created += 1;
    const id = created === 1 ? "record-old" : "record-new";
    const recording = fakeSession("record", []);
    recording.start = created === 1
      ? () => new Promise((resolve) => { releaseOldStart = () => resolve({ id, status: "recording" }); })
      : async () => ({ id, status: "recording" });
    recording.stop = async () => ({ id, status: "ready" });
    return recording;
  };
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-old"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-new"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ws.sent.at(-1).id, "record-new");

  releaseOldStart();
  await settle(gateway);

  assert.equal(ws.sent.some((event) => event.type === "record.ready" && event.id === "record-old"), false);
  assert.equal(ws.sent.at(-1).id, "record-new");
});

test("media gateway suppresses a stale failure after a newer recording starts", async () => {
  let rejectOldStart;
  let created = 0;
  const { gateway } = makeGateway();
  gateway.createRecording = () => {
    created += 1;
    const recording = fakeSession("record", []);
    if (created === 1) {
      recording.start = () => new Promise((resolve, reject) => {
        rejectOldStart = () => {
          const error = Object.assign(new Error("old failed"), { code: "RECORDING_START_FAILED" });
          recording.emit("failed", error);
          reject(error);
        };
      });
    } else {
      recording.start = async () => ({ id: "record-new", status: "recording" });
    }
    return recording;
  };
  const ws = fakeSocket();
  gateway.acceptConnection(ws, { headers: {} }, "SN-1");
  ws.emit("message", Buffer.from('{"type":"authorize","token":"session-ok"}'), false);
  await settle(gateway);
  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-old"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  ws.emit("message", Buffer.from('{"type":"record.stop"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  ws.emit("message", Buffer.from('{"type":"record.start","sessionId":"hls-new"}'), false);
  await new Promise((resolve) => setImmediate(resolve));

  rejectOldStart();
  await settle(gateway);

  assert.equal(ws.sent.some((event) => event.type === "record.failed"), false);
  assert.equal(ws.sent.at(-1).type, "record.active");
  assert.equal(ws.sent.at(-1).id, "record-new");
});
