const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { FeedAnalysisStore } = require("./store");

test("FeedAnalysisStore persists V3.2 feeding stats and rebuilds the same daily result", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-v32-store-"));
  const filePath = path.join(dir, "state.sqlite");
  const store = new FeedAnalysisStore(filePath);
  const clip = {
    id: "clip-v32",
    recordingKey: "2026-08-24 12:00:00__v32.h264",
    beginTime: "2026-08-24 12:00:00",
    endTime: "2026-08-24 12:00:30",
    durationSec: 30,
    fileName: "v32.h264",
    hasCat: true,
    hasFeeding: true,
    analysisUpdatedAt: 123456,
    feedingStats: {
      version: "feeding-stats-v3.2",
      source: { mediaId: "v32", durationSec: 30 },
      summary: {
        mealCount: 1,
        actualEatingSeconds: 10,
        bowlPresenceSeconds: 10,
        analyzedSeconds: 30,
        observedSeconds: 30,
        coverage: 1,
        confidence: 0.88,
      },
      events: [{ id: "event-1", startSec: 5, endSec: 15, confidence: 0.88 }],
      meals: [{ id: "meal-1", startSec: 5, endSec: 15, confidence: 0.88 }],
      timeline: [
        { state: "no_cat", startSec: 0, endSec: 5, observedSeconds: 5 },
        { state: "eating", startSec: 5, endSec: 15, observedSeconds: 10, confidence: 0.88 },
        { state: "no_cat", startSec: 15, endSec: 30, observedSeconds: 15 },
      ],
    },
  };
  store.upsertRecording({
    deviceSn: "CAM-V32",
    recordingKey: clip.recordingKey,
    date: "2026-08-24",
    clip,
  });
  const reopened = new FeedAnalysisStore(filePath);
  const diary = reopened.getDiary("2026-08-24", "CAM-V32");
  assert.equal(diary.algorithmVersion, "feeding-stats-v3.2");
  assert.equal(diary.mealCount, 1);
  assert.equal(diary.actualEatingSeconds, 10);
  assert.equal(diary.updatedAt, 123456);
});

test("FeedAnalysisStore persists structured alarm facts without media fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-structured-store-"));
  const filePath = path.join(dir, "state.sqlite");
  const store = new FeedAnalysisStore(filePath);
  const recordingKey = "feeding-window:2026-08-28 12:00:00__2026-08-28 12:30:00";
  store.upsertRecording({
    deviceSn: "CAM-FACTS",
    recordingKey,
    date: "2026-08-28",
    clip: {
      dataKind: "feeding_fact",
      id: recordingKey,
      recordingKey,
      beginTime: "2026-08-28 12:00:00",
      endTime: "2026-08-28 12:30:00",
      durationSec: 1800,
      catId: "cat-1",
      isEffective: true,
      hasCat: true,
      hasFeeding: true,
      markers: [],
      feedingStats: {
        version: "feeding-stats-v3.2",
        source: {
          durationSec: 1800,
          orientation: "clockwise-90",
          range: {
            startTime: "2026-08-28 12:00:00",
            endTime: "2026-08-28 12:30:00",
          },
        },
        summary: {
          mealCount: 1,
          actualEatingSeconds: 120,
          bowlPresenceSeconds: 150,
        },
        meals: [],
        events: [],
        timeline: [],
      },
    },
  });

  const row = store.db.prepare(`
    SELECT recording_json, clip_json FROM recording_analysis
    WHERE device_sn = ? AND recording_key = ?
  `).get("CAM-FACTS", recordingKey);
  const persistedClip = JSON.parse(row.clip_json);
  assert.deepEqual(JSON.parse(row.recording_json), {});
  assert.equal(persistedClip.catId, "cat-1");
  assert.equal(persistedClip.fileName, undefined);
  assert.equal(persistedClip.cover, undefined);
  assert.equal(persistedClip.playbackParams, undefined);
  assert.equal(persistedClip.cuteTimeline, undefined);
});

test("FeedAnalysisStore persists alarm watermarks per device", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-watermark-store-"));
  const filePath = path.join(dir, "state.sqlite");
  const store = new FeedAnalysisStore(filePath);
  store.updateSettings({
    feedingAnalyzedThroughMs: 1000,
    feedingPendingFromMs: 900,
    feedingPendingThroughMs: 1200,
  }, "CAM-WATERMARK");

  const reopened = new FeedAnalysisStore(filePath);
  assert.equal(reopened.getSettings("CAM-WATERMARK").feedingAnalyzedThroughMs, 1000);
  assert.equal(reopened.getSettings("CAM-WATERMARK").feedingPendingFromMs, 900);
  assert.equal(reopened.getSettings("CAM-WATERMARK").feedingPendingThroughMs, 1200);
});

