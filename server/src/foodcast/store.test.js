const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { FoodcastStore } = require("./store");

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-store-"));
  const filePath = path.join(dir, "foodcasts.sqlite");
  return { dir, filePath, store: new FoodcastStore(filePath) };
}

function job(overrides = {}) {
  return {
    id: overrides.id || "job-1",
    deviceSn: "SN-1",
    date: "2026-07-16",
    scope: "day",
    mealId: "",
    mode: "natural",
    frameMode: "source",
    targetDurationSec: 60,
    bgmSelection: "random",
    accessToken: "secret-token",
    createdAt: 1000,
    expiresAt: 9000,
    ...overrides,
  };
}

test("FoodcastStore persists jobs and structured render metadata", () => {
  const { filePath, store } = makeStore();
  store.createJob(job());
  store.updateJob("job-1", {
    status: "ready",
    stage: "ready",
    progress: 100,
    segments: [{ clipId: "clip-a", durationSec: 12 }],
    bgm: { id: "cute-1", title: "Cute One" },
    outputPath: "D:/foodcasts/job-1.mp4",
    outputSize: 1234,
    durationSec: 12,
  });
  store.close();

  const reopened = new FoodcastStore(filePath);
  const saved = reopened.getJob("job-1");

  assert.equal(saved.status, "ready");
  assert.equal(saved.progress, 100);
  assert.deepEqual(saved.segments, [{ clipId: "clip-a", durationSec: 12 }]);
  assert.deepEqual(saved.bgm, { id: "cute-1", title: "Cute One" });
  assert.equal(saved.outputSize, 1234);
  assert.equal(saved.targetDurationSec, 60);
});

test("FoodcastStore preserves historical and mode-preset target durations", () => {
  const { store } = makeStore();
  for (const targetDurationSec of [20, 30, 60, 120, 180, 420]) {
    const id = `duration-${targetDurationSec}`;
    store.createJob(job({ id, targetDurationSec }));
    assert.equal(store.getJob(id).targetDurationSec, targetDurationSec);
  }
});

test("FoodcastStore finds active and latest jobs by generation key", () => {
  const { store } = makeStore();
  store.createJob(job({ id: "ready-old", createdAt: 100 }));
  store.updateJob("ready-old", { status: "ready" });
  store.createJob(job({ id: "queued-new", createdAt: 200 }));

  assert.equal(store.findActive(job()).id, "queued-new");
  assert.equal(store.findLatest(job()).id, "queued-new");

  store.updateJob("queued-new", { status: "failed", errorCode: "TRANSCODE_FAILED" });
  assert.equal(store.findActive(job()), null);
  assert.equal(store.findLatest(job()).id, "queued-new");
});

test("FoodcastStore keeps natural and quick-cut jobs under separate generation keys", () => {
  const { store } = makeStore();
  store.createJob(job({ id: "natural", mode: "natural", createdAt: 100 }));
  store.createJob(job({ id: "quick", mode: "quick_cut", createdAt: 200 }));

  assert.equal(store.findActive(job({ mode: "natural" })).id, "natural");
  assert.equal(store.findActive(job({ mode: "quick_cut" })).id, "quick");
  assert.equal(store.getJob("quick").mode, "quick_cut");
});

test("FoodcastStore keeps source and center-crop jobs under separate generation keys", () => {
  const { store } = makeStore();
  store.createJob(job({ id: "source", frameMode: "source", createdAt: 100 }));
  store.createJob(job({ id: "crop", frameMode: "center_crop", createdAt: 200 }));

  assert.equal(store.findActive(job({ frameMode: "source" })).id, "source");
  assert.equal(store.findActive(job({ frameMode: "center_crop" })).id, "crop");
  assert.equal(store.getJob("crop").frameMode, "center_crop");
});

test("FoodcastStore keeps target durations under separate generation keys", () => {
  const { store } = makeStore();
  store.createJob(job({ id: "quick-20", mode: "quick_cut", targetDurationSec: 20, createdAt: 100 }));
  store.createJob(job({ id: "quick-60", mode: "quick_cut", targetDurationSec: 60, createdAt: 200 }));

  assert.equal(store.findActive(job({ mode: "quick_cut", targetDurationSec: 20 })).id, "quick-20");
  assert.equal(store.findActive(job({ mode: "quick_cut", targetDurationSec: 60 })).id, "quick-60");
  assert.equal(store.findLatest(job({ mode: "quick_cut", targetDurationSec: 20 })).id, "quick-20");
  assert.equal(store.findLatest(job({ mode: "quick_cut", targetDurationSec: 60 })).id, "quick-60");
  assert.equal(store.getJob("quick-20").targetDurationSec, 20);
  assert.equal(store.getJob("quick-60").targetDurationSec, 60);
});

