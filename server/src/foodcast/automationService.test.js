const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  DAILY_TIMELINE_VERSION,
  FoodcastAutomationService,
  resolveDailyDurationBudget,
  selectDailySegments,
} = require("./automationService");
const { ALGORITHM_VERSION } = require("./continuitySelector");

class MemoryCatalog {
  constructor() {
    this.intervals = new Map();
    this.meals = [];
    this.jobs = new Map();
    this.materials = new Map();
    this.daily = new Map();
  }
  async upsertInterval(value) { this.intervals.set(value.id, structuredClone(value)); }
  async listIntervals(deviceSn, date) {
    return [...this.intervals.values()].filter((row) => row.deviceSn === deviceSn && row.date === date);
  }
  async replaceMeals(deviceSn, date, meals) {
    this.meals = this.meals.filter((row) => row.deviceSn !== deviceSn || row.date !== date).concat(structuredClone(meals));
  }
  async listDueMeals(nowMs) { return this.meals.filter((row) => row.status === "pending" && row.dueAt <= nowMs); }
  async putJob(value) { this.jobs.set(value.id, structuredClone(value)); return value; }
  async getJob(id) { return structuredClone(this.jobs.get(id) || null); }
  async claimJob(id, worker, nowMs, leaseMs) {
    const value = this.jobs.get(id);
    if (!value || (value.status !== "queued" && !(value.status === "running" && value.leaseExpiresAt <= nowMs))) return null;
    Object.assign(value, { status: "running", leaseOwner: worker, leaseExpiresAt: nowMs + leaseMs });
    return structuredClone(value);
  }
  async updateJob(id, patch) {
    const value = this.jobs.get(id);
    if (!value) return null;
    Object.assign(value, structuredClone(patch));
    return structuredClone(value);
  }
  async putMaterial(value) { this.materials.set(value.id, structuredClone(value)); return value; }
  async getMaterial(id) { return structuredClone(this.materials.get(id) || null); }
  async listMaterials({ ownerOpenid, deviceSn, date, nowMs }) {
    return [...this.materials.values()].filter((row) => row.ownerOpenid === ownerOpenid
      && row.deviceSn === deviceSn && row.date === date && row.status === "ready" && row.expiresAt > nowMs);
  }
  dailyKey(owner, device, date) { return `${owner}:${device}:${date}`; }
  async getLatestDaily(owner, device, date) { return structuredClone(this.daily.get(this.dailyKey(owner, device, date)) || null); }
  async swapLatestDaily(owner, device, date, expected, next) {
    const key = this.dailyKey(owner, device, date);
    const current = this.daily.get(key);
    if ((current?.materialId || null) !== (expected || null)) return false;
    this.daily.set(key, { ...structuredClone(next), ownerOpenid: owner, deviceSn: device, date });
    return true;
  }
  async listExpiredArtifacts() { return []; }
  async expireArtifacts(ids, nowMs) {
    const fileIds = [];
    for (const id of ids) {
      const material = this.materials.get(id);
      if (!material || material.status === "expired") continue;
      if (material.fileId) fileIds.push(material.fileId);
      Object.assign(material, { status: "expired", expiredAt: nowMs });
    }
    return fileIds;
  }
}

function feedingClip(start = "2026-07-26 08:00:00", end = "2026-07-26 08:08:00") {
  return {
    id: "clip-1",
    beginTime: start,
    endTime: end,
    recordingKey: "recording-1",
    playbackParams: { fileName: "clip.h264", startTime: start, endTime: end },
    markers: [
      { markerType: "feeding_start", beginTime: start, eventId: "feeding-1" },
      { markerType: "feeding_end", beginTime: end },
    ],
    cuteTimeline: Array.from({ length: 21 }, (_, index) => ({
      offsetSec: 30 + index * 0.5,
      cuteScore: 0.96 - index * 0.001,
      modelConfidence: 0.94,
      cuteReasons: ["head_up", "close_face"],
      hasCat: true,
      faceRelation: "toward_camera",
      strictEligible: true,
      looseEligible: true,
    })),
  };
}

function defaultDailySelector() {
  return {
    async select(requests) {
      return {
        ok: true,
        algorithm: ALGORITHM_VERSION,
        config: { anchorRankMin: 0.65 },
        results: requests.map((request) => {
          const anchor = Number(request.frames[0]?.offsetSec) || 0;
          return {
            id: request.id,
            segments: [{
              startSec: anchor,
              endSec: anchor + 4,
              durationSec: 4,
              anchorOffsetSec: anchor + 2,
              peakScore: 0.9,
              peakCuteScore: 0.8,
              meanContinuityScore: 0.75,
            }],
          };
        }),
      };
    },
  };
}

