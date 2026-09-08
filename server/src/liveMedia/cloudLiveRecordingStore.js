const crypto = require("node:crypto");
const { ACTIVE_STATUSES, BLOCKING_STATUSES, cleanJob } = require("./liveRecordingStore");

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function recordingDocumentId(id) {
  return `live_recording_${crypto.createHash("sha256").update(String(id || "")).digest("hex")}`;
}

function cleanDocument(document) {
  if (!document) return null;
  const source = (
    !document.id
    && document.data
    && typeof document.data === "object"
    && !Array.isArray(document.data)
  ) ? document.data : document;
  const copy = { ...source };
  delete copy._id;
  return cleanJob(copy);
}

class CloudLiveRecordingStore {
  constructor({ database, collectionName = "cat_live_recordings" } = {}) {
    if (!database) throw new Error("CLOUDBASE_DATABASE_REQUIRED");
    this.database = database;
    this.collectionName = collectionName;
    this.collection = database.collection(collectionName);
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    try {
      await this.database.createCollection(this.collectionName);
    } catch (error) {
      if (error?.code !== "DATABASE_COLLECTION_ALREADY_EXIST") throw error;
    }
  }

  serialize(action) {
    const next = this.writeChain.then(action, action);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async listJobs() {
    const result = await this.collection.get();
    return (Array.isArray(result?.data) ? result.data : []).map(cleanDocument);
  }

  createJob(input) {
    return this.serialize(async () => {
      const job = cleanJob(input);
      if (!job.id || !job.ownerOpenid || !job.deviceSn || !job.accessToken) {
        throw codedError("LIVE_RECORDING_INVALID");
      }
      const jobs = await this.listJobs();
      if (jobs.some((item) => (
        item.ownerOpenid === job.ownerOpenid
        && item.deviceSn === job.deviceSn
        && BLOCKING_STATUSES.has(item.status)
      ))) {
        throw codedError("RECORDING_ALREADY_ACTIVE");
      }
      await this.collection.doc(recordingDocumentId(job.id)).set(job);
      return { ...job };
    });
  }

  updateJob(id, patch = {}) {
    return this.serialize(async () => {
      const doc = this.collection.doc(recordingDocumentId(id));
      const result = await doc.get();
      const existing = cleanDocument(Array.isArray(result?.data) ? result.data[0] : null);
      if (!existing) return null;
      const updated = cleanJob({ ...existing, ...patch, id: existing.id });
      await doc.set(updated);
      return { ...updated };
    });
  }

  async getOwnedJob(ownerOpenid, id) {
    const job = await this.getJob(id);
    return job?.ownerOpenid === ownerOpenid ? job : null;
  }

  async getJob(id) {
    await this.writeChain;
    const result = await this.collection.doc(recordingDocumentId(id)).get();
    const job = cleanDocument(Array.isArray(result?.data) ? result.data[0] : null);
    return job;
  }

  async findLatest(ownerOpenid, deviceSn, actorOpenid = "") {
    await this.writeChain;
    const jobs = (await this.listJobs())
      .filter((item) => (
        item.ownerOpenid === ownerOpenid
        && item.deviceSn === deviceSn
        && (!actorOpenid || item.actorOpenid === actorOpenid)
      ))
      .sort((left, right) => right.createdAt - left.createdAt);
    return jobs[0] || null;
  }

  recoverInterrupted(now = Date.now()) {
    return this.serialize(async () => {
      const jobs = await this.listJobs();
      const interrupted = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
      for (const job of interrupted) {
        await this.collection.doc(recordingDocumentId(job.id)).set(cleanJob({
          ...job,
          status: "failed",
          errorCode: "RECORDING_INTERRUPTED",
          updatedAt: now,
        }));
      }
      return interrupted.length;
    });
  }
}

module.exports = { CloudLiveRecordingStore, recordingDocumentId };
