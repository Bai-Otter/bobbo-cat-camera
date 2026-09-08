const fs = require("node:fs");
const path = require("node:path");

const { selectFoodcastSegments } = require("./model");

class FoodcastError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

class FoodcastService {
  constructor(options = {}) {
    this.store = options.store;
    this.outputDir = options.outputDir;
    this.retentionMs = Number(options.retentionMs) || 7 * 24 * 60 * 60 * 1000;
    this.maxStorageBytes = Number(options.maxStorageBytes) || 30 * 1024 * 1024 * 1024;
    this.maxRetries = Math.max(0, Number(options.maxRetries) || 0);
    this.retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 0);
    this.concurrency = Math.max(1, Number(options.concurrency) || 1);
    this.idFactory = options.idFactory;
    this.tokenFactory = options.tokenFactory;
    this.now = options.now || Date.now;
    this.getDiary = options.getDiary;
    this.bgmLibrary = options.bgmLibrary;
    this.renderer = options.renderer;
    this.resolveSource = options.resolveSource;
    this.queue = [];
    this.queuedIds = new Set();
    this.createInFlight = new Map();
    this.active = 0;
    this.pumpScheduled = false;
    this.store.recoverInterrupted();
    for (const job of this.store.listQueued()) this.enqueue(job.id);
  }

  async createFoodcast(input = {}) {
    const request = normalizeRequest(input);
    const generationKey = buildGenerationKey(request);
    const existing = this.createInFlight.get(generationKey);
    if (existing) return existing;

    const creation = this.createFoodcastForRequest(request);
    this.createInFlight.set(generationKey, creation);
    try {
      return await creation;
    } finally {
      if (this.createInFlight.get(generationKey) === creation) {
        this.createInFlight.delete(generationKey);
      }
    }
  }

  async createFoodcastForRequest(request) {
    const active = this.store.findActive(request);
    if (active) return active;

    const diary = await this.getDiary(request.deviceSn, request.date);
    const selectionRequest = {
      diary: diary || {},
      scope: request.scope,
      mealId: request.mealId,
      mode: request.mode,
      highlightRadiusSec: 5,
      minSegmentSec: 2,
      mergeGapSec: 1,
      maxSegments: 6,
      maxDurationSec: 60,
      fallbackMaxSegments: 2,
      fallbackMaxDurationSec: 20,
      targetDurationSec: request.targetDurationSec,
    };
    const segments = selectFoodcastSegments(selectionRequest);
    if (segments.length === 0) {
      throw new FoodcastError(request.mode === "quick_cut" ? "NO_CUTE_HIGHLIGHTS" : "NO_FEEDING_SEGMENTS");
    }

    let bgm;
    if (request.bgmSelection === "random") {
      const latest = this.store.findLatest(request);
      try {
        bgm = this.bgmLibrary.pick({ previousId: latest?.bgm?.id || "" });
      } catch (error) {
        throw new FoodcastError(error.code || error.message || "BGM_LIBRARY_EMPTY");
      }
    } else {
      bgm = this.bgmLibrary.get(request.bgmSelection);
      if (!bgm || bgm.id !== request.bgmSelection) {
        throw new FoodcastError("BGM_NOT_FOUND");
      }
    }

    const createdAt = this.now();
    const job = this.store.createJob({
      ...request,
      id: this.idFactory(),
      accessToken: this.tokenFactory(),
      createdAt,
      expiresAt: createdAt + this.retentionMs,
    });
    const queued = this.store.updateJob(job.id, { segments, bgm });
    this.enqueue(job.id);
    return queued;
  }

  enqueue(jobId) {
    if (this.queuedIds.has(jobId)) return;
    this.queuedIds.add(jobId);
    this.queue.push(jobId);
    if (!this.pumpScheduled) {
      this.pumpScheduled = true;
      setImmediate(() => {
        this.pumpScheduled = false;
        this.pump();
      });
    }
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const jobId = this.queue.shift();
      this.queuedIds.delete(jobId);
      this.active += 1;
      this.processJob(jobId)
        .catch(() => {})
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  async processJob(jobId) {
    let job = this.store.getJob(jobId);
    if (!job || job.status !== "queued") return;
    for (let attempt = job.attempts + 1; attempt <= this.maxRetries + 1; attempt += 1) {
      job = this.store.updateJob(jobId, {
        status: "running",
        stage: "preparing",
        progress: 5,
        attempts: attempt,
        errorCode: "",
        errorMessage: "",
      });
      try {
        const outputPath = path.join(this.outputDir, `${job.id}.mp4`);
        const result = await this.renderer.render({
          jobId: job.id,
          mode: job.mode,
          frameMode: job.frameMode,
          segments: job.segments,
          bgm: job.bgm,
          outputPath,
          resolveSource: (segment) => this.resolveSource({ job, segment }),
          onProgress: (progress) => {
            this.store.updateJob(job.id, { status: "running", stage: "rendering", progress });
          },
        });
        this.store.updateJob(job.id, {
          status: "ready",
          stage: "ready",
          progress: 100,
          outputPath,
          outputSize: result.outputSize,
          durationSec: result.durationSec,
        });
        return;
      } catch (error) {
        const errorCode = normalizeErrorCode(error);
        if (attempt <= this.maxRetries && errorCode !== "RECORDING_UNAVAILABLE") {
          this.store.updateJob(job.id, { status: "queued", stage: "retrying", progress: 0 });
          if (this.retryDelayMs) await delay(this.retryDelayMs);
          continue;
        }
        this.store.updateJob(job.id, {
          status: "failed",
          stage: "failed",
          progress: 0,
          errorCode,
          errorMessage: sanitizeError(error),
        });
        return;
      }
    }
  }

  getJob(id) {
    return this.store.getJob(id);
  }

  getLatest(input) {
    return this.store.findLatest(normalizeRequest(input));
  }

  getPublicJob(id, baseUrl = "") {
    const job = this.store.getJob(id);
    if (!job) return null;
    const publicJob = {
      id: job.id,
      deviceSn: job.deviceSn,
      date: job.date,
      scope: job.scope,
      mealId: job.mealId,
      mode: job.mode,
      frameMode: job.frameMode,
      targetDurationSec: job.targetDurationSec,
      bgmSelection: job.bgmSelection,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      attempts: job.attempts,
      errorCode: job.errorCode,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      expiresAt: job.expiresAt,
      bgm: job.bgm ? {
        id: job.bgm.id || "",
        title: job.bgm.title || "",
        artist: job.bgm.artist || "",
        licenseSource: job.bgm.licenseSource || "",
      } : null,
    };
    if (job.status === "ready") {
      const root = String(baseUrl || "").replace(/\/$/, "");
      publicJob.media = {
        url: `${root}/api/foodcasts/${encodeURIComponent(job.id)}/video?token=${encodeURIComponent(job.accessToken)}`,
        durationSec: job.durationSec,
        size: job.outputSize,
      };
    }
    return publicJob;
  }

  listBgmTracks(baseUrl = "") {
    const root = String(baseUrl || "").replace(/\/$/, "");
    return this.bgmLibrary.listPublic().map((track) => ({
      ...track,
      previewUrl: `${root}/api/foodcasts/bgm/${encodeURIComponent(track.id)}/audio`,
    }));
  }

  resolveBgmPreview(id) {
    const track = this.bgmLibrary.get(id);
    if (!track) throw new FoodcastError("BGM_NOT_FOUND");
    return track.filePath;
  }

  resolveMedia(id, accessToken) {
    const job = this.store.getJob(id);
    if (!job) throw new FoodcastError("FOODCAST_NOT_FOUND");
    if (job.status === "expired" || job.expiresAt <= this.now()) throw new FoodcastError("FOODCAST_EXPIRED");
    if (job.status !== "ready" || !job.outputPath || !fs.existsSync(job.outputPath)) {
      throw new FoodcastError("FOODCAST_NOT_READY");
    }
    if (!accessToken || accessToken !== job.accessToken) throw new FoodcastError("FOODCAST_FORBIDDEN");
    return job.outputPath;
  }

  cleanup() {
    const removed = [];
    const removeFile = (filePath) => {
      if (!filePath) return;
      fs.rmSync(filePath, { force: true });
      removed.push(filePath);
    };
    for (const filePath of this.store.expireBefore(this.now())) removeFile(filePath);

    const ready = this.store.listReadyOldest();
    let totalBytes = ready.reduce((sum, job) => sum + job.outputSize, 0);
    for (const job of ready) {
      if (totalBytes <= this.maxStorageBytes) break;
      this.store.expireJob(job.id);
      removeFile(job.outputPath);
      totalBytes -= job.outputSize;
    }
    return removed;
  }

  async waitForIdle() {
    while (this.active > 0 || this.queue.length > 0 || this.pumpScheduled) {
      await delay(1);
    }
  }
}

