const assert = require("node:assert/strict");
const test = require("node:test");

const {
  sanitizeClip,
  sanitizeRecord,
  validateWindow,
} = require("./validate-feeding-window");

test("feeding window acceptance requires exactly thirty minutes", () => {
  const window = validateWindow("2026-08-22 08:00:00", "2026-08-22 08:30:00");
  assert.equal(window.durationSec, 1800);
  assert.throws(
    () => validateWindow("2026-08-22 08:00:00", "2026-08-22 08:29:59"),
    /VALIDATION_WINDOW_MUST_BE_30_MINUTES/
  );
});

test("feeding window acceptance output excludes signed media details", () => {
  assert.deepEqual(sanitizeRecord({
    BeginTime: "2026-08-22 08:00:00",
    EndTime: "2026-08-22 09:00:00",
    FileName: "secret-recording.h264",
  }), {
    beginTime: "2026-08-22 08:00:00",
    endTime: "2026-08-22 09:00:00",
    fileNamePresent: true,
  });
  assert.deepEqual(sanitizeClip({
    beginTime: "2026-08-22 08:00:00",
    endTime: "2026-08-22 08:30:00",
    hasCat: true,
    hasFeeding: true,
    feedingStats: { summary: { mealCount: 1, actualEatingSeconds: 42, bowlPresenceSeconds: 58 } },
    markers: [{ markerType: "feeding_start" }],
  }), {
    beginTime: "2026-08-22 08:00:00",
    endTime: "2026-08-22 08:30:00",
    hasCat: true,
    hasFeeding: true,
    mealCount: 1,
    actualEatingSec: 42,
    bowlPresenceSec: 58,
    markerCount: 1,
  });
});
