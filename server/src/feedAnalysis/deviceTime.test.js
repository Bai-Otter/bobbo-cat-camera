const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatDeviceDateKey,
  formatDeviceDateTime,
  parseDeviceDateTime,
} = require("./deviceTime");

test("device wall-clock time remains Asia/Shanghai when the server runs in UTC", () => {
  const instant = new Date("2026-08-22T00:00:00.000Z");
  assert.equal(formatDeviceDateTime(instant), "2026-08-22 08:00:00");
  assert.equal(formatDeviceDateKey(instant), "2026-08-22");
  assert.equal(parseDeviceDateTime("2026-08-22 08:00:00").toISOString(), instant.toISOString());
});

test("device time parser preserves explicit offsets", () => {
  assert.equal(
    parseDeviceDateTime("2026-08-22T08:00:00+08:00").toISOString(),
    "2026-08-22T00:00:00.000Z"
  );
});

test("device time parser keeps numeric instants and rejects malformed local text", () => {
  const timestamp = Date.parse("2026-08-22T00:00:00.123Z");
  assert.equal(parseDeviceDateTime(timestamp).getTime(), timestamp);
  assert.equal(parseDeviceDateTime("not-a-device-time"), null);
});
