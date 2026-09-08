const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FeedAnalysisCoordinator,
  buildCandidateRanges,
  buildRollingAlarmAnalysisWindow,
  buildStructuredFeedingClip,
  splitRecordingForAnalysis,
} = require("./coordinator");

test("buildCandidateRanges pads, merges, and clips sparse cat samples", () => {
  const ranges = buildCandidateRanges([
    { offsetSec: 1, hasCat: true },
    { offsetSec: 3, hasCat: true },
    { offsetSec: 22, hasCat: true },
    { offsetSec: 24, hasCat: true },
    { offsetSec: 40, hasCat: false },
    { offsetSec: 58, hasCat: true },
  ], 60, {
    sampleSeconds: 2,
    mergeGapSeconds: 4,
    paddingBeforeSeconds: 5,
    paddingAfterSeconds: 7,
  });

  assert.deepEqual(ranges, [
    { startSec: 0, endSec: 12, durationSec: 12 },
    { startSec: 17, endSec: 33, durationSec: 16 },
    { startSec: 53, endSec: 60, durationSec: 7 },
  ]);
});

test("buildCandidateRanges returns no work for no-cat screening", () => {
  assert.deepEqual(buildCandidateRanges([
    { offsetSec: 0, hasCat: false },
    { offsetSec: 2, hasCat: false },
  ], 30), []);
});

test("buildRollingAlarmAnalysisWindow covers the first alarm lookback and coalesces later alarms", () => {
  const atDeviceTime = (value) => Date.parse(`${value.replace(" ", "T")}+08:00`);
  const first = buildRollingAlarmAnalysisWindow({
    alarms: [
      { occurredAtMs: atDeviceTime("2026-08-28 12:00:00") },
      { occurredAtMs: atDeviceTime("2026-08-28 12:04:00") },
    ],
  });
  assert.equal(first.beginTime, "2026-08-28 11:30:00");
  assert.equal(first.endTime, "2026-08-28 12:00:00");
  assert.equal(first.requestedThroughMs, atDeviceTime("2026-08-28 12:04:00"));

  const tail = buildRollingAlarmAnalysisWindow({
    analyzedThroughMs: atDeviceTime("2026-08-28 12:04:00"),
    pendingFromMs: atDeviceTime("2026-08-28 11:35:00"),
    pendingThroughMs: atDeviceTime("2026-08-28 12:09:00"),
    overlapMs: 30 * 1000,
  });
  assert.equal(tail.beginTime, "2026-08-28 12:03:30");
  assert.equal(tail.endTime, "2026-08-28 12:09:00");
});

test("buildRollingAlarmAnalysisWindow skips fully covered pending alarms", () => {
  const analyzedThroughMs = Date.parse("2026-08-28T12:10:00+08:00");
  assert.equal(buildRollingAlarmAnalysisWindow({
    analyzedThroughMs,
    pendingThroughMs: analyzedThroughMs,
  }), null);
});

test("buildStructuredFeedingClip removes every durable media reference", () => {
  const structured = buildStructuredFeedingClip({
    id: "clip-1",
    recordingKey: "secret-file.h264",
    beginTime: "2026-08-28 12:00:00",
    endTime: "2026-08-28 12:01:00",
    durationSec: 60,
    fileName: "secret-file.h264",
    cover: "https://secret.example/cover.jpg",
    playbackParams: { fileName: "secret-file.h264", startTime: "x", endTime: "y" },
    hasCat: true,
    hasFeeding: true,
    analysisConfidence: 0.9,
    frames: [{ rawFrame: "secret" }],
    markers: [{
      eventId: "event-1",
      markerType: "feeding_start",
      beginTime: "2026-08-28 12:00:10",
      endTime: "2026-08-28 12:00:20",
      sourceUrl: "https://secret.example/video.m3u8",
      snapshotUrl: "https://secret.example/frame.jpg",
      playbackParams: { fileName: "secret-file.h264" },
    }],
    feedingStats: {
      version: "feeding-stats-v3.2",
      source: {
        mediaId: "secret-file.h264",
        name: "secret-file.h264",
        path: "C:/secret-file.h264",
        sha256: "secret",
        durationSec: 60,
        orientation: "clockwise-90",
        range: { startTime: "2026-08-28 12:00:00", endTime: "2026-08-28 12:01:00" },
      },
      summary: { mealCount: 1, actualEatingSeconds: 10, bowlPresenceSeconds: 12 },
      meals: [],
      events: [],
      timeline: [],
    },
  }, "feeding-window:2026-08-28T12:00:00");

  const serialized = JSON.stringify(structured);
  assert.equal(serialized.includes("secret-file"), false);
  assert.equal(serialized.includes("m3u8"), false);
  assert.equal(serialized.includes("rawFrame"), false);
  assert.equal(structured.feedingStats.summary.actualEatingSeconds, 10);
  assert.equal(structured.markers[0].eventId, "event-1");
});

test("splitRecordingForAnalysis bounds long replay work and overlaps adjacent segments", () => {
  const segments = splitRecordingForAnalysis({
    BeginTime: "2026-08-24 15:00:00",
    EndTime: "2026-08-24 16:00:00",
    FileName: "hour.h264",
  });
  assert.equal(segments.length, 7);
  assert.equal(segments[0].BeginTime, "2026-08-24 15:00:00");
  assert.equal(segments[0].EndTime, "2026-08-24 15:10:00");
  assert.equal(segments[1].BeginTime, "2026-08-24 15:09:45");
  assert.equal(segments.at(-1).EndTime, "2026-08-24 16:00:00");
  assert.ok(segments.every((segment) => segment.durationSec <= 600));
});

function makeStore() {
  const state = {
    settings: {
      deviceSn: "SN001",
      analysisEnabled: true,
      officialConfigStatus: "idle",
      officialAlarmStatus: "idle",
      lastOfficialAlarmAt: 0,
      bowlRoi: null,
    },
    recordings: {},
    pendingNotifications: [],
    updatedSettings: null,
    upserts: [],
    statusEvents: [],
    materialSyncEvents: [],
  };
  return {
    getSettings() {
      return { ...state.settings };
    },
    updateSettings(patch) {
      state.settings = { ...state.settings, ...patch };
      state.updatedSettings = patch;
      return this.getSettings();
    },
    getBowlRoi(deviceSn) {
      return state.settings.bowlRoisByDevice?.[deviceSn] || null;
    },
    setBowlRoi(deviceSn, bowlRoi) {
      state.settings.bowlRoisByDevice = {
        ...(state.settings.bowlRoisByDevice || {}),
        [deviceSn]: bowlRoi,
      };
      return this.getSettings();
    },
    hasProcessed(recordingKey) {
      return !!state.recordings[recordingKey];
    },
    upsertRecording(payload) {
      state.recordings[payload.recordingKey] = payload;
      state.upserts.push(payload);
      state.statusEvents.push(["ready", payload.deviceSn, payload.recordingKey]);
    },
    markRecordingQueued(payload) {
      state.statusEvents.push(["queued", payload.deviceSn, payload.recordingKey]);
    },
    markRecordingRunning(payload) {
      state.statusEvents.push(["running", payload.deviceSn, payload.recordingKey]);
    },
    markRecordingFailed(payload) {
      state.statusEvents.push(["failed", payload.deviceSn, payload.recordingKey]);
    },
    markMaterialSyncRunning(payload) {
      state.materialSyncEvents.push(["running", payload.deviceSn, payload.recordingKey]);
    },
    markMaterialSyncReady(payload) {
      state.materialSyncEvents.push(["ready", payload.deviceSn, payload.recordingKey]);
    },
    markMaterialSyncFailed(payload) {
      state.materialSyncEvents.push(["failed", payload.deviceSn, payload.recordingKey, payload.error.message]);
    },
    listPendingMaterialSync() {
      return state.pendingMaterialSync || [];
    },
    enqueueFeedingNotification(payload) {
      const existing = state.pendingNotifications.find((item) => item.eventId === payload.eventId);
      if (existing) return existing;
      state.pendingNotifications.push(payload);
      return payload;
    },
    listPendingNotifications() {
      return state.pendingNotifications.filter((item) => !item.sentAt);
    },
    get state() {
      return state;
    },
  };
}

test("feeding-start candidate coalesces an alarm storm into one short replay task", async () => {
  const store = makeStore();
  const coordinator = new FeedAnalysisCoordinator({ store, alarmAdapter: false });
  const queued = [];
  coordinator.queue.enqueueRecording = (task) => {
    queued.push(task);
    return { ok: true, queued: true, jobKey: `${task.deviceSn}:${task.recordingKey}` };
  };
  const now = new Date("2026-08-30 12:00:40");
  const alarms = Array.from({ length: 30 }, (_, index) => ({
    id: `alarm-${index}`,
    alarmType: "MotionDetect",
    occurredAtMs: new Date(`2026-08-30 12:00:${String(index % 30).padStart(2, "0")}`).getTime(),
  }));

  const result = await coordinator.registerFeedingStartAlarms({
    device: { sn: "SN001" },
    deviceSn: "SN001",
    alarms,
    now,
  });

  assert.equal(result.queued, true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].recordingKey, "feeding-start-candidate");
  assert.equal(store.getSettings("SN001").feedingStartState, "candidate");
  assert.equal(store.getSettings("SN001").feedingStartLastAlarmAtMs, alarms.at(-1).occurredAtMs);
});

test("feeding-start active state absorbs repeated alarms without duplicate tasks", async () => {
  const store = makeStore();
  store.updateSettings({
    feedingStartState: "active",
    feedingStartLastAlarmAtMs: new Date("2026-08-30 12:00:00").getTime(),
    feedingStartConfirmedAtMs: new Date("2026-08-30 11:59:30").getTime(),
  }, "SN001");
  const coordinator = new FeedAnalysisCoordinator({ store, alarmAdapter: false });
  let queued = 0;
  coordinator.queue.enqueueRecording = () => { queued += 1; return { ok: true, queued: true }; };

  const result = await coordinator.registerFeedingStartAlarms({
    device: { sn: "SN001" },
    deviceSn: "SN001",
    alarms: [{ id: "alarm-next", alarmType: "MotionDetect", occurredAtMs: new Date("2026-08-30 12:01:00").getTime() }],
    now: new Date("2026-08-30 12:01:10"),
  });

  assert.equal(result.suppressed, true);
  assert.equal(queued, 0);
  assert.equal(store.getSettings("SN001").feedingStartState, "active");
  assert.equal(
    store.getSettings("SN001").feedingStartLastAlarmAtMs,
    new Date("2026-08-30 12:01:00").getTime()
  );
});

test("feeding-start active state rearms after the configured quiet gap", async () => {
  const store = makeStore();
  store.updateSettings({
    feedingStartState: "active",
    feedingStartLastAlarmAtMs: new Date("2026-08-30 12:00:00").getTime(),
    feedingStartConfirmedAtMs: new Date("2026-08-30 11:59:30").getTime(),
    feedingStartEventAtMs: new Date("2026-08-30 11:59:20").getTime(),
  }, "SN001");
  const coordinator = new FeedAnalysisCoordinator({
    store,
    alarmAdapter: false,
    feedingStartRearmQuietMs: 10 * 60 * 1000,
  });

  const result = await coordinator.advanceFeedingStartState({
    deviceSn: "SN001",
    now: new Date("2026-08-30 12:10:01"),
  });

  assert.equal(result.rearmed, true);
  assert.equal(store.getSettings("SN001").feedingStartState, "idle");
  assert.equal(store.getSettings("SN001").feedingStartEventAtMs, 0);
});

test("feeding-start candidate does not analyze the same short range twice", async () => {
  const store = makeStore();
  const throughMs = new Date("2026-08-30 12:00:30").getTime();
  store.updateSettings({
    feedingStartState: "candidate",
    feedingStartCandidateFromMs: new Date("2026-08-30 12:00:00").getTime(),
    feedingStartCandidateThroughMs: throughMs,
    feedingStartLastAnalyzedThroughMs: throughMs,
    feedingStartLastAlarmAtMs: new Date("2026-08-30 12:00:20").getTime(),
  }, "SN001");
  const coordinator = new FeedAnalysisCoordinator({ store, alarmAdapter: false });

  const result = await coordinator.processFeedingStartCandidateTask({
    deviceSn: "SN001",
    recordingKey: "feeding-start-candidate",
  });

  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: "FEEDING_START_RANGE_ALREADY_ANALYZED",
  });
});

