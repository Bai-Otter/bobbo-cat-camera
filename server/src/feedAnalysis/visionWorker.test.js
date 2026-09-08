const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const stream = require("node:stream");
const childProcess = require("node:child_process");

const { VisionWorkerAnalyzer } = require("./visionWorker");

function withSpawn(fakeSpawn, fn) {
  const original = childProcess.spawn;
  childProcess.spawn = fakeSpawn;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      childProcess.spawn = original;
    });
}

function createFakeProcess(stdoutPayload) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new stream.Writable({
    write(chunk, encoding, callback) {
      proc.input = (proc.input || "") + chunk.toString();
      callback();
    },
  });
  proc.kill = () => {};
  proc.stdin.on("finish", () => {
    proc.stdout.emit("data", JSON.stringify(stdoutPayload));
    proc.emit("close", 0);
  });
  return proc;
}

function createNoisyFakeProcess(stdoutPayload) {
  const proc = createFakeProcess(stdoutPayload);
  proc.stdin.removeAllListeners("finish");
  proc.stdin.on("finish", () => {
    proc.stdout.emit("data", "Downloading model weights...\n");
    proc.stdout.emit("data", JSON.stringify(stdoutPayload));
    proc.emit("close", 0);
  });
  return proc;
}

test("VisionWorkerAnalyzer analyzeSnapshot sends snapshot mode and preserves feeding markers", async () => {
  let capturedArgs = null;
  let fakeProc = null;
  await withSpawn((command, args) => {
    capturedArgs = { command, args };
    fakeProc = createFakeProcess({
      hasCat: true,
      hasFeeding: true,
      analysisConfidence: 0.91,
      bowlRoi: { x: 1, y: 2, width: 3, height: 4 },
      markers: [
        {
          eventId: "alarm-1__feeding_start",
          markerType: "feeding_start",
          markerTsMs: 1783121412000,
          beginTime: "2026-07-04 07:30:12",
          endTime: "2026-07-04 07:30:12",
        },
      ],
      cuteTimeline: [{ offsetSec: 0, cuteScore: 1, modelConfidence: 1, cuteReasons: ["head_up"], hasCat: true }],
    });
    return fakeProc;
  }, async () => {
    const analyzer = new VisionWorkerAnalyzer({
      pythonPath: "python-test",
      workerScript: "worker-test.py",
    });

    const result = await analyzer.analyzeSnapshot({
      snapshotUrl: "https://example.test/alarm.jpg",
      alarm: { id: "alarm-1" },
      bowlRoi: { x: 5, y: 6, width: 7, height: 8 },
    });

    const payload = JSON.parse(fakeProc.input);
    assert.deepEqual(capturedArgs, { command: "python-test", args: ["worker-test.py"] });
    assert.equal(payload.mode, "snapshot");
    assert.equal(payload.snapshotUrl, "https://example.test/alarm.jpg");
    assert.deepEqual(payload.alarm, { id: "alarm-1" });
    assert.deepEqual(payload.bowlRoi, { x: 5, y: 6, width: 7, height: 8 });
    assert.equal(result.hasFeeding, true);
    assert.equal(result.markers[0].eventId, "alarm-1__feeding_start");
    assert.deepEqual(result.cuteTimeline, []);
  });
});

test("VisionWorkerAnalyzer forwards recording model options and preserves v1 evidence", async () => {
  let capturedArgs = null;
  let fakeProc = null;
  await withSpawn((command, args) => {
    capturedArgs = { command, args };
    fakeProc = createFakeProcess({
      recordingKey: "recording-v1",
      target: "cat",
      hasCat: true,
      hasFeeding: true,
      analysisConfidence: 0.82,
      framesSampled: 24,
      durationMs: 1500,
      detectorBackend: "yolo",
      detectorError: "",
      feedingEvidence: {
        candidateSeconds: 20,
        verifiedSeconds: 12,
        maxConfidence: 0.88,
        rejectionReasons: {},
      },
      bowlRoi: { x: 10, y: 20, width: 30, height: 40 },
      markers: [
        null,
        {
          eventId: { sourceUrl: "https://secret.example.test/event" },
          recordingKey: { rawFrame: "must-not-leak" },
          markerType: ["cute_head_up"],
          target: "cat",
          offsetSec: 8,
          beginTime: { sourceUrl: "https://secret.example.test/begin" },
          endTime: ["2026-07-16 15:50:32"],
          markerLabel: { rawFrame: "must-not-leak" },
          modelConfidence: 1.4,
          cuteScore: -0.2,
          cuteReasons: ["head_up", "head_up", 42],
          sourceUrl: "https://secret.example.test/replay.m3u8",
        },
      ],
      cuteTimeline: [
        {
          offsetSec: 8.5,
          cuteScore: 1.4,
          modelConfidence: 0.82,
          cuteReasons: ["head_up", "head_up", 42],
          hasCat: { rawFrame: "must-not-coerce" },
          sourceUrl: "https://secret.example.test/frame.jpg",
          detectorDebug: { landmarks: [1, 2, 3] },
        },
      ],
    });
    return fakeProc;
  }, async () => {
    const analyzer = new VisionWorkerAnalyzer({
      pythonPath: "python-test",
      workerScript: "worker-test.py",
      fineWorkerScript: "worker-v32-test.py",
    });

    const result = await analyzer.analyzeRecording({
      sourceUrl: "D:/recording.mp4",
      recording: { BeginTime: "2026-07-16 15:50:24" },
      recordingKey: "recording-v1",
      beginTime: "2026-07-16 15:50:24",
      bowlRoi: { x: 10, y: 20, width: 30, height: 40 },
      detectionTarget: "cat",
      detectorBackend: "yolo",
      yoloModel: "yolo11s.pt",
      autoBowlDetection: true,
      durationSec: 120,
      orientation: "clockwise-90",
    });

    const payload = JSON.parse(fakeProc.input);
    assert.deepEqual(capturedArgs, { command: "python-test", args: ["worker-v32-test.py"] });
    assert.equal(payload.mode, "recording");
    assert.equal(payload.recordingKey, "recording-v1");
    assert.equal(payload.beginTime, "2026-07-16 15:50:24");
    assert.equal(payload.detectionTarget, "cat");
    assert.equal(payload.detectorBackend, "yolo");
    assert.equal(payload.yoloModel, "yolo11s.pt");
    assert.equal(payload.autoBowlDetection, true);
    assert.equal(payload.durationSec, 120);
    assert.equal(payload.orientation, "clockwise-90");
    assert.equal(payload.sampleSeconds, 0.5);
    assert.equal(result.recordingKey, "recording-v1");
    assert.equal(result.target, "cat");
    assert.equal(result.feedingEvidence.verifiedSeconds, 12);
    assert.equal(result.framesSampled, 24);
    assert.equal(result.durationMs, 1500);
    assert.equal(result.detectorBackend, "yolo");
    assert.equal(result.detectorError, "");
    assert.deepEqual(result.cuteTimeline, [
      {
        offsetSec: 8.5,
        cuteScore: 1,
        modelConfidence: 0.82,
        cuteReasons: ["head_up"],
        hasCat: false,
      },
    ]);
    assert.equal(result.markers[0].modelConfidence, 1);
    assert.equal(result.markers[0].cuteScore, 0);
    assert.deepEqual(result.markers[0].cuteReasons, ["head_up"]);
    assert.equal(result.markers[0].eventId, undefined);
    assert.equal(result.markers[0].recordingKey, "");
    assert.equal(result.markers[0].markerType, "");
    assert.equal(result.markers[0].beginTime, "");
    assert.equal(result.markers[0].endTime, "");
    assert.equal(result.markers[0].markerLabel, undefined);
    assert.equal(result.markers[0].sourceUrl, undefined);
    assert.doesNotMatch(JSON.stringify(result.markers), /secret\.example|sourceUrl|rawFrame/);
  });
});

