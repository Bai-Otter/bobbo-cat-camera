const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { VisionHttpAnalyzer } = require("./visionHttpClient");

function withVisionServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      try {
        const result = await fn(`http://127.0.0.1:${address.port}`);
        server.close(() => resolve(result));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

test("VisionHttpAnalyzer posts replay source metadata and normalizes target markers", async () => {
  const requests = [];

  await withVisionServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/analyze-recording");
    const body = await readJson(req);
    requests.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      recordingKey: body.recordingKey,
      target: "face",
      hasCat: true,
      hasFeeding: false,
      analysisConfidence: 0.88,
      bowlRoi: null,
      markers: [
        null,
        {
          recordingKey: "",
          markerType: "face_enter",
          target: "face",
          offsetSec: 12,
          offsetMs: 12000,
          markerTsMs: new Date("2026-07-04 12:00:12").getTime(),
          beginTime: "2026-07-04 12:00:12",
          endTime: "",
          sourceUrl: body.sourceUrl,
        },
      ],
      framesSampled: 8,
      error: "",
    }));
  }, async (baseUrl) => {
    const analyzer = new VisionHttpAnalyzer({
      baseUrl,
      detectionTarget: "face",
      detectorBackend: "auto",
    });

    const result = await analyzer.analyzeRecording({
      sourceUrl: "https://device.example.test/replay.m3u8?token=temporary",
      recordingKey: "2026-07-04 12:00:00__clip-a.mp4",
      beginTime: "2026-07-04 12:00:00",
      recording: {
        BeginTime: "2026-07-04 12:00:00",
        EndTime: "2026-07-04 12:01:00",
        FileName: "clip-a.mp4",
      },
      bowlRoi: { x: 1, y: 2, width: 3, height: 4 },
      durationSec: 60,
    });

    assert.equal(result.target, "face");
    assert.equal(result.hasCat, true);
    assert.equal(result.markers[0].markerType, "face_enter");
    assert.equal(result.markers[0].target, "face");
    assert.equal(result.markers[0].recordingKey, "2026-07-04 12:00:00__clip-a.mp4");
    assert.equal(result.markers[0].offsetSec, 12);
    assert.equal(result.markers[0].endTime, "2026-07-04 12:00:12");
    assert.equal(result.markers[0].sourceUrl, undefined);
    assert.deepEqual(result.cuteTimeline, []);
  });

  assert.deepEqual(requests[0], {
    sourceUrl: "https://device.example.test/replay.m3u8?token=temporary",
    recording: {
      BeginTime: "2026-07-04 12:00:00",
      EndTime: "2026-07-04 12:01:00",
      FileName: "clip-a.mp4",
    },
    recordingKey: "2026-07-04 12:00:00__clip-a.mp4",
    beginTime: "2026-07-04 12:00:00",
    bowlRoi: { x: 1, y: 2, width: 3, height: 4 },
    fixedBottomBowlRegion: false,
    autoBowlDetection: false,
    durationSec: 60,
    detectionTarget: "face",
    detectorBackend: "auto",
    orientation: "none",
    adaptiveFeeding: false,
    sampleSeconds: 0.5,
    sampleOffsetSeconds: 0,
    screenOnly: false,
    cuteAnalysisAllScales: false,
    cutePolicy: null,
  });
});

test("VisionHttpAnalyzer keeps sparse screening separate from V3.2 fine defaults", async () => {
  const requests = [];

  await withVisionServer(async (req, res) => {
    requests.push(await readJson(req));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ target: "cat", frames: [], markers: [] }));
  }, async (baseUrl) => {
    const analyzer = new VisionHttpAnalyzer({ baseUrl, detectionTarget: "cat" });
    await analyzer.analyzeRecording({ sourceUrl: "https://device.test/fine.m3u8" });
    await analyzer.screenRecording({ sourceUrl: "https://device.test/screen.m3u8" });
  });

  assert.equal(requests[0].sampleSeconds, 0.5);
  assert.equal(requests[0].screenOnly, false);
  assert.equal(requests[1].sampleSeconds, 2);
  assert.equal(requests[1].sampleOffsetSeconds, 0.5);
  assert.equal(requests[1].screenOnly, true);
});

test("VisionHttpAnalyzer preserves V3.2 inputs, authenticates, and retries worker startup", async () => {
  let attempts = 0;
  const waits = [];
  const requests = [];
  const analyzer = new VisionHttpAnalyzer({
    baseUrl: "https://vision.example.test",
    token: "worker-secret",
    startupRetryMs: 30_000,
    retryIntervalMs: 1_000,
    sleepImpl: async (delayMs) => waits.push(delayMs),
    fetchImpl: async (url, options) => {
      attempts += 1;
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (attempts === 1) return { ok: false, status: 503 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          target: "cat",
          hasCat: true,
          hasFeeding: true,
          framesSampled: 120,
          durationMs: 1200,
          feedingEvidence: { candidateSeconds: 8, verifiedSeconds: 6, maxConfidence: 0.9, rejectionReasons: {} },
          frames: [{ offsetSec: 1, feeding: true }],
        }),
      };
    },
  });

  const result = await analyzer.analyzeRecording({
    sourceUrl: "https://device.test/clip.m3u8",
    recording: { BeginTime: "2026-08-22 10:00:00", FileName: "clip" },
    recordingKey: "clip",
    durationSec: 180,
    fixedBottomBowlRegion: true,
    autoBowlDetection: false,
    orientation: "clockwise-90",
    adaptiveFeeding: true,
    sampleSeconds: 2,
    cuteAnalysisAllScales: true,
    cutePolicy: { strictThreshold: 0.8 },
  });

  assert.equal(attempts, 2);
  assert.equal(waits.length, 1);
  assert.equal(requests[1].options.headers.Authorization, "Bearer worker-secret");
  assert.deepEqual(requests[1].body.recording, { BeginTime: "2026-08-22 10:00:00", FileName: "clip" });
  assert.equal(requests[1].body.orientation, "clockwise-90");
  assert.equal(requests[1].body.adaptiveFeeding, true);
  assert.equal(requests[1].body.fixedBottomBowlRegion, true);
  assert.equal(requests[1].body.cuteAnalysisAllScales, true);
  assert.deepEqual(requests[1].body.cutePolicy, { strictThreshold: 0.8 });
  assert.equal(result.framesSampled, 120);
  assert.equal(result.durationMs, 1200);
  assert.deepEqual(result.frames, [{ offsetSec: 1, feeding: true }]);
});