function harness({
  nowMs = Date.parse("2026-07-26T08:20:00+08:00"),
  uploadFailureFor = "",
  deleteFailures = 0,
  dailySelector = defaultDailySelector(),
  dailyTimelineAnalyzer = null,
  shouldYieldHeavyWork = () => false,
} = {}) {
  const catalog = new MemoryCatalog();
  const renderer = {
    calls: [],
    async render(input) {
      this.calls.push(structuredClone({
        jobType: input.jobType,
        mode: input.mode,
        audioMode: input.audioMode,
        bgm: input.bgm,
        segments: input.segments,
      }));
      const durationSec = input.segments.reduce((sum, row) => sum + row.durationSec, 0);
      return { durationSec, outputSize: 100, outputMapping: input.outputMapping || [] };
    },
  };
  const mediaStorage = {
    uploads: [],
    deleted: [],
    deleteAttempts: 0,
    async upload(cloudPath) {
      const jobType = cloudPath.includes("daily_featured") ? "daily_featured" : "meal_material";
      if (uploadFailureFor === jobType) throw new Error("UPLOAD_FAILED");
      this.uploads.push(cloudPath);
      return { fileId: `cloud://env/${cloudPath}` };
    },
    async getReadUrl(fileId) { return `https://media.test/${encodeURIComponent(fileId)}`; },
    async delete(fileIds) {
      this.deleteAttempts += 1;
      if (this.deleteAttempts <= deleteFailures) throw new Error("DELETE_FAILED");
      this.deleted.push(...fileIds);
    },
  };
  const bgmLibrary = {
    tracks: [{ id: "real-1", filePath: "D:/bgm/real-1.m4a" }],
    pick() { return this.tracks[0]; },
  };
  const service = new FoodcastAutomationService({
    catalog,
    renderer,
    mediaStorage,
    bgmLibrary,
    resolveOwnerOpenid: async () => "owner-1",
    resolveSource: async () => "https://camera.test/replay.m3u8",
    tempDir: path.join("D:/tmp", "foodcast-automation-test"),
    now: () => nowMs,
    idFactory: (() => { let value = 0; return () => `id-${++value}`; })(),
    workerId: "worker-1",
    mealGapMs: 600_000,
    leaseMs: 60_000,
    retentionMs: 7 * 86_400_000,
    dailySelector,
    dailyTimelineAnalyzer,
    shouldYieldHeavyWork,
  });
  return { catalog, renderer, mediaStorage, bgmLibrary, service, nowMs };
}

test("reconcile leaves due foodcast work queued while feeding analysis owns the server", async () => {
  const h = harness({ shouldYieldHeavyWork: () => true });
  h.catalog.meals.push({
    id: "meal-busy",
    version: "v1",
    ownerOpenid: "owner-1",
    deviceSn: "SN-BUSY",
    date: "2026-07-26",
    status: "pending",
    dueAt: h.nowMs - 1,
    intervals: [],
  });

  assert.deepEqual(await h.service.reconcile(), []);
  assert.equal(h.catalog.jobs.size, 0);
  assert.equal(h.renderer.calls.length, 0);
});

