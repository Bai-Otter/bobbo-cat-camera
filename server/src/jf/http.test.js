const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRequestOptions, getHttpsProxyUrl } = require("./http");

const auth = {
  uuid: "uuid",
  appKey: "app-key",
  signature: "signature",
};

test("getHttpsProxyUrl prefers HTTPS proxy settings", () => {
  assert.equal(
    getHttpsProxyUrl({
      HTTPS_PROXY: "http://127.0.0.1:7897",
      HTTP_PROXY: "http://127.0.0.1:8080",
    }),
    "http://127.0.0.1:7897"
  );
});

test("buildRequestOptions uses an HTTPS proxy agent when configured", () => {
  const options = buildRequestOptions({
    endpoint: "api.example.com",
    path: "/device/token",
    auth,
    timeMillis: "123",
    proxyUrl: "http://127.0.0.1:7897",
  });

  assert.equal(options.hostname, "api.example.com");
  assert.equal(options.agent.constructor.name, "HttpsProxyAgent");
  assert.equal(options.headers.signature, "signature");
});

test("buildRequestOptions connects directly when no proxy is configured", () => {
  const options = buildRequestOptions({
    endpoint: "api.example.com",
    path: "/device/token",
    auth,
    timeMillis: "123",
    proxyUrl: "",
  });

  assert.equal(Object.hasOwn(options, "agent"), false);
});
