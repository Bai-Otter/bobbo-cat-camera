const test = require("node:test");
const assert = require("node:assert/strict");

const {
  readOwnedDevices,
  refreshOwnedDevices,
  replaceOwnedDevices,
  upsertOwnedDevice,
} = require("./ownedDeviceCache.js");

function makeApi(session) {
  const store = new Map([
    ["catBackendSession", JSON.stringify(session)],
  ]);
  return {
    getStorageSync(key) { return store.get(key) || ""; },
    setStorageSync(key, value) { store.set(key, value); },
    store,
  };
}

test("owned devices are cached per signed-in user without credentials", () => {
  const api = makeApi({ openid: "owner-a", sessionToken: "session-a" });
  replaceOwnedDevices([
    { sn: "SN-1", nickname: "Kitchen", username: "admin", password: "secret", adminToken: "token", coverUrl: "https://cloud.test/cover.jpg", coverUpdatedAt: 123, _online: true, liveDiagnosticsEnabled: true },
  ], api);

  assert.deepEqual(readOwnedDevices(api), [{
    sn: "SN-1",
    nickname: "Kitchen",
    username: "admin",
    ip: "",
    port: "",
    active: false,
    coverUrl: "https://cloud.test/cover.jpg",
    coverUpdatedAt: 123,
    _online: true,
    _statusState: "online",
    statusCheckedAt: 0,
    statusErrorAt: 0,
    statusErrorCode: "",
    role: "owner",
    joinedAt: 0,
    primaryCatId: "",
    primaryCatRef: "",
    permissions: [],
    liveDiagnosticsEnabled: true,
  }]);

  const otherApi = makeApi({ openid: "owner-b", sessionToken: "session-b" });
  assert.deepEqual(readOwnedDevices(otherApi), []);
});

test("a successful bind is immediately upserted into the cached device list", () => {
  const api = makeApi({ openid: "owner-a", sessionToken: "session-a" });
  replaceOwnedDevices([{ sn: "SN-1", nickname: "Old" }], api);
  upsertOwnedDevice({ sn: "SN-2", nickname: "New", password: "must-not-persist" }, api);
  upsertOwnedDevice({ sn: "SN-1", nickname: "Renamed" }, api);

  assert.deepEqual(readOwnedDevices(api).map(({ sn, nickname }) => ({ sn, nickname })), [
    { sn: "SN-1", nickname: "Renamed" },
    { sn: "SN-2", nickname: "New" },
  ]);
  assert.equal(JSON.stringify([...api.store.values()]).includes("must-not-persist"), false);
});

test("refreshOwnedDevices always replaces a stale cached list with backend ownership", async () => {
  const api = makeApi({ openid: "owner-a", sessionToken: "session-a" });
  replaceOwnedDevices([{ sn: "OLD-SN", nickname: "Old", active: true }], api);
  api.setStorageSync("lastViewedDeviceSn", "OLD-SN");

  let requests = 0;
  const result = await refreshOwnedDevices(async () => {
    requests += 1;
    return [
      { sn: "NEW-SN", nickname: "New", active: true },
      { sn: "OLD-SN", nickname: "Old", active: false },
    ];
  }, api);

  assert.equal(requests, 1);
  assert.equal(result.refreshed, true);
  assert.deepEqual(result.devices.map(({ sn, active }) => ({ sn, active })), [
    { sn: "NEW-SN", active: true },
    { sn: "OLD-SN", active: false },
  ]);
  assert.equal(api.getStorageSync("lastViewedDeviceSn"), "NEW-SN");
});

test("refreshOwnedDevices keeps transient status and cover for devices that still exist", async () => {
  const api = makeApi({ openid: "owner-a", sessionToken: "session-a" });
  replaceOwnedDevices([{
    sn: "SN-1",
    nickname: "Old",
    coverUrl: "https://old.test/cover.jpg",
    coverUpdatedAt: 123,
    _online: true,
    _statusState: "online",
    statusCheckedAt: 99,
  }], api);

  const result = await refreshOwnedDevices(async () => [{ sn: "SN-1", nickname: "New" }], api);
  assert.equal(result.devices[0].nickname, "New");
  assert.equal(result.devices[0].coverUrl, "https://old.test/cover.jpg");
  assert.equal(result.devices[0]._statusState, "online");
  assert.equal(result.devices[0].statusCheckedAt, 99);
});

test("refreshOwnedDevices preserves an intentional non-active selection after the cache is current", async () => {
  const api = makeApi({ openid: "owner-a", sessionToken: "session-a" });
  replaceOwnedDevices([
    { sn: "NEW-SN", active: true },
    { sn: "OLD-SN", active: false },
  ], api);
  api.setStorageSync("lastViewedDeviceSn", "OLD-SN");

  await refreshOwnedDevices(async () => [
    { sn: "NEW-SN", active: true },
    { sn: "OLD-SN", active: false },
  ], api);

  assert.equal(api.getStorageSync("lastViewedDeviceSn"), "OLD-SN");
});

test("refreshOwnedDevices falls back to an existing cache when the backend is unavailable", async () => {
  const api = makeApi({ openid: "owner-a", sessionToken: "session-a" });
  replaceOwnedDevices([{ sn: "CACHED-SN", active: true }], api);

  const result = await refreshOwnedDevices(async () => {
    throw new Error("BACKEND_NETWORK_FAILED");
  }, api);

  assert.equal(result.refreshed, false);
  assert.equal(result.error.message, "BACKEND_NETWORK_FAILED");
  assert.deepEqual(result.devices.map((item) => item.sn), ["CACHED-SN"]);
});
