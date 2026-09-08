const { readAppAuthState } = require("./appAuth.js");

// v2 intentionally drops pre-authoritative caches that could resurrect an already
// removed device after family sharing was introduced.
const CACHE_PREFIX = "ownedDevices:v2:";
const LAST_VIEWED_DEVICE_KEY = "lastViewedDeviceSn";

function getApi(uniApi) {
  return uniApi || (typeof uni !== "undefined" ? uni : null);
}

function cacheKey(uniApi) {
  const auth = readAppAuthState(uniApi);
  const owner = String(auth.userId || auth.openid || "").trim();
  return owner ? `${CACHE_PREFIX}${owner}` : "";
}

function sanitizeDevice(device = {}) {
  const sn = String(device.sn || device.deviceNo || "").trim();
  if (!sn) return null;
  return {
    sn,
    nickname: String(device.nickname || ""),
    username: String(device.username || "admin"),
    ip: String(device.ip || device.devIp || device.ipAddress || ""),
    port: String(device.port || ""),
    active: device.active === true,
    coverUrl: String(device.coverUrl || ""),
    coverUpdatedAt: Number(device.coverUpdatedAt) || 0,
    _online: device._online === true || device.online === true,
    _statusState: ["online", "offline", "unknown", "error"].includes(String(device._statusState || ""))
      ? String(device._statusState)
      : device._online === true || device.online === true ? "online" : "unknown",
    statusCheckedAt: Number(device.statusCheckedAt || (device.status && device.status.checkedAt)) || 0,
    statusErrorAt: Number(device.statusErrorAt) || 0,
    statusErrorCode: String(device.statusErrorCode || ""),
    role: device.role === "member" ? "member" : "owner",
    joinedAt: Number(device.joinedAt) || 0,
    primaryCatId: String(device.primaryCatId || ""),
    primaryCatRef: String(device.primaryCatRef || ""),
    permissions: Array.isArray(device.permissions) ? device.permissions.slice() : [],
    liveDiagnosticsEnabled: device.liveDiagnosticsEnabled === true,
  };
}

function mergeFetchedDevicesWithCache(fetched = [], cached = []) {
  const cachedBySn = new Map(normalizeList(cached).map((device) => [device.sn, device]));
  return normalizeList(fetched).map((device) => {
    const previous = cachedBySn.get(device.sn);
    if (!previous) return device;
    return Object.assign({}, device, {
      coverUrl: device.coverUrl || previous.coverUrl,
      coverUpdatedAt: device.coverUpdatedAt || previous.coverUpdatedAt,
      _online: previous._online,
      _statusState: previous._statusState,
      statusCheckedAt: previous.statusCheckedAt,
      statusErrorAt: previous.statusErrorAt,
      statusErrorCode: previous.statusErrorCode,
    });
  });
}

function normalizeList(devices) {
  const seen = new Set();
  return (Array.isArray(devices) ? devices : []).reduce((list, device) => {
    const safe = sanitizeDevice(device);
    if (!safe || seen.has(safe.sn)) return list;
    seen.add(safe.sn);
    list.push(safe);
    return list;
  }, []);
}

function readOwnedDevices(uniApi) {
  const api = getApi(uniApi);
  const key = cacheKey(api);
  if (!api || !key) return [];
  const raw = api.getStorageSync(key);
  if (!raw) return [];
  try {
    return normalizeList(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch (error) {
    return [];
  }
}

function replaceOwnedDevices(devices, uniApi) {
  const api = getApi(uniApi);
  const key = cacheKey(api);
  const safe = normalizeList(devices);
  if (api && key) api.setStorageSync(key, JSON.stringify(safe));
  return safe;
}

function upsertOwnedDevice(device, uniApi) {
  const safe = sanitizeDevice(device);
  if (!safe) return readOwnedDevices(uniApi);
  const current = readOwnedDevices(uniApi);
  const index = current.findIndex((item) => item.sn === safe.sn);
  if (index >= 0) current[index] = Object.assign({}, current[index], safe);
  else current.push(safe);
  return replaceOwnedDevices(current, uniApi);
}

async function refreshOwnedDevices(fetchDevices, uniApi) {
  const api = getApi(uniApi);
  const cached = readOwnedDevices(api);
  if (typeof fetchDevices !== "function") throw new Error("OWNED_DEVICES_FETCH_REQUIRED");

  try {
    const fetched = await fetchDevices();
    if (!Array.isArray(fetched)) throw new Error("OWNED_DEVICES_RESPONSE_INVALID");

    const next = replaceOwnedDevices(mergeFetchedDevicesWithCache(fetched, cached), api);
    const lastViewedSn = api ? String(api.getStorageSync(LAST_VIEWED_DEVICE_KEY) || "").trim() : "";
    const previousActive = cached.find((item) => item.active);
    const nextActive = next.find((item) => item.active);
    const lastViewedStillExists = next.some((item) => item.sn === lastViewedSn);
    const lastViewedWasReplacedActive = !!(
      lastViewedSn &&
      previousActive &&
      nextActive &&
      previousActive.sn === lastViewedSn &&
      previousActive.sn !== nextActive.sn
    );

    if (api && next.length === 0) {
      // A successful empty response is authoritative; never keep a removed device selected.
      api.removeStorageSync(LAST_VIEWED_DEVICE_KEY);
    } else if (
      api &&
      nextActive &&
      (!lastViewedSn || !lastViewedStillExists || lastViewedWasReplacedActive)
    ) {
      api.setStorageSync(LAST_VIEWED_DEVICE_KEY, nextActive.sn);
    }

    return { devices: next, refreshed: true, error: null };
  } catch (error) {
    if (cached.length === 0) throw error;
    return { devices: cached, refreshed: false, error };
  }
}

module.exports = {
  readOwnedDevices,
  refreshOwnedDevices,
  mergeFetchedDevicesWithCache,
  replaceOwnedDevices,
  sanitizeDevice,
  upsertOwnedDevice,
};
