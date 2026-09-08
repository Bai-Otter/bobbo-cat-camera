const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMealId,
  buildOutputMapping,
  extractFeedingIntervals,
  groupFeedingIntervals,
  mapSourceRangeToMeal,
  validateCustomComposition,
} = require("./materialModel");

function interval(id, startMs, endMs, extra = {}) {
  return {
    id,
    startMs,
    endMs,
    source: {
      clipId: `clip-${id}`,
      recordingKey: `recording-${id}`,
      playbackParams: { fileName: `${id}.mp4` },
    },
    ...extra,
  };
}

function material(id, extra = {}) {
  return {
    id,
    durationSec: 60,
    ownerOpenid: "owner-1",
    deviceSn: "SN-1",
    expiresAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
}

function composition(extra = {}) {
  return {
    ownerOpenid: "owner-1",
    deviceSn: "SN-1",
    frameMode: "source",
    bgmId: "bgm-01",
    bgmVolume: 0.8,
    nowMs: Date.parse("2026-07-26T00:00:00.000Z"),
    segments: [{ materialId: "m1", trimStartSec: 0, trimEndSec: 30 }],
    materials: new Map([["m1", material("m1")]]),
    ...extra,
  };
}

function assertCode(code, callback) {
  assert.throws(callback, (error) => error && error.code === code);
}

test("groups a 9:59 gap and splits an exact 10:00 gap", () => {
  const intervals = [
    interval("c", 1_320_000, 1_380_000),
    interval("a", 0, 60_000),
    interval("b", 659_000, 720_000),
  ];

  const meals = groupFeedingIntervals(intervals);

  assert.deepEqual(meals.map((meal) => meal.intervalIds), [["a", "b"], ["c"]]);
  assert.equal(meals[0].startMs, 0);
  assert.equal(meals[0].endMs, 720_000);
});

test("grouping is deterministic without mutating the supplied interval order", () => {
  const a = interval("same", 1_000, 4_000, { source: { fileName: "a.mp4" } });
  const b = interval("same", 1_000, 4_000, { source: { fileName: "b.mp4" } });
  const supplied = [b, a];

  const first = groupFeedingIntervals(supplied);
  const second = groupFeedingIntervals([a, b]);

  assert.deepEqual(first, second);
  assert.deepEqual(supplied, [b, a]);
  assert.match(first[0].version, /^[a-f0-9]{64}$/);
});

test("meal versions change when interval bounds or source details change", () => {
  const original = groupFeedingIntervals([interval("a", 1_000, 4_000)])[0].version;
  const changedBounds = groupFeedingIntervals([interval("a", 1_000, 4_001)])[0].version;
  const changedSource = groupFeedingIntervals([
    interval("a", 1_000, 4_000, {
      source: { clipId: "clip-a", recordingKey: "recording-a", playbackParams: { fileName: "other.mp4" } },
    }),
  ])[0].version;

  assert.notEqual(changedBounds, original);
  assert.notEqual(changedSource, original);
});

test("meal IDs are stable for the same device and start and differ for changed input", () => {
  const id = buildMealId("SN-1", 123_456);

  assert.equal(buildMealId("SN-1", 123_456), id);
  assert.notEqual(buildMealId("SN-2", 123_456), id);
  assert.notEqual(buildMealId("SN-1", 123_457), id);
  assert.match(id, /^meal-[a-f0-9]{24}$/);
});

test("a cross-midnight meal belongs to its start date", () => {
  const startMs = new Date(2026, 6, 26, 23, 59, 0).getTime();
  const intervals = [
    interval("before", startMs, startMs + 120_000),
    interval("after", startMs + 180_000, startMs + 240_000),
  ];

  const [meal] = groupFeedingIntervals(intervals);

  assert.equal(meal.date, "2026-07-26");
  assert.equal(meal.startMs, startMs);
  assert.equal(meal.endMs, startMs + 240_000);
});

test("extracts paired markers with recording and playback source details", () => {
  const clip = {
    id: "clip-1",
    recordingKey: "recording-1",
    beginTime: "2026-07-26 08:00:00",
    endTime: "2026-07-26 08:01:00",
    playbackParams: { fileName: "recording.mp4", token: "source-token" },
    markers: [
      { markerType: "feeding_end", beginTime: "2026-07-26 08:00:02" },
      { markerType: "feeding_end", beginTime: "2026-07-26 08:00:30", eventId: "end-1" },
      {
        markerType: "feeding_start",
        beginTime: "2026-07-26 08:00:05",
        eventId: "start-1",
        playbackParams: { fileName: "marker.mp4", startTime: "2026-07-26 08:00:05" },
      },
    ],
  };

  const intervals = extractFeedingIntervals(clip);

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].id, "start-1");
  assert.equal(intervals[0].startMs, Date.parse("2026-07-26T08:00:05+08:00"));
  assert.equal(intervals[0].endMs, Date.parse("2026-07-26T08:00:30+08:00"));
  assert.deepEqual({
    clipId: intervals[0].source.clipId,
    recordingKey: intervals[0].source.recordingKey,
    playbackParams: intervals[0].source.playbackParams,
  }, {
    clipId: "clip-1",
    recordingKey: "recording-1",
    playbackParams: {
      fileName: "marker.mp4",
      token: "source-token",
      startTime: "2026-07-26 08:00:05",
    },
  });
  assert.deepEqual(intervals[0].source.clip.cuteTimeline, []);
  assert.equal(intervals[0].source.clip.fileName, "marker.mp4");
});

