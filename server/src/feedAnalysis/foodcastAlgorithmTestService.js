const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BgmLibrary } = require("../foodcast/bgmLibrary");
const { FoodcastRenderer } = require("../foodcast/renderer");
const { selectFoodcastSegments } = require("../foodcast/model");
const { VisionWorkerAnalyzer } = require("./visionWorker");
const { resolveControlledInput, spawnProcess } = require("./activityTestService");

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function localTimeMs(value) {
  const date = new Date(String(value || "").replace(/-/g, "/"));
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function summarizeMarkerTypes(markers) {
  return [...new Set((markers || []).map((item) => String(item?.markerType || "")).filter(Boolean))];
}

function sanitizeTimeline(result = {}) {
  return (Array.isArray(result.frames) ? result.frames : []).slice(0, 10000).map((frame) => {
    const cuteEvidence = frame.cuteEvidence && typeof frame.cuteEvidence === "object" ? frame.cuteEvidence : {};
    return {
    second: Math.max(0, Math.trunc(finiteNumber(frame.second))),
    offsetSec: Math.max(0, finiteNumber(frame.offsetSec, finiteNumber(frame.second))),
    hasCat: !!frame.hasCat,
    nearBowl: !!frame.nearBowl,
    eatingVerified: !!frame.eatingVerified,
    confidence: finiteNumber(frame.confidence),
    presenceSource: String(frame.presenceSource || ""),
    presenceConfidence: finiteNumber(frame.presenceConfidence, finiteNumber(frame.confidence)),
    presenceStabilized: frame.presenceStabilized !== false && !!frame.hasCat,
    faceRelation: String(frame.faceRelation || cuteEvidence.faceRelation || ""),
    behaviorEvidence: frame.behaviorEvidence && typeof frame.behaviorEvidence === "object" ? frame.behaviorEvidence : {},
    cuteEvidence,
    catBoxes: Array.isArray(frame.catBoxes) ? frame.catBoxes : (Array.isArray(frame.targetBoxes) ? frame.targetBoxes : []),
    bowlRoi: frame.bowlRoi || result.bowlRoi || null,
    };
  });
}

function normalizeSegments(publicSegments, clip, sourcePath) {
  const clipStartMs = localTimeMs(clip.beginTime);
  return publicSegments.map((segment) => ({
    ...segment,
    sourceOffsetSec: Math.max(0, (localTimeMs(segment.startTime) - clipStartMs) / 1000),
    sourceStartMs: localTimeMs(segment.startTime),
    sourceEndMs: localTimeMs(segment.endTime),
    playbackParams: { ...(segment.playbackParams || {}), fileName: sourcePath },
  }));
}

function deriveVerifiedFeedingMarkers(timeline) {
  const timestamp = (seconds) => {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `2026-01-01 ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };
  const verified = timeline
    .filter((frame) => frame.eatingVerified)
    .sort((a, b) => a.offsetSec - b.offsetSec);
  if (!verified.length) return [];
  const runs = [];
  for (const frame of verified) {
    const previous = runs[runs.length - 1];
    if (!previous || frame.offsetSec - previous.endSec > 3) {
      runs.push({ startSec: frame.offsetSec, endSec: frame.offsetSec });
    } else {
      previous.endSec = frame.offsetSec;
    }
  }
  return runs
    .filter((run) => run.endSec - run.startSec >= 2)
    .flatMap((run) => [
      { markerType: "feeding_start", beginTime: timestamp(run.startSec) },
      { markerType: "feeding_end", beginTime: timestamp(run.endSec) },
    ]);
}

class FoodcastAlgorithmTestService {
  constructor(options = {}) {
    this.inputDir = options.inputDir || path.join(__dirname, "../../data/feed-analysis-test-inputs");
    this.outputDir = options.outputDir || path.join(os.tmpdir(), "bobbo-foodcast-algorithm-results");
    this.tempDir = options.tempDir || path.join(os.tmpdir(), "bobbo-foodcast-algorithm-temp");
    this.ffmpegPath = options.ffmpegPath || "ffmpeg";
    this.pythonPath = options.pythonPath || "python";
    this.annotationScript = options.annotationScript || path.join(__dirname, "annotate_video.py");
    this.maxFileBytes = Math.max(1, Number(options.maxFileBytes) || 512 * 1024 * 1024);
    this.transcodeTimeoutMs = Math.max(60_000, Number(options.transcodeTimeoutMs) || 20 * 60 * 1000);
    this.runProcess = options.runProcess || spawnProcess;
    this.fs = options.fs || fs;
    this.logger = options.logger || console;
    this.analyzer = options.analyzer || new VisionWorkerAnalyzer({
      pythonPath: this.pythonPath,
      workerScript: options.workerScript,
      timeoutMs: this.transcodeTimeoutMs,
    });
    this.renderer = options.renderer || new FoodcastRenderer({
      rootDir: this.tempDir,
      ffmpegPath: this.ffmpegPath,
    });
    this.bgmLibrary = options.bgmLibrary || new BgmLibrary({
      dir: options.bgmDir || path.join(__dirname, "../../../bgm"),
    });
    this.jobs = new Map();
  }

  getJob(jobId) { return this.jobs.get(String(jobId || "")) || null; }

  resolveArtifact(jobId, name) {
    const job = this.getJob(jobId);
    if (!job) throw Object.assign(new Error("FOODCAST_ALGORITHM_TEST_JOB_NOT_FOUND"), { code: "FOODCAST_ALGORITHM_TEST_JOB_NOT_FOUND", statusCode: 404 });
    const artifact = job.artifacts.find((item) => item.name === name);
    if (!artifact) throw Object.assign(new Error("FOODCAST_ALGORITHM_TEST_ARTIFACT_NOT_FOUND"), { code: "FOODCAST_ALGORITHM_TEST_ARTIFACT_NOT_FOUND", statusCode: 404 });
    return artifact.path;
  }

  async analyze(input = {}) {
    const sourcePath = resolveControlledInput(this.inputDir, input.fileName);
    const stat = await this.fs.promises.stat(sourcePath).catch(() => null);
    if (!stat?.isFile()) throw Object.assign(new Error("FOODCAST_ALGORITHM_TEST_FILE_NOT_FOUND"), { code: "FOODCAST_ALGORITHM_TEST_FILE_NOT_FOUND", statusCode: 404 });
    if (stat.size > this.maxFileBytes) throw Object.assign(new Error("FOODCAST_ALGORITHM_TEST_FILE_TOO_LARGE"), { code: "FOODCAST_ALGORITHM_TEST_FILE_TOO_LARGE", statusCode: 413 });
    const durationSec = Math.max(1, Math.min(1200, Math.trunc(Number(input.durationSec) || 120)));
    const bowlRoi = input.bowlRoi || { x: 0, y: 390, width: 368, height: 250 };
    const jobId = crypto.randomUUID();
    const resultDir = path.join(this.outputDir, jobId);
    const tempInput = path.join(this.tempDir, `${jobId}.mp4`);
    const verticalPath = path.join(resultDir, "vertical.mp4");
    const annotatedSilentPath = path.join(resultDir, "annotated-silent.mp4");
    const annotatedPath = path.join(resultDir, "annotated.mp4");
    const strictFoodcastPath = path.join(resultDir, "strict-foodcast.mp4");
    const looseFoodcastPath = path.join(resultDir, "loose-foodcast.mp4");
    const legacyFoodcastPath = path.join(resultDir, "foodcast.mp4");
    const timelinePath = path.join(resultDir, "timeline.json");
    const strictTimelinePath = path.join(resultDir, "strict-timeline.json");
    const looseTimelinePath = path.join(resultDir, "loose-timeline.json");
    const summaryPath = path.join(resultDir, "summary.json");
    await this.fs.promises.mkdir(resultDir, { recursive: true });
    await this.fs.promises.mkdir(this.tempDir, { recursive: true });

    try {
      await this.runProcess(this.ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
        "-t", String(durationSec), "-vf", "transpose=1",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", tempInput,
      ], { timeoutMs: this.transcodeTimeoutMs });
      await this.fs.promises.copyFile(tempInput, verticalPath);

      const result = await this.analyzer.analyzeRecording({
        sourceUrl: tempInput,
        recordingKey: `foodcast-algorithm-test-${jobId}`,
        beginTime: "2026-01-01 00:00:00",
        bowlRoi,
        detectionTarget: "cat",
        detectorBackend: input.detectorBackend === "opencv" ? "opencv" : "yolo",
        yoloModel: input.yoloModel || path.join(__dirname, "../../vision/models/yolo11s.pt"),
        autoBowlDetection: false,
        cuteAnalysisAllScales: true,
        cutePolicy: input.cutePolicy || null,
      });
      const timeline = sanitizeTimeline(result);
      await this.fs.promises.writeFile(timelinePath, JSON.stringify({ jobId, fileName: path.basename(sourcePath), orientation: "clockwise-90", frames: timeline }, null, 2), "utf8");

      const derivedFeedingMarkers = deriveVerifiedFeedingMarkers(timeline);
      const clip = {
        id: `foodcast-test-${jobId}`,
        beginTime: "2026-01-01 00:00:00",
        endTime: `2026-01-01 00:02:00`,
        fileName: tempInput,
        analysisConfidence: result.analysisConfidence,
        cuteTimeline: result.cuteTimeline || [],
        markers: (result.markers || []).some((marker) => marker.markerType === "feeding_start")
          ? result.markers
          : [...(result.markers || []), ...derivedFeedingMarkers],
      };
      const diary = { clips: [clip], meals: [] };
      const hasRelationTimeline = (result.cuteTimeline || []).some((item) => item.faceRelation);
      const bgm = this.bgmLibrary.pick();
      const profiles = {};
      for (const profile of ["strict", "loose"]) {
        let selectionMode = "quick_cut";
        let segments = [];
        try {
          segments = selectFoodcastSegments({
            diary,
            mode: "quick_cut",
            targetDurationSec: 60,
            selectionProfile: profile,
          });
        } catch (error) {
          this.logger.info?.("[foodcast-algorithm-test] quick cut unavailable", {
            profile,
            code: error.code || error.message,
          });
        }
        if (!segments.length && !hasRelationTimeline) {
          selectionMode = "natural_fallback";
          segments = selectFoodcastSegments({ diary, mode: "natural", targetDurationSec: 60 });
        }
        const renderSegments = normalizeSegments(segments, clip, tempInput);
        const outputPath = profile === "strict" ? strictFoodcastPath : looseFoodcastPath;
        let renderResult = null;
        if (renderSegments.length) {
          renderResult = await this.renderer.render({
            jobId: `${jobId}-${profile}-foodcast`,
            mode: selectionMode === "quick_cut" ? "quick_cut" : "natural",
            frameMode: "source",
            audioMode: "mix",
            segments: renderSegments,
            bgm,
            outputPath,
            resolveSource: async () => tempInput,
          });
        }
        const profileTimelinePath = profile === "strict" ? strictTimelinePath : looseTimelinePath;
        await this.fs.promises.writeFile(
          profileTimelinePath,
          JSON.stringify({ jobId, profile, segments: renderSegments, frames: timeline }, null, 2),
          "utf8",
        );
        profiles[profile] = {
          selectionMode,
          segments: renderSegments,
          renderResult,
          outputPath,
          timelinePath: profileTimelinePath,
        };
      }
      if (profiles.strict.renderResult) {
        await this.fs.promises.copyFile(strictFoodcastPath, legacyFoodcastPath);
      }

      await this.runProcess(this.pythonPath, [this.annotationScript, verticalPath, timelinePath, annotatedSilentPath], { timeoutMs: this.transcodeTimeoutMs });
      await this.runProcess(this.ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", annotatedSilentPath, "-i", verticalPath,
        "-map", "0:v:0", "-map", "1:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", annotatedPath,
      ], { timeoutMs: this.transcodeTimeoutMs });

      const summary = {
        jobId,
        algorithm: "existing-foodcast-cute-highlights",
        inputFile: path.basename(sourcePath),
        analyzedDurationSec: durationSec,
        bowlRoi,
        detectorBackend: result.detectorBackend,
        detectorError: result.detectorError,
        hasCat: result.hasCat,
        hasFeeding: result.hasFeeding,
        feedingEvidence: result.feedingEvidence,
        markerTypes: summarizeMarkerTypes(result.markers),
        selectedMode: profiles.strict.selectionMode,
        selectedSegments: profiles.strict.segments.map((segment) => ({ startTime: segment.startTime, endTime: segment.endTime, durationSec: segment.durationSec, markerTypes: segment.markerTypes || [], faceRelation: segment.faceRelation || "", faceRelations: segment.faceRelations || [] })),
        derivedTestFeedingInterval: derivedFeedingMarkers.length > 0,
        foodcastDurationSec: profiles.strict.renderResult?.durationSec || 0,
        profiles: Object.fromEntries(Object.entries(profiles).map(([profile, value]) => [profile, {
          selectionMode: value.selectionMode,
          selectedSegments: value.segments.map((segment) => ({
            startTime: segment.startTime,
            endTime: segment.endTime,
            durationSec: segment.durationSec,
            markerTypes: segment.markerTypes || [],
            cuteScore: segment.cuteScore,
            faceRelation: segment.faceRelation || "",
            faceRelations: segment.faceRelations || [],
          })),
          foodcastDurationSec: value.renderResult?.durationSec || 0,
          timeline: path.basename(value.timelinePath),
          artifact: value.renderResult ? path.basename(value.outputPath) : null,
        }])),
        bgm: bgm ? { id: bgm.id, title: bgm.title, artist: bgm.artist } : null,
        note: "Strict and loose profiles use the same cute-highlight analysis with different camera-relation eligibility gates.",
      };
      await this.fs.promises.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
      await this.fs.promises.rm(annotatedSilentPath, { force: true }).catch(() => {});
      const names = [
        "vertical.mp4",
        "annotated.mp4",
        "timeline.json",
        "strict-timeline.json",
        "loose-timeline.json",
        "summary.json",
      ];
      if (profiles.strict.renderResult) names.splice(1, 0, "strict-foodcast.mp4");
      if (profiles.loose.renderResult) names.splice(2, 0, "loose-foodcast.mp4");
      const artifacts = [];
      for (const name of names) {
        const artifactPath = path.join(resultDir, name);
        const item = await this.fs.promises.stat(artifactPath).catch(() => null);
        if (item) artifacts.push({ name, path: artifactPath, sizeBytes: item.size });
      }
      const response = { jobId, ...summary, artifacts: artifacts.map(({ name, sizeBytes }) => ({ name, sizeBytes })) };
      this.jobs.set(jobId, { ...response, artifacts });
      return response;
    } finally {
      await this.fs.promises.rm(tempInput, { force: true }).catch(() => {});
    }
  }
}

module.exports = { FoodcastAlgorithmTestService, sanitizeTimeline };
