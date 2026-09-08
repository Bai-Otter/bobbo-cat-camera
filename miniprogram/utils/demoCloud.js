function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    return fallback;
  }
}

const {
  BACKEND_RUNTIME,
  getBackendBaseUrl,
  isCloudHosting,
} = require("../config/backend.js");
const { callBackend } = require("./backendClient.js");

function readProfile(uniApi) {
  return parseJson(uniApi.getStorageSync("userProfile"), null);
}

function diaryKey(deviceSn, date) {
  return `demo_diary_${deviceSn || "none"}_${date || "none"}`;
}

function feedbackKey() {
  return "demo_feedback_list";
}

function notificationKey() {
  return "demo_notifications";
}

function feedAnalysisSettingKey(deviceSn) {
  return `demo_feed_analysis_setting_${deviceSn || "none"}`;
}

function replayMarkersKey(deviceSn, date) {
  return `demo_replay_markers_${deviceSn || "none"}_${date || "none"}`;
}

function deviceCoverMapKey() {
  return "demo_device_cover_map";
}

function readNotificationSetting(uniApi) {
  return parseJson(uniApi.getStorageSync("demo_notification_setting"), {
    enabled: false,
    templateId: "",
  });
}

function readDeviceCoverMap(uniApi) {
  const map = parseJson(uniApi.getStorageSync(deviceCoverMapKey()), {});
  return map && typeof map === "object" ? map : {};
}

function readLocalNotifications(uniApi) {
  const list = parseJson(uniApi.getStorageSync(notificationKey()), []);
  return Array.isArray(list) ? list : [];
}

function getUnreadNotificationCount(uniApi) {
  return readLocalNotifications(uniApi).filter((item) => !item.read).length;
}

function markLocalNotificationsRead(uniApi) {
  const list = readLocalNotifications(uniApi).map((item) => Object.assign({}, item, { read: true }));
  uniApi.setStorageSync(notificationKey(), JSON.stringify(list));
  return { ok: true, count: list.length };
}

function recordLocalNotifications(uniApi, previousDiary, nextDiary, meta = {}) {
  const setting = readNotificationSetting(uniApi);
  if (!setting.enabled) return { count: 0, items: [] };

  const oldClips = previousDiary && Array.isArray(previousDiary.clips) ? previousDiary.clips : [];
  const nextClips = nextDiary && Array.isArray(nextDiary.clips) ? nextDiary.clips : [];
  const oldIds = oldClips.reduce((acc, clip) => {
    if (clip && clip.id) acc[clip.id] = true;
    return acc;
  }, {});
  const existing = readLocalNotifications(uniApi);
  const notifiedIds = existing.reduce((acc, item) => {
    if (item && item.clipId) acc[item.clipId] = true;
    return acc;
  }, {});

  const createdAt = Date.now();
  const items = nextClips
    .filter((clip) => clip && clip.id && clip.isEffective !== false && !oldIds[clip.id] && !notifiedIds[clip.id])
    .map((clip, index) => ({
      id: `notice_${createdAt}_${index}_${clip.id}`,
      deviceSn: meta.deviceSn || (nextDiary && nextDiary.deviceSn) || "",
      date: meta.date || (nextDiary && nextDiary.date) || "",
      clipId: clip.id,
      title: clip.title || "发现新的吃饭片段",
      message: `${clip.time || "刚刚"} 发现新的小猫动态`,
      read: false,
      createdAt,
    }));

  if (items.length === 0) return { count: 0, items: [] };
  uniApi.setStorageSync(notificationKey(), JSON.stringify(items.concat(existing).slice(0, 100)));
  return { count: items.length, items };
}

