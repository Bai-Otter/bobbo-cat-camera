const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { LiveRecordingStore } = require("./liveRecordingStore");
const { SdRecordingExportSession } = require("./sdRecordingExportSession");

async function fixture({ windows = [], outputBytes = 2048 } = {}) {
  const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "sd-recording-export-"));
  const store = new LiveRecordingStore({ filePath: path.join(rootDir, "jobs.json") });
  const spawnCalls = [];
  const uploads = [];
  let now = 1_000_000;
  const session = new SdRecordingExportSession({
    ffmpegPath: "ffmpeg-test",
    rootDir: path.join(rootDir, "tmp"),
    store,
    mediaStorage: {
      async upload(cloudPath, localPath) {
        uploads.push({ cloudPath, localPath });
        return { fileId: "cloud://env/recording.mp4" };
      },
    },
    async resolveRecordingWindow() { return windows; },
    spawn(command, args) {
      spawnCalls.push({ command, args });
      const outputPath = args.at(-1);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, Buffer.alloc(outputBytes, 1));
      const child = new (require("node:events").EventEmitter)();
      child.stderr = new (require("node:stream").PassThrough)();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
    idFactory: () => "record-1",
    tokenFactory: () => "access-token",
    now: () => now,
    sleep: async () => {},
    discoveryTimeoutMs: 5,
    discoveryIntervalMs: 1,
  });
  return { rootDir, store, spawnCalls, uploads, session, setNow(value) { now = value; } };
}

test("start records timestamps without resolving or spawning media", async () => {
  let resolved = 0;
  const f = await fixture();
  f.session.resolveRecordingWindow = async () => { resolved += 1; return []; };
  try {
    const started = await f.session.start({ ownerOpenid: "owner", deviceSn: "SN-1" });
    assert.equal(started.status, "recording");
    assert.equal(started.startedAt, 1_000_000);
    assert.equal(resolved, 0);
    assert.equal(f.spawnCalls.length, 0);
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("exportWindow finalizes an existing historical interval without waiting in recording state", async () => {
  const f = await fixture({ windows: [
    { sourceUrl: "https://camera.test/history.m3u8", inpointSec: 4, outpointSec: 12 },
  ] });
  try {
    const finalizing = await f.session.exportWindow({
      ownerOpenid: "owner",
      actorOpenid: "member",
      deviceSn: "SN-1",
      startedAt: 900_000,
      endedAt: 908_000,
    });
    assert.equal(finalizing.status, "finalizing");
    assert.equal(finalizing.startedAt, 900_000);
    assert.equal(finalizing.endedAt, 908_000);
    assert.equal(finalizing.durationSec, 8);
    const ready = await f.session.completion;
    assert.equal(ready.status, "ready");
    assert.equal(ready.actorOpenid, "member");
    assert.equal(f.spawnCalls.length, 1);
    assert.equal(f.uploads.length, 1);
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("exportWindow rejects invalid or overlong historical intervals", async () => {
  const invalid = await fixture();
  const overlong = await fixture();
  try {
    await assert.rejects(
      invalid.session.exportWindow({ ownerOpenid: "owner", deviceSn: "SN-1", startedAt: 10, endedAt: 10 }),
      /RECORDING_WINDOW_INVALID/
    );
    await assert.rejects(
      overlong.session.exportWindow({ ownerOpenid: "owner", deviceSn: "SN-1", startedAt: 10, endedAt: 400_010 }),
      /RECORDING_DURATION_EXCEEDED/
    );
  } finally {
    await fsPromises.rm(invalid.rootDir, { recursive: true, force: true });
    await fsPromises.rm(overlong.rootDir, { recursive: true, force: true });
  }
});

test("recording discovery retains the device profile authorized at start", async () => {
  const f = await fixture();
  const device = { sn: "SN-1", ownerOpenid: "owner", password: "device-secret" };
  let discoveryInput;
  f.session.resolveRecordingWindow = async (input) => {
    discoveryInput = input;
    return [{ sourceUrl: "https://camera.test/replay.m3u8", inpointSec: 0, outpointSec: 5 }];
  };
  try {
    await f.session.start({ ownerOpenid: "owner", deviceSn: "SN-1", device });
    f.setNow(1_005_000);
    await f.session.stop();
    await f.session.completion;

    assert.deepEqual(discoveryInput.device, device);
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("stop returns finalizing immediately while SD export finishes in background", async () => {
  let releaseDiscovery;
  const f = await fixture();
  f.session.resolveRecordingWindow = () => new Promise((resolve) => { releaseDiscovery = resolve; });
  try {
    await f.session.start({ ownerOpenid: "owner", deviceSn: "SN-1" });
    f.setNow(1_005_000);
    const finalizing = await f.session.stop();
    assert.equal(finalizing.status, "finalizing");
    assert.equal(finalizing.endedAt, 1_005_000);
    assert.equal(f.spawnCalls.length, 0);
    releaseDiscovery([{ sourceUrl: "https://camera.test/replay.m3u8", inpointSec: 0, outpointSec: 5 }]);
    const ready = await f.session.completion;
    assert.equal(ready.status, "ready");
    assert.equal(f.spawnCalls.length, 1);
    assert.equal(f.uploads.length, 1);
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("SD export uses concat input and stream copy instead of encoding", async () => {
  const f = await fixture({ windows: [
    { sourceUrl: "https://camera.test/a.m3u8", inpointSec: 2, outpointSec: 8 },
    { sourceUrl: "https://camera.test/b.m3u8", inpointSec: 0, outpointSec: 3 },
  ] });
  try {
    await f.session.start({ ownerOpenid: "owner", deviceSn: "SN-1" });
    f.setNow(1_009_000);
    await f.session.stop();
    await f.session.completion;
    const args = f.spawnCalls[0].args;
    assert.ok(args.includes("concat"));
    assert.ok(args.includes("copy"));
    assert.ok(args.includes("+faststart"));
    assert.doesNotMatch(args.join(" "), /libx264|scale|fps|bitrate/i);
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("SD export fails cleanly when the device recording window never appears", async () => {
  const f = await fixture();
  let clock = 2_000_000;
  f.session.now = () => clock;
  f.session.resolveRecordingWindow = async () => [];
  f.session.sleep = async (milliseconds) => { clock += milliseconds; };
  try {
    await f.session.start({ ownerOpenid: "owner", deviceSn: "SN-1" });
    clock += 3_000;
    await f.session.stop();
    const failed = await f.session.completion;
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "RECORDING_WINDOW_NOT_READY");
    assert.equal(f.spawnCalls.length, 0);
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});

test("SD export assigns a safe error code when the recording resolver throws an SDK error", async () => {
  const f = await fixture();
  f.session.resolveRecordingWindow = async () => {
    throw new Error("SDK request failed");
  };
  try {
    await f.session.start({ ownerOpenid: "owner", deviceSn: "SN-1" });
    f.setNow(1_005_000);
    await f.session.stop();
    const failed = await f.session.completion;
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "RECORDING_FINALIZE_FAILED");
  } finally {
    await fsPromises.rm(f.rootDir, { recursive: true, force: true });
  }
});