test("uses the clip end for an unmatched feeding start and skips invalid intervals", () => {
  const clip = {
    id: "clip-1",
    beginTime: "2026-07-26 08:00:00",
    endTime: "2026-07-26 08:01:00",
    markers: [
      { markerType: "feeding_start", beginTime: "invalid" },
      { markerType: "feeding_start", beginTime: "2026-07-26 08:00:40" },
    ],
  };

  const intervals = extractFeedingIntervals(clip);

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].startMs, Date.parse("2026-07-26T08:00:40+08:00"));
  assert.equal(intervals[0].endMs, Date.parse("2026-07-26T08:01:00+08:00"));
});

test("builds cumulative output mapping in deterministic source order", () => {
  const mapping = buildOutputMapping([
    interval("b", 11_000, 21_000),
    interval("a", 1_000, 6_000),
  ]);

  assert.deepEqual(mapping, [
    { intervalId: "a", sourceStartMs: 1_000, sourceEndMs: 6_000, outputStartSec: 0, outputEndSec: 5 },
    { intervalId: "b", sourceStartMs: 11_000, sourceEndMs: 21_000, outputStartSec: 5, outputEndSec: 15 },
  ]);
});

test("maps a contained source highlight into concatenated meal time", () => {
  const mapping = [
    { sourceStartMs: 1_000, sourceEndMs: 6_000, outputStartSec: 0, outputEndSec: 5 },
    { sourceStartMs: 11_000, sourceEndMs: 21_000, outputStartSec: 5, outputEndSec: 15 },
  ];

  assert.deepEqual(mapSourceRangeToMeal(mapping, 13_000, 17_500), { startSec: 7, endSec: 11.5 });
});

test("returns null for a source range that does not overlap meal footage", () => {
  const mapping = [
    { sourceStartMs: 1_000, sourceEndMs: 6_000, outputStartSec: 0, outputEndSec: 5 },
  ];

  assert.equal(mapSourceRangeToMeal(mapping, 7_000, 8_000), null);
});

test("rejects malformed or only partially contained source ranges", () => {
  const mapping = [
    { sourceStartMs: 1_000, sourceEndMs: 6_000, outputStartSec: 0, outputEndSec: 5 },
    { sourceStartMs: 11_000, sourceEndMs: 21_000, outputStartSec: 5, outputEndSec: 15 },
  ];

  assertCode("SOURCE_RANGE_INVALID", () => mapSourceRangeToMeal(mapping, 4_000, 4_000));
  assertCode("SOURCE_RANGE_NOT_CONTAINED", () => mapSourceRangeToMeal(mapping, 5_000, 12_000));
});

test("validates and normalizes a custom composition using an object lookup", () => {
  const result = validateCustomComposition(composition({
    materials: { m1: material("m1") },
    frameMode: "center_crop",
    bgmVolume: 0.2,
  }));

  assert.equal(result.totalDurationSec, 30);
  assert.equal(result.frameMode, "center_crop");
  assert.equal(result.bgmVolume, 0.2);
  assert.deepEqual(result.segments, [{ materialId: "m1", trimStartSec: 0, trimEndSec: 30 }]);
});

