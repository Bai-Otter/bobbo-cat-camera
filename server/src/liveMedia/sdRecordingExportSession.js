const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const { buildLiveRecordingCloudPath } = require("../foodcast/mediaStorage");

function codedError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function finalizeError(error) {
  return error?.code ? error : codedError("RECORDING_FINALIZE_FAILED", error);
}

function quoteConcatValue(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function buildConcatManifest(windows) {
  const lines = ["ffconcat version 1.0"];
  for (const item of windows) {
    lines.push(`file ${quoteConcatValue(item.sourceUrl)}`);
    if (Number(item.inpointSec) > 0) lines.push(`inpoint ${Number(item.inpointSec).toFixed(3)}`);
    if (Number(item.outpointSec) > 0) lines.push(`outpoint ${Number(item.outpointSec).toFixed(3)}`);
  }
  return `${lines.join("\n")}\n`;
}

class SdRecordingExportSession extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.ffmpegPath) throw codedError("FFMPEG_PATH_REQUIRED");
    if (!options.rootDir) throw codedError("LIVE_RECORDING_ROOT_REQUIRED");
    if (!options.store) throw codedError("LIVE_RECORDING_STORE_REQUIRED");
    if (!options.mediaStorage) throw codedError("LIVE_RECORDING_STORAGE_REQUIRED");
    if (typeof options.resolveRecordingWindow !== "function") throw codedError("RECORDING_WINDOW_RESOLVER_REQUIRED");
    this.ffmpegPath = options.ffmpegPath;
    this.rootDir = path.resolve(options.rootDir);
    this.store = options.store;
    this.mediaStorage = options.mediaStorage;
    this.resolveRecordingWindow = options.resolveRecordingWindow;
    this.spawn = options.spawn || childProcess.spawn;
    this.fsApi = options.fsApi || fsPromises;
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.tokenFactory = options.tokenFactory || (() => crypto.randomBytes(24).toString("base64url"));
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.discoveryTimeoutMs = Math.max(1, Number(options.discoveryTimeoutMs) || 60_000);
    this.discoveryIntervalMs = Math.max(100, Number(options.discoveryIntervalMs) || 500);
    this.maxDurationSec = Math.max(1, Number(options.maxDurationSec) || 300);
    this.minOutputBytes = Math.max(1, Number(options.minOutputBytes) || 1024);
    this.logger = options.logger || console;
    this.state = "idle";
    this.job = null;
    this.device = options.device || null;
    this.outputDir = "";
    this.manifestPath = "";
    this.outputPath = "";
    this.completion = null;
    this.maxTimer = null;
  }

  async start(input = {}) {
    if (this.state !== "idle") throw codedError("RECORDING_ALREADY_STARTED");
    if (!input.ownerOpenid || !input.deviceSn) throw codedError("DEVICE_NOT_FOUND");
    if (input.device) this.device = input.device;
    const startedAt = this.now();
    this.job = await this.store.createJob({
      id: this.idFactory(),
      ownerOpenid: input.ownerOpenid,
      deviceSn: input.deviceSn,
      status: "recording",
      accessToken: this.tokenFactory(),
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
      expiresAt: startedAt + 24 * 60 * 60 * 1000,
    });
    this.state = "recording";
    this.maxTimer = setTimeout(() => { void this.stop().catch(() => {}); }, this.maxDurationSec * 1000);
    this.maxTimer.unref?.();
    return { ...this.job };
  }

  async exportWindow(input = {}) {
    if (this.state !== "idle") throw codedError("RECORDING_ALREADY_STARTED");
    if (!input.ownerOpenid || !input.deviceSn) throw codedError("DEVICE_NOT_FOUND");
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    const durationSec = (endedAt - startedAt) / 1000;
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || durationSec <= 0) {
      throw codedError("RECORDING_WINDOW_INVALID");
    }
    if (durationSec > this.maxDurationSec) throw codedError("RECORDING_DURATION_EXCEEDED");
    if (input.device) this.device = input.device;
    const createdAt = this.now();
    this.job = await this.store.createJob({
      id: this.idFactory(),
      ownerOpenid: input.ownerOpenid,
      actorOpenid: input.actorOpenid || input.ownerOpenid,
      deviceSn: input.deviceSn,
      status: "finalizing",
      accessToken: this.tokenFactory(),
      startedAt,
      endedAt,
      durationSec,
      createdAt,
      updatedAt: createdAt,
      expiresAt: createdAt + 24 * 60 * 60 * 1000,
    });
    this.state = "finalizing";
    this.completion = this.finalize().catch((error) => {
      const failure = finalizeError(error);
      this.logger.error?.("[sd-recording-export] historical finalize failed", {
        recordingId: this.job?.id || "",
        errorCode: failure.code,
        cause: error?.message || String(error),
      });
      return this.fail(failure);
    });
    return { ...this.job };
  }

  async stop() {
    if (this.state === "finalizing" || this.state === "ready" || this.state === "failed") return { ...this.job };
    if (this.state !== "recording") throw codedError("RECORDING_NOT_ACTIVE");
    if (this.maxTimer) clearTimeout(this.maxTimer);
    const endedAt = this.now();
    this.state = "finalizing";
    this.job = await this.store.updateJob(this.job.id, {
      status: "finalizing",
      endedAt,
      durationSec: Math.max(0, (endedAt - this.job.startedAt) / 1000),
      updatedAt: endedAt,
    });
    this.completion = this.finalize().catch((error) => {
      const failure = finalizeError(error);
      this.logger.error?.("[sd-recording-export] finalize failed", {
        recordingId: this.job?.id || "",
        errorCode: failure.code,
        cause: error?.message || String(error),
      });
      return this.fail(failure);
    });
    return { ...this.job };
  }

  async discoverWindows() {
    const deadline = this.now() + this.discoveryTimeoutMs;
    do {
      const windows = await this.resolveRecordingWindow({
        ownerOpenid: this.job.ownerOpenid,
        deviceSn: this.job.deviceSn,
        device: this.device,
        startedAt: this.job.startedAt,
        endedAt: this.job.endedAt,
      });
      if (Array.isArray(windows) && windows.length > 0) return windows;
      await this.sleep(this.discoveryIntervalMs);
    } while (this.now() < deadline);
    throw codedError("RECORDING_WINDOW_NOT_READY");
  }

  async finalize() {
    const windows = await this.discoverWindows();
    this.outputDir = path.join(this.rootDir, this.job.id);
    this.manifestPath = path.join(this.outputDir, "sources.ffconcat");
    this.outputPath = path.join(this.outputDir, "recording.mp4");
    await this.fsApi.mkdir(this.outputDir, { recursive: true });
    await this.fsApi.writeFile(this.manifestPath, buildConcatManifest(windows), "utf8");
    await this.runFfmpeg();
    const stat = await this.fsApi.stat(this.outputPath);
    if (!stat.isFile() || stat.size < this.minOutputBytes) throw codedError("RECORDING_OUTPUT_INVALID");
    const date = new Date(this.job.startedAt).toISOString().slice(0, 10);
    const cloudPath = buildLiveRecordingCloudPath({
      ownerOpenid: this.job.ownerOpenid,
      deviceSn: this.job.deviceSn,
      date,
      jobId: this.job.id,
    });
    const uploaded = await this.mediaStorage.upload(cloudPath, this.outputPath);
    this.job = await this.store.updateJob(this.job.id, {
      status: "ready",
      fileId: uploaded.fileId,
      outputSize: stat.size,
      updatedAt: this.now(),
    });
    this.state = "ready";
    await this.cleanupFiles();
    this.emit("ready", this.job);
    return { ...this.job };
  }

  runFfmpeg() {
    const args = [
      "-hide_banner", "-loglevel", "warning", "-y",
      "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
      "-f", "concat", "-safe", "0", "-i", this.manifestPath,
      "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy",
      "-movflags", "+faststart", this.outputPath,
    ];
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(this.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      } catch (error) {
        reject(codedError("RECORDING_EXPORT_START_FAILED", error));
        return;
      }
      child.stderr?.on?.("data", (chunk) => {
        const text = String(chunk || "").trim();
        if (text) this.logger.warn?.("[sd-recording-export] ffmpeg", text);
      });
      child.once("error", (error) => reject(codedError("RECORDING_EXPORT_FAILED", error)));
      child.once("close", (code) => code === 0 ? resolve() : reject(codedError("RECORDING_EXPORT_FAILED")));
    });
  }

  async fail(error) {
    this.state = "failed";
    this.job = await this.store.updateJob(this.job.id, {
      status: "failed",
      errorCode: error?.code || "RECORDING_EXPORT_FAILED",
      updatedAt: this.now(),
    });
    await this.cleanupFiles();
    this.emit("failed", error);
    return { ...this.job };
  }

  async cleanupFiles() {
    if (!this.outputDir) return;
    await this.fsApi.rm(this.outputDir, { recursive: true, force: true });
  }
}

module.exports = { SdRecordingExportSession, buildConcatManifest };