function handleLocalAction(uniApi, action, payload = {}) {
  if (action === "getDiary") {
    return {
      ok: true,
      diary: parseJson(uniApi.getStorageSync(diaryKey(payload.deviceSn, payload.date)), null),
    };
  }

  if (action === "upsertDiary") {
    const inputDiary = payload.diary || {};
    const diary = Object.assign({}, payload.diary || {}, {
      deviceSn: payload.deviceSn || inputDiary.deviceSn || "",
      date: payload.date || inputDiary.date || "",
      updatedAt: Date.now(),
    });
    uniApi.setStorageSync(diaryKey(diary.deviceSn, diary.date), JSON.stringify(diary));
    return { ok: true, diary };
  }

  if (action === "submitFeedback") {
    const content = String(payload.content || "").trim();
    if (!content) return { ok: false, error: "EMPTY_CONTENT" };
    const list = parseJson(uniApi.getStorageSync(feedbackKey()), []);
    const item = {
      id: `feedback_${Date.now()}`,
      type: payload.type || "建议",
      content,
      contact: payload.contact || "",
      deviceSn: payload.deviceSn || "",
      status: "open",
      createdAt: Date.now(),
    };
    list.unshift(item);
    uniApi.setStorageSync(feedbackKey(), JSON.stringify(list.slice(0, 100)));
    return { ok: true, id: item.id };
  }

  if (action === "saveNotificationSetting") {
    const enabled = !!payload.enabled;
    uniApi.setStorageSync("demo_notification_setting", JSON.stringify({
      enabled,
      templateId: payload.templateId || "",
      updatedAt: Date.now(),
    }));
    if (payload.deviceSn) {
      uniApi.setStorageSync(feedAnalysisSettingKey(payload.deviceSn), JSON.stringify({
        deviceSn: payload.deviceSn,
        feedingDetectionEnabled: enabled,
        analysisEnabled: enabled,
        notifyEnabled: enabled,
        updatedAt: Date.now(),
      }));
    }
    return { ok: true };
  }

  if (action === "setFeedAnalysisEnabled") {
    const enabled = !!payload.enabled;
    const setting = {
      deviceSn: payload.deviceSn || "",
      feedingDetectionEnabled: enabled,
      analysisEnabled: enabled,
      notifyEnabled: enabled,
      updatedAt: Date.now(),
    };
    uniApi.setStorageSync(feedAnalysisSettingKey(setting.deviceSn), JSON.stringify(setting));
    return { ok: true, setting };
  }

  if (action === "getFeedAnalysisSetting") {
    return {
      ok: true,
      setting: parseJson(uniApi.getStorageSync(feedAnalysisSettingKey(payload.deviceSn)), null),
    };
  }

  if (action === "syncFeedAnalysis") {
    const diary = Object.assign({}, payload.diary || {}, {
      deviceSn: payload.deviceSn || (payload.diary && payload.diary.deviceSn) || "",
      date: payload.date || (payload.diary && payload.diary.date) || "",
      updatedAt: Date.now(),
    });
    const markers = Array.isArray(payload.markers) ? payload.markers : [];
    uniApi.setStorageSync(diaryKey(diary.deviceSn, diary.date), JSON.stringify(diary));
    uniApi.setStorageSync(replayMarkersKey(diary.deviceSn, diary.date), JSON.stringify(markers));
    return { ok: true, diary, markers };
  }

  if (action === "getReplayMarkers") {
    return {
      ok: true,
      markers: parseJson(uniApi.getStorageSync(replayMarkersKey(payload.deviceSn, payload.date)), []),
    };
  }

  if (action === "saveDeviceCover") {
    const sn = String(payload.sn || "").trim();
    if (!sn) return { ok: false, error: "MISSING_SN" };
    const capturedAt = Number(payload.capturedAt) || Date.now();
    const existingMap = readDeviceCoverMap(uniApi);
    existingMap[sn] = {
      sn,
      fileId: String(payload.fileId || "").trim(),
      coverUrl: String(payload.localPath || payload.coverUrl || "").trim(),
      capturedAt,
      updatedAt: capturedAt,
    };
    uniApi.setStorageSync(deviceCoverMapKey(), JSON.stringify(existingMap));
    return { ok: true, cover: existingMap[sn] };
  }

  if (action === "getDeviceCovers") {
    const sns = Array.isArray(payload.sns) ? payload.sns.map((item) => String(item || "").trim()).filter(Boolean) : [];
    const map = readDeviceCoverMap(uniApi);
    const coversBySn = sns.reduce((acc, sn) => {
      if (map[sn]) acc[sn] = map[sn];
      return acc;
    }, {});
    return { ok: true, coversBySn };
  }

  return { ok: false, error: "UNKNOWN_ACTION" };
}

function mergeDeviceCoverResults(remoteResult = {}, localResult = {}) {
  const remoteMap = (remoteResult && remoteResult.coversBySn) || {};
  const localMap = (localResult && localResult.coversBySn) || {};
  const coversBySn = { ...remoteMap };
  for (const [sn, localCover] of Object.entries(localMap)) {
    const remoteCover = coversBySn[sn];
    if (!remoteCover || Number(localCover.capturedAt || 0) >= Number(remoteCover.capturedAt || 0)) {
      coversBySn[sn] = localCover;
    }
  }
  return {
    ok: remoteResult.ok !== false || localResult.ok === true,
    coversBySn,
  };
}

function buildDemoDataPayload(action, payload = {}, runtime = BACKEND_RUNTIME) {
  const data = Object.assign({ action }, payload);
  if (isCloudHosting(runtime)) {
    const serverBaseUrl = getBackendBaseUrl(runtime);
    if (serverBaseUrl) {
      data.serverBaseUrl = serverBaseUrl;
    }
  }
  return data;
}

