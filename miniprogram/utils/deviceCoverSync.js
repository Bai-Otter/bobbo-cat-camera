function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function collectNamedValues(value, acceptedKeys, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return [];
  seen.add(value);
  const values = [];
  for (const [key, nested] of Object.entries(value)) {
    if (acceptedKeys.has(String(key).toLowerCase()) && typeof nested === "string") {
      values.push(nested);
    }
    if (nested && typeof nested === "object") {
      values.push(...collectNamedValues(nested, acceptedKeys, depth + 1, seen));
    }
  }
  return values;
}

function extractCoverCandidate(result = {}) {
  const data = result.data && typeof result.data === "object" ? result.data : {};
  const nested = data.data && typeof data.data === "object" ? data.data : {};
  const image = firstNonEmpty(collectNamedValues(result, new Set(["image"])));
  const imageUrl = /^https?:\/\//i.test(image) ? image : "";
  const imageLocalPath = /^(wxfile|file):\/\//i.test(image) ? image : "";
  const imageDataUri = image.match(/^data:image\/[^;]+;base64,(.+)$/i);
  const imageBase64 = imageDataUri
    ? imageDataUri[1]
    : (/^(\/9j\/|iVBORw0KGgo)/.test(image) ? image : "");
  const fileId = firstNonEmpty([
    nested.fileId,
    nested.cloudFileId,
    data.fileId,
    data.cloudFileId,
    ...collectNamedValues(result, new Set(["fileid", "cloudfileid"])),
  ]);
  const coverUrl = firstNonEmpty([
    nested.coverUrl,
    nested.url,
    nested.picUrl,
    nested.fileUrl,
    data.coverUrl,
    data.url,
    data.picUrl,
    data.fileUrl,
    result.coverUrl,
    imageUrl,
    ...collectNamedValues(
      result,
      new Set(["coverurl", "url", "picurl", "pictureurl", "imageurl", "fileurl"])
    ),
  ]);
  const localPath = firstNonEmpty([
    nested.tempFilePath,
    nested.filePath,
    nested.path,
    result.tempFilePath,
    result.filePath,
    data.tempFilePath,
    data.filePath,
    data.path,
    result.path,
    imageLocalPath,
    ...collectNamedValues(
      result,
      new Set(["tempfilepath", "filepath", "localpath", "temppath"])
    ),
  ]);
  const base64Data = firstNonEmpty([
    ...collectNamedValues(result, new Set(["imagebase64", "jpegbase64", "base64data"])),
    imageBase64,
  ]);

  return {
    fileId,
    coverUrl,
    localPath,
    base64Data,
  };
}

function objectKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function summarizeCaptureResult(result) {
  const data = result && result.data;
  const candidate = extractCoverCandidate(result);
  const code = result && (result.code !== undefined && result.code !== null
    ? result.code
    : (data && data.code));
  const ret = result && (
    result.Ret !== undefined && result.Ret !== null ? result.Ret
      : result.ret !== undefined && result.ret !== null ? result.ret
        : data && data.Ret !== undefined && data.Ret !== null ? data.Ret
          : data && data.ret !== undefined && data.ret !== null ? data.ret
            : data && data.data && data.data.Ret !== undefined && data.data.Ret !== null ? data.data.Ret
              : data && data.data ? data.data.ret : undefined
  );

  return {
    type: Array.isArray(result) ? "array" : typeof result,
    keys: objectKeys(result),
    dataType: Array.isArray(data) ? "array" : (data === null ? "null" : typeof data),
    dataKeys: objectKeys(data),
    code: code !== undefined && code !== null ? code : null,
    ret: ret !== undefined && ret !== null ? ret : null,
    candidate: {
      fileId: !!candidate.fileId,
      coverUrl: !!candidate.coverUrl,
      localPath: !!candidate.localPath,
      base64Data: !!candidate.base64Data,
    },
  };
}

function buildCoverCloudPath({ sn = "" }) {
  return `device-covers/${String(sn || "unknown").trim()}/latest.jpg`;
}

function buildDeviceCapturePayload() {
  return {
    Name: "OPSNAP",
    OPSNAP: {
      Channel: 0,
      PicType: 0,
    },
  };
}

async function resolveTempCoverUrl(wxApi, fileId) {
  if (!wxApi || !wxApi.cloud || !wxApi.cloud.getTempFileURL || !fileId) return "";
  const result = await wxApi.cloud.getTempFileURL({ fileList: [fileId] });
  const first = result && Array.isArray(result.fileList) ? result.fileList[0] : null;
  return first && first.tempFileURL ? first.tempFileURL : "";
}

