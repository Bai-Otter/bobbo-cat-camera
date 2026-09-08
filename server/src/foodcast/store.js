const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const COLUMN_MAP = {
  status: "status",
  stage: "stage",
  progress: "progress",
  segments: "segments_json",
  bgm: "bgm_json",
  outputPath: "output_path",
  outputSize: "output_size",
  durationSec: "duration_sec",
  attempts: "attempts",
  errorCode: "error_code",
  errorMessage: "error_message",
  expiresAt: "expires_at",
  updatedAt: "updated_at",
};

class FoodcastStore {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS foodcast_jobs (
        id TEXT PRIMARY KEY,
        device_sn TEXT NOT NULL,
        date TEXT NOT NULL,
        scope TEXT NOT NULL,
        meal_id TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'natural',
        frame_mode TEXT NOT NULL DEFAULT 'source',
        target_duration_sec INTEGER NOT NULL DEFAULT 60,
        bgm_selection TEXT NOT NULL DEFAULT 'random',
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
      CREATE INDEX IF NOT EXISTS idx_foodcast_jobs_key
        ON foodcast_jobs(device_sn, date, scope, meal_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_foodcast_jobs_status
        ON foodcast_jobs(status, created_at);
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(foodcast_jobs)").all().map((row) => row.name));
    if (!columns.has("mode")) {
      this.db.exec("ALTER TABLE foodcast_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'natural'");
    }
    if (!columns.has("frame_mode")) {
      this.db.exec("ALTER TABLE foodcast_jobs ADD COLUMN frame_mode TEXT NOT NULL DEFAULT 'source'");
    }
    if (!columns.has("target_duration_sec")) {
      this.db.exec("ALTER TABLE foodcast_jobs ADD COLUMN target_duration_sec INTEGER NOT NULL DEFAULT 60");
    }
    if (!columns.has("bgm_selection")) {
      this.db.exec("ALTER TABLE foodcast_jobs ADD COLUMN bgm_selection TEXT NOT NULL DEFAULT 'random'");
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_foodcast_jobs_mode_key
        ON foodcast_jobs(device_sn, date, scope, meal_id, mode, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_foodcast_jobs_frame_key
        ON foodcast_jobs(device_sn, date, scope, meal_id, mode, frame_mode, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_foodcast_jobs_target_key
        ON foodcast_jobs(
          device_sn, date, scope, meal_id, mode, frame_mode, target_duration_sec, created_at DESC
        );
      CREATE INDEX IF NOT EXISTS idx_foodcast_jobs_bgm_key
        ON foodcast_jobs(
          device_sn, date, scope, meal_id, mode, frame_mode, target_duration_sec,
          bgm_selection, created_at DESC
        );
    `);
  }

  createJob(input) {
    const createdAt = Number(input.createdAt) || Date.now();
    this.db.prepare(`
      INSERT INTO foodcast_jobs (
        id, device_sn, date, scope, meal_id, mode, frame_mode, target_duration_sec, bgm_selection,
        status, stage, progress,
        access_token, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, ?, ?, ?)
    `).run(
      input.id,
      input.deviceSn,
      input.date,
      input.scope || "day",
      input.mealId || "",
      input.mode === "quick_cut" ? "quick_cut" : "natural",
      input.frameMode === "center_crop" ? "center_crop" : "source",
      normalizeTargetDurationSec(input.targetDurationSec),
      normalizeBgmSelection(input.bgmSelection),
      input.accessToken,
      createdAt,
      createdAt,
      Number(input.expiresAt) || createdAt
    );
    return this.getJob(input.id);
  }

  getJob(id) {
    return hydrate(this.db.prepare("SELECT * FROM foodcast_jobs WHERE id = ?").get(id));
  }

  updateJob(id, patch = {}) {
    const entries = Object.entries(patch).filter(([key]) => COLUMN_MAP[key]);
    if (!entries.some(([key]) => key === "updatedAt")) entries.push(["updatedAt", Date.now()]);
    const assignments = entries.map(([key]) => `${COLUMN_MAP[key]} = ?`).join(", ");
    const values = entries.map(([key, value]) => {
      if (key === "segments" || key === "bgm") return JSON.stringify(value || (key === "segments" ? [] : {}));
      return value;
    });
    this.db.prepare(`UPDATE foodcast_jobs SET ${assignments} WHERE id = ?`).run(...values, id);
    return this.getJob(id);
  }

  findActive(input) {
    return this.findByKey(input, "AND status IN ('queued', 'running')");
  }

  findLatest(input) {
    return this.findByKey(input, "");
  }

  findByKey(input, extraWhere) {
    return hydrate(this.db.prepare(`
      SELECT * FROM foodcast_jobs
      WHERE device_sn = ? AND date = ? AND scope = ? AND meal_id = ? AND mode = ? AND frame_mode = ?
        AND target_duration_sec = ? AND bgm_selection = ?
      ${extraWhere}
      ORDER BY created_at DESC LIMIT 1
    `).get(
      input.deviceSn,
      input.date,
      input.scope || "day",
      input.mealId || "",
      input.mode === "quick_cut" ? "quick_cut" : "natural",
      input.frameMode === "center_crop" ? "center_crop" : "source",
      normalizeTargetDurationSec(input.targetDurationSec),
      normalizeBgmSelection(input.bgmSelection)
    ));
  }

  listQueued() {
    return this.db.prepare("SELECT * FROM foodcast_jobs WHERE status = 'queued' ORDER BY created_at")
      .all()
      .map(hydrate);
  }

  recoverInterrupted() {
    const result = this.db.prepare(`
      UPDATE foodcast_jobs
      SET status = 'queued', stage = 'queued', progress = 0, updated_at = ?
      WHERE status = 'running'
    `).run(Date.now());
    return Number(result.changes) || 0;
  }

  expireBefore(now) {
    const rows = this.db.prepare(`
      SELECT id, output_path FROM foodcast_jobs
      WHERE status = 'ready' AND expires_at <= ?
    `).all(now);
    this.db.prepare(`
      UPDATE foodcast_jobs
      SET status = 'expired', stage = 'expired', progress = 0, updated_at = ?
      WHERE status = 'ready' AND expires_at <= ?
    `).run(Date.now(), now);
    return rows.map((row) => row.output_path).filter(Boolean);
  }

  expireJob(id) {
    return this.updateJob(id, { status: "expired", stage: "expired", progress: 0 });
  }

  listReadyOldest() {
    return this.db.prepare(`
      SELECT * FROM foodcast_jobs WHERE status = 'ready' ORDER BY created_at
    `).all().map(hydrate);
  }

  close() {
    this.db.close();
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch (error) {
    return fallback;
  }
}

function normalizeTargetDurationSec(value) {
  const targetDurationSec = Number(value);
  return [20, 30, 60, 120, 180, 420].includes(targetDurationSec) ? targetDurationSec : 60;
}

function normalizeBgmSelection(value) {
  const bgmSelection = typeof value === "string" ? value.trim() : "";
  return bgmSelection || "random";
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    deviceSn: row.device_sn,
    date: row.date,
    scope: row.scope,
    mealId: row.meal_id,
    mode: row.mode === "quick_cut" ? "quick_cut" : "natural",
    frameMode: row.frame_mode === "center_crop" ? "center_crop" : "source",
    targetDurationSec: normalizeTargetDurationSec(row.target_duration_sec),
    bgmSelection: normalizeBgmSelection(row.bgm_selection),
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress) || 0,
    segments: parseJson(row.segments_json, []),
    bgm: parseJson(row.bgm_json, {}),
    outputPath: row.output_path,
    outputSize: Number(row.output_size) || 0,
    durationSec: Number(row.duration_sec) || 0,
    accessToken: row.access_token,
    attempts: Number(row.attempts) || 0,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    expiresAt: Number(row.expires_at) || 0,
  };
}

module.exports = { FoodcastStore };
