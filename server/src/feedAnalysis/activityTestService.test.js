const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  FeedingActivityTestService,
  resolveControlledInput,
  summarizeResult,
} = require("./activityTestService");

test("controlled input rejects path traversal and unsupported media", () => {
  assert.throws(() => resolveControlledInput("C:/inputs", "../secret.mp4"), {
    code: "FEED_ANALYSIS_TEST_FILE_INVALID",
  });
  assert.throws(() => resolveControlledInput("C:/inputs", "sample.txt"), {
    code: "FEED_ANALYSIS_TEST_FILE_TYPE_INVALID",
  });
  assert.equal(resolveControlledInput("C:/inputs", "sample.mp4"), path.resolve("C:/inputs/sample.mp4"));
});

test("activity result exposes only the bounded summary", () => {
  const summary = summarizeResult({
    hasCat: true,
    hasFeeding: false,
    analysisConfidence: 0.71,
    framesSampled: 23,
    durationMs: 456,
    detectorBackend: "yolo",
    feedingEvidence: {
      candidateSeconds: 4,
      verifiedSeconds: 2,
      maxConfidence: 0.84,
      rejectionReasons: { HEAD_NOT_POINTING_TO_BOWL: 2 },
    },
    markers: [{ secret: "not-public" }],
    frames: [{ token: "not-public" }],
  });
  assert.deepEqual(summary, {
    hasCat: true,
    hasFeeding: false,
    analysisConfidence: 0.71,
    candidateSeconds: 4,
    verifiedSeconds: 2,
    maxConfidence: 0.84,
    rejectionReasons: { HEAD_NOT_POINTING_TO_BOWL: 2 },
    framesSampled: 23,
    durationMs: 456,
    detectorBackend: "yolo",
    detectorError: "",
    error: "",
  });
  assert.equal(Object.hasOwn(summary, "markers"), false);
  assert.equal(Object.hasOwn(summary, "frames"), false);
});

test("activity service rotates a bounded clip, calls the worker, and cleans temporary media", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feeding-activity-test-"));
  const inputDir = path.join(root, "inputs");
  const tempDir = path.join(root, "temp");
  fs.mkdirSync(inputDir);
  fs.writeFileSync(path.join(inputDir, "meal.mp4"), Buffer.alloc(16));
  const calls = [];
  const service = new FeedingActivityTestService({
    inputDir, tempDir, ffmpegPath: "ffmpeg-test", defaultDurationSec: 120,
    logger: { info() {} },
    runProcess: async (command, args) => {
      calls.push({ command, args });
      fs.writeFileSync(args.at(-1), Buffer.alloc(8));
    },
    analyzer: {
      async analyzeRecording(payload) {
        calls.push(payload);
        assert.equal(fs.existsSync(payload.sourceUrl), true);
        return {
          hasCat: true, hasFeeding: true, framesSampled: 8, durationMs: 20,
          detectorBackend: "yolo",
          feedingEvidence: { candidateSeconds: 5, verifiedSeconds: 4, maxConfidence: 0.9 },
        };
      },
    },
  });

  const result = await service.analyze({ fileName: "meal.mp4", durationSec: 90 });

  assert.equal(result.orientation, "clockwise-90");
  assert.equal(result.analyzedDurationSec, 90);
  assert.equal(result.summary.hasFeeding, true);
  assert.equal(calls[0].command, "ffmpeg-test");
  assert.equal(calls[0].args.includes("transpose=1"), true);
  assert.equal(calls[0].args.includes("90"), true);
  assert.equal(fs.existsSync(calls[1].sourceUrl), false);
});

test("activity service enforces file size and duration limits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feeding-activity-limits-"));
  fs.writeFileSync(path.join(root, "meal.mp4"), Buffer.alloc(32));
  const service = new FeedingActivityTestService({
    inputDir: root, tempDir: path.join(root, "temp"), maxFileBytes: 16, maxDurationSec: 120,
    analyzer: { analyzeRecording: async () => ({}) },
    runProcess: async () => {},
  });
  await assert.rejects(service.analyze({ fileName: "meal.mp4" }), {
    code: "FEED_ANALYSIS_TEST_FILE_TOO_LARGE",
  });

  fs.writeFileSync(path.join(root, "meal.mp4"), Buffer.alloc(8));
  await assert.rejects(service.analyze({ fileName: "meal.mp4", durationSec: 121 }), {
    code: "FEED_ANALYSIS_TEST_DURATION_INVALID",
  });
});

test("activity service persists a reviewable result bundle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feeding-activity-bundle-"));
  const inputDir = path.join(root, "inputs");
  const outputDir = path.join(root, "results");
  fs.mkdirSync(inputDir);
  fs.writeFileSync(path.join(inputDir, "meal.mp4"), Buffer.alloc(16));
  const service = new FeedingActivityTestService({
    inputDir, outputDir, tempDir: path.join(root, "temp"), logger: { info() {}, warn() {} },
    runProcess: async (command, args) => {
      const destination = args.at(-1);
      fs.writeFileSync(destination, Buffer.alloc(command === "python-test" ? 12 : 8));
    },
    pythonPath: "python-test",
    analyzer: { analyzeRecording: async () => ({
      hasCat: true, hasFeeding: false, framesSampled: 1,
      frames: [{ second: 2, hasCat: true, nearBowl: false, targetBoxes: [{ x: 1, y: 2, width: 3, height: 4 }] }],
      feedingEvidence: { candidateSeconds: 1, verifiedSeconds: 0 },
    }) },
  });
  const result = await service.analyze({ fileName: "meal.mp4", durationSec: 10 });
  assert.deepEqual(result.artifacts.map((item) => item.name), ["vertical.mp4", "annotated.mp4", "timeline.json", "summary.json"]);
  const timeline = JSON.parse(fs.readFileSync(service.resolveArtifact(result.jobId, "timeline.json"), "utf8"));
  assert.equal(timeline.frames[0].offsetSec, 2);
  assert.deepEqual(timeline.frames[0].catBoxes[0], { x: 1, y: 2, width: 3, height: 4 });
  assert.throws(() => service.resolveArtifact(result.jobId, "../secret"), { code: "FEED_ANALYSIS_TEST_ARTIFACT_NOT_FOUND" });
});
