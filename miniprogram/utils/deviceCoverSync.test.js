const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCoverCloudPath,
  buildDeviceCapturePayload,
  copyLocalCoverFile,
  extractCoverCandidate,
  materializeCoverCandidate,
  persistDeviceCover,
  summarizeCaptureResult,
} = require("./deviceCoverSync.js");

test("summarizeCaptureResult exposes safe response shape without image contents", () => {
  assert.deepEqual(summarizeCaptureResult({
    code: 2000,
    data: {
      Ret: 100,
      SessionID: "secret-session",
      OPSNAP: { PicUrl: "https://example.test/private.jpg" },
    },
  }), {
    type: "object",
    keys: ["code", "data"],
    dataType: "object",
    dataKeys: ["OPSNAP", "Ret", "SessionID"],
    code: 2000,
    ret: 100,
    candidate: {
      fileId: false,
      coverUrl: true,
      localPath: false,
      base64Data: false,
    },
  });
});

test("buildDeviceCapturePayload requests one JPEG from the default camera channel", () => {
  assert.equal(typeof buildDeviceCapturePayload, "function");
  assert.deepEqual(buildDeviceCapturePayload(), {
    Name: "OPSNAP",
    OPSNAP: {
      Channel: 0,
      PicType: 0,
    },
  });
});

test("extractCoverCandidate prefers explicit cloud file ids", () => {
  const candidate = extractCoverCandidate({
    data: {
      fileId: "cloud://cat-camera/covers/sn001.jpg",
      url: "https://example.test/sn001.jpg",
    },
  });

  assert.deepEqual(candidate, {
    fileId: "cloud://cat-camera/covers/sn001.jpg",
    coverUrl: "https://example.test/sn001.jpg",
    localPath: "",
    base64Data: "",
  });
});

test("extractCoverCandidate falls back to local temp files when no remote identifiers exist", () => {
  const candidate = extractCoverCandidate({
    tempFilePath: "wxfile://tmp/sn001.jpg",
  });

  assert.deepEqual(candidate, {
    fileId: "",
    coverUrl: "",
    localPath: "wxfile://tmp/sn001.jpg",
    base64Data: "",
  });
});

test("extractCoverCandidate reads the nested OPSNAP image URL returned by JLink capture", () => {
  const candidate = extractCoverCandidate({
    code: 2000,
    data: {
      Ret: 100,
      Data: {
        Name: "OPSNAP",
        OPSNAP: {
          PicUrl: "https://capture.example.test/SN001/latest.jpg",
        },
      },
    },
  });

  assert.deepEqual(candidate, {
    fileId: "",
    coverUrl: "https://capture.example.test/SN001/latest.jpg",
    localPath: "",
    base64Data: "",
  });
});

test("extractCoverCandidate reads JLink capture URLs nested in result payloads", () => {
  const candidate = extractCoverCandidate({
    data: {
      data: {
        result: {
          imageUrl: "https://capture.example.test/SN001/frame.jpg",
        },
      },
    },
  });

  assert.equal(candidate.coverUrl, "https://capture.example.test/SN001/frame.jpg");
});

test("extractCoverCandidate reads a backend jpeg frame payload", () => {
  const candidate = extractCoverCandidate({ imageBase64: "/9j/2Q==" });
  assert.equal(candidate.base64Data, "/9j/2Q==");
});

test("extractCoverCandidate reads the JLink data.image capture field", () => {
  assert.equal(
    extractCoverCandidate({ code: 2000, data: { Ret: 100, image: "https://capture.test/frame.jpg" } }).coverUrl,
    "https://capture.test/frame.jpg"
  );
  assert.equal(
    extractCoverCandidate({ code: 2000, data: { Ret: 100, image: "/9j/4AAQSkZJRgABAQAAAQ==" } }).base64Data,
    "/9j/4AAQSkZJRgABAQAAAQ=="
  );
});

