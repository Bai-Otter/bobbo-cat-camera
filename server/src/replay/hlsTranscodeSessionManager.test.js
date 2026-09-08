const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Writable } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HlsTranscodeSessionManager,
  contentTypeForHlsFile,
  isRtspUrl,
  isRemuxCompatibilityError,
} = require("./hlsTranscodeSessionManager");

test("HlsTranscodeSessionManager bounds interactive replay startup", () => {
  const manager = new HlsTranscodeSessionManager({ ffmpegPath: "ffmpeg-test" });

  assert.equal(manager.hlsReadyTimeoutMs, 8_000);
  assert.equal(manager.hlsReadySegmentCount, 1);
});

test("HlsTranscodeSessionManager starts ffmpeg and exposes an HLS playlist", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-test-"));
  const spawnCalls = [];
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.kill = (signal) => {
    fakeProcess.killedWith = signal;
    queueMicrotask(() => fakeProcess.emit("close", 0));
  };
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-test",
    logger: { warn() {} },
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      writeReadyHls(rootDir, "hls-test");
      return fakeProcess;
    },
  });

  const session = await manager.createSession({
    sourceUrl: "rtsp://example.test/replay.sdp",
    baseUrl: "http://backend.test",
    durationSec: 60,
    currentSec: 7,
    deviceSn: "SN001",
    ownerOpenid: "openid-owner",
  });

  assert.equal(session.ok, true);
  assert.equal(session.sessionId, "hls-test");
  assert.equal(session.playbackType, "hls");
  assert.equal(session.transport, "rtsp-hls-remux");
  assert.equal(session.reused, false);
  assert.equal(session.playUrl, "http://backend.test/api/replay-hls/hls-test/index.m3u8");
  assert.deepEqual(manager.getSessionMetadata("hls-test"), {
    deviceSn: "SN001",
    ownerOpenid: "openid-owner",
  });
  assert.deepEqual(manager.getSessionDescriptor("hls-test"), {
    deviceSn: "SN001",
    ownerOpenid: "openid-owner",
    live: false,
    playUrl: "http://backend.test/api/replay-hls/hls-test/index.m3u8",
    reuseKey: "",
  });
  assert.equal(manager.getSessionDescriptor("hls-test").sourceUrl, undefined);
  assert.equal(session.ownerOpenid, undefined);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "ffmpeg-test");
  assert.ok(spawnCalls[0].args.includes("-rtsp_transport"));
  assert.ok(spawnCalls[0].args.includes("tcp"));
  assert.ok(spawnCalls[0].args.includes("rtsp://example.test/replay.sdp"));
  assert.ok(spawnCalls[0].args.includes("-f"));
  assert.ok(spawnCalls[0].args.includes("hls"));
  assert.equal(spawnCalls[0].args.includes("-vf"), false);
  assert.equal(argAfter(spawnCalls[0].args, "-c:v"), "copy");
  assert.equal(spawnCalls[0].args.includes("libx264"), false);
  assert.equal(argAfter(spawnCalls[0].args, "-timeout"), "6000000");
  assert.equal(spawnCalls[0].args.includes("-rw_timeout"), false);
  assert.equal(argAfter(spawnCalls[0].args, "-avoid_negative_ts"), "make_zero");
  assert.equal(argAfter(spawnCalls[0].args, "-af"), "aresample=async=1:first_pts=0");
  assert.equal(argAfter(spawnCalls[0].args, "-c:a"), "aac");
  assert.equal(argAfter(spawnCalls[0].args, "-profile:a"), "aac_low");
  assert.equal(argAfter(spawnCalls[0].args, "-hls_flags"), "independent_segments+temp_file");
  assert.ok(spawnCalls[0].args.includes("-t"));
  assert.ok(spawnCalls[0].args.includes("53"));

  await manager.stopSession("hls-test");
  assert.equal(fakeProcess.killedWith, "SIGTERM");
});