test("FeedAnalysisStore persists fast feeding-start candidate state by device", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-start-state-"));
  const filePath = path.join(dir, "state.sqlite");
  const store = new FeedAnalysisStore(filePath);

  store.updateSettings({
    deviceSn: "CAM-START",
    feedingStartState: "active",
    feedingStartCandidateFromMs: 1000,
    feedingStartCandidateThroughMs: 45000,
    feedingStartLastAnalyzedThroughMs: 42000,
    feedingStartLastAlarmAtMs: 44000,
    feedingStartConfirmedAtMs: 43000,
    feedingStartEventAtMs: 36000,
  }, "CAM-START");

  const reloaded = new FeedAnalysisStore(filePath).getSettings("CAM-START");
  assert.equal(reloaded.feedingStartState, "active");
  assert.equal(reloaded.feedingStartCandidateFromMs, 1000);
  assert.equal(reloaded.feedingStartCandidateThroughMs, 45000);
  assert.equal(reloaded.feedingStartLastAnalyzedThroughMs, 42000);
  assert.equal(reloaded.feedingStartLastAlarmAtMs, 44000);
  assert.equal(reloaded.feedingStartConfirmedAtMs, 43000);
  assert.equal(reloaded.feedingStartEventAtMs, 36000);
  assert.equal(
    new FeedAnalysisStore(path.join(dir, "empty.sqlite")).getSettings("CAM-EMPTY").feedingStartState,
    "idle"
  );
});

test("FeedAnalysisStore keeps settings isolated by device", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-device-settings-"));
  const filePath = path.join(dir, "state.sqlite");
  const store = new FeedAnalysisStore(filePath);

  store.updateSettings({ deviceSn: "CAM-A", openid: "owner-a", analysisEnabled: true }, "CAM-A");
  store.updateSettings({ deviceSn: "CAM-B", openid: "owner-b", analysisEnabled: false }, "CAM-B");

  assert.equal(store.getSettings("CAM-A").openid, "owner-a");
  assert.equal(store.getSettings("CAM-A").analysisEnabled, true);
  assert.equal(store.getSettings("CAM-B").openid, "owner-b");
  assert.equal(store.getSettings("CAM-B").analysisEnabled, false);
  assert.equal(new FeedAnalysisStore(filePath).getSettings("CAM-A").openid, "owner-a");
});

test("FeedAnalysisStore persists settings, markers, and diary without queuing historical notifications", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-store-"));
  const filePath = path.join(dir, "state.json");
  const store = new FeedAnalysisStore(filePath);

  store.updateSettings({
    openid: "openid_1",
    deviceSn: "SN001",
    analysisEnabled: true,
    notifyEnabled: true,
    templateId: "tmpl_1",
    bowlRoi: { x: 20, y: 30, width: 60, height: 60 },
    bowlConfidence: 0.88,
    officialConfigStatus: "ready",
  });

  store.upsertRecording({
    recordingKey: "2026-07-04 07:30:00__motion-cat.mp4",
    date: "2026-07-04",
    clip: {
      id: "clip_1",
      internalField: "must-not-persist",
      fileName: "motion-cat.mp4",
      beginTime: "2026-07-04 07:30:00",
      endTime: "2026-07-04 07:30:24",
      durationSec: 24,
      hasCat: true,
      hasFeeding: true,
      markers: [
        null,
        {
          eventId: "event_1",
          markerType: "feeding_start",
          markerTsMs: new Date("2026-07-04 07:30:08").getTime(),
          beginTime: "2026-07-04 07:30:08",
          endTime: "2026-07-04 07:30:24",
          sourceUrl: "https://secret.example.test/source.m3u8",
          internalMarkerField: "must-not-persist",
        },
      ],
      cuteTimeline: [
        {
          offsetSec: 2.5,
          cuteScore: 1.4,
          modelConfidence: 0.87,
          cuteReasons: ["head_up", "head_up"],
          hasCat: { value: true },
          sourceUrl: "https://secret.example.test/frame.jpg",
          rawFrame: "must-not-persist",
        },
      ],
      playbackParams: {
        startTime: "2026-07-04 07:30:00",
        endTime: "2026-07-04 07:30:24",
        fileName: "motion-cat.mp4",
      },
    },
  });

  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const persistedClip = persisted.recordings["2026-07-04 07:30:00__motion-cat.mp4"].clip;
  assert.deepEqual(persistedClip.cuteTimeline, [
    {
      offsetSec: 2.5,
      cuteScore: 1,
      modelConfidence: 0.87,
      cuteReasons: ["head_up"],
      hasCat: false,
    },
  ]);
  assert.equal(persistedClip.internalField, undefined);
  assertNoSensitiveFields(persistedClip);

  const reloaded = new FeedAnalysisStore(filePath);

  assert.equal(reloaded.getSettings().analysisEnabled, true);
  assert.equal(reloaded.getDiary("2026-07-04").clipCount, 1);
  const replayMarkers = reloaded.getReplayMarkers("2026-07-04");
  assert.equal(replayMarkers.length, 2);
  assert.equal(replayMarkers.some((marker) => marker.markerLabel === "有猫出现" && marker.endTime === "2026-07-04 07:30:24"), true);
  assert.equal(reloaded.listPendingNotifications().length, 0);
});

