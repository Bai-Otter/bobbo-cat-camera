const test = require("node:test");
const assert = require("node:assert/strict");

const { WxPusherService } = require("./wxPusherService");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test("WxPusherService creates a parameter qrcode without exposing the app token", async () => {
  const requests = [];
  const service = new WxPusherService({
    appToken: "AT_secret",
    appId: "123",
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({ code: 1000, success: true, data: { url: "https://wxpusher.zjiecode.com/qrcode/test.png" } });
    },
  });

  const result = await service.createBindingQrcode("challenge-1", 900);
  assert.equal(result.qrCodeUrl, "https://wxpusher.zjiecode.com/qrcode/test.png");
  assert.deepEqual(requests[0].body, {
    appToken: "AT_secret",
    extra: "challenge-1",
    validTime: 900,
  });
  assert.equal(JSON.stringify(result).includes("AT_secret"), false);
});

test("WxPusherService sends one private non-paid UID notification", async () => {
  const requests = [];
  const service = new WxPusherService({
    appToken: "AT_secret",
    appId: "123",
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({
        code: 1000,
        success: true,
        data: [{ uid: "UID_target123", code: 1000, sendRecordId: 42 }],
      });
    },
  });

  const result = await service.send({ uid: "UID_target123", summary: "开始进食", content: "设备：测试" });
  assert.equal(result.ok, true);
  assert.deepEqual(requests[0].body.uids, ["UID_target123"]);
  assert.equal(requests[0].body.verifyPayType, 0);
  assert.equal(requests[0].body.contentType, 1);
  assert.equal(result.status, "pending");
  assert.equal(result.sendRecordId, "42");
});

test("WxPusherService rejects mismatched targets and missing send record ids", async () => {
  const responses = [
    { code: 1000, success: true, data: [{ uid: "UID_other", code: 1000, sendRecordId: 42 }] },
    { code: 1000, success: true, data: [{ uid: "UID_target123", code: 1000 }] },
  ];
  const service = new WxPusherService({
    appToken: "AT_secret",
    appId: "123",
    fetchImpl: async () => jsonResponse(responses.shift()),
  });
  await assert.rejects(
    () => service.send({ uid: "UID_target123", content: "test" }),
    /WXPUSHER_TARGET_RESULT_MISSING/
  );
  await assert.rejects(
    () => service.send({ uid: "UID_target123", content: "test" }),
    /WXPUSHER_SEND_RECORD_ID_MISSING/
  );
});

test("WxPusherService queries final status by sendRecordId", async () => {
  const requests = [];
  const service = new WxPusherService({
    appToken: "AT_secret",
    appId: "123",
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method });
      return jsonResponse({ code: 1000, success: true, data: { status: "推送成功" } });
    },
  });
  const result = await service.queryDeliveryStatus("42");
  assert.equal(result.status, "delivered");
  assert.equal(result.sendRecordId, "42");
  assert.match(requests[0].url, /sendRecordId=42/);
  assert.equal(requests[0].method, "GET");
});

test("WxPusherService treats the provider's primitive status 1 as delivered", async () => {
  const service = new WxPusherService({
    appToken: "AT_secret",
    appId: "123",
    fetchImpl: async () => jsonResponse({ code: 1000, success: true, data: 1 }),
  });

  const result = await service.queryDeliveryStatus("2425002982");
  assert.equal(result.status, "delivered");
  assert.equal(result.providerStatus, "1");
});

test("WxPusherService redacts appToken from provider failures", async () => {
  const service = new WxPusherService({
    appToken: "AT_secret",
    appId: "123",
    fetchImpl: async () => { throw new Error("request AT_secret rejected"); },
  });
  await assert.rejects(
    () => service.send({ uid: "UID_target123", content: "test" }),
    (error) => error.message.includes("[redacted]") && !error.message.includes("AT_secret")
  );
});