test("HlsTranscodeSessionManager reports a playable session after the first HLS segment", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-ready-"));
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.kill = () => queueMicrotask(() => fakeProcess.emit("close", 0));
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-ready",
    hlsReadyPollMs: 5,
    logger: { info() {}, warn() {} },
    spawn: () => fakeProcess,
  });
  const session = await manager.createSession({
    sourceUrl: "rtsp://example.test/replay.sdp",
    baseUrl: "http://backend.test",
    durationSec: 60,
    deviceSn: "SN001",
  });

  setTimeout(() => writeReadyHls(rootDir, session.sessionId), 10);
  const ready = await manager.waitUntilReady(session.sessionId, 200);

  assert.equal(ready.sessionId, session.sessionId);
  assert.equal(ready.transport, "rtsp-hls-remux");
  await manager.stopSession(session.sessionId);
});

test("HlsTranscodeSessionManager automatically resumes a ready cloud replay after RTSP closes", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-recover-"));
  const processes = [];
  const seekTargets = [];
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-recover",
    hlsReadyPollMs: 5,
    recoveryBackoffMs: [0],
    logger: { info() {}, warn() {} },
    spawn: () => {
      const fakeProcess = new EventEmitter();
      fakeProcess.stderr = new EventEmitter();
      fakeProcess.kill = (signal) => {
        fakeProcess.killedWith = signal;
        queueMicrotask(() => fakeProcess.emit("close", 0));
      };
      processes.push(fakeProcess);
      writeTimedHls(rootDir, "hls-recover", processes.length === 1 ? 3 : 2);
      return fakeProcess;
    },
  });
  const session = await manager.createSession({
    sourceUrl: "rtsp://example.test/replay-start.sdp",
    seekSource: async (targetSec) => {
      seekTargets.push(targetSec);
      return {
        sourceUrl: `rtsp://example.test/replay-${targetSec}.sdp`,
        currentSec: targetSec,
        durationSec: 60,
      };
    },
    baseUrl: "http://backend.test",
    durationSec: 60,
  });
  await manager.waitUntilReady(session.sessionId, 100);

  processes[0].emit("close", 1, null);
  await waitForCondition(() => {
    const current = manager.getSessionStatus(session.sessionId);
    return current?.generation === 1 && current?.state === "ready";
  });

  const status = manager.getSessionStatus(session.sessionId);
  assert.deepEqual(seekTargets, [3]);
  assert.equal(processes.length, 2);
  assert.equal(status.state, "ready");
  assert.equal(status.currentSec, 3);
  assert.equal(status.generation, 1);
  assert.equal(status.recoveryAttempts, 1);
  assert.equal(status.playUrl, "http://backend.test/api/replay-hls/hls-recover/index.m3u8?v=1");

  await manager.stopSession(session.sessionId);
});

test("HlsTranscodeSessionManager fails fast when ffmpeg exits before the first segment", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-start-fail-"));
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.kill = () => queueMicrotask(() => fakeProcess.emit("close", 0));
  const options = {
    sourceUrl: "rtsp://example.test/replay.sdp",
    baseUrl: "http://backend.test",
    durationSec: 60,
    deviceSn: "SN001",
    ownerOpenid: "openid-owner",
    reuseKey: "recording-a",
  };
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-start-fail",
    hlsReadyPollMs: 5,
    logger: { info() {}, warn() {} },
    spawn: () => fakeProcess,
  });
  const session = await manager.createSession(options);
  const waiting = manager.waitUntilReady(session.sessionId, 500);

  fakeProcess.stderr.emit("data", Buffer.from("Option timeout not found."));
  fakeProcess.emit("close", 1, null);

  await assert.rejects(waiting, (error) => error.code === "REPLAY_HLS_START_FAILED");
  assert.equal(manager.reuseSession(options), null);
});

