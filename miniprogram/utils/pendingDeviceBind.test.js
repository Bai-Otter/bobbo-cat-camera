const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDeviceBindDraft,
  clearPendingDeviceBind,
  readPendingDeviceBind,
  savePendingDeviceBind,
} = require("./pendingDeviceBind.js");

function createUniStorage() {
  const store = new Map();
  return {
    getStorageSync(key) {
      return store.has(key) ? store.get(key) : "";
    },
    setStorageSync(key, value) {
      store.set(key, value);
    },
    removeStorageSync(key) {
      store.delete(key);
    },
  };
}

test("savePendingDeviceBind extracts bindable fields from BLE config", () => {
  const uniApi = createUniStorage();

  const saved = savePendingDeviceBind(
    {
      deviceNo: "SN001",
      userName: "",
      password: "",
      devIp: "192.168.2.88",
      port: "34567",
      token: "ble-token",
    },
    uniApi
  );

  assert.equal(saved.sn, "SN001");
  assert.equal(saved.username, "admin");
  assert.equal(saved.password, "");
  assert.equal(saved.ip, "192.168.2.88");
  assert.equal(saved.port, "34567");
  assert.equal(saved.pairingToken, undefined);
  assert.equal(readPendingDeviceBind(uniApi).sn, "SN001");
  assert.equal(readPendingDeviceBind(uniApi).port, "34567");
});

test("buildDeviceBindDraft keeps BLE admin token out of phone storage", () => {
  const uniApi = createUniStorage();
  const rawTokenHex = "2f5a5147486c687570476e514974774e5a3156444a57375834576965354650626d706970654761796e72383d";

  const draft = buildDeviceBindDraft({ deviceNo: "SN001", token: rawTokenHex });
  const saved = savePendingDeviceBind({ deviceNo: "SN001", token: rawTokenHex }, uniApi);

  assert.equal(draft.adminToken, "/ZQGHlhupGnQItwNZ1VDJW7X4Wie5FPbmpipeGaynr8=");
  assert.equal(saved.adminToken, undefined);
  assert.equal(readPendingDeviceBind(uniApi).adminToken, undefined);
});

test("savePendingDeviceBind can recover SN from hex devId", () => {
  const uniApi = createUniStorage();

  const saved = savePendingDeviceBind({ devId: "32653231643134613864333064656436" }, uniApi);

  assert.equal(saved.sn, "2e21d14a8d30ded6");
});

test("clearPendingDeviceBind removes saved pairing result", () => {
  const uniApi = createUniStorage();
  savePendingDeviceBind({ deviceNo: "SN001" }, uniApi);

  clearPendingDeviceBind(uniApi);

  assert.equal(readPendingDeviceBind(uniApi), null);
});