test("VisionWorkerAnalyzer screenRecording uses sparse cat-only sampling", async () => {
  let capturedArgs = null;
  let fakeProc = null;
  await withSpawn((command, args) => {
    capturedArgs = { command, args };
    fakeProc = createFakeProcess({
      recordingKey: "screening-1",
      target: "cat",
      hasCat: false,
      framesSampled: 30,
      frames: [],
      error: "",
    });
    return fakeProc;
  }, async () => {
    const analyzer = new VisionWorkerAnalyzer({
      pythonPath: "python-test",
      workerScript: "worker-test.py",
      fineWorkerScript: "worker-v32-test.py",
    });

    const result = await analyzer.screenRecording({
      sourceUrl: "https://camera.example/recording.m3u8",
      recording: { BeginTime: "2026-08-22 08:00:00" },
      recordingKey: "screening-1",
      beginTime: "2026-08-22 08:00:00",
      durationSec: 60,
      detectorBackend: "yolo",
      yoloModel: "yolo11s.pt",
      sampleSeconds: 2,
      orientation: "clockwise-90",
    });

    const payload = JSON.parse(fakeProc.input);
    assert.deepEqual(capturedArgs, { command: "python-test", args: ["worker-test.py"] });
    assert.equal(payload.mode, "recording");
    assert.equal(payload.screenOnly, true);
    assert.equal(payload.detectionTarget, "cat");
    assert.equal(payload.sampleSeconds, 2);
    assert.equal(payload.sampleOffsetSeconds, 0.5);
    assert.equal(payload.bowlRoi, null);
    assert.equal(payload.autoBowlDetection, false);
    assert.equal(payload.orientation, "clockwise-90");
    assert.equal(result.hasCat, false);
    assert.equal(result.framesSampled, 30);
  });
});

test("VisionWorkerAnalyzer ignores dependency logs before the final JSON result", async () => {
  await withSpawn(
    () => createNoisyFakeProcess({
      recordingKey: "recording-noisy",
      target: "cat",
      hasCat: true,
      hasFeeding: false,
      analysisConfidence: 0.76,
      markers: [{ markerType: "cat_enter", target: "cat", offsetSec: 2 }],
    }),
    async () => {
      const analyzer = new VisionWorkerAnalyzer({
        pythonPath: "python-test",
        workerScript: "worker-test.py",
      });

      const result = await analyzer.analyzeRecording({ recordingKey: "recording-noisy" });

      assert.equal(result.error, "");
      assert.equal(result.hasCat, true);
      assert.equal(result.markers.length, 1);
    }
  );
});

test("VisionWorkerAnalyzer returns an empty cute timeline for face recordings", async () => {
  await withSpawn(
    () => createFakeProcess({
      target: "face",
      hasCat: true,
      cuteTimeline: [
        { offsetSec: 1, cuteScore: 0.9, modelConfidence: 0.9, cuteReasons: ["head_up"], hasCat: true },
      ],
    }),
    async () => {
      const analyzer = new VisionWorkerAnalyzer({
        pythonPath: "python-test",
        workerScript: "worker-test.py",
      });

      const result = await analyzer.analyzeRecording({ detectionTarget: "FACE" });

      assert.deepEqual(result.cuteTimeline, []);
    }
  );
});