test("HlsTranscodeSessionManager keeps HLS files until ffmpeg has closed", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-stop-race-"));
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.kill = (signal) => {
    fakeProcess.killedWith = signal;
  };
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-stop-race",
    ffmpegStopTimeoutMs: 500,
    logger: { warn() {} },
    spawn: () => {
      writeReadyHls(rootDir, "hls-stop-race");
      return fakeProcess;
    },
  });
  const session = await manager.createSession({
    sourceUrl: "rtsp://example.test/replay.sdp",
    baseUrl: "http://backend.test",
    durationSec: 60,
  });
  const sessionDir = path.join(rootDir, session.sessionId);

  const stopped = manager.stopSession(session.sessionId);
  await waitForTurn();
  try {
    assert.equal(fakeProcess.killedWith, "SIGTERM");
    assert.equal(fs.existsSync(sessionDir), true);
  } finally {
    fakeProcess.emit("close", 0);
  }

  assert.equal(await stopped, true);
  assert.equal(fs.existsSync(sessionDir), false);
});

test("HlsTranscodeSessionManager reuses an active recording session", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-reuse-"));
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.kill = () => queueMicrotask(() => fakeProcess.emit("close", 0));
  let spawnCount = 0;
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-reuse",
    logger: { warn() {} },
    spawn: () => {
      spawnCount += 1;
      return fakeProcess;
    },
  });
  const options = {
    sourceUrl: "rtsp://example.test/replay.sdp",
    baseUrl: "http://backend.test",
    durationSec: 60,
    deviceSn: "SN001",
    ownerOpenid: "openid-owner",
    reuseKey: "recording-a",
  };

  const first = await manager.createSession(options);
  const second = await manager.createSession(options);

  assert.equal(first.sessionId, second.sessionId);
  assert.equal(second.reused, true);
  assert.equal(spawnCount, 1);
  await manager.stopSession(first.sessionId);
});

test("HlsTranscodeSessionManager releases an official live source exactly once", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-release-"));
  const releases = [];
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.kill = () => queueMicrotask(() => fakeProcess.emit("close", 0));
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-release",
    logger: { warn() {} },
    spawn: () => {
      writeReadyHls(rootDir, "hls-release");
      return fakeProcess;
    },
  });
  const session = await manager.createSession({
    sourceUrl: "https://camera.test/live.m3u8",
    baseUrl: "http://backend.test",
    live: true,
    releaseSource: async () => releases.push("released"),
  });

  assert.equal(await manager.stopSession(session.sessionId), true);
  assert.equal(await manager.stopSession(session.sessionId), false);
  assert.equal(manager.getSessionDescriptor(session.sessionId), null);
  assert.deepEqual(releases, ["released"]);
});

test("HlsTranscodeSessionManager filters HTTP live input with a bounded playlist", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-live-hls-test-"));
  const spawnCalls = [];
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.kill = () => {};
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "live-filtered",
    logger: { warn() {} },
    spawn: (command, args) => {
      spawnCalls.push({ command, args });
      writeReadyHls(rootDir, "live-filtered");
      return fakeProcess;
    },
  });

  await manager.createSession({
    sourceUrl: "https://camera.test/live.m3u8",
    baseUrl: "http://backend.test",
    live: true,
    videoFilter: "curves=all='0/0 1/1',vibrance=intensity=0.09",
  });

  const args = spawnCalls[0].args;
  assert.equal(args.includes("-rtsp_transport"), false);
  assert.equal(args.includes("-t"), false);
  assert.equal(args.includes("0:a?"), true);
  assert.equal(argAfter(args, "-g"), "20");
  assert.equal(argAfter(args, "-keyint_min"), "20");
  assert.match(argAfter(args, "-x264-params"), /repeat-headers=1/);
  assert.equal(argAfter(args, "-force_key_frames"), "expr:gte(t,n_forced*1)");
  assert.equal(argAfter(args, "-avoid_negative_ts"), "make_zero");
  assert.equal(argAfter(args, "-profile:a"), "aac_low");
  assert.equal(argAfter(args, "-hls_list_size"), "8");
  assert.equal(
    argAfter(args, "-hls_flags"),
    "delete_segments+omit_endlist+independent_segments+temp_file"
  );
  assert.match(argAfter(args, "-vf"), /scale=.*curves=.*vibrance=/);
  assert.match(argAfter(args, "-vf"), /fps=20/);
  assert.match(argAfter(args, "-vf"), /setsar=1,format=yuv420p/);
});