test("feeding-start candidate confirms with V3.2 stats and dispatches one real start time", async () => {
  const store = makeStore();
  store.updateSettings({
    feedingStartState: "candidate",
    feedingStartCandidateFromMs: new Date("2026-08-30 12:00:00").getTime(),
    feedingStartCandidateThroughMs: new Date("2026-08-30 12:00:30").getTime(),
    feedingStartLastAlarmAtMs: new Date("2026-08-30 12:00:20").getTime(),
  }, "SN001");
  const delivered = [];
  const device = {
    sn: "SN001",
    async status() { return { status: "online" }; },
    async login() {},
    async queryRecordings() {
      return [{
        BeginTime: "2026-08-30 11:59:00",
        EndTime: "2026-08-30 12:01:00",
        FileName: "feeding.h264",
      }];
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    alarmAdapter: false,
    deviceNotificationDispatcher: {
      async dispatchFeedingEvent(payload) {
        delivered.push(payload);
        return { ok: true };
      },
    },
  });
  coordinator.analyzeRecording = async () => ({
    analysis: {
      feedingStats: {
        version: "feeding-stats-v3.2",
        source: { durationSec: 30 },
        summary: { analyzedSeconds: 30, mealCount: 1 },
        meals: [{
          id: "meal-1",
          startSec: 17,
          endSec: 29,
          spanSeconds: 12,
          actualEatingSeconds: 8,
          confidence: 0.86,
        }],
      },
    },
  });

  const result = await coordinator.processFeedingStartCandidateTask({
    device,
    deviceSn: "SN001",
    recordingKey: "feeding-start-candidate",
  });

  assert.equal(result.confirmed, true);
  assert.equal(store.getSettings("SN001").feedingStartState, "active");
  assert.equal(
    store.getSettings("SN001").feedingStartEventAtMs,
    new Date("2026-08-30 12:00:17").getTime()
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].eventType, "feeding_start");
  assert.equal(delivered[0].occurredAt, "2026-08-30 12:00:17");
});

test("feeding-start candidate uses 30 seconds first and expands to 45 seconds for follow-up evidence", async () => {
  const store = makeStore();
  store.updateSettings({
    feedingStartState: "candidate",
    feedingStartCandidateFromMs: new Date("2026-08-30 11:59:00").getTime(),
    feedingStartCandidateThroughMs: new Date("2026-08-30 12:00:30").getTime(),
    feedingStartLastAlarmAtMs: new Date("2026-08-30 12:00:20").getTime(),
  }, "SN001");
  const analyzedWindows = [];
  const device = {
    sn: "SN001",
    async status() { return { status: "online" }; },
    async login() {},
    async queryRecordings() {
      return [{
        BeginTime: "2026-08-30 11:58:00",
        EndTime: "2026-08-30 12:02:00",
        FileName: "feeding.h264",
      }];
    },
  };
  const coordinator = new FeedAnalysisCoordinator({ store, alarmAdapter: false });
  coordinator.analyzeRecording = async ({ recording }) => {
    analyzedWindows.push(recording.analysisTargetWindow);
    return { analysis: { feedingStats: { source: { durationSec: 30 }, meals: [] } } };
  };

  await coordinator.processFeedingStartCandidateTask({ device, deviceSn: "SN001" });
  store.updateSettings({
    ...store.getSettings("SN001"),
    feedingStartCandidateThroughMs: new Date("2026-08-30 12:00:40").getTime(),
  }, "SN001");
  await coordinator.processFeedingStartCandidateTask({ device, deviceSn: "SN001" });

  const durations = analyzedWindows.map((window) => (
    new Date(window.endTime).getTime() - new Date(window.beginTime).getTime()
  ) / 1000);
  assert.deepEqual(durations, [30, 45]);
});

test("disabled coordinator rejects scheduled, forced, and queued model work", async () => {
  let analyzed = 0;
  const coordinator = new FeedAnalysisCoordinator({
    enabled: false,
    store: makeStore(),
    analyzer: {
      async analyze() {
        analyzed += 1;
        return {};
      },
    },
  });
  coordinator.setDeviceProvider({ async listDeviceSns() { return []; } });
  coordinator.queue.enqueueRecording = () => ({ ok: true, queued: true });
  coordinator.processRecordingTask = async () => {
    analyzed += 1;
    return { ok: true };
  };

  coordinator.start();
  const timerStarted = coordinator.timer !== null;
  const scheduled = await coordinator.enqueueDueScans();
  const forced = coordinator.enqueueRecording({
    force: true,
    deviceSn: "SN001",
    recordingKey: "record-1",
    recording: { BeginTime: "2026-07-31 10:00:00", EndTime: "2026-07-31 10:01:00" },
  });
  const queued = await coordinator.processQueueTask({
    type: "recording",
    force: true,
    deviceSn: "SN001",
    recordingKey: "record-1",
  });
  coordinator.stop();

  assert.equal(timerStarted, false);
  assert.deepEqual(scheduled, { ok: true, devices: 0, queued: 0, skipped: true, disabled: true });
  assert.deepEqual(forced, { ok: true, queued: false, skipped: true, disabled: true });
  assert.deepEqual(queued, { ok: true, skipped: true, disabled: true });
  assert.equal(analyzed, 0);
});

test("marks an analyzed recording ready before material synchronization", async () => {
  const order = [];
  const store = makeStore();
  const originalUpsert = store.upsertRecording;
  store.upsertRecording = (payload) => {
    order.push(["local", payload.clip.id]);
    return originalUpsert(payload);
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => ({ sn: "SN001" }),
    persistAnalyzedClip: async (payload) => order.push(["durable", payload.clip.id]),
  });
  coordinator.analyzeRecording = async () => ({
    analysis: { markers: [] },
    clipDate: "2026-07-26",
    clip: { id: "clip-1", markers: [] },
  });

  const result = await coordinator.processRecordingTask({
    force: true,
    deviceSn: "SN001",
    recordingKey: "record-1",
    recording: { BeginTime: "2026-07-26 10:00:00", EndTime: "2026-07-26 10:01:00" },
  });

  assert.deepEqual(result, { ok: true });
  await coordinator.materialSyncQueue.onIdle();
  assert.deepEqual(order, [["local", "clip-1"], ["durable", "clip-1"]]);
});

test("restores durable detection settings before scheduled scanning starts", async () => {
  const store = makeStore();
  store.state.settings.analysisEnabled = false;
  const persistentSettingsStore = {
    async initialize() {},
    async loadAll() {
      return [{ deviceSn: "SN001", openid: "owner-1", analysisEnabled: true, notifyEnabled: true }];
    },
    async upsert(settings) { return settings; },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    persistentSettingsStore,
    deviceFactory: async () => ({ sn: "SN001" }),
  });

  await coordinator.initialize();
  assert.equal(store.getSettings("SN001").analysisEnabled, true);
  await coordinator.persistSettings({ deviceSn: "SN001", analysisEnabled: false, notifyEnabled: false });
  assert.equal(store.getSettings("SN001").analysisEnabled, false);
});

test('restores durable recording analysis and requeues interrupted work on initialization', async () => {
	const store = makeStore()
	store.restoreAnalysisRecords = (records) => { store.state.restoredRecords = records; return records.length }
	const persisted = []
	const requeued = []
	const persistentAnalysisStore = {
		async initialize() {},
		async loadAll() {
			return [
				{ deviceSn: 'SN001', recordingKey: 'ready-1', date: '2026-07-28', status: 'ready', clip: { id: 'clip-ready', markers: [{ markerType: 'feeding_start' }] } },
				{ deviceSn: 'SN001', recordingKey: 'queued-1', date: '2026-07-28', status: 'queued', recording: { FileName: 'queued.mp4' } },
				{ deviceSn: 'SN001', recordingKey: 'running-1', date: '2026-07-28', status: 'running', recording: { FileName: 'running.mp4' } },
				{ deviceSn: 'SN001', recordingKey: 'failed-1', date: '2026-07-28', status: 'failed', recording: { FileName: 'failed.mp4' } },
			]
		},
		async upsert(record) { persisted.push(record) },
	}
	const coordinator = new FeedAnalysisCoordinator({ store, persistentAnalysisStore, alarmAdapter: false })
	coordinator.enqueueRecording = (task) => { requeued.push(task); return { ok: true, queued: true } }

	const result = await coordinator.initialize()

	assert.equal(result.restoredRecordings, 4)
	assert.equal(store.state.restoredRecords[0].status, 'ready')
	assert.equal(store.state.restoredRecords[2].status, 'queued')
	assert.equal(persisted[0].status, 'queued')
	assert.deepEqual(requeued.map((task) => task.recordingKey), ['queued-1', 'running-1'])
})

test('persists a ready analysis before marking the local recording ready', async () => {
	const order = []
	const store = makeStore()
	const originalUpsert = store.upsertRecording
	store.upsertRecording = (payload) => { order.push('local-ready'); originalUpsert(payload) }
	const coordinator = new FeedAnalysisCoordinator({
		store,
		persistentAnalysisStore: { async upsert(record) { order.push(`cloud-${record.status}`) } },
		deviceFactory: async () => ({ sn: 'SN001' }),
		alarmAdapter: false,
	})
	coordinator.analyzeRecording = async () => ({ clipDate: '2026-07-28', clip: { id: 'clip-1', markers: [] } })

	await coordinator.processRecordingTask({ force: true, deviceSn: 'SN001', recordingKey: 'record-1', recording: { BeginTime: '2026-07-28 10:00:00' } })

	assert.deepEqual(order.slice(0, 2), ['cloud-ready', 'local-ready'])
})

test("enables scheduled detection for registered devices missing durable settings", async () => {
  const store = makeStore();
  store.state.settings.analysisEnabled = false;
  const saved = [];
  const coordinator = new FeedAnalysisCoordinator({
    store,
    persistentSettingsStore: {
      async initialize() {},
      async loadAll() { return []; },
      async loadBindings() { return []; },
      async upsert(settings) { saved.push(settings); return settings; },
    },
    deviceFactory: async () => ({ sn: "SN001" }),
  });
  coordinator.setDeviceProvider({
    listDevices: () => [{ sn: "SN001", ownerOpenid: "owner-1" }],
  });

  const result = await coordinator.initialize();

  assert.equal(result.bootstrapped, 1);
  assert.equal(store.getSettings("SN001").analysisEnabled, true);
  assert.equal(store.getSettings("SN001").notifyEnabled, true);
  assert.equal(store.getSettings("SN001").openid, "owner-1");
  assert.equal(saved.length, 1);
});

test("a material synchronization failure keeps the recording analysis ready", async () => {
  const store = makeStore();
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => ({ sn: "SN001" }),
    persistAnalyzedClip: async () => { throw new Error("CLOUD_WRITE_FAILED"); },
    retryDelayMs: 0,
    maxRetries: 0,
  });
  coordinator.analyzeRecording = async () => ({
    analysis: { markers: [] },
    clipDate: "2026-07-26",
    clip: { id: "clip-1", markers: [] },
  });

  const result = await coordinator.processRecordingTask({
    force: true,
    deviceSn: "SN001",
    recordingKey: "record-1",
    recording: { BeginTime: "2026-07-26 10:00:00", EndTime: "2026-07-26 10:01:00" },
  });

  assert.deepEqual(result, { ok: true });
  await coordinator.materialSyncQueue.onIdle();
  assert.equal(store.hasProcessed("record-1", "SN001"), true);
  assert.equal(store.state.upserts.length, 1);
  assert.deepEqual(store.state.statusEvents.at(-1), ["ready", "SN001", "record-1"]);
  assert.deepEqual(store.state.materialSyncEvents, [["running", "SN001", "record-1"], ["failed", "SN001", "record-1", "CLOUD_WRITE_FAILED"]]);
});