test("FeedAnalysisStore builds a same-device activity baseline from prior valid days", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-activity-history-"));
  const file = path.join(dir, "activity-history.sqlite");
  const store = new FeedAnalysisStore(file);
  const activityClip = (date, rate) => ({
    id: `clip-${date}`,
    recordingKey: `${date}__meal.mp4`,
    beginTime: `${date} 08:00:00`,
    endTime: `${date} 08:01:00`,
    durationSec: 60,
    fileName: "meal.mp4",
    title: "猫咪进食片段",
    time: "08:00",
    cover: "",
    isEffective: true,
    hasCat: true,
    hasFeeding: true,
    analysisConfidence: 0.9,
    bowlRoi: null,
    markers: [
      { markerType: "feeding_start", markerTsMs: new Date(`${date} 08:00:00`).getTime(), beginTime: `${date} 08:00:00` },
      { markerType: "feeding_end", markerTsMs: new Date(`${date} 08:01:00`).getTime(), beginTime: `${date} 08:01:00` },
    ],
    feedingStateTimeline: [{ state: "chewing", startSec: 0, endSec: 60, confidence: 0.9 }],
    feedingActivity: { sampleSeconds: 50, chewsPerMinute: rate, regularity: 0.8 },
    cuteTimeline: [],
    playbackParams: { startTime: `${date} 08:00:00`, endTime: `${date} 08:01:00`, fileName: "meal.mp4" },
  });
  for (let day = 1; day <= 7; day += 1) {
    const date = `2026-07-${String(day).padStart(2, "0")}`;
    store.upsertRecording({
      deviceSn: "SN-ACTIVITY",
      date,
      recordingKey: `${date}__meal.mp4`,
      clip: activityClip(date, day === 7 ? 180 : 200),
    });
  }

  const diary = store.getDiary("2026-07-07", "SN-ACTIVITY");

  assert.equal(diary.activity.validDayCount, 7);
  assert.equal(diary.activity.state, "stable");
  assert.equal(diary.activity.score, 76);
  assert.equal(store.getActivityHistory("SN-ACTIVITY", "2026-07-07").length, 6);
  assert.equal(store.getActivityHistory("OTHER", "2026-07-07").length, 0);
});

test("FeedAnalysisStore keeps feeding ROIs isolated by device", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-roi-"));
  const filePath = path.join(dir, "state.sqlite");
  const store = new FeedAnalysisStore(filePath);

  store.setBowlRoi("SN-OLD", { x: 100, y: 200, width: 300, height: 180 });
  store.setBowlRoi("SN-NEW", { x: 20, y: 40, width: 120, height: 90 });

  const reloaded = new FeedAnalysisStore(filePath);
  assert.deepEqual(reloaded.getBowlRoi("SN-OLD"), { x: 100, y: 200, width: 300, height: 180 });
  assert.deepEqual(reloaded.getBowlRoi("SN-NEW"), { x: 20, y: 40, width: 120, height: 90 });

  reloaded.setBowlRoi("SN-NEW", null);
  assert.equal(reloaded.getBowlRoi("SN-NEW"), null);
  assert.deepEqual(reloaded.getBowlRoi("SN-OLD"), { x: 100, y: 200, width: 300, height: 180 });
});

test("FeedAnalysisStore sanitizes legacy JSON replay markers on read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-legacy-markers-"));
  const filePath = path.join(dir, "state.json");
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      "markers:2026-07-12": [
        null,
        {
          markerType: "cute_head_up",
          offsetSec: 2.5,
          modelConfidence: 1.2,
          cuteScore: -0.2,
          cuteReasons: ["head_up", "head_up", 7],
          sourceUrl: "https://secret.example.test/replay.m3u8",
          internalField: "must-not-leak",
        },
      ],
    })
  );

  const store = new FeedAnalysisStore(filePath);
  const markers = store.getReplayMarkers("2026-07-12");

  assert.deepEqual(markers, [
    {
      eventId: undefined,
      recordingKey: "",
      markerType: "cute_head_up",
      target: "",
      markerTsMs: 0,
      offsetSec: 2.5,
      offsetMs: 0,
      beginTime: "",
      endTime: "",
      confidence: 0,
      modelConfidence: 1,
      cuteScore: 0,
      cuteReasons: ["head_up"],
      markerLabel: undefined,
      playbackParams: undefined,
    },
  ]);
});

test("FeedAnalysisStore rebuilds legacy JSON replay markers from the precise V3.2 timeline", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-json-marker-rebuild-"));
  const filePath = path.join(dir, "state.json");
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      "diary:2026-07-13": {
        date: "2026-07-13",
        clips: [
          {
            id: "clip-v32",
            recordingKey: "2026-07-13 10:00:00__clip-v32.mp4",
            beginTime: "2026-07-13 10:00:00",
            endTime: "2026-07-13 10:10:00",
            durationSec: 600,
            hasCat: true,
            hasFeeding: true,
            markers: [],
            feedingStats: {
              version: "feeding-stats-v3.2",
              source: {
                durationSec: 600,
                orientation: "clockwise-90",
                range: {
                  startTime: "2026-07-13 10:00:00",
                  endTime: "2026-07-13 10:10:00",
                },
              },
              summary: {
                mealCount: 1,
                actualEatingSeconds: 40,
                bowlPresenceSeconds: 100,
                analyzedSeconds: 600,
                observedSeconds: 600,
                coverage: 1,
                confidence: 0.9,
              },
              meals: [],
              events: [],
              timeline: [
                { state: "no_cat", startSec: 0, endSec: 120, confidence: 0.9 },
                { state: "cat_away_from_bowl", startSec: 120, endSec: 180, confidence: 0.8 },
                { state: "eating", startSec: 180, endSec: 220, confidence: 0.92 },
                { state: "no_cat", startSec: 220, endSec: 600, confidence: 0.9 },
              ],
            },
            playbackParams: {
              startTime: "2026-07-13 10:00:00",
              endTime: "2026-07-13 10:10:00",
              fileName: "clip-v32.mp4",
            },
          },
        ],
      },
      "markers:2026-07-13": [
        {
          markerType: "cat_presence",
          beginTime: "2026-07-13 10:00:00",
          endTime: "2026-07-13 10:10:00",
          markerLabel: "有猫出现",
        },
      ],
    })
  );

  const store = new FeedAnalysisStore(filePath);
  const markers = store.getReplayMarkers("2026-07-13");
  const catMarkers = markers.filter((marker) => marker.markerType === "cat_enter");

  assert.equal(catMarkers.length, 1);
  assert.equal(catMarkers[0].beginTime, "2026-07-13 10:02:00");
  assert.equal(catMarkers[0].endTime, "2026-07-13 10:03:40");
});

