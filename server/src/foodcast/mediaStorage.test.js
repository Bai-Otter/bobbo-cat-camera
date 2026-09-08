const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const {
  CloudMediaStorage,
  LocalMediaStorage,
  buildMediaCloudPath,
  buildLiveRecordingCloudPath,
} = require("./mediaStorage");

function assertCode(code, callback) {
  return assert.rejects(callback, (error) => error && error.code === code);
}

test("CloudMediaStorage uploads a stream and returns only the file ID", async () => {
  const calls = [];
  const app = {
    uploadFile: async (input) => {
      calls.push(input);
      return { fileID: "cloud://env/foodcasts/x.mp4", requestId: "private" };
    },
  };
  const storage = new CloudMediaStorage({ app, createReadStream: (filePath) => ({ filePath }) });

  assert.deepEqual(await storage.upload("foodcasts/u/x.mp4", "D:/tmp/x.mp4"), {
    fileId: "cloud://env/foodcasts/x.mp4",
  });
  assert.equal(calls[0].cloudPath, "foodcasts/u/x.mp4");
  assert.deepEqual(calls[0].fileContent, { filePath: "D:/tmp/x.mp4" });
});

test("CloudMediaStorage reports coded upload and URL failures", async () => {
  const uploadStorage = new CloudMediaStorage({
    app: { uploadFile: async () => ({}) },
    createReadStream: () => ({}),
  });
  await assertCode("CLOUD_MEDIA_UPLOAD_FAILED", () => uploadStorage.upload("foodcasts/x.mp4", "x.mp4"));

  const urlStorage = new CloudMediaStorage({
    app: { getTempFileURL: async () => ({ fileList: [] }) },
  });
  await assertCode("CLOUD_MEDIA_URL_FAILED", () => urlStorage.getReadUrl("cloud://missing"));
});

test("CloudMediaStorage resolves a temporary URL with a bounded lifetime", async () => {
  const calls = [];
  const storage = new CloudMediaStorage({
    app: {
      getTempFileURL: async (input) => {
        calls.push(input);
        return { fileList: [{ fileID: "cloud://env/x.mp4", tempFileURL: "https://example.test/x.mp4" }] };
      },
    },
  });

  assert.equal(await storage.getReadUrl("cloud://env/x.mp4", 120), "https://example.test/x.mp4");
  assert.deepEqual(calls[0], { fileList: [{ fileID: "cloud://env/x.mp4", maxAge: 120 }] });
});

test("CloudMediaStorage delete is idempotent for an empty list", async () => {
  let calls = 0;
  const storage = new CloudMediaStorage({
    app: { deleteFile: async () => { calls += 1; } },
  });

  await storage.delete([]);
  await storage.delete(null);
  assert.equal(calls, 0);
});

test("CloudMediaStorage deletes unique non-empty file IDs", async () => {
  const calls = [];
  const storage = new CloudMediaStorage({
    app: { deleteFile: async (input) => { calls.push(input); } },
  });

  await storage.delete(["cloud://env/a.mp4", "", "cloud://env/a.mp4", "cloud://env/b.mp4"]);
  assert.deepEqual(calls, [{ fileList: ["cloud://env/a.mp4", "cloud://env/b.mp4"] }]);
});

test("buildMediaCloudPath sanitizes identifiers and confines files under foodcasts", () => {
  const cloudPath = buildMediaCloudPath({
    ownerOpenid: "../owner /with spaces",
    deviceSn: "SN\\..\\01",
    date: "2026/07/26",
    jobId: "job:one",
    fileName: "../result final.mp4",
  });

  assert.match(cloudPath, /^foodcasts\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/2026-07-26\/[a-zA-Z0-9._-]+\/result-final\.mp4$/);
  assert.equal(cloudPath.includes(".."), false);
  assert.equal(cloudPath.includes("\\"), false);
});

test("buildLiveRecordingCloudPath sanitizes identifiers under a separate confined namespace", async () => {
  const cloudPath = buildLiveRecordingCloudPath({
    ownerOpenid: "../owner",
    deviceSn: "SN\\01",
    date: "2026/07/27",
    jobId: "job:1",
  });

  assert.match(
    cloudPath,
    /^live-recordings\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/2026-07-27\/[a-zA-Z0-9._-]+\/recording\.mp4$/
  );
  const storage = new LocalMediaStorage({ rootDir: os.tmpdir() });
  await assertCode("LOCAL_MEDIA_PATH_INVALID", () => storage.upload("other/escape.mp4", __filename));
});

test("LocalMediaStorage copies files inside its root and returns a confined path", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "foodcast-media-"));
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "foodcast-source-"));
  const sourcePath = path.join(sourceDir, "source.mp4");
  await fs.writeFile(sourcePath, "video");
  const storage = new LocalMediaStorage({ rootDir });

  try {
    const uploaded = await storage.upload("foodcasts/owner/SN/date/job/result.mp4", sourcePath);
    assert.match(uploaded.fileId, /^local-media:\/\//);
    const readPath = await storage.getReadUrl(uploaded.fileId);
    assert.equal(path.relative(rootDir, readPath).startsWith(".."), false);
    assert.equal(await fs.readFile(readPath, "utf8"), "video");
    await storage.delete([uploaded.fileId]);
    await assert.rejects(fs.stat(readPath), { code: "ENOENT" });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  }
});

test("LocalMediaStorage rejects traversal and forged file IDs", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "foodcast-media-"));
  const storage = new LocalMediaStorage({ rootDir });
  try {
    await assertCode("LOCAL_MEDIA_PATH_INVALID", () => storage.upload("../escape.mp4", __filename));
    await assertCode("LOCAL_MEDIA_PATH_INVALID", () => storage.getReadUrl("local-media://../escape.mp4"));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
