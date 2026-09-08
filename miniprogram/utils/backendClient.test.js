const test = require("node:test");
const assert = require("node:assert/strict");

const { callBackend, getBackendErrorMessage, refreshBackendSession } = require("./backendClient.js");
const { DEFAULT_BACKEND_BASE_URL, readAppAuthState, saveAppSession, setBackendBaseUrl } = require("./appAuth.js");
const { BACKEND_RUNTIME } = require("../config/backend.js");

function createUniMock() {
  const store = new Map();
  const requests = [];
  const uniApi = {
    requests,
    getStorageSync(key) {
      return store.has(key) ? store.get(key) : "";
    },
    setStorageSync(key, value) {
      store.set(key, value);
    },
    removeStorageSync(key) {
      store.delete(key);
    },
    request(options) {
      requests.push(options);
      options.success({ statusCode: 200, data: { ok: true, value: 42 } });
    },
    reLaunch(options) {
      uniApi.reLaunchUrl = options.url;
    },
  };
  return uniApi;
}

test("callBackend sends session header and encoded query", async () => {
  const uniApi = createUniMock();
  setBackendBaseUrl(DEFAULT_BACKEND_BASE_URL, uniApi);
  saveAppSession({ sessionToken: "session-abc", user: { id: "openid-1", openid: "openid-1" } }, uniApi);

  const result = await callBackend("/api/devices/SN001/status", {
    method: "GET",
    query: { date: "2026-07-08 00:00:00" },
    backendRuntime: { ...BACKEND_RUNTIME, mode: "local" },
  }, uniApi);

  assert.equal(result.value, 42);
  assert.equal(uniApi.requests[0].url, `${DEFAULT_BACKEND_BASE_URL}/api/devices/SN001/status?date=2026-07-08%2000%3A00%3A00`);
  assert.equal(uniApi.requests[0].header["X-Cat-Session"], "session-abc");
});

test("callBackend clears session and relaunches login when silent renewal fails", async () => {
  const uniApi = createUniMock();
  setBackendBaseUrl(DEFAULT_BACKEND_BASE_URL, uniApi);
  saveAppSession({ sessionToken: "session-abc", user: { id: "openid-1", openid: "openid-1" } }, uniApi);
  const urls = [];
  uniApi.request = (options) => {
    urls.push(options.url);
    options.success({ statusCode: 401, data: { detail: "AUTH_REQUIRED" } });
  };

  await assert.rejects(() => callBackend("/api/devices", {
    backendRuntime: { ...BACKEND_RUNTIME, mode: "local" },
  }, uniApi), /AUTH_REQUIRED/);

  assert.equal(JSON.parse(uniApi.getStorageSync("userProfile")).loggedIn, false);
  assert.equal(uniApi.reLaunchUrl, "/pages/login/index");
  assert.equal(urls.filter((url) => url.endsWith("/api/auth/wechat-login")).length, 1);
});

test("callBackend silently renews an invalid session and retries the original request", async () => {
  const uniApi = createUniMock();
  setBackendBaseUrl(DEFAULT_BACKEND_BASE_URL, uniApi);
  saveAppSession({ sessionToken: "expired-session", user: { id: "openid-1", openid: "openid-1" } }, uniApi);
  let protectedCalls = 0;
  uniApi.request = (options) => {
    if (options.url.endsWith("/api/auth/wechat-login")) {
      assert.equal(options.header["X-Cat-Session"], undefined);
      options.success({
        statusCode: 200,
        data: { sessionToken: "renewed-session", user: { id: "openid-1", openid: "openid-1" } },
      });
      return;
    }
    protectedCalls += 1;
    if (protectedCalls === 1) {
      assert.equal(options.header["X-Cat-Session"], "expired-session");
      options.success({ statusCode: 401, data: { error: "SESSION_INVALID" } });
      return;
    }
    assert.equal(options.header["X-Cat-Session"], "renewed-session");
    options.success({ statusCode: 200, data: { ok: true, records: [1] } });
  };

  const result = await callBackend("/api/devices/SN001/recordings", {
    backendRuntime: { ...BACKEND_RUNTIME, mode: "local" },
  }, uniApi);

  assert.deepEqual(result, { ok: true, records: [1] });
  assert.equal(protectedCalls, 2);
  assert.equal(readAppAuthState(uniApi).sessionToken, "renewed-session");
  assert.equal(uniApi.reLaunchUrl, undefined);
});

test("concurrent invalid sessions share one silent renewal", async () => {
  const uniApi = createUniMock();
  setBackendBaseUrl(DEFAULT_BACKEND_BASE_URL, uniApi);
  saveAppSession({ sessionToken: "expired-session", user: { id: "openid-1", openid: "openid-1" } }, uniApi);
  let loginCalls = 0;
  uniApi.request = (options) => {
    if (options.url.endsWith("/api/auth/wechat-login")) {
      loginCalls += 1;
      setImmediate(() => options.success({
        statusCode: 200,
        data: { sessionToken: "renewed-session", user: { id: "openid-1", openid: "openid-1" } },
      }));
      return;
    }
    const token = options.header["X-Cat-Session"];
    setImmediate(() => options.success(token === "renewed-session"
      ? { statusCode: 200, data: { ok: true, path: options.url } }
      : { statusCode: 401, data: { error: "SESSION_INVALID" } }));
  };

  const results = await Promise.all([
    callBackend("/api/devices", { backendRuntime: { ...BACKEND_RUNTIME, mode: "local" } }, uniApi),
    callBackend("/api/feed-analysis/markers", { backendRuntime: { ...BACKEND_RUNTIME, mode: "local" } }, uniApi),
  ]);

  assert.equal(results.length, 2);
  assert.equal(loginCalls, 1);
  assert.equal(uniApi.reLaunchUrl, undefined);
});