test("retries pending material synchronization without reanalyzing the recording", async () => {
  const store = makeStore();
  store.state.pendingMaterialSync = [{
    deviceSn: "SN001",
    date: "2026-07-26",
    recordingKey: "record-1",
    recording: { BeginTime: "2026-07-26 08:00:00" },
    clip: { id: "clip-1", markers: [] },
  }];
  let persisted = 0;
  const coordinator = new FeedAnalysisCoordinator({
    store,
    persistAnalyzedClip: async () => { persisted += 1; },
  });
  coordinator.analyzeRecording = async () => {
    throw new Error("recording analysis must not run during material recovery");
  };

  const result = coordinator.recoverMaterialSync();

  assert.deepEqual(result, { ok: true, queued: 1, records: 1 });
  await coordinator.materialSyncQueue.onIdle();
  assert.equal(persisted, 1);
  assert.deepEqual(store.state.materialSyncEvents, [["running", "SN001", "record-1"], ["ready", "SN001", "record-1"]]);
});

test("syncNow also persists before marking a discovered recording processed", async () => {
  const order = [];
  const store = makeStore();
  const originalUpsert = store.upsertRecording;
  store.upsertRecording = (payload) => {
    order.push("local");
    return originalUpsert(payload);
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => ({ sn: "SN001" }),
    persistAnalyzedClip: async () => order.push("durable"),
  });
  coordinator.bootstrapOfficialConfig = async () => {};
  coordinator.collectCandidateRecordings = async () => ({ records: [{ FileName: "clip.h264" }], snapshots: [] });
  coordinator.analyzeRecording = async () => ({
    analysis: { markers: [] },
    clipDate: "2026-07-26",
    clip: { id: "clip-sync", markers: [] },
  });

  await coordinator.syncNow({ force: true, date: "2026-07-26" });

  assert.deepEqual(order, ["durable", "local"]);
});

test("FeedAnalysisCoordinator defers device work while user playback is active", async () => {
  const calls = [];
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const record = {
    BeginTime: "2026-07-14 09:48:41",
    EndTime: "2026-07-14 09:48:53",
    FileName: "clip.h264",
  };
  const device = {
    sn: "SNP",
    async getPlaybackUrl() {
      calls.push(["getPlaybackUrl"]);
      return "https://example.test/clip.m3u8";
    },
  };
  const analyzer = {
    async analyzeRecording() {
      calls.push(["analyzeRecording"]);
      return { markers: [] };
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
    retryDelayMs: 0,
    maxRetries: 0,
  });

  coordinator.pauseDevice("SNP", 60 * 1000);
  const result = await coordinator.processRecordingTask({
    force: true,
    date: "2026-07-14",
    device,
    deviceSn: "SNP",
    recording: record,
    recordingKey: "2026-07-14 09:48:41__clip.h264",
  });

  assert.deepEqual(result, { ok: false, deferred: true, error: "ANALYSIS_PAUSED_FOR_USER_PLAYBACK" });
  assert.deepEqual(calls, []);
  assert.deepEqual(store.state.statusEvents, []);
});

test("FeedAnalysisCoordinator playback deferral does not consume failure retries", async () => {
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    deviceFactory: async () => ({}),
    analyzer: {},
    retryDelayMs: 1,
    maxRetries: 1,
  });
  const requeued = [];
  coordinator.enqueueRecording = (task) => {
    requeued.push(task);
    return { ok: true, queued: true };
  };
  coordinator.pauseDevice("SNP", 60 * 1000);

  await coordinator.processQueueTask({
    force: true,
    date: "2026-07-14",
    deviceSn: "SNP",
    recordingKey: "2026-07-14 09:48:41__clip.h264",
    retryCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].retryCount, 1);
});

test("FeedAnalysisCoordinator globally defers other-device analysis during user replay acquisition", async () => {
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    deviceFactory: async () => ({}),
    analyzer: {},
    retryDelayMs: 0,
    maxRetries: 0,
  });
  coordinator.pauseAll(60 * 1000);

  const result = await coordinator.processQueueTask({
    deviceSn: "OTHER-SN",
    recordingKey: "2026-09-01 12:00:00__clip.h264",
  });

  assert.deepEqual(result, {
    ok: false,
    deferred: true,
    error: "ANALYSIS_PAUSED_FOR_USER_PLAYBACK",
  });
});

test("FeedAnalysisCoordinator bootstraps config and analyzes only new recordings", async () => {
  const calls = [];
  let motionConfig = { "Detect.MotionDetect": [{ Enable: false }] };
  const analyzerPayloads = [];
  const store = makeStore();
  store.setBowlRoi("SN001", { x: 120, y: 240, width: 200, height: 160 });
  const device = {
    async getConfig(name) {
      calls.push(["getConfig", name]);
      if (name === "Detect.MotionDetect") {
        return motionConfig;
      }
      return { Record: [{ PacketLength: 120 }] };
    },
    async setConfig(payload) {
      calls.push(["setConfig", payload.Name]);
      if (payload.Name === "Detect.MotionDetect") motionConfig = payload;
      return { Ret: 100 };
    },
    async queryRecordings(query) {
      calls.push(["queryRecordings", query]);
      return [
        {
          BeginTime: "2026-07-04 12:00:00",
          EndTime: "2026-07-04 12:00:30",
          FileName: "clip-a.mp4",
        },
      ];
    },
    async getPlaybackUrl(record, options) {
      calls.push(["getPlaybackUrl", record.FileName, options]);
      return "https://example.test/clip-a.m3u8";
    },
  };
  const analyzer = {
    async analyzeRecording(payload) {
      analyzerPayloads.push(payload);
      calls.push(["analyzeRecording"]);
      return {
        hasCat: true,
        hasFeeding: true,
        analysisConfidence: 0.93,
        bowlRoi: { x: 1, y: 2, width: 3, height: 4 },
        markers: [
          {
            markerType: "feeding_start",
            target: "cat",
            offsetSec: 8,
            offsetMs: 8000,
            markerTsMs: new Date("2026-07-04 12:00:08").getTime(),
            beginTime: "2026-07-04 12:00:08",
            endTime: "2026-07-04 12:00:30",
          },
        ],
      };
    },
  };

  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
    detectionTarget: "face",
    detectorBackend: "auto",
    orientation: "clockwise-90",
  });

  await coordinator.syncNow({ force: true, date: "2026-07-04" });
  await coordinator.syncNow({ force: true, date: "2026-07-04" });

  assert.equal(store.state.settings.officialConfigStatus, "ready");
  assert.equal(store.state.upserts.length, 1);
  assert.deepEqual(calls.find((call) => call[0] === "queryRecordings")[1], {
    beginTime: "2026-07-04 00:00:00",
    endTime: "2026-07-04 23:59:59",
  });
  assert.equal(analyzerPayloads[0].sourceUrl, "https://example.test/clip-a.m3u8");
  assert.equal(analyzerPayloads[0].recordingKey, "2026-07-04 12:00:00__clip-a.mp4");
  assert.equal(analyzerPayloads[0].beginTime, "2026-07-04 12:00:00");
  assert.equal(analyzerPayloads[0].detectionTarget, "face");
  assert.equal(analyzerPayloads[0].detectorBackend, "auto");
  assert.equal(analyzerPayloads[0].orientation, "clockwise-90");
  assert.deepEqual(analyzerPayloads[0].bowlRoi, { x: 120, y: 240, width: 200, height: 160 });
  assert.equal(store.state.settings.bowlRoi, null);
  assert.deepEqual(calls.find((call) => call[0] === "getPlaybackUrl")[2], {
    channel: 0,
    streamType: 1,
    speed: 8,
    startTime: "2026-07-04 12:00:00",
    endTime: "2026-07-04 12:00:30",
    fileName: "clip-a.mp4",
    mediaType: "hls",
    protocol: "hls",
    retryOccupied: false,
  });
  assert.equal(analyzerPayloads[0].durationSec, 30);
  assert.equal(store.state.upserts[0].clip.feedingStats.source.orientation, "clockwise-90");
  assert.equal(store.state.upserts[0].clip.feedingStats.summary.mealCount, 0);
  assert.equal(
    store.state.upserts[0].clip.markers.some((item) => item.markerType === "feeding_start"),
    false
  );
  assert.deepEqual(
    calls.map((item) => item[0]),
    [
      "getConfig",
      "getConfig",
      "setConfig",
      "getConfig",
      "setConfig",
      "queryRecordings",
      "getPlaybackUrl",
      "analyzeRecording",
      "queryRecordings",
    ]
  );
});

test("FeedAnalysisCoordinator lowers playback speed while keeping direct hls", async () => {
  const calls = [];
  const analyzerPayloads = [];
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const device = {
    async queryRecordings(query) {
      calls.push(["queryRecordings", query]);
      return [
        {
          BeginTime: "2026-07-04 12:00:00",
          EndTime: "2026-07-04 12:00:30",
          FileName: "clip-a.mp4",
        },
      ];
    },
    async getPlaybackUrl(record, options) {
      calls.push(["getPlaybackUrl", record.FileName, options]);
      if (options.speed === 8) throw new Error("Speed not supported");
      return "https://example.test/direct-playback.m3u8";
    },
  };
  const analyzer = {
    async analyzeRecording(payload) {
      analyzerPayloads.push(payload);
      calls.push(["analyzeRecording"]);
      return {
        hasCat: true,
        hasFeeding: false,
        analysisConfidence: 0.8,
        markers: [
          {
            markerType: "face_enter",
            target: "face",
            offsetSec: 4,
            offsetMs: 4000,
            markerTsMs: new Date("2026-07-04 12:00:04").getTime(),
            beginTime: "2026-07-04 12:00:04",
            endTime: "2026-07-04 12:00:30",
          },
        ],
      };
    },
  };

  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
    detectionTarget: "face",
  });

  await coordinator.syncNow({ force: true, date: "2026-07-04" });

  const playbackCalls = calls.filter((item) => item[0] === "getPlaybackUrl");
  assert.equal(playbackCalls.length, 2);
  assert.equal(playbackCalls[0][2].mediaType, "hls");
  assert.equal(playbackCalls[0][2].protocol, "hls");
  assert.equal(playbackCalls[0][2].speed, 8);
  assert.equal(playbackCalls[1][2].mediaType, "hls");
  assert.equal(playbackCalls[1][2].protocol, "hls");
  assert.equal(playbackCalls[1][2].speed, 4);
  assert.equal(analyzerPayloads[0].sourceUrl, "https://example.test/direct-playback.m3u8");
  assert.equal(store.state.upserts[0].clip.markers[0].markerType, "face_enter");
});

test("FeedAnalysisCoordinator releases and reacquires a stale occupied playback channel", async () => {
  const calls = [];
  let attempts = 0;
  const device = {
    async sleepImpl(ms) {
      calls.push(["settle", ms]);
    },
    async getPlaybackUrl(_recording, options) {
      attempts += 1;
      calls.push(["playback", options.speed, options.streamType]);
      if (attempts === 1) {
        throw new Error("playback url failed: code -514053 playback channel occupied");
      }
      return "https://example.test/recovered.m3u8";
    },
    async closeLivestream(channel, streamType) {
      calls.push(["close", channel, streamType]);
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    detectionTarget: "face",
    analyzer: {
      async analyzeRecording(payload) {
        calls.push(["analyze", payload.sourceUrl]);
        return { target: "face", frames: [], markers: [], error: "" };
      },
    },
  });

  await coordinator.analyzeRecording({
    device,
    recording: {
      BeginTime: "2026-08-22 08:00:00",
      EndTime: "2026-08-22 08:01:00",
      FileName: "clip.h264",
    },
    recordingKey: "occupied-channel",
    deviceSn: "SN001",
  });

  assert.deepEqual(calls, [
    ["playback", 8, 1],
    ["close", 0, 1],
    ["settle", 3000],
    ["playback", 8, 1],
    ["analyze", "https://example.test/recovered.m3u8"],
    ["close", 0, 1],
  ]);
});

test("FeedAnalysisCoordinator does not lower playback speed for a repeated occupied channel", async () => {
  const calls = [];
  const device = {
    async sleepImpl(ms) { calls.push(["settle", ms]); },
    async getPlaybackUrl(_recording, options) {
      calls.push(["playback", options.speed, options.retryOccupied]);
      throw new Error("playback url failed: code -514053 playback channel occupied");
    },
    async closeLivestream(channel, streamType) {
      calls.push(["close", channel, streamType]);
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    detectionTarget: "face",
    analyzer: { async analyzeRecording() { throw new Error("must not analyze"); } },
  });

  await assert.rejects(
    () => coordinator.analyzeRecording({
      device,
      recording: {
        BeginTime: "2026-08-22 08:00:00",
        EndTime: "2026-08-22 08:01:00",
        FileName: "clip.h264",
      },
      recordingKey: "occupied-twice",
      deviceSn: "SN001",
    }),
    /-514053/
  );
  assert.deepEqual(calls, [
    ["playback", 8, false],
    ["close", 0, 1],
    ["settle", 3000],
    ["playback", 8, false],
  ]);
});