test("FeedAnalysisStore sanitizes historical SQLite clip JSON on read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-historical-sqlite-"));
  const filePath = path.join(dir, "state.sqlite");
  const store = new FeedAnalysisStore(filePath);
  const recordingKey = "2026-07-11 09:00:00__legacy.h264";

  store.markRecordingQueued({
    deviceSn: "SN-HISTORY",
    date: "2026-07-11",
    recordingKey,
    recording: {},
  });
  store.db.prepare(`
    UPDATE recording_analysis
    SET status = 'ready', clip_json = ?
    WHERE device_sn = ? AND recording_key = ?
  `).run(JSON.stringify(buildHistoricalDirtyClip()), "SN-HISTORY", recordingKey);

  let diary;
  assert.doesNotThrow(() => {
    diary = store.getDiary("2026-07-11", "SN-HISTORY");
  });
  const clips = store.getClipsForDate("SN-HISTORY", "2026-07-11");

  assert.equal(diary.clips[0].markers.length, 1);
  assertSanitizedHistoricalClip(clips[0]);
});

test("FeedAnalysisStore sanitizes historical JSON diary clips on read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-historical-json-"));
  const filePath = path.join(dir, "state.json");
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      "diary:2026-07-11": {
        deviceSn: "SN-HISTORY",
        date: "2026-07-11",
        clipCount: 2,
        clips: [null, buildHistoricalDirtyClip()],
        meals: [],
      },
    })
  );

  const store = new FeedAnalysisStore(filePath);
  let diary;
  assert.doesNotThrow(() => {
    diary = store.getDiary("2026-07-11", "SN-HISTORY");
  });

  assert.equal(diary.clips.length, 1);
  assertSanitizedHistoricalClip(diary.clips[0]);
});

test("FeedAnalysisStore sanitizes legacy JSON recordings before rebuilding derived state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-legacy-rebuild-"));
  const filePath = path.join(dir, "state.json");
  const legacyKey = "2026-07-11 09:00:00__legacy.h264";
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      settings: { deviceSn: "SN-HISTORY" },
      recordings: {
        [legacyKey]: {
          recordingKey: legacyKey,
          date: "2026-07-11",
          clip: buildHistoricalDirtyClip(),
        },
      },
    })
  );

  const store = new FeedAnalysisStore(filePath);
  assert.doesNotThrow(() => {
    store.upsertRecording({
      recordingKey: "2026-07-11 10:00:00__new.h264",
      date: "2026-07-11",
      clip: {
        id: "clip-new",
        beginTime: "2026-07-11 10:00:00",
        endTime: "2026-07-11 10:00:30",
        fileName: "new.h264",
        hasCat: true,
        markers: [],
      },
    });
  });

  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const derivedDiary = persisted["diary:2026-07-11"];
  const derivedMarkers = persisted["markers:2026-07-11"];
  const legacyClip = derivedDiary.clips.find((clip) => clip.id === "clip-history");

  assert.equal(derivedDiary.clips.length, 2);
  assertSanitizedHistoricalClip(legacyClip);
  assert.equal(derivedMarkers.length, 3);
  assert.equal(derivedMarkers.filter((marker) => marker.markerLabel === "有猫出现").length, 2);
  assert.doesNotMatch(
    JSON.stringify({ derivedDiary, derivedMarkers }),
    /secret\.example|sourceUrl|rawFrame|detectorDebug|internalField/
  );
});

