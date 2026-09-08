const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildMealId,
  buildOutputMapping,
  extractFeedingIntervals,
  groupFeedingIntervals,
} = require("./materialModel");
const { formatDeviceDateTime, parseDeviceDateTime } = require("../feedAnalysis/deviceTime");
const { ALGORITHM_VERSION, ContinuityV3Selector } = require("./continuitySelector");
const { buildMediaCloudPath } = require("./mediaStorage");

const DAILY_TIMELINE_VERSION = "cute-features-v2-fixed-bowl";

function codedError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mealJobId(meal) {
  return `meal-job-${stableHash([meal.id, meal.version]).slice(0, 24)}`;
}

function intervalToRenderSegment(interval) {
  return {
    ...(interval.source || {}),
    intervalId: interval.id,
    startMs: interval.startMs,
    endMs: interval.endMs,
    durationSec: (interval.endMs - interval.startMs) / 1000,
    sourceOffsetSec: 0,
  };
}

function uniqueSourceClips(material) {
  const clips = Array.isArray(material?.sourceClips) ? material.sourceClips : [];
  return [...new Map(clips.filter((clip) => clip?.id).map((clip) => [clip.id, clip])).values()];
}

function clipBounds(clip) {
  const startMs = parseDeviceDateTime(clip?.beginTime)?.getTime();
  const endMs = parseDeviceDateTime(clip?.endTime)?.getTime();
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? { startMs, endMs }
    : null;
}

function buildContinuityRequests(materials) {
  const ordered = materials
    .filter((material) => material.kind === "meal" && material.status === "ready" && material.fileId)
    .sort((left, right) => Number(left.mealStartMs) - Number(right.mealStartMs) || String(left.id).localeCompare(String(right.id)));
  const requests = [];
  const contexts = new Map();
  for (const material of ordered) {
    const materialFrames = (Array.isArray(material.cuteTimeline) ? material.cuteTimeline : [])
      .filter((frame) => Number.isFinite(Number(frame?.offsetSec)))
      .map((frame) => ({ ...frame, offsetSec: Number(frame.offsetSec) }));
    const materialDurationSec = Number(material.durationSec);
    if (materialFrames.length && Number.isFinite(materialDurationSec) && materialDurationSec > 0) {
      const id = `${material.id}:material`;
      requests.push({ id, durationSec: materialDurationSec, frames: materialFrames });
      contexts.set(id, {
        material,
        mapping: { outputStartSec: 0, outputEndSec: materialDurationSec },
        sourceStartMs: Number(material.mealStartMs) || Number(material.createdAt) || 0,
      });
      continue;
    }
    const sourceClips = uniqueSourceClips(material);
    if (!sourceClips.length || !Array.isArray(material.outputMapping)) continue;
    for (let index = 0; index < material.outputMapping.length; index += 1) {
      const mapping = material.outputMapping[index];
      const sourceStartMs = Number(mapping?.sourceStartMs);
      const sourceEndMs = Number(mapping?.sourceEndMs);
      const outputStartSec = Number(mapping?.outputStartSec);
      const outputEndSec = Number(mapping?.outputEndSec);
      if (!Number.isFinite(sourceStartMs) || !Number.isFinite(sourceEndMs) || sourceEndMs <= sourceStartMs
        || !Number.isFinite(outputStartSec) || !Number.isFinite(outputEndSec) || outputEndSec <= outputStartSec) continue;
      const clip = sourceClips.find((candidate) => {
        const bounds = clipBounds(candidate);
        return bounds && bounds.startMs <= sourceStartMs && sourceEndMs <= bounds.endMs;
      });
      const bounds = clipBounds(clip);
      if (!clip || !bounds) continue;
      const frames = (Array.isArray(clip.cuteTimeline) ? clip.cuteTimeline : [])
        .filter((frame) => Number.isFinite(Number(frame?.offsetSec)))
        .map((frame) => ({ ...frame, absoluteMs: bounds.startMs + Number(frame.offsetSec) * 1000 }))
        .filter((frame) => sourceStartMs <= frame.absoluteMs && frame.absoluteMs < sourceEndMs)
        .map(({ absoluteMs, ...frame }) => ({
          ...frame,
          offsetSec: Math.round(((absoluteMs - sourceStartMs) / 1000) * 1000) / 1000,
        }));
      if (!frames.length) continue;
      const id = `${material.id}:${index}`;
      requests.push({ id, durationSec: (sourceEndMs - sourceStartMs) / 1000, frames });
      contexts.set(id, { material, mapping, sourceStartMs });
    }
  }
  return { requests, contexts };
}