test("backfills legacy meal timelines once and rebuilds one daily from every meal", async () => {
  const analyzerCalls = [];
  const h = harness({
    dailyTimelineAnalyzer: {
      async analyzeRecording(input) {
        analyzerCalls.push(structuredClone(input));
        return {
          cuteTimeline: Array.from({ length: 25 }, (_, index) => ({
            offsetSec: index * 0.5,
            cuteScore: 0.92,
            modelConfidence: 0.9,
            cuteReasons: ["close_face"],
            hasCat: true,
            faceRelation: "toward_camera",
            relationConfidence: 0.9,
            strictEligible: true,
            looseEligible: true,
            sizeScore: 0.9,
            cameraScore: 0.9,
            pitchScore: 0.8,
            visibilityScore: 0.9,
          })),
        };
      },
    },
  });
  const legacyMeals = [
    { id: "legacy-meal-1", mealStartMs: h.nowMs - 7_200_000, fileId: "meal-1.mp4", durationSec: 155 },
    { id: "legacy-meal-2", mealStartMs: h.nowMs - 3_600_000, fileId: "meal-2.mp4", durationSec: 170 },
  ];
  for (const meal of legacyMeals) {
    h.catalog.materials.set(meal.id, {
      ...meal,
      kind: "meal",
      ownerOpenid: "owner-1",
      deviceSn: "SN-1",
      date: "2026-07-26",
      status: "ready",
      createdAt: h.nowMs - 1_000,
      expiresAt: h.nowMs + 86_400_000,
      sourceClips: [],
      outputMapping: [],
    });
  }
  h.catalog.materials.set("legacy-daily", {
    id: "legacy-daily",
    kind: "daily",
    ownerOpenid: "owner-1",
    deviceSn: "SN-1",
    date: "2026-07-26",
    status: "ready",
    fileId: "old-daily.mp4",
    algorithm: "",
    createdAt: h.nowMs - 1_000,
    expiresAt: h.nowMs + 86_400_000,
  });
  h.catalog.daily.set("owner-1:SN-1:2026-07-26", {
    materialId: "legacy-daily",
    fileId: "old-daily.mp4",
    version: "legacy-version",
  });

  const rebuilt = await h.service.updateDailyFeatured({
    ownerOpenid: "owner-1",
    deviceSn: "SN-1",
    date: "2026-07-26",
    nowMs: h.nowMs,
  });
  const rebuiltAgain = await h.service.updateDailyFeatured({
    ownerOpenid: "owner-1",
    deviceSn: "SN-1",
    date: "2026-07-26",
    nowMs: h.nowMs + 1,
  });

  assert.equal(analyzerCalls.length, 2);
  assert.deepEqual(analyzerCalls.map((call) => call.sampleSeconds), [0.5, 0.5]);
  assert.deepEqual(analyzerCalls.map((call) => call.cuteAnalysisAllScales), [true, true]);
  assert.deepEqual(analyzerCalls.map((call) => call.fixedBottomBowlRegion), [true, true]);
  assert.deepEqual(analyzerCalls.map((call) => call.beginTime), [
    "2026-07-26 06:20:00",
    "2026-07-26 07:20:00",
  ]);
  assert.equal(rebuilt.algorithm, ALGORITHM_VERSION);
  assert.deepEqual(new Set(rebuilt.sourceMaterialIds), new Set(["legacy-meal-1", "legacy-meal-2"]));
  assert.equal(rebuilt.bgm.id, "real-1");
  assert.equal(rebuiltAgain.id, rebuilt.id);
  assert.equal(h.renderer.calls.filter((call) => call.jobType === "daily_featured").length, 1);
  assert.equal((await h.catalog.getMaterial("legacy-meal-1")).cuteTimeline.length, 25);
  assert.equal((await h.catalog.getMaterial("legacy-meal-2")).cuteTimeline.length, 25);
  assert.equal((await h.catalog.getMaterial("legacy-meal-1")).cuteTimelineVersion, DAILY_TIMELINE_VERSION);
  assert.equal((await h.catalog.getMaterial("legacy-meal-2")).cuteTimelineVersion, DAILY_TIMELINE_VERSION);
});

test("finalizes a meal after ten quiet minutes and updates daily featured", async () => {
  const h = harness();
  await h.service.ingestAnalyzedClip({ deviceSn: "SN-1", date: "2026-07-26", clip: feedingClip(), recording: {} });
  await h.service.reconcile(h.nowMs);

  assert.deepEqual(h.renderer.calls.map((call) => call.jobType), ["meal_material", "daily_featured"]);
  assert.equal(h.renderer.calls[0].audioMode, "source");
  assert.equal(h.renderer.calls[1].audioMode, "mix");
  assert.equal(h.renderer.calls[1].mode, "quick_cut");
  assert.ok(h.renderer.calls[1].segments.reduce((sum, row) => sum + row.durationSec, 0) <= 60);
  assert.equal(h.renderer.calls[1].bgm.id, "real-1");
  const pointer = await h.catalog.getLatestDaily("owner-1", "SN-1", "2026-07-26");
  assert.equal(pointer.fileId.startsWith("cloud://"), true);
  const daily = await h.catalog.getMaterial(pointer.materialId);
  assert.equal(daily.algorithm, ALGORITHM_VERSION);
  assert.equal(daily.sourceMaterialIds.length, 1);
  assert.equal([...h.catalog.materials.values()].some((item) => item.kind === "daily_segment"), false);
});

