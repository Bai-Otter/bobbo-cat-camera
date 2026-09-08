const crypto = require("node:crypto");

const { validateCustomComposition } = require("./materialModel");

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function publicMaterial(material, previewUrl) {
  return {
    id: material.id,
    kind: material.kind,
    date: material.date,
    durationSec: material.durationSec,
    createdAt: material.createdAt,
    expiresAt: material.expiresAt,
    trimStartSec: material.trimStartSec,
    trimEndSec: material.trimEndSec,
    mealStartMs: material.mealStartMs,
    mealEndMs: material.mealEndMs,
    sourceMaterialIds: material.sourceMaterialIds || [],
    bgm: material.bgm || null,
    version: material.version || "",
    previewUrl,
    coverUrl: "",
    hasCover: !!(material.coverFileId || material.fileId),
  };
}

class CustomFoodcastService {
  constructor(options = {}) {
    this.catalog = options.catalog;
    this.mediaStorage = options.mediaStorage;
    this.bgmLibrary = options.bgmLibrary;
    this.renderOutput = options.renderOutput;
    this.renderCover = options.renderCover;
    this.now = options.now || Date.now;
    this.idFactory = options.idFactory || crypto.randomUUID;
    this.workerId = options.workerId || `custom-worker-${crypto.randomUUID()}`;
    this.leaseMs = Number(options.leaseMs) || 300_000;
    this.retentionMs = Number(options.retentionMs) || 30 * 86_400_000;
  }

  async listMaterials({ ownerOpenid, deviceSn, date = "", sinceMs = 0 } = {}) {
    const nowMs = this.now();
    const materials = await this.catalog.listMaterials({ ownerOpenid, deviceSn, date, nowMs });
    const visible = materials.filter((material) => (
      Number(material.createdAt) >= Number(sinceMs || 0)
      && ["meal", "daily_segment", "custom"].includes(material.kind)
    ));
    return visible.map((material) => publicMaterial(material, ""));
  }

  async countAvailableFoodcasts({ ownerOpenid, deviceSn } = {}) {
    return this.catalog.countAvailableFoodcasts({
      ownerOpenid,
      deviceSn,
      nowMs: this.now(),
    });
  }

  async getLatestDaily({ ownerOpenid, deviceSn, date } = {}) {
    const pointer = await this.catalog.getLatestDaily(ownerOpenid, deviceSn, date);
    if (!pointer?.materialId) return null;
    const material = await this.catalog.getMaterial(pointer.materialId);
    if (!material
      || material.ownerOpenid !== ownerOpenid
      || material.deviceSn !== deviceSn
      || material.status !== "ready"
      || Number(material.expiresAt) <= this.now()) return null;
    return {
      ...publicMaterial(material, ""),
      bgm: material.bgm || pointer.bgm || null,
      version: material.version || pointer.version || "",
    };
  }

  async resolveMaterials(segments) {
    const materials = new Map();
    for (const segment of Array.isArray(segments) ? segments : []) {
      const id = String(segment?.materialId || "");
      if (!materials.has(id)) materials.set(id, await this.catalog.getMaterial(id));
    }
    return materials;
  }

  validate(input, materials) {
    const normalized = validateCustomComposition({
      ...input,
      materials,
      nowMs: this.now(),
    });
    const bgm = this.bgmLibrary.get(normalized.bgmId);
    if (!bgm?.id || !bgm?.filePath) throw codedError("BGM_NOT_FOUND");
    return { normalized, bgm };
  }