test("materializeCoverCandidate writes JLink base64 images to a local file", async () => {
  let writeOptions;
  const wxApi = {
    env: { USER_DATA_PATH: "wxfile://userdata" },
    getFileSystemManager() {
      return {
        writeFile(options) {
          writeOptions = options;
          options.success();
        },
      };
    },
  };

  const source = await materializeCoverCandidate({
    candidate: { base64Data: "/9j/4AAQSkZJRgABAQAAAQ==" },
    wxApi,
    sn: "SN001",
    capturedAt: 1710000001234,
  });

  assert.equal(source, "wxfile://userdata/device-cover-SN001-1710000001234.jpg");
  assert.equal(writeOptions.data, "/9j/4AAQSkZJRgABAQAAAQ==");
  assert.equal(writeOptions.encoding, "base64");
});

test("copyLocalCoverFile moves a temporary capture into durable user storage", async () => {
  let copyOptions;
  const wxApi = {
    env: { USER_DATA_PATH: "wxfile://userdata" },
    getFileSystemManager() {
      return {
        copyFile(options) {
          copyOptions = options;
          options.success();
        },
      };
    },
  };

  const localPath = await copyLocalCoverFile(wxApi, {
    sn: "SN001",
    capturedAt: 1710000001234,
    localPath: "wxfile://tmp/frame.jpg",
  });

  assert.equal(localPath, "wxfile://userdata/device-cover-SN001-1710000001234.jpg");
  assert.equal(copyOptions.srcPath, "wxfile://tmp/frame.jpg");
});

test("buildCoverCloudPath creates a stable per-device cloud storage key", () => {
  assert.equal(
    buildCoverCloudPath({ sn: "SN001", capturedAt: 1710000001234 }),
    "device-covers/SN001/latest.jpg"
  );
  assert.equal(
    buildCoverCloudPath({ sn: "SN001", capturedAt: 1710009999999 }),
    "device-covers/SN001/latest.jpg"
  );
});

