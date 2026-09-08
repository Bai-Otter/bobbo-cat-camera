const test = require("node:test");
const assert = require("node:assert/strict");

const {
  recordingKey,
  summarizeVisionFrames,
  buildClipFromRecording,
  buildDiaryFromClips,
  buildReplayMarkersFromClips,
} = require("./model");

function buildFrame(second, overrides = {}) {
  return {
    second,
    hasCat: false,
    nearBowl: false,
    confidence: 0.5,
    bowlRoi: { x: 200, y: 200, width: 80, height: 80 },
    ...overrides,
  };
}

test("summarizeVisionFrames identifies cat and feeding markers", () => {
  const beginTime = "2026-07-04 12:00:00";
  const frames = [];
  for (let second = 0; second <= 24; second += 1) {
    frames.push(
      buildFrame(second, {
        hasCat: second >= 3 && second <= 19,
        nearBowl: second >= 5 && second <= 14,
        confidence: second >= 3 && second <= 19 ? 0.92 : 0.18,
      })
    );
  }

  const summary = summarizeVisionFrames({
    beginTime,
    endTime: "2026-07-04 12:00:24",
    frames,
  });

  assert.equal(summary.hasCat, true);
  assert.equal(summary.hasFeeding, true);
  assert.deepEqual(
    summary.markers.map((marker) => marker.markerType),
    ["cat_enter", "feeding_start", "feeding_end", "cat_leave"]
  );
  assert.equal(summary.markers[0].markerTsMs, new Date("2026-07-04 12:00:03").getTime());
  assert.equal(summary.markers[1].markerTsMs, new Date("2026-07-04 12:00:05").getTime());
  assert.equal(summary.markers[2].markerTsMs, new Date("2026-07-04 12:00:15").getTime());
  assert.equal(summary.markers[3].markerTsMs, new Date("2026-07-04 12:00:20").getTime());
  assert.deepEqual(summary.bowlRoi, { x: 200, y: 200, width: 80, height: 80 });
});

test("buildDiaryFromClips keeps only cat clips and feeding meals", () => {
  const catClip = buildClipFromRecording(
    {
      BeginTime: "2026-07-04 07:30:00",
      EndTime: "2026-07-04 07:30:24",
      FileName: "motion-cat.mp4",
      Event: "MotionDetect",
    },
    {
      hasCat: true,
      hasFeeding: true,
      analysisConfidence: 0.91,
      markers: [
        { markerType: "cat_enter", markerTsMs: new Date("2026-07-04 07:30:03").getTime() },
        { markerType: "feeding_start", markerTsMs: new Date("2026-07-04 07:30:08").getTime() },
        { markerType: "feeding_end", markerTsMs: new Date("2026-07-04 07:30:20").getTime() },
      ],
    },
    "SN001"
  );
  const emptyClip = buildClipFromRecording(
    {
      BeginTime: "2026-07-04 08:00:00",
      EndTime: "2026-07-04 08:00:10",
      FileName: "empty.mp4",
    },
    {
      hasCat: false,
      hasFeeding: false,
      analysisConfidence: 0.2,
      markers: [],
    },
    "SN001"
  );

  const diary = buildDiaryFromClips({
    deviceSn: "SN001",
    date: "2026-07-04",
    clips: [catClip, emptyClip],
  });

  assert.equal(diary.clipCount, 1);
  assert.equal(diary.eatCount, 1);
  assert.equal(diary.clips[0].fileName, "motion-cat.mp4");
  assert.equal(diary.clips[0].hasCat, true);
  assert.equal(diary.clips[0].hasFeeding, true);
  assert.equal(diary.meals[0].startTime, "2026-07-04 07:30:08");
  assert.equal(diary.meals[0].endTime, "2026-07-04 07:30:20");
  assert.equal(diary.meals[0].bowlPresenceSeconds, 12);
  assert.equal(diary.meals[0].actualEatingSeconds, 0);
  assert.equal(diary.meals[0].uncertainSeconds, 12);
  assert.equal(diary.eatMinutes, 0);
  assert.equal(diary.activity.state, "baseline_building");
  assert.equal(
    recordingKey({
      BeginTime: "2026-07-04 07:30:00",
      FileName: "motion-cat.mp4",
    }),
    "2026-07-04 07:30:00__motion-cat.mp4"
  );
  assert.deepEqual(emptyClip.cuteTimeline, []);
});

