/**
 * 配置加载
 */
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

let bundledFfmpegPath = "";
try {
  bundledFfmpegPath = require("@ffmpeg-installer/ffmpeg").path;
} catch (error) {
  bundledFfmpegPath = "";
}

const required = [
  "JF_UUID",
  "JF_APPKEY",
  "JF_APPSECRET",
  "JF_MOVECARD",
  "JF_DEVICE_SN",
  "JF_DEVICE_USERNAME",
  "JF_ENDPOINT",
];

function resolveVisionBaseUrl(value) {
  const text = String(value || "").trim();
  if (!text || /^(local|worker|disabled|none)$/i.test(text)) return "";
  return text.replace(/\/+$/, "");
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

const cloudHosting =
  isTruthyEnv(process.env.WECHAT_CLOUD_HOSTING) ||
  isTruthyEnv(process.env.CLOUD_HOSTING);
const httpBehindProxy = isTruthyEnv(process.env.HTTP_BEHIND_PROXY);
const explicitPublicBaseUrl = String(
  process.env.PUBLIC_BASE_URL || process.env.BACKEND_PUBLIC_BASE_URL || ""
).trim().replace(/\/+$/, "");
const vendorAlarmCallbackToken = String(process.env.VENDOR_ALARM_CALLBACK_TOKEN || "").trim() ||
  crypto.createHash("sha256")
    .update(`bobbo-vendor-alarm:${process.env.APP_SESSION_SECRET || "local-development"}`)
    .digest("hex")
    .slice(0, 40);
const deviceRegistryBackend =
  process.env.DEVICE_REGISTRY_BACKEND || (cloudHosting ? "cloudbase" : "file");
const cloudbaseCredentials = {
  secretId:
    process.env.CLOUDBASE_SECRET_ID ||
    process.env.TCB_SECRET_ID ||
    process.env.TENCENTCLOUD_SECRETID ||
    "",
  secretKey:
    process.env.CLOUDBASE_SECRET_KEY ||
    process.env.TCB_SECRET_KEY ||
    process.env.TENCENTCLOUD_SECRETKEY ||
    "",
};

const missingCameraKeys = required.filter((key) => !process.env[key]);
const strictRuntime = cloudHosting || process.env.NODE_ENV === "production";
if (missingCameraKeys.length && strictRuntime) {
  console.error("[config] 缺少摄像头环境变量 " + missingCameraKeys.join(", ") + "，请参考 server/.env.example");
  process.exit(1);
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}
if (missingCameraKeys.length) {
  console.warn(
    "[config] camera features are disabled until these local variables are configured: "
      + missingCameraKeys.join(", ")
  );
}

if ((cloudHosting || process.env.NODE_ENV === "production") && Buffer.byteLength(process.env.APP_SESSION_SECRET || "") < 32) {
  console.error("[config] APP_SESSION_SECRET must contain at least 32 bytes in production");
  process.exit(1);
}

if (
  (cloudHosting || process.env.NODE_ENV === "production") &&
  deviceRegistryBackend === "cloudbase" &&
  (!cloudbaseCredentials.secretId || !cloudbaseCredentials.secretKey)
) {
  console.error("[config] CLOUDBASE_SECRET_ID and CLOUDBASE_SECRET_KEY are required for the CloudBase device registry");
  process.exit(1);
}

if (cloudHosting && !explicitPublicBaseUrl) {
  console.error("[config] PUBLIC_BASE_URL is required for Cloud Hosting media playback");
  process.exit(1);
}

module.exports = {
  endpoint: process.env.JF_ENDPOINT,
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || "0.0.0.0",
  publicBaseUrl: explicitPublicBaseUrl || `https://localhost:${Number(process.env.PORT) || 3000}`,
  vendorAlarms: {
    callbackToken: vendorAlarmCallbackToken,
    callbackBaseUrl: `${explicitPublicBaseUrl || `https://localhost:${Number(process.env.PORT) || 3000}`}/api/vendor/alarms/callback`,
  },
  cloudHosting,
  httpBehindProxy,
  cameraConfigured: missingCameraKeys.length === 0,
  wechat: {
    appId: process.env.WECHAT_APP_ID || "touristappid",
    appSecret: process.env.WECHAT_APP_SECRET || "",
    timeoutMs: Number(process.env.WECHAT_LOGIN_TIMEOUT_MS) || 5000,
	miniCodeEnvVersion: process.env.WECHAT_MINICODE_ENV_VERSION || "trial",
	envVersion: process.env.WECHAT_MINICODE_ENV_VERSION || "trial",
  },
  wechatDeviceMessages: {
    modelId: process.env.WECHAT_DEVICE_MESSAGE_MODEL_ID || "",
    startTemplateId: process.env.WECHAT_DEVICE_MESSAGE_START_TEMPLATE_ID || "",
    endTemplateId: process.env.WECHAT_DEVICE_MESSAGE_END_TEMPLATE_ID || "",
    startData: parseJsonObject(process.env.WECHAT_DEVICE_MESSAGE_START_DATA_JSON),
    endData: parseJsonObject(process.env.WECHAT_DEVICE_MESSAGE_END_DATA_JSON),
    miniProgramState: process.env.WECHAT_DEVICE_MESSAGE_MINIPROGRAM_STATE ||
      process.env.WECHAT_MINICODE_ENV_VERSION || "trial",
    timeoutMs: Number(process.env.WECHAT_DEVICE_MESSAGE_TIMEOUT_MS) || 5000,
  },
  wechatMiniSubscriptions: {
    startTemplateId: process.env.WECHAT_MINI_SUBSCRIPTION_START_TEMPLATE_ID || "",
    endTemplateId: process.env.WECHAT_MINI_SUBSCRIPTION_END_TEMPLATE_ID || "",
    startData: parseJsonObject(process.env.WECHAT_MINI_SUBSCRIPTION_START_DATA_JSON),
    endData: parseJsonObject(process.env.WECHAT_MINI_SUBSCRIPTION_END_DATA_JSON),
    page: process.env.WECHAT_MINI_SUBSCRIPTION_PAGE || "pages/today/index",
    miniProgramState: process.env.WECHAT_MINI_SUBSCRIPTION_STATE ||
      process.env.WECHAT_MINICODE_ENV_VERSION || "trial",
    timeoutMs: Number(process.env.WECHAT_MINI_SUBSCRIPTION_TIMEOUT_MS) || 5000,
  },
  wechatOfficialAccount: {
    appId: process.env.WECHAT_OFFICIAL_ACCOUNT_APP_ID || "",
    appSecret: process.env.WECHAT_OFFICIAL_ACCOUNT_APP_SECRET || "",
    callbackToken: process.env.WECHAT_OFFICIAL_ACCOUNT_CALLBACK_TOKEN || "",
    encodingAesKey: process.env.WECHAT_OFFICIAL_ACCOUNT_ENCODING_AES_KEY || "",
    startTemplateId: process.env.WECHAT_OFFICIAL_ACCOUNT_START_TEMPLATE_ID || "",
    endTemplateId: process.env.WECHAT_OFFICIAL_ACCOUNT_END_TEMPLATE_ID || "",
    startData: parseJsonObject(process.env.WECHAT_OFFICIAL_ACCOUNT_START_DATA_JSON),
    endData: parseJsonObject(process.env.WECHAT_OFFICIAL_ACCOUNT_END_DATA_JSON),
    timeoutMs: Number(process.env.WECHAT_OFFICIAL_ACCOUNT_TIMEOUT_MS) || 5000,
  },
  wxPusher: {
    appToken: process.env.WXPUSHER_APP_TOKEN || "",
    appId: process.env.WXPUSHER_APP_ID || "",
    callbackSecret: process.env.WXPUSHER_CALLBACK_SECRET || "",
    endpoint: process.env.WXPUSHER_ENDPOINT || "https://wxpusher.zjiecode.com/api/send/message",
    qrEndpoint: process.env.WXPUSHER_QR_ENDPOINT || "https://wxpusher.zjiecode.com/api/fun/create/qrcode",
    timeoutMs: Number(process.env.WXPUSHER_TIMEOUT_MS) || 5000,
    challengeTtlSeconds: Number(process.env.WXPUSHER_CHALLENGE_TTL_SECONDS) || 1800,
  },
  session: {
    secret: process.env.APP_SESSION_SECRET || "",
    ttlMs: Number(process.env.APP_SESSION_TTL_MS) || 30 * 24 * 60 * 60 * 1000,
  },
  automation: {
    tickSecret: process.env.AUTOMATION_TICK_SECRET || "",
  },
  legacyDeviceOwnerOpenid: process.env.LEGACY_DEVICE_OWNER_OPENID || "",
  deviceRegistryBackend,
  cloudbaseEnvId: process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || "",
  cloudbaseCredentials,
  auth: {
    uuid: process.env.JF_UUID,
    appKey: process.env.JF_APPKEY,
    appSecret: process.env.JF_APPSECRET,
    moveCard: Number(process.env.JF_MOVECARD),
  },
  device: {
    sn: process.env.JF_DEVICE_SN,
    username: process.env.JF_DEVICE_USERNAME,
    password: process.env.JF_DEVICE_PASSWORD,
  },
  deviceRegistryFile:
    process.env.JF_DEVICE_REGISTRY_FILE ||
    path.join(__dirname, "../data/devices.json"),
  appData: {
    stateFile:
      process.env.APP_DATA_STATE_FILE ||
      path.join(__dirname, "../data/app-data.sqlite"),
  },
  accountSyncAuditFile:
    process.env.ACCOUNT_SYNC_AUDIT_FILE ||
    path.join(__dirname, "../data/account-sync-audit.jsonl"),
  livePlaybackDiagnosticSn: String(process.env.LIVE_PLAYBACK_DIAGNOSTIC_SN || "").trim(),
  channel: process.env.CHANNEL || "0",
  stream: process.env.STREAM || "1",
  webrtcFallbackSeconds: Number(process.env.WEBRTC_FALLBACK_SECONDS) || 8,
  devicePri: {
    host: process.env.JF_DEVICE_LAN_HOST || "",
    httpPort: Number(process.env.JF_DEVICE_LAN_HTTP_PORT) || 80,
    wsPort: process.env.JF_DEVICE_LAN_WS_PORT ? Number(process.env.JF_DEVICE_LAN_WS_PORT) : null,
    secure: process.env.JF_DEVICE_LAN_SECURE === "true" || process.env.JF_DEVICE_LAN_SECURE === "1",
  },
  replay: {
    sessionTtlMs: Number(process.env.REPLAY_SESSION_TTL_MS) || 10 * 60 * 1000,
    ffmpegPath: process.env.FFMPEG_PATH || bundledFfmpegPath,
    channelReleaseDelayMs: Number(process.env.REPLAY_CHANNEL_RELEASE_DELAY_MS) || 0,
    userPlaybackHoldMs: Number(process.env.REPLAY_USER_PLAYBACK_HOLD_MS) || 120 * 1000,
    nativeLanEnabled: /^(1|true|yes|on)$/i.test(String(process.env.REPLAY_NATIVE_LAN_ENABLED || "")),
  },
  playerAuth: {
    uuid: process.env.JF_UUID,
    appkey: process.env.JF_APPKEY,
    appsecret: process.env.JF_APPSECRET,
    movedcard: Number(process.env.JF_MOVECARD),
  },
  devicePri: {
    host: process.env.JF_DEVICE_LAN_HOST || "",
    httpPort: Number(process.env.JF_DEVICE_LAN_HTTP_PORT) || 80,
    wsPort: process.env.JF_DEVICE_LAN_WS_PORT ? Number(process.env.JF_DEVICE_LAN_WS_PORT) : null,
    secure: process.env.JF_DEVICE_LAN_SECURE === "true" || process.env.JF_DEVICE_LAN_SECURE === "1",
  },
  replay: {
    sessionTtlMs: Number(process.env.REPLAY_SESSION_TTL_MS) || 10 * 60 * 1000,
    ffmpegPath: process.env.FFMPEG_PATH || bundledFfmpegPath,
    channelReleaseDelayMs: Number(process.env.REPLAY_CHANNEL_RELEASE_DELAY_MS) || 0,
    userPlaybackHoldMs: Number(process.env.REPLAY_USER_PLAYBACK_HOLD_MS) || 120 * 1000,
    nativeLanEnabled: /^(1|true|yes|on)$/i.test(String(process.env.REPLAY_NATIVE_LAN_ENABLED || "")),
  },
  liveMedia: {
    stateFile:
      process.env.LIVE_RECORDING_STATE_FILE ||
      path.join(__dirname, "../data/live-recordings.json"),
    tempDir:
      process.env.LIVE_RECORDING_TEMP_DIR ||
      path.join(__dirname, "../data/live-recording-temp"),
    outputDir:
      process.env.LIVE_MEDIA_OUTPUT_DIR ||
      path.join(__dirname, "../data/media"),
    collection: process.env.LIVE_RECORDING_COLLECTION || "cat_live_recordings",
    maxDurationSec: Math.min(
      300,
      Math.max(1, Number(process.env.LIVE_RECORDING_MAX_DURATION_SEC) || 300)
    ),
  },
  catAvatarDir:
    process.env.CAT_AVATAR_DIR ||
    path.join(__dirname, "../data/media/cat-avatars"),
  replayThumbnailDir:
    process.env.REPLAY_THUMBNAIL_DIR ||
    path.join(__dirname, "../data/media/replay-thumbnails"),
  deviceCoverDir:
    process.env.DEVICE_COVER_DIR ||
    path.join(__dirname, "../data/media/device-covers"),
  analysis: {
    enabled: !/^(0|false|no|off)$/i.test(
      String(process.env.FEED_ANALYSIS_ENABLED || "").trim()
    ),
    automationEnabled: process.env.FEED_ANALYSIS_AUTOMATION_ENABLED === undefined
      ? true
      : isTruthyEnv(process.env.FEED_ANALYSIS_AUTOMATION_ENABLED),
    recordingsCollection:
      process.env.FEED_ANALYSIS_RECORDINGS_COLLECTION || "feed_analysis_recordings",
    settingsCollection: process.env.FEED_ANALYSIS_SETTINGS_COLLECTION || "feed_analysis_states",
    pushPlusBindingsCollection:
      process.env.PUSHPLUS_BINDINGS_COLLECTION || "pushplus_bindings",
    pollIntervalMs: Number(process.env.FEED_ANALYSIS_POLL_INTERVAL_MS) || 60 * 1000,
    stateFile:
      process.env.FEED_ANALYSIS_STATE_FILE ||
      path.join(__dirname, "../data/feed-analysis-state.sqlite"),
    globalConcurrency:
      Number(process.env.FEED_ANALYSIS_GLOBAL_CONCURRENCY) || 2,
    playbackSpeed: Math.min(
      8,
      Math.max(1, Number(process.env.FEED_ANALYSIS_PLAYBACK_SPEED) || 8)
    ),
    playbackStreamType: Number.isFinite(Number(process.env.FEED_ANALYSIS_PLAYBACK_STREAM_TYPE))
      ? Math.max(0, Number(process.env.FEED_ANALYSIS_PLAYBACK_STREAM_TYPE))
      : 1,
    orientation: ["none", "clockwise-90"].includes(
      String(process.env.FEED_ANALYSIS_ORIENTATION || "clockwise-90").trim().toLowerCase()
    )
      ? String(process.env.FEED_ANALYSIS_ORIENTATION || "clockwise-90").trim().toLowerCase()
      : "clockwise-90",
    screeningSampleSeconds: Math.min(
      10,
      Math.max(1, Number(process.env.FEED_ANALYSIS_SCREENING_SAMPLE_SECONDS) || 2)
    ),
    alarmCompensationLookbackMs:
      (Number(process.env.FEED_ANALYSIS_ALARM_COMPENSATION_MINUTES) || 15) * 60 * 1000,
    alarmCompensationIntervalMs:
      (Number(process.env.FEED_ANALYSIS_ALARM_COMPENSATION_INTERVAL_MINUTES) || 15) * 60 * 1000,
    feedingStart: {
      enabled: process.env.FEEDING_START_CONFIRMATION_ENABLED === undefined
        ? true
        : isTruthyEnv(process.env.FEEDING_START_CONFIRMATION_ENABLED),
      windowMs: (Number(process.env.FEEDING_START_WINDOW_SECONDS) || 30) * 1000,
      maxWindowMs: (Number(process.env.FEEDING_START_MAX_WINDOW_SECONDS) || 45) * 1000,
      preRollMs: (Number(process.env.FEEDING_START_PRE_ROLL_SECONDS) || 15) * 1000,
      minWindowMs: (Number(process.env.FEEDING_START_MIN_WINDOW_SECONDS) || 20) * 1000,
      candidateTtlMs: (Number(process.env.FEEDING_START_CANDIDATE_TTL_SECONDS) || 120) * 1000,
      rearmQuietMs: (Number(process.env.FEEDING_START_REARM_QUIET_SECONDS) || 600) * 1000,
      extensionMs: (Number(process.env.FEEDING_START_EXTENSION_SECONDS) || 10) * 1000,
      confirmationPolicy: {
        minActualEatingSeconds: Number(process.env.FEEDING_START_MIN_EATING_SECONDS) || 6,
        minSpanSeconds: Number(process.env.FEEDING_START_MIN_SPAN_SECONDS) || 8,
        minConfidence: Number(process.env.FEEDING_START_MIN_CONFIDENCE) || 0.6,
        maxEvidenceAgeSeconds:
          Number(process.env.FEEDING_START_MAX_EVIDENCE_AGE_SECONDS) || 5,
      },
    },
    retryDelayMs:
      Number(process.env.FEED_ANALYSIS_RETRY_DELAY_MS) || 60 * 1000,
    maxRetries:
      Number(process.env.FEED_ANALYSIS_MAX_RETRIES) || 3,
    materialSyncMaxAttempts:
      Number(process.env.FEED_ANALYSIS_MATERIAL_SYNC_MAX_ATTEMPTS) || 10,
    alarmWindowPaddingSeconds:
      Number(process.env.FEED_ANALYSIS_ALARM_WINDOW_PADDING_SECONDS) || 5 * 60,
    alarmTimeoutMs:
      Number(process.env.FEED_ANALYSIS_ALARM_TIMEOUT_MS) || 3000,
    pythonPath:
      process.env.FEED_ANALYSIS_PYTHON || process.env.PYTHON_PATH || "python",
    workerScript:
      process.env.FEED_ANALYSIS_WORKER_SCRIPT ||
      path.join(__dirname, "feedAnalysis/vision_worker.py"),
    minConfidence: Number(process.env.FEED_ANALYSIS_MIN_CONFIDENCE) || 0.35,
    visionBaseUrl: resolveVisionBaseUrl(
      process.env.FEED_ANALYSIS_VISION_BASE_URL
    ),
    target: process.env.FEED_ANALYSIS_TARGET || "cat",
    detectorBackend: process.env.FEED_ANALYSIS_DETECTOR_BACKEND || "auto",
    yoloModel: process.env.FEED_ANALYSIS_YOLO_MODEL || "",
    visionTimeoutMs:
      Number(process.env.FEED_ANALYSIS_VISION_TIMEOUT_MS) || 12 * 60 * 1000,
    visionToken: process.env.FEED_ANALYSIS_VISION_TOKEN || "",
    visionStartupRetryMs:
      Number(process.env.FEED_ANALYSIS_VISION_STARTUP_RETRY_MS) || 3 * 60 * 1000,
    visionRetryIntervalMs:
      Number(process.env.FEED_ANALYSIS_VISION_RETRY_INTERVAL_MS) || 5000,
    workerControlToken: process.env.FEED_ANALYSIS_WORKER_CONTROL_TOKEN || "",
    test: {
      token: process.env.FEED_ANALYSIS_TEST_TOKEN || "",
      inputDir:
        process.env.FEED_ANALYSIS_TEST_INPUT_DIR ||
        path.join(__dirname, "../data/feed-analysis-test-inputs"),
      tempDir:
        process.env.FEED_ANALYSIS_TEST_TEMP_DIR ||
        path.join(__dirname, "../data/feed-analysis-test-temp"),
      outputDir:
        process.env.FEED_ANALYSIS_TEST_OUTPUT_DIR ||
        path.join(__dirname, "../data/feed-analysis-test-results"),
      maxFileBytes:
        (Number(process.env.FEED_ANALYSIS_TEST_MAX_FILE_MB) || 512) * 1024 * 1024,
      defaultDurationSec:
        Number(process.env.FEED_ANALYSIS_TEST_DEFAULT_DURATION_SEC) || 120,
      maxDurationSec:
        Number(process.env.FEED_ANALYSIS_TEST_MAX_DURATION_SEC) || 1200,
    },
  },
  foodcast: {
    stateFile:
      process.env.FOODCAST_STATE_FILE ||
      path.join(__dirname, "../data/foodcasts.sqlite"),
    outputDir:
      process.env.FOODCAST_OUTPUT_DIR ||
      path.join(__dirname, "../data/foodcasts"),
    tempDir:
      process.env.FOODCAST_TEMP_DIR ||
      path.join(__dirname, "../data/foodcast-temp"),
    bgmDir:
      process.env.FOODCAST_BGM_DIR ||
      path.join(__dirname, "../../bgm"),
    ffmpegPath: process.env.FOODCAST_FFMPEG_PATH || process.env.FFMPEG_PATH || bundledFfmpegPath,
    concurrency: Number(process.env.FOODCAST_CONCURRENCY) || 1,
    maxRetries: Number(process.env.FOODCAST_MAX_RETRIES) || 2,
    retryDelayMs: Number(process.env.FOODCAST_RETRY_DELAY_MS) || 5000,
    retentionMs: (Number(process.env.FOODCAST_RETENTION_DAYS) || 30) * 24 * 60 * 60 * 1000,
    maxStorageBytes: (Number(process.env.FOODCAST_MAX_STORAGE_GB) || 30) * 1024 * 1024 * 1024,
    cleanupIntervalMs: Number(process.env.FOODCAST_CLEANUP_INTERVAL_MS) || 60 * 60 * 1000,
    materials: {
      stateFile:
        process.env.FOODCAST_MATERIAL_STATE_FILE ||
        path.join(__dirname, "../data/foodcast-materials.sqlite"),
      collection: process.env.FOODCAST_MATERIAL_COLLECTION || "foodcast_materials",
      retentionMs:
        (Number(process.env.FOODCAST_MATERIAL_RETENTION_DAYS) || 30) * 24 * 60 * 60 * 1000,
      mealGapMs:
        (Number(process.env.FOODCAST_MEAL_GAP_MINUTES) || 10) * 60 * 1000,
      leaseMs:
        (Number(process.env.FOODCAST_JOB_LEASE_SECONDS) || 300) * 1000,
    },
  },
  pushPlus: {
    token: process.env.PUSHPLUS_TOKEN || "",
    secretKey: process.env.PUSHPLUS_SECRET_KEY || "",
    endpoint: process.env.PUSHPLUS_ENDPOINT || "https://www.pushplus.plus/send",
    baseUrl: process.env.PUSHPLUS_OPEN_API_BASE_URL || "https://www.pushplus.plus",
    channel: process.env.PUSHPLUS_CHANNEL || "wechat",
    timeoutMs: Number(process.env.PUSHPLUS_TIMEOUT_MS) || 5000,
    ownerOpenid: process.env.PUSHPLUS_OWNER_OPENID || "",
    callbackSecret: process.env.PUSHPLUS_CALLBACK_SECRET || "",
    serviceQrUrl:
      process.env.PUSHPLUS_SERVICE_QR_URL ||
      "https://image.pushplus.plus/pc/image/pushplus_mp.jpg",
  },
};