function candidateScore(candidate) {
  return Number(candidate.peakScore) * 0.65
    + Number(candidate.peakCuteScore) * 0.25
    + Number(candidate.meanContinuityScore) * 0.10;
}

function addCandidate(selected, selectedIds, candidate, remaining) {
  if (selectedIds.has(candidate.id) || remaining < 4) return remaining;
  const durationSec = Math.min(Number(candidate.durationSec) || 0, remaining);
  if (durationSec < 4) return remaining;
  selected.push({ ...candidate, durationSec });
  selectedIds.add(candidate.id);
  return remaining - durationSec;
}

async function selectDailySegments(materials, maxDurationSec = 60, selector = new ContinuityV3Selector()) {
  const { requests, contexts } = buildContinuityRequests(materials);
  if (!requests.length) return { algorithm: ALGORITHM_VERSION, config: {}, segments: [] };
  const selection = await selector.select(requests);
  const candidates = [];
  for (const result of selection.results) {
    const context = contexts.get(result?.id);
    if (!context) continue;
    for (let index = 0; index < (Array.isArray(result.segments) ? result.segments.length : 0); index += 1) {
      const segment = result.segments[index];
      const startSec = Number(segment?.startSec);
      const endSec = Number(segment?.endSec);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec - startSec < 4) continue;
      const mappingDurationSec = Number(context.mapping.outputEndSec) - Number(context.mapping.outputStartSec);
      if (startSec < 0 || endSec > mappingDurationSec + 0.001) continue;
      candidates.push({
        id: `${result.id}:${index}:${startSec}`,
        materialId: context.material.id,
        fileId: context.material.fileId,
        mealStartMs: Number(context.material.mealStartMs) || context.sourceStartMs,
        absoluteStartMs: context.sourceStartMs + startSec * 1000,
        sourceOffsetSec: Number(context.mapping.outputStartSec) + startSec,
        durationSec: endSec - startSec,
        peakScore: Number(segment.peakScore) || 0,
        peakCuteScore: Number(segment.peakCuteScore) || 0,
        meanContinuityScore: Number(segment.meanContinuityScore) || 0,
        anchorOffsetSec: Number(segment.anchorOffsetSec) || 0,
      });
    }
  }
  const ranked = candidates.slice().sort((left, right) => (
    candidateScore(right) - candidateScore(left)
    || left.absoluteStartMs - right.absoluteStartMs
    || left.id.localeCompare(right.id)
  ));
  const bestByMeal = new Map();
  for (const candidate of ranked) {
    if (!bestByMeal.has(candidate.materialId)) bestByMeal.set(candidate.materialId, candidate);
  }
  const selected = [];
  const selectedIds = new Set();
  let remaining = Math.max(0, Number(maxDurationSec) || 0);
  const coverage = [...bestByMeal.values()].sort((left, right) => (
    candidateScore(right) - candidateScore(left)
    || left.mealStartMs - right.mealStartMs
  ));
  for (const candidate of coverage) remaining = addCandidate(selected, selectedIds, candidate, remaining);
  for (const candidate of ranked) remaining = addCandidate(selected, selectedIds, candidate, remaining);
  selected.sort((left, right) => left.absoluteStartMs - right.absoluteStartMs || left.id.localeCompare(right.id));
  return { algorithm: selection.algorithm, config: selection.config || {}, segments: selected };
}

function resolveDailyDurationBudget(materials, durationMode = "auto") {
  const fixedBudgets = { compact: 30, standard: 60, rich: 120 };
  if (fixedBudgets[durationMode]) return fixedBudgets[durationMode];
  const mealCount = (Array.isArray(materials) ? materials : []).filter((material) => (
    material?.kind === "meal" && material?.status === "ready" && material?.fileId
  )).length;
  // Auto mode gives every meal room to contribute without padding the result
  // with repeated or low-quality footage. Actual output can be shorter.
  return Math.min(120, Math.max(20, mealCount * 15));
}

