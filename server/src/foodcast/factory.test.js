const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createDefaultFoodcastAutomationService,
  createDefaultFoodcastService,
} = require("./factory");

test("createDefaultFoodcastService wires config, diary lookup, BGM, and renderer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-factory-"));
  const bgmDir = path.join(dir, "bgm");
  fs.mkdirSync(bgmDir, { recursive: true });
  fs.writeFileSync(path.join(bgmDir, "cute.mp3"), "audio");
  fs.writeFileSync(path.join(bgmDir, "library.json"), JSON.stringify({
    tracks: [{ id: "cute", file: "cute.mp3" }],
  }));
  const calls = [];
  const coordinator = {
    store: {
      getDiary(date, deviceSn) {
        calls.push({ date, deviceSn });
        return { date, deviceSn, clips: [], meals: [] };
      },
    },
  };
  const service = createDefaultFoodcastService({
    config: {
      foodcast: {
        stateFile: path.join(dir, "foodcasts.sqlite"),
        outputDir: path.join(dir, "outputs"),
        tempDir: path.join(dir, "temp"),
        bgmDir,
        concurrency: 1,
        maxRetries: 2,
        retryDelayMs: 0,
        retentionMs: 10_000,
        maxStorageBytes: 20_000,
        ffmpegPath: "ffmpeg-test",
      },
    },
    coordinator,
  });

  const diary = await service.getDiary("SN-FACTORY", "2026-07-16");

  assert.equal(diary.deviceSn, "SN-FACTORY");
  assert.deepEqual(calls, [{ date: "2026-07-16", deviceSn: "SN-FACTORY" }]);
  assert.equal(service.bgmLibrary.list()[0].id, "cute");
  assert.equal(service.renderer.ffmpegPath, "ffmpeg-test");
  service.store.close();
});

test("createDefaultFoodcastAutomationService uses durable local adapters outside Cloud Hosting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-automation-factory-"));
  const bgmDir = path.join(dir, "bgm");
  fs.mkdirSync(bgmDir, { recursive: true });
  fs.writeFileSync(path.join(bgmDir, "cute.mp3"), "audio");
  fs.writeFileSync(path.join(bgmDir, "library.json"), JSON.stringify({
    tracks: [{ id: "cute", file: "cute.mp3" }],
  }));
  const service = createDefaultFoodcastAutomationService({
    config: {
      cloudHosting: false,
      foodcast: {
        outputDir: path.join(dir, "outputs"),
        tempDir: path.join(dir, "temp"),
        bgmDir,
        ffmpegPath: "ffmpeg-test",
        cleanupIntervalMs: 60_000,
        materials: {
          stateFile: path.join(dir, "materials.sqlite"),
          collection: "materials",
          retentionMs: 10_000,
          mealGapMs: 600_000,
          leaseMs: 60_000,
        },
      },
    },
    resolveOwnerOpenid: async () => "owner",
    resolveSource: async () => "source",
    shouldYieldHeavyWork: () => true,
  });

  assert.equal(service.catalog.constructor.name, "MaterialCatalog");
  assert.equal(service.mediaStorage.constructor.name, "LocalMediaStorage");
  assert.equal(service.renderer.ffmpegPath, "ffmpeg-test");
  assert.equal(service.heavyWorkBlocked(), true);
  service.catalog.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