test("refreshBackendSession renews the session before a websocket connection", async () => {
  const uniApi = createUniMock();
  setBackendBaseUrl(DEFAULT_BACKEND_BASE_URL, uniApi);
  saveAppSession({ sessionToken: "expired-session", user: { id: "openid-1", openid: "openid-1" } }, uniApi);
  uniApi.request = (options) => {
    assert.ok(options.url.endsWith("/api/auth/wechat-login"));
    assert.equal(options.header["X-Cat-Session"], undefined);
    options.success({
      statusCode: 200,
      data: { sessionToken: "websocket-session", user: { id: "openid-1", openid: "openid-1" } },
    });
  };

  const token = await refreshBackendSession({
    backendRuntime: { ...BACKEND_RUNTIME, mode: "local" },
  }, uniApi);

  assert.equal(token, "websocket-session");
  assert.equal(readAppAuthState(uniApi).sessionToken, "websocket-session");
});

test("callBackend routes development and experience builds through the temporary tunnel", async () => {
  for (const envVersion of ["develop", "trial"]) {
    const uniApi = createUniMock();
    const runtime = {
      ...BACKEND_RUNTIME,
      mode: "local",
      localBaseUrl: "https://api.example.com",
      developmentBaseUrl: "https://dev-tunnel.example.com",
      trialBaseUrl: "https://trial-tunnel.example.com",
    };
    await callBackend("/api/session", {
      backendRuntime: runtime,
      wxApi: { getAccountInfoSync: () => ({ miniProgram: { envVersion } }) },
    }, uniApi);
    assert.equal(
      uniApi.requests[0].url,
      `${envVersion === "develop" ? "https://dev-tunnel.example.com" : "https://trial-tunnel.example.com"}/api/session`
    );
  }
});

test("callBackend preserves a sanitized backend details message", async () => {
  const uniApi = createUniMock();
  uniApi.request = (options) => options.success({
    statusCode: 502,
    data: {
      error: "DEVICE_BIND_FAILED",
      details: { message: "请求失败: connect ETIMEDOUT" },
    },
  });

  await assert.rejects(() => callBackend("/api/devices", {
    method: "POST",
    data: { sn: "SN001" },
    backendRuntime: { ...BACKEND_RUNTIME, mode: "local" },
  }, uniApi), /connect ETIMEDOUT/);
});

test("callBackend sends account sync diagnostics and preserves request id on errors", async () => {
  const uniApi = createUniMock();
  uniApi.request = (options) => {
    uniApi.requests.push(options);
    options.success({
      statusCode: 403,
      data: { error: "CAT_PROFILE_READ_ONLY", details: { requestId: "cat_12345678" } },
    });
  };

  await assert.rejects(async () => {
    try {
      await callBackend("/api/cats/cat-1", {
        method: "PUT",
        data: { name: "小布" },
        requestId: "cat_12345678",
        syncSource: "cat-editor",
        backendRuntime: { ...BACKEND_RUNTIME, mode: "local" },
      }, uniApi);
    } catch (error) {
      assert.equal(error.code, "CAT_PROFILE_READ_ONLY");
      assert.equal(error.statusCode, 403);
      assert.equal(error.requestId, "cat_12345678");
      throw error;
    }
  }, /CAT_PROFILE_READ_ONLY/);
  assert.equal(uniApi.requests[0].header["X-Bobbo-Request-Id"], "cat_12345678");
  assert.equal(uniApi.requests[0].header["X-Bobbo-Sync-Source"], "cat-editor");
});

test("callBackend uses Cloud Hosting for API requests while keeping the configured public media base", async () => {
  const uniApi = createUniMock();
  const runtime = {
    ...BACKEND_RUNTIME,
    mode: "cloud-hosting",
    cloud: {
      ...BACKEND_RUNTIME.cloud,
      envId: "cloud1-prod",
      serviceName: "cat-camera-api",
      publicBaseUrl: "https://cat-camera.example.com/",
    },
  };
  let containerCall;
  const wxApi = {
    cloud: {
      callContainer(options) {
        containerCall = options;
        options.success({ statusCode: 200, data: { ok: true, transport: "cloud" } });
      },
    },
  };

  const result = await callBackend(
    "/api/devices",
    {
      method: "POST",
      data: { nickname: "Mimi" },
      query: { source: "mini program" },
      backendRuntime: runtime,
      wxApi,
    },
    uniApi
  );

  assert.deepEqual(result, { ok: true, transport: "cloud" });
  assert.equal(uniApi.requests.length, 0);
  assert.equal(containerCall.config.env, "cloud1-prod");
  assert.equal(containerCall.header["X-WX-SERVICE"], "cat-camera-api");
  assert.equal(containerCall.path, "/api/devices?source=mini%20program");
  assert.deepEqual(containerCall.data, { nickname: "Mimi" });
});

test("getBackendErrorMessage explains missing JF runtime config", () => {
  assert.equal(
    getBackendErrorMessage(new Error("JF_CONFIG_MISSING"), "请求失败"),
    "后台缺少 JF 配置，请检查服务配置"
  );
});

test("getBackendErrorMessage explains bounded replay startup failures", () => {
  assert.equal(
    getBackendErrorMessage(new Error("REPLAY_HLS_START_FAILED"), "录像播放失败"),
    "录像启动失败，请重试"
  );
  assert.equal(
    getBackendErrorMessage(new Error("REPLAY_HLS_START_TIMEOUT"), "录像播放失败"),
    "录像连接超时，请重试"
  );
});
