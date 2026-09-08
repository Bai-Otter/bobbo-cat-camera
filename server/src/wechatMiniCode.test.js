const test = require("node:test");
const assert = require("node:assert/strict");
const { createWechatMiniCodeService } = require("./wechatMiniCode");

test("mini code service caches access token and returns image bytes", async () => {
  const calls = [];
  const image = Buffer.from("png-image-bytes");
  const service = createWechatMiniCodeService({
    appId: "wx-test",
    appSecret: "server-secret",
    now: () => 1000,
    request: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/cgi-bin/token")) {
        return { contentType: "application/json", body: Buffer.from('{"access_token":"access-1","expires_in":7200}') };
      }
      return { contentType: "image/png", body: image };
    },
  });

  assert.equal(await service.create({ scene: "a".repeat(32), page: "pages/share/accept" }), image);
  await service.create({ scene: "b".repeat(32), page: "pages/share/accept" });
  assert.equal(calls.filter((call) => call.url.includes("/cgi-bin/token")).length, 1);
  assert.deepEqual(calls[1].options.body, {
    scene: "a".repeat(32),
    page: "pages/share/accept",
    check_path: true,
    env_version: "release",
    width: 430,
  });
  assert.doesNotMatch(JSON.stringify(calls[1].options.body), /server-secret|access-1/);
});

test("mini code service can bypass path validation for a trial-only page", async () => {
  const calls = [];
  const service = createWechatMiniCodeService({
    appId: "wx-test",
    appSecret: "server-secret",
    request: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return String(url).includes("/cgi-bin/token")
        ? { contentType: "application/json", body: Buffer.from('{"access_token":"access-1"}') }
        : { contentType: "image/jpeg", body: Buffer.from("jpeg-image-bytes") };
    },
  });

  const image = await service.create({
    scene: "trial-scene",
    page: "pages/share/accept",
    checkPath: false,
    envVersion: "trial",
  });

  assert.equal(image.toString(), "jpeg-image-bytes");
  assert.deepEqual(calls[1].options.body, {
    scene: "trial-scene",
    page: "pages/share/accept",
    check_path: false,
    env_version: "trial",
    width: 430,
  });
});

test("mini code service rejects missing server credentials and provider JSON", async () => {
  await assert.rejects(
    createWechatMiniCodeService({ appId: "wx-test", appSecret: "" }).create({ scene: "token", page: "pages/share/accept" }),
    { code: "WECHAT_MINICODE_NOT_CONFIGURED" }
  );
  const service = createWechatMiniCodeService({
    appId: "wx-test",
    appSecret: "secret",
    request: async (url) => String(url).includes("/cgi-bin/token")
      ? { contentType: "application/json", body: Buffer.from('{"access_token":"access-1"}') }
      : { contentType: "application/json", body: Buffer.from('{"errcode":41030,"errmsg":"invalid page"}') },
  });
  await assert.rejects(service.create({ scene: "token", page: "pages/share/accept" }), (error) => {
    assert.equal(error.code, "WECHAT_MINICODE_PROVIDER_ERROR");
    assert.equal(error.providerCode, 41030);
    assert.doesNotMatch(error.message, /invalid page|secret/);
    return true;
  });
});
