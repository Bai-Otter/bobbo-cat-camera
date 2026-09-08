const path = require("path");
const childProcess = require("child_process");
const { sanitizeAnalysisMarker } = require("./model");

function parseWorkerOutput(stdout = "") {
  const text = String(stdout || "").trim();
  try {
    return JSON.parse(text || "{}");
  } catch (initialError) {
    for (let index = text.lastIndexOf("{"); index >= 0; index = text.lastIndexOf("{", index - 1)) {
      try {
        return JSON.parse(text.slice(index));
      } catch (error) {
        // Dependency progress logs can precede the worker's final JSON object.
      }
    }
    throw initialError;
  }
}

function finiteNumber(value) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  } catch (error) {
    return 0;
  }
}

function boundedScore(value) {
  return Math.max(0, Math.min(1, finiteNumber(value)));
}

function normalizeCuteReasons(value) {
  const candidates = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return [...new Set(candidates.filter((reason) => typeof reason === "string"))];
}

function sanitizeCuteTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  return timeline
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const base = {
      offsetSec: finiteNumber(item.offsetSec),
      cuteScore: boundedScore(item.cuteScore),
      modelConfidence: boundedScore(item.modelConfidence),
      cuteReasons: normalizeCuteReasons(item.cuteReasons),
      hasCat: typeof item.hasCat === "boolean" ? item.hasCat : false,
      };
      if (!Object.prototype.hasOwnProperty.call(item, "faceRelation")) return base;
      return {
        ...base,
        faceRelation: typeof item.faceRelation === "string" ? item.faceRelation : "unknown",
        relationConfidence: boundedScore(item.relationConfidence),
        strictEligible: item.strictEligible === true,
        looseEligible: item.looseEligible === true,
        sizeScore: boundedScore(item.sizeScore),
        cameraScore: boundedScore(item.cameraScore),
        pitchScore: boundedScore(item.pitchScore),
        visibilityScore: boundedScore(item.visibilityScore),
      };
    });
}

class VisionWorkerAnalyzer {
  constructor(options = {}) {
    this.pythonPath = options.pythonPath || "python";
    this.workerScript = options.workerScript || path.join(__dirname, "vision_worker.py");
    this.fineWorkerScript = options.fineWorkerScript || this.workerScript;
    this.minConfidence = Number(options.minConfidence) || 0.35;
    this.timeoutMs = Number(options.timeoutMs) || 12 * 60 * 1000;
  }

  runWorker(workerPayload, fallbackPayload = {}, signal = null, workerScript = this.workerScript) {
    return new Promise((resolve, reject) => {
      const proc = childProcess.spawn(this.pythonPath, [workerScript], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        proc.kill();
        const error = new Error("ANALYSIS_PREEMPTED");
        error.code = "ANALYSIS_PREEMPTED";
        finish(() => reject(error));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        proc.kill();
        finish(() => reject(new Error("VISION_WORKER_TIMEOUT")));
      }, this.timeoutMs);

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", (error) => {
        clearTimeout(timer);
        finish(() => reject(error));
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        if (code !== 0) {
          finish(() => reject(new Error(stderr.trim() || `VISION_WORKER_EXIT_${code}`)));
          return;
        }
        try {
          const parsed = parseWorkerOutput(stdout);
          finish(() => resolve(this.normalizeResult(parsed, {
            includeCuteTimeline: workerPayload.mode === "recording" && workerPayload.detectionTarget !== "face",
          })));
        } catch (error) {
          finish(() => reject(new Error(`VISION_WORKER_PARSE_ERROR: ${error.message}`)));
        }
      });

