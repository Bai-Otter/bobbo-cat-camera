const test = require("node:test");
const assert = require("node:assert/strict");

const { refreshDeviceToken } = require("./deviceTokenRefresh.js");

test("refreshDeviceToken fetches the current SDK token for one serial number", async () => {
  const calls = [];
  const sdk = {
    getDeviceToken(payload, callback) {
      calls.push(payload);
      callback({ code: 2000, data: { tokens: [{ sn: "SN-1", token: "fresh-token" }] } });
    },
  };

  assert.equal(await refreshDeviceToken({ sdk, sn: "SN-1", timeoutMs: 50 }), "fresh-token");
  assert.deepEqual(calls, [{ sns: ["SN-1"] }]);
});

test("refreshDeviceToken rejects a successful response that does not contain the requested device", async () => {
  const sdk = {
    getDeviceToken(payload, callback) {
      callback({ code: 2000, data: { tokens: [{ sn: "SN-2", token: "other-token" }] } });
    },
  };

  await assert.rejects(
    refreshDeviceToken({ sdk, sn: "SN-1", timeoutMs: 50 }),
    { code: "DEVICE_TOKEN_REFRESH_EMPTY" }
  );
});

test("refreshDeviceToken falls back to the authenticated backend when the SDK returns no token", async () => {
  const backendCalls = [];
  const sdk = {
    getDeviceToken(payload, callback) {
      callback({ code: 2000, data: { tokens: [] } });
    },
  };

  const token = await refreshDeviceToken({
    sdk,
    sn: "SN-1",
    timeoutMs: 50,
    fetchBackendToken: async (sn) => {
      backendCalls.push(sn);
      return { ok: true, deviceToken: "backend-token" };
    },
  });

  assert.equal(token, "backend-token");
  assert.deepEqual(backendCalls, ["SN-1"]);
});
