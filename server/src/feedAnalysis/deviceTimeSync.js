const { formatDeviceDateTime, parseDeviceDateTime } = require("./deviceTime");

function extractDeviceTime(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.OPTimeQuery === "string") return payload.OPTimeQuery.trim();
  if (typeof payload.OPTimeSetting === "string") return payload.OPTimeSetting.trim();
  if (typeof payload.OPUTCTimeSetting === "string") return payload.OPUTCTimeSetting.trim();
  for (const value of Object.values(payload)) {
    const found = extractDeviceTime(value);
    if (found) return found;
  }
  return "";
}

async function readDeviceClock(device) {
  if (!device || typeof device.opdev !== "function") throw new Error("DEVICE_OPDEV_UNAVAILABLE");
  const data = await device.opdev({ Name: "OPTimeQuery" });
  const deviceTime = extractDeviceTime(data);
  const parsed = parseDeviceDateTime(deviceTime);
  if (!parsed) throw new Error("DEVICE_TIME_READBACK_INVALID");
  return { deviceTime, date: parsed, data };
}

async function syncDeviceClock(device, now = new Date(), { maxDriftMs = 5_000 } = {}) {
  if (!device || typeof device.opdev !== "function") throw new Error("DEVICE_OPDEV_UNAVAILABLE");
  const targetDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(targetDate.getTime())) throw new Error("DEVICE_TIME_INVALID");
  const requestedTime = formatDeviceDateTime(targetDate);
  const data = await device.opdev({
    Name: "OPTimeSetting",
    OPTimeSetting: requestedTime,
  });
  const readback = await readDeviceClock(device);
  const driftMs = Math.abs(readback.date.getTime() - targetDate.getTime());
  return {
    synced: driftMs <= Math.max(0, Number(maxDriftMs) || 0),
    requestedTime,
    deviceTime: readback.deviceTime,
    driftMs,
    data,
    readback: readback.data,
  };
}

module.exports = {
  extractDeviceTime,
  readDeviceClock,
  syncDeviceClock,
};
