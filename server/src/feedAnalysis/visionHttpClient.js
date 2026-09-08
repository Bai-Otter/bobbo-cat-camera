const { sanitizeAnalysisMarker } = require("./model");

function cleanTarget(value) {
  const target = String(value || "face").trim().toLowerCase();
  return target === "cat" ? "cat" : "face";
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

function stripSensitiveMarkerFields(marker = {}, fallback = {}) {
  const sanitized = sanitizeAnalysisMarker(marker, {
    recordingKey: fallback.recordingKey,
    target: fallback.target,
    endTimeFallbackToBegin: true,
  });
  return { ...sanitized, target: cleanTarget(sanitized.target) };
}

function emptyAnalysis(payload = {}, error = "") {
  return {
    recordingKey: payload.recordingKey || "",
    target: cleanTarget(payload.detectionTarget),
    hasCat: false,
    hasFeeding: false,
    analysisConfidence: 0,
    analysisStatus: "failed",
    bowlRoi: payload.bowlRoi || null,
    markers: [],
    cuteTimeline: [],
    frames: [],
    error,
  };
}

class VisionHttpAnalyzer {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || "").replace(/\/+$/, "");
    this.detectionTarget = cleanTarget(options.detectionTarget || "face");
    this.detectorBackend = String(options.detectorBackend || "auto");
    this.yoloModel = String(options.yoloModel || "");
    this.timeoutMs = Number(options.timeoutMs) || 45 * 1000;
    this.token = String(options.token || "");
    this.startupRetryMs = Math.max(0, Number(options.startupRetryMs) || 0);
    this.retryIntervalMs = Math.max(250, Number(options.retryIntervalMs) || 5000);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.sleepImpl = options.sleepImpl || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  async request(pathname, requestPayload, signal = null) {
    const startedAt = Date.now();
    let lastError = null;
    while (true) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = { "Content-Type": "application/json" };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(`VISION_HTTP_${response.status}`);
          error.statusCode = response.status;
          throw error;
        }
        return await response.json();
      } catch (error) {
        if (signal?.aborted) {
          const preempted = new Error("ANALYSIS_PREEMPTED");
          preempted.code = "ANALYSIS_PREEMPTED";
          throw preempted;
        }
        lastError = error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      }

      const retryableStatus = [429, 502, 503, 504].includes(Number(lastError?.statusCode));
      const retryableNetworkError = !Number.isFinite(Number(lastError?.statusCode));
      const retryDeadline = startedAt + this.startupRetryMs;
      if ((!retryableStatus && !retryableNetworkError) || Date.now() >= retryDeadline) throw lastError;
      const delayMs = Math.min(this.retryIntervalMs, Math.max(0, retryDeadline - Date.now()));
      if (delayMs <= 0) throw lastError;
      await this.sleepImpl(delayMs);
    }
  }

  async analyzeRecording(payload = {}) {
    if (!this.baseUrl) {
      return emptyAnalysis(payload, "VISION_BASE_URL_MISSING");
    }
    if (!this.fetchImpl) {
      return emptyAnalysis(payload, "FETCH_UNAVAILABLE");
    }

    const requestPayload = this.buildRequestPayload(payload);
    try {
      const parsed = await this.request("/analyze-recording", requestPayload, payload.signal);
      return this.normalizeResult(parsed, requestPayload);
    } catch (error) {
      if (payload.signal?.aborted) {
        const preempted = new Error("ANALYSIS_PREEMPTED");
        preempted.code = "ANALYSIS_PREEMPTED";
        throw preempted;
      }
      return emptyAnalysis(requestPayload, error.message || "VISION_HTTP_FAILED");
    }
  }

  async screenRecording(payload = {}) {
    return this.analyzeRecording({
      ...payload,
      screenOnly: true,
      sampleSeconds: Number(payload.sampleSeconds) || 2,
      sampleOffsetSeconds: Number(payload.sampleOffsetSeconds) || 0.5,
    });
  }

  async analyzeSnapshot(payload = {}) {
    if (!this.baseUrl) {
      return emptyAnalysis(payload, "VISION_BASE_URL_MISSING");
    }
    if (!this.fetchImpl) {
      return emptyAnalysis(payload, "FETCH_UNAVAILABLE");
    }

    const requestPayload = this.buildSnapshotRequestPayload(payload);
    try {
      const parsed = await this.request("/analyze-snapshot", requestPayload, payload.signal);
      return this.normalizeResult(parsed, requestPayload);
    } catch (error) {
      if (error?.code === "ANALYSIS_PREEMPTED") throw error;
      return emptyAnalysis(requestPayload, error.message || "VISION_HTTP_FAILED");
    }
  }

  buildRequestPayload(payload = {}) {
    const recording = payload.recording || {};
    const body = {
      sourceUrl: payload.sourceUrl || "",
      recording,
      recordingKey: payload.recordingKey || "",
      beginTime: payload.beginTime || recording.BeginTime || recording.beginTime || "",
      durationSec: Math.max(0, Number(payload.durationSec) || 0),
      bowlRoi: payload.bowlRoi || null,
      fixedBottomBowlRegion: !!payload.fixedBottomBowlRegion,
      autoBowlDetection: !!payload.autoBowlDetection,
      detectionTarget: cleanTarget(payload.detectionTarget || this.detectionTarget),
      detectorBackend: payload.detectorBackend || this.detectorBackend,
      orientation: payload.orientation || "none",
      adaptiveFeeding: !!payload.adaptiveFeeding,
      sampleSeconds: Math.min(10, Math.max(0.5, Number(payload.sampleSeconds) || 0.5)),
      sampleOffsetSeconds: Math.max(0, Number(payload.sampleOffsetSeconds) || 0),
      screenOnly: !!payload.screenOnly,
      cuteAnalysisAllScales: !!payload.cuteAnalysisAllScales,
      cutePolicy: payload.cutePolicy || null,
    };
    const yoloModel = payload.yoloModel || this.yoloModel;
    if (yoloModel) body.yoloModel = yoloModel;
    return body;
  }

  buildSnapshotRequestPayload(payload = {}) {
    const body = {
      snapshotUrl: payload.snapshotUrl || "",
      alarm: payload.alarm || {},
      bowlRoi: payload.bowlRoi || null,
      detectionTarget: cleanTarget(payload.detectionTarget || this.detectionTarget),
      detectorBackend: payload.detectorBackend || this.detectorBackend,
    };
    const yoloModel = payload.yoloModel || this.yoloModel;
    if (yoloModel) body.yoloModel = yoloModel;
    return body;
  }

  normalizeResult(result = {}, requestPayload = {}) {
    const target = cleanTarget(result.target || requestPayload.detectionTarget || this.detectionTarget);
    const markers = Array.isArray(result.markers)
      ? result.markers
          .filter((marker) => marker && typeof marker === "object" && !Array.isArray(marker))
          .map((marker) =>
            stripSensitiveMarkerFields(marker, {
              recordingKey: requestPayload.recordingKey,
              target,
            })
          )
      : [];
    const isSnapshotRequest = Object.prototype.hasOwnProperty.call(requestPayload, "snapshotUrl");
    return {
      recordingKey: result.recordingKey || requestPayload.recordingKey || "",
      target,
      hasCat: !!result.hasCat,
      hasFeeding: !!result.hasFeeding,
      analysisConfidence: Number(result.analysisConfidence) || 0,
      analysisStatus: result.error ? "failed" : "ready",
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
      bowlRoi: result.bowlRoi || requestPayload.bowlRoi || null,
      markers,
      cuteTimeline: target === "cat" && !isSnapshotRequest
        ? sanitizeCuteTimeline(result.cuteTimeline)
        : [],
      frames: Array.isArray(result.frames) ? result.frames : [],
      error: result.error || "",
    };
  }
}

module.exports = {
  VisionHttpAnalyzer,
  cleanTarget,
  stripSensitiveMarkerFields,
};
