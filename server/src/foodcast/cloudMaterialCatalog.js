const crypto = require("node:crypto");

function hash(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function clean(document) {
  if (!document) return null;
  const value = { ...document };
  delete value._id;
  delete value.recordKind;
  return value;
}

function first(result) {
  return Array.isArray(result?.data) ? result.data[0] || null : null;
}

function recordId(kind, value) {
  if (kind === "interval") return `interval:${hash(value.id || `${value.deviceSn}:${value.startMs}:${value.endMs}`)}`;
  if (kind === "meal") return `meal:${hash(value.id || `${value.deviceSn}:${value.startMs}`)}`;
  return `${kind}:${value.id}`;
}

function dailyId(ownerOpenid, deviceSn, date) {
  return `daily:${ownerOpenid}:${deviceSn}:${date}`;
}

function sortBy(rows, timeKey) {
  return rows.sort((left, right) => (
    Number(left[timeKey]) - Number(right[timeKey]) || String(left.id).localeCompare(String(right.id))
  ));
}

class CloudMaterialCatalog {
  constructor({ database, collectionName = "foodcast_materials" } = {}) {
    if (!database) throw new Error("CLOUDBASE_DATABASE_REQUIRED");
    this.database = database;
    this.collectionName = collectionName;
    this.collection = database.collection(collectionName);
  }

  async initialize() {
    try {
      await this.database.createCollection(this.collectionName);
    } catch (error) {
      if (error?.code !== "DATABASE_COLLECTION_ALREADY_EXIST") throw error;
    }
  }

  async set(kind, value, collection = this.collection) {
    await collection.doc(recordId(kind, value)).set({ data: { ...value, recordKind: kind } });
    return value;
  }

  async get(kind, id, collection = this.collection) {
    const result = await collection.doc(recordId(kind, { id })).get();
    return clean(first(result));
  }

  async all(collection = this.collection) {
    if (typeof collection.limit !== "function") {
      const result = await collection.get();
      return Array.isArray(result?.data) ? result.data : [];
    }
    const rows = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const result = await collection.limit(pageSize).skip(offset).get();
      const page = Array.isArray(result?.data) ? result.data : [];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  async upsertInterval(value) {
    return this.set("interval", value);
  }

  async listIntervals(deviceSn, date) {
    const rows = (await this.all())
      .filter((row) => row.recordKind === "interval" && row.deviceSn === deviceSn && row.date === date)
      .map(clean);
    return sortBy(rows, "startMs");
  }

  async replaceMeals(deviceSn, date, meals) {
    const oldRows = (await this.all())
      .filter((row) => row.recordKind === "meal" && row.deviceSn === deviceSn && row.date === date);
    const nextMeals = Array.isArray(meals) ? meals : [];
    const nextIds = new Set(nextMeals.map((meal) => recordId("meal", meal)));
    for (const meal of nextMeals) await this.set("meal", meal);
    for (const row of oldRows) {
      if (!nextIds.has(row._id)) await this.collection.doc(row._id).remove();
    }
  }

  async listDueMeals(nowMs, limit = 50) {
    const rows = (await this.all())
      .filter((row) => row.recordKind === "meal" && row.status === "pending" && Number(row.dueAt) <= Number(nowMs))
      .map(clean);
    return sortBy(rows, "dueAt").slice(0, Math.max(1, Number(limit) || 50));
  }

  async putJob(value) {
    return this.set("job", value);
  }

  async getJob(id) {
    return this.get("job", id);
  }

  async claimJob(id, workerId, nowMs, leaseMs) {
    return this.database.runTransaction(async (transaction) => {
      const collection = transaction.collection(this.collectionName);
      const current = await this.get("job", id, collection);
      const claimable = current && (
        current.status === "queued"
        || (current.status === "running" && Number(current.leaseExpiresAt) <= Number(nowMs))
      );
      if (!claimable) return null;
      const claimed = {
        ...current,
        status: "running",
        leaseOwner: String(workerId),
        leaseExpiresAt: Number(nowMs) + Number(leaseMs),
        updatedAt: Number(nowMs),
      };
      await this.set("job", claimed, collection);
      return claimed;
    });
  }

  async updateJob(id, patch = {}) {
    const current = await this.getJob(id);
    if (!current) return null;
    const updated = { ...current, ...patch, id };
    await this.set("job", updated);
    return updated;
  }

  async putMaterial(value) {
    return this.set("material", value);
  }

  async getMaterial(id) {
    return this.get("material", id);
  }

  async listMaterials({ ownerOpenid, deviceSn, date, nowMs = Date.now() } = {}) {
    const rows = (await this.all()).filter((row) => (
      row.recordKind === "material"
      && row.ownerOpenid === ownerOpenid
      && row.deviceSn === deviceSn
      && (!date || row.date === date)
      && row.status === "ready"
      && Number(row.expiresAt) > Number(nowMs)
    )).map(clean);
    return sortBy(rows, "createdAt");
  }

  async countAvailableFoodcasts({ ownerOpenid, deviceSn, nowMs = Date.now() } = {}) {
    const rows = await this.all();
    const availableMaterials = rows.filter((row) => (
      row.recordKind === "material"
      && row.ownerOpenid === ownerOpenid
      && row.deviceSn === deviceSn
      && row.status === "ready"
      && row.fileId
      && Number(row.expiresAt) > Number(nowMs)
    ));
    const materialsById = new Map(availableMaterials.map((row) => [row.id, row]));
    const directCount = availableMaterials.filter((row) => ["meal", "custom"].includes(row.kind)).length;
    const currentDailyCount = rows.filter((row) => (
      row.recordKind === "daily"
      && row.ownerOpenid === ownerOpenid
      && row.deviceSn === deviceSn
      && materialsById.get(row.materialId)?.kind === "daily"
    )).length;
    return directCount + currentDailyCount;
  }

  async getLatestDaily(ownerOpenid, deviceSn, date, collection = this.collection) {
    const result = await collection.doc(dailyId(ownerOpenid, deviceSn, date)).get();
    return clean(first(result));
  }

  async swapLatestDaily(ownerOpenid, deviceSn, date, expectedMaterialId, next) {
    return this.database.runTransaction(async (transaction) => {
      const collection = transaction.collection(this.collectionName);
      const current = await this.getLatestDaily(ownerOpenid, deviceSn, date, collection);
      if ((current?.materialId || null) !== (expectedMaterialId || null)) return false;
      await collection.doc(dailyId(ownerOpenid, deviceSn, date)).set({
        data: {
          ...next,
          ownerOpenid,
          deviceSn,
          date,
          recordKind: "daily",
        },
      });
      return true;
    });
  }

  async listExpiredArtifacts(nowMs) {
    const rows = await this.all();
    const referenced = new Set(rows
      .filter((row) => row.recordKind === "daily")
      .map((row) => row.materialId));
    const referencedFiles = new Set(rows
      .filter((row) => row.recordKind === "material" && referenced.has(row.id) && row.fileId)
      .map((row) => row.fileId));
    return rows.filter((row) => (
      row.recordKind === "material"
      && row.status === "ready"
      && row.fileId
      && Number(row.expiresAt) > 0
      && Number(row.expiresAt) <= Number(nowMs)
      && !referenced.has(row.id)
      && !referencedFiles.has(row.fileId)
    )).map(clean).sort((left, right) => (
      Number(left.expiresAt) - Number(right.expiresAt) || String(left.id).localeCompare(String(right.id))
    ));
  }

  async expireArtifacts(ids, nowMs = Date.now()) {
    const fileIds = [];
    for (const id of [...new Set(Array.isArray(ids) ? ids : [])]) {
      const current = await this.getMaterial(id);
      if (!current || current.status === "expired") continue;
      if (current.fileId) fileIds.push(current.fileId);
      await this.putMaterial({ ...current, status: "expired", expiredAt: Number(nowMs) });
    }
    return fileIds;
  }
}

module.exports = {
  CloudMaterialCatalog,
  dailyId,
  recordId,
};