test("HlsTranscodeSessionManager returns immediately and serves the playlist after one segment", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-test-"));
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.kill = () => {};
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-ready",
    hlsReadyTimeoutMs: 500,
    hlsReadyPollMs: 10,
    logger: { warn() {} },
    spawn: () => fakeProcess,
  });

  const session = await manager.createSession({
    sourceUrl: "rtsp://example.test/replay.sdp",
    baseUrl: "http://backend.test",
    durationSec: 60,
  });
  assert.equal(session.sessionId, "hls-ready");

  const sessionDir = path.join(rootDir, "hls-ready");
  fs.writeFileSync(path.join(sessionDir, "index.m3u8"), "#EXTM3U\nseg_00000.ts\n");
  fs.writeFileSync(path.join(sessionDir, "seg_00000.ts"), "segment-0");
  const response = createCapturingResponse();
  await manager.attachHttpResponse(session.sessionId, "index.m3u8", response, { method: "GET", headers: {} });
  await response.done;
  assert.equal(response.statusCode, 200);
});

test("HlsTranscodeSessionManager finalizes the full playlist before analysis", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-analysis-"));
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.kill = (signal) => {
    fakeProcess.killedWith = signal;
    queueMicrotask(() => fakeProcess.emit("close", 0));
  };
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-analysis",
    hlsReadyPollMs: 10,
    logger: { warn() {} },
    spawn: () => {
      writeTimedHls(rootDir, "hls-analysis", 2);
      return fakeProcess;
    },
  });
  const session = await manager.createSession({
    sourceUrl: "rtsp://example.test/replay.sdp",
    baseUrl: "http://backend.test",
    durationSec: 5,
  });

  let resolved = false;
  const analysisReady = manager.finalizeForAnalysis(session.sessionId, 5, {
    timeoutMs: 500,
    durationToleranceSec: 0,
  });
  analysisReady.then(() => {
    resolved = true;
  });
  await waitForTurn();
  assert.equal(resolved, false);

  writeTimedHls(rootDir, "hls-analysis", 5);
  const finalized = await analysisReady;
  const playlist = fs.readFileSync(path.join(rootDir, "hls-analysis", "index.m3u8"), "utf8");

  assert.equal(finalized.playUrl, "http://backend.test/api/replay-hls/hls-analysis/index.m3u8");
  assert.equal(fakeProcess.killedWith, "SIGTERM");
  assert.match(playlist, /#EXT-X-ENDLIST\s*$/);
});

test("HlsTranscodeSessionManager finalizes playable partial coverage for analysis", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-partial-analysis-"));
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.kill = () => queueMicrotask(() => fakeProcess.emit("close", 0));
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-partial-analysis",
    hlsReadyPollMs: 5,
    logger: { warn() {} },
    spawn: () => {
      writeTimedHls(rootDir, "hls-partial-analysis", 2);
      return fakeProcess;
    },
  });
  const session = await manager.createSession({
    sourceUrl: "rtsp://example.test/replay.sdp",
    baseUrl: "http://backend.test",
    durationSec: 10,
  });

  const finalized = await manager.finalizeForAnalysis(session.sessionId, 10, {
    timeoutMs: 20,
    durationToleranceSec: 0,
  });
  const playlist = fs.readFileSync(
    path.join(rootDir, "hls-partial-analysis", "index.m3u8"),
    "utf8"
  );

  assert.equal(finalized.analysisPartial, true);
  assert.equal(finalized.availableDurationSec, 2);
  assert.match(playlist, /#EXT-X-ENDLIST\s*$/);
});

