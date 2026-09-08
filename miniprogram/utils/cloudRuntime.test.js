const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getMiniProgramAppId,
  initCloudRuntime,
} = require("./cloudRuntime.js");

function makeLogger() {
  return {
    messages: [],
    log(...args) {
      this.messages.push(["log", ...args]);
    },
    warn(...args) {
      this.messages.push(["warn", ...args]);
    },
    error(...args) {
      this.messages.push(["error", ...args]);
    },
  };
}

test("getMiniProgramAppId reads the runtime account info", () => {
  const wxApi = {
    getAccountInfoSync() {
      return { miniProgram: { appId: "wx123" } };
    },
  };

  assert.equal(getMiniProgramAppId(wxApi), "wx123");
});

test("initCloudRuntime skips wx.cloud.init when runtime appid is missing", () => {
  let initCalls = 0;
  const logger = makeLogger();
  const wxApi = {
    cloud: {
      init() {
        initCalls += 1;
      },
    },
    getAccountInfoSync() {
      return { miniProgram: { appId: "" } };
    },
  };

  const result = initCloudRuntime({
    wxApi,
    cloudEnvId: "cloud1-demo",
    logger,
  });

  assert.equal(initCalls, 0);
  assert.equal(result.cloudReady, false);
  assert.equal(result.cloudInitialized, false);
  assert.equal(result.reason, "appid-missing");
});

test("initCloudRuntime initializes cloud when env and appid are present", () => {
  const calls = [];
  const wxApi = {
    cloud: {
      init(payload) {
        calls.push(payload);
      },
    },
    getAccountInfoSync() {
      return { miniProgram: { appId: "wx123" } };
    },
  };

  const result = initCloudRuntime({
    wxApi,
    cloudEnvId: "cloud1-demo",
    logger: makeLogger(),
  });

  assert.deepEqual(calls, [{ env: "cloud1-demo", traceUser: true }]);
  assert.equal(result.cloudReady, true);
  assert.equal(result.cloudInitialized, true);
  assert.equal(result.appId, "wx123");
});

test("initCloudRuntime degrades instead of throwing when wx.cloud.init fails", () => {
  const result = initCloudRuntime({
    wxApi: {
      cloud: {
        init() {
          throw new Error("appid missing");
        },
      },
      getAccountInfoSync() {
        return { miniProgram: { appId: "wx123" } };
      },
    },
    cloudEnvId: "cloud1-demo",
    logger: makeLogger(),
  });

  assert.equal(result.cloudReady, false);
  assert.equal(result.cloudInitialized, false);
  assert.equal(result.reason, "init-failed");
});
