function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function extractRows(result) {
  const data = result && result.data ? result.data : result;
  if (Array.isArray(data)) return data;
  for (const key of ["tokens", "deviceTokens", "devices"]) {
    if (data && Array.isArray(data[key])) return data[key];
  }
  if (data && data.data) return extractRows(data.data);
  return [];
}

function rowSn(row = {}) {
  return String(row.sn || row.uuid || row.deviceSn || "").trim();
}

function refreshSdkDeviceToken({ sdk, sn, timeoutMs = 12000 } = {}) {
  const deviceSn = String(sn || "").trim();
  if (!sdk || typeof sdk.getDeviceToken !== "function" || !deviceSn) {
    return Promise.reject(stableError("DEVICE_TOKEN_REFRESH_UNAVAILABLE"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    timer = setTimeout(
      () => finish(reject)(stableError("DEVICE_TOKEN_REFRESH_TIMEOUT")),
      Math.max(1, Number(timeoutMs) || 12000)
    );
    try {
      sdk.getDeviceToken({ sns: [deviceSn] }, finish((result) => {
        const row = extractRows(result).find((item) => rowSn(item) === deviceSn);
        const token = String((row && (row.token || row.deviceToken)) || "").trim();
        if (!token) return reject(stableError("DEVICE_TOKEN_REFRESH_EMPTY"));
        resolve(token);
      }));
    } catch (error) {
      finish(reject)(error);
    }
  });
}

function extractBackendToken(result) {
  if (typeof result === "string") return result.trim();
  return String((result && (result.deviceToken || result.token)) || "").trim();
}

async function refreshDeviceToken({ sdk, sn, timeoutMs = 12000, fetchBackendToken } = {}) {
  const deviceSn = String(sn || "").trim();
  try {
    return await refreshSdkDeviceToken({ sdk, sn: deviceSn, timeoutMs });
  } catch (sdkError) {
    if (typeof fetchBackendToken !== "function" || !deviceSn) throw sdkError;
    const token = extractBackendToken(await fetchBackendToken(deviceSn));
    if (!token) throw stableError("DEVICE_TOKEN_REFRESH_EMPTY");
    return token;
  }
}

module.exports = { extractRows, refreshDeviceToken };
