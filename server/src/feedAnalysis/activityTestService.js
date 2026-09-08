const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { VisionWorkerAnalyzer } = require("./visionWorker");

const ALLOWED_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);

function codedError(code, statusCode = 400) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function finiteInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function cleanRejectionReasons(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, count] of Object.entries(value)) {
    const safeKey = String(key || "").trim().slice(0, 80);
    if (!safeKey) continue;
    result[safeKey] = Math.max(0, finiteInteger(count, 0));
  }
  return result;
}

function summarizeResult(result = {}) {
  const evidence = result.feedingEvidence && typeof result.feedingEvidence === "object"
    ? result.feedingEvidence
    : {};
  return {
    hasCat: !!result.hasCat,
    hasFeeding: !!result.hasFeeding,
    analysisConfidence: Number(result.analysisConfidence) || 0,
    candidateSeconds: Math.max(0, finiteInteger(evidence.candidateSeconds, 0)),
    verifiedSeconds: Math.max(0, finiteInteger(evidence.verifiedSeconds, 0)),
    maxConfidence: Number(evidence.maxConfidence) || 0,
    rejectionReasons: cleanRejectionReasons(evidence.rejectionReasons),
    framesSampled: Math.max(0, finiteInteger(result.framesSampled, 0)),
    durationMs: Math.max(0, finiteInteger(result.durationMs, 0)),
    detectorBackend: String(result.detectorBackend || "").slice(0, 40),
    detectorError: String(result.detectorError || "").slice(0, 240),
    error: String(result.error || "").slice(0, 240),
  };
}

function resolveControlledInput(inputDir, fileName) {
  const requested = String(fileName || "").trim();
  if (!requested || requested !== path.basename(requested)) {
    throw codedError("FEED_ANALYSIS_TEST_FILE_INVALID");
  }
  const extension = path.extname(requested).toLowerCase();
  if (!ALLOWED_VIDEO_EXTENSIONS.has(extension)) {
    throw codedError("FEED_ANALYSIS_TEST_FILE_TYPE_INVALID");
  }
  const root = path.resolve(inputDir);
  const resolved = path.resolve(root, requested);
  if (path.dirname(resolved) !== root) throw codedError("FEED_ANALYSIS_TEST_FILE_INVALID");
  return resolved;
}

function spawnProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish(() => reject(codedError("FEED_ANALYSIS_TEST_TRANSCODE_TIMEOUT", 504)));
    }, options.timeoutMs || 5 * 60 * 1000);
    proc.stderr.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    proc.once("error", () => {
      finish(() => reject(codedError("FEED_ANALYSIS_TEST_FFMPEG_UNAVAILABLE", 503)));
    });
    proc.once("close", (code) => {
      finish(() => {
        if (code === 0) return resolve();
        const error = codedError("FEED_ANALYSIS_TEST_TRANSCODE_FAILED", 422);
        error.detail = stderr.trim().split(/\r?\n/).slice(-1)[0] || "";
        reject(error);
      });
    });
  });
}

class FeedingActivityTestService {
  constructor(options = {}) {
    this.inputDir = options.inputDir || path.join(__dirname, "../../data/feed-analysis-test-inputs");
    this.tempDir = options.tempDir || path.join(os.tmpdir(), "bobbo-feed-analysis-tests");
    this.outputDir = options.outputDir || path.join(__dirname, "../../data/feed-analysis-test-results");
    this.ffmpegPath = options.ffmpegPath || "ffmpeg";
    this.maxFileBytes = Math.max(1, Number(options.maxFileBytes) || 512 * 1024 * 1024);
    this.maxDurationSec = Math.max(1, Number(options.maxDurationSec) || 1_200);
    this.defaultDurationSec = Math.min(
      this.maxDurationSec,
      Math.max(1, Number(options.defaultDurationSec) || 120)
    );
    this.transcodeTimeoutMs = Math.max(1_000, Number(options.transcodeTimeoutMs) || 10 * 60 * 1000);
    this.annotationScript = options.annotationScript || path.join(__dirname, "annotate_video.py");
    this.pythonPath = options.pythonPath || options.vision?.pythonPath || "python";
    this.analyzer = options.analyzer || new VisionWorkerAnalyzer(options.vision || {});
    this.runProcess = options.runProcess || spawnProcess;
    this.fs = options.fs || fs;
    this.logger = options.logger || console;
    this.jobs = new Map();
  }

  sanitizeTimeline(result = {}) {
    const frames = Array.isArray(result.frames) ? result.frames : [];
    return frames.slice(0, 10000).map((frame) => ({
      second: Math.max(0, finiteInteger(frame.second, 0)),
      offsetSec: Number.isFinite(Number(frame.offsetSec)) ? Number(frame.offsetSec) : Math.max(0, finiteInteger(frame.second, 0)),
      hasCat: !!frame.hasCat,
      nearBowl: !!frame.nearBowl,
      eatingVerified: !!frame.eatingVerified,
      confidence: Number(frame.confidence) || 0,
      behaviorEvidence: frame.behaviorEvidence && typeof frame.behaviorEvidence === "object" ? frame.behaviorEvidence : {},
      cuteEvidence: frame.cuteEvidence && typeof frame.cuteEvidence === "object" ? frame.cuteEvidence : {},
      catBoxes: Array.isArray(frame.catBoxes) ? frame.catBoxes : (Array.isArray(frame.targetBoxes) ? frame.targetBoxes : []),
      bowlRoi: frame.bowlRoi || result.bowlRoi || null,
    }));
  }

