const cloud = require("wx-server-sdk");
const http = require("http");
const https = require("https");
const { withCollection } = require("./collectionBootstrap");
const { getObsoleteCoverFileId } = require("./coverStoragePolicy");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const DIARY_COLL = "demo_diaries";
const FEEDBACK_COLL = "feedback";
const SETTINGS_COLL = "notification_settings";
const ANALYSIS_COLL = "feed_analysis_states";
const MARKERS_COLL = "replay_markers";
const DEVICE_COVERS_COLL = "device_covers";

function requireOpenid() {
  const wxCtx = cloud.getWXContext();
  if (!wxCtx.OPENID) {
    const err = new Error("NO_OPENID");
    err.code = "NO_OPENID";
    throw err;
  }
  return wxCtx.OPENID;
}

function cleanString(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

function cleanDiary(event) {
  const diary = event.diary || {};
  return {
    deviceSn: cleanString(event.deviceSn || diary.deviceSn, 80),
    date: cleanString(event.date || diary.date, 20),
    eatCount: Number(diary.eatCount) || 0,
    eatMinutes: Number(diary.eatMinutes) || 0,
    clipCount: Number(diary.clipCount) || 0,
    clips: Array.isArray(diary.clips) ? diary.clips.slice(0, 80) : [],
    meals: Array.isArray(diary.meals) ? diary.meals.slice(0, 40) : [],
    featuredClipId: cleanString(diary.featuredClipId, 120),
    foodcast: diary.foodcast || null,
    updatedAt: Date.now(),
  };
}

function cleanMarker(marker = {}, event = {}) {
  return {
    deviceSn: cleanString(event.deviceSn || marker.deviceSn, 80),
    date: cleanString(event.date || marker.date, 20),
    recordingKey: cleanString(marker.recordingKey, 200),
    markerType: cleanString(marker.markerType, 40),
    markerTsMs: Number(marker.markerTsMs) || 0,
    beginTime: cleanString(marker.beginTime, 40),
    endTime: cleanString(marker.endTime, 40),
    confidence: Number(marker.confidence) || 0,
    playbackParams: marker.playbackParams || null,
    createdAt: Number(marker.createdAt) || Date.now(),
  };
}

async function upsertOne(collName, where, data) {
  const coll = db.collection(collName);
  const existing = await coll.where(where).limit(1).get();
  if (existing.data && existing.data.length > 0) {
    const id = existing.data[0]._id;
    await coll.doc(id).update({ data });
    return Object.assign({ _id: id }, data);
  }
  const created = await coll.add({ data });
  return Object.assign({ _id: created._id }, data);
}

async function getDiary(openid, event) {
  const deviceSn = cleanString(event.deviceSn, 80);
  const date = cleanString(event.date, 20);
  if (!deviceSn || !date) return { ok: false, error: "MISSING_PARAMS" };

  if (event.sync !== false) {
    await syncFeedAnalysis(openid, event);
  }

  const result = await db.collection(DIARY_COLL).where({ openid, deviceSn, date }).limit(1).get();
  return { ok: true, diary: result.data && result.data[0] ? result.data[0] : null };
}

async function upsertDiary(openid, event) {
  const diary = cleanDiary(event);
  if (!diary.deviceSn || !diary.date) return { ok: false, error: "MISSING_PARAMS" };
  const saved = await upsertOne(
    DIARY_COLL,
    { openid, deviceSn: diary.deviceSn, date: diary.date },
    Object.assign({}, diary, { openid })
  );
  return { ok: true, diary: saved };
}

async function submitFeedback(openid, event) {
  const content = cleanString(event.content, 1000);
  if (!content) return { ok: false, error: "EMPTY_CONTENT" };

  const data = {
    openid,
    type: cleanString(event.type || "建议", 40),
    content,
    contact: cleanString(event.contact, 120),
    deviceSn: cleanString(event.deviceSn, 80),
    status: "open",
    createdAt: Date.now(),
  };
  const created = await db.collection(FEEDBACK_COLL).add({ data });
  return { ok: true, id: created._id };
}

async function saveNotificationSetting(openid, event) {
  const enabled = !!event.enabled;
  const data = {
    openid,
    enabled,
    templateId: cleanString(event.templateId, 120),
    updatedAt: Date.now(),
  };
  await upsertOne(SETTINGS_COLL, { openid }, data);
  if (event.deviceSn) {
    await upsertOne(
      ANALYSIS_COLL,
      { openid, deviceSn: cleanString(event.deviceSn, 80) },
      {
        openid,
        deviceSn: cleanString(event.deviceSn, 80),
        feedingDetectionEnabled: enabled,
        analysisEnabled: enabled,
        notifyEnabled: enabled,
        templateId: cleanString(event.templateId, 120),
        bowlRoi: event.bowlRoi || null,
        bowlConfidence: Number(event.bowlConfidence) || 0,
        lastScannedAt: Number(event.lastScannedAt) || 0,
        lastProcessedRecordingKey: cleanString(event.lastProcessedRecordingKey, 200),
        officialConfigStatus: cleanString(event.officialConfigStatus || "idle", 40),
        updatedAt: Date.now(),
      }
    );
  }
  await syncServerSettings(openid, event);
  return { ok: true };
}

async function setFeedAnalysisEnabled(openid, event) {
  const deviceSn = cleanString(event.deviceSn, 80);
  if (!deviceSn) return { ok: false, error: "MISSING_PARAMS" };

  const existingSetting = await db.collection(SETTINGS_COLL).where({ openid }).limit(1).get();
  const notifySetting = existingSetting.data && existingSetting.data[0] ? existingSetting.data[0] : {};
  const enabled = !!event.enabled;
  const data = {
    openid,
    deviceSn,
    feedingDetectionEnabled: enabled,
    analysisEnabled: enabled,
    notifyEnabled: enabled,
    templateId: cleanString(event.templateId || notifySetting.templateId, 120),
    bowlRoi: event.bowlRoi || null,
    bowlConfidence: Number(event.bowlConfidence) || 0,
    lastScannedAt: Number(event.lastScannedAt) || 0,
    lastProcessedRecordingKey: cleanString(event.lastProcessedRecordingKey, 200),
    officialConfigStatus: cleanString(event.officialConfigStatus || "idle", 40),
    updatedAt: Date.now(),
  };
  const setting = await upsertOne(ANALYSIS_COLL, { openid, deviceSn }, data);
  await syncServerSettings(openid, {
    deviceSn,
    enabled: setting.analysisEnabled,
    templateId: setting.templateId,
    notifyEnabled: setting.notifyEnabled,
  });
  return { ok: true, setting };
}

async function getReplayMarkers(openid, event) {
  const deviceSn = cleanString(event.deviceSn, 80);
  const date = cleanString(event.date, 20);
  if (!deviceSn || !date) return { ok: false, error: "MISSING_PARAMS" };

  if (event.sync !== false) {
    await syncFeedAnalysis(openid, event);
  }

  const result = await db.collection(MARKERS_COLL).where({ openid, deviceSn, date }).get();
  return { ok: true, markers: result.data || [] };
}

async function getDeviceCovers(openid, event) {
  const sns = Array.isArray(event.sns)
    ? event.sns.map((item) => cleanString(item, 80)).filter(Boolean)
    : [];
  if (sns.length === 0) return { ok: true, coversBySn: {} };

  const result = await withCollection(db, DEVICE_COVERS_COLL, () =>
    db.collection(DEVICE_COVERS_COLL).where({ openid, sn: _.in(sns) }).get()
  );
  const records = result.data || [];
  const fileIds = records.map((item) => item.fileId).filter(Boolean);
  let tempUrlMap = {};
  if (fileIds.length > 0) {
    try {
      const tempResult = await cloud.getTempFileURL({ fileList: fileIds });
      tempUrlMap = (tempResult.fileList || []).reduce((acc, item) => {
        if (item.fileID && item.tempFileURL) {
          acc[item.fileID] = item.tempFileURL;
        }
        return acc;
      }, {});
    } catch (error) {
      console.error("[demoData] getTempFileURL", error);
    }
  }
  const coversBySn = {};
  for (const item of records) {
    coversBySn[item.sn] = {
      sn: item.sn,
      fileId: item.fileId || "",
      coverUrl: tempUrlMap[item.fileId] || item.coverUrl || "",
      capturedAt: Number(item.capturedAt) || 0,
      updatedAt: Number(item.updatedAt) || 0,
    };
  }
  return { ok: true, coversBySn };
}

async function saveDeviceCover(openid, event) {
  const sn = cleanString(event.sn, 80);
  if (!sn) return { ok: false, error: "MISSING_SN" };

  const capturedAt = Number(event.capturedAt) || Date.now();
  const fileId = cleanString(event.fileId, 500);
  const coverUrl = cleanString(event.coverUrl, 1000);
  const data = {
    openid,
    sn,
    fileId,
    coverUrl,
    capturedAt,
    updatedAt: capturedAt,
  };
  let obsoleteFileId = "";
  const saved = await withCollection(db, DEVICE_COVERS_COLL, async () => {
    const existingResult = await db
      .collection(DEVICE_COVERS_COLL)
      .where({ openid, sn })
      .limit(1)
      .get();
    const existingCover = existingResult.data && existingResult.data[0];
    const nextCover = await upsertOne(DEVICE_COVERS_COLL, { openid, sn }, data);
    obsoleteFileId = getObsoleteCoverFileId(existingCover, fileId);
    return nextCover;
  });
  if (obsoleteFileId) {
    try {
      await cloud.deleteFile({ fileList: [obsoleteFileId] });
    } catch (error) {
      console.error("[demoData] delete obsolete device cover", error);
    }
  }
  return { ok: true, cover: saved };
}

function resolveServerBaseUrl(event) {
  return cleanString(
    event.serverBaseUrl ||
      process.env.FEED_ANALYSIS_SERVER_BASE_URL ||
      process.env.ANALYSIS_SERVER_BASE_URL,
    300
  );
}

function httpRequestJson(method, urlString, payload) {
  const url = new URL(urlString);
  const body = payload ? JSON.stringify(payload) : "";
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw || "{}"));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function syncServerSettings(openid, event) {
  const serverBaseUrl = resolveServerBaseUrl(event);
  if (!serverBaseUrl || !event.deviceSn) return { ok: false, skipped: true };
  try {
    const enabled = Object.prototype.hasOwnProperty.call(event, "feedingDetectionEnabled")
      ? !!event.feedingDetectionEnabled
      : Object.prototype.hasOwnProperty.call(event, "enabled")
        ? !!event.enabled
        : !!event.analysisEnabled || !!event.notifyEnabled;
    await httpRequestJson("POST", `${serverBaseUrl}/api/feed-analysis/settings`, {
      openid,
      deviceSn: cleanString(event.deviceSn, 80),
      feedingDetectionEnabled: enabled,
      analysisEnabled: enabled,
      notifyEnabled: enabled,
      templateId: cleanString(event.templateId, 120),
    });
    return { ok: true };
  } catch (error) {
    console.error("[demoData] syncServerSettings", error);
    return { ok: false, error: error.message || "SYNC_SERVER_FAILED" };
  }
}

