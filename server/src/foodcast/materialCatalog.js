const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function parseJson(value) {
  return JSON.parse(value || "{}");
}

function sortByTimeThenId(rows, timeKey) {
  return rows.sort((left, right) => (
    Number(left[timeKey]) - Number(right[timeKey]) || String(left.id).localeCompare(String(right.id))
  ));
}

class MaterialCatalog {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS foodcast_material_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        owner_openid TEXT NOT NULL DEFAULT '',
        device_sn TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        due_at INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        file_id TEXT NOT NULL DEFAULT '',
        body_json TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX IF NOT EXISTS idx_foodcast_material_records_lookup
        ON foodcast_material_records(kind, device_sn, date, status);
      CREATE INDEX IF NOT EXISTS idx_foodcast_material_records_due
        ON foodcast_material_records(kind, status, due_at);
      CREATE INDEX IF NOT EXISTS idx_foodcast_material_records_expiry
        ON foodcast_material_records(kind, expires_at);
      CREATE TABLE IF NOT EXISTS foodcast_daily_latest (
        pointer_id TEXT PRIMARY KEY,
        owner_openid TEXT NOT NULL,
        device_sn TEXT NOT NULL,
        date TEXT NOT NULL,
        material_id TEXT NOT NULL,
        body_json TEXT NOT NULL
      );
    `);
    this.upsertStatement = this.db.prepare(`
      INSERT INTO foodcast_material_records (
        kind, id, owner_openid, device_sn, date, status, due_at, expires_at, file_id, body_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET
        owner_openid = excluded.owner_openid,
        device_sn = excluded.device_sn,
        date = excluded.date,
        status = excluded.status,
        due_at = excluded.due_at,
        expires_at = excluded.expires_at,
        file_id = excluded.file_id,
        body_json = excluded.body_json
    `);
  }

  write(kind, document) {
    this.upsertStatement.run(
      kind,
      document.id,
      document.ownerOpenid || "",
      document.deviceSn || "",
      document.date || "",
      document.status || "",
      Number(document.dueAt) || 0,
      Number(document.expiresAt) || 0,
      document.fileId || "",
      JSON.stringify(document)
    );
    return document;
  }

  read(kind, id) {
    const row = this.db.prepare(`
      SELECT body_json FROM foodcast_material_records WHERE kind = ? AND id = ?
    `).get(kind, id);
    return row ? parseJson(row.body_json) : null;
  }

  async upsertInterval(value) {
    return this.write("interval", value);
  }

  async listIntervals(deviceSn, date) {
    return this.db.prepare(`
      SELECT body_json FROM foodcast_material_records
      WHERE kind = 'interval' AND device_sn = ? AND date = ?
      ORDER BY json_extract(body_json, '$.startMs'), id
    `).all(deviceSn, date).map((row) => parseJson(row.body_json));
  }

  async replaceMeals(deviceSn, date, meals) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM foodcast_material_records WHERE kind = 'meal' AND device_sn = ? AND date = ?`)
        .run(deviceSn, date);
      for (const meal of Array.isArray(meals) ? meals : []) this.write("meal", meal);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async listDueMeals(nowMs, limit = 50) {
    return this.db.prepare(`
      SELECT body_json FROM foodcast_material_records
      WHERE kind = 'meal' AND status = 'pending' AND due_at <= ?
      ORDER BY due_at, id LIMIT ?
    `).all(Number(nowMs), Math.max(1, Number(limit) || 50)).map((row) => parseJson(row.body_json));
  }

  async putJob(value) {
    return this.write("job", value);
  }

  async getJob(id) {
    return this.read("job", id);
  }

  async claimJob(id, workerId, nowMs, leaseMs) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read("job", id);
      const claimable = current && (
        current.status === "queued"
        || (current.status === "running" && Number(current.leaseExpiresAt) <= Number(nowMs))
      );
      if (!claimable) {
        this.db.exec("COMMIT");
        return null;
      }
      const claimed = {
        ...current,
        status: "running",
        leaseOwner: String(workerId),
        leaseExpiresAt: Number(nowMs) + Number(leaseMs),
        updatedAt: Number(nowMs),
      };
      this.write("job", claimed);
      this.db.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async updateJob(id, patch = {}) {
    const current = this.read("job", id);
    if (!current) return null;
    const updated = { ...current, ...patch, id };
    this.write("job", updated);
    return updated;
  }

