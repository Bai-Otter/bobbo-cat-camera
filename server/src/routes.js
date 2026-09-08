const express = require("express");
const crypto = require("crypto");
const { AccountSyncAudit, cleanRequestId, safeErrorCode } = require("./accountSyncAudit");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const config = require("./config");
const cache = require("./tokenCache");
const { createAppSessionService } = require("./appSession");
const { createRequestAuth } = require("./requestAuth");
const { createWechatLoginService } = require("./wechatLogin");
const { createWechatMiniCodeService } = require("./wechatMiniCode");
const { WechatMiniSubscriptionService } = require("./notifications/wechatMiniSubscriptionService");
const { WechatOfficialAccountService, parseWechatEventXml } = require("./notifications/wechatOfficialAccountService");
const { WechatNotificationCoordinator } = require("./notifications/wechatNotificationCoordinator");
const { WechatDeviceMessageService } = require("./notifications/wechatDeviceMessageService");
const { WechatDeviceNotificationCoordinator } = require("./notifications/wechatDeviceNotificationCoordinator");
const { WechatHybridNotificationCoordinator } = require("./notifications/wechatHybridNotificationCoordinator");
const { WxPusherService } = require("./notifications/wxPusherService");
const { WxPusherBindingService } = require("./notifications/wxPusherBindingService");
const { PushPlusNotifier } = require("./notifications/pushPlusNotifier");
const { PushPlusOpenApi } = require("./notifications/pushPlusOpenApi");
const { PushPlusBindingService } = require("./notifications/pushPlusBindingService");
const { AppDataStore } = require("./appDataStore");
const { DeviceRegistry, buildCatRef } = require("./deviceRegistry");
const { createCloudDeviceRegistryStore } = require("./cloudDeviceRegistryStore");
const { JFDevice } = require("./jf/device");
const { JFDevicePriClient } = require("./jf/devicePriClient");
const { getHttpsProxyUrl } = require("./jf/http");
const { FlvRelay } = require("./replay/flvRelay");
const { ReplaySessionManager, normalizeReplayRecord } = require("./replay/replaySessionManager");
const { HlsTranscodeSessionManager, isRtspUrl } = require("./replay/hlsTranscodeSessionManager");
const { createNativeHlsSourceController } = require("./replay/nativeHlsSourceController");
const { resolveVideoFilter } = require("./videoFilters/cutePreset");
const { captureLiveSnapshot } = require("./liveSnapshot");
const { RecordingThumbnailService } = require("./replay/recordingThumbnailService");
const { publicRecording } = require("./liveMedia/liveRecordingStore");
const { LiveRecordingSourceManager } = require("./liveMedia/liveRecordingSourceManager");
const {
  formatDateKey: formatFeedAnalysisDateKey,
  recordingKey: feedAnalysisRecordingKey,
} = require("./feedAnalysis/model");
const { FeedingActivityTestService } = require("./feedAnalysis/activityTestService");
const { FoodcastAlgorithmTestService } = require("./feedAnalysis/foodcastAlgorithmTestService");
const { matchMotionAlarmRecording, normalizeMotionAlarmList } = require("./motionAlerts");
const { formatDeviceDateTime } = require("./feedAnalysis/deviceTime");
const { readDeviceClock, syncDeviceClock } = require("./feedAnalysis/deviceTimeSync");
const { buildDeviceSettingsSummary } = require("./deviceSettingsSummary");
const {
  isLivePlaybackDiagnosticDevice,
  normalizeLivePlaybackEvent,
} = require("./livePlaybackDiagnostics");

const router = express.Router();
const motionAlarmImageSources = new Map();
const MOTION_ALARM_IMAGE_TTL_MS = 15 * 60 * 1000;
const MOTION_ALARM_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const accountSyncAudit = new AccountSyncAudit({ filePath: config.accountSyncAuditFile });
const appSessions = createAppSessionService({
  secret: config.session.secret || "local-development-session-secret-32-bytes",
  ttlMs: config.session.ttlMs,
});
const requestAuth = createRequestAuth({
  sessions: appSessions,
  allowSessionIdentity: !config.cloudHosting,
  trustCloudHeaders: config.cloudHosting,
  allowDevelopmentIdentity: /^(1|true|yes|on)$/i.test(
    String(process.env.ALLOW_DEVELOPMENT_IDENTITY || "")
  ),
});
const defaultWechatLoginService = createWechatLoginService(config.wechat);
let wechatLoginService = defaultWechatLoginService;
const defaultWechatMiniCodeService = createWechatMiniCodeService(config.wechat);
let wechatMiniCodeService = defaultWechatMiniCodeService;
const appDataStore = new AppDataStore(config.appData.stateFile);
const recordingThumbnailService = new RecordingThumbnailService({
  outputDir: config.replayThumbnailDir,
  timeoutMs: 20_000,
  maxAttempts: 2,
  retryDelayMs: 1_500,
  failedCooldownMs: 30_000,
  logger: console,
  sourceForRecord: async (deviceSn, record) => {
    const dev = await ensureDeviceReady(deviceSn);
    await dev.login();
    // Keep the exact recording boundary when requesting the vendor URL.
    // Shifting beginTime while retaining fileName makes some firmwares reject
    // an otherwise playable recording. FFmpeg can capture the first frame.
    const playback = buildPlaybackRequestForTargetSec(buildReplayRecordFromBody(record), 0);
    const baseOptions = {
      channel: 0,
      streamType: 0,
      startTime: playback.requestNormalized.beginTime,
      endTime: playback.requestNormalized.endTime,
      fileName: playback.requestNormalized.fileName,
    };
    const candidates = [];
    let lastError = null;
    // The vendor's default replay transport is the same source that already
    // succeeds through our HLS relay. Prefer it for FFmpeg thumbnails, then
    // retain explicit HLS as a second candidate for compatible firmwares.
    for (const options of [
      baseOptions,
      {
        ...baseOptions,
        mediaType: "hls",
        protocol: "ts",
      },
    ]) {
      try {
        const url = await dev.getPlaybackUrl(playback.requestRecord, options);
        if (url && !candidates.includes(url)) candidates.push(url);
      } catch (error) {
        lastError = error;
      }
    }
    if (candidates.length === 0) throw lastError || new Error("THUMBNAIL_SOURCE_UNAVAILABLE");
    return candidates;
  },
  capture: ({ sourceUrl, timeoutMs, signal }) => captureLiveSnapshot({
    sourceUrl,
    timeoutMs,
    signal,
    ffmpegPath: config.replay.ffmpegPath,
  }),
});
let feedAnalysisCoordinator = null;
let foodcastService = null;
let foodcastAutomationService = null;
let foodcastAutomationRecovery = null;
let customFoodcastService = null;
let liveRecordingService = null;
const defaultFeedingActivityTestService = new FeedingActivityTestService({
  inputDir: config.analysis.test.inputDir,
 tempDir: config.analysis.test.tempDir,
  outputDir: config.analysis.test.outputDir,
  maxFileBytes: config.analysis.test.maxFileBytes,
  defaultDurationSec: config.analysis.test.defaultDurationSec,
  maxDurationSec: config.analysis.test.maxDurationSec,
  ffmpegPath: config.replay.ffmpegPath || "ffmpeg",
  vision: {
    pythonPath: config.analysis.pythonPath,
    workerScript: config.analysis.workerScript,
    minConfidence: config.analysis.minConfidence,
    timeoutMs: config.analysis.visionTimeoutMs,
  },
});
let feedingActivityTestService = defaultFeedingActivityTestService;
const defaultFoodcastAlgorithmTestService = new FoodcastAlgorithmTestService({
  inputDir: config.analysis.test.inputDir,
  outputDir: path.join(config.analysis.test.outputDir, "foodcast"),
  tempDir: path.join(config.analysis.test.tempDir, "foodcast"),
  pythonPath: config.analysis.pythonPath,
  workerScript: config.analysis.workerScript,
  transcodeTimeoutMs: config.analysis.visionTimeoutMs,
  ffmpegPath: config.replay.ffmpegPath || "ffmpeg",
});
let foodcastAlgorithmTestService = defaultFoodcastAlgorithmTestService;
let replayChannelReleaseDelayMs = config.replay.channelReleaseDelayMs;
let replayChannelReleaseSleep = defaultSleep;
const DEFAULT_DEVICE_NICKNAME = "\u732b\u996d\u6444\u50cf\u5934";
const deviceRegistryStore = config.deviceRegistryBackend === "cloudbase"
  ? createCloudDeviceRegistryStore({
      envId: config.cloudbaseEnvId,
      secretId: config.cloudbaseCredentials.secretId,
      secretKey: config.cloudbaseCredentials.secretKey,
    })
  : null;
const deviceRegistry = new DeviceRegistry({
  filePath: config.deviceRegistryFile,
  store: deviceRegistryStore,
  legacyOwnerOpenid: config.legacyDeviceOwnerOpenid,
  requireLegacyOwner: config.cloudHosting || process.env.NODE_ENV === "production",
  defaultProfile: {
    sn: config.device.sn,
    nickname: DEFAULT_DEVICE_NICKNAME,
    username: config.device.username,
    password: config.device.password,
  },
});

async function ensureWechatAnalysisEnabled(deviceSn) {
  if (!feedAnalysisCoordinator || !feedAnalysisCoordinator.store) return;
  const settings = feedAnalysisCoordinator.store.getSettings(deviceSn);
  if (settings.analysisEnabled && settings.feedingDetectionEnabled) return;
  const next = {
    ...settings,
    deviceSn,
    analysisEnabled: true,
    feedingDetectionEnabled: true,
  };
  if (typeof feedAnalysisCoordinator.persistSettings === "function") {
    await feedAnalysisCoordinator.persistSettings(next);
  } else {
    feedAnalysisCoordinator.store.updateSettings(next, deviceSn);
  }
}

const defaultWechatMiniSubscriptionService = new WechatMiniSubscriptionService({
  ...config.wechat,
  ...config.wechatMiniSubscriptions,
});
const defaultWechatOfficialAccountService = new WechatOfficialAccountService({
  ...config.wechatOfficialAccount,
  miniProgramAppId: config.wechat.appId,
});
const defaultWxPusherService = new WxPusherService(config.wxPusher);
const defaultWxPusherBindingService = new WxPusherBindingService({
  store: appDataStore,
  wxPusherService: defaultWxPusherService,
  challengeTtlSeconds: config.wxPusher.challengeTtlSeconds,
  callbackConfigured: !!config.wxPusher.callbackSecret,
});
const defaultPushPlusNotifier = new PushPlusNotifier(config.pushPlus);
const defaultPushPlusBindingService = new PushPlusBindingService({
  store: appDataStore,
  openApi: new PushPlusOpenApi(config.pushPlus),
  serviceQrUrl: config.pushPlus.serviceQrUrl,
});
const defaultWechatFallbackNotificationCoordinator = new WechatNotificationCoordinator({
  store: appDataStore,
  deviceRegistry,
  miniService: defaultWechatMiniSubscriptionService,
  officialService: defaultWechatOfficialAccountService,
  wxPusherService: defaultWxPusherService,
  pushPlusNotifier: defaultPushPlusNotifier,
  ensureAnalysisEnabled: ensureWechatAnalysisEnabled,
});
const defaultWechatDeviceMessageService = new WechatDeviceMessageService({
  ...config.wechat,
  ...config.wechatDeviceMessages,
});
const defaultWechatLongTermNotificationCoordinator = new WechatDeviceNotificationCoordinator({
  store: appDataStore,
  deviceRegistry,
  messageService: defaultWechatDeviceMessageService,
  ensureAnalysisEnabled: ensureWechatAnalysisEnabled,
});
const defaultWechatDeviceNotificationCoordinator = new WechatHybridNotificationCoordinator({
  store: appDataStore,
  deviceRegistry,
  deviceMessageService: defaultWechatDeviceMessageService,
  deviceCoordinator: defaultWechatLongTermNotificationCoordinator,
  fallbackCoordinator: defaultWechatFallbackNotificationCoordinator,
});
let wechatDeviceNotificationCoordinator = defaultWechatDeviceNotificationCoordinator;

async function initializeDeviceRegistry() {
  await deviceRegistry.initialize();
  await wechatDeviceNotificationCoordinator.initialize();
}

async function resolveDeviceOwnerOpenid(deviceSn) {
  const profile = await deviceRegistry.getBySn(deviceSn);
  return String(profile?.ownerOpenid || "");
}

function mediaControlRequest(req = {}) {
  if (typeof req.get === "function") return req;
  return {
    get(name) {
      const value = req.headers?.[String(name || "").toLowerCase()];
      return Array.isArray(value) ? value[0] : value || "";
    },
  };
}

function authenticateMediaControl(req, token) {
  return requestAuth.authenticate(mediaControlRequest(req), token);
}

async function resolveOwnedMediaDevice(ownerOpenid, deviceSn) {
  return deviceRegistry.getAccessible(deviceSn, ownerOpenid);
}

async function resolveOwnedLiveSession(ownerOpenid, deviceSn, sessionId) {
  const descriptor = replayHlsManager.getSessionDescriptor?.(sessionId)
    || liveRecordingSourceManager.getSessionDescriptor(sessionId);
  if (!descriptor
    || descriptor.ownerOpenid !== ownerOpenid
    || descriptor.deviceSn !== deviceSn
    || descriptor.live !== true) {
    return null;
  }
  return descriptor;
}

async function resolveOwnedTalkbackUrl(ownerOpenid, deviceSn) {
  const profile = await resolveOwnedMediaDevice(ownerOpenid, deviceSn);
  if (!profile) {
    const error = new Error("DEVICE_NOT_FOUND");
    error.code = "DEVICE_NOT_FOUND";
    throw error;
  }
  const device = await ensureDeviceReady(deviceSn);
  await device.login();
  return device.getTalkbackUrl({ channel: config.channel, audioCode: "aac" });
}

async function resolveOwnedRecordingLiveSource(ownerOpenid, deviceSn) {
  const profile = await resolveOwnedMediaDevice(ownerOpenid, deviceSn);
  if (!profile) {
    const error = new Error("DEVICE_NOT_FOUND");
    error.code = "DEVICE_NOT_FOUND";
    throw error;
  }
  const device = await ensureDeviceReady(deviceSn);
  await device.login();
  return device.getLivestreamUrl("hls-ts", config.channel, config.stream);
}