test("FeedAnalysisCoordinator does not lower playback speed for unrelated source errors", async () => {
  const speeds = [];
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    detectionTarget: "face",
    analyzer: { async analyzeRecording() { throw new Error("must not analyze"); } },
  });
  await assert.rejects(
    () => coordinator.analyzeRecording({
      device: {
        async getPlaybackUrl(_recording, options) {
          speeds.push(options.speed);
          throw new Error("upstream connection reset");
        },
      },
      recording: {
        BeginTime: "2026-08-22 08:00:00",
        EndTime: "2026-08-22 08:01:00",
        FileName: "clip.h264",
      },
      recordingKey: "network-error",
      deviceSn: "SN001",
    }),
    /connection reset/
  );
  assert.deepEqual(speeds, [8]);
});

test("FeedAnalysisCoordinator releases the vendor playback channel after analysis", async () => {
  const releases = [];
  const sourceReleases = [];
  const device = {
    async getPlaybackUrl() {
      return "https://example.test/recording.m3u8";
    },
    async closeLivestream(channel, streamType) {
      releases.push([channel, streamType]);
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    analyzer: {
      async analyzeRecording() {
        return { target: "cat", markers: [], frames: [], error: "" };
      },
    },
    resolveAnalysisSourceUrl: async ({ sourceUrl }) => ({
      sourceUrl,
      release: async () => sourceReleases.push("released"),
    }),
  });

  await coordinator.analyzeRecording({
    device,
    recording: {
      BeginTime: "2026-07-04 12:00:00",
      EndTime: "2026-07-04 12:02:00",
      FileName: "clip.mp4",
    },
    recordingKey: "release-channel",
    deviceSn: "SN001",
  });

  assert.deepEqual(releases, [[0, 1]]);
  assert.deepEqual(sourceReleases, ["released"]);
});

test("FeedAnalysisCoordinator keeps screening and feeding analysis in one playback session", async () => {
  const calls = [];
  let playbackCount = 0;
  const device = {
    async getPlaybackUrl() {
      playbackCount += 1;
      const sourceUrl = `https://example.test/session-${playbackCount}.m3u8`;
      calls.push(["playback", sourceUrl]);
      return sourceUrl;
    },
    async closeLivestream(channel, streamType) {
      calls.push(["close", channel, streamType]);
    },
  };
  const analyzer = {
    async analyzeRecording(payload) {
      calls.push(["analyze", payload.sourceUrl, payload.sampleSeconds, payload.adaptiveFeeding]);
      return { target: "cat", hasCat: true, framesSampled: 120, durationMs: 500, frames: [], error: "" };
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    analyzer,
    detectionTarget: "cat",
    screeningSampleSeconds: 2,
  });

  const result = await coordinator.analyzeRecording({
    device,
    recording: {
      BeginTime: "2026-08-22 08:00:00",
      EndTime: "2026-08-22 08:01:00",
      FileName: "clip.h264",
    },
    recordingKey: "same-session-candidate",
    deviceSn: "SN001",
  });

  assert.deepEqual(calls, [
    ["playback", "https://example.test/session-1.m3u8"],
    ["analyze", "https://example.test/session-1.m3u8", 2, true],
    ["close", 0, 1],
  ]);
  assert.deepEqual(result.analysis.screening, {
    hasCat: true,
    framesSampled: 120,
    durationMs: 500,
    sampleSeconds: 2,
    candidateRanges: [],
    error: "",
    sameSession: true,
  });
});

test("FeedAnalysisCoordinator rejects an empty adaptive analysis instead of recording no-cat success", async () => {
  const releases = [];
  const speeds = [];
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    detectionTarget: "cat",
    analyzer: {
      async analyzeRecording() {
        return { target: "cat", hasCat: false, framesSampled: 0, frames: [], error: "VIDEO_READ_FAILED" };
      },
    },
  });
  const device = {
    async getPlaybackUrl(_recording, options) {
      speeds.push(options.speed);
      return "https://example.test/empty-session.m3u8";
    },
    async closeLivestream(channel, streamType) {
      releases.push([channel, streamType]);
    },
  };

  await assert.rejects(
    coordinator.analyzeRecording({
      device,
      recording: {
        BeginTime: "2026-08-22 08:00:00",
        EndTime: "2026-08-22 08:30:00",
        FileName: "hour.h264",
      },
      recordingKey: "empty-screen",
      deviceSn: "SN001",
    }),
    /VISION_ANALYSIS_FAILED: VIDEO_READ_FAILED/
  );
  assert.deepEqual(speeds, [8, 4, 2, 1]);
  assert.deepEqual(releases, [[0, 1], [0, 1], [0, 1], [0, 1]]);
});

test("FeedAnalysisCoordinator retries an unreadable hls source at a slower playback speed", async () => {
  const calls = [];
  let analysisAttempt = 0;
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    detectionTarget: "cat",
    analyzer: {
      async analyzeRecording(payload) {
        analysisAttempt += 1;
        calls.push(["analyze", payload.sourceUrl]);
        if (analysisAttempt === 1) {
          return { target: "cat", frames: [], error: "VIDEO_READ_FAILED" };
        }
        return { target: "cat", hasCat: true, frames: [], markers: [], error: "" };
      },
    },
  });
  const device = {
    async getPlaybackUrl(_recording, options) {
      calls.push(["playback", options.speed]);
      return `https://example.test/replay-${options.speed}.m3u8`;
    },
    async closeLivestream(channel, streamType) {
      calls.push(["close", channel, streamType]);
    },
  };

  const result = await coordinator.analyzeRecording({
    device,
    recording: {
      BeginTime: "2026-08-22 08:00:00",
      EndTime: "2026-08-22 08:30:00",
      FileName: "hour.h264",
    },
    recordingKey: "fallback-on-read",
    deviceSn: "SN001",
  });

  assert.equal(result.analysis.hasCat, true);
  assert.deepEqual(calls, [
    ["playback", 8],
    ["analyze", "https://example.test/replay-8.m3u8"],
    ["close", 0, 1],
    ["playback", 4],
    ["analyze", "https://example.test/replay-4.m3u8"],
    ["close", 0, 1],
  ]);
});

test("FeedAnalysisCoordinator stops slower playback retries when user playback pauses the device", async () => {
  const calls = [];
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    detectionTarget: "cat",
    analyzer: {
      async analyzeRecording(payload) {
        calls.push(["analyze", payload.sourceUrl]);
        coordinator.pauseDevice("SN001", 60 * 1000);
        return { target: "cat", frames: [], error: "VIDEO_READ_FAILED" };
      },
    },
  });
  const device = {
    async getPlaybackUrl(_recording, options) {
      calls.push(["playback", options.speed]);
      return `https://example.test/replay-${options.speed}.m3u8`;
    },
    async closeLivestream(channel, streamType) {
      calls.push(["close", channel, streamType]);
    },
  };

  await assert.rejects(
    coordinator.analyzeRecording({
      device,
      recording: {
        BeginTime: "2026-08-22 08:00:00",
        EndTime: "2026-08-22 08:30:00",
        FileName: "hour.h264",
      },
      recordingKey: "preempt-after-read-failure",
      deviceSn: "SN001",
    }),
    { code: "ANALYSIS_PAUSED_FOR_USER_PLAYBACK" }
  );
  assert.deepEqual(calls, [
    ["playback", 8],
    ["analyze", "https://example.test/replay-8.m3u8"],
    ["close", 0, 1],
  ]);
});

test("FeedAnalysisCoordinator analyzes candidate discovery and feeding evidence in one session", async () => {
  const playbackRequests = [];
  const detailedPayloads = [];
  const device = {
    async getPlaybackUrl(recording, options) {
      playbackRequests.push({
        beginTime: recording.BeginTime,
        endTime: recording.EndTime,
        startTime: options.startTime,
        finishTime: options.endTime,
      });
      return `https://example.test/session-${playbackRequests.length}.m3u8`;
    },
    async closeLivestream() {},
  };
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    deviceFactory: async () => device,
    detectionTarget: "cat",
    screeningSampleSeconds: 2,
    analyzer: {
      async analyzeRecording(payload) {
        detailedPayloads.push(payload);
        return {
          target: "cat",
          hasCat: true,
          hasFeeding: false,
          framesSampled: 900,
          durationMs: 50,
          frames: [
            { offsetSec: 100, second: 100, hasCat: true, nearBowl: false, eatingVerified: false, confidence: 0.8 },
            { offsetSec: 102, second: 102, hasCat: true, nearBowl: false, eatingVerified: false, confidence: 0.8 },
            { offsetSec: 900, second: 900, hasCat: true, nearBowl: false, eatingVerified: false, confidence: 0.8 },
            { offsetSec: 902, second: 902, hasCat: true, nearBowl: false, eatingVerified: false, confidence: 0.8 },
          ],
          markers: [],
          error: "",
        };
      },
    },
  });

  const result = await coordinator.analyzeRecording({
    device,
    recording: {
      BeginTime: "2026-08-22 10:00:00",
      EndTime: "2026-08-22 10:30:00",
      FileName: "half-hour.h264",
    },
    recordingKey: "candidate-only-detail",
    deviceSn: "SN001",
  });

  assert.deepEqual(playbackRequests, [
    {
      beginTime: "2026-08-22 10:00:00",
      endTime: "2026-08-22 10:30:00",
      startTime: "2026-08-22 10:00:00",
      finishTime: "2026-08-22 10:30:00",
    },
  ]);
  assert.deepEqual(
    detailedPayloads.map((payload) => ({
      beginTime: payload.beginTime,
      durationSec: payload.durationSec,
    })),
    [{ beginTime: "2026-08-22 10:00:00", durationSec: 1800 }]
  );
  assert.equal(detailedPayloads[0].adaptiveFeeding, true);
  assert.equal(detailedPayloads[0].sampleSeconds, 2);
  assert.deepEqual(
    result.analysis.frames.map((frame) => frame.offsetSec),
    [100, 102, 900, 902]
  );
  assert.deepEqual(result.analysis.screening.candidateRanges, [
    { startSec: 92, endSec: 116, durationSec: 24 },
    { startSec: 892, endSec: 916, durationSec: 24 },
  ]);
});

test("FeedAnalysisCoordinator records no-cat from the same adaptive analysis session", async () => {
  let detailedCalls = 0;
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    detectionTarget: "cat",
    analyzer: {
      async analyzeRecording(payload) {
        detailedCalls += 1;
        assert.equal(payload.adaptiveFeeding, true);
        return {
          target: "cat",
          hasCat: false,
          framesSampled: 30,
          durationMs: 80,
          frames: [
            { second: 0, offsetSec: 0, hasCat: false, nearBowl: false, eatingVerified: false },
          ],
          error: "",
        };
      },
    },
  });

  const result = await coordinator.analyzeRecording({
    device: { async getPlaybackUrl() { return "https://example.test/no-cat.m3u8"; } },
    recording: {
      BeginTime: "2026-08-22 09:00:00",
      EndTime: "2026-08-22 09:01:00",
      FileName: "no-cat.h264",
    },
    recordingKey: "same-session-no-cat",
    deviceSn: "SN001",
  });

  assert.equal(detailedCalls, 1);
  assert.equal(result.analysis.screening.sameSession, true);
  assert.equal(result.analysis.feedingStats.summary.mealCount, 0);
});

