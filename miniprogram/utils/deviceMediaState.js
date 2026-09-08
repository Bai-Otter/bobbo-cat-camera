const COVER_STALE_MS = 30 * 60 * 1000;
const DEFAULT_TIME_SYNC_THRESHOLD_SECONDS = 120;

function toEpochMs(value) {
  if (!value && value !== 0) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value).trim();
  if (!normalized) return 0;
  const matched = normalized.match(
    /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/
  );
  if (matched) {
    return new Date(
      Number(matched[1]),
      Number(matched[2]) - 1,
      Number(matched[3]),
      Number(matched[4]),
      Number(matched[5]),
      Number(matched[6])
    ).getTime();
  }
  const date = new Date(normalized.replace(/-/g, "/"));
  const ts = date.getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function buildDeviceCards({ devices = [], coversBySn = {}, now = Date.now() }) {
  return devices.map((device) => {
    const cover = coversBySn[device.sn] || null;
    const refreshedCoverUrl = String((cover && cover.coverUrl) || "");
    const coverUrl = refreshedCoverUrl || String(device.coverUrl || "");
    const coverUpdatedAt = Number(
      refreshedCoverUrl ? cover && cover.updatedAt : device.coverUpdatedAt
    ) || 0;
    const hasCover = !!coverUrl;
    return Object.assign({}, device, {
      coverUrl,
      coverUpdatedAt,
      isCoverStale: hasCover ? now - coverUpdatedAt > COVER_STALE_MS : false,
      streamReadyState: device.token ? "ready" : "idle",
    });
  });
}

function normalizeStatus(raw = {}) {
  const statusValue = String(raw.status || raw.Status || "").trim();
  const online = statusValue === "online" || raw.online === true || raw.Online === true;
  const offline = statusValue.toLowerCase() === "offline" || statusValue.toLowerCase() === "off_line";
  const state = online ? "online" : offline ? "offline" : "unknown";
  return {
    status: state === "offline" ? "offLine" : state,
    statusDesc: state === "online" ? "在线" : state === "offline" ? "离线" : "状态未知",
    checkedAt: Number(raw.checkedAt) || 0,
    raw,
  };
}

function rowSn(row = {}) {
  return String(row.sn || row.uuid || row.deviceSn || "").trim();
}

function normalizeOwnedDevice(device = {}, tokenBySn = {}, statusBySn = {}) {
  const sn = String(device.sn || "").trim();
  const token = String(tokenBySn[sn] || device.token || device.deviceToken || "").trim();
  const freshStatus = statusBySn[sn];
  const cachedState = ["online", "offline", "error"].includes(String(device._statusState || ""))
    ? String(device._statusState)
    : "unknown";
  const cachedStatus = {
    status: cachedState === "offline" ? "offLine" : cachedState,
    statusDesc: cachedState === "online" ? "在线" : cachedState === "offline" ? "离线" : cachedState === "error" ? "状态异常" : "状态未知",
    checkedAt: Number(device.statusCheckedAt) || 0,
    source: "cache",
  };
  const status = freshStatus || (device.status && typeof device.status === "object" ? device.status : cachedStatus);
  const statusState = status.status === "online" ? "online" : status.status === "offLine" ? "offline" : status.status === "error" ? "error" : "unknown";
  const online = statusState === "online";
  const publicDevice = Object.assign({}, device);
  delete publicDevice.password;
  delete publicDevice.adminToken;
  return Object.assign({}, publicDevice, {
    sn,
    token,
    deviceToken: token,
    username: device.username || "admin",
    nickname: device.nickname || "摄像头",
    status,
    _online: !!online,
    _statusState: statusState,
    statusCheckedAt: Number(status.checkedAt || device.statusCheckedAt) || 0,
  });
}

