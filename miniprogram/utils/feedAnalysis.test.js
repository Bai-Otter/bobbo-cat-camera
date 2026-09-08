const test = require("node:test");
const assert = require("node:assert/strict");

const {
  attachReplayMarkers,
  buildReplayMarkerChips,
  buildReplayMarkerRanges,
  markerLabel,
  markerPercent,
} = require("./feedAnalysis.js");

test("attachReplayMarkers decorates recordings with related markers", () => {
  const records = [
    {
      FileName: "clip-a.mp4",
      BeginTime: "2026-07-04 12:00:00",
      EndTime: "2026-07-04 12:00:30",
    },
    {
      FileName: "clip-b.mp4",
      BeginTime: "2026-07-04 12:10:00",
      EndTime: "2026-07-04 12:10:10",
    },
  ];
  const markers = [
    {
      recordingKey: "2026-07-04 12:00:00__clip-a.mp4",
      markerType: "feeding_start",
      markerTsMs: new Date("2026-07-04 12:00:08").getTime(),
      playbackParams: {
        startTime: "2026-07-04 12:00:08",
        endTime: "2026-07-04 12:00:30",
        fileName: "clip-a.mp4",
      },
    },
  ];

  const decorated = attachReplayMarkers(records, markers);

  assert.equal(decorated[0].markers.length, 1);
  assert.equal(decorated[0].markers[0].markerLabel, "\u5f00\u59cb\u8fdb\u98df");
  assert.equal(decorated[1].markers.length, 0);
  assert.equal(markerLabel("cat_leave"), "\u732b\u54aa\u79bb\u5f00");
});

test("markerLabel supports face test markers and target-aware fallback text", () => {
  assert.equal(markerLabel("face_enter"), "\u4eba\u8138\u51fa\u73b0");
  assert.equal(markerLabel("face_leave"), "\u4eba\u8138\u79bb\u5f00");
  assert.equal(markerLabel("cat_enter"), "\u732b\u54aa\u51fa\u73b0");
  assert.equal(markerLabel({ markerType: "face_enter", target: "face" }), "\u4eba\u8138\u51fa\u73b0");
  assert.equal(markerLabel("cute_head_up"), "\u732b\u54aa\u62ac\u5934");
  assert.equal(markerLabel("cute_extreme_closeup"), "\u732b\u54aa\u5927\u7a81\u8138");
});

test("buildReplayMarkerRanges pairs target enter and leave markers by offset", () => {
  const markers = [
    { markerType: "face_enter", target: "face", offsetSec: 10 },
    { markerType: "face_leave", target: "face", offsetSec: 25 },
    { markerType: "face_enter", target: "face", offsetSec: 40 },
  ];

  const ranges = buildReplayMarkerRanges(markers, 100);

  assert.deepEqual(ranges, [
    { target: "face", startSec: 10, endSec: 25, leftPercent: 10, widthPercent: 15 },
    { target: "face", startSec: 40, endSec: 100, leftPercent: 40, widthPercent: 60 },
  ]);
  assert.equal(markerPercent({ offsetSec: 25 }, 100), 25);
  assert.equal(markerPercent({ offsetMs: 12000 }, 100), 12);
});

test("buildReplayMarkerRanges includes feeding start and end on the progress timeline", () => {
  const ranges = buildReplayMarkerRanges([
    { markerType: "cat_enter", target: "cat", offsetSec: 1 },
    { markerType: "feeding_start", target: "cat", offsetSec: 2 },
    { markerType: "feeding_end", target: "cat", offsetSec: 10 },
  ], 74);

  assert.deepEqual(ranges, [
    {
      target: "cat",
      startSec: 1,
      endSec: 74,
      leftPercent: 1.351,
      widthPercent: 98.649,
    },
    {
      target: "feeding",
      startSec: 2,
      endSec: 10,
      leftPercent: 2.703,
      widthPercent: 10.811,
    },
  ]);
});