test("FeedAnalysisStore sqlite mode persists recording analysis status and sanitized markers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-sqlite-"));
  const filePath = path.join(dir, "state.sqlite");
  const store = new FeedAnalysisStore(filePath);

  store.markRecordingQueued({
    deviceSn: "SN-SQL",
    date: "2026-07-14",
    recordingKey: "2026-07-14 09:00:00__clip-a.h264",
    recording: {
      BeginTime: "2026-07-14 09:00:00",
      EndTime: "2026-07-14 09:00:30",
      FileName: "clip-a.h264",
      sourceUrl: "https://secret.example.test/playback.m3u8",
      password: "device-password",
    },
  });
  store.markRecordingRunning({
    deviceSn: "SN-SQL",
    recordingKey: "2026-07-14 09:00:00__clip-a.h264",
  });
  store.upsertRecording({
    deviceSn: "SN-SQL",
    recordingKey: "2026-07-14 09:00:00__clip-a.h264",
    date: "2026-07-14",
    clip: {
      id: "clip_sql_1",
      fileName: "clip-a.h264",
      beginTime: "2026-07-14 09:00:00",
      endTime: "2026-07-14 09:00:30",
      durationSec: 30,
      hasCat: true,
      hasFeeding: false,
      markers: [
        {
          eventId: "event-cat-enter",
          markerType: "cat_enter",
          target: "cat",
          markerTsMs: new Date("2026-07-14 09:00:08").getTime(),
          offsetSec: 8,
          offsetMs: 8000,
          modelConfidence: 1.2,
          cuteScore: -0.2,
          cuteReasons: ["head_up", "head_up", 42],
          beginTime: "2026-07-14 09:00:08",
          endTime: "2026-07-14 09:00:30",
          sourceUrl: "https://secret.example.test/playback.m3u8",
          adminToken: "admin-token",
          playbackParams: {
            startTime: "2026-07-14 09:00:08",
            endTime: "2026-07-14 09:00:30",
            fileName: "clip-a.h264",
          },
        },
      ],
      cuteTimeline: [
        {
          offsetSec: 8.5,
          cuteScore: 1.2,
          modelConfidence: 0.88,
          cuteReasons: ["head_up", "head_up", null],
          hasCat: true,
          frame: "raw-frame-data",
          sourceUrl: "https://secret.example.test/frame.jpg",
          detectorDebug: { landmarks: [1, 2, 3] },
        },
      ],
      playbackParams: {
        startTime: "2026-07-14 09:00:00",
        endTime: "2026-07-14 09:00:30",
        fileName: "clip-a.h264",
      },
    },
  });

  const reloaded = new FeedAnalysisStore(filePath);
  const statuses = reloaded.getAnalysisStatus("SN-SQL", "2026-07-14");
  const markers = reloaded.getReplayMarkers("2026-07-14", "SN-SQL");
  const clips = reloaded.getClipsForDate("SN-SQL", "2026-07-14");

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].status, "ready");
  assert.equal(statuses[0].failureCount, 0);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].offsetSec, 8);
  assert.equal(markers[0].modelConfidence, 1);
  assert.equal(markers[0].cuteScore, 0);
  assert.deepEqual(markers[0].cuteReasons, ["head_up"]);
  assert.equal(markers[0].playbackParams.startTime, "2026-07-14 09:00:08");
  assert.deepEqual(clips[0].cuteTimeline, [
    {
      offsetSec: 8.5,
      cuteScore: 1,
      modelConfidence: 0.88,
      cuteReasons: ["head_up"],
      hasCat: true,
    },
  ]);
  assertNoSensitiveFields(clips);
});

test("FeedAnalysisStore preserves a ready clip when a forced reanalysis fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-ready-retry-"));
  const filePath = path.join(dir, "state.sqlite");
  const recordingKey = "2026-07-14 09:00:00__clip-a.h264";
  const store = new FeedAnalysisStore(filePath);

  store.markRecordingQueued({
    deviceSn: "SN-RETRY",
    date: "2026-07-14",
    recordingKey,
    recording: {
      BeginTime: "2026-07-14 09:00:00",
      EndTime: "2026-07-14 09:00:30",
      FileName: "clip-a.h264",
    },
  });
  store.upsertRecording({
    deviceSn: "SN-RETRY",
    recordingKey,
    date: "2026-07-14",
    clip: {
      id: "clip-ready",
      beginTime: "2026-07-14 09:00:00",
      endTime: "2026-07-14 09:00:30",
      fileName: "clip-a.h264",
      hasCat: true,
      hasFeeding: true,
      markers: [{ markerType: "feeding_start", beginTime: "2026-07-14 09:00:08" }],
    },
  });

  store.markRecordingQueued({
    deviceSn: "SN-RETRY",
    date: "2026-07-14",
    recordingKey,
    recording: {
      BeginTime: "2026-07-14 09:00:00",
      EndTime: "2026-07-14 09:00:30",
      FileName: "clip-a.h264",
    },
  });
  store.markRecordingFailed({
    deviceSn: "SN-RETRY",
    recordingKey,
    error: "HLS_TRANSCODE_NOT_READY",
  });

  const status = store.getAnalysisStatus("SN-RETRY", "2026-07-14")[0];
  assert.equal(status.status, "ready");
  assert.equal(status.failureCount, 1);
  assert.equal(status.lastError, "HLS_TRANSCODE_NOT_READY");
  assert.equal(store.getClipsForDate("SN-RETRY", "2026-07-14")[0].id, "clip-ready");
});

test("FeedAnalysisStore does not requeue a failed recording during an ordinary scan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-failed-status-"));
  const store = new FeedAnalysisStore(path.join(dir, "state.sqlite"));
  const deviceSn = "SN-FAILED";
  const date = "2026-07-28";
  const recordingKey = "2026-07-28 10:00:00__clip.h264";
  const recording = { FileName: "clip.h264" };

  assert.equal(store.markRecordingQueued({ deviceSn, date, recordingKey, recording }), true);
  store.markRecordingFailed({ deviceSn, recordingKey, error: "VIDEO_OPEN_FAILED" });

  assert.equal(store.markRecordingQueued({ deviceSn, date, recordingKey, recording }), false);
  assert.equal(store.getAnalysisStatus(deviceSn, date)[0].status, "failed");
  assert.equal(store.markRecordingQueued({ deviceSn, date, recordingKey, recording, force: true }), true);
  assert.equal(store.getAnalysisStatus(deviceSn, date)[0].status, "queued");
});

