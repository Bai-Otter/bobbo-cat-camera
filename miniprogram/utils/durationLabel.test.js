const test = require("node:test");
const assert = require("node:assert/strict");

const { formatDurationLabel } = require("./durationLabel.js");

test("formatDurationLabel keeps seconds as the smallest unit", () => {
  assert.equal(formatDurationLabel(5), "5秒");
  assert.equal(formatDurationLabel(65), "1分05秒");
  assert.equal(formatDurationLabel(3723), "1小时02分03秒");
});

test("formatDurationLabel normalizes invalid or tiny durations to one second", () => {
  assert.equal(formatDurationLabel(0), "1秒");
  assert.equal(formatDurationLabel(null), "1秒");
  assert.equal(formatDurationLabel("12.6"), "13秒");
});