test("rejects custom compositions outside the 1 to 10 segment limit", () => {
  assertCode("CUSTOM_SEGMENT_COUNT_INVALID", () => validateCustomComposition(composition({ segments: [] })));
  const materials = new Map();
  const segments = [];
  for (let index = 0; index < 11; index += 1) {
    const id = `m${index}`;
    materials.set(id, material(id));
    segments.push({ materialId: id, trimStartSec: 0, trimEndSec: 1 });
  }
  assertCode("CUSTOM_SEGMENT_COUNT_INVALID", () => validateCustomComposition(composition({ materials, segments })));
});

test("rejects duplicate selected material IDs", () => {
  assertCode("CUSTOM_MATERIAL_DUPLICATE", () => validateCustomComposition(composition({
    segments: [
      { materialId: "m1", trimStartSec: 0, trimEndSec: 10 },
      { materialId: "m1", trimStartSec: 10, trimEndSec: 20 },
    ],
  })));
});

test("rejects a selected material absent from the supplied lookup", () => {
  assertCode("CUSTOM_MATERIAL_NOT_FOUND", () => validateCustomComposition(composition({
    segments: [{ materialId: "missing", trimStartSec: 0, trimEndSec: 10 }],
  })));
});

test("rejects a material owned by another user", () => {
  assertCode("CUSTOM_MATERIAL_OWNER_MISMATCH", () => validateCustomComposition(composition({
    materials: new Map([["m1", material("m1", { ownerOpenid: "owner-2" })]]),
  })));
});

test("rejects a material belonging to another device", () => {
  assertCode("CUSTOM_MATERIAL_DEVICE_MISMATCH", () => validateCustomComposition(composition({
    materials: new Map([["m1", material("m1", { deviceSn: "SN-2" })]]),
  })));
});

test("rejects an expired material", () => {
  assertCode("CUSTOM_MATERIAL_EXPIRED", () => validateCustomComposition(composition({
    materials: new Map([["m1", material("m1", { expiresAt: "2026-07-26T00:00:00.000Z" })]]),
  })));
});

test("rejects zero, reversed, negative, and out-of-material trims", () => {
  const trims = [
    [-1, 10],
    [10, 10],
    [20, 10],
    [0, 61],
    [0, Number.NaN],
  ];
  for (const [trimStartSec, trimEndSec] of trims) {
    assertCode("CUSTOM_TRIM_INVALID", () => validateCustomComposition(composition({
      segments: [{ materialId: "m1", trimStartSec, trimEndSec }],
    })));
  }
});

test("rejects a custom composition longer than 60 seconds", () => {
  const materials = new Map([
    ["m1", material("m1", { durationSec: 200 })],
    ["m2", material("m2", { durationSec: 200 })],
  ]);

  assertCode("CUSTOM_DURATION_EXCEEDED", () => validateCustomComposition(composition({
    materials,
    bgmId: "",
    segments: [
      { materialId: "m1", trimStartSec: 0, trimEndSec: 31 },
      { materialId: "m2", trimStartSec: 0, trimEndSec: 30 },
    ],
  })));
});

test("rejects unsupported frame modes", () => {
  assertCode("CUSTOM_FRAME_MODE_INVALID", () => validateCustomComposition(composition({ frameMode: "stretch" })));
});

test("requires an explicit non-reserved BGM ID", () => {
  for (const bgmId of ["", "   ", "random", "none", "RANDOM", null]) {
    assertCode("CUSTOM_BGM_REQUIRED", () => validateCustomComposition(composition({ bgmId })));
  }
});

test("rejects BGM volume outside the inclusive 0.2 to 1.0 range", () => {
  for (const bgmVolume of [0.19, 1.01, Number.NaN, "loud"]) {
    assertCode("CUSTOM_BGM_VOLUME_INVALID", () => validateCustomComposition(composition({ bgmVolume })));
  }
  assert.equal(validateCustomComposition(composition({ bgmVolume: 1 })).bgmVolume, 1);
});