test("FeedAnalysisStore restores interrupted running recordings after a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-running-recovery-"));
  const store = new FeedAnalysisStore(path.join(dir, "state.sqlite"));
  const deviceSn = "SN-RUNNING";
  const date = "2026-07-28";
  const recordingKey = "2026-07-28 10:00:00__clip.h264";

  store.markRecordingQueued({ deviceSn, date, recordingKey, recording: { FileName: "clip.h264" } });
  store.markRecordingRunning({ deviceSn, recordingKey });

  assert.equal(store.recoverInterruptedRecordings(), 1);
  assert.equal(store.getAnalysisStatus(deviceSn, date)[0].status, "queued");
});

test("FeedAnalysisStore tracks material sync independently from ready analysis", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-material-sync-"));
  const store = new FeedAnalysisStore(path.join(dir, "state.sqlite"));
  const recordingKey = "2026-07-28 12:00:00__clip.h264";
  const recording = {
    BeginTime: "2026-07-28 12:00:00",
    EndTime: "2026-07-28 12:00:12",
    FileName: "clip.h264",
  };
  const clip = {
    id: "clip-material-sync",
    recordingKey,
    beginTime: recording.BeginTime,
    endTime: recording.EndTime,
    markers: [{ markerType: "cat_enter", beginTime: recording.BeginTime }],
  };

  store.markRecordingQueued({ deviceSn: "SN-SYNC", date: "2026-07-28", recordingKey, recording });
  store.upsertRecording({ deviceSn: "SN-SYNC", date: "2026-07-28", recordingKey, clip });
  store.markMaterialSyncRunning({ deviceSn: "SN-SYNC", recordingKey });
  store.markMaterialSyncFailed({ deviceSn: "SN-SYNC", recordingKey, error: "CLOUD_WRITE_FAILED" });

  assert.equal(store.getAnalysisStatus("SN-SYNC", "2026-07-28")[0].status, "ready");
  const [pending] = store.listPendingMaterialSync(10);
  assert.equal(pending.deviceSn, "SN-SYNC");
  assert.equal(pending.date, "2026-07-28");
  assert.equal(pending.recordingKey, recordingKey);
  assert.equal(pending.recording.FileName, recording.FileName);
  assert.equal(pending.clip.id, clip.id);
  assert.equal(pending.materialSyncStatus, "failed");
  assert.equal(pending.materialSyncAttempts, 1);
  assert.equal(pending.materialSyncError, "CLOUD_WRITE_FAILED");

  store.markMaterialSyncReady({ deviceSn: "SN-SYNC", recordingKey });
  assert.deepEqual(store.listPendingMaterialSync(10), []);
});

test("FeedAnalysisStore clears analysis for only one device and date", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-clear-"));
  const filePath = path.join(dir, "state.sqlite");
  const store = new FeedAnalysisStore(filePath);

  const queue = (deviceSn, date, suffix) => store.markRecordingQueued({
    deviceSn,
    date,
    recordingKey: `${date} 09:00:00__clip-${suffix}.h264`,
    recording: {
      BeginTime: `${date} 09:00:00`,
      EndTime: `${date} 09:01:00`,
      FileName: `clip-${suffix}.h264`,
    },
  });
  queue("SN-OLD", "2026-07-08", "target");
  queue("SN-OLD", "2026-07-09", "other-date");
  queue("SN-NEW", "2026-07-08", "other-device");

  const result = store.clearAnalysisForDate("SN-OLD", "2026-07-08");

  assert.equal(result.deleted, 1);
  assert.equal(store.getAnalysisStatus("SN-OLD", "2026-07-08").length, 0);
  assert.equal(store.getAnalysisStatus("SN-OLD", "2026-07-09").length, 1);
  assert.equal(store.getAnalysisStatus("SN-NEW", "2026-07-08").length, 1);
});

test("FeedAnalysisStore migrates legacy json state into an empty sqlite store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-migrate-"));
  const sqlitePath = path.join(dir, "feed-analysis-state.sqlite");
  const legacyPath = path.join(dir, "feed-analysis-state.json");
  fs.writeFileSync(
    legacyPath,
    JSON.stringify({
      settings: {
        deviceSn: "SN-OLD",
        analysisEnabled: true,
        officialConfigStatus: "ready",
      },
      recordings: {
        "2026-07-14 09:00:00__clip-a.h264": {
          recordingKey: "2026-07-14 09:00:00__clip-a.h264",
          date: "2026-07-14",
          clip: {
            id: "clip_old_1",
            recordingKey: "2026-07-14 09:00:00__clip-a.h264",
            beginTime: "2026-07-14 09:00:00",
            endTime: "2026-07-14 09:00:30",
            durationSec: 30,
            fileName: "clip-a.h264",
            hasCat: true,
            markers: [
              null,
              {
                markerType: "cat_enter",
                target: "cat",
                offsetSec: 5,
                playbackParams: {
                  startTime: "2026-07-14 09:00:05",
                  endTime: "2026-07-14 09:00:30",
                  fileName: "clip-a.h264",
                },
              },
            ],
          },
        },
      },
    })
  );

  const store = new FeedAnalysisStore(sqlitePath);
  const markers = store.getReplayMarkers("2026-07-14", "SN-OLD");

  assert.equal(store.getSettings().analysisEnabled, true);
  assert.equal(store.getSettings().officialConfigStatus, "ready");
  assert.equal(store.hasProcessed("2026-07-14 09:00:00__clip-a.h264", "SN-OLD"), true);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].offsetSec, 5);
  assert.equal(markers[1].markerLabel, "有猫出现");
  assert.deepEqual(store.getClipsForDate("SN-OLD", "2026-07-14")[0].cuteTimeline, []);
});