test("HlsTranscodeSessionManager seeks a bound native source without replacing the session", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-test-"));
  const events = [];
  const fakeProcesses = [];
  const sourceController = {
    async start({ write }) {
      events.push("start");
      sourceController.write = write;
    },
    async pause() {
      events.push("pause");
    },
    async seek(targetSec) {
      events.push(["seek", targetSec]);
    },
    async resume() {
      events.push("resume");
    },
    async stop() {
      events.push("stop");
    },
  };
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-native",
    logger: { warn() {} },
    spawn: (command, args, options) => {
      const fakeProcess = new EventEmitter();
      fakeProcess.stderr = new EventEmitter();
      fakeProcess.stdin = { destroyed: false, write() {} };
      fakeProcess.kill = (signal) => {
        fakeProcess.killedWith = signal;
        queueMicrotask(() => fakeProcess.emit("close", 0));
      };
      fakeProcesses.push({ fakeProcess, command, args, options });
      writeReadyHls(rootDir, "hls-native");
      return fakeProcess;
    },
  });

  const session = await manager.createSession({
    sourceController,
    baseUrl: "http://backend.test",
    deviceSn: "device-a",
    durationSec: 60,
    videoFilter: "vibrance=intensity=0.09",
  });
  const seekResult = await manager.seekSession(session.sessionId, 24);

  assert.deepEqual(events, ["start", "pause", ["seek", 24], "resume"]);
  assert.equal(fakeProcesses.length, 2);
  assert.equal(fakeProcesses[0].fakeProcess.killedWith, "SIGTERM");
  assert.equal(fakeProcesses[0].options.stdio[0], "pipe");
  assert.match(argAfter(fakeProcesses[0].args, "-vf"), /vibrance=intensity=0\.09/);
  assert.match(argAfter(fakeProcesses[1].args, "-vf"), /vibrance=intensity=0\.09/);
  assert.equal(seekResult.sessionId, session.sessionId);
  assert.equal(seekResult.currentSec, 24);
  assert.equal(seekResult.playUrl, "http://backend.test/api/replay-hls/hls-native/index.m3u8?v=1");

  await manager.stopSession(session.sessionId);
  assert.equal(events.at(-1), "stop");
});

test("HlsTranscodeSessionManager waits for ffmpeg to close before rebuilding files on seek", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-seek-race-"));
  const fakeProcesses = [];
  const sourceController = {
    async start() {},
    async pause() {},
    async seek() {},
    async resume() {},
    async stop() {},
  };
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-seek-race",
    ffmpegStopTimeoutMs: 500,
    logger: { warn() {} },
    spawn: () => {
      const fakeProcess = new EventEmitter();
      fakeProcess.stderr = new EventEmitter();
      fakeProcess.stdin = { destroyed: false, write() {} };
      fakeProcess.kill = (signal) => {
        fakeProcess.killedWith = signal;
        if (fakeProcesses.length > 1) queueMicrotask(() => fakeProcess.emit("close", 0));
      };
      fakeProcesses.push(fakeProcess);
      writeReadyHls(rootDir, "hls-seek-race");
      return fakeProcess;
    },
  });
  const session = await manager.createSession({
    sourceController,
    baseUrl: "http://backend.test",
    durationSec: 60,
  });
  const sessionDir = path.join(rootDir, session.sessionId);

  const seeked = manager.seekSession(session.sessionId, 24);
  await waitForTurn();
  try {
    assert.equal(fakeProcesses[0].killedWith, "SIGTERM");
    assert.equal(fakeProcesses.length, 1);
    assert.equal(fs.existsSync(sessionDir), true);
  } finally {
    fakeProcesses[0].emit("close", 0);
  }

  assert.equal((await seeked).currentSec, 24);
  assert.equal(fakeProcesses.length, 2);
  await manager.stopSession(session.sessionId);
});