test("FoodcastStore keeps music selections under separate active and latest generation keys", () => {
  const { store } = makeStore();
  store.createJob(job({ id: "random", bgmSelection: "random", createdAt: 100 }));
  store.createJob(job({ id: "bgm-01", bgmSelection: "bgm-01", createdAt: 200 }));

  assert.equal(store.findActive(job({ bgmSelection: "random" })).id, "random");
  assert.equal(store.findActive(job({ bgmSelection: "bgm-01" })).id, "bgm-01");
  assert.equal(store.findLatest(job({ bgmSelection: "random" })).id, "random");
  assert.equal(store.findLatest(job({ bgmSelection: "bgm-01" })).id, "bgm-01");
  assert.equal(store.getJob("random").bgmSelection, "random");
  assert.equal(store.getJob("bgm-01").bgmSelection, "bgm-01");
});

test("FoodcastStore normalizes empty music selections to random", () => {
  const { store } = makeStore();
  store.createJob(job({ id: "blank", bgmSelection: "  \t " }));

  assert.equal(store.getJob("blank").bgmSelection, "random");
  assert.equal(store.findLatest(job({ bgmSelection: "" })).id, "blank");
});

test("FoodcastStore migrates legacy databases to the default target duration without losing jobs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-store-legacy-"));
  const filePath = path.join(dir, "foodcasts.sqlite");
  const legacy = new DatabaseSync(filePath);
  legacy.exec(`
    CREATE TABLE foodcast_jobs (
      id TEXT PRIMARY KEY,
      device_sn TEXT NOT NULL,
      date TEXT NOT NULL,
      scope TEXT NOT NULL,
      meal_id TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'natural',
      frame_mode TEXT NOT NULL DEFAULT 'source',
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      segments_json TEXT NOT NULL DEFAULT '[]',
      bgm_json TEXT NOT NULL DEFAULT '{}',
      output_path TEXT NOT NULL DEFAULT '',
      output_size INTEGER NOT NULL DEFAULT 0,
      duration_sec REAL NOT NULL DEFAULT 0,
      access_token TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    INSERT INTO foodcast_jobs (
      id, device_sn, date, scope, meal_id, mode, frame_mode, status, stage,
      access_token, created_at, updated_at, expires_at
    ) VALUES (
      'legacy-job', 'SN-1', '2026-07-16', 'day', '', 'quick_cut', 'source',
      'ready', 'ready', 'legacy-token', 100, 100, 9000
    );
  `);
  legacy.close();

  const migrated = new FoodcastStore(filePath);
  const saved = migrated.getJob("legacy-job");

  assert.equal(saved.id, "legacy-job");
  assert.equal(saved.status, "ready");
  assert.equal(saved.targetDurationSec, 60);
  assert.equal(saved.bgmSelection, "random");
  assert.equal(migrated.findLatest(job({ mode: "quick_cut", targetDurationSec: 60 })).id, "legacy-job");
  assert.equal(migrated.findLatest(job({ mode: "quick_cut", targetDurationSec: 20 })), null);
  const columns = migrated.db.prepare("PRAGMA table_info(foodcast_jobs)").all();
  assert.ok(columns.some((column) => column.name === "target_duration_sec"));
  const bgmSelectionColumn = columns.find((column) => column.name === "bgm_selection");
  assert.equal(bgmSelectionColumn.notnull, 1);
  assert.equal(bgmSelectionColumn.dflt_value, "'random'");
  const indexes = migrated.db.prepare("PRAGMA index_list(foodcast_jobs)").all();
  assert.ok(indexes.some((index) => index.name === "idx_foodcast_jobs_bgm_key"));
  assert.deepEqual(
    migrated.db.prepare("PRAGMA index_info(idx_foodcast_jobs_bgm_key)").all()
      .map((column) => column.name),
    [
      "device_sn",
      "date",
      "scope",
      "meal_id",
      "mode",
      "frame_mode",
      "target_duration_sec",
      "bgm_selection",
      "created_at",
    ]
  );
});

test("FoodcastStore requeues interrupted running jobs after restart", () => {
  const { filePath, store } = makeStore();
  store.createJob(job());
  store.updateJob("job-1", { status: "running", stage: "rendering", progress: 65, attempts: 1 });
  store.close();

  const reopened = new FoodcastStore(filePath);
  const recovered = reopened.recoverInterrupted();

  assert.equal(recovered, 1);
  assert.equal(reopened.getJob("job-1").status, "queued");
  assert.equal(reopened.getJob("job-1").stage, "queued");
  assert.equal(reopened.getJob("job-1").progress, 0);
  assert.equal(reopened.listQueued()[0].id, "job-1");
});

test("FoodcastStore expires ready jobs and returns their output files", () => {
  const { store } = makeStore();
  store.createJob(job({ id: "expired", expiresAt: 1000 }));
  store.updateJob("expired", { status: "ready", outputPath: "D:/foodcasts/expired.mp4", outputSize: 500 });
  store.createJob(job({ id: "current", expiresAt: 5000 }));
  store.updateJob("current", { status: "ready", outputPath: "D:/foodcasts/current.mp4", outputSize: 500 });

  const files = store.expireBefore(2000);

  assert.deepEqual(files, ["D:/foodcasts/expired.mp4"]);
  assert.equal(store.getJob("expired").status, "expired");
  assert.equal(store.getJob("current").status, "ready");
});

