const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const ACTIVE_STATUSES = new Set(["starting", "recording", "finalizing"]);
const BLOCKING_STATUSES = new Set(["starting", "recording"]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function cleanJob(job = {}) {
  return {
    id: String(job.id || ""),
    ownerOpenid: String(job.ownerOpenid || ""),
    actorOpenid: String(job.actorOpenid || job.ownerOpenid || ""),
    deviceSn: String(job.deviceSn || ""),
    status: String(job.status || "starting"),
    accessToken: String(job.accessToken || ""),
    fileId: String(job.fileId || ""),
    outputSize: Number(job.outputSize) || 0,
    durationSec: Number(job.durationSec) || 0,
    errorCode: String(job.errorCode || ""),
    startedAt: Number(job.startedAt) || Number(job.createdAt) || Date.now(),
    endedAt: Number(job.endedAt) || 0,
    createdAt: Number(job.createdAt) || Date.now(),
    updatedAt: Number(job.updatedAt) || Number(job.createdAt) || Date.now(),
    expiresAt: Number(job.expiresAt) || 0,
  };
}

function publicRecording(job) {
  if (!job) return null;
  const clean = cleanJob(job);
  return {
    id: clean.id,
    deviceSn: clean.deviceSn,
    status: clean.status,
    accessToken: clean.accessToken,
    outputSize: clean.outputSize,
    durationSec: clean.durationSec,
    errorCode: clean.errorCode,
    startedAt: clean.startedAt,
    endedAt: clean.endedAt,
    createdAt: clean.createdAt,
    updatedAt: clean.updatedAt,
    expiresAt: clean.expiresAt,
  };
}

class LiveRecordingStore {
  constructor({ filePath, fsApi = fsPromises } = {}) {
    if (!filePath) throw codedError("LIVE_RECORDING_STORE_PATH_REQUIRED");
    this.filePath = path.resolve(filePath);
    this.fsApi = fsApi;
    this.writeChain = Promise.resolve();
  }

  async loadJobs() {
    try {
      const parsed = JSON.parse(await this.fsApi.readFile(this.filePath, "utf8"));
      return Array.isArray(parsed.jobs) ? parsed.jobs.map(cleanJob) : [];
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  async saveJobs(jobs) {
    await this.fsApi.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await this.fsApi.writeFile(temporaryPath, JSON.stringify({ version: 1, jobs }, null, 2), "utf8");
    await this.fsApi.rename(temporaryPath, this.filePath);
  }

  serialize(action) {
    const next = this.writeChain.then(action, action);
    this.writeChain = next.catch(() => {});
    return next;
  }

  createJob(input) {
    return this.serialize(async () => {
      const jobs = await this.loadJobs();
      const job = cleanJob(input);
      if (!job.id || !job.ownerOpenid || !job.deviceSn || !job.accessToken) {
        throw codedError("LIVE_RECORDING_INVALID");
      }
      if (jobs.some((item) => (
        item.ownerOpenid === job.ownerOpenid
        && item.deviceSn === job.deviceSn
        && BLOCKING_STATUSES.has(item.status)
      ))) {
        throw codedError("RECORDING_ALREADY_ACTIVE");
      }
      jobs.push(job);
      await this.saveJobs(jobs);
      return { ...job };
    });
  }

  updateJob(id, patch = {}) {
    return this.serialize(async () => {
      const jobs = await this.loadJobs();
      const index = jobs.findIndex((item) => item.id === id);
      if (index < 0) return null;
      jobs[index] = cleanJob({ ...jobs[index], ...patch, id: jobs[index].id });
      await this.saveJobs(jobs);
      return { ...jobs[index] };
    });
  }

  async getOwnedJob(ownerOpenid, id) {
    const job = await this.getJob(id);
    if (job?.ownerOpenid !== ownerOpenid) return null;
    return job ? { ...job } : null;
  }

  async getJob(id) {
    await this.writeChain;
    const jobs = await this.loadJobs();
    const job = jobs.find((item) => item.id === id);
    return job ? { ...job } : null;
  }

  async findLatest(ownerOpenid, deviceSn, actorOpenid = "") {
    await this.writeChain;
    const jobs = await this.loadJobs();
    const actor = String(actorOpenid || "");
    const matches = jobs.filter((item) => (
      item.ownerOpenid === ownerOpenid
      && item.deviceSn === deviceSn
      && (!actor || item.actorOpenid === actor)
    ));
    matches.sort((left, right) => right.createdAt - left.createdAt);
    return matches[0] ? { ...matches[0] } : null;
  }

  recoverInterrupted(now = Date.now()) {
    return this.serialize(async () => {
      const jobs = await this.loadJobs();
      let recovered = 0;
      for (const job of jobs) {
        if (!ACTIVE_STATUSES.has(job.status)) continue;
        job.status = "failed";
        job.errorCode = "RECORDING_INTERRUPTED";
        job.updatedAt = now;
        recovered += 1;
      }
      if (recovered) await this.saveJobs(jobs);
      return recovered;
    });
  }
}

module.exports = { ACTIVE_STATUSES, BLOCKING_STATUSES, LiveRecordingStore, cleanJob, publicRecording };
