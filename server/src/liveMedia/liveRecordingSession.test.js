const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { LiveRecordingStore } = require("./liveRecordingStore");
const { LiveRecordingSession } = require("./liveRecordingSession");

function makeChild({ closeOnQuit = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.writes = [];
  child.stdin.on("data", (chunk) => {
    child.writes.push(String(chunk));
    if (closeOnQuit && String(chunk).includes("q")) queueMicrotask(() => child.emit("close", 0, null));
  });
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => child.emit("close", signal === "SIGKILL" ? 137 : 0, signal));
    return true;
  };
  return child;
}

async function fixture({
  outputBytes = 2048,
  ffmpegStderr = "",
  uploadError = null,
  closeOnQuit = true,
  storeUpdateError = null,
  recordingStatusError = null,
  resolveSourceUrl = null,
  fsApi = fsPromises,
} = {}) {
  const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "live-recording-session-"));
  const store = new LiveRecordingStore({ filePath: path.join(rootDir, "jobs.json") });
  if (storeUpdateError) {
    const updateJob = store.updateJob.bind(store);
    let failed = false;
    store.updateJob = async (id, patch) => {
      if (!failed && patch.status === "finalizing") {
        failed = true;
        throw storeUpdateError;
      }
      return updateJob(id, patch);
    };
  }
  if (recordingStatusError) {
    const updateJob = store.updateJob.bind(store);
    let failed = false;
    store.updateJob = async (id, patch) => {
      if (!failed && patch.status === "recording") {
        failed = true;
        throw recordingStatusError;
      }
      return updateJob(id, patch);
    };
  }
  const child = makeChild({ closeOnQuit });
  const spawnCalls = [];
  const uploads = [];
  const errors = [];
  const session = new LiveRecordingSession({
    ffmpegPath: "ffmpeg-test",
    rootDir: path.join(rootDir, "tmp"),
    store,
    mediaStorage: {
      async upload(cloudPath, localPath) {
        uploads.push({ cloudPath, localPath });
        if (uploadError) throw uploadError;
        return { fileId: "cloud://env/live-recordings/record-1.mp4" };
      },
    },
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      if (outputBytes !== null) {
        fs.mkdirSync(path.dirname(args.at(-1)), { recursive: true });
        fs.writeFileSync(args.at(-1), Buffer.alloc(outputBytes, 7));
      }
      if (ffmpegStderr) child.stderr.write(ffmpegStderr);
      return child;
    },
    idFactory: () => "record-1",
    tokenFactory: () => "access-secret",
    now: () => 1_000,
    stopTimeoutMs: 10,
    logger: { warn() {}, error(message, detail) { errors.push({ message, detail }); } },
    resolveSourceUrl,
    fsApi,
  });
  return { rootDir, store, child, spawnCalls, uploads, errors, session };
}

const input = {
  ownerOpenid: "openid-owner",
  deviceSn: "SN-1",
  hlsSessionId: "hls-1",
  sourceUrl: "https://backend.test/hls/hls-1/index.m3u8",
  httpProxy: "http://127.0.0.1:7897",
};

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