test("buildDiaryFromClips aggregates V3.2 stats idempotently and merges one returning meal", () => {
  const buildV32Clip = (beginTime, endTime, fileName, eventStart, eventEnd) => buildClipFromRecording(
    { BeginTime: beginTime, EndTime: endTime, FileName: fileName },
    {
      hasCat: true,
      feedingStats: {
        version: "feeding-stats-v3.2",
        source: { mediaId: fileName, durationSec: 30 },
        summary: {
          mealCount: 1,
          actualEatingSeconds: eventEnd - eventStart,
          bowlPresenceSeconds: eventEnd - eventStart,
          analyzedSeconds: 30,
          observedSeconds: 30,
          coverage: 1,
          confidence: 0.9,
        },
        events: [{ id: "event-1", startSec: eventStart, endSec: eventEnd, confidence: 0.9 }],
        meals: [{ id: "meal-1", startSec: eventStart, endSec: eventEnd, confidence: 0.9 }],
        timeline: [
          { state: "no_cat", startSec: 0, endSec: eventStart, observedSeconds: eventStart },
          {
            state: "eating",
            startSec: eventStart,
            endSec: eventEnd,
            observedSeconds: eventEnd - eventStart,
            confidence: 0.9,
          },
          { state: "no_cat", startSec: eventEnd, endSec: 30, observedSeconds: 30 - eventEnd },
        ],
      },
    },
    "CAM-V32"
  );
  const first = buildV32Clip("2026-08-24 07:00:00", "2026-08-24 07:00:30", "a.mp4", 5, 15);
  const second = buildV32Clip("2026-08-24 07:05:00", "2026-08-24 07:05:30", "b.mp4", 2, 12);
  const diary = buildDiaryFromClips({
    deviceSn: "CAM-V32",
    date: "2026-08-24",
    clips: [first, first, second],
  });

  assert.equal(diary.algorithmVersion, "feeding-stats-v3.2");
  assert.equal(diary.analysisState, "ready");
  assert.equal(diary.mealCount, 1);
  assert.equal(diary.eatCount, 1);
  assert.equal(diary.actualEatingSeconds, 20);
  assert.equal(diary.bowlPresenceSeconds, 20);
  assert.equal(diary.analyzedClipCount, 2);
  assert.equal(diary.meals[0].clipIds.length, 2);
});

test("buildDiaryFromClips groups returns before ten minutes and excludes away time", () => {
  const first = buildClipFromRecording({
    BeginTime: "2026-07-04 07:00:00",
    EndTime: "2026-07-04 07:01:00",
    FileName: "first.mp4",
  }, {
    hasCat: true,
    hasFeeding: true,
    markers: [
      { markerType: "feeding_start", markerTsMs: new Date("2026-07-04 07:00:10").getTime() },
      { markerType: "feeding_end", markerTsMs: new Date("2026-07-04 07:00:40").getTime() },
    ],
    feedingStateTimeline: [
      { state: "chewing", startSec: 10, endSec: 25, confidence: 0.9 },
      { state: "licking", startSec: 25, endSec: 35, confidence: 0.8 },
      { state: "not_eating", startSec: 35, endSec: 40, confidence: 0.7 },
    ],
  }, "SN001");
  const returned = buildClipFromRecording({
    BeginTime: "2026-07-04 07:10:39",
    EndTime: "2026-07-04 07:11:00",
    FileName: "returned.mp4",
  }, {
    hasCat: true,
    hasFeeding: true,
    markers: [
      { markerType: "feeding_start", markerTsMs: new Date("2026-07-04 07:10:39").getTime() },
      { markerType: "feeding_end", markerTsMs: new Date("2026-07-04 07:10:49").getTime() },
    ],
    feedingStateTimeline: [
      { state: "chewing", startSec: 0, endSec: 10, confidence: 0.91 },
    ],
  }, "SN001");

  const diary = buildDiaryFromClips({ deviceSn: "SN001", date: "2026-07-04", clips: [returned, first] });

  assert.equal(diary.eatCount, 1);
  assert.equal(diary.meals[0].spanSeconds, 639);
  assert.equal(diary.meals[0].bowlPresenceSeconds, 40);
  assert.equal(diary.meals[0].chewingSeconds, 25);
  assert.equal(diary.meals[0].lickingSeconds, 10);
  assert.equal(diary.meals[0].notEatingSeconds, 5);
  assert.equal(diary.meals[0].actualEatingSeconds, 35);
  assert.equal(diary.meals[0].uncertainSeconds, 0);
  assert.equal(diary.actualEatingSeconds, 35);
  assert.equal(diary.eatMinutes, 35 / 60);
  assert.deepEqual(diary.meals[0].clipIds, [first.id, returned.id]);
});

