function hasConfiguredCloudEnv(cloudEnvId) {
  return !!(cloudEnvId && cloudEnvId !== "YOUR_CLOUD_ENV_ID");
}

function getMiniProgramAppId(wxApi) {
  if (!wxApi || typeof wxApi.getAccountInfoSync !== "function") return "";
  try {
    const accountInfo = wxApi.getAccountInfoSync() || {};
    const miniProgram = accountInfo.miniProgram || {};
    return String(miniProgram.appId || "").trim();
  } catch (error) {
    return "";
  }
}

function initCloudRuntime({ wxApi, cloudEnvId, logger = console } = {}) {
  const envReady = hasConfiguredCloudEnv(cloudEnvId);
  if (!envReady) {
    logger.warn && logger.warn("[cloud] cloud env id is not configured; skip wx.cloud.init");
    return {
      cloudReady: false,
      cloudInitialized: false,
      appId: "",
      reason: "env-missing",
    };
  }

  if (!wxApi || !wxApi.cloud || typeof wxApi.cloud.init !== "function") {
    logger.warn && logger.warn("[cloud] wx.cloud is unavailable; skip wx.cloud.init");
    return {
      cloudReady: false,
      cloudInitialized: false,
      appId: "",
      reason: "cloud-unavailable",
    };
  }

  const appId = getMiniProgramAppId(wxApi);
  if (!appId) {
    logger.warn && logger.warn("[cloud] mini program appid is missing; skip wx.cloud.init");
    return {
      cloudReady: false,
      cloudInitialized: false,
      appId: "",
      reason: "appid-missing",
    };
  }

  try {
    wxApi.cloud.init({
      env: cloudEnvId,
      traceUser: true,
    });
    logger.log && logger.log("[cloud] wx.cloud initialized, env =", cloudEnvId);
    return {
      cloudReady: true,
      cloudInitialized: true,
      appId,
      reason: "",
    };
  } catch (error) {
    logger.warn && logger.warn("[cloud] wx.cloud.init failed; cloud features disabled", error);
    return {
      cloudReady: false,
      cloudInitialized: false,
      appId,
      reason: "init-failed",
      error,
    };
  }
}

module.exports = {
  getMiniProgramAppId,
  hasConfiguredCloudEnv,
  initCloudRuntime,
};