test("live recording transcodes an owned HLS session to a phone-compatible 1440p MP4", async () => {
  const f = await fixture();
  try {
    const started = await f.session.start(input);
    assert.equal(started.status, "recording");
    const call = f.spawnCalls[0];
    assert.equal(call.command, "ffmpeg-test");
    assert.deepEqual(call.options, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    assert.ok(call.args.includes("https://backend.test/hls/hls-1/index.m3u8"));
    assert.equal(call.args[call.args.indexOf("-http_proxy") + 1], "http://127.0.0.1:7897");
    assert.ok(call.args.includes("300"));
    assert.ok(call.args.includes("0:v:0?"));
    assert.ok(call.args.includes("0:a:0?"));
    assert.equal(optionValue(call.args, "-c:v"), "libx264");
    assert.equal(optionValue(call.args, "-preset"), "veryfast");
    assert.equal(optionValue(call.args, "-crf"), "23");
    assert.equal(
      optionValue(call.args, "-vf"),
      "scale=iw:ih:in_range=full:out_range=tv,format=yuv420p"
    );
    assert.equal(optionValue(call.args, "-tag:v"), "avc1");
    assert.equal(optionValue(call.args, "-c:a"), "aac");
    assert.equal(optionValue(call.args, "-b:a"), "128k");
    assert.ok(!call.args.includes("copy"));
    assert.ok(call.args.includes("+faststart"));
    assert.doesNotMatch(call.args.join(" "), /scale=1920|scale=1280|h264_nvenc|hevc_nvenc/i);

    const ready = await f.session.stop();
    assert.equal(ready.status, "ready");
    assert.equal(ready.fileId, "cloud://env/live-recordings/record-1.mp4");
    assert.deepEqual(f.child.writes, ["q\n"]);
    assert.match(f.uploads[0].cloudPath, /^live-recordings\/openid-owner\/SN-1\/1970-01-01\/record-1\/recording\.mp4$/);
    await assert.rejects(fsPromises.stat(f.uploads[0].localPath), { code: "ENOENT" });
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("live recording resolves a trusted source for the authorized owner and device", async () => {
  const resolverCalls = [];
  const f = await fixture({
    resolveSourceUrl: async (context) => {
      resolverCalls.push(context);
      return "https://camera.test/second-live/index.m3u8";
    },
  });
  try {
    await f.session.start({ ownerOpenid: "openid-owner", deviceSn: "SN-1", device: { sn: "SN-1" } });
    assert.deepEqual(resolverCalls, [{
      ownerOpenid: "openid-owner",
      deviceSn: "SN-1",
      device: { sn: "SN-1" },
    }]);
    assert.ok(f.spawnCalls[0].args.includes("https://camera.test/second-live/index.m3u8"));
    await f.session.stop();
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("live recording persists source resolution failures without starting ffmpeg", async () => {
  const f = await fixture({
    resolveSourceUrl: async () => {
      throw new Error("second stream rejected");
    },
  });
  try {
    await assert.rejects(
      f.session.start({ ownerOpenid: "openid-owner", deviceSn: "SN-1", device: { sn: "SN-1" } }),
      { code: "RECORDING_SOURCE_FAILED" }
    );
    assert.equal(f.spawnCalls.length, 0);
    const saved = await f.store.getOwnedJob("openid-owner", "record-1");
    assert.equal(saved.status, "failed");
    assert.equal(saved.errorCode, "RECORDING_SOURCE_FAILED");
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("live recording marks directory preparation failures instead of leaving a starting job", async () => {
  const f = await fixture({
    resolveSourceUrl: async () => "https://camera.test/second-live/index.m3u8",
    fsApi: {
      ...fsPromises,
      async mkdir() {
        throw new Error("disk unavailable");
      },
    },
  });
  try {
    await assert.rejects(
      f.session.start({ ownerOpenid: "openid-owner", deviceSn: "SN-1" }),
      { code: "RECORDING_START_FAILED" }
    );
    const saved = await f.store.getOwnedJob("openid-owner", "record-1");
    assert.equal(saved.status, "failed");
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("live recording terminates ffmpeg when recording status persistence fails", async () => {
  const f = await fixture({
    resolveSourceUrl: async () => "https://camera.test/second-live/index.m3u8",
    recordingStatusError: new Error("database unavailable"),
  });
  try {
    await assert.rejects(
      f.session.start({ ownerOpenid: "openid-owner", deviceSn: "SN-1" }),
      { code: "RECORDING_START_FAILED" }
    );
    assert.deepEqual(f.child.kills, ["SIGTERM"]);
    const saved = await f.store.getOwnedJob("openid-owner", "record-1");
    assert.equal(saved.status, "failed");
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("live recording rejects unusable output and removes partial files", async () => {
  const f = await fixture({ outputBytes: 8 });
  try {
    await f.session.start(input);
    await assert.rejects(f.session.stop(), { code: "RECORDING_OUTPUT_INVALID" });
    const saved = await f.store.getOwnedJob("openid-owner", "record-1");
    assert.equal(saved.status, "failed");
    assert.equal(saved.errorCode, "RECORDING_OUTPUT_INVALID");
    await assert.rejects(fsPromises.stat(path.join(f.rootDir, "tmp", "record-1", "recording.part.mp4")), { code: "ENOENT" });
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("live recording maps a missing FFmpeg output to a stable error and logs sanitized diagnostics", async () => {
  const f = await fixture({
    outputBytes: null,
    ffmpegStderr: "https://camera.test/live/index.m3u8?token=secret: Server returned 403 Forbidden",
  });
  try {
    await f.session.start(input);
    await assert.rejects(f.session.stop(), { code: "RECORDING_OUTPUT_INVALID" });
    const saved = await f.store.getOwnedJob("openid-owner", "record-1");
    assert.equal(saved.errorCode, "RECORDING_OUTPUT_INVALID");
    assert.match(f.errors[0].detail.ffmpeg, /403 Forbidden/);
    assert.doesNotMatch(f.errors[0].detail.ffmpeg, /camera\.test|secret/);
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("live recording cleans finalized local media when cloud upload fails", async () => {
  const error = Object.assign(new Error("upload failed"), { code: "CLOUD_MEDIA_UPLOAD_FAILED" });
  const f = await fixture({ uploadError: error });
  try {
    await f.session.start(input);
    await assert.rejects(f.session.stop(), { code: "CLOUD_MEDIA_UPLOAD_FAILED" });
    const saved = await f.store.getOwnedJob("openid-owner", "record-1");
    assert.equal(saved.status, "failed");
    assert.equal(f.errors[0].detail.stage, "upload");
    assert.equal(f.errors[0].detail.error, "CLOUD_MEDIA_UPLOAD_FAILED");
    const mediaDir = path.join(f.rootDir, "tmp", "record-1");
    assert.deepEqual(await fsPromises.readdir(mediaDir), []);
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("live recording auto-stop callback finalizes at the five-minute boundary", async () => {
  let autoStop;
  let delay;
  const f = await fixture();
  f.session.scheduleTimeout = (callback, timeoutMs) => {
    autoStop = callback;
    delay = timeoutMs;
    return { callback };
  };
  f.session.cancelTimeout = () => {};
  try {
    await f.session.start(input);
    assert.equal(delay, 300_000);
    const ready = await autoStop();
    assert.equal(ready.status, "ready");
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("live recording preserves the media when the intermediate finalizing status write is transient", async () => {
  const f = await fixture({ storeUpdateError: new Error("temporary database failure") });
  try {
    await f.session.start(input);
    const ready = await f.session.stop();
    assert.equal(ready.status, "ready");
    assert.equal(ready.fileId, "cloud://env/live-recordings/record-1.mp4");
    assert.equal(f.uploads.length, 1);
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});