const MODE_TARGET_DURATION_SEC = Object.freeze({
  quick_cut: 60,
  natural: 60,
});

function normalizeRequest(input) {
  const deviceSn = String(input.deviceSn || "").trim();
  const date = String(input.date || "").trim();
  const scope = input.scope === "meal" ? "meal" : "day";
  const mealId = scope === "meal" ? String(input.mealId || "").trim() : "";
  const mode = input.mode === "quick_cut" ? "quick_cut" : "natural";
  const frameMode = input.frameMode === "center_crop" ? "center_crop" : "source";
  const targetDurationSec = normalizeTargetDurationSec(mode);
  const bgmSelection = normalizeBgmSelection(input.bgmId);
  if (!deviceSn || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (scope === "meal" && !mealId)) {
    throw new FoodcastError("INVALID_FOODCAST_REQUEST");
  }
  return { deviceSn, date, scope, mealId, mode, frameMode, targetDurationSec, bgmSelection };
}

function normalizeTargetDurationSec(mode) {
  return MODE_TARGET_DURATION_SEC[mode] || MODE_TARGET_DURATION_SEC.natural;
}

function normalizeBgmSelection(value) {
  if (value === undefined || value === null || value === "") return "random";
  if (typeof value !== "string") throw new FoodcastError("INVALID_FOODCAST_REQUEST");
  if (value === "random" || /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)) return value;
  throw new FoodcastError("INVALID_FOODCAST_REQUEST");
}

function buildGenerationKey(request) {
  return JSON.stringify([
    request.deviceSn,
    request.date,
    request.scope,
    request.mealId,
    request.mode,
    request.frameMode,
    request.targetDurationSec,
    request.bgmSelection,
  ]);
}

function normalizeErrorCode(error) {
  const code = String(error?.code || error?.message || "");
  if (code.includes("RECORDING_UNAVAILABLE")) return "RECORDING_UNAVAILABLE";
  if (code.includes("BGM_LIBRARY_EMPTY")) return "BGM_LIBRARY_EMPTY";
  return "TRANSCODE_FAILED";
}

function sanitizeError(error) {
  return String(error?.message || error || "TRANSCODE_FAILED")
    .replace(/https?:\/\/\S+/gi, "[media-url]")
    .slice(0, 500);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { FoodcastError, FoodcastService, normalizeRequest };