test("VisionHttpAnalyzer clears cute timeline when snapshot request has no URL", () => {
  const analyzer = new VisionHttpAnalyzer({
    baseUrl: "https://vision.example.test",
    detectionTarget: "cat",
  });

  const result = analyzer.normalizeResult(
    {
      target: "cat",
      cuteTimeline: [
        { offsetSec: 0.5, cuteScore: 0.9, modelConfidence: 0.9, cuteReasons: ["head_up"], hasCat: true },
      ],
    },
    { snapshotUrl: "", detectionTarget: "cat" }
  );

  assert.deepEqual(result.cuteTimeline, []);
});

test("VisionHttpAnalyzer posts snapshot metadata and normalizes feeding markers", async () => {
  const requests = [];

  await withVisionServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/analyze-snapshot");
    const body = await readJson(req);
    requests.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      hasCat: true,
      hasFeeding: true,
      analysisConfidence: 0.91,
      bowlRoi: body.bowlRoi,
      markers: [
        {
          markerType: "feeding_start",
          target: "cat",
          markerTsMs: new Date("2026-07-04 12:00:08").getTime(),
          beginTime: "2026-07-04 12:00:08",
          endTime: "2026-07-04 12:00:08",
          sourceUrl: body.snapshotUrl,
        },
      ],
      cuteTimeline: [{ offsetSec: 0, cuteScore: 1, modelConfidence: 1, cuteReasons: ["head_up"], hasCat: true }],
      error: "",
    }));
  }, async (baseUrl) => {
    const analyzer = new VisionHttpAnalyzer({
      baseUrl,
      detectionTarget: "cat",
      detectorBackend: "auto",
    });

    const result = await analyzer.analyzeSnapshot({
      snapshotUrl: "https://device.example.test/alarm.jpg?token=temporary",
      alarm: { id: "alarm-1", occurredAt: "2026-07-04 12:00:08" },
      bowlRoi: { x: 1, y: 2, width: 3, height: 4 },
    });

    assert.equal(result.target, "cat");
    assert.equal(result.hasCat, true);
    assert.equal(result.hasFeeding, true);
    assert.equal(result.markers[0].markerType, "feeding_start");
    assert.equal(result.markers[0].sourceUrl, undefined);
    assert.deepEqual(result.cuteTimeline, []);
  });

  assert.deepEqual(requests[0], {
    snapshotUrl: "https://device.example.test/alarm.jpg?token=temporary",
    alarm: { id: "alarm-1", occurredAt: "2026-07-04 12:00:08" },
    bowlRoi: { x: 1, y: 2, width: 3, height: 4 },
    detectionTarget: "cat",
    detectorBackend: "auto",
  });
});

test("VisionHttpAnalyzer normalizes compact cat timeline and explainable marker fields", () => {
  const analyzer = new VisionHttpAnalyzer({
    baseUrl: "https://vision.example.test",
    detectionTarget: "cat",
  });

  const result = analyzer.normalizeResult(
    {
      recordingKey: "clip-cute",
      target: "cat",
      markers: [
        {
          eventId: { sourceUrl: "https://secret.example.test/event" },
          recordingKey: { rawFrame: "must-not-leak" },
          markerType: ["cute_head_up"],
          beginTime: { sourceUrl: "https://secret.example.test/begin" },
          endTime: ["2026-07-04 12:00:01"],
          markerLabel: { rawFrame: "must-not-leak" },
          modelConfidence: "1.2",
          cuteScore: -1,
          cuteReasons: ["head_up", "head_up", null],
          sourceUrl: "https://secret.example.test/replay.m3u8",
        },
      ],
      cuteTimeline: [
        {
          offsetSec: "0.5",
          cuteScore: 1.2,
          modelConfidence: "0.83",
          cuteReasons: "head_up",
          hasCat: "false",
          frame: "raw-frame-data",
          sourceUrl: "https://secret.example.test/frame.jpg",
        },
      ],
    },
    { recordingKey: "clip-cute", detectionTarget: "cat" }
  );

  assert.deepEqual(result.cuteTimeline, [
    {
      offsetSec: 0.5,
      cuteScore: 1,
      modelConfidence: 0.83,
      cuteReasons: ["head_up"],
      hasCat: false,
    },
  ]);
  assert.equal(result.markers[0].modelConfidence, 1);
  assert.equal(result.markers[0].cuteScore, 0);
  assert.deepEqual(result.markers[0].cuteReasons, ["head_up"]);
  assert.equal(result.markers[0].eventId, undefined);
  assert.equal(result.markers[0].recordingKey, "clip-cute");
  assert.equal(result.markers[0].markerType, "");
  assert.equal(result.markers[0].beginTime, "");
  assert.equal(result.markers[0].endTime, "");
  assert.equal(result.markers[0].markerLabel, undefined);
  assert.equal(result.markers[0].sourceUrl, undefined);
  assert.doesNotMatch(JSON.stringify(result.markers), /secret\.example|sourceUrl|rawFrame/);
});