test("HlsTranscodeSessionManager refreshes an RTSP source when seeking cloud fallback", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-test-"));
  const fakeProcesses = [];
  const seekTargets = [];
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "hls-cloud",
    logger: { warn() {} },
    spawn: (command, args) => {
      const fakeProcess = new EventEmitter();
      fakeProcess.stderr = new EventEmitter();
      fakeProcess.kill = (signal) => {
        fakeProcess.killedWith = signal;
        queueMicrotask(() => fakeProcess.emit("close", 0));
      };
      fakeProcesses.push({ fakeProcess, command, args });
      writeReadyHls(rootDir, "hls-cloud");
      return fakeProcess;
    },
  });

  const session = await manager.createSession({
    sourceUrl: "rtsp://example.test/replay-start.sdp",
    seekSource: async (targetSec) => {
      seekTargets.push(targetSec);
      return {
        sourceUrl: `rtsp://example.test/replay-${targetSec}.sdp`,
        currentSec: targetSec,
        durationSec: 60,
      };
    },
    baseUrl: "http://backend.test",
    durationSec: 60,
  });

  const result = await manager.seekSession(session.sessionId, 24);

  assert.deepEqual(seekTargets, [24]);
  assert.equal(fakeProcesses.length, 2);
  assert.equal(fakeProcesses[0].fakeProcess.killedWith, "SIGTERM");
  assert.ok(fakeProcesses[1].args.includes("rtsp://example.test/replay-24.sdp"));
  assert.equal(result.sessionId, session.sessionId);
  assert.equal(result.currentSec, 24);
  assert.equal(result.playUrl, "http://backend.test/api/replay-hls/hls-cloud/index.m3u8?v=1");
  await waitForTurn();
  assert.equal(fakeProcesses.length, 2);
});

test("HlsTranscodeSessionManager handles a segment removed before its stream opens", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-test-"));
  const sessionDir = path.join(rootDir, "hls-read-race");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "seg_00002.ts"), "stale-segment");
  const readStream = new EventEmitter();
  readStream.pipe = () => readStream;
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    logger: { warn() {} },
    createReadStream: () => {
      queueMicrotask(() => {
        const error = new Error("segment removed during seek");
        error.code = "ENOENT";
        readStream.emit("error", error);
      });
      return readStream;
    },
  });
  manager.sessions.set("hls-read-race", {
    id: "hls-read-race",
    dir: sessionDir,
    closed: false,
    lastAccessAt: 0,
  });
  const chunks = [];
  const response = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.headersSent = false;
  response.writeHead = (statusCode) => {
    response.statusCode = statusCode;
    response.headersSent = true;
  };

  await manager.attachHttpResponse("hls-read-race", "seg_00002.ts", response);
  await waitForTurn();

  assert.equal(response.statusCode, 404);
  assert.match(Buffer.concat(chunks).toString(), /hls file expired/);
});

test("HlsTranscodeSessionManager serves complete segments with media length headers", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-http-"));
  const sessionDir = path.join(rootDir, "hls-http");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "seg_00000.ts"), "0123456789");
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    logger: { warn() {} },
  });
  manager.sessions.set("hls-http", {
    id: "hls-http",
    dir: sessionDir,
    closed: false,
    lastAccessAt: 0,
  });
  const response = createCapturingResponse();

  await manager.attachHttpResponse("hls-http", "seg_00000.ts", response, {
    headers: {},
  });
  await response.done;

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "video/mp2t");
  assert.equal(response.headers["Content-Length"], "10");
  assert.equal(response.headers["Accept-Ranges"], "bytes");
  assert.equal(response.body().toString(), "0123456789");
});