test("FeedAnalysisStore enqueues and deduplicates snapshot feeding notifications", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-store-"));
  const filePath = path.join(dir, "state.json");
  const store = new FeedAnalysisStore(filePath);

  const notification = store.enqueueFeedingNotification({
    eventId: "alarm-1__feeding_start",
    date: "2026-07-04",
    snapshotUrl: "https://example.test/alarm.jpg",
    alarmId: "alarm-1",
    startTime: "2026-07-04 12:00:08",
  });
  const duplicate = store.enqueueFeedingNotification({
    eventId: "alarm-1__feeding_start",
    date: "2026-07-04",
  });

  assert.equal(notification.title, "猫咪来吃饭了");
  assert.equal(duplicate, notification);
  assert.equal(store.listPendingNotifications().length, 1);

  const reloaded = new FeedAnalysisStore(filePath);
  assert.equal(reloaded.listPendingNotifications()[0].snapshotUrl, "https://example.test/alarm.jpg");
});

for (const extension of ["json", "sqlite"]) {
  test(`FeedAnalysisStore validates clip scalars and bowl ROI in ${extension} mode`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-clip-scalars-"));
    const filePath = path.join(dir, `state.${extension}`);
    const store = new FeedAnalysisStore(filePath);
    const recordingKey = "2026-07-10 08:00:00__clip-scalars.h264";

    store.upsertRecording({
      deviceSn: "SN-CLIP",
      recordingKey,
      date: "2026-07-10",
      clip: {
        id: { sourceUrl: "https://secret.example.test/id" },
        recordingKey: { rawFrame: "must-not-leak" },
        beginTime: ["2026-07-10 08:00:00"],
        endTime: { sourceUrl: "https://secret.example.test/end" },
        durationSec: [30],
        fileName: { rawFrame: "must-not-leak" },
        title: ["title"],
        time: { sourceUrl: "https://secret.example.test/time" },
        cover: { rawFrame: "must-not-leak" },
        isEffective: { sourceUrl: "https://secret.example.test/effective" },
        hasCat: [true],
        hasFeeding: "true",
        analysisConfidence: [0.9],
        bowlRoi: {
          x: 10,
          y: 20,
          width: 100,
          height: 80,
          sourceUrl: "https://secret.example.test/roi",
          rawFrame: "must-not-leak",
          detectorDebug: { points: [1, 2] },
        },
        markers: [],
      },
    });

    const persistedClip = extension === "sqlite"
      ? JSON.parse(
          store.db
            .prepare("SELECT clip_json FROM recording_analysis WHERE device_sn = ? AND recording_key = ?")
            .get("SN-CLIP", recordingKey).clip_json
        )
      : JSON.parse(fs.readFileSync(filePath, "utf8")).recordings[recordingKey].clip;

    assert.equal(persistedClip.id, "");
    assert.equal(persistedClip.recordingKey, "");
    assert.equal(persistedClip.beginTime, "");
    assert.equal(persistedClip.endTime, "");
    assert.equal(persistedClip.durationSec, 0);
    assert.equal(persistedClip.fileName, "");
    assert.equal(persistedClip.title, "");
    assert.equal(persistedClip.time, "");
    assert.equal(persistedClip.cover, "");
    assert.equal(persistedClip.isEffective, false);
    assert.equal(persistedClip.hasCat, false);
    assert.equal(persistedClip.hasFeeding, false);
    assert.equal(persistedClip.analysisConfidence, 0);
    assert.deepEqual(persistedClip.bowlRoi, { x: 10, y: 20, width: 100, height: 80 });
    assert.doesNotMatch(JSON.stringify(persistedClip), /secret\.example|sourceUrl|rawFrame|detectorDebug/);
  });

  test(`FeedAnalysisStore strips nested objects from marker scalars in ${extension} mode`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-marker-scalars-"));
    const filePath = path.join(dir, `state.${extension}`);
    const store = new FeedAnalysisStore(filePath);
    const recordingKey = "2026-07-10 09:00:00__nested.h264";

    store.upsertRecording({
      deviceSn: "SN-NESTED",
      recordingKey,
      date: "2026-07-10",
      clip: {
        id: "clip-nested",
        markers: [
          {
            eventId: { sourceUrl: "https://secret.example.test/event" },
            recordingKey: { rawFrame: "must-not-leak" },
            markerType: ["cat_enter"],
            target: { sourceUrl: "https://secret.example.test/target" },
            markerTsMs: [1_700_000_000_000],
            offsetSec: [5],
            offsetMs: [5000],
            beginTime: { rawFrame: "must-not-leak" },
            endTime: ["2026-07-10 09:00:05"],
            confidence: [1],
            modelConfidence: [1],
            cuteScore: [1],
            markerLabel: { sourceUrl: "https://secret.example.test/label" },
            playbackParams: {
              startTime: { sourceUrl: "https://secret.example.test/start" },
              endTime: ["2026-07-10 09:00:30"],
              fileName: { rawFrame: "must-not-leak" },
              targetSec: 5,
            },
          },
        ],
      },
    });

    const persistedClip = extension === "sqlite"
      ? JSON.parse(
          store.db
            .prepare("SELECT clip_json FROM recording_analysis WHERE device_sn = ? AND recording_key = ?")
            .get("SN-NESTED", recordingKey).clip_json
        )
      : JSON.parse(fs.readFileSync(filePath, "utf8")).recordings[recordingKey].clip;
    const marker = persistedClip.markers[0];

    assert.equal(marker.eventId, undefined);
    assert.equal(marker.recordingKey, "");
    assert.equal(marker.markerType, "");
    assert.equal(marker.target, "");
    assert.equal(marker.markerTsMs, 0);
    assert.equal(marker.offsetSec, 0);
    assert.equal(marker.offsetMs, 0);
    assert.equal(marker.beginTime, "");
    assert.equal(marker.endTime, "");
    assert.equal(marker.confidence, 0);
    assert.equal(marker.modelConfidence, 0);
    assert.equal(marker.cuteScore, 0);
    assert.equal(marker.markerLabel, undefined);
    assert.deepEqual(marker.playbackParams, {
      startTime: "",
      endTime: "",
      fileName: "",
      targetSec: 5,
    });
    assert.doesNotMatch(JSON.stringify(persistedClip), /secret\.example|sourceUrl|rawFrame/);
  });

  test(`FeedAnalysisStore rejects invalid clips in ${extension} mode`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-invalid-clip-"));
    const filePath = path.join(dir, `state.${extension}`);
    const store = new FeedAnalysisStore(filePath);

    for (const [index, clip] of [null, [], "invalid"].entries()) {
      assert.throws(
        () => store.upsertRecording({
          deviceSn: "SN-INVALID",
          recordingKey: `invalid-${index}`,
          date: "2026-07-10",
          clip,
        }),
        { message: "RECORDING_CLIP_INVALID" }
      );
    }
  });
}