async function replaceReplayMarkers(openid, event, markers) {
  const deviceSn = cleanString(event.deviceSn, 80);
  const date = cleanString(event.date, 20);
  const coll = db.collection(MARKERS_COLL);
  const existing = await coll.where({ openid, deviceSn, date }).get();
  if (existing.data && existing.data.length > 0) {
    await Promise.all(existing.data.map((item) => coll.doc(item._id).remove()));
  }
  for (const marker of markers) {
    await coll.add({
      data: Object.assign({ openid }, cleanMarker(marker, event)),
    });
  }
}

async function sendPendingNotifications(openid, deviceState, pendingNotifications = []) {
  if (!deviceState || !deviceState.notifyEnabled || !deviceState.templateId) {
    return [];
  }
  const sentIds = [];
  for (const item of pendingNotifications) {
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        page: "pages/today/index",
        templateId: deviceState.templateId,
        miniprogramState: "developer",
        lang: "zh_CN",
        data: {
          thing1: { value: cleanString(item.title || "猫来吃饭了", 20) },
          time2: { value: cleanString(item.startTime || "", 32) },
          thing3: { value: cleanString(item.message || "检测到猫咪开始进食", 20) },
        },
      });
      sentIds.push(item.eventId);
    } catch (error) {
      console.error("[demoData] sendPendingNotifications", error);
    }
  }
  return sentIds;
}