test("daily continuity selection covers each qualifying meal before globally filling the budget", async () => {
  const baseMs = Date.parse("2026-07-26T08:00:00+08:00");
  const materials = Array.from({ length: 3 }, (_, mealIndex) => {
    const startMs = baseMs + mealIndex * 3_600_000;
    return {
      id: `meal-${mealIndex + 1}`,
      kind: "meal",
      status: "ready",
      fileId: `file-${mealIndex + 1}`,
      mealStartMs: startMs,
      outputMapping: [{ sourceStartMs: startMs, sourceEndMs: startMs + 60_000, outputStartSec: 0, outputEndSec: 60 }],
      sourceClips: [{
        id: `clip-${mealIndex + 1}`,
        beginTime: new Date(startMs).toISOString(),
        endTime: new Date(startMs + 60_000).toISOString(),
        cuteTimeline: [{ offsetSec: 2, hasCat: true }],
      }],
    };
  });
  const selector = {
    async select(requests) {
      return {
        algorithm: ALGORITHM_VERSION,
        config: { targetSegmentSec: 6 },
        results: requests.map((request, index) => ({
          id: request.id,
          segments: [
            { startSec: 2, endSec: 8, peakScore: 0.7 + index * 0.05, peakCuteScore: 0.8, meanContinuityScore: 0.7 },
            { startSec: 20, endSec: 25, peakScore: index === 1 ? 0.99 : 0.6, peakCuteScore: 0.9, meanContinuityScore: 0.8 },
          ],
        })),
      };
    },
  };

  const result = await selectDailySegments(materials, 23, selector);

  assert.equal(result.algorithm, ALGORITHM_VERSION);
  assert.deepEqual(new Set(result.segments.map((segment) => segment.materialId)), new Set(["meal-1", "meal-2", "meal-3"]));
  assert.equal(result.segments.length, 4);
  assert.ok(result.segments.reduce((sum, segment) => sum + segment.durationSec, 0) <= 23);
  assert.deepEqual(result.segments.map((segment) => segment.absoluteStartMs), result.segments.map((segment) => segment.absoluteStartMs).sort((a, b) => a - b));
  assert.equal(result.segments.filter((segment) => segment.materialId === "meal-2").length, 2);
});

test("daily duration budget grows with meal count and honors explicit caps", () => {
  const materials = Array.from({ length: 7 }, (_, index) => ({
    id: `meal-${index}`,
    kind: "meal",
    status: "ready",
    fileId: `meal-${index}.mp4`,
  }));
  assert.equal(resolveDailyDurationBudget(materials.slice(0, 1), "auto"), 20);
  assert.equal(resolveDailyDurationBudget(materials.slice(0, 3), "auto"), 45);
  assert.equal(resolveDailyDurationBudget(materials, "auto"), 105);
  assert.equal(resolveDailyDurationBudget(materials, "compact"), 30);
  assert.equal(resolveDailyDurationBudget(materials, "standard"), 60);
  assert.equal(resolveDailyDurationBudget(materials, "rich"), 120);
});

test("a meal stays ready when continuity-v3 finds no qualifying cute segment", async () => {
  const h = harness({
    dailySelector: {
      async select(requests) {
        return { algorithm: ALGORITHM_VERSION, config: {}, results: requests.map((request) => ({ id: request.id, segments: [] })) };
      },
    },
  });
  await h.service.ingestAnalyzedClip({ deviceSn: "SN-1", date: "2026-07-26", clip: feedingClip() });
  const results = await h.service.reconcile(h.nowMs);

  assert.deepEqual(results, [{ jobId: results[0].jobId, ok: true }]);
  assert.deepEqual(h.renderer.calls.map((call) => call.jobType), ["meal_material"]);
  assert.equal((await h.catalog.getLatestDaily("owner-1", "SN-1", "2026-07-26")), null);
  assert.equal((await h.catalog.getJob(results[0].jobId)).status, "ready");
});

test("does not generate at 9:59 of quiet time", async () => {
  const endMs = Date.parse("2026-07-26T08:08:00+08:00");
  const h = harness({ nowMs: endMs + 599_000 });
  await h.service.ingestAnalyzedClip({ deviceSn: "SN-1", date: "2026-07-26", clip: feedingClip() });
  await h.service.reconcile(h.nowMs);
  assert.deepEqual(h.renderer.calls, []);
});

test("reconciliation is idempotent after meal and daily jobs succeed", async () => {
  const h = harness();
  await h.service.ingestAnalyzedClip({ deviceSn: "SN-1", date: "2026-07-26", clip: feedingClip() });
  await h.service.reconcile(h.nowMs);
  await h.service.reconcile(h.nowMs + 1_000);
  assert.equal(h.renderer.calls.length, 2);
});