test("buildDiaryFromClips splits an exact ten minute return gap", () => {
  function feedingClip(beginTime, endTime, fileName) {
    return buildClipFromRecording({ BeginTime: beginTime, EndTime: endTime, FileName: fileName }, {
      hasCat: true,
      hasFeeding: true,
      markers: [
        { markerType: "feeding_start", markerTsMs: new Date(beginTime).getTime() },
        { markerType: "feeding_end", markerTsMs: new Date(endTime).getTime() },
      ],
    }, "SN001");
  }
  const first = feedingClip("2026-07-04 08:00:00", "2026-07-04 08:00:30", "first.mp4");
  const second = feedingClip("2026-07-04 08:10:30", "2026-07-04 08:11:00", "second.mp4");

  const diary = buildDiaryFromClips({ deviceSn: "SN001", date: "2026-07-04", clips: [second, first] });

  assert.equal(diary.eatCount, 2);
  assert.deepEqual(diary.meals.map((meal) => meal.startTime), [
    "2026-07-04 08:00:00",
    "2026-07-04 08:10:30",
  ]);
});

test("buildDiaryFromClips builds activity on the seventh valid day", () => {
  const clip = buildClipFromRecording({
    BeginTime: "2026-07-20 12:00:00",
    EndTime: "2026-07-20 12:01:00",
    FileName: "activity.mp4",
  }, {
    hasCat: true,
    hasFeeding: true,
    markers: [
      { markerType: "feeding_start", markerTsMs: new Date("2026-07-20 12:00:00").getTime() },
      { markerType: "feeding_end", markerTsMs: new Date("2026-07-20 12:01:00").getTime() },
    ],
    feedingStateTimeline: [{ state: "chewing", startSec: 0, endSec: 60 }],
    feedingActivity: {
      sampleSeconds: 50,
      chewsPerMinute: 180,
      regularity: 0.8,
      stroke: 0.02,
      algorithmVersion: "chewmeter-prototype",
    },
  }, "SN001");
  const history = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-07-${String(index + 10).padStart(2, "0")}`,
    chewsPerMinute: 200,
    regularity: 0.7,
  }));

  const building = buildDiaryFromClips({ deviceSn: "SN001", date: "2026-07-20", clips: [clip], activityHistory: history.slice(0, 5) });
  const ready = buildDiaryFromClips({ deviceSn: "SN001", date: "2026-07-20", clips: [clip], activityHistory: history.slice(0, 6) });

  assert.equal(building.activity.state, "baseline_building");
  assert.equal(building.activity.score, null);
  assert.equal(ready.activity.state, "stable");
  assert.equal(ready.activity.score, 76);
  assert.deepEqual(ready.activity.weights, { rate: 0.75, regularity: 0.25, stroke: 0 });
});

test("buildClipFromRecording preserves compact cute analysis fields", () => {
  const clip = buildClipFromRecording(
    {
      BeginTime: "2026-07-04 10:00:00",
      EndTime: "2026-07-04 10:00:30",
      FileName: "cute-cat.mp4",
    },
    {
      hasCat: true,
      markers: [
        null,
        {
          eventId: { sourceUrl: "https://secret.example.test/event" },
          markerType: "cute_head_up",
          target: "cat",
          beginTime: { sourceUrl: "https://secret.example.test/begin" },
          endTime: ["2026-07-04 10:00:03"],
          markerLabel: { rawFrame: "must-not-leak" },
          modelConfidence: 1.1,
          cuteScore: -0.1,
          cuteReasons: ["head_up", "head_up", 7],
          sourceUrl: "https://secret.example.test/replay.m3u8",
          rawFrame: "must-not-leak",
        },
      ],
      cuteTimeline: [
        {
          offsetSec: 3.5,
          cuteScore: 1.1,
          modelConfidence: 0.91,
          cuteReasons: ["head_up", "head_up", false],
          hasCat: "false",
          frame: "raw-frame-data",
          sourceUrl: "https://secret.example.test/frame.jpg",
        },
      ],
    },
    "SN001"
  );

  assert.deepEqual(clip.cuteTimeline, [
    {
      offsetSec: 3.5,
      cuteScore: 1,
      modelConfidence: 0.91,
      cuteReasons: ["head_up"],
      hasCat: false,
    },
  ]);
  assert.equal(clip.markers[0].modelConfidence, 1);
  assert.equal(clip.markers[0].cuteScore, 0);
  assert.deepEqual(clip.markers[0].cuteReasons, ["head_up"]);
  assert.equal(clip.markers.length, 1);
  assert.equal(clip.markers[0].eventId, undefined);
  assert.equal(clip.markers[0].beginTime, "");
  assert.equal(clip.markers[0].endTime, "");
  assert.equal(clip.markers[0].markerLabel, undefined);
  assert.equal(clip.markers[0].sourceUrl, undefined);
  assert.equal(clip.markers[0].rawFrame, undefined);
  assert.doesNotMatch(JSON.stringify(clip.markers), /secret\.example|sourceUrl|rawFrame/);
});

test("buildDiaryFromClips derives a stable meal id for legacy markers without eventId", () => {
  const clip = buildClipFromRecording(
    {
      BeginTime: "2026-07-04 09:00:00",
      EndTime: "2026-07-04 09:01:00",
      FileName: "legacy-cat.h264",
    },
    {
      hasCat: true,
      hasFeeding: true,
      markers: [
        { markerType: "feeding_start", markerTsMs: new Date("2026-07-04 09:00:10").getTime() },
        { markerType: "feeding_end", markerTsMs: new Date("2026-07-04 09:00:30").getTime() },
      ],
    },
    "SN001"
  );

  const diary = buildDiaryFromClips({
    deviceSn: "SN001",
    date: "2026-07-04",
    clips: [clip],
  });

  assert.equal(diary.meals.length, 1);
  assert.equal(
    diary.meals[0].id,
    "meal_clip_SN001_2026_07_04_09_00_00_legacy_cat_h264_2026-07-04_09_00_10"
  );
});

test("buildClipFromRecording uses V3.2 meals as the canonical feeding notification markers", () => {
  const record = {
    BeginTime: "2026-08-28 08:00:00",
    EndTime: "2026-08-28 08:01:00",
    FileName: "feeding.h264",
  };
  const clip = buildClipFromRecording(record, {
    hasCat: true,
    hasFeeding: false,
    markers: [
      { markerType: "cat_enter", markerTsMs: new Date("2026-08-28 08:00:02").getTime() },
      { markerType: "feeding_start", markerTsMs: new Date("2026-08-28 08:00:04").getTime() },
      { markerType: "feeding_end", markerTsMs: new Date("2026-08-28 08:00:08").getTime() },
    ],
    feedingStats: {
      version: "feeding-stats-v3.2",
      source: {
        mediaId: "2026-08-28 08:00:00__feeding.h264",
        durationSec: 60,
        orientation: "clockwise-90",
        range: { startTime: record.BeginTime, endTime: record.EndTime },
      },
      summary: {
        mealCount: 1,
        actualEatingSeconds: 12,
        bowlPresenceSeconds: 16,
        analyzedSeconds: 60,
        observedSeconds: 60,
        coverage: 1,
        confidence: 0.9,
      },
      meals: [{
        id: "meal-1",
        startSec: 10,
        endSec: 26,
        spanSeconds: 16,
        actualEatingSeconds: 12,
        bowlPresenceSeconds: 16,
        confidence: 0.9,
        eventCount: 1,
        eventIds: ["feeding-event-1"],
      }],
      events: [],
      timeline: [],
    },
  }, "SN001");

  assert.deepEqual(
    clip.markers.map((item) => [item.markerType, item.beginTime]),
    [
      ["cat_enter", ""],
      ["feeding_start", "2026-08-28 08:00:10"],
      ["feeding_end", "2026-08-28 08:00:26"],
    ]
  );
  assert.equal(
    clip.markers[1].eventId,
    "2026-08-28 08:00:00__feeding.h264__feeding_start__1787875210000"
  );
  assert.equal(
    clip.markers[2].eventId,
    "2026-08-28 08:00:00__feeding.h264__feeding_end__1787875226000"
  );
});

test("buildReplayMarkersFromClips filters malformed legacy markers", () => {
  const marker = { markerType: "cat_enter", offsetSec: 5 };

  assert.deepEqual(
    buildReplayMarkersFromClips([
      { markers: [null, marker, "invalid"] },
      null,
    ]),
    [marker]
  );
});

test("buildReplayMarkersFromClips expands a legacy hasCat clip into a full presence interval", () => {
  const markers = buildReplayMarkersFromClips([{
    id: "clip-cat",
    recordingKey: "2026-09-01 12:30:00__cat.h264",
    beginTime: "2026-09-01 12:30:00",
    endTime: "2026-09-01 12:35:00",
    hasCat: true,
    analysisConfidence: 0.82,
    markers: [{ markerType: "cat_enter", markerTsMs: new Date("2026-09-01T12:31:00").getTime() }],
  }]);

  assert.equal(markers.length, 2);
  assert.deepEqual(markers[1], {
    eventId: "2026-09-01 12:30:00__cat.h264__cat_presence",
    recordingKey: "2026-09-01 12:30:00__cat.h264",
    markerType: "cat_enter",
    target: "cat",
    markerTsMs: new Date("2026-09-01T12:30:00").getTime(),
    offsetSec: 0,
    offsetMs: 0,
    beginTime: "2026-09-01 12:30:00",
    endTime: "2026-09-01 12:35:00",
    confidence: 0.82,
    markerLabel: "有猫出现",
  });
});

test("buildReplayMarkersFromClips uses v3.2 cat states instead of coloring the whole coarse clip", () => {
  const markers = buildReplayMarkersFromClips([{
    id: "clip-v32-cat",
    recordingKey: "2026-09-01 12:30:00__cat.h264",
    beginTime: "2026-09-01 12:30:00",
    endTime: "2026-09-01 12:35:00",
    hasCat: true,
    markers: [
      { markerType: "cat_enter", beginTime: "2026-09-01 12:30:00", endTime: "2026-09-01 12:35:00" },
      { markerType: "feeding_start", beginTime: "2026-09-01 12:31:40" },
    ],
    feedingStats: {
      version: "feeding-stats-v3.2",
      source: {
        durationSec: 300,
        orientation: "clockwise-90",
        range: { startTime: "2026-09-01 12:30:00", endTime: "2026-09-01 12:35:00" },
      },
      summary: {},
      meals: [],
      events: [],
      timeline: [
        { state: "no_cat", startSec: 0, endSec: 60 },
        { state: "cat_away_from_bowl", startSec: 60, endSec: 90, confidence: 0.8 },
        { state: "no_cat", startSec: 90, endSec: 100 },
        { state: "eating", startSec: 100, endSec: 130, confidence: 0.9 },
        { state: "near_bowl_not_eating", startSec: 131, endSec: 140, confidence: 0.7 },
        { state: "no_cat", startSec: 140, endSec: 300 },
      ],
    },
  }]);

  const catRanges = markers.filter((marker) => marker.markerType === "cat_enter");
  assert.deepEqual(catRanges.map((marker) => [marker.beginTime, marker.endTime]), [
    ["2026-09-01 12:31:00", "2026-09-01 12:31:30"],
    ["2026-09-01 12:31:40", "2026-09-01 12:32:20"],
  ]);
  assert.equal(markers.some((marker) => marker.markerType === "feeding_start"), true);
});
