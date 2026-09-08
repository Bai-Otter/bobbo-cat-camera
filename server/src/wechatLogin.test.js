const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createWechatLoginService,
  defaultRequestJson,
  getHttpsProxyUrl,
} = require("./wechatLogin");

test("wechat login provider requests use the configured HTTPS proxy", async () => {
  let requestOptions;
  const requestGet = (_url, options, onResponse) => {
    requestOptions = options;
    const request = new EventEmitter();
    request.destroy = (error) => request.emit("error", error);

    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      onResponse(response);
      response.emit("data", '{"openid":"openid-owner"}');
      response.emit("end");
    });
    return request;
  };

  const result = await defaultRequestJson(
    new URL("https://api.weixin.qq.com/sns/jscode2session"),
    {
      proxyUrl: "http://127.0.0.1:7897",
      requestGet,
    }
  );

  assert.equal(result.openid, "openid-owner");
  assert.equal(requestOptions.agent.constructor.name, "HttpsProxyAgent");
  assert.equal(
    getHttpsProxyUrl({ HTTPS_PROXY: "http://127.0.0.1:7897" }),
    "http://127.0.0.1:7897"
  );
});

test("wechat login exchanges a one-time code without exposing the app secret", async () => {
  let requestedUrl = "";
  const service = createWechatLoginService({
    appId: "wx-test-app",
    appSecret: "server-only-secret",
    requestJson: async (url) => {
      requestedUrl = String(url);
      return { openid: "openid-owner", session_key: "session-key" };
    },
  });

  const result = await service.exchange("one-time-code");

  assert.deepEqual(result, {
    openid: "openid-owner",
    unionid: "",
  });
  const parsed = new URL(requestedUrl);
  assert.equal(parsed.searchParams.get("appid"), "wx-test-app");
  assert.equal(parsed.searchParams.get("secret"), "server-only-secret");
  assert.equal(parsed.searchParams.get("js_code"), "one-time-code");
});

test("wechat login rejects missing server configuration before making a request", async () => {
  let called = false;
  const service = createWechatLoginService({
    appId: "wx-test-app",
    appSecret: "",
    requestJson: async () => {
      called = true;
      return {};
    },
  });

  await assert.rejects(
    service.exchange("one-time-code"),
    { code: "WECHAT_LOGIN_NOT_CONFIGURED" }
  );
  assert.equal(called, false);
});

test("wechat login maps provider errors to a stable code without leaking details", async () => {
  const service = createWechatLoginService({
    appId: "wx-test-app",
    appSecret: "server-only-secret",
    requestJson: async () => ({ errcode: 40029, errmsg: "invalid code" }),
  });

  await assert.rejects(
    service.exchange("expired-code"),
    (error) => {
      assert.equal(error.code, "WECHAT_LOGIN_PROVIDER_ERROR");
      assert.equal(error.providerCode, 40029);
      assert.doesNotMatch(error.message, /server-only-secret|invalid code/);
      return true;
    }
  );
});

test("wechat login rejects a response without an openid", async () => {
  const service = createWechatLoginService({
    appId: "wx-test-app",
    appSecret: "server-only-secret",
    requestJson: async () => ({ session_key: "session-key" }),
  });

  await assert.rejects(
    service.exchange("one-time-code"),
    { code: "WECHAT_LOGIN_INVALID_RESPONSE" }
  );
});