  async putMaterial(value) {
    return this.write("material", value);
  }

  async getMaterial(id) {
    return this.read("material", id);
  }

  async listMaterials({ ownerOpenid, deviceSn, date, nowMs = Date.now() } = {}) {
    const rows = this.db.prepare(`
      SELECT body_json FROM foodcast_material_records
      WHERE kind = 'material' AND owner_openid = ? AND device_sn = ? AND status = 'ready'
        AND expires_at > ? AND (? = '' OR date = ?)
    `).all(ownerOpenid || "", deviceSn || "", Number(nowMs), date || "", date || "")
      .map((row) => parseJson(row.body_json));
    return sortByTimeThenId(rows, "createdAt");
  }

  async countAvailableFoodcasts({ ownerOpenid, deviceSn, nowMs = Date.now() } = {}) {
    const direct = this.db.prepare(`
      SELECT COUNT(*) AS count FROM foodcast_material_records
      WHERE kind = 'material' AND owner_openid = ? AND device_sn = ?
        AND status = 'ready' AND expires_at > ? AND file_id != ''
        AND json_extract(body_json, '$.kind') IN ('meal', 'custom')
    `).get(ownerOpenid || "", deviceSn || "", Number(nowMs));
    const currentDaily = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM foodcast_daily_latest AS daily
      INNER JOIN foodcast_material_records AS material
        ON material.kind = 'material' AND material.id = daily.material_id
      WHERE daily.owner_openid = ? AND daily.device_sn = ?
        AND material.owner_openid = ? AND material.device_sn = ?
        AND material.status = 'ready' AND material.expires_at > ? AND material.file_id != ''
        AND json_extract(material.body_json, '$.kind') = 'daily'
    `).get(
      ownerOpenid || "",
      deviceSn || "",
      ownerOpenid || "",
      deviceSn || "",
      Number(nowMs)
    );
    return Number(direct?.count || 0) + Number(currentDaily?.count || 0);
  }

  pointerId(ownerOpenid, deviceSn, date) {
    return `${ownerOpenid}:${deviceSn}:${date}`;
  }

  async getLatestDaily(ownerOpenid, deviceSn, date) {
    const row = this.db.prepare(`SELECT body_json FROM foodcast_daily_latest WHERE pointer_id = ?`)
      .get(this.pointerId(ownerOpenid, deviceSn, date));
    return row ? parseJson(row.body_json) : null;
  }

  async swapLatestDaily(ownerOpenid, deviceSn, date, expectedMaterialId, next) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = await this.getLatestDaily(ownerOpenid, deviceSn, date);
      if ((current?.materialId || null) !== (expectedMaterialId || null)) {
        this.db.exec("COMMIT");
        return false;
      }
      const value = { ...next, ownerOpenid, deviceSn, date };
      this.db.prepare(`
        INSERT INTO foodcast_daily_latest (
          pointer_id, owner_openid, device_sn, date, material_id, body_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(pointer_id) DO UPDATE SET material_id = excluded.material_id, body_json = excluded.body_json
      `).run(
        this.pointerId(ownerOpenid, deviceSn, date), ownerOpenid, deviceSn, date,
        value.materialId, JSON.stringify(value)
      );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async listExpiredArtifacts(nowMs) {
    const referenced = new Set(this.db.prepare(`SELECT material_id FROM foodcast_daily_latest`)
      .all().map((row) => row.material_id));
    const referencedFiles = new Set();
    for (const id of referenced) {
      const material = this.read("material", id);
      if (material?.fileId) referencedFiles.add(material.fileId);
    }
    return this.db.prepare(`
      SELECT body_json FROM foodcast_material_records
      WHERE kind = 'material' AND status = 'ready' AND expires_at > 0 AND expires_at <= ? AND file_id != ''
      ORDER BY expires_at, id
    `).all(Number(nowMs)).map((row) => parseJson(row.body_json))
      .filter((row) => !referenced.has(row.id) && !referencedFiles.has(row.fileId));
  }

  async expireArtifacts(ids, nowMs = Date.now()) {
    const fileIds = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of [...new Set(Array.isArray(ids) ? ids : [])]) {
        const current = this.read("material", id);
        if (!current || current.status === "expired") continue;
        if (current.fileId) fileIds.push(current.fileId);
        this.write("material", { ...current, status: "expired", expiredAt: Number(nowMs) });
      }
      this.db.exec("COMMIT");
      return fileIds;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = { MaterialCatalog };