test("FeedAnalysisCoordinator processes only the uncovered alarm tail and advances its watermark", async () => {
  const store = makeStore();
  const analyzedThroughMs = new Date("2026-08-28 12:00:00").getTime();
  const pendingThroughMs = new Date("2026-08-28 12:10:00").getTime();
  store.updateSettings({
    feedingAnalyzedThroughMs: analyzedThroughMs,
    feedingPendingFromMs: new Date("2026-08-28 11:40:00").getTime(),
    feedingPendingThroughMs: pendingThroughMs,
  }, "SN001");
  const queries = [];
  const analyzed = [];
  const device = {
    sn: "SN001",
    async status() { return { status: "online" }; },
    async login() {},
    async queryRecordings(query) {
      queries.push(query);
      return [{
        BeginTime: "2026-08-28 11:30:00",
        EndTime: "2026-08-28 12:30:00",
        FileName: "hour.h264",
      }];
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: {},
  });
  coordinator.analyzeRecording = async ({ recording, recordingKey }) => {
    analyzed.push({ recording, recordingKey });
    return {
      clipDate: "2026-08-28",
      analysis: { hasCat: false },
      clip: {
        id: recordingKey,
        recordingKey,
        beginTime: recording.BeginTime,
        endTime: recording.EndTime,
        hasCat: false,
        hasFeeding: false,
        markers: [],
      },
    };
  };

  const result = await coordinator.processAlarmWindowTask({
    device,
    deviceSn: "SN001",
    alarmWindow: { endMs: pendingThroughMs },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(queries, [{
    beginTime: "2026-08-28 11:59:15",
    endTime: "2026-08-28 12:10:00",
  }]);
  assert.equal(analyzed.length, 1);
  assert.equal(analyzed[0].recording.BeginTime, "2026-08-28 11:59:27");
  assert.equal(analyzed[0].recording.EndTime, "2026-08-28 12:10:00");
  assert.deepEqual(analyzed[0].recording.analysisTargetWindow, {
    beginTime: "2026-08-28 11:59:30",
    endTime: "2026-08-28 12:10:00",
  });
  assert.equal(store.getSettings("SN001").feedingAnalyzedThroughMs, pendingThroughMs);
  assert.equal(store.getSettings("SN001").feedingPendingThroughMs, 0);
});

test("FeedAnalysisCoordinator retries an alarm window without advancing when replay is not ready", async () => {
  const store = makeStore();
  const pendingThroughMs = new Date("2026-08-28 12:10:00").getTime();
  store.updateSettings({
    feedingPendingFromMs: new Date("2026-08-28 11:40:00").getTime(),
    feedingPendingThroughMs: pendingThroughMs,
  }, "SN001");
  const scheduled = [];
  const device = {
    sn: "SN001",
    async status() { return { status: "online" }; },
    async login() {},
    async queryRecordings() { return []; },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: {},
  });
  coordinator.scheduleRecordingRetry = (task) => scheduled.push(task);
  const task = {
    device,
    deviceSn: "SN001",
    alarmWindow: {
      startMs: new Date("2026-08-28 11:40:00").getTime(),
      endMs: pendingThroughMs,
    },
  };

  const result = await coordinator.processAlarmWindowTask(task);

  assert.deepEqual(result, {
    ok: false,
    deferred: true,
    retry: true,
    error: "ALARM_REPLAY_NOT_READY",
  });
  assert.deepEqual(scheduled, [task]);
  assert.equal(Number(store.getSettings("SN001").feedingAnalyzedThroughMs) || 0, 0);
  assert.equal(store.getSettings("SN001").feedingPendingThroughMs, pendingThroughMs);
});

test("FeedAnalysisCoordinator starts one padded replay session instead of probing repeatedly", async () => {
  const store = makeStore();
  const startMs = Date.parse("2026-08-22T08:00:00+08:00");
  const endMs = Date.parse("2026-08-22T08:30:00+08:00");
  const attempts = [];
  const device = {
    sn: "SN001",
    async status() { return { status: "online" }; },
    async login() {},
    async queryRecordings() {
      return [{
        BeginTime: "2026-08-22 08:00:00",
        EndTime: "2026-08-22 08:30:00",
        FileName: "hour.h264",
      }];
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: {},
  });
  coordinator.analyzeRecording = async ({ recording, recordingKey }) => {
    attempts.push(recording.BeginTime);
    return {
      clipDate: "2026-08-22",
      analysis: { hasCat: true },
      clip: {
        id: recordingKey,
        recordingKey,
        beginTime: recording.BeginTime,
        endTime: recording.EndTime,
        hasCat: true,
        hasFeeding: false,
        markers: [],
      },
    };
  };

  const result = await coordinator.processAlarmWindowTask({
    device,
    deviceSn: "SN001",
    alarmWindow: { startMs, endMs },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(attempts, ["2026-08-22 08:00:12"]);
  assert.equal(store.hasProcessed(
    "feeding-window:2026-08-22 08:00:00__2026-08-22 08:30:00",
    "SN001"
  ), true);
  assert.equal(store.getSettings("SN001").feedingAnalyzedThroughMs, endMs);
});

test("FeedAnalysisCoordinator retries the task without opening a second replay after a zero-frame read", async () => {
  const store = makeStore();
  const startMs = Date.parse("2026-08-22T08:00:00+08:00");
  const endMs = Date.parse("2026-08-22T08:30:00+08:00");
  const attempts = [];
  const device = {
    sn: "SN001",
    async status() { return { status: "online" }; },
    async login() {},
    async queryRecordings() {
      return [{
        BeginTime: "2026-08-22 08:00:00",
        EndTime: "2026-08-22 08:30:00",
        FileName: "hour.h264",
      }];
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: {},
    nowProvider: () => new Date(endMs + 60 * 60 * 1000),
  });
  coordinator.analyzeRecording = async ({ recording, recordingKey }) => {
    attempts.push(recording.BeginTime);
    throw new Error("VISION_ANALYSIS_FAILED: VIDEO_READ_FAILED");
  };
  const scheduled = [];
  coordinator.scheduleRecordingRetry = (task) => scheduled.push(task);
  const task = {
    device,
    deviceSn: "SN001",
    alarmWindow: { startMs, endMs },
  };

  const result = await coordinator.processAlarmWindowTask(task);

  assert.equal(result.ok, false);
  assert.equal(result.retry, true);
  assert.deepEqual(attempts, ["2026-08-22 08:00:12"]);
  assert.deepEqual(scheduled, [task]);
  assert.equal(Number(store.getSettings("SN001").feedingAnalyzedThroughMs) || 0, 0);
});

test("FeedAnalysisCoordinator abandons a stale alarm window on its first replay failure", async () => {
  const store = makeStore();
  const startMs = Date.parse("2026-08-31T15:05:47+08:00");
  const endMs = Date.parse("2026-08-31T15:35:47+08:00");
  const device = {
    sn: "SN001",
    async status() { return { status: "online" }; },
    async login() {},
    async queryRecordings() {
      return [{
        BeginTime: "2026-08-31 15:11:06",
        EndTime: "2026-08-31 15:11:19",
        FileName: "stale.h264",
      }];
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: {},
    nowProvider: () => new Date("2026-09-02T03:00:00+08:00"),
    retryDelayMs: 1,
    maxRetries: 1,
  });
  coordinator.analyzeRecording = async () => {
    throw new Error("VISION_ANALYSIS_FAILED: VIDEO_READ_FAILED");
  };
  const scheduled = [];
  coordinator.scheduleRecordingRetry = (task) => scheduled.push(task);

  const result = await coordinator.processAlarmWindowTask({
    device,
    deviceSn: "SN001",
    alarmWindow: { startMs, endMs },
    retryCount: 0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.abandoned, true);
  assert.equal(result.retry, false);
  assert.deepEqual(scheduled, []);
  assert.equal(store.getSettings("SN001").feedingAnalyzedThroughMs, endMs);
  assert.equal(store.getSettings("SN001").feedingPendingFromMs, 0);
  assert.equal(store.getSettings("SN001").feedingPendingThroughMs, 0);
});

test("FeedAnalysisCoordinator waits for a running queue task to finish before scheduling its retry", async () => {
  const store = makeStore();
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => ({ sn: "SN001" }),
    analyzer: {},
    retryDelayMs: 5,
    maxRetries: 1,
  });
  const attempts = [];
  coordinator.processQueueTask = async (task) => {
    attempts.push(Number(task.retryCount) || 0);
    coordinator.scheduleRecordingRetry(task);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { ok: false, error: "TEST_RETRY" };
  };

  coordinator.enqueueAlarmWindow({
    deviceSn: "SN001",
    window: {
      startMs: Date.parse("2026-09-01T10:00:00+08:00"),
      endMs: Date.parse("2026-09-01T10:30:00+08:00"),
      beginTime: "2026-09-01 10:00:00",
      endTime: "2026-09-01 10:30:00",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(attempts, [0]);
  await new Promise((resolve) => setTimeout(resolve, 55));
  await coordinator.queue.onIdle();
  assert.deepEqual(attempts, [0, 1]);
});

test("FeedAnalysisCoordinator uses the fixed bottom bowl region only when no calibrated ROI exists", async () => {
  const store = makeStore();
  const analyzerPayloads = [];
  const device = {
    async getPlaybackUrl() {
      return "https://example.test/recording.m3u8";
    },
  };
  const analyzer = {
    async analyzeRecording(payload) {
      analyzerPayloads.push(payload);
      return {
        target: "cat",
        hasCat: false,
        hasFeeding: false,
        analysisConfidence: 0,
        bowlRoi: payload.bowlRoi,
        markers: [],
        cuteTimeline: [],
        error: "",
      };
    },
  };
  const coordinator = new FeedAnalysisCoordinator({ store, analyzer });
  const recording = {
    BeginTime: "2026-07-04 12:00:00",
    EndTime: "2026-07-04 12:01:00",
    FileName: "clip.mp4",
  };

  await coordinator.analyzeRecording({
    device,
    recording,
    recordingKey: "without-roi",
    deviceSn: "SN001",
  });
  store.setBowlRoi("SN001", { x: 1, y: 2, width: 3, height: 4 });
  await coordinator.analyzeRecording({
    device,
    recording,
    recordingKey: "with-roi",
    deviceSn: "SN001",
  });

  assert.equal(analyzerPayloads[0].bowlRoi, null);
  assert.equal(analyzerPayloads[0].autoBowlDetection, false);
  assert.equal(analyzerPayloads[0].fixedBottomBowlRegion, true);
  assert.deepEqual(analyzerPayloads[1].bowlRoi, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(analyzerPayloads[1].autoBowlDetection, false);
  assert.equal(analyzerPayloads[1].fixedBottomBowlRegion, false);
});

test("FeedAnalysisCoordinator rejects an RTSP response instead of silently transcoding it", async () => {
  const calls = [];
  const analyzerPayloads = [];
  const resolverPayloads = [];
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const record = {
    BeginTime: "2026-07-14 09:48:41",
    EndTime: "2026-07-14 09:48:53",
    FileName: "/idea0/2026-07-14/001/09.48.41-09.48.53[M][@1757][0].h264",
  };
  const device = {
    async queryRecordings() {
      return [record];
    },
    async getPlaybackUrl() {
      return "rtsp://camera.example.test/replay.sdp";
    },
  };
  const analyzer = {
    async analyzeRecording(payload) {
      analyzerPayloads.push(payload);
      calls.push(["analyzeRecording", payload.sourceUrl]);
      return {
        hasCat: true,
        analysisConfidence: 0.9,
        markers: [{ markerType: "face_enter", target: "face", offsetSec: 0 }],
      };
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
    detectionTarget: "face",
    resolveAnalysisSourceUrl: async (payload) => {
      resolverPayloads.push(payload);
      return "https://localhost:3000/api/replay-hls/session-1/index.m3u8";
    },
  });

  await assert.rejects(
    () => coordinator.syncNow({ force: true, date: "2026-07-14" }),
    /FEED_ANALYSIS_HLS_TRANSPORT_MISMATCH/
  );

  assert.equal(resolverPayloads.length, 0);
  assert.equal(analyzerPayloads.length, 0);
  assert.equal(store.state.upserts.length, 0);
});

test("FeedAnalysisCoordinator marks recordings failed when vision analysis reports an error", async () => {
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const record = {
    BeginTime: "2026-07-14 09:48:41",
    EndTime: "2026-07-14 09:48:53",
    FileName: "clip.h264",
  };
  const device = {
    sn: "SNF",
    async getPlaybackUrl() {
      return "https://example.test/clip.m3u8";
    },
  };
  const analyzer = {
    async analyzeRecording() {
      return { analysisStatus: "failed", error: "DECODE_FAILED", markers: [] };
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
  });

  coordinator.enqueueRecording({
    force: true,
    date: "2026-07-14",
    device,
    deviceSn: "SNF",
    recording: record,
    recordingKey: "2026-07-14 09:48:41__clip.h264",
  });
  await coordinator.queue.onIdle();

  assert.equal(store.state.upserts.length, 0);
  assert.deepEqual(
    store.state.statusEvents.map((item) => item.slice(0, 3)),
    [
      ["running", "SNF", "2026-07-14 09:48:41__clip.h264"],
      ["failed", "SNF", "2026-07-14 09:48:41__clip.h264"],
    ]
  );
});

test("FeedAnalysisCoordinator retries transient analysis aborts instead of treating them as final failures", async () => {
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const record = {
    BeginTime: "2026-07-14 09:48:41",
    EndTime: "2026-07-14 09:48:53",
    FileName: "clip.h264",
  };
  const device = {
    sn: "SNA",
    async getPlaybackUrl() {
      return "https://example.test/clip.m3u8";
    },
  };
  const analyzer = {
    async analyzeRecording() {
      throw new Error("This operation was aborted");
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
    retryDelayMs: 0,
    maxRetries: 0,
  });

  coordinator.enqueueRecording({
    force: true,
    date: "2026-07-14",
    device,
    deviceSn: "SNA",
    recording: record,
    recordingKey: "2026-07-14 09:48:41__clip.h264",
  });
  await coordinator.queue.onIdle();

  assert.deepEqual(
    store.state.statusEvents.map((item) => item.slice(0, 3)),
    [
      ["running", "SNA", "2026-07-14 09:48:41__clip.h264"],
      ["failed", "SNA", "2026-07-14 09:48:41__clip.h264"],
    ]
  );
});

test("FeedAnalysisCoordinator retries replay sources that produced no HLS segments", async () => {
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const record = {
    BeginTime: "2026-07-14 09:48:41",
    EndTime: "2026-07-14 09:48:53",
    FileName: "clip.h264",
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => ({}),
    analyzer: {},
    resolveAnalysisSourceUrl: async () => {
      throw new Error("HLS_TRANSCODE_NOT_READY");
    },
  });
  const scheduled = [];
  coordinator.scheduleRecordingRetry = (task) => scheduled.push(task);

  const result = await coordinator.processRecordingTask({
    force: true,
    date: "2026-07-14",
    device: {
      async getPlaybackUrl() {
        return "https://example.test/clip.m3u8";
      },
    },
    deviceSn: "SNA",
    recording: record,
    recordingKey: "2026-07-14 09:48:41__clip.h264",
  });

  assert.deepEqual(result, {
    ok: false,
    retry: true,
    error: "HLS_TRANSCODE_NOT_READY",
  });
  assert.equal(scheduled.length, 1);
});

test("FeedAnalysisCoordinator queues a device date scan and analyzes discovered recordings in background", async () => {
  const calls = [];
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const records = [
    {
      BeginTime: "2026-07-04 12:00:00",
      EndTime: "2026-07-04 12:00:30",
      FileName: "clip-a.mp4",
    },
    {
      BeginTime: "2026-07-04 12:05:00",
      EndTime: "2026-07-04 12:05:30",
      FileName: "clip-b.mp4",
    },
  ];
  const device = {
    sn: "SNQ",
    async login() {
      calls.push(["login"]);
    },
    async queryRecordings(query) {
      calls.push(["queryRecordings", query]);
      return records;
    },
    async getPlaybackUrl(record) {
      calls.push(["getPlaybackUrl", record.FileName]);
      return `https://example.test/${record.FileName}.m3u8`;
    },
  };
  const analyzer = {
    async analyzeRecording(payload) {
      calls.push(["analyzeRecording", payload.recordingKey, payload.sourceUrl]);
      return {
        hasCat: true,
        hasFeeding: false,
        analysisConfidence: 0.8,
        markers: [
          {
            markerType: "cat_enter",
            target: "cat",
            offsetSec: 4,
            offsetMs: 4000,
            markerTsMs: new Date(payload.recording.BeginTime.replace(" ", "T")).getTime() + 4000,
            beginTime: payload.recording.BeginTime,
            endTime: payload.recording.EndTime,
          },
        ],
      };
    },
  };

  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
    globalConcurrency: 2,
  });

  const queued = coordinator.enqueueDeviceDate({
    force: true,
    date: "2026-07-04",
    device,
    deviceSn: "SNQ",
  });
  await coordinator.queue.onIdle();

  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true);
  assert.equal(queued.jobKey, "SNQ:date:2026-07-04");
  assert.deepEqual(calls[0], ["login"]);
  assert.deepEqual(calls[1], [
    "queryRecordings",
    {
      beginTime: "2026-07-04 00:00:00",
      endTime: "2026-07-04 23:59:59",
    },
  ]);
  assert.deepEqual(
    store.state.statusEvents.map((item) => item.slice(0, 3)),
    [
      ["queued", "SNQ", "2026-07-04 12:00:00__clip-a.mp4"],
      ["queued", "SNQ", "2026-07-04 12:05:00__clip-b.mp4"],
      ["running", "SNQ", "2026-07-04 12:00:00__clip-a.mp4"],
      ["ready", "SNQ", "2026-07-04 12:00:00__clip-a.mp4"],
      ["running", "SNQ", "2026-07-04 12:05:00__clip-b.mp4"],
      ["ready", "SNQ", "2026-07-04 12:05:00__clip-b.mp4"],
    ]
  );
  assert.equal(store.state.upserts.length, 2);
  assert.equal(store.state.upserts[0].deviceSn, "SNQ");
  assert.equal(store.state.upserts[0].clip.markers[0].offsetSec, 4);
});

test("FeedAnalysisCoordinator refreshes an expired device token once before scanning", async () => {
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" }, "SN-REFRESH");
  const calls = [];
  const staleDevice = {
    sn: "SN-REFRESH",
    async login() { calls.push("stale-login"); throw new Error("设备登录失败: token expired"); },
  };
  const freshDevice = {
    sn: "SN-REFRESH",
    async login() { calls.push("fresh-login"); },
    async queryRecordings() { calls.push("query"); return []; },
  };
  const coordinator = new FeedAnalysisCoordinator({ store, deviceFactory: async () => staleDevice, analyzer: {} });
  coordinator.setDeviceProvider({
    async getDevice() { return staleDevice; },
    async refreshDevice(sn) { calls.push(`refresh:${sn}`); return freshDevice; },
  });

  const result = await coordinator.processScanTask({ deviceSn: "SN-REFRESH", date: "2026-07-30" });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["stale-login", "refresh:SN-REFRESH", "fresh-login", "query"]);
});

test("FeedAnalysisCoordinator refreshes an expired device token once before analyzing a recording", async () => {
  const store = makeStore();
  const calls = [];
  const staleDevice = {
    sn: "SN-REFRESH",
    async login() { calls.push("stale-login"); throw new Error("设备登录失败: token expired"); },
  };
  const freshDevice = {
    sn: "SN-REFRESH",
    async login() { calls.push("fresh-login"); },
    async getPlaybackUrl() { calls.push("playback"); return "https://example.test/clip.m3u8"; },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => staleDevice,
    analyzer: { async analyzeRecording() { return { hasCat: true, markers: [] }; } },
  });
  coordinator.setDeviceProvider({
    async getDevice() { return staleDevice; },
    async refreshDevice(sn) { calls.push(`refresh:${sn}`); return freshDevice; },
  });

  const result = await coordinator.processRecordingTask({
    force: true,
    deviceSn: "SN-REFRESH",
    date: "2026-07-30",
    recordingKey: "clip-1",
    recording: { BeginTime: "2026-07-30 10:00:00", EndTime: "2026-07-30 10:00:10" },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["stale-login", "refresh:SN-REFRESH", "fresh-login", "playback"]);
});

test("FeedAnalysisCoordinator skips a scheduled scan while its device is offline", async () => {
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" }, "SN-OFFLINE");
  const calls = [];
  const device = {
    sn: "SN-OFFLINE",
    async status() { calls.push("status"); return { status: "offline" }; },
    async login() { calls.push("login"); },
    async queryRecordings() { calls.push("query"); return []; },
  };
  const coordinator = new FeedAnalysisCoordinator({ store, deviceFactory: async () => device, analyzer: {} });

  const result = await coordinator.processScanTask({ device, deviceSn: "SN-OFFLINE", date: "2026-07-30" });

  assert.deepEqual(result, { ok: true, skipped: true, reason: "DEVICE_OFFLINE" });
  assert.deepEqual(calls, ["status"]);
});

test("FeedAnalysisCoordinator defers queued recordings while their device is offline", async () => {
  const store = makeStore();
  const calls = [];
  const scheduled = [];
  const device = {
    sn: "SN-OFFLINE",
    async status() { calls.push("status"); return { status: "offline" }; },
    async login() { calls.push("login"); },
  };
  const coordinator = new FeedAnalysisCoordinator({ store, deviceFactory: async () => device, analyzer: {} });
  coordinator.scheduleRecordingRetry = (task, options) => scheduled.push({ task, options });
  const task = {
    device,
    deviceSn: "SN-OFFLINE",
    date: "2026-07-30",
    recordingKey: "clip-offline",
    recording: { BeginTime: "2026-07-30 10:00:00", EndTime: "2026-07-30 10:00:10" },
  };

  const result = await coordinator.processRecordingTask(task);

  assert.deepEqual(result, { ok: false, deferred: true, error: "DEVICE_OFFLINE" });
  assert.deepEqual(calls, ["status"]);
  assert.deepEqual(scheduled, [{ task, options: { consumeRetry: false } }]);
  assert.deepEqual(store.state.statusEvents, []);
});

test("FeedAnalysisCoordinator skips a scan when login loses the device after an online status", async () => {
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" }, "SN-RACE");
  const stale = {
    sn: "SN-RACE",
    async status() { return { status: "online" }; },
    async login() { throw new Error("设备登录失败: Device offline"); },
  };
  const refreshed = {
    sn: "SN-RACE",
    async login() { throw new Error("设备登录失败: Device offline"); },
  };
  const coordinator = new FeedAnalysisCoordinator({ store, deviceFactory: async () => stale, analyzer: {} });
  coordinator.setDeviceProvider({
    async getDevice() { return stale; },
    async refreshDevice() { return refreshed; },
  });

  const result = await coordinator.processQueueTask({ deviceSn: "SN-RACE", date: "2026-07-30" });

  assert.deepEqual(result, { ok: true, skipped: true, reason: "DEVICE_UNAVAILABLE" });
});

test("FeedAnalysisCoordinator defers a recording when login loses the device after an online status", async () => {
  const store = makeStore();
  const scheduled = [];
  const stale = {
    sn: "SN-RACE",
    async status() { return { status: "online" }; },
    async login() { throw new Error("设备登录失败: Device offline"); },
  };
  const refreshed = {
    sn: "SN-RACE",
    async login() { throw new Error("设备登录失败: Device offline"); },
  };
  const coordinator = new FeedAnalysisCoordinator({ store, deviceFactory: async () => stale, analyzer: {} });
  coordinator.setDeviceProvider({
    async getDevice() { return stale; },
    async refreshDevice() { return refreshed; },
  });
  coordinator.scheduleRecordingRetry = (task, options) => scheduled.push({ task, options });
  const task = {
    deviceSn: "SN-RACE",
    date: "2026-07-30",
    recordingKey: "clip-race",
    recording: { BeginTime: "2026-07-30 10:00:00", EndTime: "2026-07-30 10:00:10" },
  };

  const result = await coordinator.processQueueTask(task);

  assert.deepEqual(result, { ok: false, deferred: true, error: "DEVICE_UNAVAILABLE" });
  assert.deepEqual(scheduled, [{ task, options: { consumeRetry: false } }]);
  assert.deepEqual(store.state.statusEvents, []);
});

test("FeedAnalysisCoordinator skips a scan when the device provider cannot acquire a token", async () => {
  const store = makeStore();
  const coordinator = new FeedAnalysisCoordinator({ store, deviceFactory: async () => ({}), analyzer: {} });
  coordinator.setDeviceProvider({
    async getDevice() { throw new Error("获取 token 失败: DEV_NOTEXIT"); },
  });

  const result = await coordinator.processQueueTask({ deviceSn: "SN-NO-TOKEN", date: "2026-07-30" });

  assert.deepEqual(result, { ok: true, skipped: true, reason: "DEVICE_UNAVAILABLE" });
});

test("FeedAnalysisCoordinator defers a recording when the device provider cannot acquire a token", async () => {
  const store = makeStore();
  const scheduled = [];
  const coordinator = new FeedAnalysisCoordinator({ store, deviceFactory: async () => ({}), analyzer: {} });
  coordinator.setDeviceProvider({
    async getDevice() { throw new Error("获取 token 失败: DEV_NOTEXIT"); },
  });
  coordinator.scheduleRecordingRetry = (task, options) => scheduled.push({ task, options });
  const task = {
    deviceSn: "SN-NO-TOKEN",
    date: "2026-07-30",
    recordingKey: "clip-no-token",
    recording: { BeginTime: "2026-07-30 10:00:00", EndTime: "2026-07-30 10:00:10" },
  };

  const result = await coordinator.processQueueTask(task);

  assert.deepEqual(result, { ok: false, deferred: true, error: "DEVICE_UNAVAILABLE" });
  assert.deepEqual(scheduled, [{ task, options: { consumeRetry: false } }]);
  assert.deepEqual(store.state.statusEvents, []);
});

test("FeedAnalysisCoordinator force scan reanalyzes an already ready recording", async () => {
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const record = {
    BeginTime: "2026-07-04 12:00:00",
    EndTime: "2026-07-04 12:00:30",
    FileName: "clip-a.mp4",
  };
  store.state.recordings["2026-07-04 12:00:00__clip-a.mp4"] = {
    recordingKey: "2026-07-04 12:00:00__clip-a.mp4",
    clip: { markers: [] },
  };
  let analyzed = 0;
  const device = {
    sn: "SNF",
    async queryRecordings() {
      return [record];
    },
    async getPlaybackUrl() {
      return "https://example.test/clip-a.m3u8";
    },
  };
  const analyzer = {
    async analyzeRecording() {
      analyzed += 1;
      return {
        hasCat: true,
        markers: [{ markerType: "face_enter", target: "face", offsetSec: 3 }],
      };
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
    alarmAdapter: false,
  });

  coordinator.enqueueDeviceDate({
    force: true,
    date: "2026-07-04",
    device,
    deviceSn: "SNF",
  });
  await coordinator.queue.onIdle();

  assert.equal(analyzed, 1);
  assert.equal(store.state.upserts.length, 1);
  assert.equal(store.state.upserts[0].clip.markers[0].markerType, "face_enter");
});

test("FeedAnalysisCoordinator force queue scan includes the full date when official alarms are empty", async () => {
  const calls = [];
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const record = {
    BeginTime: "2026-07-04 12:00:00",
    EndTime: "2026-07-04 12:00:30",
    FileName: "clip-a.mp4",
  };
  const device = {
    sn: "SNF",
    async queryAlarmMessages() {
      calls.push("queryAlarmMessages");
      return [];
    },
    async queryRecordings(query) {
      calls.push(["queryRecordings", query]);
      return [record];
    },
    async getPlaybackUrl() {
      return "https://example.test/clip-a.m3u8";
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: {
      async analyzeRecording() {
        calls.push("analyzeRecording");
        return { hasCat: true, markers: [] };
      },
    },
    alarmAdapter: false,
  });

  coordinator.enqueueDeviceDate({
    force: true,
    date: "2026-07-04",
    device,
    deviceSn: "SNF",
  });
  await coordinator.queue.onIdle();

  assert.deepEqual(calls.slice(0, 2), [
    "queryAlarmMessages",
    [
      "queryRecordings",
      {
        beginTime: "2026-07-04 00:00:00",
        endTime: "2026-07-04 23:59:59",
      },
    ],
  ]);
  assert.ok(calls.includes("analyzeRecording"));
  assert.equal(store.state.upserts.length, 1);
});

test("FeedAnalysisCoordinator uses official live-object alarms to choose replay windows", async () => {
  const calls = [];
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const device = {
    async queryAlarmMessages(payload) {
      calls.push(["queryAlarmMessages", payload]);
      return [
        {
          AlarmID: "alarm-1",
          AlarmType: "HumanDetect",
          AlarmTime: "2026-07-04 12:00:08",
          Message: "活物报警",
        },
      ];
    },
    async queryRecordings(payload) {
      calls.push(["queryRecordings", payload]);
      return [
        {
          BeginTime: "2026-07-04 12:00:00",
          EndTime: "2026-07-04 12:00:30",
          FileName: "clip-alarm.mp4",
        },
      ];
    },
    async getPlaybackUrl(record) {
      calls.push(["getPlaybackUrl", record.FileName]);
      return "https://example.test/clip-alarm.m3u8";
    },
  };
  const analyzer = {
    async analyzeRecording() {
      calls.push(["analyzeRecording"]);
      return {
        hasCat: true,
        hasFeeding: true,
        analysisConfidence: 0.93,
        markers: [
          {
            eventId: "feeding_1",
            markerType: "feeding_start",
            markerTsMs: new Date("2026-07-04 12:00:10").getTime(),
            beginTime: "2026-07-04 12:00:10",
            endTime: "2026-07-04 12:00:30",
          },
        ],
      };
    },
  };

  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
    nowProvider: () => new Date("2026-07-04 12:10:00"),
  });

  const result = await coordinator.syncNow({ force: true });

  assert.equal(result.processed, 1);
  assert.equal(calls[0][0], "queryAlarmMessages");
  assert.equal(calls[1][0], "queryRecordings");
  assert.equal(calls[1][1].beginTime, "2026-07-04 11:59:08");
  assert.equal(calls[1][1].endTime, "2026-07-04 12:02:08");
  assert.equal(store.state.upserts[0].clip.hasCat, true);
  assert.equal(store.state.settings.lastOfficialAlarmAt, new Date("2026-07-04 12:00:08").getTime());
});