test("attachReplayMarkers keeps raw markers but deduplicates list chips by type", () => {
  const markers = [
    { recordingKey: "2026-07-04 12:00:00__clip-a.mp4", markerType: "cat_enter", markerTsMs: 1 },
    { recordingKey: "2026-07-04 12:00:00__clip-a.mp4", markerType: "cat_leave", markerTsMs: 2 },
    { recordingKey: "2026-07-04 12:00:00__clip-a.mp4", markerType: "cat_enter", markerTsMs: 3 },
    { recordingKey: "2026-07-04 12:00:00__clip-a.mp4", markerType: "feeding_start", markerTsMs: 4 },
    { recordingKey: "2026-07-04 12:00:00__clip-a.mp4", markerType: "feeding_end", markerTsMs: 5 },
    { recordingKey: "2026-07-04 12:00:00__clip-a.mp4", markerType: "feeding_start", markerTsMs: 6 },
  ];

  const decorated = attachReplayMarkers([
    { FileName: "clip-a.mp4", BeginTime: "2026-07-04 12:00:00" },
  ], markers);

  assert.equal(decorated[0].markers.length, 6);
  assert.deepEqual(
    decorated[0].markerChips.map((marker) => marker.markerType),
    ["cat_enter", "cat_leave", "feeding_start", "feeding_end"]
  );
  assert.deepEqual(
    buildReplayMarkerChips(markers).map((marker) => marker.markerType),
    ["cat_enter", "cat_leave", "feeding_start", "feeding_end"]
  );
});

test("attachReplayMarkers decorates recordings with normalized analysis badges", () => {
  const records = ["queued", "running", "ready", "failed", "unknown", "missing"].map((status, index) => ({
    FileName: `${status}.h264`,
    BeginTime: `2026-07-28 0${index}:00:00`,
  }));
  const statuses = records.slice(0, 5).map((record, index) => ({
    recordingKey: `${record.BeginTime}__${record.FileName}`,
    status: ["queued", "running", "ready", "failed", "other"][index],
  }));

  const readyRecord = records[2];
  const decorated = attachReplayMarkers(records, [{
    recordingKey: `${readyRecord.BeginTime}__${readyRecord.FileName}`,
    markerType: "cat_enter",
  }], statuses);

  assert.deepEqual(
    decorated.map((record) => [record.analysisStatus, record.analysisLabel, record.analysisTone]),
    [
      ["queued", "\u5206\u6790\u4e2d", "running"],
      ["running", "\u5206\u6790\u4e2d", "running"],
      ["ready", "\u6709\u732b\u54aa", "ready"],
      ["failed", "\u5206\u6790\u5931\u8d25", "failed"],
      ["other", "", ""],
      ["", "", ""],
    ]
  );
});

test("attachReplayMarkers hides only analyzed recordings without cat markers", () => {
  const states = ["missing", "queued", "running", "failed", "cat", "feeding", "empty", "irrelevant"];
  const records = states.map((state, index) => ({
    FileName: `${state}.h264`,
    BeginTime: `2026-07-28 ${String(index).padStart(2, "0")}:00:00`,
  }));
  const statuses = records.slice(1).map((record, index) => ({
    recordingKey: `${record.BeginTime}__${record.FileName}`,
    status: index < 3 ? ["queued", "running", "failed"][index] : "ready",
  }));
  const markers = [
    {
      recordingKey: `${records[4].BeginTime}__${records[4].FileName}`,
      markerType: "cat_enter",
    },
    {
      recordingKey: `${records[5].BeginTime}__${records[5].FileName}`,
      markerType: "feeding_start",
    },
    {
      recordingKey: `${records[7].BeginTime}__${records[7].FileName}`,
      markerType: "face_enter",
    },
  ];

  const decorated = attachReplayMarkers(records, markers, statuses);

  assert.deepEqual(
    decorated.map((record) => record.FileName),
    ["missing.h264", "queued.h264", "running.h264", "failed.h264", "cat.h264", "feeding.h264"]
  );
  assert.deepEqual(
    decorated.slice(4).map((record) => [record.analysisStatus, record.analysisLabel, record.analysisTone]),
    [
      ["ready", "\u6709\u732b\u54aa", "ready"],
      ["ready", "\u6709\u732b\u54aa", "ready"],
    ]
  );
});
