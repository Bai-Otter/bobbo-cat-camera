const test = require("node:test");
const assert = require("node:assert/strict");

const { PushPlusOpenApi } = require("./pushPlusOpenApi");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test("PushPlusOpenApi exchanges credentials once and generates user-specific friend QR codes", async () => {
  const requests = [];
  const api = new PushPlusOpenApi({
    token: "user-token",
    secretKey: "server-secret",
    baseUrl: "https://pushplus.example",
    nowProvider: () => 1_000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/api/common/openApi/getAccessKey")) {
        return jsonResponse({ code: 200, data: { accessKey: "access-1", expiresIn: 7200 } });
      }
      return jsonResponse({
        code: 200,
        data: { qrCodeImgUrl: `https://mp.weixin.qq.com/qr/${requests.length}` },
      });
    },
  });

  const first = await api.getFriendQrCode({ content: "bind-code-1", second: 3600, scanCount: 1 });
  const second = await api.getFriendQrCode({ content: "bind-code-2", second: 7200, scanCount: 1 });

  assert.equal(first.qrCodeImgUrl, "https://mp.weixin.qq.com/qr/2");
  assert.equal(second.qrCodeImgUrl, "https://mp.weixin.qq.com/qr/3");
  assert.equal(requests.filter((item) => item.url.includes("getAccessKey")).length, 1);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    token: "user-token",
    secretKey: "server-secret",
  });
  assert.match(requests[1].url, /content=bind-code-1/);
  assert.match(requests[1].url, /second=3600/);
  assert.match(requests[1].url, /scanCount=1/);
  assert.equal(requests[1].options.headers["access-key"], "access-1");
});

test("PushPlusOpenApi reports missing open API credentials without making a request", async () => {
  let called = false;
  const api = new PushPlusOpenApi({
    token: "user-token",
    secretKey: "",
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ code: 200 });
    },
  });

  assert.equal(api.isConfigured(), false);
  await assert.rejects(api.getFriendQrCode({ content: "bind" }), /PUSHPLUS_OPEN_API_NOT_CONFIGURED/);
  assert.equal(called, false);
});
