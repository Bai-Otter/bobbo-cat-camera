const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDiaryFromRecords,
  buildFoodcast,
  formatDateKey,
} = require("./demoDiary.js");

test("buildDiaryFromRecords keeps motion records and duration candidates", () => {
  const diary = buildDiaryFromRecords({
    deviceSn: "SN001",
    date: "2026-07-02",
    records: [
      {
        BeginTime: "2026-07-02 08:00:00",
        EndTime: "2026-07-02 08:00:05",
        FileName: "too-short.mp4",
      },
      {
        BeginTime: "2026-07-02 08:10:00",
        EndTime: "2026-07-02 08:10:08",
        FileName: "motion-short.mp4",
        Event: "MotionDetect",
      },
      {
        BeginTime: "2026-07-02 12:00:00",
        EndTime: "2026-07-02 12:02:00",
        FileName: "lunch.mp4",
      },
      {
        BeginTime: "2026-07-02 20:00:00",
        EndTime: "2026-07-02 20:15:00",
        FileName: "too-long.mp4",
      },
    ],
  });

  assert.equal(diary.clipCount, 2);
  assert.equal(diary.clips[0].fileName, "motion-short.mp4");
  assert.equal(diary.clips[1].durationSec, 120);
  assert.equal(diary.eatCount, 2);
  assert.equal(diary.eatMinutes, 3);
  assert.equal(diary.featuredClipId, diary.clips[1].id);
});

test("buildDiaryFromRecords merges clips in the same 20 minute meal window", () => {
  const diary = buildDiaryFromRecords({
    deviceSn: "SN002",
    date: "2026-07-02",
    records: [
      {
        BeginTime: "2026-07-02 18:00:00",
        EndTime: "2026-07-02 18:01:00",
        FileName: "first.mp4",
      },
      {
        BeginTime: "2026-07-02 18:15:00",
        EndTime: "2026-07-02 18:16:00",
        FileName: "same-meal.mp4",
      },
      {
        BeginTime: "2026-07-02 18:25:00",
        EndTime: "2026-07-02 18:26:00",
        FileName: "next-meal.mp4",
      },
    ],
  });

  assert.equal(diary.clipCount, 3);
  assert.equal(diary.eatCount, 2);
  assert.equal(diary.eatMinutes, 3);
});

test("buildFoodcast creates a compact playlist from effective clips", () => {
  const diary = buildDiaryFromRecords({
    deviceSn: "SN003",
    date: "2026-07-02",
    records: [
      {
        BeginTime: "2026-07-02 07:30:00",
        EndTime: "2026-07-02 07:31:30",
        FileName: "breakfast.mp4",
      },
      {
        BeginTime: "2026-07-02 21:00:00",
        EndTime: "2026-07-02 21:00:30",
        FileName: "night.mp4",
      },
    ],
  });

  const foodcast = buildFoodcast(diary);

  assert.match(foodcast.id, /^foodcast_/);
  assert.deepEqual(foodcast.clipIds, diary.clips.map((clip) => clip.id));
  assert.equal(foodcast.totalDurationSec, 120);
  assert.equal(foodcast.title, "7月2日吃播");
});

test("formatDateKey uses local yyyy-mm-dd strings", () => {
  assert.equal(formatDateKey(new Date(2026, 6, 2)), "2026-07-02");
});