class FoodcastAutomationService {
  constructor(options = {}) {
    this.catalog = options.catalog;
    this.renderer = options.renderer;
    this.mediaStorage = options.mediaStorage;
    this.bgmLibrary = options.bgmLibrary;
    this.resolveOwnerOpenid = options.resolveOwnerOpenid;
    this.resolvePreferences = options.resolvePreferences || (async () => ({ mode: "quick_cut" }));
    this.resolveSource = options.resolveSource;
    this.tempDir = options.tempDir;
    this.now = options.now || Date.now;
    this.idFactory = options.idFactory || crypto.randomUUID;
    this.workerId = options.workerId || `worker-${crypto.randomUUID()}`;
    this.mealGapMs = Number(options.mealGapMs) || 600_000;
    this.leaseMs = Number(options.leaseMs) || 300_000;
    this.retentionMs = Number(options.retentionMs) || 30 * 86_400_000;
    this.pollIntervalMs = Number(options.pollIntervalMs) || 60_000;
    this.cleanupIntervalMs = Number(options.cleanupIntervalMs) || 3_600_000;
    this.cleanupBatchSize = Math.max(1, Number(options.cleanupBatchSize) || 100);
    this.dailyTimelineAnalyzer = options.dailyTimelineAnalyzer || null;
    this.dailyTimelineSampleSeconds = Math.min(2, Math.max(0.5, Number(options.dailyTimelineSampleSeconds) || 0.5));
    this.dailyTimelineOrientation = options.dailyTimelineOrientation || "none";
    this.dailyTimelineDetectorBackend = options.dailyTimelineDetectorBackend || "auto";
    this.dailyTimelineYoloModel = options.dailyTimelineYoloModel || "";
    this.shouldYieldHeavyWork = typeof options.shouldYieldHeavyWork === "function"
      ? options.shouldYieldHeavyWork
      : () => false;
    this.priorityCheckIntervalMs = Math.max(250, Number(options.priorityCheckIntervalMs) || 1000);
    this.logger = options.logger || console;
    this.dailySelector = options.dailySelector || new ContinuityV3Selector({
      pythonPath: options.pythonPath,
      projectRoot: options.projectRoot,
    });
    this.timer = null;
    this.cleanupTimer = null;
    this.pendingFileDeletes = new Set();
  }

  heavyWorkBlocked() {
    try {
      return this.shouldYieldHeavyWork() === true;
    } catch {
      return false;
    }
  }

  throwIfHeavyWorkBlocked() {
    if (!this.heavyWorkBlocked()) return;
    throw codedError("FOODCAST_PREEMPTED");
  }

  async initialize() {
    await this.catalog.initialize?.();
  }

  async ingestAnalyzedClip({ deviceSn, date, clip, recording } = {}) {
    const ownerOpenid = String(await this.resolveOwnerOpenid(deviceSn) || "").trim();
    if (!ownerOpenid) throw codedError("DEVICE_OWNER_REQUIRED");
    const intervals = extractFeedingIntervals(clip);
    for (const interval of intervals) {
      await this.catalog.upsertInterval({ ...interval, ownerOpenid, deviceSn, date });
    }
    const storedIntervals = await this.catalog.listIntervals(deviceSn, date);
    const meals = groupFeedingIntervals(storedIntervals, { gapMs: this.mealGapMs }).map((meal) => ({
      ...meal,
      id: buildMealId(deviceSn, meal.startMs),
      ownerOpenid,
      deviceSn,
      date: meal.date || date,
      status: "pending",
      dueAt: meal.endMs + this.mealGapMs,
      recordingKey: recording?.recordingKey || clip?.recordingKey || "",
    }));
    await this.catalog.replaceMeals(deviceSn, date, meals);
    return { intervals: intervals.length, meals: meals.length };
  }

  async reconcile(nowMs = this.now()) {
    if (this.heavyWorkBlocked()) return [];
    const dueMeals = await this.catalog.listDueMeals(nowMs);
    const results = [];
    for (const meal of dueMeals) {
      if (this.heavyWorkBlocked()) break;
      const jobId = mealJobId(meal);
      let job = await this.catalog.getJob(jobId);
      if (!job) {
        job = await this.catalog.putJob({
          id: jobId,
          jobType: "meal_material",
          ownerOpenid: meal.ownerOpenid,
          deviceSn: meal.deviceSn,
          date: meal.date,
          meal,
          status: "queued",
          createdAt: nowMs,
          updatedAt: nowMs,
        });
      }
      if (job.status === "ready") continue;
      const claimed = await this.catalog.claimJob(jobId, this.workerId, nowMs, this.leaseMs);
      if (!claimed) continue;
      try {
        await this.processJob(jobId);
        results.push({ jobId, ok: true });
      } catch (error) {
        results.push({ jobId, ok: false, error: error.code || error.message });
      }
    }
    return results;
  }