test("keeps the previous daily file when replacement upload fails", async () => {
  const h = harness({ uploadFailureFor: "daily_featured" });
  h.catalog.daily.set("owner-1:SN-1:2026-07-26", {
    materialId: "old-daily",
    fileId: "old-file",
    version: "old-version",
  });
  await h.service.ingestAnalyzedClip({ deviceSn: "SN-1", date: "2026-07-26", clip: feedingClip() });
  await h.service.reconcile(h.nowMs);
  assert.equal((await h.catalog.getLatestDaily("owner-1", "SN-1", "2026-07-26")).fileId, "old-file");
});

test("ingestion rejects a device without an owner before accepting intervals", async () => {
  const h = harness();
  h.service.resolveOwnerOpenid = async () => "";
  await assert.rejects(
    h.service.ingestAnalyzedClip({ deviceSn: "SN-missing", date: "2026-07-26", clip: feedingClip() }),
    { code: "DEVICE_OWNER_REQUIRED" }
  );
  assert.equal(h.catalog.intervals.size, 0);
});

test("expires metadata before deleting unreferenced media", async () => {
  const h = harness();
  h.catalog.materials.set("old", {
    id: "old", status: "ready", fileId: "cloud://old", expiresAt: h.nowMs - 1,
  });
  h.catalog.listExpiredArtifacts = async () => [structuredClone(h.catalog.materials.get("old"))];
  const calls = [];
  const expire = h.catalog.expireArtifacts.bind(h.catalog);
  h.catalog.expireArtifacts = async (...args) => { calls.push("expire"); return expire(...args); };
  const remove = h.mediaStorage.delete.bind(h.mediaStorage);
  h.mediaStorage.delete = async (...args) => { calls.push("delete"); return remove(...args); };

  const result = await h.service.cleanup(h.nowMs);

  assert.deepEqual(calls, ["expire", "delete"]);
  assert.equal(h.catalog.materials.get("old").status, "expired");
  assert.deepEqual(h.mediaStorage.deleted, ["cloud://old"]);
  assert.deepEqual(result, { artifacts: 1, files: 1, pendingFiles: 0, failures: [] });
});

test("retries cloud deletion after metadata has already expired", async () => {
  const h = harness({ deleteFailures: 1 });
  h.catalog.materials.set("old", {
    id: "old", status: "ready", fileId: "cloud://old", expiresAt: h.nowMs - 1,
  });
  h.catalog.listExpiredArtifacts = async () => (
    h.catalog.materials.get("old").status === "ready" ? [structuredClone(h.catalog.materials.get("old"))] : []
  );

  const first = await h.service.cleanup(h.nowMs);
  const second = await h.service.cleanup(h.nowMs + 1);

  assert.equal(first.pendingFiles, 1);
  assert.equal(first.failures.length, 1);
  assert.equal(second.pendingFiles, 0);
  assert.deepEqual(h.mediaStorage.deleted, ["cloud://old"]);
});

test("render cleanup removes its temporary output after final failure", async () => {
  const h = harness({ uploadFailureFor: "meal_material" });
  const removed = [];
  const original = require("node:fs").rmSync;
  require("node:fs").rmSync = (filePath, options) => removed.push([filePath, options]);
  try {
    await assert.rejects(h.service.renderAndUpload({
      jobId: "failed", jobType: "meal_material", ownerOpenid: "owner-1", deviceSn: "SN-1",
      date: "2026-07-26", segments: [{ durationSec: 1 }], audioMode: "source",
    }));
  } finally {
    require("node:fs").rmSync = original;
  }
  assert.equal(removed.length, 2);
  assert.equal(removed[0][0].endsWith("failed.mp4"), true);
  assert.deepEqual(removed[0][1], { force: true });
  assert.equal(removed[1][0].endsWith("failed.jpg"), true);
  assert.deepEqual(removed[1][1], { force: true });
});

test("legacy material cover generation reuses stored media and uploads a jpeg", async () => {
  const h = harness();
  const captures = [];
  h.renderer.captureCover = async (source, outputPath) => captures.push({ source, outputPath });

  const result = await h.service.renderMaterialCover({
    material: {
      id: "meal-old",
      ownerOpenid: "owner-1",
      deviceSn: "SN-1",
      date: "2026-07-26",
      fileId: "cloud://env/old.mp4",
    },
  });

  assert.equal(captures.length, 1);
  assert.match(captures[0].source, /^https:\/\/media\.test\//);
  assert.match(captures[0].outputPath, /cover-[a-f0-9]{24}\.jpg$/);
  assert.match(result.coverFileId, /cover\.jpg$/);
});