  async writeJson(filePath, value) {
    await this.fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  }

  getJob(jobId) { return this.jobs.get(String(jobId || "")) || null; }

  resolveArtifact(jobId, artifactName) {
    const job = this.getJob(jobId);
    if (!job) throw codedError("FEED_ANALYSIS_TEST_JOB_NOT_FOUND", 404);
    const artifact = job.artifacts?.find((item) => item.name === artifactName);
    if (!artifact) throw codedError("FEED_ANALYSIS_TEST_ARTIFACT_NOT_FOUND", 404);
    return artifact.path;
  }

  async analyze(input = {}) {
    const sourcePath = resolveControlledInput(this.inputDir, input.fileName);
    let stat;
    try {
      stat = await this.fs.promises.stat(sourcePath);
    } catch {
      throw codedError("FEED_ANALYSIS_TEST_FILE_NOT_FOUND", 404);
    }
    if (!stat.isFile()) throw codedError("FEED_ANALYSIS_TEST_FILE_NOT_FOUND", 404);
    if (stat.size > this.maxFileBytes) throw codedError("FEED_ANALYSIS_TEST_FILE_TOO_LARGE", 413);

    const requestedDuration = finiteInteger(input.durationSec, this.defaultDurationSec);
    if (requestedDuration < 1 || requestedDuration > this.maxDurationSec) {
      throw codedError("FEED_ANALYSIS_TEST_DURATION_INVALID");
    }
    const detectorBackend = ["auto", "yolo", "opencv"].includes(input.detectorBackend)
      ? input.detectorBackend
      : "auto";
    const startedAt = Date.now();
    const jobId = crypto.randomUUID();
    await this.fs.promises.mkdir(this.tempDir, { recursive: true });
    const outputPath = path.join(this.tempDir, jobId + ".mp4");
    const resultDir = path.join(this.outputDir, jobId);
    const verticalPath = path.join(resultDir, "vertical.mp4");
    const annotatedPath = path.join(resultDir, "annotated.mp4");
    const annotatedSilentPath = path.join(resultDir, "annotated-silent.mp4");
    const timelinePath = path.join(resultDir, "timeline.json");
    const summaryPath = path.join(resultDir, "summary.json");
    this.logger.info?.("[feeding-activity-test] started", {
      jobId,
      fileName: path.basename(sourcePath),
      durationSec: requestedDuration,
    });

    try {
      await this.fs.promises.mkdir(resultDir, { recursive: true });
      await this.runProcess(this.ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", sourcePath,
        "-t", String(requestedDuration),
        "-vf", "transpose=1",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        outputPath,
      ], { timeoutMs: this.transcodeTimeoutMs });
      await this.fs.promises.copyFile(outputPath, verticalPath);
      const result = await this.analyzer.analyzeRecording({
        sourceUrl: outputPath,
        recordingKey: `activity-test-${jobId}`,
        beginTime: "2026-01-01 00:00:00",
        detectionTarget: "cat",
        detectorBackend,
        autoBowlDetection: input.autoBowlDetection !== false,
      });
      const summary = summarizeResult(result);
      const timeline = this.sanitizeTimeline(result);
      await this.writeJson(timelinePath, { jobId, fileName: path.basename(sourcePath), orientation: "clockwise-90", frames: timeline });
      await this.writeJson(summaryPath, { jobId, fileName: path.basename(sourcePath), orientation: "clockwise-90", analyzedDurationSec: requestedDuration, summary, timelineFrames: timeline.length });
      try {
        await this.runProcess(this.pythonPath, [this.annotationScript, verticalPath, timelinePath, annotatedSilentPath], { timeoutMs: this.transcodeTimeoutMs });
        await this.runProcess(this.ffmpegPath, [
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", annotatedSilentPath, "-i", verticalPath,
          "-map", "0:v:0", "-map", "1:a?",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", annotatedPath,
        ], { timeoutMs: this.transcodeTimeoutMs });
      } catch (error) {
        this.logger.warn?.("[feeding-activity-test] annotation failed", { jobId, error: error.message });
      } finally {
        await this.fs.promises.rm(annotatedSilentPath, { force: true }).catch(() => {});
      }
      const files = [verticalPath, annotatedPath, timelinePath, summaryPath];
      const artifacts = [];
      for (const filePath of files) {
        try { const fileStat = await this.fs.promises.stat(filePath); artifacts.push({ name: path.basename(filePath), path: filePath, sizeBytes: fileStat.size }); } catch {}
      }
      const elapsedMs = Date.now() - startedAt;
      this.logger.info?.("[feeding-activity-test] completed", {
        jobId, elapsedMs, framesSampled: summary.framesSampled, error: summary.error || undefined,
      });
      const response = {
        jobId,
        fileName: path.basename(sourcePath),
        orientation: "clockwise-90",
        analyzedDurationSec: requestedDuration,
        elapsedMs,
        summary,
        artifacts: artifacts.map(({ name, sizeBytes }) => ({ name, sizeBytes })),
      };
      this.jobs.set(jobId, { ...response, artifacts });
      return response;
    } finally {
      await this.fs.promises.rm(outputPath, { force: true }).catch(() => {});
    }
  }
}

module.exports = {
  FeedingActivityTestService,
  resolveControlledInput,
  spawnProcess,
  summarizeResult,
};