function formatDeviceTimestamp(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function parseDeviceTimestamp(value) {
  const text = String(value || "").trim().replace(" ", "T");
  const timestamp = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text}+08:00`).getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function authorizedDeviceSnapshot(device, ownerOpenid, deviceSn) {
  if (!device || typeof device !== "object") return null;
  if (device.sn && String(device.sn) !== String(deviceSn || "")) return null;
  if (device.ownerOpenid && String(device.ownerOpenid) !== String(ownerOpenid || "")) return null;
  return { ...device, sn: String(deviceSn || "") };
}

function recordingStageError(code, cause) {
  if (cause?.code) return cause;
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function runRecordingStage(code, action) {
  try {
    return await action();
  } catch (error) {
    throw recordingStageError(code, error);
  }
}

async function resolveOwnedRecordingWindow({ ownerOpenid, deviceSn, device, startedAt, endedAt } = {}) {
  const profile = authorizedDeviceSnapshot(device, ownerOpenid, deviceSn)
    || await resolveOwnedMediaDevice(ownerOpenid, deviceSn);
  if (!profile) {
    const error = new Error("RECORDING_DEVICE_CONTEXT_MISSING");
    error.code = "RECORDING_DEVICE_CONTEXT_MISSING";
    throw error;
  }
  const startMs = Number(startedAt);
  const endMs = Number(endedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    const error = new Error("RECORDING_WINDOW_INVALID");
    error.code = "RECORDING_WINDOW_INVALID";
    throw error;
  }
  const recordingDevice = await runRecordingStage(
    "RECORDING_DEVICE_PREPARE_FAILED",
    () => ensureDeviceReady(deviceSn, profile)
  );
  await runRecordingStage("RECORDING_DEVICE_LOGIN_FAILED", () => recordingDevice.login());
  feedAnalysisCoordinator?.pauseDevice?.(deviceSn, config.replay.userPlaybackHoldMs);
  const stoppedHlsSessions = await runRecordingStage(
    "RECORDING_CHANNEL_RELEASE_FAILED",
    async () => Number(await replayHlsManager.stopDeviceSessions?.(deviceSn)) || 0
  );
  await waitForReplayChannelRelease(stoppedHlsSessions);
  const records = await runRecordingStage("RECORDING_QUERY_FAILED", () => recordingDevice.queryRecordings({
    beginTime: formatDeviceTimestamp(startMs - 2_000),
    endTime: formatDeviceTimestamp(endMs + 2_000),
    channel: config.channel,
  }));
  const overlaps = records.filter((record) => {
    const recordStart = parseDeviceTimestamp(record.BeginTime || record.beginTime);
    const recordEnd = parseDeviceTimestamp(record.EndTime || record.endTime);
    return Number.isFinite(recordStart) && Number.isFinite(recordEnd) && recordEnd > startMs && recordStart < endMs;
  });
  const windows = [];
  for (const record of overlaps) {
    const recordStart = parseDeviceTimestamp(record.BeginTime || record.beginTime);
    const recordEnd = parseDeviceTimestamp(record.EndTime || record.endTime);
    const clipStart = Math.max(startMs, recordStart);
    const clipEnd = Math.min(endMs, recordEnd);
    let sourceUrl;
    try {
      sourceUrl = await recordingDevice.getPlaybackUrl(record, { mediaType: "hls", protocol: "hls" });
    } catch {
      sourceUrl = await runRecordingStage(
        "RECORDING_PLAYBACK_URL_FAILED",
        () => recordingDevice.getPlaybackUrl(record)
      );
    }
    windows.push({
      sourceUrl,
      inpointSec: Math.max(0, (clipStart - recordStart) / 1000),
      outpointSec: Math.max(0, (clipEnd - recordStart) / 1000),
    });
  }
  return windows;
}

function resolveFeedAnalysisSourceUrl(options = {}) {
  const sourceUrl = String(options.sourceUrl || "");
  if (/^https?:\/\//i.test(sourceUrl)) {
    return {
      sourceUrl,
      transport: "direct-vendor-hls",
    };
  }
  if (!isRtspUrl(sourceUrl)) return sourceUrl;
  return replayHlsManager.createSession({
    sourceUrl,
    baseUrl: config.publicBaseUrl || "",
    durationSec: Number(options.durationSec) || 0,
    currentSec: 0,
    deviceSn: options.deviceSn || "",
  }).then(async (session) => {
    if (
      Number(options.durationSec) > 0 &&
      typeof replayHlsManager.finalizeForAnalysis === "function"
    ) {
      const finalized = await replayHlsManager.finalizeForAnalysis(
        session.sessionId,
        Number(options.durationSec)
      );
      return finalized.playUrl;
    }
    return session.playUrl;
  });
}

const replaySessionManager = createReplaySessionManager();
let replayHlsManager = createReplayHlsManager();
const liveRecordingSourceManager = new LiveRecordingSourceManager({
  ttlMs: config.replay.sessionTtlMs,
});
let replayNativeClientFactory = createDefaultReplayNativeClient;
const replayCleanupTimer = setInterval(() => {
  replaySessionManager.cleanupExpired().catch((error) => {
    console.warn("[replay] cleanup failed", error.message);
  });
  replayHlsManager.cleanupExpired().catch((error) => {
    console.warn("[replay-hls] cleanup failed", error.message);
  });
  liveRecordingSourceManager.cleanupExpired().catch((error) => {
    console.warn("[recording-source] cleanup failed", error.message);
  });
}, Math.min(config.replay.sessionTtlMs, 60 * 1000));
replayCleanupTimer.unref?.();

function setFeedAnalysisCoordinator(coordinator) {
  feedAnalysisCoordinator = coordinator;
  if (coordinator && typeof coordinator.setDeviceProvider === "function") {
    coordinator.setDeviceProvider({
      listDeviceSns: () => deviceRegistry.list().map((profile) => profile.sn),
      listDevices: () => deviceRegistry.list(),
      getDevice: async (sn) => {
        return ensureDeviceReady(sn);
      },
      refreshDevice: async (sn) => {
        cache.remove(getTokenCacheKey(sn));
        return ensureDeviceReady(sn);
      },
    });
  }
  if (coordinator && typeof coordinator.resolveAnalysisSourceUrl === "function") {
    coordinator.resolveAnalysisSourceUrl = async (options = {}) => resolveFeedAnalysisSourceUrl(options);
  }
  if (coordinator && typeof coordinator.setDeviceNotificationDispatcher === "function") {
    coordinator.setDeviceNotificationDispatcher(wechatDeviceNotificationCoordinator);
  }
  if (coordinator && typeof coordinator.setMotionAlarmSink === "function") {
    coordinator.setMotionAlarmSink(async (deviceSn, alarms) => {
      appDataStore.saveMotionAlarms(deviceSn, normalizeMotionAlarmList(alarms));
    });
  }
}

function setWechatDeviceNotificationCoordinatorForTests(coordinator) {
  wechatDeviceNotificationCoordinator = coordinator || defaultWechatDeviceNotificationCoordinator;
  if (feedAnalysisCoordinator && typeof feedAnalysisCoordinator.setDeviceNotificationDispatcher === "function") {
    feedAnalysisCoordinator.setDeviceNotificationDispatcher(wechatDeviceNotificationCoordinator);
  }
}

function setFoodcastService(service) {
  foodcastService = service || null;
  if (!foodcastService) return;
  foodcastService.resolveSource = async ({ job, segment }) => {
    const device = await ensureDeviceReady(job.deviceSn);
    await device.login();
    const playback = segment.playbackParams || {};
    const beginTime = segment.startTime || playback.startTime || formatDeviceDateTime(segment.startMs);
    const endTime = segment.endTime || playback.endTime || formatDeviceDateTime(segment.endMs);
    let record = {
      BeginTime: beginTime,
      EndTime: endTime,
      FileName: playback.fileName || "",
    };
    if (!record.FileName && beginTime && endTime && typeof device.queryRecordings === "function") {
      const candidates = await device.queryRecordings({
        beginTime,
        endTime,
        channel: 0,
        event: "*",
      });
      const rows = Array.isArray(candidates) ? candidates : [];
      const match = rows.find((item) => {
        const itemStart = String(item.BeginTime || item.beginTime || "");
        const itemEnd = String(item.EndTime || item.endTime || "");
        return itemStart <= endTime && itemEnd >= beginTime;
      }) || rows[0];
      if (match) record = { ...match, BeginTime: beginTime, EndTime: endTime };
    }
    const options = {
      mediaType: "hls",
      protocol: "ts",
      startTime: record.BeginTime,
      endTime: record.EndTime,
      fileName: record.FileName,
    };
    try {
      return await device.getPlaybackUrl(record, options);
    } catch (error) {
      return device.getPlaybackUrl(record);
    }
  };
}

function setFoodcastAutomationService(service) {
  foodcastAutomationService = service || null;
  foodcastAutomationRecovery = null;
}

function resolveFoodcastPreferences(openid) {
  return appDataStore.getFoodcastPreferences(openid);
}

function setCustomFoodcastService(service) {
  customFoodcastService = service || null;
}

function setLiveRecordingService(service) {
  liveRecordingService = service || null;
}

function setLiveRecordingServiceForTests(service) {
  setLiveRecordingService(service);
}

function setFeedingActivityTestServiceForTests(service) {
  feedingActivityTestService = service || defaultFeedingActivityTestService;
}

async function terminateSharedAccess(openid, deviceSn) {
  const tasks = [
    replaySessionManager.stopUserDeviceSessions?.(openid, deviceSn),
    replayHlsManager.stopUserDeviceSessions?.(openid, deviceSn),
    liveRecordingSourceManager.stopUserDeviceSessions?.(openid, deviceSn),
    liveRecordingService?.gateway?.closeUserDeviceContexts?.(openid, deviceSn),
  ].filter((task) => task && typeof task.then === "function");
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("[sharing] session cleanup failed", result.reason?.message || result.reason);
    }
  }
}

function resetDeviceStateForTests(options = {}) {
  deviceRegistry.resetForTests(options);
}

function setReplayHlsManagerForTests(manager) {
  replayHlsManager = manager || createReplayHlsManager();
}

function setReplayNativeClientFactoryForTests(factory) {
  replayNativeClientFactory = factory || createDefaultReplayNativeClient;
}

function setReplayChannelReleaseDelayForTests(delayMs, sleepImpl) {
  replayChannelReleaseDelayMs =
    delayMs === null || delayMs === undefined
      ? config.replay.channelReleaseDelayMs
      : Math.max(0, Number(delayMs) || 0);
  replayChannelReleaseSleep = typeof sleepImpl === "function" ? sleepImpl : defaultSleep;
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function notificationAuditDigest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function normalizeBowlRoi(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const numbers = [value.x, value.y, value.width, value.height].map(Number);
  if (numbers.some((item) => !Number.isFinite(item))) return undefined;
  const [x, y, width, height] = numbers.map(Math.round);
  if (x < 0 || y < 0 || width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function safeSecretEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

async function proxyPushPlusQrImage(res, sourceUrl) {
  const parsed = new URL(String(sourceUrl || ""));
  const allowedHosts = new Set(["image.pushplus.plus", "mp.weixin.qq.com"]);
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
    throw new Error("PUSHPLUS_QR_SOURCE_INVALID");
  }
  const response = await fetch(parsed, {
    headers: {
      Referer: "https://www.pushplus.plus/",
      "User-Agent": "Mozilla/5.0 cat-camera-remote",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`PUSHPLUS_QR_HTTP_${response.status}`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const bytes = Buffer.from(await response.arrayBuffer());
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(bytes);
}

function sanitizeNotificationProviderStatus(status = {}) {
  return {
    provider: cleanText(status.provider || "pushplus", 32),
    configured: !!status.configured,
    status: cleanText(status.status || (status.configured ? "idle" : "not_configured"), 32),
    lastAttemptAt: Number.isFinite(Number(status.lastAttemptAt)) ? Number(status.lastAttemptAt) : undefined,
    lastSuccessAt: Number.isFinite(Number(status.lastSuccessAt)) ? Number(status.lastSuccessAt) : undefined,
    lastError: status.lastError ? cleanText(status.lastError, 240) : undefined,
    lastMessageId: status.lastMessageId ? cleanText(status.lastMessageId, 128) : undefined,
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReplayChannelRelease(stoppedSessionCount) {
  if (!stoppedSessionCount || replayChannelReleaseDelayMs <= 0) return;
  await replayChannelReleaseSleep(replayChannelReleaseDelayMs);
}

function getActiveDeviceSn() {
  return deviceRegistry.getActiveSn() || config.device.sn;
}

function getStoredDeviceProfile(sn = getActiveDeviceSn()) {
  const stored = deviceRegistry.get(sn) || {};
  const profileSn = stored.sn || sn || config.device.sn;
  const isDefaultDevice = profileSn === config.device.sn;
  return {
    sn: profileSn,
    nickname: stored.nickname || DEFAULT_DEVICE_NICKNAME,
    username: stored.username || (isDefaultDevice ? config.device.username : "admin"),
    password: stored.password !== undefined ? stored.password : (isDefaultDevice ? config.device.password : ""),
    ip: stored.ip || (isDefaultDevice ? config.devicePri.host : ""),
    port: stored.port || "",
    adminToken: "",
  };
}

function getTokenCacheKey(sn = getActiveDeviceSn()) {
  return `token:${sn}`;
}

function createDeviceClient(profile) {
  return new JFDevice({
    endpoint: config.endpoint,
    auth: config.auth,
    sn: profile.sn,
    username: profile.username,
    password: profile.password,
    nickname: profile.nickname,
    ip: profile.ip,
    port: profile.port,
    adminToken: profile.adminToken,
  });
}

async function getDevice(sn = getActiveDeviceSn(), profileOverride = null) {
  const profile = profileOverride && String(profileOverride.sn || "") === String(sn || "")
    ? profileOverride
    : getStoredDeviceProfile(sn);
  const dev = createDeviceClient(profile);
  const cachedToken = cache.get(getTokenCacheKey(profile.sn));
  if (cachedToken) dev.deviceToken = cachedToken;
  return dev;
}

async function ensureDeviceReady(sn = getActiveDeviceSn(), profileOverride = null) {
  const dev = await getDevice(sn, profileOverride);
  if (!dev.deviceToken) {
    const token = await dev.ensureDeviceToken();
    cache.set(getTokenCacheKey(dev.sn), token, cache.TTL_TOKEN);
  }
  return dev;
}

function getLivestreamCacheKey(protocol, channel = config.channel, stream = config.stream, sn = getActiveDeviceSn()) {
  const baseKey = protocol === "webrtc" ? "webrtcUrl" : protocol === "flv" ? "flvUrl" : "hlsUrl";
  return `${baseKey}:${sn}:${channel}:${stream}`;
}

function normalizeLivestreamProtocol(body = {}) {
  const mediaType = String(body.mediaType || "").toLowerCase();
  const protocol = String(body.protocol || "").toLowerCase();
  if (protocol.includes("-")) return protocol;
  if (protocol === "webrtc" || mediaType === "webrtc") return "webrtc";
  if (protocol === "flv" || mediaType === "flv") return "flv";
  if (protocol === "hls-ts" || mediaType === "hls") return "hls-ts";
  return "hls-ts";
}

async function fetchLivestreamUrl(
  protocol,
  channel = config.channel,
  stream = config.stream,
  sn = getActiveDeviceSn(),
  options = {}
) {
  const cacheKey = getLivestreamCacheKey(protocol, channel, stream, sn);
  if (options.fresh === true) {
    cache.remove(cacheKey);
  } else {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }

  const dev = await ensureDeviceReady(sn);
  try {
    await dev.login();
  } catch (error) {
    console.warn("[routes] login failed, clear cache retry:", error.message);
    cache.clear();
    const retryDevice = await ensureDeviceReady(sn);
    await retryDevice.login();
    return getAndCacheUrl(retryDevice, protocol, cacheKey, channel, stream);
  }
  return getAndCacheUrl(dev, protocol, cacheKey, channel, stream);
}

async function getAndCacheUrl(dev, protocol, cacheKey, channel = config.channel, stream = config.stream) {
  const url = await dev.getLivestreamUrl(protocol, channel, stream);
  cache.set(cacheKey, url, cache.TTL_URL);
  return url;
}

async function releaseLivestreamUrl(protocol, channel, stream, sn) {
  const cacheKey = getLivestreamCacheKey(protocol, channel, stream, sn);
  cache.remove(cacheKey);
  const dev = await ensureDeviceReady(sn);
  try {
    await dev.closeLivestream(channel, stream);
  } finally {
    cache.remove(cacheKey);
  }
}

function createReplaySessionManager() {
  return new ReplaySessionManager({
    ttlMs: config.replay.sessionTtlMs,
    createNativeClient: ({ deviceSn, lanHost } = {}) => {
      return replayNativeClientFactory({ deviceSn, lanHost });
    },
    createRelay: () =>
      new FlvRelay({
        ffmpegPath: config.replay.ffmpegPath,
        logger: console,
      }),
  });
}

function createDefaultReplayNativeClient({ deviceSn, lanHost } = {}) {
  const profile = getStoredDeviceProfile(deviceSn || getActiveDeviceSn());
  return new JFDevicePriClient({
    host: lanHost || profile.ip || config.devicePri.host,
    httpPort: config.devicePri.httpPort,
    wsPort: config.devicePri.wsPort,
    secure: config.devicePri.secure,
    username: profile.username || config.device.username,
    password: profile.password !== undefined ? profile.password : config.device.password,
  });
}

function createReplayHlsManager() {
  return new HlsTranscodeSessionManager({
    ttlMs: config.replay.sessionTtlMs,
    ffmpegPath: config.replay.ffmpegPath,
    logger: console,
  });
}

function ensureKnownDevice(sn) {
  return !sn || deviceRegistry.has(sn) || sn === getActiveDeviceSn();
}

async function requireOwnedDevice(req, res, sn) {
  const profile = await deviceRegistry.getForOwner(sn, req.auth.openid);
  if (!profile) {
    sendApiError(res, 404, "DEVICE_NOT_FOUND");
    return null;
  }
  return profile;
}

function sanitizeNotificationDelivery(delivery = {}) {
  return {
    id: cleanText(delivery.id, 128),
    provider: cleanText(delivery.provider, 40),
    status: ["pending", "delivered", "failed"].includes(delivery.status) ? delivery.status : "pending",
    deviceSn: cleanText(delivery.deviceSn, 128),
    eventType: cleanText(delivery.eventType, 40),
    eventTime: Number(delivery.eventTime) || 0,
    providerStatus: cleanText(delivery.providerStatus, 160),
    acceptedAt: Number(delivery.acceptedAt) || 0,
    deliveredAt: Number(delivery.deliveredAt) || 0,
    failedAt: Number(delivery.failedAt) || 0,
    createdAt: Number(delivery.createdAt) || 0,
    updatedAt: Number(delivery.updatedAt) || 0,
  };
}

async function refreshNotificationDelivery(delivery) {
  if (!delivery || delivery.status !== "pending" || delivery.provider !== "wxpusher") return delivery;
  try {
    const result = await defaultWxPusherService.queryDeliveryStatus(delivery.providerMessageId);
    appDataStore.updateWechatNotificationDeliveryByProviderMessageId("wxpusher", delivery.providerMessageId, result);
  } catch (error) {
    if (!["WXPUSHER_STATUS_REJECTED", "WXPUSHER_STATUS_HTTP_404"].includes(error.code || error.message)) {
      console.warn("[notifications] wxpusher status refresh failed", {
        code: cleanText(error.code || error.message, 80),
      });
    }
  }
  return appDataStore.getWechatNotificationDelivery(delivery.id, delivery.openid) || delivery;
}

async function proxyWxPusherQrImage(res, sourceUrl) {
  const parsed = new URL(String(sourceUrl || ""));
  if (parsed.protocol !== "https:" || parsed.hostname !== "wxpusher.zjiecode.com") {
    throw new Error("WXPUSHER_QR_SOURCE_INVALID");
  }
  const response = await fetch(parsed, {
    headers: { "User-Agent": "Mozilla/5.0 bobbo-wxpusher-binding" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`WXPUSHER_QR_HTTP_${response.status}`);
  const contentType = response.headers.get("content-type") || "image/png";
  if (!contentType.startsWith("image/")) throw new Error("WXPUSHER_QR_CONTENT_INVALID");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=120");
  res.send(Buffer.from(await response.arrayBuffer()));
}

async function requireAccessibleDevice(req, res, sn) {
  const profile = await deviceRegistry.getAccessible(sn, req.auth.openid);
  if (!profile) {
    sendApiError(res, 404, "DEVICE_NOT_FOUND");
    return null;
  }
  return profile;
}

async function getOwnedActiveDevice(req, res) {
  const sn = await deviceRegistry.getActiveSnForOwner(req.auth.openid);
  if (!sn) {
    sendApiError(res, 404, "DEVICE_NOT_FOUND");
    return null;
  }
  return requireOwnedDevice(req, res, sn);
}

async function getAccessibleActiveDevice(req, res) {
  const sn = await deviceRegistry.getActiveSnForUser(req.auth.openid);
  if (!sn) {
    sendApiError(res, 404, "DEVICE_NOT_FOUND");
    return null;
  }
  return requireAccessibleDevice(req, res, sn);
}

function getRequestBaseUrl(req) {
  if (config.cloudHosting && config.publicBaseUrl) {
    return String(config.publicBaseUrl).trim().replace(/\/+$/, "");
  }
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.get("host");
  return `${proto}://${host}`;
}

function sendApiError(res, status, error, details) {
  res.status(status).json({ ok: false, error, details });
}

function sendWechatDeviceNotificationError(res, error) {
  const code = cleanText(error && (error.code || error.message), 100) || "WECHAT_DEVICE_NOTIFICATION_FAILED";
  const status = Number(error && error.statusCode) || (
    code === "DEVICE_NOT_FOUND" ? 404 :
      code === "WECHAT_DEVICE_NOT_CONFIGURED" || code === "WECHAT_MINI_NOT_CONFIGURED" ? 503 :
        /INVALID|required/i.test(code) ? 400 : 502
  );
  sendApiError(res, status, code);
}

function accountSyncOperation(req) {
  if (req.method === "POST" && req.path === "/api/devices") return "device_bind";
  if (req.method === "PUT" && /^\/api\/devices\/[^/]+\/nickname$/.test(req.path)) return "device_nickname_update";
  if (req.method === "POST" && req.path === "/api/cats/import") return "cat_import";
  if (req.method === "PUT" && /^\/api\/cats\/[^/]+$/.test(req.path)) return "cat_save";
  if (req.method === "DELETE" && /^\/api\/cats\/[^/]+$/.test(req.path)) return "cat_delete";
  return "";
}

function requireFoodcastService(res) {
  if (foodcastService) return foodcastService;
  sendApiError(res, 503, "FOODCAST_NOT_CONFIGURED");
  return null;
}

function requireCustomFoodcastService(res) {
  if (customFoodcastService) return customFoodcastService;
  sendApiError(res, 503, "CUSTOM_FOODCAST_NOT_CONFIGURED");
  return null;
}

function requireLiveRecordingService(res) {
  if (liveRecordingService?.store && liveRecordingService?.mediaStorage) {
    return liveRecordingService;
  }
  sendApiError(res, 503, "LIVE_RECORDING_NOT_CONFIGURED");
  return null;
}

function isSafeMotionAlarmImageUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host !== "localhost"
      && host !== "0.0.0.0"
      && host !== "::1"
      && !/^127\./.test(host)
      && !/^10\./.test(host)
      && !/^192\.168\./.test(host)
      && !/^169\.254\./.test(host)
      && !/^172\.(1[6-9]|2\d|3[01])\./.test(host);
  } catch (error) {
    return false;
  }
}

function registerMotionAlarmImage(sourceUrl, baseUrl) {
  if (!isSafeMotionAlarmImageUrl(sourceUrl)) return "";
  const now = Date.now();
  for (const [key, item] of motionAlarmImageSources) {
    if (!item || item.expiresAt <= now) motionAlarmImageSources.delete(key);
  }
  while (motionAlarmImageSources.size >= 500) {
    motionAlarmImageSources.delete(motionAlarmImageSources.keys().next().value);
  }
  const key = crypto.randomBytes(24).toString("hex");
  motionAlarmImageSources.set(key, {
    sourceUrl: String(sourceUrl),
    expiresAt: now + MOTION_ALARM_IMAGE_TTL_MS,
  });
  return `${String(baseUrl || "").replace(/\/+$/, "")}/api/motion-alert-images/${key}`;
}