test("HlsTranscodeSessionManager honors byte range requests for media segments", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-range-"));
  const sessionDir = path.join(rootDir, "hls-range");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "seg_00000.ts"), "0123456789");
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    logger: { warn() {} },
  });
  manager.sessions.set("hls-range", {
    id: "hls-range",
    dir: sessionDir,
    closed: false,
    lastAccessAt: 0,
  });
  const response = createCapturingResponse();

  await manager.attachHttpResponse("hls-range", "seg_00000.ts", response, {
    headers: { range: "bytes=2-5" },
  });
  await response.done;

  assert.equal(response.statusCode, 206);
  assert.equal(response.headers["Content-Range"], "bytes 2-5/10");
  assert.equal(response.headers["Content-Length"], "4");
  assert.equal(response.body().toString(), "2345");
});

test("HlsTranscodeSessionManager traces HLS session misses and completed segment responses", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-trace-"));
  const sessionDir = path.join(rootDir, "hls-trace-session");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "seg_00000.ts"), "0123456789");
  const logs = [];
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    instanceId: "instance-a",
    logger: {
      info(message) {
        logs.push(message);
      },
      warn() {},
    },
  });

  const missingResponse = createCapturingResponse();
  await manager.attachHttpResponse("missing-session", "index.m3u8", missingResponse, {
    method: "GET",
    headers: {},
  });
  await missingResponse.done;

  manager.sessions.set("hls-trace-session", {
    id: "hls-trace-session",
    dir: sessionDir,
    closed: false,
    lastAccessAt: 0,
  });
  const segmentResponse = createCapturingResponse();
  await manager.attachHttpResponse("hls-trace-session", "seg_00000.ts", segmentResponse, {
    method: "GET",
    headers: { range: "bytes=2-5" },
  });
  await segmentResponse.done;

  assert.match(
    logs.join("\n"),
    /\[DEBUG-HLS-HTTP-7f3a\] miss .*"instance":"instance-a".*"session":"missing-".*"file":"index\.m3u8"/
  );
  assert.match(
    logs.join("\n"),
    /\[DEBUG-HLS-HTTP-7f3a\] begin .*"instance":"instance-a".*"session":"hls-trac".*"file":"seg_00000\.ts".*"status":206.*"bytes":4/
  );
  assert.match(
    logs.join("\n"),
    /\[DEBUG-HLS-HTTP-7f3a\] complete .*"instance":"instance-a".*"session":"hls-trac".*"file":"seg_00000\.ts".*"bytes":4/
  );
});

test("HlsTranscodeSessionManager traces the producing instance when HLS becomes ready", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-ready-trace-"));
  const logs = [];
  const fakeProcess = new EventEmitter();
  fakeProcess.stderr = new EventEmitter();
  fakeProcess.kill = () => queueMicrotask(() => fakeProcess.emit("close", 0));
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => "ready-trace-session",
    instanceId: "producer-a",
    logger: {
      info(message) {
        logs.push(message);
      },
      warn() {},
    },
    spawn: () => {
      const dir = path.join(rootDir, "ready-trace-session");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "seg_00000.ts"), "segment-0");
      fs.writeFileSync(path.join(dir, "seg_00001.ts"), "segment-1");
      fs.writeFileSync(
        path.join(dir, "index.m3u8"),
        "#EXTM3U\n#EXT-X-VERSION:6\nseg_00000.ts\nseg_00001.ts\n"
      );
      return fakeProcess;
    },
  });

  const session = await manager.createSession({
    sourceUrl: "rtsp://example.test/replay.sdp",
    baseUrl: "https://backend.test",
    durationSec: 30,
  });

  const response = createCapturingResponse();
  await manager.attachHttpResponse(session.sessionId, "index.m3u8", response, { method: "GET", headers: {} });
  await response.done;

  assert.match(
    logs.join("\n"),
    /\[DEBUG-HLS-HTTP-7f3a\] ready .*"instance":"producer-a".*"session":"ready-tr".*"file":"index\.m3u8".*"version":6.*"segments":2/
  );
  await manager.stopSession(session.sessionId);
});