function writeBase64CoverFile(wxApi, { sn, capturedAt, base64Data }) {
  const fs = wxApi && wxApi.getFileSystemManager && wxApi.getFileSystemManager();
  const userDataPath = wxApi && wxApi.env && wxApi.env.USER_DATA_PATH;
  if (!fs || !userDataPath || !base64Data) return Promise.resolve("");
  const safeSn = String(sn || "unknown").replace(/[^a-z0-9_-]/gi, "_");
  const filePath = `${userDataPath}/device-cover-${safeSn}-${capturedAt}.jpg`;
  return new Promise((resolve, reject) => {
    fs.writeFile({
      filePath,
      data: base64Data,
      encoding: "base64",
      success: () => resolve(filePath),
      fail: reject,
    });
  });
}

function copyLocalCoverFile(wxApi, { sn, capturedAt, localPath }) {
  const fs = wxApi && wxApi.getFileSystemManager && wxApi.getFileSystemManager();
  const userDataPath = wxApi && wxApi.env && wxApi.env.USER_DATA_PATH;
  if (!localPath || !fs || typeof fs.copyFile !== "function" || !userDataPath) {
    return Promise.resolve(localPath || "");
  }
  if (String(localPath).startsWith(`${userDataPath}/`)) return Promise.resolve(localPath);
  const safeSn = String(sn || "unknown").replace(/[^a-z0-9_-]/gi, "_");
  const destPath = `${userDataPath}/device-cover-${safeSn}-${capturedAt}.jpg`;
  return new Promise((resolve) => {
    fs.copyFile({
      srcPath: localPath,
      destPath,
      success: () => resolve(destPath),
      fail: () => resolve(localPath),
    });
  });
}

async function materializeCoverCandidate({ candidate = {}, wxApi, sn, capturedAt = Date.now() }) {
  if (candidate.localPath) return candidate.localPath;
  if (candidate.coverUrl) return candidate.coverUrl;
  if (!candidate.base64Data) return "";
  return writeBase64CoverFile(wxApi, {
    sn,
    capturedAt,
    base64Data: candidate.base64Data,
  });
}

function downloadRemoteCover(wxApi, { sn, capturedAt, coverUrl }) {
  const userDataPath = wxApi && wxApi.env && wxApi.env.USER_DATA_PATH;
  if (!wxApi || typeof wxApi.downloadFile !== "function" || !userDataPath || !coverUrl) {
    return Promise.resolve("");
  }
  const safeSn = String(sn || "unknown").replace(/[^a-z0-9_-]/gi, "_");
  const filePath = `${userDataPath}/device-cover-${safeSn}-${capturedAt}.jpg`;
  return new Promise((resolve, reject) => {
    wxApi.downloadFile({
      url: coverUrl,
      filePath,
      success: (result) => {
        if ([200, 206].includes(Number(result && result.statusCode))) {
          resolve((result && result.tempFilePath) || filePath);
        } else {
          reject(new Error("DEVICE_COVER_DOWNLOAD_FAILED"));
        }
      },
      fail: reject,
    });
  });
}

async function persistDeviceCover({ sn, capturedAt = Date.now(), candidate = {}, wxApi, saveCover }) {
  if (!sn || !saveCover) return { ok: false, error: "MISSING_PARAMS" };

  let fileId = candidate.fileId || "";
  let coverUrl = candidate.coverUrl || "";
  let localPath = candidate.localPath || "";

  if (localPath) {
    localPath = await copyLocalCoverFile(wxApi, { sn, capturedAt, localPath });
  }

  if (!fileId && !localPath && coverUrl && /^https?:\/\//i.test(coverUrl)) {
    localPath = await downloadRemoteCover(wxApi, { sn, capturedAt, coverUrl });
  }

  if (!fileId && !localPath && candidate.base64Data) {
    localPath = await materializeCoverCandidate({
      candidate,
      wxApi,
      sn,
      capturedAt,
    });
  }

  if (!fileId && localPath && wxApi && wxApi.cloud && wxApi.cloud.uploadFile) {
    try {
      const cloudPath = buildCoverCloudPath({ sn, capturedAt });
      const uploaded = await wxApi.cloud.uploadFile({
        cloudPath,
        filePath: localPath,
      });
      fileId = uploaded && uploaded.fileID ? uploaded.fileID : "";
      if (fileId && !coverUrl) {
        coverUrl = await resolveTempCoverUrl(wxApi, fileId);
      }
    } catch (error) {
      // Self-hosted builds expose wx.cloud even when no cloud environment is
      // configured. The durable phone file remains a valid cover fallback.
      fileId = "";
    }
  }

  if (!fileId && !coverUrl && !localPath) return { ok: false, error: "EMPTY_COVER_CANDIDATE" };

  return saveCover({
    sn,
    fileId,
    coverUrl,
    localPath,
    capturedAt,
  });
}

module.exports = {
  buildCoverCloudPath,
  buildDeviceCapturePayload,
  extractCoverCandidate,
  materializeCoverCandidate,
  copyLocalCoverFile,
  downloadRemoteCover,
  persistDeviceCover,
  summarizeCaptureResult,
};