  async renderAndUpload({ jobId, jobType, ownerOpenid, deviceSn, date, segments, mode, audioMode, bgm, bgmVolume, outputMapping, signal }) {
    fs.mkdirSync(this.tempDir, { recursive: true });
    const outputPath = path.join(this.tempDir, `${jobId}.mp4`);
    const coverPath = path.join(this.tempDir, `${jobId}.jpg`);
    try {
      const result = await this.renderer.render({
        jobId,
        jobType,
        segments,
        mode,
        audioMode,
        bgm,
        bgmVolume,
        outputMapping,
        signal,
        outputPath,
        resolveSource: async (segment) => {
          if (segment.fileId) return this.mediaStorage.getReadUrl(segment.fileId);
          return this.resolveSource({ job: { id: jobId, jobType, ownerOpenid, deviceSn, date }, segment });
        },
      });
      const cloudPath = buildMediaCloudPath({
        ownerOpenid,
        deviceSn,
        date,
        jobId: `${jobType}-${jobId}`,
        fileName: "result.mp4",
      });
      const uploaded = await this.mediaStorage.upload(cloudPath, outputPath);
      let coverFileId = "";
      if (typeof this.renderer.captureCover === "function") {
        await this.renderer.captureCover(outputPath, coverPath);
        const coverCloudPath = buildMediaCloudPath({
          ownerOpenid,
          deviceSn,
          date,
          jobId: `${jobType}-${jobId}`,
          fileName: "cover.jpg",
        });
        const coverUploaded = await this.mediaStorage.upload(coverCloudPath, coverPath);
        coverFileId = coverUploaded.fileId || "";
      }
      return { ...result, ...uploaded, coverFileId };
    } finally {
      fs.rmSync(outputPath, { force: true });
      fs.rmSync(coverPath, { force: true });
    }
  }

  async renderMaterialCover({ material } = {}) {
    if (!material?.id || !material.fileId || typeof this.renderer.captureCover !== "function") {
      return { coverFileId: "" };
    }
    fs.mkdirSync(this.tempDir, { recursive: true });
    const coverPath = path.join(this.tempDir, `cover-${stableHash(material.id).slice(0, 24)}.jpg`);
    try {
      const source = await this.mediaStorage.getReadUrl(material.fileId, 600);
      await this.renderer.captureCover(source, coverPath);
      const uploaded = await this.mediaStorage.upload(buildMediaCloudPath({
        ownerOpenid: material.ownerOpenid,
        deviceSn: material.deviceSn,
        date: material.date,
        jobId: `cover-${material.id}`,
        fileName: "cover.jpg",
      }), coverPath);
      return { coverFileId: uploaded.fileId || "" };
    } finally {
      fs.rmSync(coverPath, { force: true });
    }
  }

