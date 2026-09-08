const DEVICE_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseDeviceDateTime(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const text = String(value || "").trim();
  const localMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
  );
  if (localMatch) {
    const [, year, month, day, hour, minute, second, fraction = "0"] = localMatch;
    const milliseconds = Number(fraction.padEnd(3, "0"));
    const timestamp = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      milliseconds
    ) - DEVICE_UTC_OFFSET_MS;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDeviceDateTime(value) {
  const date = parseDeviceDateTime(value);
  if (!date) return "";
  const shifted = new Date(date.getTime() + DEVICE_UTC_OFFSET_MS);
  return [
    shifted.getUTCFullYear(),
    pad2(shifted.getUTCMonth() + 1),
    pad2(shifted.getUTCDate()),
  ].join("-") + ` ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`;
}

function formatDeviceDateKey(value = new Date()) {
  return formatDeviceDateTime(value).slice(0, 10);
}

module.exports = {
  DEVICE_UTC_OFFSET_MS,
  formatDeviceDateKey,
  formatDeviceDateTime,
  parseDeviceDateTime,
};
