const test = require("node:test");
const assert = require("node:assert/strict");

const { createLiveMediaControl, RECORDER_OPTIONS } = require("./liveMediaControl.js");
const { saveAppSession } = require("./appAuth.js");

function createEventTarget(names) {
  const listeners = new Map(names.map((name) => [name, new Set()]));
  const target = {};
  for (const name of names) {
    const suffix = name[0].toUpperCase() + name.slice(1);
    target[`on${suffix}`] = (listener) => listeners.get(name).add(listener);
    target[`off${suffix}`] = (listener) => listeners.get(name).delete(listener);
  }
  target.emit = (name, payload) => {
    for (const listener of [...listeners.get(name)]) listener(payload);
  };
  target.listenerCount = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  return target;
}

function fixture() {
  const socket = createEventTarget(["open", "message", "close", "error"]);
  socket.sent = [];
  socket.send = ({ data }) => socket.sent.push(data);
  socket.close = () => socket.emit("close", { code: 1000 });
  const recorder = createEventTarget(["start", "frameRecorded", "stop", "error"]);
  recorder.starts = [];
  recorder.start = (options) => recorder.starts.push(options);
  recorder.stop = () => recorder.emit("stop", {});
  const calls = [];
  const wxApi = {
    cloud: {
      connectContainer(options) {
        calls.push(options);
        return Promise.resolve({ socketTask: socket });
      },
    },
    getRecorderManager() { return recorder; },
    getSetting({ success }) {
      success({ authSetting: { "scope.record": true } });
    },
    authorize({ success }) { success(); },
  };
  const store = new Map();
  const uniApi = {
    getStorageSync(key) { return store.get(key) || ""; },
    setStorageSync(key, value) { store.set(key, value); },
    removeStorageSync(key) { store.delete(key); },
  };
  saveAppSession({ sessionToken: "session-ok", user: { openid: "owner" } }, uniApi);
  return { calls, recorder, socket, uniApi, wxApi };
}

test("media control connects to Cloud Hosting and authorizes before any media command", async () => {
  const fx = fixture();
  const intervals = [];
  const events = [];
  const control = createLiveMediaControl({
    wxApi: fx.wxApi,
    uniApi: fx.uniApi,
    deviceSn: "SN",
    backendRuntime: {
      mode: "cloud-hosting",
      cloud: { envId: "env-test", serviceName: "cat-feeding-api" },
    },
    onEvent: (event) => events.push(event),
    setInterval: (callback) => { intervals.push(callback); return 1; },
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  });
  const connected = control.connect();
  await Promise.resolve();
  assert.deepEqual(fx.calls, [{
    config: { env: "env-test" },
    service: "cat-feeding-api",
    path: "/api/devices/SN/media-control",
  }]);
  assert.equal(fx.socket.listenerCount(), 4, "CloudBase socketTask listeners must be attached");
  fx.socket.emit("open", {});
  assert.deepEqual(JSON.parse(fx.socket.sent[0]), { type: "authorize", token: "session-ok" });
  fx.socket.emit("message", { data: JSON.stringify({ type: "authorized", deviceSn: "SN" }) });
  await connected;
  assert.equal(control.isAuthorized(), true);
  control.startRecording();
  assert.deepEqual(JSON.parse(fx.socket.sent[1]), { type: "record.start" });
  intervals[0]();
  assert.deepEqual(JSON.parse(fx.socket.sent[2]), { type: "ping" });
  assert.equal(events.at(-1).type, "authorized");
  fx.socket.emit("close", { code: 1006 });
  assert.equal(control.isAuthorized(), false);
  control.close();
});

test("media control connects to the configured local backend over wx.connectSocket", async () => {
  const fx = fixture();
  const localCalls = [];
  fx.wxApi.connectSocket = (options) => {
    localCalls.push(options);
    return fx.socket;
  };
  const control = createLiveMediaControl({
    wxApi: fx.wxApi,
    uniApi: fx.uniApi,
    deviceSn: "SN / local",
    backendRuntime: {
      mode: "local",
      localBaseUrl: "http://192.168.8.25:8000/",
      cloud: {},
    },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  });

  const connected = control.connect();
  assert.deepEqual(localCalls, [{
    url: "ws://192.168.8.25:8000/api/devices/SN%20%2F%20local/media-control",
  }]);
  assert.equal(fx.calls.length, 0, "local mode must not allocate a Cloud Hosting socket");
  fx.socket.emit("open", {});
  assert.deepEqual(JSON.parse(fx.socket.sent[0]), { type: "authorize", token: "session-ok" });
  fx.socket.emit("message", { data: JSON.stringify({ type: "authorized", deviceSn: "SN / local" }) });
  await connected;

  control.startRecording("hls-local");
  assert.deepEqual(JSON.parse(fx.socket.sent[1]), {
    type: "record.start",
    sessionId: "hls-local",
  });
  control.close();
});

