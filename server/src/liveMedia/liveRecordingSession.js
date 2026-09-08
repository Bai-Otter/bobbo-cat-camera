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

function sanitizeFfmpegDiagnostic(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(token|password|secret|key)=\S+/gi, "$1=[redacted]")
    .slice(-4000);
}

function defaultId() {
  return crypto.randomUUID();
}

function defaultToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function safeFfmpegDiagnostic(value) {
  return String(value || "")
    .replace(/(?:https?|rtsp):\/\/\S+/gi, "[redacted-url]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .slice(-2000);
}

class LiveRecordingSession extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.ffmpegPath) throw codedError("FFMPEG_PATH_REQUIRED");
    if (!options.rootDir) throw codedError("LIVE_RECORDING_ROOT_REQUIRED");
    if (!options.store) throw codedError("LIVE_RECORDING_STORE_REQUIRED");
    if (!options.mediaStorage) throw codedError("LIVE_RECORDING_STORAGE_REQUIRED");
    this.ffmpegPath = options.ffmpegPath;
    this.rootDir = path.resolve(options.rootDir);
    this.store = options.store;
    this.mediaStorage = options.mediaStorage;
    this.spawn = options.spawn || childProcess.spawn;
    this.fsApi = options.fsApi || fsPromises;
    this.idFactory = options.idFactory || defaultId;
    this.tokenFactory = options.tokenFactory || defaultToken;
    this.now = options.now || Date.now;
    this.maxDurationSec = Math.max(1, Number(options.maxDurationSec) || 300);
    this.stopTimeoutMs = Math.max(1, Number(options.stopTimeoutMs) || 2500);
    this.minOutputBytes = Math.max(1, Number(options.minOutputBytes) || 1024);
    this.scheduleTimeout = options.scheduleTimeout || setTimeout;
    this.cancelTimeout = options.cancelTimeout || clearTimeout;
    this.logger = options.logger || console;
    this.resolveSourceUrl = options.resolveSourceUrl || null;
    this.state = "idle";
    this.process = null;
    this.job = null;
    this.partPath = "";
    this.finalPath = "";
    this.maxTimer = null;
    this.killTimer = null;
    this.finalizePromise = null;
    this.completion = null;
    this.resolveCompletion = null;
    this.rejectCompletion = null;
    this.ffmpegStderr = "";
  }

  async start(input = {}) {
    if (this.state !== "idle") throw codedError("RECORDING_ALREADY_STARTED");
    if (!input.ownerOpenid || !input.deviceSn) {
      throw codedError("LIVE_SESSION_NOT_FOUND");
    }
    if (!this.resolveSourceUrl
      && (!input.hlsSessionId || !/^https?:\/\//i.test(String(input.sourceUrl || "")))) {
      throw codedError("LIVE_SESSION_NOT_FOUND");
    }
    const createdAt = this.now();
    const id = this.idFactory();
    const accessToken = this.tokenFactory();
    this.job = await this.store.createJob({
      id,
      ownerOpenid: input.ownerOpenid,
      actorOpenid: input.actorOpenid || input.ownerOpenid,
      deviceSn: input.deviceSn,
      status: "starting",
      accessToken,
      createdAt,
      updatedAt: createdAt,
      expiresAt: createdAt + 24 * 60 * 60 * 1000,
    });
    this.completion = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    let sourceUrl = input.sourceUrl;
    if (this.resolveSourceUrl) {
      try {
        sourceUrl = await this.resolveSourceUrl({
          ownerOpenid: input.ownerOpenid,
          deviceSn: input.deviceSn,
          device: input.device,
        });
      } catch (error) {
        await this.fail(codedError("RECORDING_SOURCE_FAILED", error));
        return this.completion;
      }
    }
    if (!/^https?:\/\//i.test(String(sourceUrl || ""))) {
      await this.fail(codedError("RECORDING_SOURCE_FAILED"));
      return this.completion;
    }
    const outputDir = path.join(this.rootDir, id);
    this.partPath = path.join(outputDir, "recording.part.mp4");
    this.finalPath = path.join(outputDir, "recording.mp4");
    // Camera HLS is HEVC/hev1 on current hardware, which some WeChat album
    // implementations reject. Preserve its 1440p dimensions but emit AVC/AAC.
    const args = [
      "-hide_banner", "-loglevel", "warning", "-y",
      ...(input.httpProxy ? ["-http_proxy", String(input.httpProxy)] : []),
      "-i", sourceUrl,
      "-t", String(this.maxDurationSec),
      "-map", "0:v:0?", "-map", "0:a:0?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-vf", "scale=iw:ih:in_range=full:out_range=tv,format=yuv420p",
      "-tag:v", "avc1",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-f", "mp4",
      this.partPath,
    ];
    try {
      await this.fsApi.mkdir(outputDir, { recursive: true });
      this.process = this.spawn(this.ffmpegPath, args, {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      this.process.stderr?.on?.("data", (chunk) => {
        this.ffmpegStderr = `${this.ffmpegStderr}${String(chunk || "")}`.slice(-8000);
      });
      this.process.once("error", (error) => {
        void this.fail(codedError("RECORDING_PROCESS_FAILED", error));
      });
      this.process.once("close", () => {
        if (this.state === "failed") return;
        void this.finalize().catch(() => {});
      });
      this.state = "recording";
      this.job = await this.store.updateJob(id, { status: "recording", updatedAt: this.now() });
      this.maxTimer = this.scheduleTimeout(() => this.stop("timeout"), this.maxDurationSec * 1000);
      this.maxTimer?.unref?.();
      return { ...this.job };
    } catch (error) {
      const coded = error?.code ? error : codedError("RECORDING_START_FAILED", error);
      await this.fail(coded);
      this.process?.kill?.("SIGTERM");
      return this.completion;
    }
  }

  async stop() {
    if (this.state === "ready") return this.job;
    if (this.state === "failed") return this.completion;
    if (["stopping", "finalizing"].includes(this.state)) return this.completion;
    if (this.state !== "recording") throw codedError("RECORDING_NOT_ACTIVE");
    this.state = "stopping";
    if (this.maxTimer) this.cancelTimeout(this.maxTimer);
    if (this.process?.stdin && !this.process.stdin.writableEnded) this.process.stdin.write("q\n");
    this.killTimer = setTimeout(() => {
      if (!this.process || ["ready", "failed"].includes(this.state)) return;
      this.process.kill("SIGTERM");
      const hardKill = setTimeout(() => {
        if (this.process && !["ready", "failed"].includes(this.state)) this.process.kill("SIGKILL");
      }, this.stopTimeoutMs);
      hardKill.unref?.();
    }, this.stopTimeoutMs);
    this.killTimer.unref?.();
    return this.completion;
  }

  async finalize() {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizePromise = this.finishOutput();
    return this.finalizePromise;
  }

  async finishOutput() {
    if (this.maxTimer) this.cancelTimeout(this.maxTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.state = "finalizing";
    let stage = "finalizing-status";
    try {
      try {
        this.job = await this.store.updateJob(this.job.id, { status: "finalizing", updatedAt: this.now() });
      } catch (error) {
        // This status is informational. Do not destroy a complete local recording
        // because a transient cloud database write failed before the upload.
        this.logger.warn?.("[live-recording] finalizing status update failed; continuing", {
          recordingId: this.job.id,
          error: error?.code || error?.message || String(error),
        });
      }
      stage = "validate-output";
      let stat;
      try {
        stat = await this.fsApi.stat(this.partPath);
      } catch (error) {
        if (error?.code === "ENOENT") throw codedError("RECORDING_OUTPUT_INVALID", error);
        throw error;
      }
      if (!stat.isFile() || stat.size < this.minOutputBytes) throw codedError("RECORDING_OUTPUT_INVALID");
      stage = "rename-output";
      await this.fsApi.rename(this.partPath, this.finalPath);
      const date = new Date(this.job.createdAt).toISOString().slice(0, 10);
      const cloudPath = buildLiveRecordingCloudPath({
        ownerOpenid: this.job.ownerOpenid,
        deviceSn: this.job.deviceSn,
        date,
        jobId: this.job.id,
      });
      stage = "upload";
      const uploaded = await this.mediaStorage.upload(cloudPath, this.finalPath);
      const durationSec = Math.max(0, (this.now() - this.job.createdAt) / 1000);
      stage = "ready-status";
      this.job = await this.store.updateJob(this.job.id, {
        status: "ready",
        fileId: uploaded.fileId,
        outputSize: stat.size,
        durationSec,
        updatedAt: this.now(),
      });
      this.state = "ready";
      await this.cleanupFiles();
      this.resolveCompletion(this.job);
      this.emit("ready", this.job);
      return this.job;
    } catch (error) {
      const coded = stage === "validate-output" && error?.code === "ENOENT"
        ? codedError("RECORDING_OUTPUT_INVALID", error)
        : error?.code ? error : codedError("RECORDING_FINALIZE_FAILED", error);
      this.logger.error?.("[live-recording] finalize failed", {
        recordingId: this.job?.id || "",
        stage,
        error: coded.code || coded.message || String(coded),
        cause: error?.cause?.message || error?.message || String(error),
        ffmpeg: safeFfmpegDiagnostic(this.ffmpegStderr),
      });
      await this.fail(coded);
      throw coded;
    } finally {
      this.process = null;
    }
  }

  async fail(error) {
    if (this.state === "failed") return;
    if (this.maxTimer) this.cancelTimeout(this.maxTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.state = "failed";
    if (this.job) {
      this.job = await this.store.updateJob(this.job.id, {
        status: "failed",
        errorCode: error.code || "RECORDING_FAILED",
        updatedAt: this.now(),
      });
    }
    await this.cleanupFiles();
    this.rejectCompletion?.(error);
    this.emit("failed", error);
  }

  async cleanupFiles() {
    for (const filePath of [this.partPath, this.finalPath]) {
      if (!filePath) continue;
      try {
        await this.fsApi.unlink(filePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

module.exports = { LiveRecordingSession };