test("FeedAnalysisCoordinator falls back to incremental OPLogQuery alarms when the cloud alarm list is empty", async () => {
  const store = makeStore();
  store.updateSettings({
    analysisEnabled: true,
    lastDeviceLogPosition: 1103,
  }, "SN001");
  const opdevCalls = [];
  const persisted = [];
  const device = {
    sn: "SN001",
    async queryAlarmMessages() { return []; },
    async opdev(payload) {
      opdevCalls.push(payload);
      if (payload.Name === "OPTimeQuery") {
        return { Ret: 100, OPTimeQuery: "2026-09-01 10:03:00" };
      }
      return {
        Ret: 100,
        OPLogQuery: [
          { Position: 1103, Time: "2026-09-01 10:01:00", Type: "EventStart", Data: "HumanDetect,1" },
          { Position: 1104, Time: "2026-09-01 10:02:00", Type: "EventStart", Data: "HumanDetect,1" },
        ],
      };
    },
  };
  const coordinator = new FeedAnalysisCoordinator({ store, alarmAdapter: false });
  coordinator.setMotionAlarmSink(async (sn, alarms) => persisted.push([sn, alarms]));
  coordinator.registerFeedingStartAlarms = async ({ alarms }) => ({
    queued: true,
    settings: { ...store.getSettings("SN001"), feedingStartLastAlarmAtMs: alarms.at(-1).occurredAtMs },
  });

  const result = await coordinator.collectOfficialAlarmCandidates(
    device,
    new Date("2026-09-01T02:03:00.000Z")
  );

  assert.equal(result.available, true);
  assert.deepEqual(result.alarms.map((alarm) => alarm.id), ["device-log-1104"]);
  assert.equal(store.getSettings("SN001").lastDeviceLogPosition, 1104);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0][0], "SN001");
  assert.deepEqual(opdevCalls.map((call) => call.Name), ["OPTimeQuery", "OPLogQuery"]);
});

