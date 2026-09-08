const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

function codedError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 10);
}

function sanitizeSegment(value, fallbackPrefix) {
  const source = String(value ?? "").trim();
  const cleaned = source
    .replace(/\\/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 96);
  return cleaned || `${fallbackPrefix}-${shortHash(source)}`;
}

function sanitizeFileName(value) {
  const baseName = path.posix.basename(String(value ?? "").replace(/\\/g, "/"));
  const extension = path.posix.extname(baseName).toLowerCase();
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  const safeStem = sanitizeSegment(stem, "media");
  const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".mp4";
  return `${safeStem}${safeExtension}`;
}

function buildMediaCloudPath({ ownerOpenid, deviceSn, date, jobId, fileName = "result.mp4" } = {}) {
  return [
    "foodcasts",
    sanitizeSegment(ownerOpenid, "owner"),
    sanitizeSegment(deviceSn, "device"),
    sanitizeSegment(date, "date"),
    sanitizeSegment(jobId, "job"),
    sanitizeFileName(fileName),
  ].join("/");
}

function buildLiveRecordingCloudPath({ ownerOpenid, deviceSn, date, jobId } = {}) {
  return [
    "live-recordings",
    sanitizeSegment(ownerOpenid, "owner"),
    sanitizeSegment(deviceSn, "device"),
    sanitizeSegment(date, "date"),
    sanitizeSegment(jobId, "job"),
    "recording.mp4",
  ].join("/");
}

function normalizeCloudPath(cloudPath) {
  const value = String(cloudPath || "");
  const root = value.split("/")[0];
  if (!value
    || value.includes("\\")
    || value.startsWith("/")
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || !new Set(["foodcasts", "live-recordings"]).has(root)) {
    throw codedError("LOCAL_MEDIA_PATH_INVALID");
  }
  return value;
}

class CloudMediaStorage {
  constructor({ app, createReadStream = fs.createReadStream } = {}) {
    this.app = app;
    this.createReadStream = createReadStream;
  }

  async upload(cloudPath, localPath) {
    const safeCloudPath = normalizeCloudPath(cloudPath);
    try {
      const result = await this.app?.uploadFile?.({
        cloudPath: safeCloudPath,
        fileContent: this.createReadStream(localPath),
      });
      if (!result?.fileID) throw codedError("CLOUD_MEDIA_UPLOAD_FAILED");
      return { fileId: result.fileID };
    } catch (error) {
      if (error?.code === "CLOUD_MEDIA_UPLOAD_FAILED") throw error;
      throw codedError("CLOUD_MEDIA_UPLOAD_FAILED", error);
    }
  }

  async getReadUrl(fileId, maxAgeSec = 600) {
    const normalizedMaxAge = Math.max(1, Math.min(86_400, Number(maxAgeSec) || 600));
    try {
      const result = await this.app?.getTempFileURL?.({
        fileList: [{ fileID: String(fileId || ""), maxAge: normalizedMaxAge }],
      });
      const match = result?.fileList?.find((item) => (
        item?.fileID === fileId || item?.fileId === fileId
      )) || result?.fileList?.[0];
      const readUrl = match?.tempFileURL || match?.tempFileUrl;
      if (!readUrl) throw codedError("CLOUD_MEDIA_URL_FAILED");
      return readUrl;
    } catch (error) {
      if (error?.code === "CLOUD_MEDIA_URL_FAILED") throw error;
      throw codedError("CLOUD_MEDIA_URL_FAILED", error);
    }
  }

  async delete(fileIds) {
    const uniqueFileIds = [...new Set((Array.isArray(fileIds) ? fileIds : [])
      .map((fileId) => String(fileId || "").trim())
      .filter(Boolean))];
    if (!uniqueFileIds.length) return;
    try {
      await this.app?.deleteFile?.({ fileList: uniqueFileIds });
    } catch (error) {
      throw codedError("CLOUD_MEDIA_DELETE_FAILED", error);
    }
  }
}

class LocalMediaStorage {
  constructor({ rootDir, copyFile = fsPromises.copyFile, mkdir = fsPromises.mkdir, unlink = fsPromises.unlink } = {}) {
    if (!rootDir) throw codedError("LOCAL_MEDIA_ROOT_REQUIRED");
    this.rootDir = path.resolve(rootDir);
    this.copyFile = copyFile;
    this.mkdir = mkdir;
    this.unlink = unlink;
  }

  resolveRelative(relativePath) {
    const normalized = normalizeCloudPath(relativePath);
    const absolutePath = path.resolve(this.rootDir, ...normalized.split("/"));
    const relative = path.relative(this.rootDir, absolutePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw codedError("LOCAL_MEDIA_PATH_INVALID");
    }
    return absolutePath;
  }

  encodeFileId(cloudPath) {
    return `local-media://${encodeURIComponent(cloudPath)}`;
  }

  decodeFileId(fileId) {
    const prefix = "local-media://";
    const value = String(fileId || "");
    if (!value.startsWith(prefix)) throw codedError("LOCAL_MEDIA_PATH_INVALID");
    try {
      return decodeURIComponent(value.slice(prefix.length));
    } catch {
      throw codedError("LOCAL_MEDIA_PATH_INVALID");
    }
  }

  async upload(cloudPath, localPath) {
    const normalized = normalizeCloudPath(cloudPath);
    const destinationPath = this.resolveRelative(normalized);
    await this.mkdir(path.dirname(destinationPath), { recursive: true });
    await this.copyFile(localPath, destinationPath);
    return { fileId: this.encodeFileId(normalized) };
  }

  async getReadUrl(fileId) {
    return this.resolveRelative(this.decodeFileId(fileId));
  }

  async delete(fileIds) {
    const uniqueFileIds = [...new Set(Array.isArray(fileIds) ? fileIds : [])];
    for (const fileId of uniqueFileIds) {
      if (!fileId) continue;
      const localPath = await this.getReadUrl(fileId);
      try {
        await this.unlink(localPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

module.exports = {
  CloudMediaStorage,
  LocalMediaStorage,
  buildLiveRecordingCloudPath,
  buildMediaCloudPath,
};