for (const extension of ["json", "sqlite"]) {
  test(`FeedAnalysisStore persists PushPlus friend bindings in ${extension} mode`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-analysis-binding-"));
    const filePath = path.join(dir, `state.${extension}`);
    const store = new FeedAnalysisStore(filePath);
    const now = Date.now();

    store.savePushPlusBindingChallenge({
      openid: "openid-bind-1",
      code: "binding-code-1",
      qrCodeUrl: "https://mp.weixin.qq.com/private-qr",
      expiresAt: now + 60_000,
    });

    assert.equal(store.getActivePushPlusBindingChallenge("openid-bind-1", now).code, "binding-code-1");
    const binding = store.completePushPlusBinding("binding-code-1", {
      token: "friend-token-1",
      friendId: 41,
      isFollow: 1,
      nickName: "Cat Friend",
    });

    assert.equal(binding.openid, "openid-bind-1");
    assert.equal(new FeedAnalysisStore(filePath).getPushPlusBinding("openid-bind-1").friendToken, "friend-token-1");
    assert.equal(store.getActivePushPlusBindingChallenge("openid-bind-1", now), null);
  });
}

function assertNoSensitiveFields(payload) {
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /secret\.example|device-password|admin-token|sourceUrl/i);
}

function buildHistoricalDirtyClip() {
  return {
    id: "clip-history",
    recordingKey: "2026-07-11 09:00:00__legacy.h264",
    beginTime: "2026-07-11 09:00:00",
    endTime: "2026-07-11 09:00:30",
    durationSec: 30,
    fileName: "legacy.h264",
    hasCat: true,
    hasFeeding: true,
    internalField: "must-not-leak",
    markers: [
      null,
      {
        markerType: "feeding_start",
        beginTime: "2026-07-11 09:00:05",
        offsetSec: 5,
        modelConfidence: 1.4,
        cuteScore: -0.2,
        cuteReasons: ["head_up", "head_up", 7],
        sourceUrl: "https://secret.example.test/replay.m3u8",
      },
    ],
    cuteTimeline: [
      {
        offsetSec: 5.5,
        cuteScore: 1.4,
        modelConfidence: -0.2,
        cuteReasons: ["head_up", "head_up", null],
        hasCat: true,
        sourceUrl: "https://secret.example.test/frame.jpg",
        rawFrame: "must-not-leak",
        detectorDebug: { landmarks: [1, 2, 3] },
      },
    ],
  };
}

function assertSanitizedHistoricalClip(clip) {
  assert.equal(clip.markers.length, 1);
  assert.equal(clip.markers[0].modelConfidence, 1);
  assert.equal(clip.markers[0].cuteScore, 0);
  assert.deepEqual(clip.markers[0].cuteReasons, ["head_up"]);
  assert.deepEqual(clip.cuteTimeline, [
    {
      offsetSec: 5.5,
      cuteScore: 1,
      modelConfidence: 0,
      cuteReasons: ["head_up"],
      hasCat: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(clip), /secret\.example|sourceUrl|rawFrame|detectorDebug|internalField/);
}