  async ensureDailyTimelines(materials = [], { signal } = {}) {
    if (!this.dailyTimelineAnalyzer) return materials;
    const resolved = [];
    for (const material of materials) {
      if (material?.kind !== "meal" || material.status !== "ready" || !material.fileId) {
        resolved.push(material);
        continue;
      }
      if (
        material.cuteTimelineVersion === DAILY_TIMELINE_VERSION
        && buildContinuityRequests([material]).requests.length
      ) {
        resolved.push(material);
        continue;
      }
      const durationSec = Number(material.durationSec);
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        throw codedError("DAILY_TIMELINE_DURATION_REQUIRED");
      }
      const sourceUrl = await this.mediaStorage.getReadUrl(material.fileId, 1800);
      const result = await this.dailyTimelineAnalyzer.analyzeRecording({
        sourceUrl,
        recordingKey: `foodcast-daily-${material.id}`,
        beginTime: formatDeviceDateTime(
          Number(material.mealStartMs) || Number(material.createdAt) || 0
        ),
        durationSec,
        detectionTarget: "cat",
        detectorBackend: this.dailyTimelineDetectorBackend,
        yoloModel: this.dailyTimelineYoloModel,
        orientation: this.dailyTimelineOrientation,
        autoBowlDetection: false,
        fixedBottomBowlRegion: true,
        cuteAnalysisAllScales: true,
        sampleSeconds: this.dailyTimelineSampleSeconds,
        signal,
      });
      const cuteTimeline = Array.isArray(result?.cuteTimeline) ? result.cuteTimeline : [];
      if (!cuteTimeline.length) {
        this.logger.warn?.("[foodcast-automation] daily timeline analysis produced no frames", {
          materialId: material.id,
          error: result?.error || "",
        });
        throw codedError("DAILY_TIMELINE_ANALYSIS_EMPTY");
      }
      const updated = {
        ...material,
        cuteTimeline,
        cuteTimelineVersion: DAILY_TIMELINE_VERSION,
        cuteTimelineAnalyzedAt: this.now(),
      };
      await this.catalog.putMaterial(updated);
      resolved.push(updated);
    }
    return resolved;
  }

  async processJob(jobId) {
    const job = await this.catalog.getJob(jobId);
    if (!job || job.status !== "running") return null;
    const nowMs = this.now();
    const priorityController = new AbortController();
    const checkPriority = () => {
      if (this.heavyWorkBlocked()) priorityController.abort("feeding-analysis-priority");
    };
    checkPriority();
    const priorityTimer = setInterval(checkPriority, this.priorityCheckIntervalMs);
    priorityTimer.unref?.();
    try {
      this.throwIfHeavyWorkBlocked();
      let mealMaterial = job.mealMaterialId
        ? await this.catalog.getMaterial(job.mealMaterialId)
        : null;
      if (!mealMaterial) {
        const mealSegments = job.meal.intervals.map(intervalToRenderSegment);
        const outputMapping = buildOutputMapping(job.meal.intervals);
        const result = await this.renderAndUpload({
          jobId,
          jobType: "meal_material",
          ownerOpenid: job.ownerOpenid,
          deviceSn: job.deviceSn,
          date: job.date,
          segments: mealSegments,
          audioMode: "source",
          bgm: null,
          outputMapping,
          signal: priorityController.signal,
        });
        mealMaterial = {
          id: `meal-material-${stableHash([job.meal.id, job.meal.version]).slice(0, 24)}`,
          kind: "meal",
          ownerOpenid: job.ownerOpenid,
          deviceSn: job.deviceSn,
          date: job.date,
          mealId: job.meal.id,
          mealVersion: job.meal.version,
          mealStartMs: job.meal.startMs,
          mealEndMs: job.meal.endMs,
          status: "ready",
          fileId: result.fileId,
          coverFileId: result.coverFileId || "",
          durationSec: result.durationSec,
          outputMapping: result.outputMapping || outputMapping,
          sourceClips: [...new Map(job.meal.intervals
            .map((interval) => interval?.source?.clip)
            .filter((clip) => clip?.id)
            .map((clip) => [clip.id, clip])).values()],
          createdAt: nowMs,
          expiresAt: nowMs + this.retentionMs,
        };
        await this.catalog.putMaterial(mealMaterial);
        await this.catalog.updateJob(jobId, { mealMaterialId: mealMaterial.id, status: "running" });
      }

      await this.updateDailyFeatured({
        ownerOpenid: job.ownerOpenid,
        deviceSn: job.deviceSn,
        date: job.date,
        nowMs,
        signal: priorityController.signal,
      });
      return this.catalog.updateJob(jobId, {
        status: "ready",
        leaseOwner: "",
        leaseExpiresAt: 0,
        updatedAt: nowMs,
      });
    } catch (error) {
      await this.catalog.updateJob(jobId, {
        status: "queued",
        leaseOwner: "",
        leaseExpiresAt: 0,
        errorCode: error.code || "AUTOMATION_FAILED",
        errorMessage: String(error.message || error),
        updatedAt: nowMs,
      });
      throw error;
    } finally {
      clearInterval(priorityTimer);
    }
  }

  async updateDailyFeatured({ ownerOpenid, deviceSn, date, nowMs, signal }) {
    const listedMaterials = await this.catalog.listMaterials({ ownerOpenid, deviceSn, date, nowMs });
    const materials = await this.ensureDailyTimelines(listedMaterials, { signal });
    const preferences = await this.resolvePreferences(ownerOpenid);
    const mode = preferences?.mode === "natural" ? "natural" : "quick_cut";
    const durationMode = ["compact", "standard", "rich"].includes(preferences?.durationMode)
      ? preferences.durationMode
      : "auto";
    const targetDurationSec = resolveDailyDurationBudget(materials, durationMode);
    const selection = await selectDailySegments(materials, targetDurationSec, this.dailySelector);
    const segments = selection.segments;
    const current = await this.catalog.getLatestDaily(ownerOpenid, deviceSn, date);
    if (!segments.length) return current?.materialId ? this.catalog.getMaterial(current.materialId) : null;
    const version = stableHash({
      mode,
      durationMode,
      targetDurationSec,
      algorithm: selection.algorithm,
      algorithmConfig: selection.config,
      segments: segments.map((segment) => [
        segment.materialId,
        segment.sourceOffsetSec,
        segment.durationSec,
        segment.peakScore,
        segment.peakCuteScore,
        segment.meanContinuityScore,
      ]),
    });
    if (current?.version === version) return this.catalog.getMaterial(current.materialId);
    const bgm = this.bgmLibrary.pick({ previousId: current?.bgm?.id || "" });
    if (!bgm?.id || !bgm?.filePath) throw codedError("BGM_LIBRARY_EMPTY");
    const dailyId = `daily-${version.slice(0, 24)}`;
    const result = await this.renderAndUpload({
      jobId: dailyId,
      jobType: "daily_featured",
      ownerOpenid,
      deviceSn,
      date,
      segments,
      mode,
      audioMode: "mix",
      bgm,
      bgmVolume: 0.85,
      signal,
    });
    const dailyMaterial = {
      id: dailyId,
      kind: "daily",
      ownerOpenid,
      deviceSn,
      date,
      status: "ready",
      fileId: result.fileId,
      coverFileId: result.coverFileId || "",
      durationSec: result.durationSec,
      mode,
      durationMode,
      targetDurationSec,
      algorithm: selection.algorithm,
      algorithmConfig: selection.config,
      bgm: { id: bgm.id },
      version,
      sourceMaterialIds: [...new Set(segments.map((segment) => segment.materialId))],
      selectedSegments: segments.map((segment) => ({
        materialId: segment.materialId,
        sourceOffsetSec: segment.sourceOffsetSec,
        durationSec: segment.durationSec,
        absoluteStartMs: segment.absoluteStartMs,
        peakScore: segment.peakScore,
        peakCuteScore: segment.peakCuteScore,
        meanContinuityScore: segment.meanContinuityScore,
      })),
      createdAt: nowMs,
      expiresAt: nowMs + this.retentionMs,
    };
    await this.catalog.putMaterial(dailyMaterial);
    const swapped = await this.catalog.swapLatestDaily(
      ownerOpenid,
      deviceSn,
      date,
      current?.materialId || null,
      { materialId: dailyId, fileId: result.fileId, version, bgm: { id: bgm.id } }
    );
    if (!swapped) {
      await this.mediaStorage.delete([result.fileId]);
      throw codedError("DAILY_VERSION_CONFLICT");
    }
    return dailyMaterial;
  }

  async cleanup(nowMs = this.now()) {
    const expired = await this.catalog.listExpiredArtifacts(nowMs);
    const expiredFileIds = await this.catalog.expireArtifacts(expired.map((item) => item.id), nowMs);
    for (const fileId of expiredFileIds) {
      if (fileId) this.pendingFileDeletes.add(fileId);
    }
    let deletedFiles = 0;
    const failures = [];
    const pending = [...this.pendingFileDeletes];
    for (let index = 0; index < pending.length; index += this.cleanupBatchSize) {
      const batch = pending.slice(index, index + this.cleanupBatchSize);
      try {
        await this.mediaStorage.delete(batch);
        for (const fileId of batch) this.pendingFileDeletes.delete(fileId);
        deletedFiles += batch.length;
      } catch (error) {
        failures.push({ fileIds: batch, error: error.code || error.message || "MEDIA_DELETE_FAILED" });
      }
    }
    return {
      artifacts: expired.length,
      files: deletedFiles,
      pendingFiles: this.pendingFileDeletes.size,
      failures,
    };
  }

  start() {
    if (this.timer) return;
    this.reconcile().catch((error) => console.warn("[foodcast-automation] reconcile failed", error.message));
    this.timer = setInterval(() => {
      this.reconcile().catch((error) => console.warn("[foodcast-automation] reconcile failed", error.message));
    }, this.pollIntervalMs);
    this.timer.unref?.();
    this.cleanup().catch((error) => console.warn("[foodcast-automation] cleanup failed", error.message));
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch((error) => console.warn("[foodcast-automation] cleanup failed", error.message));
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.timer = null;
    this.cleanupTimer = null;
  }
}

module.exports = {
  DAILY_TIMELINE_VERSION,
  FoodcastAutomationService,
  mealJobId,
  resolveDailyDurationBudget,
  selectDailySegments,
};