test("FeedAnalysisCoordinator hydrates callback alarm pictures without delaying alarm ingestion", async () => {
  const store = makeStore();
  const persisted = [];
  let resolveHydrated;
  const hydrated = new Promise((resolve) => { resolveHydrated = resolve; });
  const device = {
    sn: "SN001",
    async getAlarmPicUrl(alarm) {
      return `https://example.test/${alarm.id}.jpg`;
    },
  };
  const coordinator = new FeedAnalysisCoordinator({ store, alarmAdapter: false });
  coordinator.setDeviceProvider({ async getDevice() { return device; } });
  coordinator.setMotionAlarmSink(async (sn, alarms) => {
    persisted.push([sn, alarms]);
    if (alarms.some((alarm) => alarm.snapshotUrl)) resolveHydrated();
  });
  coordinator.registerFeedingStartAlarms = async () => ({ queued: true });

  const result = await coordinator.ingestOfficialAlarmCallback({
    deviceSn: "SN001",
    rawAlarms: [{
      AlarmID: "motion-1",
      AlarmType: "MotionDetect",
      AlarmTime: "2026-09-01 10:02:00",
    }],
  });

  assert.equal(result.queued, true);
  assert.equal(persisted[0][1][0].snapshotUrl, "");
  await hydrated;
  assert.equal(persisted.length, 2);
  assert.equal(persisted[1][1][0].snapshotUrl, "https://example.test/motion-1.jpg");
});

test("FeedAnalysisCoordinator queues one rolling 30-minute window for scheduled alarms", async () => {
  const store = makeStore();
  store.updateSettings({
    analysisEnabled: true,
    officialConfigStatus: "ready",
    officialAlarmStatus: "ready",
  }, "SN-ALARM");
  const admitted = [];
  const device = {
    sn: "SN-ALARM",
    async status() { return { status: "online" }; },
    async login() {},
    async queryAlarmMessages() {
      return [{
        AlarmID: "alarm-window-1",
        AlarmType: "HumanDetect",
        AlarmTime: "2026-08-28 12:00:00",
        Message: "活物报警",
      }];
    },
    async queryRecordings() {
      throw new Error("scheduled scan must defer replay lookup to the alarm window job");
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: {},
    alarmAdapter: false,
    nowProvider: () => new Date("2026-08-28 12:01:00"),
  });
  coordinator.enqueueAlarmWindow = (task) => {
    admitted.push(task);
    return { ok: true, queued: true };
  };
  const fastCandidates = [];
  coordinator.enqueueFeedingStartCandidate = (task) => {
    fastCandidates.push(task);
    return { ok: true, queued: true };
  };

  const result = await coordinator.processScanTask({
    force: false,
    date: "2026-08-28",
    device,
    deviceSn: "SN-ALARM",
  });

  assert.equal(result.queued, 1);
  assert.equal(fastCandidates.length, 0);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].window.beginTime, "2026-08-28 11:30:00");
  assert.equal(admitted[0].window.endTime, "2026-08-28 12:00:00");
  assert.equal(
    store.getSettings("SN-ALARM").feedingPendingThroughMs,
    new Date("2026-08-28 12:00:00").getTime()
  );
});

test("FeedAnalysisCoordinator analyzes historical alarm pictures without sending realtime notifications", async () => {
  const calls = [];
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const device = {
    async queryAlarmMessages(payload) {
      calls.push(["queryAlarmMessages", payload]);
      return [
        {
          AlarmID: "alarm-1",
          AlarmType: "HumanDetect",
          AlarmTime: "2026-07-04 12:00:08",
          Message: "live object",
          PicUrl: "https://example.test/alarm.jpg",
        },
      ];
    },
    async getAlarmPicUrl(alarm) {
      calls.push(["getAlarmPicUrl", alarm.id]);
      return alarm.snapshotUrl;
    },
    async queryRecordings() {
      calls.push(["queryRecordings"]);
      throw new Error("recording fallback should not run when alarm picture exists");
    },
    async getPlaybackUrl() {
      calls.push(["getPlaybackUrl"]);
      throw new Error("playback should not run when alarm picture exists");
    },
  };
  const analyzer = {
    async analyzeSnapshot(payload) {
      calls.push(["analyzeSnapshot", payload.snapshotUrl, payload.alarm.id]);
      return {
        hasCat: true,
        hasFeeding: true,
        analysisConfidence: 0.94,
        bowlRoi: { x: 1, y: 2, width: 3, height: 4 },
        markers: [
          {
            markerType: "feeding_start",
            markerTsMs: new Date("2026-07-04 12:00:08").getTime(),
            beginTime: "2026-07-04 12:00:08",
            endTime: "2026-07-04 12:00:08",
          },
        ],
      };
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
    nowProvider: () => new Date("2026-07-04 12:10:00"),
  });

  const result = await coordinator.syncNow({ force: true });

  assert.equal(result.processed, 0);
  assert.equal(result.records, 0);
  assert.equal(result.snapshots, 1);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["queryAlarmMessages", "getAlarmPicUrl", "analyzeSnapshot"]
  );
  assert.equal(store.state.pendingNotifications.length, 0);
});