      proc.stdin.write(
        JSON.stringify({
          ...workerPayload,
          minConfidence: this.minConfidence,
        })
      );
      proc.stdin.end();
    }).catch((error) => {
      if (error?.code === "ANALYSIS_PREEMPTED") throw error;
      return {
        hasCat: false,
        hasFeeding: false,
        analysisConfidence: 0,
        bowlRoi: fallbackPayload.bowlRoi || null,
        markers: [],
        cuteTimeline: [],
        error: error.message,
      };
    });
  }

  analyzeRecording(payload = {}) {
    return this.runWorker(
      {
        mode: "recording",
        sourceUrl: payload.sourceUrl || "",
        recording: payload.recording || {},
        recordingKey: payload.recordingKey || "",
        beginTime: payload.beginTime || "",
        durationSec: Math.max(0, Number(payload.durationSec) || 0),
        bowlRoi: payload.bowlRoi || null,
        detectionTarget: payload.detectionTarget || "cat",
        detectorBackend: payload.detectorBackend || "auto",
        yoloModel: payload.yoloModel || "",
        autoBowlDetection: !!payload.autoBowlDetection,
        fixedBottomBowlRegion: !!payload.fixedBottomBowlRegion,
        orientation: payload.orientation || "none",
        adaptiveFeeding: !!payload.adaptiveFeeding,
        sampleSeconds: Math.min(10, Math.max(0.5, Number(payload.sampleSeconds) || 0.5)),
        cuteAnalysisAllScales: !!payload.cuteAnalysisAllScales,
        cutePolicy: payload.cutePolicy || null,
      },
      payload,
      payload.signal,
      this.fineWorkerScript
    );
  }

  screenRecording(payload = {}) {
    return this.runWorker(
      {
        mode: "recording",
        screenOnly: true,
        sourceUrl: payload.sourceUrl || "",
        recording: payload.recording || {},
        recordingKey: payload.recordingKey || "",
        beginTime: payload.beginTime || "",
        durationSec: Math.max(0, Number(payload.durationSec) || 0),
        bowlRoi: null,
        detectionTarget: "cat",
        detectorBackend: payload.detectorBackend || "auto",
        yoloModel: payload.yoloModel || "",
        autoBowlDetection: false,
        orientation: payload.orientation || "none",
        sampleSeconds: Math.min(10, Math.max(1, Number(payload.sampleSeconds) || 2)),
        sampleOffsetSeconds: Math.max(0, Number(payload.sampleOffsetSeconds) || 0.5),
      },
      payload,
      payload.signal
    );
  }

  analyzeSnapshot(payload = {}) {
    return this.runWorker(
      {
        mode: "snapshot",
        snapshotUrl: payload.snapshotUrl || "",
        alarm: payload.alarm || {},
        bowlRoi: payload.bowlRoi || null,
      },
      payload,
      payload.signal
    );
  }

  normalizeResult(result = {}, options = {}) {
    const target = result.target || "";
    return {
      recordingKey: result.recordingKey || "",
      target,
      hasCat: !!result.hasCat,
      hasFeeding: !!result.hasFeeding,
      analysisConfidence: Number(result.analysisConfidence) || 0,
      framesSampled: Math.max(0, Math.trunc(finiteNumber(result.framesSampled))),
      durationMs: Math.max(0, Math.trunc(finiteNumber(result.durationMs))),
      detectorBackend: String(result.detectorBackend || ""),
      detectorError: String(result.detectorError || ""),
      feedingEvidence: result.feedingEvidence || {
        candidateSeconds: 0,
        verifiedSeconds: 0,
        maxConfidence: 0,
        rejectionReasons: {},
      },
      bowlRoi: result.bowlRoi || null,
      markers: Array.isArray(result.markers)
        ? result.markers
            .filter((item) => item && typeof item === "object" && !Array.isArray(item))
            .map((item) => sanitizeAnalysisMarker(item, {
              target,
              endTimeFallbackToBegin: true,
            }))
        : [],
      cuteTimeline: options.includeCuteTimeline && target !== "face"
        ? sanitizeCuteTimeline(result.cuteTimeline)
        : [],
      frames: Array.isArray(result.frames) ? result.frames : [],
      error: result.error || "",
    };
  }
}

module.exports = { VisionWorkerAnalyzer };