async function proxyMotionAlarmImage(res, key) {
  const item = motionAlarmImageSources.get(String(key || ""));
  if (!item || item.expiresAt <= Date.now()) {
    motionAlarmImageSources.delete(String(key || ""));
    return sendApiError(res, 404, "MOTION_ALERT_IMAGE_EXPIRED");
  }
  const response = await fetch(item.sourceUrl, {
    headers: { "User-Agent": "Mozilla/5.0 bobbo-motion-alert" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok || !isSafeMotionAlarmImageUrl(response.url || item.sourceUrl)) {
    throw new Error(`MOTION_ALERT_IMAGE_HTTP_${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.toLowerCase().startsWith("image/")) throw new Error("MOTION_ALERT_IMAGE_CONTENT_INVALID");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MOTION_ALARM_IMAGE_MAX_BYTES) {
    throw new Error("MOTION_ALERT_IMAGE_SIZE_INVALID");
  }
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=600");
  res.send(bytes);
}

function requireReplayExportService(res) {
  if (typeof liveRecordingService?.startReplayExport === "function") {
    return liveRecordingService;
  }
  sendApiError(res, 503, "REPLAY_CLIP_EXPORT_NOT_CONFIGURED");
  return null;
}

function foodcastErrorStatus(code) {
  if (code === "INVALID_FOODCAST_REQUEST") return 400;
  if (code.startsWith("CUSTOM_") && code.endsWith("_MISMATCH")) return 404;
  if (code === "CUSTOM_MATERIAL_NOT_FOUND") return 404;
  if (code === "CUSTOM_MATERIAL_EXPIRED") return 410;
  if (code === "CUSTOM_DURATION_EXCEEDED") return 422;
  if (code.startsWith("CUSTOM_")) return 400;
  if (code === "FOODCAST_FORBIDDEN") return 403;
  if (code === "FOODCAST_NOT_FOUND" || code === "BGM_NOT_FOUND") return 404;
  if (code === "FOODCAST_EXPIRED") return 410;
  if (code === "FOODCAST_NOT_READY") return 409;
  if (code === "NO_FEEDING_SEGMENTS" || code === "NO_CUTE_HIGHLIGHTS" || code === "NO_CUTE_MATERIAL") return 422;
  if (code === "BGM_LIBRARY_EMPTY") return 503;
  return 500;
}

function sendFoodcastError(res, error) {
  const code = cleanText(error && (error.code || error.message), 80) || "FOODCAST_FAILED";
  sendApiError(res, foodcastErrorStatus(code), code);
}

function parseSingleByteRange(range, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || size <= 0) return null;
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) return null;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
  if (!endText) return { start, end: size - 1 };
  const requestedEnd = Number(endText);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function streamRangeFile(req, res, filePath, contentType, cacheControl) {
  const stat = fs.statSync(filePath);
  const range = String(req.headers.range || "");
  const baseHeaders = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
  };
  const parsedRange = range ? parseSingleByteRange(range, stat.size) : null;
  if (range && !parsedRange) {
    res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath, parsedRange || undefined);
  stream.once("error", (error) => {
    if (!res.headersSent) {
      sendFoodcastError(res, error);
      return;
    }
    if (!res.destroyed) res.destroy();
  });
  if (!parsedRange) {
    res.writeHead(200, { ...baseHeaders, "Content-Length": stat.size });
  } else {
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Range": `bytes ${parsedRange.start}-${parsedRange.end}/${stat.size}`,
      "Content-Length": parsedRange.end - parsedRange.start + 1,
    });
  }
  stream.pipe(res);
}

async function streamRemoteMedia(req, res, mediaUrl, contentType, cacheControl) {
  const range = String(req.headers.range || "");
  const response = await fetch(mediaUrl, {
    headers: range ? { Range: range } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const error = new Error("LIVE_RECORDING_MEDIA_UNAVAILABLE");
    error.code = "LIVE_RECORDING_MEDIA_UNAVAILABLE";
    throw error;
  }
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "Accept-Ranges": response.headers.get("accept-ranges") || "bytes",
  };
  for (const name of ["content-length", "content-range"]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  const stream = Readable.fromWeb(response.body);
  stream.once("error", () => {
    if (!res.destroyed) res.destroy();
  });
  stream.pipe(res);
}

function publicLiveRecording(req, job) {
  const recording = publicRecording(job);
  if (recording?.status === "ready" && recording.accessToken) {
    recording.videoUrl = `${getRequestBaseUrl(req)}/api/live-recordings/${encodeURIComponent(recording.id)}`
      + `/video?token=${encodeURIComponent(recording.accessToken)}`;
  }
  return recording;
}

function getAudioContentType(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  return "application/octet-stream";
}

function isOneAccountBindError(error) {
  return /29013|DEV_SUPPORT_TOKEN_ONLY_ONE_ACCOUNT_ADD/.test(String(error && error.message ? error.message : error));
}

function getSafeErrorDetails(error) {
  const message = String(error && error.message ? error.message : error);
  return {
    message: message
      .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"***"')
      .replace(/"adminToken"\s*:\s*"[^"]*"/gi, '"adminToken":"***"')
      .replace(/"authentication"\s*:\s*"[^"]*"/gi, '"authentication":"***"'),
  };
}

function getCachedDeviceToken(sn = getActiveDeviceSn()) {
  return cache.get(getTokenCacheKey(sn)) || "";
}

function normalizePublicStatus(status) {
  if (!status || typeof status !== "object") {
    return { status: "unknown", statusDesc: "unknown" };
  }
  const value = status.status || status.Status || "unknown";
  return {
    ...status,
    status: value,
    statusDesc: value === "online" ? "online" : value,
  };
}

function devicePermissionsForRole(role) {
  return role === "member"
    ? ["live", "talkback", "snapshot", "record", "replay", "today", "foodcast", "download"]
    : ["owner", "live", "talkback", "snapshot", "record", "replay", "today", "foodcast", "download", "share", "settings"];
}

function buildPublicDevice(status = null, sn = getActiveDeviceSn(), activeSn = getActiveDeviceSn(), access = {}) {
  const profile = getStoredDeviceProfile(sn);
  const role = access.role === "member" ? "member" : "owner";
  const token = role === "owner" ? getCachedDeviceToken(profile.sn) : "";
  const safeStatus = normalizePublicStatus(status);
  const online = safeStatus.status === "online";
  return {
    sn: profile.sn,
    nickname: profile.nickname,
    username: profile.username || "admin",
    ip: profile.ip || "",
    port: profile.port || "",
    ...(token ? { token, deviceToken: token } : {}),
    status: safeStatus,
    online,
    _online: online,
    active: profile.sn === activeSn,
    primaryCatId: cleanText(access.primaryCatId, 128),
    primaryCatRef: cleanText(access.primaryCatRef, 128) || buildCatRef(access.ownerOpenid, access.primaryCatId),
    role,
    permissions: devicePermissionsForRole(role),
    liveDiagnosticsEnabled: isLivePlaybackDiagnosticDevice(profile.sn, config.livePlaybackDiagnosticSn),
  };
}

function canonicalCatAvatarPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let pathname = raw;
  try {
    if (/^https?:\/\//i.test(raw)) pathname = new URL(raw).pathname;
  } catch {}
  const match = /^\/media\/cat-avatars\/([^/?#]+)$/i.exec(pathname);
  if (!match) return raw;
  let fileName = match[1];
  try { fileName = decodeURIComponent(fileName); } catch {}
  return `/media/cat-avatars/${encodeURIComponent(path.basename(fileName))}`;
}

function prepareCatProfileForStorage(cat = {}) {
  const next = { ...(cat || {}) };
  if (next.avatar) next.avatar = canonicalCatAvatarPath(next.avatar);
  if (next.avatarUrl) next.avatarUrl = canonicalCatAvatarPath(next.avatarUrl);
  return next;
}

function publicCatProfile(req, cat = {}) {
  const {
    ownerOpenid: ignoredOwnerOpenid,
    ...publicCat
  } = cat || {};
  for (const key of ["avatar", "avatarUrl"]) {
    const avatarPath = canonicalCatAvatarPath(publicCat[key]);
    if (avatarPath.startsWith("/media/cat-avatars/")) {
      publicCat[key] = `${getRequestBaseUrl(req)}${avatarPath}`;
    }
  }
  return publicCat;
}

function deviceDataOwner(profile, fallbackOpenid = "") {
  return String(profile && profile.ownerOpenid || fallbackOpenid || "");
}

function normalizePublicRecording(record, deviceSn = "", baseUrl = "") {
  try {
    const normalized = normalizeReplayRecord(record);
    const thumbnail = recordingThumbnailService.state(deviceSn, normalized, baseUrl);
    return {
      ...record,
      beginTime: normalized.beginTime,
      endTime: normalized.endTime,
      fileName: normalized.fileName,
      durationSec: normalized.durationSec,
      ...thumbnail,
    };
  } catch (error) {
    return record;
  }
}

function buildReplayRecordFromBody(body = {}) {
  return {
    beginTime: body.beginTime || body.startTime || body.BeginTime,
    endTime: body.endTime || body.EndTime,
    fileName: body.fileName || body.FileName,
    durationSec: body.durationSec,
  };
}

function buildPlaybackRequestForTargetSec(record, targetSec = 0) {
  const originalNormalized = normalizeReplayRecord(record);
  const currentSec = Math.max(
    0,
    Math.min(Number(targetSec) || 0, Math.max(0, originalNormalized.durationSec - 1))
  );
  if (!currentSec) {
    return {
      requestRecord: record,
      requestNormalized: originalNormalized,
      originalNormalized,
      currentSec,
    };
  }

  const shiftedBeginTime = formatDeviceLocalTime(
    new Date(parseDeviceLocalTimeForRoute(originalNormalized.beginTime).getTime() + currentSec * 1000)
  );
  const requestRecord = {
    ...record,
    beginTime: shiftedBeginTime,
    BeginTime: shiftedBeginTime,
    startTime: shiftedBeginTime,
    endTime: originalNormalized.endTime,
    EndTime: originalNormalized.endTime,
    fileName: originalNormalized.fileName,
    FileName: originalNormalized.fileName,
    durationSec: Math.max(1, originalNormalized.durationSec - currentSec),
  };
  return {
    requestRecord,
    requestNormalized: normalizeReplayRecord(requestRecord),
    originalNormalized,
    currentSec,
  };
}

function parseDeviceLocalTimeForRoute(value) {
  const text = String(value || "").replace("T", " ");
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6])
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("INVALID_DEVICE_TIME: " + value);
  return parsed;
}

function formatDeviceLocalTime(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-") + " " + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
}

async function buildOfficialPlaybackFallback(dev, body, targetSec, deviceSn = "") {
  const playbackRequest = buildPlaybackRequestForTargetSec(buildReplayRecordFromBody(body), targetSec);
  const { requestRecord, requestNormalized, originalNormalized, currentSec } = playbackRequest;
  const attempts = [
    { mediaType: "hls", protocol: "hls", transport: "official-hls" },
    { mediaType: "flv", protocol: "flv", transport: "official-flv" },
  ];
  let lastError = null;
  const videoFilter = resolveVideoFilter(body.videoFilter);
  for (const attempt of attempts) {
    try {
      const url = await dev.getPlaybackUrl(requestRecord, {
        channel: body.channel || 0,
        streamType: body.streamType || 0,
        startTime: requestNormalized.beginTime,
        endTime: requestNormalized.endTime,
        fileName: requestNormalized.fileName,
        mediaType: attempt.mediaType,
        protocol: attempt.protocol,
      });
      if (isRtspUrl(url) || videoFilter) {
        return replayHlsManager.createSession({
          sourceUrl: url,
          baseUrl: body.baseUrl || "",
          durationSec: originalNormalized.durationSec,
          currentSec,
          deviceSn,
          ownerOpenid: body.ownerOpenid,
          videoFilter,
          transport: videoFilter ? `${attempt.transport}-cute-filter` : undefined,
        });
      }
      return {
        ok: true,
        sessionId: null,
        streamUrl: url,
        playUrl: url,
        durationSec: originalNormalized.durationSec,
        currentSec,
        transport: attempt.transport,
        fallback: true,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("OFFICIAL_PLAYBACK_FALLBACK_FAILED");
}

async function getPlaybackUrlWithSdkDefaultFallback(dev, body = {}) {
  const playbackRequest = buildPlaybackRequestForTargetSec(buildReplayRecordFromBody(body), body.targetSec);
  const { requestRecord, requestNormalized, originalNormalized, currentSec } = playbackRequest;
  const baseOptions = {
    channel: body.channel || 0,
    streamType: body.streamType || 0,
    startTime: requestNormalized.beginTime,
    endTime: requestNormalized.endTime,
    fileName: requestNormalized.fileName,
  };
  const attempts = [];
  if (body.mediaType || body.protocol) {
    attempts.push({
      ...baseOptions,
      mediaType: body.mediaType,
      protocol: body.protocol,
      transport: `${body.mediaType || "default"}-${body.protocol || "default"}`,
    });
  }
  attempts.push({ ...baseOptions, transport: "official-default" });

  let lastError = null;
  for (const attempt of attempts) {
    const { transport, ...options } = attempt;
    try {
      return {
        url: await dev.getPlaybackUrl(requestRecord, options),
        transport,
        durationSec: originalNormalized.durationSec,
        currentSec,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("OFFICIAL_PLAYBACK_URL_FAILED");
}

async function normalizePlaybackForMiniProgram(playback, baseUrl, deviceSn = "", options = {}) {
  const videoFilter = String(options.videoFilter || "");
  if (!isRtspUrl(playback.url) && !videoFilter && options.forceSeekableHls !== true) {
    const manifestSource = liveRecordingSourceManager.createSource({
      playUrl: playback.url,
      ownerOpenid: options.ownerOpenid,
      deviceSn,
      relayBaseUrl: baseUrl,
      relayMode: "manifest",
      vodPlaylist: true,
      live: false,
      transport: `${playback.transport}-vod-manifest`,
      releaseSource: options.releaseSource,
    });
    const descriptor = liveRecordingSourceManager.getSessionDescriptor(manifestSource.sessionId);
    return {
      ok: true,
      manifestSessionId: manifestSource.sessionId,
      url: descriptor.playUrl,
      playUrl: descriptor.playUrl,
      streamUrl: descriptor.playUrl,
      transport: descriptor.transport,
      playbackType: "hls",
      direct: true,
      durationSec: playback.durationSec,
      currentSec: playback.currentSec,
    };
  }
  const session = await replayHlsManager.createSession({
    sourceUrl: playback.url,
    baseUrl,
    durationSec: playback.durationSec,
    currentSec: playback.currentSec,
    deviceSn,
    ownerOpenid: options.ownerOpenid,
    seekSource: options.seekSource,
    reuseKey: options.reuseKey,
    videoFilter,
    transport: videoFilter ? `${playback.transport}-cute-filter` : undefined,
  });
  return {
    ok: true,
    sessionId: session.sessionId,
    url: session.playUrl,
    playUrl: session.playUrl,
    streamUrl: session.streamUrl,
    transport: session.transport,
    playbackType: session.playbackType,
    durationSec: session.durationSec,
    currentSec: session.currentSec,
    fallback: true,
  };
}

async function waitForReplayHlsReady(result) {
  if (!result?.sessionId || typeof replayHlsManager.waitUntilReady !== "function") return result;
  try {
    const ready = await replayHlsManager.waitUntilReady(result.sessionId);
    return { ...result, ...ready };
  } catch (error) {
    try {
      await replayHlsManager.stopSession?.(result.sessionId);
    } catch (cleanupError) {
      console.warn("[replay-hls] failed startup cleanup", cleanupError.message || cleanupError);
    }
    throw error;
  }
}

async function createNativeHlsPlayback(body, deviceSn, baseUrl) {
  const profile = getStoredDeviceProfile(deviceSn);
  const lanHost = body.lanHost || body.deviceIp || profile.ip || config.devicePri.host;
  if (!lanHost) throw new Error("DEVICE_PRI_CONFIG_MISSING: host");
  const playbackRequest = buildPlaybackRequestForTargetSec(buildReplayRecordFromBody(body), body.targetSec);
  const { originalNormalized, currentSec } = playbackRequest;
  const nativeClient = replayNativeClientFactory({ deviceSn, lanHost });
  const sourceController = createNativeHlsSourceController({
    nativeClient,
    channel: body.channel || 0,
    stream: body.stream || "Main",
    beginTime: originalNormalized.beginTime,
    fileName: originalNormalized.fileName,
    targetSec: currentSec,
  });
  return replayHlsManager.createSession({
    sourceController,
    baseUrl,
    durationSec: originalNormalized.durationSec,
    currentSec,
    deviceSn,
    ownerOpenid: body.ownerOpenid,
    transport: "device-pri-hls-relay",
    videoFilter: resolveVideoFilter(body.videoFilter),
  });
}

function requireCoordinator(res) {
  if (!feedAnalysisCoordinator) {
    res.status(503).json({ ok: false, error: "FEED_ANALYSIS_UNAVAILABLE" });
    return null;
  }
  return feedAnalysisCoordinator;
}

async function getFeedAnalysisDevice(req, res) {
  const body = req.body || {};
  const query = req.query || {};
  const requestedSn = cleanText(body.deviceSn || query.deviceSn, 128);
  const sn = requestedSn || await deviceRegistry.getActiveSnForUser(req.auth.openid);
  const profile = await requireAccessibleDevice(req, res, sn);
  if (!profile) return null;
  const device = await ensureDeviceReady(sn);
  return { sn: device.sn || sn, device };
}

async function syncFeedAnalysisForRequest(coordinator, req, res, { date, force }) {
  const context = await getFeedAnalysisDevice(req, res);
  if (!context) return null;
  coordinator.store.updateSettings({ deviceSn: context.sn }, context.sn);
  if (req.body && req.body.recording) {
    const normalized = normalizeReplayRecord(req.body.recording);
    const recording = {
      ...req.body.recording,
      BeginTime: normalized.beginTime,
      EndTime: normalized.endTime,
      FileName: normalized.fileName,
      beginTime: normalized.beginTime,
      endTime: normalized.endTime,
      fileName: normalized.fileName,
      durationSec: normalized.durationSec,
    };
    const recordingKey = feedAnalysisRecordingKey(recording);
    const recordingDate = formatFeedAnalysisDateKey(normalized.beginTime || date);
    if (typeof coordinator.store.markRecordingQueued === "function") {
      coordinator.store.markRecordingQueued({
        deviceSn: context.sn,
        date: recordingDate,
        recordingKey,
        recording,
      });
    }
    if (typeof coordinator.enqueueRecording !== "function") {
      throw new Error("FEED_ANALYSIS_RECORDING_QUEUE_UNAVAILABLE");
    }
    return coordinator.enqueueRecording({
      force,
      date: recordingDate,
      device: context.device,
      deviceSn: context.sn,
      recording,
      recordingKey,
      priority: 100,
      reason: "manual-sync",
    });
  }
  if (typeof coordinator.enqueueDeviceDate === "function") {
    return coordinator.enqueueDeviceDate({
      force,
      date,
      device: context.device,
      deviceSn: context.sn,
      priority: force ? 50 : 10,
      reason: "manual-sync",
    });
  }
  return coordinator.syncNow({
    force,
    date,
    device: context.device,
    deviceSn: context.sn,
  });
}

function sanitizePublicPlaybackParams(params = null) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  return {
    startTime: sanitizePublicString(params.startTime),
    endTime: sanitizePublicString(params.endTime),
    fileName: sanitizePublicString(params.fileName),
    targetSec: sanitizePublicFiniteNumber(params.targetSec),
  };
}

function sanitizePublicString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function sanitizePublicOptionalString(value) {
  return typeof value === "string" ? value : undefined;
}

function sanitizePublicFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sanitizePublicScore(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sanitizePublicCuteReasons(value) {
  const candidates = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return [...new Set(candidates.filter((reason) => typeof reason === "string"))];
}

function sanitizePublicReplayMarker(marker = {}) {
  return {
    eventId: sanitizePublicOptionalString(marker.eventId),
    recordingKey: sanitizePublicString(marker.recordingKey),
    markerType: sanitizePublicString(marker.markerType),
    target: sanitizePublicString(marker.target),
    markerTsMs: sanitizePublicFiniteNumber(marker.markerTsMs),
    offsetSec: sanitizePublicFiniteNumber(marker.offsetSec),
    offsetMs: sanitizePublicFiniteNumber(marker.offsetMs),
    beginTime: sanitizePublicString(marker.beginTime),
    endTime: sanitizePublicString(marker.endTime),
    confidence: sanitizePublicScore(marker.confidence),
    modelConfidence: sanitizePublicScore(marker.modelConfidence),
    cuteScore: sanitizePublicScore(marker.cuteScore),
    cuteReasons: sanitizePublicCuteReasons(marker.cuteReasons),
    markerLabel: sanitizePublicOptionalString(marker.markerLabel),
    playbackParams: sanitizePublicPlaybackParams(marker.playbackParams),
  };
}

function sanitizePublicErrorMessage(message = "") {
  return String(message || "")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(password|adminToken|token|deviceToken)=\S+/gi, "$1=[redacted]")
    .replace(/"(password|adminToken|token|deviceToken)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .slice(0, 500);
}

function sanitizePublicAnalysisStatus(status = {}) {
  return {
    date: status.date || "",
    recordingKey: status.recordingKey || "",
    status: status.status || "unknown",
    failureCount: Number(status.failureCount) || 0,
    lastError: sanitizePublicErrorMessage(status.lastError),
    updatedAt: Number(status.updatedAt) || 0,
  };
}

function isCapabilityRequest(req) {
  if (/^\/api\/vendor\/alarms\/callback\/[^/]+\/[^/]+$/.test(req.path)) {
    return req.method === "POST" || req.method === "GET";
  }
  if (req.method === "POST" && req.path === "/api/internal/automation/tick") {
    return true;
  }
  if (req.method === "POST" && req.path === "/api/internal/feeding-activity-test") {
    return true;
  }
  if (req.method === "POST" && req.path === "/api/internal/foodcast-algorithm-test") {
    return true;
  }
  if (req.method === "POST" && req.path === "/api/feed-analysis/notifications/pushplus-callback") {
    return true;
  }
  if (req.method === "POST" && req.path === "/api/notifications/wxpusher-callback") {
    return true;
  }
  if (req.method !== "GET") return false;
  return (
    req.path === "/api/notifications/wxpusher-binding-qrcode" ||
    req.path === "/api/notifications/pushplus-binding-service-qrcode" ||
    req.path === "/api/notifications/pushplus-binding-friend-qrcode" ||
    /^\/api\/motion-alert-images\/[a-f0-9]{48}$/.test(req.path) ||
    /^\/api\/live-recording-sources\/[^/]+\/[^/]+$/.test(req.path) ||
    /^\/api\/replay-hls\/[^/]+\/[^/]+$/.test(req.path) ||
    /^\/api\/replay-sessions\/[^/]+\/live\.flv$/.test(req.path) ||
    /^\/api\/foodcasts\/bgm\/[^/]+\/audio$/.test(req.path) ||
    /^\/api\/foodcast-materials\/[^/]+\/video$/.test(req.path) ||
    /^\/api\/foodcasts\/[^/]+\/video$/.test(req.path) ||
    /^\/api\/live-recordings\/[^/]+\/video$/.test(req.path)
  );
}

function foodcastMaterialToken(materialId, expiresAt) {
  return crypto.createHmac("sha256", String(config.session.secret || ""))
    .update(`${String(materialId || "")}\n${Number(expiresAt) || 0}`)
    .digest("hex");
}

function publicFoodcastMaterial(req, material) {
  if (!material?.id) return material;
  const expiresAt = Math.min(
    Number(material.expiresAt) || Date.now() + 3_600_000,
    Date.now() + 24 * 60 * 60 * 1000
  );
  const token = foodcastMaterialToken(material.id, expiresAt);
  const baseMediaUrl = `${getRequestBaseUrl(req)}/api/foodcast-materials/${encodeURIComponent(material.id)}`
    + `/video?expires=${expiresAt}&token=${token}`;
  return {
    ...material,
    previewUrl: baseMediaUrl,
    coverUrl: material.hasCover ? `${baseMediaUrl}&cover=1` : "",
  };
}

function flattenVendorAlarmPayload(payload) {
  const found = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 6) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const keys = Object.keys(value);
    const looksLikeAlarm = keys.some((key) => /alarm|event|type|message/i.test(key)) &&
      keys.some((key) => /time|timestamp|created/i.test(key));
    if (looksLikeAlarm) found.push(value);
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  visit(payload);
  return found.length > 0 ? found : (payload && typeof payload === "object" ? [payload] : []);
}

function getReplaySessionMetadata(sessionId) {
  return (
    replayHlsManager.getSessionMetadata?.(sessionId) ||
    replaySessionManager.getSessionMetadata?.(sessionId) ||
    liveRecordingSourceManager.getSessionMetadata(sessionId) ||
    null
  );
}

function buildPlaybackReuseKey(deviceSn, body = {}) {
  const normalized = normalizeReplayRecord(buildReplayRecordFromBody(body));
  const raw = JSON.stringify({
    deviceSn: String(deviceSn || ""),
    beginTime: normalized.beginTime,
    endTime: normalized.endTime,
    fileName: normalized.fileName,
    targetSec: Math.max(0, Math.trunc(Number(body.targetSec) || 0)),
    videoFilter: String(body.videoFilter || ""),
  });
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function withReplayTimeout(promise, timeoutMs, errorCode) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(errorCode)), Math.max(1, Number(timeoutMs) || 1));
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function requireOwnedReplaySession(req, res) {
  const metadata = getReplaySessionMetadata(req.params.sessionId);
  if (!metadata || !metadata.ownerOpenid || metadata.ownerOpenid !== req.auth.openid) {
    sendApiError(res, 404, "REPLAY_SESSION_NOT_FOUND");
    return null;
  }
  return metadata;
}

router.use((req, res, next) => {
  const operation = accountSyncOperation(req);
  if (!operation) return next();
  const requestId = cleanRequestId(req.get("x-bobbo-request-id"));
  const source = cleanText(req.get("x-bobbo-sync-source"), 40);
  const resourceId = cleanText(
    req.body && (req.body.sn || req.body.deviceSn) || req.params && req.params.catId,
    128
  );
  req.accountSyncRequestId = requestId;
  req.accountSyncSource = source;
  res.setHeader("X-Bobbo-Request-Id", requestId);
  accountSyncAudit.record(`${operation}_received`, { requestId, resourceId, source });
  res.once("finish", () => {
    accountSyncAudit.record(`${operation}_response`, {
      requestId,
      resourceId,
      openid: req.auth && req.auth.openid,
      source,
      statusCode: res.statusCode,
      errorCode: res.statusCode >= 400 ? `HTTP_${res.statusCode}` : "",
    });
  });
  next();
});

router.use((req, res, next) => {
  if (req.path === "/api/wechat/official-account/callback") return next();
  if (req.method === "POST" && req.path === "/api/auth/wechat-login") {
    return config.cloudHosting
      ? requestAuth.requireTrustedIdentity(req, res, next)
      : next();
  }
  if (isCapabilityRequest(req)) return next();
  return requestAuth.requireSession(req, res, next);
});

function validAutomationTickSecret(value) {
  const expected = Buffer.from(String(config.automation?.tickSecret || ""));
  const received = Buffer.from(String(value || ""));
  return expected.length > 0
    && expected.length === received.length
    && crypto.timingSafeEqual(expected, received);
}

router.all("/api/vendor/alarms/callback/:token/:sn", async (req, res) => {
  if (!safeSecretEqual(req.params.token, config.vendorAlarms?.callbackToken)) {
    return sendApiError(res, 403, "VENDOR_ALARM_CALLBACK_FORBIDDEN");
  }
  if (req.method === "GET") return res.json({ ok: true });
  const deviceSn = cleanText(req.params.sn, 128);
  if (!deviceRegistry.get(deviceSn)) return sendApiError(res, 404, "DEVICE_NOT_FOUND");
  try {
    const rawAlarms = flattenVendorAlarmPayload(req.body);
    const publicAlarms = normalizeMotionAlarmList(rawAlarms);
    if (publicAlarms.length > 0) appDataStore.saveMotionAlarms(deviceSn, publicAlarms);
    const result = feedAnalysisCoordinator?.ingestOfficialAlarmCallback
      ? await feedAnalysisCoordinator.ingestOfficialAlarmCallback({ deviceSn, rawAlarms })
      : { ok: true, alarms: publicAlarms, queued: false };
    res.json({ ok: true, accepted: publicAlarms.length, queued: result?.queued === true });
  } catch (error) {
    console.warn("[motion-alerts] vendor callback failed", deviceSn, safeErrorCode(error));
    sendApiError(res, 500, "VENDOR_ALARM_CALLBACK_FAILED");
  }
});

function triggerFoodcastAutomationRecovery() {
  if (!foodcastAutomationService || typeof foodcastAutomationService.reconcile !== "function") {
    return false;
  }
  if (foodcastAutomationRecovery) return true;
  foodcastAutomationRecovery = Promise.resolve()
    .then(() => foodcastAutomationService.reconcile())
    .catch((error) => {
      console.warn("[automation-tick] foodcast reconcile failed", error.message);
    })
    .finally(() => {
      foodcastAutomationRecovery = null;
    });
  return true;
}

router.post("/api/internal/automation/tick", async (req, res) => {
  if (!validAutomationTickSecret(req.get("x-automation-tick-secret"))) {
    return sendApiError(res, 403, "AUTOMATION_TICK_FORBIDDEN");
  }
  if (!feedAnalysisCoordinator || typeof feedAnalysisCoordinator.enqueueDueScans !== "function") {
    return sendApiError(res, 503, "AUTOMATION_SCAN_UNAVAILABLE");
  }
  try {
    const scan = await feedAnalysisCoordinator.enqueueDueScans("", { waitForDiscovery: false });
    const foodcastTriggered = triggerFoodcastAutomationRecovery();
    if (!foodcastTriggered) {
      return sendApiError(res, 503, "AUTOMATION_FOODCAST_UNAVAILABLE");
    }
    const jobs = Array.isArray(scan?.jobs) ? scan.jobs : [];
    const scanQueue = typeof feedAnalysisCoordinator.getQueueStatus === "function"
      ? feedAnalysisCoordinator.getQueueStatus()
      : null;
    return res.status(202).json({
      ok: true,
      scanDevices: Number(scan?.devices) || 0,
      scanQueued: Number(scan?.queued) || 0,
      scanSkipped: jobs.filter((job) => job?.skipped).length,
      scanCoalesced: jobs.filter((job) => !job?.queued && !job?.skipped).length,
      scanQueue,
      foodcastTriggered: true,
    });
  } catch (error) {
    console.warn("[automation-tick] scan enqueue failed", error.message);
    return sendApiError(res, 503, "AUTOMATION_SCAN_FAILED");
  }
});

router.get("/api/device-status", async (req, res) => {
  try {
    const profile = await getAccessibleActiveDevice(req, res);
    if (!profile) return;
    const dev = await ensureDeviceReady(profile.sn);
    const status = await dev.status();
    res.json({ code: 0, data: status });
  } catch (error) {
    console.error("[device-status]", error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

router.get("/getWebrtcUrl", async (req, res) => {
  if (config.cloudHosting) return sendApiError(res, 404, "NOT_FOUND");
  try {
    const profile = await getAccessibleActiveDevice(req, res);
    if (!profile) return;
    const url = await fetchLivestreamUrl("webrtc", config.channel, config.stream, profile.sn);
    res.json({ code: 0, protocol: "webrtc", url });
  } catch (error) {
    console.error("[getWebrtcUrl]", error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

router.get("/getLivestreamUrl", async (req, res) => {
  if (config.cloudHosting) return sendApiError(res, 404, "NOT_FOUND");
  try {
    const protocol = req.query.protocol || "flv";
    const stream = req.query.stream || "1";
    const profile = await getAccessibleActiveDevice(req, res);
    if (!profile) return;
    const dev = await ensureDeviceReady(profile.sn);
    await dev.login();
    const url = await dev.getLivestreamUrl(protocol, config.channel, stream);
    res.json({ code: 0, protocol, stream, url });
  } catch (error) {
    console.error("[getLivestreamUrl]", error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

router.get("/getFlvUrl", async (req, res) => {
  if (config.cloudHosting) return sendApiError(res, 404, "NOT_FOUND");
  try {
    const profile = await getAccessibleActiveDevice(req, res);
    if (!profile) return;
    const url = await fetchLivestreamUrl("flv", config.channel, config.stream, profile.sn);
    res.json({ code: 0, protocol: "flv", url });
  } catch (error) {
    console.error("[getFlvUrl]", error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

router.get("/getHlsUrl", async (req, res) => {
  if (config.cloudHosting) return sendApiError(res, 404, "NOT_FOUND");
  try {
    const profile = await getAccessibleActiveDevice(req, res);
    if (!profile) return;
    const url = await fetchLivestreamUrl("hls-ts", config.channel, config.stream, profile.sn);
    res.json({ code: 0, protocol: "hls-ts", url });
  } catch (error) {
    console.error("[getHlsUrl]", error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

router.get("/api/player-auth", (req, res) => {
  if (config.cloudHosting) return sendApiError(res, 404, "NOT_FOUND");
  res.json({ code: 0, data: config.playerAuth });
});

function cleanPersistedAvatar(value) {
  const avatar = cleanText(value, 1024);
  return /^(?:https?:\/\/|cloud:\/\/)/i.test(avatar) ? avatar : "";
}

function publicAppProfile(profile = {}) {
  return { ...profile, avatar: cleanPersistedAvatar(profile.avatar) };
}

function persistedAvatarPatch(body = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, "avatar")) return {};
  const avatar = cleanPersistedAvatar(body.avatar);
  return avatar ? { avatar } : {};
}

router.post("/api/auth/wechat-login", async (req, res) => {
  const requestId = cleanRequestId(req.get("x-bobbo-request-id"));
  const source = "wechat-login";
  let openid = "";
  res.set("X-Bobbo-Request-Id", requestId);
  accountSyncAudit.record("wechat_login_received", { requestId, source });
  try {
    const identity = config.cloudHosting
      ? { openid: req.auth.openid }
      : await wechatLoginService.exchange(req.body && req.body.code);
    openid = identity.openid;
    const loginPayload = req.body || {};
    const profile = appDataStore.upsertUser(openid, {
      ...(identity.unionid ? { unionid: identity.unionid } : {}),
      ...(Object.prototype.hasOwnProperty.call(loginPayload, "nickname")
        ? { nickname: cleanText(loginPayload.nickname, 80) }
        : {}),
      ...persistedAvatarPatch(loginPayload),
    });
	const publicProfile = publicAppProfile(profile);
    const user = {
      id: openid,
      openid,
      nickname: publicProfile.nickname || "",
      avatar: publicProfile.avatar || "",
    };
    accountSyncAudit.record("wechat_login_succeeded", {
      requestId,
      openid,
      source,
      statusCode: 200,
    });
    res.json({
      ok: true,
      sessionToken: appSessions.issue(openid),
      user,
      loginAt: Date.now(),
    });
  } catch (error) {
    const code = cleanText(error && (error.code || error.message), 80) || "WECHAT_LOGIN_FAILED";
    const status =
      code === "WECHAT_LOGIN_CODE_REQUIRED" ? 400
        : code === "WECHAT_LOGIN_NOT_CONFIGURED" ? 503
          : code === "WECHAT_LOGIN_PROVIDER_ERROR" ? 401
            : 502;
    const providerCode = /^\d{3,8}$/.test(String(error && error.providerCode || ""))
      ? String(error.providerCode)
      : "";
    accountSyncAudit.record("wechat_login_failed", {
      requestId,
      openid,
      source,
      statusCode: status,
      errorCode: providerCode ? `${code}_${providerCode}` : code,
    });
    sendApiError(res, status, code);
  }
});

router.post("/api/internal/feeding-activity-test", async (req, res) => {
  const expectedToken = config.analysis.test.token;
  const providedToken = req.get("x-feed-analysis-test-token") || "";
  if (!expectedToken) return sendApiError(res, 503, "FEED_ANALYSIS_TEST_NOT_CONFIGURED");
  if (!safeSecretEqual(providedToken, expectedToken)) {
    return sendApiError(res, 401, "FEED_ANALYSIS_TEST_UNAUTHORIZED");
  }
  try {
    const result = await feedingActivityTestService.analyze({
      fileName: cleanText(req.body && req.body.fileName, 255),
      durationSec: req.body && req.body.durationSec,
      detectorBackend: cleanText(req.body && req.body.detectorBackend, 20),
      autoBowlDetection: req.body && req.body.autoBowlDetection,
    });
    return res.json({
      ok: true,
      ...result,
      artifacts: (result.artifacts || []).map((artifact) => ({
        ...artifact,
        downloadPath: `/api/internal/feeding-activity-test/${encodeURIComponent(result.jobId)}/${encodeURIComponent(artifact.name)}`,
      })),
    });
  } catch (error) {
    const code = cleanText(error.code || error.message || "FEED_ANALYSIS_TEST_FAILED", 100);
    const status = Number(error.statusCode) || 500;
    console.warn("[feeding-activity-test] failed", { code });
    return sendApiError(res, status, code);
  }
});

router.get("/api/internal/feeding-activity-test/:jobId", (req, res) => {
  const expectedToken = config.analysis.test.token;
  const providedToken = req.get("x-feed-analysis-test-token") || "";
  if (!expectedToken) return sendApiError(res, 503, "FEED_ANALYSIS_TEST_NOT_CONFIGURED");
  if (!safeSecretEqual(providedToken, expectedToken)) return sendApiError(res, 401, "FEED_ANALYSIS_TEST_UNAUTHORIZED");
  const job = feedingActivityTestService.getJob?.(cleanText(req.params.jobId, 80));
  if (!job) return sendApiError(res, 404, "FEED_ANALYSIS_TEST_JOB_NOT_FOUND");
  res.json({ ok: true, ...job, artifacts: job.artifacts.map(({ name, sizeBytes }) => ({ name, sizeBytes })) });
});

router.get("/api/internal/feeding-activity-test/:jobId/:artifactName", (req, res) => {
  const expectedToken = config.analysis.test.token;
  const providedToken = req.get("x-feed-analysis-test-token") || "";
  if (!expectedToken) return sendApiError(res, 503, "FEED_ANALYSIS_TEST_NOT_CONFIGURED");
  if (!safeSecretEqual(providedToken, expectedToken)) return sendApiError(res, 401, "FEED_ANALYSIS_TEST_UNAUTHORIZED");
  try {
    const filePath = feedingActivityTestService.resolveArtifact(cleanText(req.params.jobId, 80), cleanText(req.params.artifactName, 40));
    streamRangeFile(req, res, filePath, path.extname(filePath).toLowerCase() === ".json" ? "application/json" : "video/mp4", "private, max-age=300");
  } catch (error) {
    sendApiError(res, Number(error.statusCode) || 404, error.code || "FEED_ANALYSIS_TEST_ARTIFACT_NOT_FOUND");
  }
});

router.post("/api/internal/foodcast-algorithm-test", async (req, res) => {
  const expectedToken = config.analysis.test.token;
  const providedToken = req.get("x-feed-analysis-test-token") || "";
  if (!expectedToken) return sendApiError(res, 503, "FEED_ANALYSIS_TEST_NOT_CONFIGURED");
  if (!safeSecretEqual(providedToken, expectedToken)) return sendApiError(res, 401, "FEED_ANALYSIS_TEST_UNAUTHORIZED");
  try {
    const result = await foodcastAlgorithmTestService.analyze({
      fileName: cleanText(req.body && req.body.fileName, 255),
      durationSec: req.body && req.body.durationSec,
      detectorBackend: cleanText(req.body && req.body.detectorBackend, 20),
      bowlRoi: req.body && req.body.bowlRoi,
      cutePolicy: req.body && req.body.cutePolicy,
    });
    return res.json({
      ok: true,
      ...result,
      artifacts: result.artifacts.map((artifact) => ({
        ...artifact,
        downloadPath: `/api/internal/foodcast-algorithm-test/${encodeURIComponent(result.jobId)}/${encodeURIComponent(artifact.name)}`,
      })),
    });
  } catch (error) {
    const code = cleanText(error.code || error.message || "FOODCAST_ALGORITHM_TEST_FAILED", 100);
    return sendApiError(res, Number(error.statusCode) || 500, code);
  }
});

router.get("/api/internal/foodcast-algorithm-test/:jobId", (req, res) => {
  const expectedToken = config.analysis.test.token;
  const providedToken = req.get("x-feed-analysis-test-token") || "";
  if (!expectedToken) return sendApiError(res, 503, "FEED_ANALYSIS_TEST_NOT_CONFIGURED");
  if (!safeSecretEqual(providedToken, expectedToken)) return sendApiError(res, 401, "FEED_ANALYSIS_TEST_UNAUTHORIZED");
  const job = foodcastAlgorithmTestService.getJob?.(cleanText(req.params.jobId, 80));
  if (!job) return sendApiError(res, 404, "FOODCAST_ALGORITHM_TEST_JOB_NOT_FOUND");
  res.json({ ok: true, ...job, artifacts: job.artifacts.map(({ name, sizeBytes }) => ({ name, sizeBytes })) });
});

router.get("/api/internal/foodcast-algorithm-test/:jobId/:artifactName", (req, res) => {
  const expectedToken = config.analysis.test.token;
  const providedToken = req.get("x-feed-analysis-test-token") || "";
  if (!expectedToken) return sendApiError(res, 503, "FEED_ANALYSIS_TEST_NOT_CONFIGURED");
  if (!safeSecretEqual(providedToken, expectedToken)) return sendApiError(res, 401, "FEED_ANALYSIS_TEST_UNAUTHORIZED");
  try {
    const filePath = foodcastAlgorithmTestService.resolveArtifact(cleanText(req.params.jobId, 80), cleanText(req.params.artifactName, 80));
    streamRangeFile(req, res, filePath, path.extname(filePath).toLowerCase() === ".json" ? "application/json" : "video/mp4", "private, max-age=300");
  } catch (error) {
    sendApiError(res, Number(error.statusCode) || 404, error.code || "FOODCAST_ALGORITHM_TEST_ARTIFACT_NOT_FOUND");
  }
});

router.get("/api/profile", (req, res) => {
  const profile = appDataStore.getUser(req.auth.openid)
    || appDataStore.upsertUser(req.auth.openid);
  res.json({ ok: true, profile: publicAppProfile(profile) });
});

router.patch("/api/profile", (req, res) => {
  const profile = appDataStore.upsertUser(req.auth.openid, {
    ...(Object.prototype.hasOwnProperty.call(req.body || {}, "nickname")
      ? { nickname: cleanText(req.body.nickname, 80) }
      : {}),
    ...persistedAvatarPatch(req.body || {}),
  });
  res.json({ ok: true, profile: publicAppProfile(profile) });
});

router.get("/api/foodcasts/preferences", (req, res) => {
  res.json({ ok: true, preferences: appDataStore.getFoodcastPreferences(req.auth.openid) });
});

router.put("/api/foodcasts/preferences", (req, res) => {
  try {
    const preferences = appDataStore.saveFoodcastPreferences(req.auth.openid, req.body || {});
    res.json({ ok: true, preferences });
  } catch (error) {
    sendApiError(res, 400, cleanText(error.message, 80));
  }
});

router.post("/api/feedback", (req, res) => {
  try {
    const feedback = appDataStore.addFeedback(req.auth.openid, {
      type: req.body.type,
      content: req.body.content,
      contact: req.body.contact,
      deviceSn: req.body.deviceSn,
    });
    res.status(201).json({ ok: true, id: feedback.id });
  } catch (error) {
    sendApiError(res, 400, cleanText(error.message, 80));
  }
});

router.get("/api/device-covers", async (req, res) => {
  const sns = String(req.query.sns || "")
    .split(",")
    .map((item) => cleanText(item, 128))
    .filter(Boolean)
    .slice(0, 100);
  const coversBySn = {};
  await Promise.all(sns.map(async (sn) => {
    const access = await deviceRegistry.getAccessible(sn, req.auth.openid);
    if (!access) return;
    const ownerCovers = appDataStore.getDeviceCovers(access.ownerOpenid, [sn]);
    if (ownerCovers[sn]) {
      const cover = { ...ownerCovers[sn] };
      const mediaPath = String(cover.coverUrl || "").match(/\/media\/device-covers\/[^?#]+/);
      if (mediaPath) cover.coverUrl = `${getRequestBaseUrl(req)}${mediaPath[0]}`;
      coversBySn[sn] = cover;
    }
  }));
  res.json({ ok: true, coversBySn });
});

router.post("/api/device-covers", async (req, res) => {
  try {
    const sn = cleanText(req.body.sn, 128);
    const owner = await deviceRegistry.getForOwner(sn, req.auth.openid);
    if (!owner) return sendApiError(res, 403, "DEVICE_OWNER_REQUIRED");
    const cover = appDataStore.saveDeviceCover(req.auth.openid, {
      sn,
      fileId: req.body.fileId,
      coverUrl: req.body.coverUrl,
      capturedAt: req.body.capturedAt,
    });
    res.json({ ok: true, cover });
  } catch (error) {
    sendApiError(res, 400, cleanText(error.message, 80));
  }
});

router.get("/api/devices", async (req, res) => {
  const profiles = await deviceRegistry.listAccessible(req.auth.openid);
  const activeSn = await deviceRegistry.getActiveSnForUser(req.auth.openid);
  res.json({
    ok: true,
    devices: profiles.map((profile) => buildPublicDevice(null, profile.sn, activeSn, profile)),
  });
});

router.post("/api/devices/:sn/wechat-device-subscription-ticket", async (req, res) => {
  try {
    if (!await requireAccessibleDevice(req, res, req.params.sn)) return;
    if (typeof wechatDeviceNotificationCoordinator.getTicket !== "function") {
      return res.status(410).json({ ok: false, error: "WECHAT_DEVICE_SUBSCRIPTION_DEPRECATED" });
    }
    const ticket = await wechatDeviceNotificationCoordinator.getTicket(req.auth.openid, req.params.sn);
    res.json({ ok: true, ticket });
  } catch (error) {
    sendWechatDeviceNotificationError(res, error);
  }
});

router.get("/api/devices/:sn/wechat-device-subscription", async (req, res) => {
  try {
    if (!await requireAccessibleDevice(req, res, req.params.sn)) return;
    if (typeof wechatDeviceNotificationCoordinator.getSubscription !== "function") {
      return res.json({
        ok: true,
        subscription: { configured: false, enabled: false, deprecated: true, templates: [] },
      });
    }
    const subscription = await wechatDeviceNotificationCoordinator.getSubscription(
      req.auth.openid,
      req.params.sn
    );
    res.json({ ok: true, subscription });
  } catch (error) {
    sendWechatDeviceNotificationError(res, error);
  }
});

router.put("/api/devices/:sn/wechat-device-subscription", async (req, res) => {
  try {
    if (!await requireAccessibleDevice(req, res, req.params.sn)) return;
    if (typeof wechatDeviceNotificationCoordinator.saveSubscription !== "function") {
      return res.status(410).json({ ok: false, error: "WECHAT_DEVICE_SUBSCRIPTION_DEPRECATED" });
    }
    const subscription = await wechatDeviceNotificationCoordinator.saveSubscription(
      req.auth.openid,
      req.params.sn,
      {
        enabled: req.body && req.body.enabled !== false,
        results: req.body && req.body.results,
      }
    );
    res.json({ ok: true, subscription });
  } catch (error) {
    sendWechatDeviceNotificationError(res, error);
  }
});

router.post("/api/devices/:sn/wechat-device-subscription/test", async (req, res) => {
  try {
    if (!await requireAccessibleDevice(req, res, req.params.sn)) return;
    if (typeof wechatDeviceNotificationCoordinator.sendTest !== "function") {
      return res.status(410).json({ ok: false, error: "WECHAT_DEVICE_TEST_UNAVAILABLE" });
    }
    const eventType = cleanText(req.body && req.body.eventType, 40);
    if (!["feeding_start", "feeding_end"].includes(eventType)) {
      return res.status(400).json({ ok: false, error: "WECHAT_DEVICE_EVENT_TYPE_INVALID" });
    }
    const result = await wechatDeviceNotificationCoordinator.sendTest(
      req.auth.openid,
      req.params.sn,
      eventType
    );
    res.json(result);
  } catch (error) {
    sendWechatDeviceNotificationError(res, error);
  }
});

router.get("/api/devices/:sn/notifications", async (req, res) => {
  try {
    if (!await requireAccessibleDevice(req, res, req.params.sn)) return;
    const notifications = await wechatDeviceNotificationCoordinator.getSettings(
      req.auth.openid,
      req.params.sn
    );
    res.json({ ok: true, notifications });
  } catch (error) {
    sendWechatDeviceNotificationError(res, error);
  }
});

router.put("/api/devices/:sn/notifications", async (req, res) => {
  try {
    if (!await requireAccessibleDevice(req, res, req.params.sn)) return;
    const notifications = await wechatDeviceNotificationCoordinator.savePreference(
      req.auth.openid,
      req.params.sn,
      !!(req.body && req.body.enabled)
    );
    res.json({ ok: true, notifications });
  } catch (error) {
    sendWechatDeviceNotificationError(res, error);
  }
});

router.post("/api/devices/:sn/notifications/subscription-result", async (req, res) => {
  try {
    if (!await requireAccessibleDevice(req, res, req.params.sn)) return;
    const notifications = await wechatDeviceNotificationCoordinator.recordSubscriptionResult(
      req.auth.openid,
      req.params.sn,
      req.body && req.body.results
    );
    res.json({ ok: true, notifications });
  } catch (error) {
    sendWechatDeviceNotificationError(res, error);
  }
});

router.post("/api/devices/:sn/notifications/test", async (req, res) => {
  try {
    if (!await requireAccessibleDevice(req, res, req.params.sn)) return;
    const eventType = cleanText(req.body && req.body.eventType, 40);
    if (!["feeding_start", "feeding_end"].includes(eventType)) {
      return sendApiError(res, 400, "NOTIFICATION_EVENT_TYPE_INVALID");
    }
    if (typeof wechatDeviceNotificationCoordinator.sendTest !== "function") {
      return sendApiError(res, 503, "NOTIFICATION_TEST_UNAVAILABLE");
    }
    const result = await wechatDeviceNotificationCoordinator.sendTest(
      req.auth.openid,
      req.params.sn,
      eventType
    );
    if (!result?.delivery?.id) return sendApiError(res, 502, "NOTIFICATION_DELIVERY_NOT_RECORDED");
    res.status(202).json({ ok: true, delivery: sanitizeNotificationDelivery(result.delivery) });
  } catch (error) {
    sendWechatDeviceNotificationError(res, error);
  }
});

router.get("/api/notifications/pushplus-binding", async (req, res) => {
  try {
    const status = await defaultPushPlusBindingService.getBindingStatus(req.auth.openid);
    const pushPlusReady = !!status.bound && !!status.isFollow;
    const wxPusherBinding = pushPlusReady ? null : appDataStore.getWxPusherBinding(req.auth.openid);
    const wxPusherReady = !!(
      wxPusherBinding && wxPusherBinding.status === "active" && defaultWxPusherService.isConfigured()
    );
    const provider = pushPlusReady ? "pushplus" : wxPusherReady ? "wxpusher" : "pushplus";
    const code = cleanText(status.friendQrCode, 128);
    res.json({
      ok: true,
      binding: {
        provider,
        configured: !!status.configured || wxPusherReady,
        bound: pushPlusReady || wxPusherReady,
        isFollow: pushPlusReady || wxPusherReady,
        deliveryReady: pushPlusReady || wxPusherReady,
        status: pushPlusReady || wxPusherReady ? "active" : "not_bound",
        ...(status.expiresAt ? { expiresAt: Number(status.expiresAt) } : {}),
        serviceQrImageUrl: "/api/notifications/pushplus-binding-service-qrcode",
        ...(code ? {
          friendQrCode: code,
          friendQrImageUrl: `/api/notifications/pushplus-binding-friend-qrcode?code=${encodeURIComponent(code)}`,
        } : {}),
      },
    });
  } catch (error) {
    sendApiError(res, error.statusCode || 502, cleanText(error.code || error.message, 80));
  }
});

router.post("/api/notifications/pushplus-binding-challenge", async (req, res) => {
  try {
    const status = await defaultPushPlusBindingService.getBindingStatus(req.auth.openid);
    const code = cleanText(status.friendQrCode, 128);
    if (status.bound) return res.json({
      ok: true,
      binding: {
        configured: true,
        bound: true,
        isFollow: true,
        deliveryReady: true,
        status: "active",
      },
    });
    if (!code) return sendApiError(res, 503, "PUSHPLUS_BINDING_CHALLENGE_UNAVAILABLE");
    res.status(201).json({
      ok: true,
      binding: {
        configured: true,
        bound: false,
        deliveryReady: false,
        status: "pending",
        expiresAt: Number(status.expiresAt) || 0,
        serviceQrImageUrl: "/api/notifications/pushplus-binding-service-qrcode",
        friendQrCode: code,
        friendQrImageUrl: `/api/notifications/pushplus-binding-friend-qrcode?code=${encodeURIComponent(code)}`,
      },
    });
  } catch (error) {
    sendApiError(res, error.statusCode || 502, cleanText(error.code || error.message, 80));
  }
});

router.delete("/api/notifications/pushplus-binding", (req, res) => {
  try {
    res.json({
      ok: true,
      binding: {
        ...defaultPushPlusBindingService.removeBinding(req.auth.openid),
        deliveryReady: false,
      },
    });
  } catch (error) {
    sendApiError(res, 400, cleanText(error.code || error.message, 80));
  }
});

router.get("/api/notifications/pushplus-binding-service-qrcode", async (req, res) => {
  try {
    await proxyPushPlusQrImage(res, defaultPushPlusBindingService.getServiceQrSourceUrl());
  } catch (error) {
    sendApiError(res, 502, cleanText(error.code || error.message, 80));
  }
});

router.get("/api/notifications/pushplus-binding-friend-qrcode", async (req, res) => {
  try {
    const code = cleanText(req.query.code, 128);
    const sourceUrl = code ? defaultPushPlusBindingService.getFriendQrSourceUrl(code) : "";
    if (!sourceUrl) return sendApiError(res, 404, "PUSHPLUS_FRIEND_QR_NOT_FOUND");
    await proxyPushPlusQrImage(res, sourceUrl);
  } catch (error) {
    sendApiError(res, 502, cleanText(error.code || error.message, 80));
  }
});

router.get("/api/notifications/deliveries/:deliveryId", async (req, res) => {
  let delivery = appDataStore.getWechatNotificationDelivery(req.params.deliveryId, req.auth.openid);
  if (!delivery) return sendApiError(res, 404, "NOTIFICATION_DELIVERY_NOT_FOUND");
  delivery = await refreshNotificationDelivery(delivery);
  res.json({ ok: true, delivery: sanitizeNotificationDelivery(delivery) });
});

router.get("/api/notifications/wxpusher-binding", (req, res) => {
  try {
    res.json({
      ok: true,
      binding: defaultWxPusherBindingService.getBindingStatus(req.auth.openid),
    });
  } catch (error) {
    sendApiError(res, 400, cleanText(error.code || error.message, 80));
  }
});

router.get("/api/notifications/wxpusher-clawbot", (req, res) => {
  try {
    res.json({
      ok: true,
      clawBot: {
        configured: defaultWxPusherService.isConfigured(),
        ...appDataStore.getWxPusherClawBotStatus(req.auth.openid),
      },
    });
  } catch (error) {
    sendApiError(res, 400, cleanText(error.code || error.message, 80));
  }
});

router.post("/api/notifications/wxpusher-clawbot/confirm", async (req, res) => {
  const deliveryId = cleanText(req.body && req.body.deliveryId, 128);
  if (!deliveryId) return sendApiError(res, 400, "NOTIFICATION_DELIVERY_ID_REQUIRED");
  try {
    let delivery = appDataStore.getWechatNotificationDelivery(deliveryId, req.auth.openid);
    if (delivery) delivery = await refreshNotificationDelivery(delivery);
    const clawBot = appDataStore.confirmWxPusherClawBot(req.auth.openid, deliveryId);
    console.info("[notifications] clawbot confirmed", {
      deliveryIdHash: notificationAuditDigest(deliveryId),
      openidHash: notificationAuditDigest(req.auth.openid),
      status: cleanText(delivery && delivery.status, 24),
    });
    return res.json({ ok: true, clawBot: { configured: defaultWxPusherService.isConfigured(), ...clawBot } });
  } catch (error) {
    const code = cleanText(error.code || error.message, 80);
    console.warn("[notifications] clawbot confirmation failed", {
      deliveryIdHash: notificationAuditDigest(deliveryId),
      openidHash: notificationAuditDigest(req.auth.openid),
      code,
    });
    const conflictCodes = new Set([
      "WXPUSHER_BINDING_REQUIRED",
      "WXPUSHER_CLAWBOT_TEST_PENDING",
      "WXPUSHER_CLAWBOT_TEST_FAILED",
    ]);
    return sendApiError(res, conflictCodes.has(code) ? 409 : 400, code);
  }
});

router.post("/api/notifications/wxpusher-binding-challenge", async (req, res) => {
  try {
    const binding = await defaultWxPusherBindingService.createChallenge(req.auth.openid);
    res.status(201).json({
      ok: true,
      binding: {
        configured: true,
        bound: false,
        expiresAt: binding.expiresAt,
        followUrl: binding.followUrl,
        qrImageUrl: `/api/notifications/wxpusher-binding-qrcode?challenge=${encodeURIComponent(binding.challenge)}`,
      },
    });
  } catch (error) {
    sendApiError(res, error.statusCode || 503, cleanText(error.code || error.message, 80));
  }
});

router.delete("/api/notifications/wxpusher-binding", (req, res) => {
  try {
    res.json({
      ok: true,
      binding: defaultWxPusherBindingService.removeBinding(req.auth.openid),
    });
  } catch (error) {
    sendApiError(res, 400, cleanText(error.code || error.message, 80));
  }
});

router.get("/api/notifications/wxpusher-binding-qrcode", async (req, res) => {
  try {
    const sourceUrl = defaultWxPusherBindingService.getQrSourceUrl(req.query.challenge);
    if (!sourceUrl) return sendApiError(res, 404, "WXPUSHER_CHALLENGE_NOT_FOUND");
    await proxyWxPusherQrImage(res, sourceUrl);
  } catch (error) {
    sendApiError(res, 502, cleanText(error.code || error.message, 80));
  }
});

router.post("/api/notifications/wxpusher-callback", (req, res) => {
  if (!safeSecretEqual(req.query.key, config.wxPusher.callbackSecret)) {
    return sendApiError(res, 403, "WXPUSHER_CALLBACK_FORBIDDEN");
  }
  try {
    const result = defaultWxPusherBindingService.handleCallback(req.body || {});
    if (!result.ok) return sendApiError(res, 400, result.error || "WXPUSHER_CALLBACK_INVALID");
    return res.json({ ok: true, ignored: !!result.ignored });
  } catch (error) {
    return sendApiError(res, 400, cleanText(error.code || error.message, 80));
  }
});

router.get("/api/notifications/official-account-binding", (req, res) => {
  const user = appDataStore.getUser(req.auth.openid);
  const binding = user && user.unionid
    ? appDataStore.getOfficialBindingByUnionid(user.unionid)
    : null;
  res.json({
    ok: true,
    binding: {
      configured: !!(
        config.wechatOfficialAccount.appId &&
        config.wechatOfficialAccount.appSecret &&
        config.wechatOfficialAccount.callbackToken
      ),
      bound: !!(binding && binding.status === "active"),
      unionidAvailable: !!(user && user.unionid),
      status: binding && binding.status || "not_bound",
    },
  });
});

router.get("/api/wechat/official-account/callback", (req, res) => {
  const verification = defaultWechatOfficialAccountService.verifyCallback(req.query || {});
  if (!verification.ok) return res.status(403).type("text/plain").send("forbidden");
  const echo = cleanText(req.query && req.query.echostr, 512);
  return res.type("text/plain").send(echo);
});

router.post(
  "/api/wechat/official-account/callback",
  express.text({ type: ["text/xml", "application/xml", "application/*+xml"], limit: "64kb" }),
  async (req, res) => {
    const verification = defaultWechatOfficialAccountService.verifyCallback(req.query || {});
    if (!verification.ok) return res.status(403).type("text/plain").send("forbidden");
    try {
      const event = parseWechatEventXml(req.body);
      if (event.messageType === "event" && event.event === "subscribe" && event.fromUserName) {
        const follower = await defaultWechatOfficialAccountService.getFollower(event.fromUserName);
        if (follower.subscribed && follower.unionid) {
          appDataStore.saveOfficialBinding({
            unionid: follower.unionid,
            officialOpenid: follower.officialOpenid,
            status: "active",
          });
        }
      } else if (event.messageType === "event" && event.event === "unsubscribe") {
        appDataStore.markOfficialBindingUnsubscribed(event.fromUserName);
      }
      return res.type("text/plain").send("success");
    } catch (error) {
      console.warn("[wechat-official-callback] rejected", {
        code: cleanText(error && (error.code || error.message), 80),
      });
      return res.status(400).type("text/plain").send("invalid");
    }
  }
);

function shareTokenHash(tokenValue) {
  return crypto.createHash("sha256").update(String(tokenValue || "")).digest("hex");
}

function publicShareMember(member = {}) {
  const profile = appDataStore.getUser(member.openid) || {};
  return {
    openid: member.openid,
    nickname: profile.nickname || "家庭成员",
    avatar: profile.avatar || "",
    joinedAt: Number(member.joinedAt) || 0,
  };
}

router.post("/api/devices/:sn/share-invites", async (req, res) => {
  try {
    if (!await requireOwnedDevice(req, res, req.params.sn)) return;
    const token = crypto.randomBytes(24).toString("base64url");
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60 * 1000;
    const invite = await deviceRegistry.createShareInvite(req.params.sn, req.auth.openid, {
      id: crypto.randomUUID(),
      tokenHash: shareTokenHash(token),
      now,
      expiresAt,
    });
    accountSyncAudit.record("share_invite_created", {
      requestId: req.accountSyncRequestId,
      resourceId: req.params.sn,
      openid: req.auth.openid,
      source: "share-page",
      statusCode: 201,
    });
    res.status(201).json({
      ok: true,
      invite: {
        id: invite.id,
        deviceSn: invite.deviceSn,
        token,
        expiresAt: invite.expiresAt,
      },
    });
  } catch (error) {
    const code = cleanText(error.message, 80);
    sendApiError(res, code === "DEVICE_NOT_FOUND" ? 404 : 400, code);
  }
});

router.post("/api/devices/:sn/share-invites/:inviteId/minicode", async (req, res) => {
  try {
    if (!await requireOwnedDevice(req, res, req.params.sn)) return;
    const token = cleanText(req.body && req.body.token, 64);
    if (!token) return sendApiError(res, 400, "SHARE_INVITE_TOKEN_REQUIRED");
    const invites = await deviceRegistry.listShareInvites(req.params.sn, req.auth.openid);
    const invite = invites.find((item) => item.id === req.params.inviteId);
    if (!invite || !safeSecretEqual(invite.tokenHash, shareTokenHash(token))) {
      return sendApiError(res, 404, "SHARE_INVITE_NOT_FOUND");
    }
    if (invite.cancelledAt || invite.usedAt || invite.expiresAt <= Date.now()) {
      return sendApiError(res, 409, "SHARE_INVITE_INACTIVE");
    }
    const image = await wechatMiniCodeService.create({
      scene: token,
      page: "pages/share/accept",
      // This page is present in the trial build but is not published yet.
      checkPath: false,
      envVersion: "trial",
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(image);
  } catch (error) {
    const code = cleanText(error.code || error.message, 80) || "WECHAT_MINICODE_FAILED";
    sendApiError(res, code === "WECHAT_MINICODE_NOT_CONFIGURED" ? 503 : 502, code);
  }
});

router.post("/api/share-invites/redeem", async (req, res) => {
  let token = "";
  try {
    token = cleanText(req.body && req.body.token, 256);
    if (!token) {
      accountSyncAudit.record("share_invite_redeem_failed", {
        requestId: req.accountSyncRequestId,
        openid: req.auth.openid,
        source: "share-accept",
        statusCode: 400,
        errorCode: "SHARE_INVITE_TOKEN_REQUIRED",
      });
      return sendApiError(res, 400, "SHARE_INVITE_TOKEN_REQUIRED");
    }
    const access = await deviceRegistry.redeemShareInvite(
      shareTokenHash(token),
      req.auth.openid,
      { now: Date.now() }
    );
    accountSyncAudit.record("share_invite_redeemed", {
      requestId: req.accountSyncRequestId,
      resourceId: access.sn,
      openid: req.auth.openid,
      source: "share-accept",
      statusCode: 200,
    });
    res.json({
      ok: true,
      device: buildPublicDevice(null, access.sn, access.sn, access),
    });
  } catch (error) {
    const code = cleanText(error.message, 80);
    const conflict = [
      "SHARE_INVITE_USED",
      "SHARE_INVITE_EXPIRED",
      "SHARE_INVITE_CANCELLED",
      "SHARE_INVITE_OWNER_CANNOT_REDEEM",
      "DEVICE_MEMBER_LIMIT_REACHED",
    ].includes(code);
    const statusCode = conflict ? 409 : code === "SHARE_INVITE_NOT_FOUND" ? 404 : 400;
    accountSyncAudit.record("share_invite_redeem_failed", {
      requestId: req.accountSyncRequestId,
      resourceId: token ? shareTokenHash(token) : "",
      openid: req.auth.openid,
      source: "share-accept",
      statusCode,
      errorCode: code || "SHARE_INVITE_REDEEM_FAILED",
    });
    sendApiError(res, statusCode, code);
  }
});

router.get("/api/devices/:sn/sharing", async (req, res) => {
  try {
    if (!await requireOwnedDevice(req, res, req.params.sn)) return;
    const [members, invites] = await Promise.all([
      deviceRegistry.listMembers(req.params.sn, req.auth.openid),
      deviceRegistry.listShareInvites(req.params.sn, req.auth.openid),
    ]);
    res.json({
      ok: true,
      members: members.map(publicShareMember),
      invites: invites.map((invite) => ({
        id: invite.id,
        deviceSn: invite.deviceSn,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
      })),
      memberLimit: 5,
    });
  } catch (error) {
    sendApiError(res, 404, cleanText(error.message, 80));
  }
});

router.delete("/api/devices/:sn/share-invites/:inviteId", async (req, res) => {
  if (!await requireOwnedDevice(req, res, req.params.sn)) return;
  const invite = await deviceRegistry.cancelShareInvite(req.params.inviteId, req.auth.openid);
  if (!invite || invite.deviceSn !== req.params.sn) return sendApiError(res, 404, "SHARE_INVITE_NOT_FOUND");
  accountSyncAudit.record("share_invite_cancelled", {
    requestId: req.accountSyncRequestId,
    resourceId: req.params.sn,
    openid: req.auth.openid,
    source: "share-page",
    statusCode: 200,
  });
  res.json({ ok: true, inviteId: invite.id });
});

router.delete("/api/devices/:sn/members/:openid", async (req, res) => {
  try {
    if (!await requireOwnedDevice(req, res, req.params.sn)) return;
    const member = await deviceRegistry.revokeMember(req.params.sn, req.auth.openid, req.params.openid);
    if (!member) return sendApiError(res, 404, "SHARED_MEMBER_NOT_FOUND");
    await terminateSharedAccess(member.openid, req.params.sn);
    accountSyncAudit.record("share_member_revoked", {
      requestId: req.accountSyncRequestId,
      resourceId: req.params.sn,
      openid: req.auth.openid,
      source: "share-page",
      statusCode: 200,
    });
    res.json({ ok: true, member: publicShareMember(member) });
  } catch (error) {
    sendApiError(res, 404, cleanText(error.message, 80));
  }
});

router.delete("/api/shared-devices/:sn", async (req, res) => {
  const member = await deviceRegistry.leaveSharedDevice(req.params.sn, req.auth.openid);
  if (!member) return sendApiError(res, 404, "SHARED_DEVICE_NOT_FOUND");
  await terminateSharedAccess(req.auth.openid, req.params.sn);
  accountSyncAudit.record("share_member_left", {
    requestId: req.accountSyncRequestId,
    resourceId: req.params.sn,
    openid: req.auth.openid,
    source: "share-page",
    statusCode: 200,
  });
  res.json({ ok: true, sn: req.params.sn });
});

router.get("/api/cats", async (req, res) => {
  res.json({
    ok: true,
    cats: (await deviceRegistry.listCatsForUser(req.auth.openid)).map((cat) => publicCatProfile(req, cat)),
  });
});

const CAT_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const CAT_AVATAR_MIME_EXTENSIONS = Object.freeze({
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
});

function decodeCatAvatarPayload(body = {}) {
  const mimeType = String(body.mimeType || "image/jpeg").trim().toLowerCase();
  const extension = CAT_AVATAR_MIME_EXTENSIONS[mimeType];
  if (!extension) throw new Error("CAT_AVATAR_TYPE_UNSUPPORTED");
  const encoded = String(body.data || "").replace(/^data:[^;]+;base64,/, "");
  if (!encoded || !/^[a-z0-9+/=\r\n]+$/i.test(encoded)) {
    throw new Error("CAT_AVATAR_DATA_INVALID");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > CAT_AVATAR_MAX_BYTES) {
    throw new Error("CAT_AVATAR_TOO_LARGE");
  }
  return { bytes, extension };
}

router.post("/api/cat-avatars", async (req, res) => {
  try {
    const catId = cleanText(req.body && req.body.catId, 128);
    if (!catId) return sendApiError(res, 400, "CAT_AVATAR_CAT_ID_REQUIRED");
    const { bytes, extension } = decodeCatAvatarPayload(req.body || {});
    fs.mkdirSync(config.catAvatarDir, { recursive: true });
    const fileName = `${crypto.randomUUID()}${extension}`;
    const filePath = path.join(config.catAvatarDir, fileName);
    fs.writeFileSync(filePath, bytes, { flag: "wx" });
    const avatarUrl = `${getRequestBaseUrl(req)}/media/cat-avatars/${encodeURIComponent(fileName)}`;
    res.status(201).json({ ok: true, avatarUrl, bytes: bytes.length });
  } catch (error) {
    const code = cleanText(error.code || error.message, 80) || "CAT_AVATAR_UPLOAD_FAILED";
    sendApiError(res, code === "CAT_AVATAR_TOO_LARGE" ? 413 : 400, code);
  }
});

router.post("/api/cats/import", async (req, res) => {
  const cats = Array.isArray(req.body && req.body.cats) ? req.body.cats.slice(0, 20) : [];
  try {
    for (const cat of cats) {
      await deviceRegistry.upsertCatForOwner(req.auth.openid, prepareCatProfileForStorage(cat));
    }
    accountSyncAudit.record("cat_import_succeeded", {
      requestId: req.accountSyncRequestId,
      openid: req.auth.openid,
      source: req.accountSyncSource,
      statusCode: 200,
    });
    res.json({
      ok: true,
      cats: (await deviceRegistry.listCatsForUser(req.auth.openid)).map((cat) => publicCatProfile(req, cat)),
      requestId: req.accountSyncRequestId,
    });
  } catch (error) {
    accountSyncAudit.record("cat_import_failed", {
      requestId: req.accountSyncRequestId,
      openid: req.auth.openid,
      source: req.accountSyncSource,
      statusCode: 400,
      error,
    });
    sendApiError(res, 400, cleanText(error.message, 80), { requestId: req.accountSyncRequestId });
  }
});

router.put("/api/cats/:catId", async (req, res) => {
  try {
    const cat = await deviceRegistry.upsertCatForOwner(req.auth.openid, prepareCatProfileForStorage({
      ...req.body,
      id: req.params.catId,
    }));
    accountSyncAudit.record("cat_save_succeeded", {
      requestId: req.accountSyncRequestId,
      resourceId: req.params.catId,
      openid: req.auth.openid,
      source: req.accountSyncSource,
      statusCode: 200,
    });
    res.json({ ok: true, cat: publicCatProfile(req, cat), requestId: req.accountSyncRequestId });
  } catch (error) {
    accountSyncAudit.record("cat_save_failed", {
      requestId: req.accountSyncRequestId,
      resourceId: req.params.catId,
      openid: req.auth.openid,
      source: req.accountSyncSource,
      statusCode: 400,
      error,
    });
    sendApiError(res, 400, cleanText(error.message, 80), { requestId: req.accountSyncRequestId });
  }
});

router.delete("/api/cats/:catId", async (req, res) => {
  const cat = await deviceRegistry.deleteCatForOwner(req.auth.openid, req.params.catId);
  if (!cat) return sendApiError(res, 404, "CAT_PROFILE_NOT_FOUND");
  res.json({ ok: true, catId: cat.id });
});

router.put("/api/devices/:sn/primary-cat", async (req, res) => {
  try {
    if (!await requireOwnedDevice(req, res, req.params.sn)) return;
    const profile = await deviceRegistry.assignPrimaryCat(req.params.sn, req.auth.openid, req.body && req.body.catId);
    res.json({ ok: true, device: buildPublicDevice(null, profile.sn, profile.sn, { role: "owner" }) });
  } catch (error) {
    const code = cleanText(error.message, 80);
    sendApiError(res, code === "CAT_PROFILE_NOT_FOUND" ? 404 : 400, code);
  }
});

router.post("/api/devices", async (req, res) => {
  const requestId = req.accountSyncRequestId || cleanRequestId(req.get("x-bobbo-request-id"));
  const source = req.accountSyncSource || cleanText(req.get("x-bobbo-sync-source"), 40);
  let sn = "";
  try {
    sn = cleanText(req.body.sn || req.body.deviceSn, 128);
    if (!sn) {
      accountSyncAudit.record("device_bind_rejected", {
        requestId, openid: req.auth.openid, source, statusCode: 400, errorCode: "DEVICE_SN_REQUIRED",
      });
      return sendApiError(res, 400, "DEVICE_SN_REQUIRED", { requestId });
    }
    const existing = await deviceRegistry.getBySn(sn);
    if (existing && existing.ownerOpenid && existing.ownerOpenid !== req.auth.openid) {
      accountSyncAudit.record("device_bind_rejected", {
        requestId, resourceId: sn, openid: req.auth.openid, source, statusCode: 409, errorCode: "DEVICE_ALREADY_OWNED",
      });
      return sendApiError(res, 409, "DEVICE_ALREADY_OWNED", { requestId });
    }
    const nickname = cleanText(req.body.nickname, 80);
    const username = cleanText(req.body.username || req.body.userName, 80) || "admin";
    const password = cleanText(req.body.password || req.body.passWord || req.body.devicePassword, 256);
    const ip = cleanText(req.body.ip || req.body.devIp || req.body.ipAddress, 128);
    const port = cleanText(req.body.port || req.body.devicePort, 32);
    const adminToken = cleanText(req.body.adminToken || req.body.bindToken || req.body.token, 512);
    const profile = {
      nickname: nickname || (existing && existing.nickname) || DEFAULT_DEVICE_NICKNAME,
      username,
      password,
      ip,
      port,
      adminToken,
      sn,
    };
    const dev = createDeviceClient(profile);
    accountSyncAudit.record("device_bind_vendor_check", {
      requestId, resourceId: sn, openid: req.auth.openid, source,
    });
    const token = await dev.ensureDeviceToken();
    await deviceRegistry.upsertForOwner(profile, req.auth.openid, { active: true });
    const saved = await deviceRegistry.getForOwner(sn, req.auth.openid);
    if (!saved) throw new Error("DEVICE_ACCOUNT_SYNC_VERIFY_FAILED");
    cache.clear();
    cache.set(getTokenCacheKey(sn), token, cache.TTL_TOKEN);
    accountSyncAudit.record("device_bind_succeeded", {
      requestId, resourceId: sn, openid: req.auth.openid, source, statusCode: 200,
    });
    res.json({
      ok: true,
      device: buildPublicDevice(null, sn, sn),
      requestId,
    });
  } catch (error) {
    console.error("[devices/bind]", requestId, safeErrorCode(error));
    accountSyncAudit.record("device_bind_failed", {
      requestId, resourceId: sn, openid: req.auth.openid, source, statusCode: isOneAccountBindError(error) ? 409 : 502, error,
    });
    if (isOneAccountBindError(error)) {
      return sendApiError(res, 409, "DEVICE_ALREADY_BOUND_TO_OTHER_ACCOUNT", {
        code: 29013,
        message: "设备只允许一个账号绑定，请先在原账号解绑",
        requestId,
      });
    }
    return sendApiError(res, 502, "DEVICE_BIND_FAILED", {
      ...getSafeErrorDetails(error),
      requestId,
    });
  }
});

router.put("/api/devices/:sn/nickname", async (req, res) => {
  const requestId = req.accountSyncRequestId || cleanRequestId(req.get("x-bobbo-request-id"));
  const source = req.accountSyncSource || cleanText(req.get("x-bobbo-sync-source"), 40);
  const sn = cleanText(req.params.sn, 128);
  try {
    const profile = await deviceRegistry.renameForOwner(sn, req.auth.openid, req.body && req.body.nickname);
    if (!profile) {
      accountSyncAudit.record("device_nickname_update_failed", {
        requestId, resourceId: sn, openid: req.auth.openid, source, statusCode: 404, errorCode: "DEVICE_NOT_FOUND",
      });
      return sendApiError(res, 404, "DEVICE_NOT_FOUND", { requestId });
    }
    const activeSn = await deviceRegistry.getActiveSnForUser(req.auth.openid);
    accountSyncAudit.record("device_nickname_updated", {
      requestId, resourceId: sn, openid: req.auth.openid, source, statusCode: 200,
    });
    return res.json({
      ok: true,
      device: buildPublicDevice(null, sn, activeSn, { ...profile, role: "owner" }),
      requestId,
    });
  } catch (error) {
    const code = cleanText(error.message, 80) || "DEVICE_NICKNAME_UPDATE_FAILED";
    const statusCode = code === "DEVICE_NICKNAME_REQUIRED" || code === "DEVICE_NICKNAME_TOO_LONG" ? 400 : 500;
    accountSyncAudit.record("device_nickname_update_failed", {
      requestId, resourceId: sn, openid: req.auth.openid, source, statusCode, error,
    });
    return sendApiError(res, statusCode, code, { requestId });
  }
});

router.delete("/api/devices/:sn", async (req, res) => {
  try {
    const removed = await deviceRegistry.removeForOwner(req.params.sn, req.auth.openid);
    if (!removed) return sendApiError(res, 404, "DEVICE_NOT_FOUND");
    appDataStore.deleteDeviceCover(req.auth.openid, req.params.sn);
    cache.clear();
    res.json({ ok: true, sn: removed.sn });
  } catch (error) {
    console.error("[devices/unbind]", error.message);
    sendApiError(res, 500, "DEVICE_UNBIND_FAILED");
  }
});

router.post("/api/devices/:sn/direct-live-access", async (req, res) => {
  const requestId = cleanRequestId(req.get("x-bobbo-request-id")) || crypto.randomUUID();
  const sn = cleanText(req.params.sn, 128);
  try {
    const access = await deviceRegistry.getAccessible(sn, req.auth.openid);
    if (!access) {
      accountSyncAudit.record("direct_live_access_denied", {
        requestId,
        resourceId: sn,
        openid: req.auth.openid,
        source: "shared-live",
        statusCode: 404,
        errorCode: "DEVICE_NOT_FOUND",
      });
      return sendApiError(res, 404, "DEVICE_NOT_FOUND", { requestId });
    }
    if (!devicePermissionsForRole(access.role).includes("live")) {
      accountSyncAudit.record("direct_live_access_denied", {
        requestId,
        resourceId: sn,
        openid: req.auth.openid,
        source: "shared-live",
        statusCode: 403,
        errorCode: "DIRECT_LIVE_FORBIDDEN",
      });
      return sendApiError(res, 403, "DIRECT_LIVE_FORBIDDEN", { requestId });
    }

    const dev = await ensureDeviceReady(sn);
    const deviceToken = cleanText(dev.deviceToken || getCachedDeviceToken(sn), 1024);
    if (!deviceToken) throw new Error("DIRECT_LIVE_TOKEN_UNAVAILABLE");

    accountSyncAudit.record("direct_live_access_granted", {
      requestId,
      resourceId: sn,
      openid: req.auth.openid,
      source: "shared-live",
      statusCode: 200,
      role: access.role,
    });
    return res.json({ ok: true, deviceToken, requestId });
  } catch (error) {
    console.error("[direct-live-access]", requestId, safeErrorCode(error));
    accountSyncAudit.record("direct_live_access_failed", {
      requestId,
      resourceId: sn,
      openid: req.auth.openid,
      source: "shared-live",
      statusCode: 502,
      error,
    });
    return sendApiError(res, 502, "DIRECT_LIVE_TOKEN_UNAVAILABLE", { requestId });
  }
});

router.post("/api/devices/:sn/live-playback-events", async (req, res) => {
  const sn = cleanText(req.params.sn, 128);
  const access = await requireAccessibleDevice(req, res, sn);
  if (!access) return;
  if (!isLivePlaybackDiagnosticDevice(sn, config.livePlaybackDiagnosticSn)) {
    return res.status(204).end();
  }
  try {
    const diagnostic = normalizeLivePlaybackEvent(req.body || {});
    const role = access.role === "member" ? "member" : "owner";
    accountSyncAudit.record(`live_playback_${diagnostic.event}`, {
      requestId: diagnostic.sessionId,
      resourceId: sn,
      openid: req.auth.openid,
      source: `${role}-${diagnostic.source}`,
      statusCode: diagnostic.errorCode ? 0 : 200,
      errorCode: diagnostic.errorCode,
    });
    return res.status(204).end();
  } catch (error) {
    return sendApiError(res, 400, cleanText(error.code || error.message, 80) || "LIVE_PLAYBACK_EVENT_INVALID");
  }
});

router.get("/api/devices/:sn/token", async (req, res) => {
  try {
    const profile = await requireOwnedDevice(req, res, req.params.sn);
    if (!profile) return;
    const device = await ensureDeviceReady(req.params.sn);
    res.json({ ok: true, deviceToken: device.deviceToken });
  } catch (error) {
    console.error("[device-token/:sn]", error.message);
    if (isOneAccountBindError(error)) {
      return sendApiError(res, 409, "DEVICE_ALREADY_BOUND_TO_OTHER_ACCOUNT", {
        code: 29013,
        message: "设备已绑定到其他账户",
      });
    }
    sendApiError(res, 502, "DEVICE_TOKEN_REFRESH_FAILED", getSafeErrorDetails(error));
  }
});

router.get("/api/devices/:sn/status", async (req, res) => {
  try {
    const profile = await requireAccessibleDevice(req, res, req.params.sn);
    if (!profile) return;
    const dev = await ensureDeviceReady(req.params.sn);
    const status = await dev.status();
    res.json({
      ok: true,
      status: normalizePublicStatus(status),
      device: buildPublicDevice(
      status,
      req.params.sn,
        await deviceRegistry.getActiveSnForUser(req.auth.openid),
        profile
      ),
    });
  } catch (error) {
    console.error("[device-status/:sn]", error.message);
    sendApiError(res, 500, error.message);
  }
});

router.post("/api/devices/:sn/livestream", async (req, res) => {
  try {
    const profile = await requireAccessibleDevice(req, res, req.params.sn);
    if (!profile) return;
    const protocol = normalizeLivestreamProtocol(req.body);
    const channel = req.body.channel ?? config.channel;
    const stream = req.body.stream ?? config.stream;
    const recordingSource = req.body.recordingSource === true;
    const playbackSource = req.body.playbackSource === true;
    const sharedSource = req.body.sharedSource === true;
    const url = await fetchLivestreamUrl(protocol, channel, stream, req.params.sn, {
      // A shared live/recording session must start from the current camera
      // playlist. Reusing the general nine-hour URL cache can leave the phone
      // attached to a playlist whose upstream session has already stopped.
      fresh: sharedSource,
    });
    const videoFilter = resolveVideoFilter(req.body.videoFilter);
    if (recordingSource || playbackSource || sharedSource) {
      const session = liveRecordingSourceManager.createSource({
        playUrl: url,
        deviceSn: req.params.sn,
        ownerOpenid: req.auth.openid,
        httpProxy: getHttpsProxyUrl(),
        relayBaseUrl: getRequestBaseUrl(req),
        transport: sharedSource
          ? "official-hls-shared-source"
          : recordingSource
            ? "official-hls-recording-source"
            : "official-hls-playback-source",
        releaseSource: () => releaseLivestreamUrl(protocol, channel, stream, req.params.sn),
      });
      if (playbackSource) {
        const descriptor = liveRecordingSourceManager.getSessionDescriptor(session.sessionId);
        return res.json({
          ok: true,
          sessionId: session.sessionId,
          url: descriptor.playUrl,
          transport: sharedSource ? "official-hls-shared-stable" : descriptor.transport,
          playbackSource: true,
          sharedSource,
        });
      }
      if (sharedSource) {
        const descriptor = liveRecordingSourceManager.getSessionDescriptor(session.sessionId);
        return res.json({
          ok: true,
          sessionId: session.sessionId,
          url: descriptor.playUrl,
          transport: "official-hls-shared-stable",
          sharedSource: true,
          recordingSource: true,
        });
      }
      return res.json(session);
    }
    if (videoFilter) {
      const session = await replayHlsManager.createSession({
        sourceUrl: url,
        baseUrl: getRequestBaseUrl(req),
        deviceSn: req.params.sn,
        ownerOpenid: req.auth.openid,
        transport: "official-hls-cute-filter",
        live: true,
        videoFilter,
        releaseSource: () => releaseLivestreamUrl(protocol, channel, stream, req.params.sn),
      });
      return res.json({
        ...session,
        url: session.playUrl,
        filterPreset: req.body.videoFilter,
      });
    }
    res.json({
      ok: true,
      url,
      protocol,
      transport: `official-${protocol}`,
    });
  } catch (error) {
    console.error("[livestream/:sn]", error.message);
    sendApiError(res, 500, error.message);
  }
});

router.post("/api/devices/:sn/live-priority", async (req, res) => {
  try {
    const profile = await requireAccessibleDevice(req, res, req.params.sn);
    if (!profile) return;
    if (!devicePermissionsForRole(profile.role).includes("live")) {
      return sendApiError(res, 403, "LIVE_ACCESS_FORBIDDEN");
    }
    const requestedHoldMs = Number(req.body && req.body.holdMs);
    const holdMs = Math.min(
      10 * 60 * 1000,
      Math.max(30 * 1000, requestedHoldMs || config.replay.userPlaybackHoldMs)
    );
    const pause = feedAnalysisCoordinator?.pauseDevice?.(req.params.sn, holdMs) || null;
    const stoppedReplaySessions = Number(
      await replayHlsManager.stopDeviceSessions?.(req.params.sn)
    ) || 0;
    await waitForReplayChannelRelease(stoppedReplaySessions);
    if (stoppedReplaySessions > 0) {
      console.log("[live-priority] replay sessions preempted", {
        deviceSn: req.params.sn,
        stoppedReplaySessions,
      });
    }
    res.json({
      ok: true,
      holdMs,
      pausedUntil: Number(pause && pause.until) || 0,
      stoppedReplaySessions,
    });
  } catch (error) {
    console.error("[live-priority/:sn]", error.message);
    sendApiError(res, 500, error.message);
  }
});

router.post("/api/devices/:sn/live-snapshot", async (req, res) => {
  const protocol = "hls-ts";
  const channel = req.body.channel ?? config.channel;
  const stream = req.body.stream ?? config.stream;
  try {
    const profile = await requireAccessibleDevice(req, res, req.params.sn);
    if (!profile) return;
    const sourceUrl = await fetchLivestreamUrl(protocol, channel, stream, req.params.sn, { fresh: true });
    const jpeg = await captureLiveSnapshot({
      sourceUrl,
      ffmpegPath: config.replay.ffmpegPath,
    });
    fs.mkdirSync(config.deviceCoverDir, { recursive: true });
    const safeSn = String(req.params.sn).replace(/[^a-z0-9_-]/gi, "_");
    const finalPath = path.join(config.deviceCoverDir, `${safeSn}.jpg`);
    const tempPath = `${finalPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, jpeg);
    fs.renameSync(tempPath, finalPath);
    const capturedAt = Date.now();
    const coverUrl = `${getRequestBaseUrl(req)}/media/device-covers/${safeSn}.jpg?v=${capturedAt}`;
    appDataStore.saveDeviceCover(profile.ownerOpenid, {
      sn: req.params.sn,
      coverUrl,
      capturedAt,
    });
    res.json({
      ok: true,
      contentType: "image/jpeg",
      imageBase64: jpeg.toString("base64"),
      imageBytes: jpeg.length,
      capturedAt,
      coverUrl,
    });
  } catch (error) {
    console.error("[live-snapshot/:sn]", error.message);
    sendApiError(res, 502, "LIVE_SNAPSHOT_FAILED", getSafeErrorDetails(error));
  }
});

router.get("/api/devices/:sn/recordings", async (req, res) => {
  try {
    const profile = await requireAccessibleDevice(req, res, req.params.sn);
    if (!profile) return;
    if (!req.query.beginTime || !req.query.endTime) {
      return sendApiError(res, 400, "RECORDING_TIME_RANGE_REQUIRED");
    }
    const dev = await ensureDeviceReady(req.params.sn);
    await dev.login();
    const recordings = await dev.queryRecordings({
      beginTime: req.query.beginTime,
      endTime: req.query.endTime,
      channel: req.query.channel || 0,
      event: req.query.event || "*",
      streamType: req.query.streamType || "0x00000000",
      type: req.query.type || "h264",
    });
    const publicRecordings = recordings.map((record) => normalizePublicRecording(
      record,
      req.params.sn,
      getRequestBaseUrl(req)
    ));
    res.json({ ok: true, recordings: publicRecordings });
  } catch (error) {
    console.error("[recordings]", error.message);
    sendApiError(res, 500, error.message);
  }
});

router.post("/api/devices/:sn/playback-url", async (req, res) => {
  const startedAt = Date.now();
  const timings = {};
  const mark = (name) => { timings[name] = Date.now() - startedAt; };
  try {
    const profile = await requireAccessibleDevice(req, res, req.params.sn);
    if (!profile) return;
    mark("accessMs");
    const requestedVideoFilter = resolveVideoFilter(req.body.videoFilter);
    const forceSeekableHls = req.body.forceSeekableHls === true;
    const preferDirectHls = !forceSeekableHls && !requestedVideoFilter && (
      req.body.preferDirectHls === true
      || (req.body.mediaType === "hls" && req.body.protocol === "hls")
    );
    const reuseKey = buildPlaybackReuseKey(req.params.sn, req.body);
    const reusable = !preferDirectHls && replayHlsManager.reuseSession?.({
      deviceSn: req.params.sn,
      ownerOpenid: req.auth.openid,
      reuseKey,
    });
    if (reusable) {
      const readyReusable = await waitForReplayHlsReady(reusable);
      mark("hlsReadyMs");
      mark("reusedMs");
      console.log("[playback-url] ready", { deviceSn: req.params.sn, reused: true, timings });
      return res.json(readyReusable);
    }
    feedAnalysisCoordinator?.pauseAll?.(Math.min(config.replay.userPlaybackHoldMs, 30 * 1000));
    feedAnalysisCoordinator?.pauseDevice?.(req.params.sn, config.replay.userPlaybackHoldMs);
    recordingThumbnailService.pauseDevice?.(req.params.sn, config.replay.userPlaybackHoldMs);
    const stoppedHlsSessions = Number(await replayHlsManager.stopDeviceSessions?.(req.params.sn)) || 0;
    const stoppedManifestSessions = Number(await liveRecordingSourceManager.stopDeviceSessions?.(
      req.params.sn,
      { live: false }
    )) || 0;
    mark("preemptMs");
    const requestedLanHost = req.body.lanHost || req.body.deviceIp || "";
    if (!preferDirectHls && config.replay.nativeLanEnabled && requestedLanHost) {
      try {
        const nativeHls = await withReplayTimeout(
          createNativeHlsPlayback(
            { ...req.body, lanHost: requestedLanHost, ownerOpenid: req.auth.openid },
            req.params.sn,
            getRequestBaseUrl(req)
          ),
          800,
          "REPLAY_NATIVE_LAN_TIMEOUT"
        );
        mark("nativeReadyMs");
        return res.json(nativeHls);
      } catch (error) {
        console.warn("[playback-url] native HLS failed, trying cloud fallback", error.message);
      }
    }
    const dev = await ensureDeviceReady(req.params.sn);
    await withReplayTimeout(dev.login(), 4000, "REPLAY_DEVICE_LOGIN_TIMEOUT");
    mark("loginMs");
    if (typeof dev.closeLivestream === "function") {
      try {
        await withReplayTimeout(
          dev.closeLivestream(Number(config.channel) || 0, Number(config.analysis.playbackStreamType) || 1),
          1500,
          "REPLAY_ANALYSIS_PREEMPT_TIMEOUT"
        );
        mark("analysisPreemptMs");
      } catch (error) {
        console.warn("[playback-url] analysis stream preemption skipped", {
          deviceSn: req.params.sn,
          error: error.code || error.message || String(error),
        });
      }
    }
    const playbackBody = preferDirectHls
      ? { ...req.body, mediaType: "hls", protocol: "hls", videoFilter: "" }
      : { ...req.body, mediaType: "", protocol: "" };
    const videoFilter = resolveVideoFilter(playbackBody.videoFilter);
    const playback = await withReplayTimeout(
      getPlaybackUrlWithSdkDefaultFallback(dev, playbackBody),
      9000,
      "REPLAY_VENDOR_URL_TIMEOUT"
    );
    mark("vendorUrlMs");
    const seekSource = async (targetSec) => {
      const refreshed = await withReplayTimeout(
        getPlaybackUrlWithSdkDefaultFallback(dev, { ...playbackBody, targetSec }),
        9000,
        "REPLAY_VENDOR_URL_TIMEOUT"
      );
      if (!isRtspUrl(refreshed.url) && !videoFilter && !forceSeekableHls) {
        throw new Error("HLS_SEEK_SOURCE_UNSUPPORTED");
      }
      return {
        sourceUrl: refreshed.url,
        durationSec: refreshed.durationSec,
        currentSec: refreshed.currentSec,
      };
    };
    const releasePlaybackSource = typeof dev.closeLivestream === "function"
      ? dev.closeLivestream.bind(
          dev,
          Number(playbackBody.channel || 0),
          Number(playbackBody.streamType || 0)
        )
      : null;
    let result = await normalizePlaybackForMiniProgram(
      playback,
      getRequestBaseUrl(req),
      req.params.sn,
      {
        seekSource,
        reuseKey,
        videoFilter,
        forceSeekableHls,
        ownerOpenid: req.auth.openid,
        releaseSource: releasePlaybackSource,
      }
    );
    result = await waitForReplayHlsReady(result);
    mark("hlsReadyMs");
    mark("responseMs");
    console.log("[playback-url] ready", {
      deviceSn: req.params.sn,
      stoppedHlsSessions,
      stoppedManifestSessions,
      transport: result.transport,
      reused: result.reused === true,
      timings,
    });
    res.json(result);
  } catch (error) {
    mark("failedMs");
    console.error("[playback-url]", error.message, timings);
    const code = String(error.code || error.message || "REPLAY_PLAYBACK_FAILED");
    const status = /TIMEOUT$/.test(code) ? 504 : /^REPLAY_HLS_START_/.test(code) ? 502 : 500;
    sendApiError(res, status, code);
  }
});

router.get("/api/devices/:sn/settings-summary", async (req, res) => {
  try {
    const access = await requireAccessibleDevice(req, res, req.params.sn);
    if (!access) return;
    const dev = await ensureDeviceReady(req.params.sn);
    const status = normalizePublicStatus(await dev.status());
    if (status.status !== "online") {
      return res.json({
        ok: true,
        sn: req.params.sn,
        role: access.role === "member" ? "member" : "owner",
        status: status.status,
        summary: buildDeviceSettingsSummary(),
        stale: true,
      });
    }
    await dev.login();
    const operations = {
      storageInfo: () => dev.getInfo("StorageInfo"),
      storagePosition: () => dev.getConfig("Storage.StoragePosition"),
      record: () => dev.getConfig("Record"),
      snapshot: () => dev.getConfig("Storage.Snapshot"),
      encode: () => dev.getConfig("AVEnc.Encode"),
    };
    const rows = await Promise.all(Object.entries(operations).map(async ([key, run]) => {
      try {
        return [key, await run(), ""];
      } catch (error) {
        return [key, null, safeErrorCode(error)];
      }
    }));
    const values = Object.fromEntries(rows.map(([key, value]) => [key, value]));
    const errors = Object.fromEntries(rows.filter(([, , error]) => error).map(([key, , error]) => [key, error]));
    res.json({
      ok: true,
      sn: req.params.sn,
      role: access.role === "member" ? "member" : "owner",
      status: "online",
      summary: buildDeviceSettingsSummary(values),
      errors,
      stale: false,
      checkedAt: Date.now(),
    });
  } catch (error) {
    console.error("[device-settings-summary]", req.params.sn, safeErrorCode(error), String(error && error.message || ""));
    sendApiError(res, 502, "DEVICE_SETTINGS_SUMMARY_FAILED");
  }
});

router.post("/api/app/foreground-sync", async (req, res) => {
  const profiles = await deviceRegistry.listAccessible(req.auth.openid);
  const syncStartedAt = new Date();
  const deviceTime = formatDeviceDateTime(syncStartedAt);
  const results = await Promise.all(profiles.map(async (profile) => {
    try {
      // listAccessible() intentionally returns a sanitized access profile. Use
      // the registry-backed device credentials here so owner and shared-member
      // foreground refreshes follow the same working path as live playback.
      const dev = await ensureDeviceReady(profile.sn);
      const status = normalizePublicStatus(await dev.status());
      if (status.status !== "online") {
        return { sn: profile.sn, status: status.status, synced: false };
      }
      await dev.login();
      const clock = await syncDeviceClock(dev, syncStartedAt);
      let motionAlarmReady = false;
      let motionAlarmError = "";
      if (feedAnalysisCoordinator && typeof feedAnalysisCoordinator.bootstrapOfficialConfig === "function") {
        try {
          await feedAnalysisCoordinator.bootstrapOfficialConfig(dev, profile.sn);
          motionAlarmReady = true;
        } catch (error) {
          motionAlarmError = safeErrorCode(error);
          console.warn("[foreground-sync] motion alarm bootstrap failed", profile.sn, motionAlarmError);
        }
      }
      return {
        sn: profile.sn,
        status: "online",
        synced: clock.synced,
        deviceTime: clock.deviceTime,
        requestedTime: clock.requestedTime,
        driftMs: clock.driftMs,
        motionAlarmReady,
        ...(motionAlarmError ? { motionAlarmError } : {}),
      };
    } catch (error) {
      return { sn: profile.sn, status: "unknown", synced: false, error: safeErrorCode(error) };
    }
  }));
  res.json({ ok: true, deviceTime, results });
});

router.get("/api/devices/:sn/motion-alerts/preference", async (req, res) => {
  try {
    if (!await requireAccessibleDevice(req, res, req.params.sn)) return;
    const preference = appDataStore.getMotionAlertPreference(req.auth.openid, req.params.sn);
    res.json({ ok: true, preference });
  } catch (error) {
    sendApiError(res, 500, "MOTION_ALERT_PREFERENCE_LOAD_FAILED");
  }
});

router.get("/api/motion-alert-images/:key", async (req, res) => {
  try {
    await proxyMotionAlarmImage(res, req.params.key);
  } catch (error) {
    console.warn("[motion-alerts] image proxy failed", safeErrorCode(error));
    if (!res.headersSent) sendApiError(res, 502, "MOTION_ALERT_IMAGE_LOAD_FAILED");
  }
});

router.put("/api/devices/:sn/motion-alerts/preference", async (req, res) => {
  try {
    if (!await requireAccessibleDevice(req, res, req.params.sn)) return;
    const preference = appDataStore.saveMotionAlertPreference(
      req.auth.openid,
      req.params.sn,
      !!(req.body && req.body.enabled)
    );
    // This switch is deliberately user-scoped. The server-side feed-analysis
    // coordinator keeps the device's motion detection enabled independently.
    res.json({ ok: true, preference, deviceDetectionEnabled: true });
  } catch (error) {
    sendApiError(res, 500, "MOTION_ALERT_PREFERENCE_SAVE_FAILED");
  }
});

router.get("/api/devices/:sn/motion-alerts", async (req, res) => {
  try {
    if (!await requireAccessibleDevice(req, res, req.params.sn)) return;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? String(req.query.date)
      : new Date().toISOString().slice(0, 10);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const refreshVendor = String(req.query.refresh || "") === "1";
    let liveAlarms = [];
    let alarmRecordings = [];
    let stale = false;
    if (refreshVendor) try {
      const dev = await ensureDeviceReady(req.params.sn);
      await dev.login();
      if (feedAnalysisCoordinator && typeof feedAnalysisCoordinator.bootstrapOfficialConfig === "function") {
        await feedAnalysisCoordinator.bootstrapOfficialConfig(dev, req.params.sn);
      }
      const rawAlarms = await dev.queryAlarmMessages({
        beginTime: `${date} 00:00:00`,
        endTime: `${date} 23:59:59`,
        page: 1,
        limit,
      });
      const alarmsWithPictures = await Promise.all((rawAlarms || []).slice(0, limit).map(async (alarm) => {
        try {
          const picUrl = await dev.getAlarmPicUrl(alarm);
          return picUrl ? { ...alarm, PicUrl: picUrl } : alarm;
        } catch (error) {
          return alarm;
        }
      }));
      liveAlarms = normalizeMotionAlarmList(alarmsWithPictures);
      appDataStore.saveMotionAlarms(req.params.sn, liveAlarms);
      if (liveAlarms.some((alarm) => !alarm.imageUrl)) {
        try {
          alarmRecordings = await dev.queryRecordings({
            beginTime: `${date} 00:00:00`,
            endTime: `${date} 23:59:59`,
            channel: 0,
            event: "*",
            streamType: "0x00000000",
            type: "h264",
          });
        } catch (error) {
          console.warn("[motion-alerts] recording fallback unavailable", req.params.sn, safeErrorCode(error));
        }
      }
    } catch (error) {
      stale = true;
      console.warn("[motion-alerts] live query unavailable; using stored history", req.params.sn, safeErrorCode(error));
    }
    const storedAlarms = appDataStore.listMotionAlarms(req.params.sn, { date, limit });
    if (refreshVendor && alarmRecordings.length === 0 && storedAlarms.some((alarm) => !alarm.imageUrl)) {
      try {
        const replayDevice = await ensureDeviceReady(req.params.sn);
        await replayDevice.login();
        alarmRecordings = await replayDevice.queryRecordings({
          beginTime: `${date} 00:00:00`,
          endTime: `${date} 23:59:59`,
          channel: 0,
          event: "*",
          streamType: "0x00000000",
          type: "h264",
        });
      } catch (error) {
        console.warn("[motion-alerts] stored recording fallback unavailable", req.params.sn, safeErrorCode(error));
      }
    }
    const byId = new Map([...storedAlarms, ...liveAlarms].map((alarm) => [alarm.id, alarm]));
    const baseUrl = getRequestBaseUrl(req);
    const fallbackQueue = new Map();
    const alarms = [...byId.values()]
      .sort((a, b) => b.occurredAtMs - a.occurredAtMs)
      .slice(0, limit)
      .map((alarm) => {
        const proxiedImageUrl = registerMotionAlarmImage(alarm.imageUrl, baseUrl);
        if (proxiedImageUrl) return { ...alarm, imageUrl: proxiedImageUrl, imageState: "ready" };
        const recording = matchMotionAlarmRecording(alarm, alarmRecordings);
        if (!recording) return { ...alarm, imageUrl: "", imageState: "unavailable" };
        const thumbnail = recordingThumbnailService.state(req.params.sn, recording, baseUrl);
        if (thumbnail.thumbnailState !== "ready" && fallbackQueue.size < 12) {
          fallbackQueue.set(thumbnail.recordingKey, recording);
        }
        return {
          ...alarm,
          imageUrl: thumbnail.thumbnailUrl || "",
          imageState: thumbnail.thumbnailState,
        };
      });
    for (const recording of fallbackQueue.values()) {
      recordingThumbnailService.enqueue(req.params.sn, recording).catch(() => {});
    }
    const revision = crypto.createHash("sha1")
      .update(JSON.stringify(alarms.map((alarm) => [alarm.id, alarm.occurredAtMs, alarm.imageState, alarm.imageUrl])))
      .digest("hex");
    const unchanged = !!req.query.since && String(req.query.since) === revision;
    res.json({
      ok: true,
      date,
      revision,
      unchanged,
      alarms: unchanged ? [] : alarms,
      stale,
      preference: appDataStore.getMotionAlertPreference(req.auth.openid, req.params.sn),
      deviceDetectionEnabled: true,
    });
  } catch (error) {
    console.error("[motion-alerts]", req.params.sn, safeErrorCode(error));
    sendApiError(res, 502, "MOTION_ALERT_HISTORY_LOAD_FAILED");
  }
});

router.post("/api/devices/:sn/replay-clips", async (req, res) => {
  const service = requireReplayExportService(res);
  if (!service) return;
  try {
    const profile = await requireAccessibleDevice(req, res, req.params.sn);
    if (!profile) return;
    const recordingStartMs = parseDeviceTimestamp(req.body.startTime || req.body.beginTime);
    const recordingEndMs = parseDeviceTimestamp(req.body.endTime);
    const startOffsetSec = Math.max(0, Number(req.body.startOffsetSec) || 0);
    const endOffsetSec = Math.max(0, Number(req.body.endOffsetSec) || 0);
    if (!Number.isFinite(recordingStartMs) || endOffsetSec <= startOffsetSec) {
      return sendApiError(res, 400, "RECORDING_WINDOW_INVALID");
    }
    const startedAt = recordingStartMs + startOffsetSec * 1000;
    const requestedEndedAt = recordingStartMs + endOffsetSec * 1000;
    const endedAt = Number.isFinite(recordingEndMs) ? Math.min(requestedEndedAt, recordingEndMs) : requestedEndedAt;
    if (endedAt <= startedAt || endedAt - startedAt > 300_000) {
      return sendApiError(res, 400, endedAt - startedAt > 300_000 ? "RECORDING_DURATION_EXCEEDED" : "RECORDING_WINDOW_INVALID");
    }
    const job = await service.startReplayExport({
      ownerOpenid: profile.ownerOpenid || req.auth.openid,
      actorOpenid: req.auth.openid,
      deviceSn: req.params.sn,
      device: profile,
      startedAt,
      endedAt,
    });
    res.status(202).json({ ok: true, recording: publicLiveRecording(req, job) });
  } catch (error) {
    const code = String(error.code || error.message || "REPLAY_CLIP_EXPORT_FAILED");
    const status = /INVALID|EXCEEDED/.test(code) ? 400 : code === "RECORDING_ALREADY_ACTIVE" ? 409 : 502;
    sendApiError(res, status, code);
  }
});

router.post("/api/devices/:sn/replay-sessions", async (req, res) => {
  try {
    const profile = await requireAccessibleDevice(req, res, req.params.sn);
    if (!profile) return;
    const lanHost = req.body.lanHost || req.body.deviceIp || "";
    if (!lanHost && !getStoredDeviceProfile(req.params.sn).ip && !config.devicePri.host) {
      return sendApiError(res, 503, "DEVICE_PRI_CONFIG_MISSING");
    }
    const videoFilter = resolveVideoFilter(req.body.videoFilter);
    const result = videoFilter
      ? await createNativeHlsPlayback(
          { ...req.body, lanHost, ownerOpenid: req.auth.openid },
          req.params.sn,
          getRequestBaseUrl(req)
        )
      : await replaySessionManager.createSession({
          baseUrl: getRequestBaseUrl(req),
          deviceSn: req.params.sn,
          ownerOpenid: req.auth.openid,
          channel: req.body.channel || 0,
          stream: req.body.stream || "Main",
          record: buildReplayRecordFromBody(req.body),
          lanHost,
          targetSec: req.body.targetSec || 0,
        });
    res.json(await waitForReplayHlsReady(result));
  } catch (error) {
    console.warn("[replay-sessions] native relay failed, trying official playback fallback", error.message);
    try {
      const dev = await ensureDeviceReady(req.params.sn);
      await dev.login();
      const fallback = await buildOfficialPlaybackFallback(
        dev,
        { ...req.body, baseUrl: getRequestBaseUrl(req), ownerOpenid: req.auth.openid },
        req.body.targetSec || 0,
        req.params.sn
      );
      res.json(await waitForReplayHlsReady(fallback));
    } catch (fallbackError) {
      console.error("[replay-sessions]", fallbackError.message);
      sendApiError(res, 500, fallbackError.message, { nativeError: error.message });
    }
  }
});

router.get("/api/replay-hls/:sessionId/:fileName", async (req, res) => {
  try {
    await replayHlsManager.attachHttpResponse(req.params.sessionId, req.params.fileName, res, req);
  } catch (error) {
    sendApiError(res, 500, error.message);
  }
});

router.post("/api/devices/:sn/recording-thumbnails", async (req, res) => {
  try {
    const profile = await requireAccessibleDevice(req, res, req.params.sn);
    if (!profile) return;
    const records = (Array.isArray(req.body.recordings) ? req.body.recordings : []).slice(0, 6);
    const queued = records.map((record) => recordingThumbnailService.state(
      req.params.sn,
      record,
      getRequestBaseUrl(req)
    ));
    for (const record of records) {
      recordingThumbnailService.enqueue(req.params.sn, record).catch(() => {});
    }
    res.status(202).json({ ok: true, queued });
  } catch (error) {
    sendApiError(res, 400, cleanText(error.message, 80));
  }
});

router.get("/api/live-recording-sources/:sessionId/:fileName", async (req, res) => {
  try {
    await liveRecordingSourceManager.attachHttpResponse(
      req.params.sessionId,
      req.params.fileName,
      req,
      res
    );
  } catch (error) {
    sendApiError(
      res,
      error.message === "RECORDING_SOURCE_NOT_FOUND" ? 404 : 502,
      error.message
    );
  }
});

router.get("/api/replay-sessions/:sessionId/live.flv", (req, res) => {
  try {
    replaySessionManager.attachHttpResponse(req.params.sessionId, req, res);
  } catch (error) {
    sendApiError(res, error.message === "REPLAY_SESSION_NOT_FOUND" ? 404 : 500, error.message);
  }
});

router.get("/api/replay-sessions/:sessionId/status", (req, res) => {
  try {
    if (!requireOwnedReplaySession(req, res)) return;
    const status = replayHlsManager.getSessionStatus?.(req.params.sessionId);
    if (!status) return sendApiError(res, 404, "REPLAY_SESSION_NOT_FOUND");
    res.json(status);
  } catch (error) {
    sendApiError(res, error.message === "REPLAY_SESSION_NOT_FOUND" ? 404 : 500, error.message);
  }
});

router.post("/api/replay-sessions/:sessionId/seek", async (req, res) => {
  try {
    if (!requireOwnedReplaySession(req, res)) return;
    if (replayHlsManager.hasSession?.(req.params.sessionId)) {
      return res.json(await replayHlsManager.seekSession(req.params.sessionId, req.body.targetSec));
    }
    res.json(await replaySessionManager.seekSession(req.params.sessionId, req.body.targetSec));
  } catch (error) {
    sendApiError(res, error.message === "REPLAY_SESSION_NOT_FOUND" ? 404 : 500, error.message);
  }
});

router.post("/api/replay-sessions/:sessionId/pause", async (req, res) => {
  try {
    if (!requireOwnedReplaySession(req, res)) return;
    res.json(await replaySessionManager.pauseSession(req.params.sessionId));
  } catch (error) {
    sendApiError(res, error.message === "REPLAY_SESSION_NOT_FOUND" ? 404 : 500, error.message);
  }
});

router.post("/api/replay-sessions/:sessionId/resume", async (req, res) => {
  try {
    if (!requireOwnedReplaySession(req, res)) return;
    res.json(await replaySessionManager.resumeSession(req.params.sessionId));
  } catch (error) {
    sendApiError(res, error.message === "REPLAY_SESSION_NOT_FOUND" ? 404 : 500, error.message);
  }
});

router.delete("/api/replay-sessions/:sessionId", async (req, res) => {
  try {
    if (!requireOwnedReplaySession(req, res)) return;
    const stoppedNative = await replaySessionManager.stopSession(req.params.sessionId);
    const stoppedHls = await replayHlsManager.stopSession(req.params.sessionId);
    const stoppedRecordingSource = await liveRecordingSourceManager.stopSession(req.params.sessionId);
    const stopped = stoppedNative || stoppedHls || stoppedRecordingSource;
    res.json({ ok: true, stopped });
  } catch (error) {
    sendApiError(res, 500, error.message);
  }
});

router.get("/api/devices/:sn/time", async (req, res) => {
  try {
    const profile = await requireAccessibleDevice(req, res, req.params.sn);
    if (!profile) return;
    const dev = await ensureDeviceReady(req.params.sn);
    await dev.login();
    const result = await readDeviceClock(dev);
    res.json({ ok: true, deviceTime: result.deviceTime, data: result.data });
  } catch (error) {
    console.error("[device-time]", error.message);
    sendApiError(res, 500, error.message);
  }
});

router.post("/api/devices/:sn/time-sync", async (req, res) => {
  try {
    const profile = await requireOwnedDevice(req, res, req.params.sn);
    if (!profile) return;
    const deviceTime = cleanText(req.body.deviceTime, 64);
    if (!deviceTime) {
      return sendApiError(res, 400, "DEVICE_TIME_REQUIRED");
    }
    const mode = String(req.body.mode || "local").toLowerCase();
    const key = mode === "utc" ? "OPUTCTimeSetting" : "OPTimeSetting";
    const dev = await ensureDeviceReady(req.params.sn);
    await dev.login();
    if (mode === "local") {
      const parsed = new Date(deviceTime.replace(" ", "T") + "+08:00");
      if (Number.isNaN(parsed.getTime())) return sendApiError(res, 400, "DEVICE_TIME_INVALID");
      const result = await syncDeviceClock(dev, parsed);
      return res.json({ ok: true, mode, ...result });
    }
    const data = await dev.opdev({ Name: key, [key]: deviceTime });
    const readback = await readDeviceClock(dev);
    res.json({ ok: true, deviceTime: readback.deviceTime, requestedTime: deviceTime, mode, data, readback: readback.data });
  } catch (error) {
    console.error("[device-time-sync]", error.message);
    sendApiError(res, 500, error.message);
  }
});

router.post("/api/foodcasts", async (req, res) => {
  const service = requireFoodcastService(res);
  if (!service) return;
  try {
    const deviceSn = cleanText(req.body.deviceSn, 128);
    if (!await requireOwnedDevice(req, res, deviceSn)) return;
    const job = await service.createFoodcast({
      deviceSn,
      date: cleanText(req.body.date, 20),
      scope: req.body.scope === "meal" ? "meal" : "day",
      mealId: cleanText(req.body.mealId, 240),
      mode: req.body.mode === "quick_cut" ? "quick_cut" : "natural",
      frameMode: req.body.frameMode === "center_crop" ? "center_crop" : "source",
      targetDurationSec: req.body.targetDurationSec,
      bgmId: req.body.bgmId,
    });
    res.status(202).json({ ok: true, job: service.getPublicJob(job.id, getRequestBaseUrl(req)) });
  } catch (error) {
    sendFoodcastError(res, error);
  }
});

router.get("/api/foodcasts/latest", async (req, res) => {
  const service = requireFoodcastService(res);
  if (!service) return;
  try {
    const deviceSn = cleanText(req.query.deviceSn, 128);
    if (!await requireAccessibleDevice(req, res, deviceSn)) return;
    const job = service.getLatest({
      deviceSn,
      date: cleanText(req.query.date, 20),
      scope: req.query.scope === "meal" ? "meal" : "day",
      mealId: cleanText(req.query.mealId, 240),
      mode: req.query.mode === "quick_cut" ? "quick_cut" : "natural",
      frameMode: req.query.frameMode === "center_crop" ? "center_crop" : "source",
      targetDurationSec: req.query.targetDurationSec,
      bgmId: req.query.bgmId,
    });
    res.json({ ok: true, job: job ? service.getPublicJob(job.id, getRequestBaseUrl(req)) : null });
  } catch (error) {
    sendFoodcastError(res, error);
  }
});

router.get("/api/foodcasts/bgm", (req, res) => {
  const service = requireFoodcastService(res);
  if (!service) return;
  try {
    res.json({ ok: true, tracks: service.listBgmTracks(getRequestBaseUrl(req)) });
  } catch (error) {
    sendFoodcastError(res, error);
  }
});

router.get("/api/foodcasts/bgm/:trackId/audio", (req, res) => {
  const service = requireFoodcastService(res);
  if (!service) return;
  try {
    const filePath = service.resolveBgmPreview(cleanText(req.params.trackId, 160));
    streamRangeFile(req, res, filePath, getAudioContentType(filePath), "public, max-age=3600");
  } catch (error) {
    sendFoodcastError(res, error);
  }
});

router.get("/api/foodcasts/stats", async (req, res) => {
  try {
    const profiles = await deviceRegistry.listAccessible(req.auth.openid);
    if (profiles.length === 0) {
      return res.json({ ok: true, stats: { availableCount: 0 } });
    }
    const service = requireCustomFoodcastService(res);
    if (!service) return;
    const counts = await Promise.all(profiles.map((profile) => service.countAvailableFoodcasts({
      ownerOpenid: deviceDataOwner(profile, req.auth.openid),
      deviceSn: profile.sn,
    })));
    const availableCount = counts.reduce((total, count) => total + Math.max(0, Number(count) || 0), 0);
    res.json({ ok: true, stats: { availableCount } });
  } catch (error) {
    sendFoodcastError(res, error);
  }
});

router.get("/api/foodcasts/daily", async (req, res) => {
  const service = requireCustomFoodcastService(res);
  if (!service) return;
  try {
    const deviceSn = cleanText(req.query.deviceSn, 128)
      || await deviceRegistry.getActiveSnForUser(req.auth.openid);
    const access = await requireAccessibleDevice(req, res, deviceSn);
    if (!access) return;
    const daily = await service.getLatestDaily({
      ownerOpenid: deviceDataOwner(access, req.auth.openid),
      deviceSn,
      date: cleanText(req.query.date, 20),
    });
    res.json({ ok: true, daily: publicFoodcastMaterial(req, daily) });
  } catch (error) {
    sendFoodcastError(res, error);
  }
});

router.get("/api/foodcasts/materials", async (req, res) => {
  const service = requireCustomFoodcastService(res);
  if (!service) return;
  try {
    const deviceSn = cleanText(req.query.deviceSn, 128)
      || await deviceRegistry.getActiveSnForUser(req.auth.openid);
    const access = await requireAccessibleDevice(req, res, deviceSn);
    if (!access) return;
    const sinceValue = Number(req.query.since);
    const materials = await service.listMaterials({
      ownerOpenid: deviceDataOwner(access, req.auth.openid),
      deviceSn,
      date: cleanText(req.query.date, 20),
      sinceMs: Number.isFinite(sinceValue) && sinceValue > 0 ? sinceValue : 0,
    });
    res.json({ ok: true, materials: materials.map((material) => publicFoodcastMaterial(req, material)) });
  } catch (error) {
    sendFoodcastError(res, error);
  }
});

router.get("/api/foodcast-materials/:materialId/video", async (req, res) => {
  const service = requireCustomFoodcastService(res);
  if (!service) return;
  try {
    const materialId = cleanText(req.params.materialId, 160);
    const expiresAt = Number(req.query.expires);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()
      || !safeSecretEqual(req.query.token, foodcastMaterialToken(materialId, expiresAt))) {
      return sendApiError(res, 404, "FOODCAST_NOT_FOUND");
    }
    let material = await service.getMaterial(materialId);
    if (!material || material.status !== "ready" || !material.fileId
      || Number(material.expiresAt) <= Date.now()) {
      return sendApiError(res, 404, "FOODCAST_NOT_FOUND");
    }
    const wantsCover = String(req.query.cover || "") === "1";
    if (wantsCover && !material.coverFileId) {
      material = await service.ensureMaterialCover(materialId);
    }
    const fileId = wantsCover ? material.coverFileId : material.fileId;
    if (!fileId) return sendApiError(res, 404, "FOODCAST_NOT_FOUND");
    const mediaUrl = await service.mediaStorage.getReadUrl(fileId, 600);
    const contentType = wantsCover ? "image/jpeg" : "video/mp4";
    if (/^https?:\/\//i.test(String(mediaUrl || ""))) {
      await streamRemoteMedia(req, res, mediaUrl, contentType, "private, max-age=300");
      return;
    }
    streamRangeFile(req, res, mediaUrl, contentType, "private, max-age=300");
  } catch (error) {
    if (!res.headersSent) sendApiError(res, 502, error.code || "FOODCAST_MEDIA_UNAVAILABLE");
  }
});

router.post("/api/foodcasts/custom", async (req, res) => {
  const service = requireCustomFoodcastService(res);
  if (!service) return;
  try {
    const deviceSn = cleanText(req.body.deviceSn, 128)
      || await deviceRegistry.getActiveSnForUser(req.auth.openid);
    const access = await requireOwnedDevice(req, res, deviceSn);
    if (!access) return;
    const dataOwnerOpenid = deviceDataOwner(access, req.auth.openid);
    const segments = (Array.isArray(req.body.segments) ? req.body.segments : []).map((segment) => ({
      materialId: cleanText(segment?.materialId, 160),
      trimStartSec: segment?.trimStartSec,
      trimEndSec: segment?.trimEndSec,
    }));
    const job = await service.create({
      ownerOpenid: dataOwnerOpenid,
      deviceSn,
      segments,
      frameMode: req.body.frameMode === "center_crop" ? "center_crop" : "source",
      bgmId: cleanText(req.body.bgmId, 160),
      bgmVolume: req.body.bgmVolume,
    });
    setImmediate(() => service.processJob(job.id).catch((error) => {
      console.warn("[custom-foodcast] render failed", error.message);
    }));
    res.status(202).json({
      ok: true,
      job: await service.getPublicJob({ ownerOpenid: dataOwnerOpenid, jobId: job.id }),
    });
  } catch (error) {
    sendFoodcastError(res, error);
  }
});

router.get("/api/foodcasts/custom/:jobId", async (req, res) => {
  const service = requireCustomFoodcastService(res);
  if (!service) return;
  try {
    const rawJob = await service.getJob(cleanText(req.params.jobId, 160));
    if (!rawJob) return sendApiError(res, 404, "FOODCAST_NOT_FOUND");
    const access = await requireAccessibleDevice(req, res, rawJob.deviceSn);
    if (!access) return;
    const job = await service.getPublicJob({
      ownerOpenid: access.ownerOpenid,
      jobId: rawJob.id,
    });
    if (!job) return sendApiError(res, 404, "FOODCAST_NOT_FOUND");
    res.json({ ok: true, job });
  } catch (error) {
    sendFoodcastError(res, error);
  }
});

router.get("/api/foodcasts/:jobId", async (req, res) => {
  const service = requireFoodcastService(res);
  if (!service) return;
  const job = service.getJob(cleanText(req.params.jobId, 160));
  if (!job) return sendApiError(res, 404, "FOODCAST_NOT_FOUND");
  if (!await requireAccessibleDevice(req, res, job.deviceSn)) return;
  res.json({ ok: true, job: service.getPublicJob(job.id, getRequestBaseUrl(req)) });
});

router.get("/api/foodcasts/:jobId/video", (req, res) => {
  const service = requireFoodcastService(res);
  if (!service) return;
  try {
    const filePath = service.resolveMedia(
      cleanText(req.params.jobId, 160),
      cleanText(req.query.token, 240)
    );
    streamRangeFile(req, res, filePath, "video/mp4", "private, max-age=300");
  } catch (error) {
    sendFoodcastError(res, error);
  }
});

router.get("/api/devices/:sn/live-recordings/latest", async (req, res) => {
  const service = requireLiveRecordingService(res);
  if (!service) return;
  const access = await requireAccessibleDevice(req, res, req.params.sn);
  if (!access) return;
  const job = await service.store.findLatest(access.ownerOpenid, req.params.sn, req.auth.openid);
  if (!job) return sendApiError(res, 404, "LIVE_RECORDING_NOT_FOUND");
  res.json({ ok: true, recording: publicLiveRecording(req, job) });
});

router.get("/api/live-recordings/:id", async (req, res) => {
  const service = requireLiveRecordingService(res);
  if (!service) return;
  const job = await service.store.getJob(cleanText(req.params.id, 160));
  if (!job) return sendApiError(res, 404, "LIVE_RECORDING_NOT_FOUND");
  const access = await requireAccessibleDevice(req, res, job.deviceSn);
  if (!access) return;
  if (job.ownerOpenid !== access.ownerOpenid) return sendApiError(res, 404, "LIVE_RECORDING_NOT_FOUND");
  res.json({ ok: true, recording: publicLiveRecording(req, job) });
});

router.get("/api/live-recordings/:id/video", async (req, res) => {
  const service = requireLiveRecordingService(res);
  if (!service) return;
  try {
    const job = await service.store.getJob(cleanText(req.params.id, 160));
    if (!job || !safeSecretEqual(req.query.token, job.accessToken)) {
      return sendApiError(res, 404, "LIVE_RECORDING_NOT_FOUND");
    }
    if (job.status !== "ready" || !job.fileId) {
      return sendApiError(res, 409, "LIVE_RECORDING_NOT_READY");
    }
    const mediaUrl = await service.mediaStorage.getReadUrl(job.fileId, 600);
    if (/^https?:\/\//i.test(String(mediaUrl || ""))) {
      await streamRemoteMedia(req, res, mediaUrl, "video/mp4", "private, max-age=300");
      return;
    }
    streamRangeFile(req, res, mediaUrl, "video/mp4", "private, max-age=300");
  } catch (error) {
    if (!res.headersSent) sendApiError(res, 502, error.code || "LIVE_RECORDING_MEDIA_UNAVAILABLE");
  }
});

router.get("/api/feed-analysis/status", async (req, res) => {
  const coordinator = requireCoordinator(res);
  if (!coordinator) return;
  const profile = await getAccessibleActiveDevice(req, res);
  if (!profile) return;
  const settings = coordinator.store.getSettings(profile.sn);
  const { openid: ignoredOpenid, ...safeSettings } = settings;
  res.json({
    ok: true,
    settings: {
      ...safeSettings,
      deviceSn: profile.sn,
      feedingDetectionEnabled: !!settings.analysisEnabled && !!settings.notifyEnabled,
    },
    queueStatus: typeof coordinator.getQueueStatus === "function"
      ? coordinator.getQueueStatus(profile.sn)
      : coordinator.queue && typeof coordinator.queue.getStatus === "function"
        ? coordinator.queue.getStatus()
        : null,
    notificationProvider: sanitizeNotificationProviderStatus(
      typeof coordinator.getNotificationStatus === "function"
        ? coordinator.getNotificationStatus()
        : {}
    ),
  });
});

router.post("/api/feed-analysis/settings", async (req, res) => {
  const coordinator = requireCoordinator(res);
  if (!coordinator) return;
  const hasUnifiedSetting = Object.prototype.hasOwnProperty.call(req.body || {}, "feedingDetectionEnabled");
  const feedingDetectionEnabled = hasUnifiedSetting
    ? !!req.body.feedingDetectionEnabled
    : !!req.body.analysisEnabled || !!req.body.notifyEnabled;
  const openid = req.auth.openid;
  const deviceSn = cleanText(req.body.deviceSn, 128) || await deviceRegistry.getActiveSnForOwner(openid);
  if (!await requireOwnedDevice(req, res, deviceSn)) return;
  const hasBowlRoi = Object.prototype.hasOwnProperty.call(req.body || {}, "bowlRoi");
  const bowlRoi = hasBowlRoi ? normalizeBowlRoi(req.body.bowlRoi) : undefined;
  if (hasBowlRoi && bowlRoi === undefined) {
    return sendApiError(res, 400, "BOWL_ROI_INVALID");
  }
  if (
    feedingDetectionEnabled &&
    req.body.requirePushPlusBinding &&
    (!openid || !(typeof coordinator.canDeliverNotificationTo === "function"
      ? coordinator.canDeliverNotificationTo(openid)
      : typeof coordinator.store.getPushPlusBinding === "function" &&
        coordinator.store.getPushPlusBinding(openid)))
  ) {
    return sendApiError(res, 409, "PUSHPLUS_FRIEND_NOT_BOUND");
  }
  let storedSettings = coordinator.store.updateSettings({
    openid,
    deviceSn,
    analysisEnabled: feedingDetectionEnabled,
    notifyEnabled: feedingDetectionEnabled,
    templateId: req.body.templateId || "",
  }, deviceSn);
  if (hasBowlRoi) {
    storedSettings = typeof coordinator.store.setBowlRoi === "function"
      ? coordinator.store.setBowlRoi(deviceSn, bowlRoi)
      : coordinator.store.updateSettings({ bowlRoi }, deviceSn);
  }
  if (typeof coordinator.persistSettings === "function") {
    storedSettings = await coordinator.persistSettings(storedSettings);
  }
  res.json({
    ok: true,
    settings: {
      ...storedSettings,
      feedingDetectionEnabled,
    },
  });
});

router.post("/api/feed-analysis/sync", async (req, res) => {
  const coordinator = requireCoordinator(res);
  if (!coordinator) return;
  try {
    const date = req.body.date || new Date().toISOString().slice(0, 10);
    const result = await syncFeedAnalysisForRequest(coordinator, req, res, {
      force: !!req.body.force,
      date,
    });
    if (!result) return;
    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error("[feed-analysis/sync]", error.message);
    coordinator.store.updateSettings({ officialConfigStatus: "error" });
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get("/api/feed-analysis/diary", async (req, res) => {
  const coordinator = requireCoordinator(res);
  if (!coordinator) return;
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const deviceSn = cleanText(req.query.deviceSn, 128) || await deviceRegistry.getActiveSnForUser(req.auth.openid);
    if (!await requireAccessibleDevice(req, res, deviceSn)) return;
    if (req.query.sync === "1") {
      const result = await syncFeedAnalysisForRequest(coordinator, req, res, {
        force: false,
        date,
      });
      if (!result) return;
    }
    res.json({ ok: true, diary: coordinator.store.getDiary(date, deviceSn) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get("/api/feed-analysis/markers", async (req, res) => {
  const coordinator = requireCoordinator(res);
  if (!coordinator) return;
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const deviceSn = cleanText(req.query.deviceSn, 128) || await deviceRegistry.getActiveSnForUser(req.auth.openid);
    if (!await requireAccessibleDevice(req, res, deviceSn)) return;
    const rawMarkers = coordinator.store.getReplayMarkers(date, deviceSn);
    const markers = Array.isArray(rawMarkers)
      ? rawMarkers
          .filter((marker) => marker && typeof marker === "object" && !Array.isArray(marker))
          .map(sanitizePublicReplayMarker)
      : [];
    const analysisStatus = typeof coordinator.store.getAnalysisStatus === "function"
      ? coordinator.store.getAnalysisStatus(deviceSn, date).map(sanitizePublicAnalysisStatus)
      : [];
    res.json({ ok: true, markers, analysisStatus });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get("/api/devices/:sn/timeline", async (req, res) => {
  const coordinator = requireCoordinator(res);
  if (!coordinator) return;
  try {
    const deviceSn = cleanText(req.params.sn, 128);
    if (!await requireAccessibleDevice(req, res, deviceSn)) return;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? String(req.query.date)
      : new Date().toISOString().slice(0, 10);
    const rawMarkers = coordinator.store.getReplayMarkers(date, deviceSn);
    const markers = Array.isArray(rawMarkers)
      ? rawMarkers.filter((marker) => marker && typeof marker === "object" && !Array.isArray(marker))
        .map(sanitizePublicReplayMarker)
      : [];
    const diary = coordinator.store.getDiary(date, deviceSn);
    const analysisStatus = typeof coordinator.store.getAnalysisStatus === "function"
      ? coordinator.store.getAnalysisStatus(deviceSn, date).map(sanitizePublicAnalysisStatus)
      : [];
    const alarms = appDataStore.listMotionAlarms(deviceSn, { date, limit: 100 });
    const settings = coordinator.store.getSettings(deviceSn) || {};
    const sourceHealth = {
      status: sanitizePublicString(settings.officialAlarmStatus || "idle"),
      source: sanitizePublicString(settings.officialAlarmSource || "none"),
      checkedAt: sanitizePublicFiniteNumber(settings.officialAlarmCheckedAt || settings.lastOfficialAlarmScanAt),
      motionDeliveryEnabled: settings.motionDeliveryEnabled === true,
      motionDeliveryStatus: sanitizePublicString(settings.motionDeliveryStatus || "idle"),
      motionDeliveryCheckedAt: sanitizePublicFiniteNumber(settings.motionDeliveryCheckedAt),
      lastMotionAlarmAt: sanitizePublicFiniteNumber(settings.lastMotionAlarmAt),
      lastPetAlarmAt: sanitizePublicFiniteNumber(settings.lastPetAlarmAt),
    };
    const payload = { markers, diary, analysisStatus, alarms, sourceHealth };
    const revision = crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
    const unchanged = !!req.query.since && String(req.query.since) === revision;
    res.json({
      ok: true,
      date,
      revision,
      unchanged,
      ...(unchanged ? {} : payload),
    });
  } catch (error) {
    console.error("[device-timeline]", req.params.sn, safeErrorCode(error));
    sendApiError(res, 500, "DEVICE_TIMELINE_LOAD_FAILED");
  }
});

router.post("/api/feed-analysis/notifications/ack", async (req, res) => {
  const coordinator = requireCoordinator(res);
  if (!coordinator) return;
  if (!await getOwnedActiveDevice(req, res)) return;
  coordinator.store.ackNotifications(Array.isArray(req.body.eventIds) ? req.body.eventIds : []);
  res.json({ ok: true });
});

router.get("/api/feed-analysis/notifications/binding", async (req, res) => {
  const coordinator = requireCoordinator(res);
  if (!coordinator) return;
  const openid = req.auth.openid;
  if (typeof coordinator.getPushPlusBindingStatus !== "function") {
    return sendApiError(res, 503, "PUSHPLUS_OPEN_API_NOT_CONFIGURED");
  }
  try {
    const status = await coordinator.getPushPlusBindingStatus(openid);
    const friendQrCode = cleanText(status.friendQrCode, 128);
    res.json({
      ok: true,
      configured: !!status.configured,
      bound: !!status.bound,
      deliveryReady: !!status.bound || (
        typeof coordinator.canDeliverNotificationTo === "function" &&
        coordinator.canDeliverNotificationTo(openid)
      ),
      ...(status.bound ? { isFollow: !!status.isFollow } : {}),
      ...(status.expiresAt ? { expiresAt: Number(status.expiresAt) } : {}),
      serviceQrImageUrl: "/api/feed-analysis/notifications/service-qr-image",
      ...(friendQrCode
        ? {
            friendQrImageUrl:
              `/api/feed-analysis/notifications/friend-qr-image?code=${encodeURIComponent(friendQrCode)}`,
          }
        : {}),
    });
  } catch (error) {
    console.error("[feed-analysis/pushplus-binding]", error.message);
    sendApiError(res, 502, cleanText(error.message, 240));
  }
});

router.get("/api/feed-analysis/notifications/service-qr-image", async (req, res) => {
  const coordinator = requireCoordinator(res);
  if (!coordinator) return;
  try {
    const sourceUrl = coordinator.getPushPlusQrSourceUrl("service");
    await proxyPushPlusQrImage(res, sourceUrl);
  } catch (error) {
    sendApiError(res, 502, cleanText(error.message, 240));
  }
});

router.get("/api/feed-analysis/notifications/friend-qr-image", async (req, res) => {
  const coordinator = requireCoordinator(res);
  if (!coordinator) return;
  try {
    const code = cleanText(req.query.code, 128);
    const sourceUrl = code ? coordinator.getPushPlusQrSourceUrl("friend", code) : "";
    if (!sourceUrl) return sendApiError(res, 404, "PUSHPLUS_FRIEND_QR_NOT_FOUND");
    await proxyPushPlusQrImage(res, sourceUrl);
  } catch (error) {
    sendApiError(res, 502, cleanText(error.message, 240));
  }
});

router.post("/api/feed-analysis/notifications/pushplus-callback", async (req, res) => {
  const callbackSecret = config.pushPlus.callbackSecret;
  const providedSecret = req.query.key || req.get("x-pushplus-callback-secret") || "";
  if (!callbackSecret) return sendApiError(res, 503, "PUSHPLUS_CALLBACK_NOT_CONFIGURED");
  if (!safeSecretEqual(providedSecret, callbackSecret)) {
    return sendApiError(res, 403, "PUSHPLUS_CALLBACK_FORBIDDEN");
  }
  const payload = req.body || {};
  if (payload.event === "message_complate") {
    const messageInfo = payload.messageInfo || {};
    const shortCode = cleanText(messageInfo.shortCode, 128);
    const sendStatus = Number(messageInfo.sendStatus);
    if (!shortCode || ![0, 1, 2, 3].includes(sendStatus)) {
      return sendApiError(res, 400, "PUSHPLUS_MESSAGE_CALLBACK_INVALID");
    }
    appDataStore.updateWechatNotificationDeliveryByProviderMessageId("pushplus", shortCode, {
      status: sendStatus === 2 ? "delivered" : sendStatus === 3 ? "failed" : "pending",
      providerStatus: `sendStatus:${sendStatus}`,
      providerCode: sendStatus,
      error: sendStatus === 3 ? cleanText(messageInfo.message, 160) || "PUSHPLUS_DELIVERY_FAILED" : "",
    });
    return res.json({ code: 200, msg: "success" });
  }
  let result = defaultPushPlusBindingService.handleCallback(payload);
  if ((!result || !result.ok) && feedAnalysisCoordinator?.handlePushPlusCallback) {
    result = await feedAnalysisCoordinator.handlePushPlusCallback(payload);
  }
  if (!result || !result.ok) {
    return sendApiError(res, 400, (result && result.error) || "PUSHPLUS_CALLBACK_INVALID");
  }
  res.json({ code: 200, msg: "success" });
});

router.post("/api/feed-analysis/notifications/test", async (req, res) => {
  const coordinator = requireCoordinator(res);
  if (!coordinator) return;
  const profile = await getOwnedActiveDevice(req, res);
  if (!profile) return;
  if (typeof coordinator.sendTestNotification !== "function") {
    res.status(503).json({ ok: false, error: "PUSHPLUS_NOT_CONFIGURED" });
    return;
  }
  try {
    const result = await coordinator.sendTestNotification(req.auth.openid, profile.sn);
    res.status(result && result.ok ? 200 : 503).json(result || { ok: false, error: "PUSHPLUS_SEND_FAILED" });
  } catch (error) {
    console.error("[feed-analysis/pushplus-test]", error.message);
    res.status(502).json({ ok: false, error: cleanText(error.message || "PUSHPLUS_SEND_FAILED", 240) });
  }
});

module.exports = {
  authorizedDeviceSnapshot,
  authenticateMediaControl,
  router,
  initializeDeviceRegistry,
  resolveDeviceOwnerOpenid,
  resolveOwnedLiveSession,
  resolveOwnedMediaDevice,
  resolveOwnedRecordingLiveSource,
  resolveOwnedRecordingWindow,
  resolveOwnedTalkbackUrl,
  recordingStageError,
  resolveFoodcastPreferences,
  resetDeviceStateForTests,
  resetAppDataForTests() {
    appDataStore.clear();
  },
  setWechatLoginServiceForTests(service) {
    wechatLoginService = service || defaultWechatLoginService;
  },
  setWechatMiniCodeServiceForTests(service) {
    wechatMiniCodeService = service || defaultWechatMiniCodeService;
  },
  setWechatDeviceNotificationCoordinatorForTests,
  setReplayHlsManagerForTests,
  setReplayNativeClientFactoryForTests,
  setReplayChannelReleaseDelayForTests,
  setFeedAnalysisCoordinator,
  setFoodcastService,
  setFoodcastAutomationService,
  setCustomFoodcastService,
  setLiveRecordingService,
  setLiveRecordingServiceForTests,
  setFeedingActivityTestServiceForTests,
  setFoodcastAlgorithmTestServiceForTests(service) {
    foodcastAlgorithmTestService = service || defaultFoodcastAlgorithmTestService;
  },
};