function buildLocalDemoRequest(action, payload = {}) {
  if (action === "getDiary") {
    return {
      path: "/api/feed-analysis/diary",
      options: {
        method: "GET",
        query: {
          deviceSn: payload.deviceSn || "",
          date: payload.date || "",
          sync: payload.sync ? "1" : "0",
        },
      },
    };
  }
  if (action === "syncFeedAnalysis") {
    return {
      path: "/api/feed-analysis/sync",
      options: {
        method: "POST",
        data: {
          deviceSn: payload.deviceSn || "",
          date: payload.date || "",
          force: !!payload.force,
        },
      },
    };
  }
  if (action === "getReplayMarkers") {
    return {
      path: "/api/feed-analysis/markers",
      options: {
        method: "GET",
        query: {
          deviceSn: payload.deviceSn || "",
          date: payload.date || "",
        },
      },
    };
  }
  if (action === "submitFeedback") {
    return {
      path: "/api/feedback",
      options: {
        method: "POST",
        data: Object.assign({}, payload),
      },
    };
  }
  if (action === "saveNotificationSetting" || action === "setFeedAnalysisEnabled") {
    return {
      path: "/api/feed-analysis/settings",
      options: {
        method: "POST",
        data: {
          deviceSn: payload.deviceSn || "",
          feedingDetectionEnabled: !!payload.enabled,
          templateId: payload.templateId || "",
        },
      },
    };
  }
  if (action === "getDeviceCovers") {
    return {
      path: "/api/device-covers",
      options: {
        method: "GET",
        query: {
          sns: (Array.isArray(payload.sns) ? payload.sns : [])
            .map((item) => String(item || "").trim())
            .filter(Boolean)
            .join(","),
        },
      },
    };
  }
  if (action === "saveDeviceCover") {
    if (!String(payload.fileId || "").trim() && !String(payload.coverUrl || "").trim()) {
      return null;
    }
    return {
      path: "/api/device-covers",
      options: {
        method: "POST",
        data: {
          sn: payload.sn || "",
          fileId: payload.fileId || "",
          coverUrl: payload.coverUrl || "",
          capturedAt: payload.capturedAt,
        },
      },
    };
  }
  return null;
}

function callDemoData(action, payload = {}) {
  const uniApi = typeof uni !== "undefined" ? uni : null;
  const wxApi = typeof wx !== "undefined" ? wx : null;
  if (!uniApi) return Promise.resolve({ ok: false, error: "NO_UNI" });

  const profile = readProfile(uniApi);
  if (!isCloudHosting(BACKEND_RUNTIME)) {
    if (action === "saveNotificationSetting" || action === "saveDeviceCover") {
      handleLocalAction(uniApi, action, payload);
    }
    const request = buildLocalDemoRequest(action, payload);
    if (!request) return Promise.resolve(handleLocalAction(uniApi, action, payload));
    return callBackend(request.path, request.options, uniApi)
      .then((result) => {
        if (action === "getDeviceCovers") {
          return mergeDeviceCoverResults(result, handleLocalAction(uniApi, action, payload));
        }
        return result;
      })
      .catch((error) => {
        console.log("[demoCloud] local backend fallback", error);
        return handleLocalAction(uniApi, action, payload);
      });
  }

  const canUseCloud = !!(profile && profile.cloudOk && wxApi && wxApi.cloud);
  if (!canUseCloud) {
    return Promise.resolve(handleLocalAction(uniApi, action, payload));
  }

  if (action === "saveNotificationSetting" || action === "saveDeviceCover") {
    handleLocalAction(uniApi, action, payload);
  }

  return new Promise((resolve) => {
    wxApi.cloud.callFunction({
      name: "demoData",
      data: buildDemoDataPayload(action, payload),
      success: (res) => {
        const result = (res && res.result) || { ok: false, error: "EMPTY_RESULT" };
        resolve(action === "getDeviceCovers"
          ? mergeDeviceCoverResults(result, handleLocalAction(uniApi, action, payload))
          : result);
      },
      fail: (err) => {
        console.log("[demoCloud] cloud fallback", err);
        resolve(handleLocalAction(uniApi, action, payload));
      },
    });
  });
}

module.exports = {
  buildDemoDataPayload,
  buildLocalDemoRequest,
  callDemoData,
  getUnreadNotificationCount,
  handleLocalAction,
  mergeDeviceCoverResults,
  markLocalNotificationsRead,
  readLocalNotifications,
  recordLocalNotifications,
};