test("experience media control uses the trial tunnel", async () => {
  const fx = fixture();
  const localCalls = [];
  fx.wxApi.getAccountInfoSync = () => ({ miniProgram: { envVersion: "trial" } });
  fx.wxApi.connectSocket = (options) => {
    localCalls.push(options);
    return fx.socket;
  };
  const control = createLiveMediaControl({
    wxApi: fx.wxApi,
    uniApi: fx.uniApi,
    deviceSn: "SN",
    backendRuntime: {
      mode: "local",
      localBaseUrl: "https://api.example.com",
      trialBaseUrl: "https://trial-tunnel.example.com",
      cloud: {},
    },
  });

  const connected = control.connect();
  assert.deepEqual(localCalls, [{
    url: "wss://trial-tunnel.example.com/api/devices/SN/media-control",
  }]);
  fx.socket.emit("open", {});
  fx.socket.emit("message", { data: JSON.stringify({ type: "authorized" }) });
  await connected;
  control.close();
});

test("talkback starts mono AAC frames only after microphone permission and server activation", async () => {
  const fx = fixture();
  const events = [];
  const control = createLiveMediaControl({
    wxApi: fx.wxApi,
    uniApi: fx.uniApi,
    deviceSn: "SN",
    backendRuntime: {
      mode: "cloud-hosting",
      cloud: { envId: "env-test", serviceName: "cat-feeding-api" },
    },
    onEvent: (event) => events.push(event),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  });
  const connected = control.connect();
  await Promise.resolve();
  assert.equal(fx.socket.listenerCount(), 4, "CloudBase socketTask listeners must be attached");
  fx.socket.emit("open", {});
  fx.socket.emit("message", { data: JSON.stringify({ type: "authorized" }) });
  await connected;
  await control.startTalk();
  assert.equal(fx.recorder.starts.length, 0);
  fx.socket.emit("message", { data: JSON.stringify({ type: "talk.active" }) });
  assert.deepEqual(fx.recorder.starts[0], RECORDER_OPTIONS);
  const audio = new Uint8Array([1, 2, 3]).buffer;
  fx.recorder.emit("frameRecorded", { frameBuffer: audio });
  assert.equal(fx.socket.sent.at(-1), audio);
  fx.recorder.emit("error", { errMsg: "RecorderManager:fail auth deny" });
  assert.deepEqual(JSON.parse(fx.socket.sent.at(-1)), { type: "talk.stop" });
  fx.socket.emit("close", { code: 1006 });
  assert.equal(control.isTalking(), false);
  assert.equal(fx.recorder.starts.length, 1);
  assert.ok(events.some((event) => event.type === "talk.failed"));
  control.close();
  assert.equal(fx.socket.listenerCount(), 0);
  assert.equal(fx.recorder.listenerCount(), 0);
});

test("talkback permission denial never allocates a backend talk session", async () => {
  const fx = fixture();
  fx.wxApi.getSetting = ({ success }) => success({ authSetting: { "scope.record": false } });
  fx.wxApi.authorize = ({ fail }) => fail({ errMsg: "authorize:fail auth deny" });
  const control = createLiveMediaControl({
    wxApi: fx.wxApi,
    uniApi: fx.uniApi,
    deviceSn: "SN",
    backendRuntime: {
      mode: "cloud-hosting",
      cloud: { envId: "env-test", serviceName: "cat-feeding-api" },
    },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  });
  const connected = control.connect();
  await Promise.resolve();
  assert.equal(fx.socket.listenerCount(), 4, "CloudBase socketTask listeners must be attached");
  fx.socket.emit("open", {});
  fx.socket.emit("message", { data: JSON.stringify({ type: "authorized" }) });
  await connected;

  await assert.rejects(control.startTalk(), { code: "MICROPHONE_PERMISSION_DENIED" });
  assert.equal(fx.socket.sent.some((data) => {
    try { return JSON.parse(data).type === "talk.start"; } catch { return false; }
  }), false);
  control.close();
});

test("stopping talkback while microphone permission is pending cancels the later start", async () => {
  const fx = fixture();
  let grantPermission;
  fx.wxApi.getSetting = ({ success }) => success({ authSetting: { "scope.record": false } });
  fx.wxApi.authorize = ({ success }) => { grantPermission = success; };
  const control = createLiveMediaControl({
    wxApi: fx.wxApi,
    uniApi: fx.uniApi,
    deviceSn: "SN",
    backendRuntime: {
      mode: "cloud-hosting",
      cloud: { envId: "env-test", serviceName: "cat-feeding-api" },
    },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  });
  const connected = control.connect();
  await Promise.resolve();
  fx.socket.emit("open", {});
  fx.socket.emit("message", { data: JSON.stringify({ type: "authorized" }) });
  await connected;

  const starting = control.startTalk();
  await Promise.resolve();
  control.stopTalk();
  grantPermission();
  await starting;

  const commands = fx.socket.sent.filter((data) => typeof data === "string").map((data) => JSON.parse(data).type);
  assert.equal(commands.includes("talk.start"), false);
  assert.equal(commands.includes("talk.stop"), true);
  control.close();
});
