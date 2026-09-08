const test = require("node:test");
const assert = require("node:assert/strict");

const { downloadQrImage } = require("./qrImageLoader");

test("downloadQrImage uses authenticated Cloud Hosting binary access", async () => {
  const calls = [];
  const previousWx = global.wx;
  global.wx = {
    cloud: {
      callContainer(options) {
        calls.push(options);
        options.success({
          statusCode: 200,
          header: { "content-type": "image/jpeg" },
          data: Uint8Array.from([81, 82, 49]).buffer,
        });
      },
    },
    arrayBufferToBase64(buffer) {
      return Buffer.from(buffer).toString("base64");
    },
    getStorageSync(key) {
      if (key === "catBackendSession") return JSON.stringify({ sessionToken: "session-1" });
      return "";
    },
  };
  try {
    const result = await downloadQrImage(
      "https://cat-feeding-api.example/api/feed-analysis/notifications/service-qr-image",
      undefined,
      {
        mode: "cloud-hosting",
        cloud: {
          envId: "YOUR_CLOUDBASE_ENV",
          serviceName: "cat-feeding-api",
          publicBaseUrl: "https://cat-feeding-api.example",
        },
      }
    );
    assert.equal(result, "data:image/jpeg;base64,UVIx");
    assert.deepEqual(calls[0].config, { env: "YOUR_CLOUDBASE_ENV" });
    assert.equal(calls[0].path, "/api/feed-analysis/notifications/service-qr-image");
    assert.equal(calls[0].method, "GET");
    assert.deepEqual(calls[0].header, {
      "X-WX-SERVICE": "cat-feeding-api",
      "X-Cat-Session": "session-1",
    });
    assert.equal(calls[0].responseType, "arraybuffer");
  } finally {
    global.wx = previousWx;
  }
});

test("downloadQrImage returns a local temporary path for inline rendering", async () => {
  const calls = [];
  const uniApi = {
    getStorageSync(key) {
      if (key === "catBackendSession") return JSON.stringify({ sessionToken: "session-1" });
      return "";
    },
    downloadFile(options) {
      calls.push({ url: options.url, header: options.header });
      options.success({ statusCode: 200, tempFilePath: "wxfile://tmp/service-qr.jpg" });
    },
  };

  const result = await downloadQrImage("http://backend.test/service-qr", uniApi);

  assert.equal(result, "wxfile://tmp/service-qr.jpg");
  assert.deepEqual(calls, [{
    url: "http://backend.test/service-qr",
    header: { "X-Cat-Session": "session-1" },
  }]);
});

test("downloadQrImage rejects an unsuccessful download instead of showing a blank image", async () => {
  const uniApi = {
    downloadFile(options) {
      options.success({ statusCode: 502, tempFilePath: "" });
    },
  };

  await assert.rejects(
    downloadQrImage("http://backend.test/friend-qr", uniApi),
    /QR_IMAGE_DOWNLOAD_502/
  );
});