test("FeedAnalysisCoordinator falls back to recordings when alarm picture confidence is low", async () => {
  const calls = [];
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const device = {
    async queryAlarmMessages() {
      calls.push(["queryAlarmMessages"]);
      return [
        {
          AlarmID: "alarm-1",
          AlarmType: "HumanDetect",
          AlarmTime: "2026-07-04 12:00:08",
          Message: "live object",
          PicUrl: "https://example.test/alarm.jpg",
        },
      ];
    },
    async getAlarmPicUrl(alarm) {
      calls.push(["getAlarmPicUrl"]);
      return alarm.snapshotUrl;
    },
    async queryRecordings(payload) {
      calls.push(["queryRecordings", payload]);
      return [
        {
          BeginTime: "2026-07-04 12:00:00",
          EndTime: "2026-07-04 12:00:30",
          FileName: "clip-alarm.mp4",
        },
      ];
    },
    async getPlaybackUrl() {
      calls.push(["getPlaybackUrl"]);
      return "https://example.test/clip-alarm.m3u8";
    },
  };
  const analyzer = {
    async analyzeSnapshot() {
      calls.push(["analyzeSnapshot"]);
      return { hasCat: false, hasFeeding: false, analysisConfidence: 0.1, markers: [] };
    },
    async analyzeRecording() {
      calls.push(["analyzeRecording"]);
      return { hasCat: false, hasFeeding: false, analysisConfidence: 0.2, markers: [] };
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
    nowProvider: () => new Date("2026-07-04 12:10:00"),
  });

  const result = await coordinator.syncNow({ force: true });

  assert.equal(result.processed, 1);
  assert.equal(result.records, 1);
  assert.equal(result.snapshots, 1);
  assert.equal(store.state.pendingNotifications.length, 0);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["queryAlarmMessages", "getAlarmPicUrl", "analyzeSnapshot", "queryRecordings", "getPlaybackUrl", "analyzeRecording"]
  );
});

test("FeedAnalysisCoordinator falls back to recording analysis only when alarm pictures are unavailable", async () => {
  const calls = [];
  const store = makeStore();
  store.updateSettings({ officialConfigStatus: "ready", officialAlarmStatus: "ready" });
  const device = {
    async queryAlarmMessages() {
      calls.push(["queryAlarmMessages"]);
      return [
        {
          AlarmID: "alarm-1",
          AlarmType: "HumanDetect",
          AlarmTime: "2026-07-04 12:00:08",
          Message: "live object",
        },
      ];
    },
    async getAlarmPicUrl() {
      calls.push(["getAlarmPicUrl"]);
      return "";
    },
    async queryRecordings(payload) {
      calls.push(["queryRecordings", payload]);
      return [
        {
          BeginTime: "2026-07-04 12:00:00",
          EndTime: "2026-07-04 12:00:30",
          FileName: "clip-alarm.mp4",
        },
      ];
    },
    async getPlaybackUrl(record) {
      calls.push(["getPlaybackUrl", record.FileName]);
      return "https://example.test/clip-alarm.m3u8";
    },
  };
  const analyzer = {
    async analyzeRecording() {
      calls.push(["analyzeRecording"]);
      return {
        hasCat: true,
        hasFeeding: true,
        analysisConfidence: 0.93,
        markers: [
          {
            eventId: "feeding_1",
            markerType: "feeding_start",
            markerTsMs: new Date("2026-07-04 12:00:10").getTime(),
            beginTime: "2026-07-04 12:00:10",
            endTime: "2026-07-04 12:00:30",
          },
        ],
      };
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer,
    nowProvider: () => new Date("2026-07-04 12:10:00"),
  });

  const result = await coordinator.syncNow({ force: true });

  assert.equal(result.processed, 1);
  assert.equal(result.records, 1);
  assert.equal(result.snapshots, 0);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["queryAlarmMessages", "getAlarmPicUrl", "queryRecordings", "getPlaybackUrl", "analyzeRecording"]
  );
});

test("FeedAnalysisCoordinator still bootstraps official alarms when legacy config is already ready", async () => {
  const calls = [];
  const store = makeStore();
  store.state.settings.officialConfigStatus = "ready";
  store.state.settings.officialAlarmStatus = "idle";
  const device = {
    async subscribeAlarmMessages(payload) {
      calls.push(["subscribeAlarmMessages", payload]);
      return { Ret: 100 };
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: {},
  });

  await coordinator.bootstrapOfficialConfig(device);

  assert.deepEqual(calls, [["subscribeAlarmMessages", { alarmTypes: ["MotionDetect"] }]]);
  assert.equal(store.state.settings.officialAlarmStatus, "ready");
  assert.equal(store.state.settings.officialAlarmProfileVersion, 2);
});

test("FeedAnalysisCoordinator keeps the current motion alarm subscription profile", async () => {
  const calls = [];
  const store = makeStore();
  store.state.settings.officialConfigStatus = "ready";
  store.state.settings.officialAlarmStatus = "ready";
  store.state.settings.officialAlarmProfileVersion = 2;
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => ({
      async subscribeAlarmMessages(payload) {
        calls.push(payload);
      },
    }),
    analyzer: {},
  });

  await coordinator.bootstrapOfficialConfig(await coordinator.deviceFactory());

  assert.deepEqual(calls, []);
});

test("FeedAnalysisCoordinator queues a bounded replay compensation window when official alarms are empty", async () => {
  const calls = [];
  const admitted = [];
  const store = makeStore();
  store.state.settings.officialConfigStatus = "ready";
  store.state.settings.officialAlarmStatus = "ready";
  const device = {
    sn: "SN001",
    async queryAlarmMessages(payload) {
      calls.push(["queryAlarmMessages", payload]);
      return [];
    },
  };
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => device,
    analyzer: {},
    nowProvider: () => new Date("2026-07-04 12:10:00"),
  });
  coordinator.enqueueAlarmWindow = (task) => {
    admitted.push(task.window);
    return { ok: true, queued: true };
  };

  const result = await coordinator.processScanTask({
    force: false,
    date: "2026-07-04",
    device,
    deviceSn: "SN001",
  });

  assert.equal(result.queued, 1);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].source, "replay-compensation");
  assert.equal(admitted[0].beginTime, "2026-07-04 11:55:00");
  assert.equal(admitted[0].endTime, "2026-07-04 12:10:00");
  assert.equal(store.getSettings("SN001").lastAlarmCompensationAt, new Date("2026-07-04 12:10:00").getTime());
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["queryAlarmMessages"]
  );
});

test("FeedAnalysisCoordinator schedules scans using the local calendar date", async () => {
  const admitted = [];
  const store = makeStore();
  store.state.settings.analysisEnabled = true;
  const coordinator = new FeedAnalysisCoordinator({
    store,
    deviceFactory: async () => ({}),
    deviceProvider: {
      async listDeviceSns() {
        return ["SN001"];
      },
    },
    analyzer: {},
    nowProvider: () => new Date(2026, 6, 5, 0, 30, 0),
  });
  coordinator.queue.enqueueDeviceDate = (task) => {
    admitted.push(task);
    return { ok: true, queued: true };
  };

  const result = await coordinator.enqueueDueScans();

  assert.equal(result.queued, 1);
  assert.equal(admitted[0].date, "2026-07-05");
});

test("FeedAnalysisCoordinator rate-limits sustained queue backlog warnings", async () => {
  const clock = { value: 1_000_000 };
  const warnings = [];
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    deviceFactory: async () => ({ sn: "SN001" }),
    nowProvider: () => new Date(clock.value),
    queueWarningAgeMs: 300_000,
    queueWarningCooldownMs: 60_000,
    logger: {
      warn: (...args) => warnings.push(args),
      error() {},
    },
  });
  coordinator.queue.getStatus = ({ deviceSn = "" } = {}) => ({
    pending: 5,
    running: 2,
    oldestPendingMs: 300_001,
    activeDevice: deviceSn ? { pending: 1, running: false } : undefined,
  });

  assert.deepEqual(coordinator.getQueueStatus("SN001").activeDevice, { pending: 1, running: false });
  coordinator.reportQueueCapacityIfNeeded();
  coordinator.reportQueueCapacityIfNeeded();
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings[0]), /pending.*5/);
  assert.doesNotMatch(JSON.stringify(warnings[0]), /SN001/);

  clock.value += 60_000;
  coordinator.reportQueueCapacityIfNeeded();
  assert.equal(warnings.length, 2);
});

test("FeedAnalysisCoordinator does not schedule automatic scans when automation is disabled", async () => {
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    deviceFactory: async () => ({ sn: "SN001" }),
    automationEnabled: false,
  });
  let scanCalls = 0;
  coordinator.enqueueDueScans = async () => {
    scanCalls += 1;
  };

  try {
    coordinator.start();

    assert.equal(scanCalls, 0);
    assert.equal(coordinator.timer, null);
  } finally {
    coordinator.stop();
  }
});

test("FeedAnalysisCoordinator forwards snapshot starts and recording markers to WeChat device delivery", async () => {
  const events = [];
  const clips = [];
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    notifier: null,
    deviceNotificationDispatcher: {
      async dispatchFeedingEvent(event) { events.push(event); return { ok: true, delivered: 1 }; },
      async dispatchFeedingClip(input) { clips.push(input); return []; },
    },
  });

  const result = await coordinator.deliverFeedingNotification({
    eventId: "alarm-1__feeding_start",
    markerType: "feeding_start",
    deliveryOrigin: "realtime_alarm",
    startTime: "2026-08-23 12:00:00",
  }, "SN001");
  await coordinator.deliverWechatClipEvents("SN001", {
    id: "clip-1",
    markers: [{ markerType: "feeding_start", markerTsMs: 1 }],
  }, { origin: "realtime_alarm" });

  assert.equal(result.ok, true);
  assert.equal(events[0].sourceEventId, "alarm-1__feeding_start");
  assert.equal(events[0].deviceSn, "SN001");
  assert.equal(clips[0].clip.id, "clip-1");
});

test("FeedAnalysisCoordinator dispatches stable V3.2 feeding events even when legacy analysis disagrees", async () => {
  const delivered = [];
  const frames = [];
  for (let second = 0; second < 8; second += 1) {
    for (const fraction of [0, 0.5]) {
      frames.push({
        second,
        offsetSec: second + fraction,
        hasCat: true,
        hasTarget: true,
        nearBowl: true,
        eatingVerified: second % 3 === 0,
        confidence: 0.9,
        behaviorEvidence: {
          confidence: 0.8,
          faceObserved: true,
          faceAtBowl: true,
        },
      });
    }
  }
  const coordinator = new FeedAnalysisCoordinator({
    store: makeStore(),
    analyzer: {
      async analyzeRecording() {
        return {
          hasCat: true,
          hasFeeding: false,
          markers: [],
          frames,
          error: "",
        };
      },
    },
    deviceNotificationDispatcher: {
      async dispatchFeedingClip(input) {
        delivered.push(input);
        return [];
      },
    },
  }, { origin: "realtime_alarm" });
  const input = {
    device: {
      async getPlaybackUrl() {
        return "https://example.test/v32-feeding.m3u8";
      },
    },
    recording: {
      BeginTime: "2026-08-28 12:00:00",
      EndTime: "2026-08-28 12:00:08",
      FileName: "feeding.h264",
    },
    recordingKey: "2026-08-28 12:00:00__feeding.h264",
    deviceSn: "SN001",
  };

  const first = await coordinator.analyzeRecording(input);
  const second = await coordinator.analyzeRecording(input);
  await coordinator.deliverWechatClipEvents("SN001", first.clip);

  assert.equal(first.analysis.feedingStats.summary.mealCount, 1);
  assert.equal(first.analysis.hasFeeding, false);
  assert.deepEqual(
    first.clip.markers.map((item) => item.markerType),
    ["feeding_start", "feeding_end"]
  );
  assert.deepEqual(
    first.clip.markers.map((item) => item.eventId),
    second.clip.markers.map((item) => item.eventId)
  );
  assert.equal(delivered.length, 0);
});