function buildOwnedDeviceCards({
  devices = [],
  tokenRows = [],
  statusRows = [],
  coversBySn = {},
  now = Date.now(),
}) {
  const tokenBySn = tokenRows.reduce((acc, row) => {
    const sn = rowSn(row);
    if (sn) acc[sn] = row.token || row.deviceToken || "";
    return acc;
  }, {});
  const statusBySn = statusRows.reduce((acc, row) => {
    const sn = rowSn(row);
    if (sn) acc[sn] = normalizeStatus(row);
    return acc;
  }, {});
  const ownedDevices = devices
    .filter((device) => device && device.sn)
    .map((device) => normalizeOwnedDevice(device, tokenBySn, statusBySn));
  return buildDeviceCards({ devices: ownedDevices, coversBySn, now });
}

function canUseDirectLiveSdk(device = {}) {
  if (!device || !String(device.sn || "").trim()) return false;
  return device.role !== "member";
}

function selectDirectLiveSdkDevices(devices = [], options = {}) {
  return devices.filter((device) => canUseDirectLiveSdk(device, options));
}

function buildLivestreamPlan({
  platform = "",
  quality = "0",
  username = "",
  password = "",
  confirmedCandidates = [],
}) {
  const primary = {
    key: "hls-ts",
    mediaType: "hls",
    protocol: "ts",
    stream: String(quality || "0"),
    channel: "0",
    username,
    password,
  };

  const candidates =
    platform === "mp-weixin" ? [] : Array.isArray(confirmedCandidates) ? confirmedCandidates : [];

  return {
    primary,
    candidates,
    fallback: Object.assign({}, primary),
  };
}

function classifyLivestreamFailure(stage) {
  if (stage === "missing-token") return "missing-token";
  if (stage === "device-login") return "device-login";
  if (
    stage === "requesting-primary-stream" ||
    stage === "requesting-fallback-stream" ||
    stage === "requesting-stream"
  ) {
    return "stream-request";
  }
  return "playback";
}

function shouldFallbackToSdkLive({ source = "", deviceToken = "", attempted = false } = {}) {
  return source === "backend" && !!String(deviceToken || "").trim() && attempted !== true;
}

function isTransientLivestreamFailure(value) {
  if (!value || value instanceof Error) return false;
  const candidates = [value, value.data, value.data && value.data.data]
    .filter((item) => item && typeof item === "object");
  return candidates.some((item) => {
    const code = Number(item.code !== undefined && item.code !== null ? item.code : item.Code);
    const message = String(item.msg || item.message || item.Msg || "");
    return code === -99991 && /xmts\s+hittest\s+failed/i.test(message);
  });
}

function getTimeDriftSeconds(deviceTime, nowMs = Date.now()) {
  const deviceMs = toEpochMs(deviceTime);
  if (!deviceMs) return 0;
  return Math.round(Math.abs(nowMs - deviceMs) / 1000);
}

function shouldPromptTimeSync({
  deviceTime,
  nowMs = Date.now(),
  promptShown = false,
  thresholdSeconds = DEFAULT_TIME_SYNC_THRESHOLD_SECONDS,
}) {
  if (promptShown) return false;
  return getTimeDriftSeconds(deviceTime, nowMs) > thresholdSeconds;
}

function findTimeString(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const match = value.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
    return match ? match[0] : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTimeString(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      const found = findTimeString(value[key]);
      if (found) return found;
    }
  }
  return "";
}

function extractDeviceTime(response) {
  if (!response || typeof response !== "object") return "";
  return findTimeString(response);
}

function formatDateTime(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function buildTimeSyncPayload(mode = "local", date = new Date()) {
  if (mode === "utc") {
    return {
      Name: "OPUTCTimeSetting",
      OPUTCTimeSetting: formatDateTime(date),
    };
  }
  return {
    Name: "OPTimeSetting",
    OPTimeSetting: formatDateTime(date),
  };
}

module.exports = {
  COVER_STALE_MS,
  DEFAULT_TIME_SYNC_THRESHOLD_SECONDS,
  buildDeviceCards,
  buildOwnedDeviceCards,
  canUseDirectLiveSdk,
  selectDirectLiveSdkDevices,
  buildLivestreamPlan,
  buildTimeSyncPayload,
  classifyLivestreamFailure,
  isTransientLivestreamFailure,
  shouldFallbackToSdkLive,
  extractDeviceTime,
  getTimeDriftSeconds,
  shouldPromptTimeSync,
};