test("persistDeviceCover uploads a local file and saves the resolved cloud metadata", async () => {
  const calls = [];
  const wxApi = {
    cloud: {
      async uploadFile(payload) {
        calls.push(["uploadFile", payload]);
        return { fileID: "cloud://demo/device-covers/SN001/latest.jpg" };
      },
      async getTempFileURL(payload) {
        calls.push(["getTempFileURL", payload]);
        return {
          fileList: [
            {
              tempFileURL: "https://example.test/device-covers/SN001/latest.jpg",
            },
          ],
        };
      },
    },
  };

  const result = await persistDeviceCover({
    sn: "SN001",
    capturedAt: 1710000001234,
    candidate: {
      fileId: "",
      coverUrl: "",
      localPath: "wxfile://tmp/sn001.jpg",
    },
    wxApi,
    saveCover: async (payload) => {
      calls.push(["saveCover", payload]);
      return { ok: true, cover: payload };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[2], [
    "saveCover",
    {
      sn: "SN001",
      fileId: "cloud://demo/device-covers/SN001/latest.jpg",
      coverUrl: "https://example.test/device-covers/SN001/latest.jpg",
      localPath: "wxfile://tmp/sn001.jpg",
      capturedAt: 1710000001234,
    },
  ]);
});

test("persistDeviceCover saves a durable local-only capture without cloud storage", async () => {
  let savedPayload;
  const wxApi = {
    env: { USER_DATA_PATH: "wxfile://userdata" },
    getFileSystemManager() {
      return {
        copyFile(options) {
          options.success();
        },
      };
    },
  };

  const result = await persistDeviceCover({
    sn: "SN001",
    capturedAt: 1710000001234,
    candidate: { localPath: "wxfile://tmp/frame.jpg" },
    wxApi,
    saveCover: async (payload) => {
      savedPayload = payload;
      return { ok: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(savedPayload.fileId, "");
  assert.equal(savedPayload.coverUrl, "");
  assert.equal(savedPayload.localPath, "wxfile://userdata/device-cover-SN001-1710000001234.jpg");
});

test("persistDeviceCover keeps the durable phone cover when cloud upload is unavailable", async () => {
  let uploadAttempts = 0;
  let savedPayload;
  const wxApi = {
    env: { USER_DATA_PATH: "wxfile://userdata" },
    getFileSystemManager() {
      return {
        copyFile(options) {
          options.success();
        },
      };
    },
    cloud: {
      async uploadFile() {
        uploadAttempts += 1;
        throw new Error("Cloud API isn't enabled");
      },
    },
  };

  const result = await persistDeviceCover({
    sn: "SN001",
    capturedAt: 1710000001234,
    candidate: { localPath: "wxfile://tmp/frame.jpg" },
    wxApi,
    saveCover: async (payload) => {
      savedPayload = payload;
      return { ok: true, cover: payload };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(uploadAttempts, 1);
  assert.equal(savedPayload.fileId, "");
  assert.equal(savedPayload.coverUrl, "");
  assert.equal(savedPayload.localPath, "wxfile://userdata/device-cover-SN001-1710000001234.jpg");
});

test("persistDeviceCover writes a backend jpeg frame before uploading it", async () => {
  const calls = [];
  const wxApi = {
    env: { USER_DATA_PATH: "wxfile://usr" },
    getFileSystemManager() {
      return {
        writeFile(payload) {
          calls.push(["writeFile", payload.filePath, payload.data, payload.encoding]);
          payload.success();
        },
      };
    },
    cloud: {
      async uploadFile(payload) {
        calls.push(["uploadFile", payload]);
        return { fileID: "cloud://demo/device-covers/SN001/frame.jpg" };
      },
      async getTempFileURL() {
        return { fileList: [{ tempFileURL: "https://example.test/frame.jpg" }] };
      },
    },
  };

  const result = await persistDeviceCover({
    sn: "SN001",
    capturedAt: 1710000001234,
    candidate: { base64Data: "/9j/2Q==" },
    wxApi,
    saveCover: async () => ({ ok: true }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], [
    "writeFile",
    "wxfile://usr/device-cover-SN001-1710000001234.jpg",
    "/9j/2Q==",
    "base64",
  ]);
  assert.equal(calls[1][0], "uploadFile");
  assert.equal(calls[1][1].filePath, "wxfile://usr/device-cover-SN001-1710000001234.jpg");
});

test("persistDeviceCover copies a remote device image into durable cloud storage", async () => {
  const calls = [];
  const wxApi = {
    env: { USER_DATA_PATH: "wxfile://usr" },
    downloadFile(options) {
      calls.push(["download", options.url, options.filePath]);
      options.success({ statusCode: 200, tempFilePath: options.filePath });
    },
    cloud: {
      uploadFile(options) {
        calls.push(["upload", options.cloudPath, options.filePath]);
        return Promise.resolve({ fileID: "cloud://env/device-covers/SN001/latest.jpg" });
      },
      getTempFileURL() {
        return Promise.resolve({ fileList: [{ tempFileURL: "https://cloud.test/cover.jpg" }] });
      },
    },
  };
  let savedPayload = null;

  const result = await persistDeviceCover({
    sn: "SN001",
    capturedAt: 1710000000000,
    candidate: { coverUrl: "https://device-obs.test/capture.jpg" },
    wxApi,
    saveCover(payload) {
      savedPayload = payload;
      return Promise.resolve({ ok: true });
    },
  });

  assert.equal(result.ok, true);
  assert.match(calls[0][2], /device-cover-SN001-1710000000000\.jpg$/);
  assert.equal(calls[1][0], "upload");
  assert.equal(savedPayload.fileId, "cloud://env/device-covers/SN001/latest.jpg");
  assert.equal(savedPayload.coverUrl, "https://device-obs.test/capture.jpg");
});