async function syncFeedAnalysis(openid, event) {
  const deviceSn = cleanString(event.deviceSn, 80);
  const date = cleanString(event.date, 20);
  if (!deviceSn || !date) return { ok: false, error: "MISSING_PARAMS" };
  const serverBaseUrl = resolveServerBaseUrl(event);
  if (!serverBaseUrl) return { ok: false, error: "NO_SERVER_BASE_URL" };

  const syncResult = await httpRequestJson("POST", `${serverBaseUrl}/api/feed-analysis/sync`, {
    deviceSn,
    date,
    force: !!event.force,
  });
  if (!syncResult.ok) {
    return syncResult;
  }

  const diary = cleanDiary({
    deviceSn,
    date,
    diary: syncResult.diary || { deviceSn, date, clips: [], meals: [] },
  });
  await upsertDiary(openid, { deviceSn, date, diary });
  await replaceReplayMarkers(openid, { deviceSn, date }, syncResult.markers || []);

  const deviceStateResult = await db.collection(ANALYSIS_COLL).where({ openid, deviceSn }).limit(1).get();
  const deviceState =
    deviceStateResult.data && deviceStateResult.data[0] ? deviceStateResult.data[0] : null;
  const sentIds = await sendPendingNotifications(openid, deviceState, syncResult.pendingNotifications || []);
  if (sentIds.length > 0) {
    await httpRequestJson("POST", `${serverBaseUrl}/api/feed-analysis/notifications/ack`, {
      eventIds: sentIds,
    });
  }

  return {
    ok: true,
    diary,
    markers: syncResult.markers || [],
    sentNotificationIds: sentIds,
  };
}

exports.main = async (event = {}) => {
  try {
    const openid = requireOpenid();
    switch (event.action) {
      case "getDiary":
        return await getDiary(openid, event);
      case "upsertDiary":
        return await upsertDiary(openid, event);
      case "submitFeedback":
        return await submitFeedback(openid, event);
      case "saveNotificationSetting":
        return await saveNotificationSetting(openid, event);
      case "setFeedAnalysisEnabled":
        return await setFeedAnalysisEnabled(openid, event);
      case "getReplayMarkers":
        return await getReplayMarkers(openid, event);
      case "syncFeedAnalysis":
        return await syncFeedAnalysis(openid, event);
      case "getDeviceCovers":
        return await getDeviceCovers(openid, event);
      case "saveDeviceCover":
        return await saveDeviceCover(openid, event);
      default:
        return { ok: false, error: "UNKNOWN_ACTION" };
    }
  } catch (err) {
    console.error("[demoData]", err);
    return { ok: false, error: err.code || err.message || "SERVER_ERROR" };
  }
};
