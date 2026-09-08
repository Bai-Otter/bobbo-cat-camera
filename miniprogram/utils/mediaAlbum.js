function codedError(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function callApi(api, method, options = {}) {
  return new Promise((resolve, reject) => {
    if (!api || typeof api[method] !== "function") {
      reject(codedError("ALBUM_API_UNAVAILABLE"));
      return;
    }
    api[method]({ ...options, success: resolve, fail: reject });
  });
}

function isPermissionError(error) {
  return /auth|authorize|permission|deny/i.test(
    String((error && (error.errMsg || error.message)) || error || "")
  );
}

async function guideAlbumPermission(api) {
  if (!api || !api.showModal || !api.openSetting) return false;
  let choice;
  try {
    choice = await callApi(api, "showModal", {
      title: "需要相册权限",
      content: "请在设置中开启相册权限，再重新保存。",
      confirmText: "去设置",
    });
  } catch (error) {
    throw codedError("ALBUM_PERMISSION_CANCELLED", error);
  }
  if (!choice || !choice.confirm) throw codedError("ALBUM_PERMISSION_CANCELLED");
  await callApi(api, "openSetting").catch((error) => {
    throw codedError("ALBUM_SETTINGS_FAILED", error);
  });
  return true;
}

async function resolveLocalMedia(api, source, kind) {
  const value = String(source || "");
  if (!/^https?:\/\//i.test(value)) {
    if (!value) throw codedError(`${kind}_SOURCE_INVALID`);
    return value;
  }
  let result;
  const destinationPath = kind === "IMAGE" && api && api.env && api.env.USER_DATA_PATH
    ? `${api.env.USER_DATA_PATH}/device-capture-${Date.now()}.jpg`
    : "";
  try {
    result = await callApi(api, "downloadFile", {
      url: value,
      ...(destinationPath ? { filePath: destinationPath } : {}),
    });
  } catch (error) {
    throw codedError(`${kind}_DOWNLOAD_FAILED`, error);
  }
  const localPath = result && result.tempFilePath || destinationPath;
  if (![200, 206].includes(Number(result && result.statusCode)) || !localPath) {
    throw codedError(`${kind}_DOWNLOAD_FAILED`);
  }
  return localPath;
}

async function saveMedia(api, source, options) {
  const filePath = await resolveLocalMedia(api, source, options.kind);
  try {
    await callApi(api, options.saveMethod, { filePath });
  } catch (error) {
    if (isPermissionError(error)) {
      await guideAlbumPermission(api);
      throw codedError("ALBUM_PERMISSION_DENIED", error);
    }
    throw codedError(options.failureCode, error);
  }
  return { filePath };
}

function saveRemoteImage(api, source) {
  return saveMedia(api, source, {
    kind: "IMAGE",
    saveMethod: "saveImageToPhotosAlbum",
    failureCode: "SAVE_IMAGE_FAILED",
  });
}

function saveRemoteVideo(api, source) {
  return saveMedia(api, source, {
    kind: "VIDEO",
    saveMethod: "saveVideoToPhotosAlbum",
    failureCode: "SAVE_VIDEO_FAILED",
  });
}

module.exports = { guideAlbumPermission, saveRemoteImage, saveRemoteVideo };