function waitForTurn() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitForCondition(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true before timeout");
}

function createCapturingResponse() {
  const chunks = [];
  let resolveDone;
  const response = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.headersSent = false;
  response.headers = {};
  response.writeHead = (statusCode, headers) => {
    response.statusCode = statusCode;
    response.headers = headers;
    response.headersSent = true;
  };
  response.done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  response.on("finish", resolveDone);
  response.body = () => Buffer.concat(chunks);
  return response;
}

function argAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

test("HLS helpers classify playlist, segment, and RTSP URLs", () => {
  assert.equal(contentTypeForHlsFile("index.m3u8"), "application/vnd.apple.mpegurl");
  assert.equal(contentTypeForHlsFile("seg_00001.ts"), "video/mp2t");
  assert.equal(contentTypeForHlsFile("unknown.bin"), "application/octet-stream");
  assert.equal(isRtspUrl("rtsp://example.test/a.sdp"), true);
  assert.equal(isRtspUrl("https://example.test/a.m3u8"), false);
  assert.equal(isRemuxCompatibilityError("Could not write header: Invalid argument"), true);
  assert.equal(isRemuxCompatibilityError("Connection timed out"), false);
});

test("HlsTranscodeSessionManager stops existing sessions for the same device", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-camera-hls-test-"));
  let nextId = 1;
  const fakeProcesses = [];
  const manager = new HlsTranscodeSessionManager({
    rootDir,
    ffmpegPath: "ffmpeg-test",
    idFactory: () => `hls-${nextId++}`,
    logger: { warn() {} },
    spawn: () => {
      const fakeProcess = new EventEmitter();
      fakeProcess.stderr = new EventEmitter();
      fakeProcess.kill = (signal) => {
        fakeProcess.killedWith = signal;
        queueMicrotask(() => fakeProcess.emit("close", 0));
      };
      fakeProcesses.push(fakeProcess);
      writeReadyHls(rootDir, `hls-${fakeProcesses.length}`);
      return fakeProcess;
    },
  });

  await manager.createSession({
    sourceUrl: "rtsp://example.test/one.sdp",
    baseUrl: "http://backend.test",
    durationSec: 60,
    currentSec: 0,
    deviceSn: "device-a",
  });
  await manager.createSession({
    sourceUrl: "rtsp://example.test/two.sdp",
    baseUrl: "http://backend.test",
    durationSec: 60,
    currentSec: 0,
    deviceSn: "device-b",
  });

  const stopped = await manager.stopDeviceSessions("device-a");

  assert.equal(stopped, 1);
  assert.equal(fakeProcesses[0].killedWith, "SIGTERM");
  assert.equal(fakeProcesses[1].killedWith, undefined);
});

function writeReadyHls(rootDir, sessionId) {
  const sessionDir = path.join(rootDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "seg_00000.ts"), "segment-0");
  fs.writeFileSync(path.join(sessionDir, "seg_00001.ts"), "segment-1");
  fs.writeFileSync(path.join(sessionDir, "index.m3u8"), "#EXTM3U\nseg_00000.ts\nseg_00001.ts\n");
}

function writeTimedHls(rootDir, sessionId, segmentCount) {
  const sessionDir = path.join(rootDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const lines = ["#EXTM3U", "#EXT-X-PLAYLIST-TYPE:EVENT"];
  for (let index = 0; index < segmentCount; index += 1) {
    const name = `seg_${String(index).padStart(5, "0")}.ts`;
    fs.writeFileSync(path.join(sessionDir, name), `segment-${index}`);
    lines.push("#EXTINF:1.000000,", name);
  }
  fs.writeFileSync(path.join(sessionDir, "index.m3u8"), `${lines.join("\n")}\n`);
}