  async create(input = {}) {
    const materials = await this.resolveMaterials(input.segments);
    const { normalized } = this.validate(input, materials);
    const nowMs = this.now();
    const job = {
      id: this.idFactory(),
      jobType: "custom",
      ownerOpenid: normalized.ownerOpenid,
      deviceSn: normalized.deviceSn,
      status: "queued",
      frameMode: normalized.frameMode,
      bgmId: normalized.bgmId,
      bgmVolume: normalized.bgmVolume,
      segments: normalized.segments,
      totalDurationSec: normalized.totalDurationSec,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    await this.catalog.putJob(job);
    return job;
  }

  async processJob(jobId) {
    const claimed = await this.catalog.claimJob(jobId, this.workerId, this.now(), this.leaseMs);
    if (!claimed || claimed.jobType !== "custom") return null;
    try {
      const materials = await this.resolveMaterials(claimed.segments);
      const { normalized, bgm } = this.validate(claimed, materials);
      const segments = normalized.segments.map((segment) => {
        const material = materials.get(segment.materialId);
        const baseOffsetSec = Number(material.trimStartSec) || 0;
        return {
          materialId: material.id,
          fileId: material.fileId,
          sourceOffsetSec: baseOffsetSec + segment.trimStartSec,
          durationSec: segment.trimEndSec - segment.trimStartSec,
        };
      });
      const result = await this.renderOutput({
        jobId: claimed.id,
        jobType: "custom",
        ownerOpenid: claimed.ownerOpenid,
        deviceSn: claimed.deviceSn,
        date: new Date(this.now()).toISOString().slice(0, 10),
        segments,
        frameMode: normalized.frameMode,
        audioMode: "mix",
        bgm,
        bgmVolume: normalized.bgmVolume,
      });
      const outputMaterial = {
        id: `custom-material-${claimed.id}`,
        kind: "custom",
        ownerOpenid: claimed.ownerOpenid,
        deviceSn: claimed.deviceSn,
        date: new Date(this.now()).toISOString().slice(0, 10),
        status: "ready",
        fileId: result.fileId,
        coverFileId: result.coverFileId || "",
        durationSec: result.durationSec,
        frameMode: normalized.frameMode,
        bgm: { id: bgm.id, volume: normalized.bgmVolume },
        sourceMaterialIds: normalized.segments.map((segment) => segment.materialId),
        createdAt: this.now(),
        expiresAt: this.now() + this.retentionMs,
      };
      await this.catalog.putMaterial(outputMaterial);
      return this.catalog.updateJob(claimed.id, {
        status: "ready",
        outputMaterialId: outputMaterial.id,
        fileId: result.fileId,
        durationSec: result.durationSec,
        leaseOwner: "",
        leaseExpiresAt: 0,
        updatedAt: this.now(),
      });
    } catch (error) {
      await this.catalog.updateJob(claimed.id, {
        status: "failed",
        errorCode: error.code || "CUSTOM_RENDER_FAILED",
        errorMessage: String(error.message || error),
        leaseOwner: "",
        leaseExpiresAt: 0,
        updatedAt: this.now(),
      });
      throw error;
    }
  }

  async getPublicJob({ ownerOpenid, jobId } = {}) {
    const job = await this.catalog.getJob(jobId);
    if (!job || job.jobType !== "custom" || job.ownerOpenid !== ownerOpenid) return null;
    const publicJob = {
      id: job.id,
      deviceSn: job.deviceSn,
      status: job.status,
      frameMode: job.frameMode,
      bgmId: job.bgmId,
      bgmVolume: job.bgmVolume,
      totalDurationSec: job.totalDurationSec,
      durationSec: job.durationSec,
      errorCode: job.errorCode || "",
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
    if (job.status === "ready" && job.fileId) {
      publicJob.videoUrl = await this.mediaStorage.getReadUrl(job.fileId);
    }
    return publicJob;
  }

  async getJob(jobId) {
    const job = await this.catalog.getJob(jobId);
    return job && job.jobType === "custom" ? job : null;
  }

  async getMaterial(materialId) {
    return this.catalog.getMaterial(materialId);
  }

  async ensureMaterialCover(materialId) {
    const material = await this.catalog.getMaterial(materialId);
    if (!material?.fileId) return material;
    if (material.coverFileId) return material;
    if (typeof this.renderCover !== "function") return material;
    const result = await this.renderCover({ material });
    if (!result?.coverFileId) return material;
    const updated = { ...material, coverFileId: result.coverFileId };
    await this.catalog.putMaterial(updated);
    return updated;
  }
}

module.exports = { CustomFoodcastService };
