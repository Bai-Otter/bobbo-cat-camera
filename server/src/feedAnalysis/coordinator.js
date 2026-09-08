const path = require("path");

const { AlarmScanAdapter } = require("./alarmAdapter");
const { AnalysisQueue } = require("./analysisQueue");
const {
  buildClipFromRecording,
  formatDateKey,
  recordingKey,
  sanitizeAnalysisMarker,
  sanitizeFeedingStats,
} = require("./model");
const { ALGORITHM_VERSION, buildFeedingStats } = require("./feedingStats");
const {
  DEFAULT_FEEDING_START_CONFIRMATION_POLICY,
  evaluateFeedingStartConfirmation,
} = require("./feedingStartConfirmation");
const {
  alarmTimeWindow,
  extractDeviceLogEntries,
  formatDeviceTime,
  isFeedingTriggerAlarm,
  selectNewDeviceLogAlarms,
  selectNewLiveObjectAlarms,
} = require("./officialAlarm");
const {
  buildLiveObjectAlarmConfigPayload,
  enableMotionDetectConfig,
  motionAlarmDeliveryEnabled,
  resolveLiveObjectAlarmConfigNames,
  tuneRecordConfig,
} = require("./officialConfig");
const { FeedAnalysisStore } = require("./store");
const { VisionWorkerAnalyzer } = require("./visionWorker");
const { VisionHttpAnalyzer } = require("./visionHttpClient");
const { CloudFeedAnalysisSettingsStore } = require("./cloudSettingsStore");
const { CloudFeedAnalysisRecordingStore } = require("./cloudRecordingStore");
const { JFDevice } = require("../jf/device");
const { PushPlusNotifier } = require("../notifications/pushPlusNotifier");
const { PushPlusOpenApi } = require("../notifications/pushPlusOpenApi");
const { PushPlusBindingService } = require("../notifications/pushPlusBindingService");
const cache = require("../tokenCache");
const {
  formatDeviceDateTime,
  parseDeviceDateTime,
} = require("./deviceTime");
const { readDeviceClock } = require("./deviceTimeSync");

function formatLocalDateTime(date) {
  return formatDeviceDateTime(date);
}

function dayRange(dateValue) {
  const dateText = String(dateValue || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return null;
  return {
    beginTime: `${dateText} 00:00:00`,
    endTime: `${dateText} 23:59:59`,
  };
}

function parseLocalDateTime(value) {
  return parseDeviceDateTime(value);
}

function isPlaybackChannelOccupied(error) {
  const message = String(error && error.message ? error.message : error);
  return /-514053|playback channel occupied|NET_PLAYBACK_OCCUPIED/i.test(message);
}

function recordingDurationSec(recording = {}) {
  const explicit = Number(recording.durationSec);
  if (explicit > 0) return explicit;
  const begin = parseLocalDateTime(recording.BeginTime || recording.beginTime || "");
  const end = parseLocalDateTime(recording.EndTime || recording.endTime || "");
  if (!begin || !end) return 0;
  return Math.max(0, Math.round((end - begin) / 1000));
}

const ANALYSIS_SEGMENT_SECONDS = 10 * 60;
const ANALYSIS_SEGMENT_OVERLAP_SECONDS = 15;
const ALARM_ANALYSIS_LOOKBACK_MS = 30 * 60 * 1000;
const ALARM_ANALYSIS_OVERLAP_MS = 30 * 1000;
const ALARM_ANALYSIS_MAX_WINDOW_MS = 30 * 60 * 1000;
const REPLAY_LEAD_PADDING_SECONDS = 15;
const REPLAY_LEAD_TRIM_SECONDS = 12;
const PLAYBACK_CHANNEL_SETTLE_MS = 3_000;
const STALE_ALARM_WINDOW_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FEEDING_START_TASK_KEY = "feeding-start-candidate";
const OFFICIAL_ALARM_PROFILE_VERSION = 2;

function sanitizePlaybackParams(value = {}, fallback = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const startTime = String(source.startTime || fallback.startTime || "");
  const endTime = String(source.endTime || fallback.endTime || "");
  const targetSec = Number(source.targetSec);
  return {
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    ...(Number.isFinite(targetSec) && targetSec >= 0 ? { targetSec } : {}),
  };
}

function mergeAlarmCandidates(primary = [], fallback = []) {
  const merged = [];
  for (const alarm of [...primary, ...fallback]) {
    if (!alarm || !alarm.occurredAtMs) continue;
    const duplicate = merged.some((existing) =>
      existing.id === alarm.id || Math.abs(existing.occurredAtMs - alarm.occurredAtMs) <= 3_000
    );
    if (!duplicate) merged.push(alarm);
  }
  return merged.sort((a, b) => a.occurredAtMs - b.occurredAtMs);
}

function buildAlarmSourceHealthPatch(alarms = [], {
  cloudAvailable = false,
  deviceLogAvailable = false,
  checkedAt = Date.now(),
  previous = {},
} = {}) {
  const latestByType = {
    motion: Number(previous.lastMotionAlarmAt) || 0,
    pet: Number(previous.lastPetAlarmAt) || 0,
    human: Number(previous.lastHumanAlarmAt) || 0,
  };
  for (const alarm of Array.isArray(alarms) ? alarms : []) {
    const sourceType = String(alarm?.sourceType || "unknown");
    if (!Object.prototype.hasOwnProperty.call(latestByType, sourceType)) continue;
    latestByType[sourceType] = Math.max(latestByType[sourceType], Number(alarm?.occurredAtMs) || 0);
  }
  return {
    lastMotionAlarmAt: latestByType.motion,
    lastPetAlarmAt: latestByType.pet,
    lastHumanAlarmAt: latestByType.human,
    officialAlarmSource: cloudAvailable && deviceLogAvailable
      ? "cloud+device-log"
      : cloudAvailable ? "cloud" : deviceLogAvailable ? "device-log" : "none",
    officialAlarmCheckedAt: Number(checkedAt) || Date.now(),
  };
}

function isPlaybackSpeedFallbackError(error) {
  const message = String(error && error.message ? error.message : error);
  return /speed\s*(?:is\s*)?(?:not\s*)?supported|unsupported\s*speed|FEED_ANALYSIS_HLS_TRANSPORT_MISMATCH/i.test(message);
}

async function settlePlaybackChannel(device) {
  const sleep = typeof device?.sleepImpl === "function"
    ? device.sleepImpl.bind(device)
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await sleep(PLAYBACK_CHANNEL_SETTLE_MS);
}

function buildCandidateRanges(frames = [], durationSec = 0, options = {}) {
  const sampleSeconds = Math.max(0.5, Number(options.sampleSeconds) || 2);
  const mergeGapSeconds = Math.max(sampleSeconds, Number(options.mergeGapSeconds) || sampleSeconds * 3);
  const paddingBeforeSeconds = Math.max(0, Number(options.paddingBeforeSeconds) || 8);
  const paddingAfterSeconds = Math.max(0, Number(options.paddingAfterSeconds) || 12);
  const clipEnd = Math.max(0, Number(durationSec) || 0);
  const catOffsets = (Array.isArray(frames) ? frames : [])
    .filter((frame) => frame && frame.hasCat === true)
    .map((frame) => Number(frame.offsetSec ?? frame.second))
    .filter((offset) => Number.isFinite(offset) && offset >= 0 && (!clipEnd || offset <= clipEnd))
    .sort((left, right) => left - right);
  if (catOffsets.length === 0) return [];

  const rawRanges = [];
  let first = catOffsets[0];
  let last = first;
  for (const offset of catOffsets.slice(1)) {
    if (offset - last <= mergeGapSeconds) {
      last = offset;
      continue;
    }
    rawRanges.push({ first, last });
    first = offset;
    last = offset;
  }
  rawRanges.push({ first, last });

  const padded = rawRanges.map((range) => {
    const startSec = Math.max(0, range.first - paddingBeforeSeconds);
    const endSec = clipEnd
      ? Math.min(clipEnd, range.last + sampleSeconds + paddingAfterSeconds)
      : range.last + sampleSeconds + paddingAfterSeconds;
    return { startSec, endSec, durationSec: Math.max(0, endSec - startSec) };
  }).filter((range) => range.durationSec > 0);

  return padded.reduce((merged, range) => {
    const previous = merged.at(-1);
    if (!previous || range.startSec > previous.endSec) {
      merged.push(range);
      return merged;
    }
    previous.endSec = Math.max(previous.endSec, range.endSec);
    previous.durationSec = previous.endSec - previous.startSec;
    return merged;
  }, []);
}

function alarmOccurredAtMs(alarm = {}) {
  const explicit = Number(alarm.occurredAtMs);
  if (explicit > 0) return explicit;
  const parsed = parseLocalDateTime(
    alarm.occurredAt || alarm.AlarmTime || alarm.alarmTime || alarm.time || ""
  );
  return parsed ? parsed.getTime() : 0;
}

function buildRollingAlarmAnalysisWindow({
  alarms = [],
  analyzedThroughMs = 0,
  pendingFromMs = 0,
  pendingThroughMs = 0,
  lookbackMs = ALARM_ANALYSIS_LOOKBACK_MS,
  overlapMs = ALARM_ANALYSIS_OVERLAP_MS,
  maxWindowMs = ALARM_ANALYSIS_MAX_WINDOW_MS,
} = {}) {
  const alarmTimes = (Array.isArray(alarms) ? alarms : [])
    .map(alarmOccurredAtMs)
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const coveredThrough = Math.max(0, Number(analyzedThroughMs) || 0);
  const pendingEnd = Math.max(0, Number(pendingThroughMs) || 0);
  const alarmEnd = alarmTimes.at(-1) || 0;
  const requestedThroughMs = Math.max(pendingEnd, alarmEnd);
  if (!requestedThroughMs || requestedThroughMs <= coveredThrough) return null;

  const proposedStarts = [];
  const pendingStart = Math.max(0, Number(pendingFromMs) || 0);
  if (pendingStart) proposedStarts.push(pendingStart);
  if (alarmTimes.length > 0) {
    proposedStarts.push(alarmTimes[0] - Math.max(0, Number(lookbackMs) || 0));
  }
  let startMs = proposedStarts.length > 0
    ? Math.min(...proposedStarts)
    : requestedThroughMs - Math.max(0, Number(lookbackMs) || 0);
  if (coveredThrough > 0) {
    startMs = Math.max(startMs, coveredThrough - Math.max(0, Number(overlapMs) || 0));
  }
  const endMs = Math.min(
    requestedThroughMs,
    startMs + Math.max(1, Number(maxWindowMs) || ALARM_ANALYSIS_MAX_WINDOW_MS)
  );
  if (startMs >= endMs) return null;
  return {
    startMs,
    endMs,
    requestedThroughMs,
    beginTime: formatLocalDateTime(new Date(startMs)),
    endTime: formatLocalDateTime(new Date(endMs)),
  };
}

function clipRecordingToWindow(recording = {}, window = {}) {
  const recordingBegin = parseLocalDateTime(recording.BeginTime || recording.beginTime || "");
  const recordingEnd = parseLocalDateTime(recording.EndTime || recording.endTime || "");
  const windowBegin = parseLocalDateTime(window.beginTime || "");
  const windowEnd = parseLocalDateTime(window.endTime || "");
  if (!recordingBegin || !recordingEnd || !windowBegin || !windowEnd) return null;
  const beginMs = Math.max(recordingBegin.getTime(), windowBegin.getTime());
  const endMs = Math.min(recordingEnd.getTime(), windowEnd.getTime());
  if (endMs <= beginMs) return null;
  const beginTime = formatLocalDateTime(new Date(beginMs));
  const endTime = formatLocalDateTime(new Date(endMs));
  return {
    ...recording,
    BeginTime: beginTime,
    EndTime: endTime,
    beginTime,
    endTime,
    durationSec: Math.round((endMs - beginMs) / 1000),
    alarmAnalysisWindow: {
      beginTime: window.beginTime,
      endTime: window.endTime,
    },
  };
}

function shiftRecordingStart(recording = {}, offsetSeconds = 0) {
  const begin = parseLocalDateTime(recording.BeginTime || recording.beginTime || "");
  const end = parseLocalDateTime(recording.EndTime || recording.endTime || "");
  const offsetMs = Math.max(0, Number(offsetSeconds) || 0) * 1000;
  if (!begin || !end || begin.getTime() + offsetMs >= end.getTime()) return null;
  const beginTime = formatLocalDateTime(new Date(begin.getTime() + offsetMs));
  const endTime = formatLocalDateTime(end);
  return {
    ...recording,
    BeginTime: beginTime,
    EndTime: endTime,
    beginTime,
    endTime,
    durationSec: Math.max(0, Math.round((end.getTime() - begin.getTime() - offsetMs) / 1000)),
  };
}

function padRecordingForStableReplay(recording = {}, originalRecording = {}) {
  const targetBegin = parseLocalDateTime(recording.BeginTime || recording.beginTime || "");
  const targetEnd = parseLocalDateTime(recording.EndTime || recording.endTime || "");
  const sourceBegin = parseLocalDateTime(
    originalRecording.BeginTime || originalRecording.beginTime || ""
  );
  if (!targetBegin || !targetEnd || !sourceBegin) return recording;
  const paddedBeginMs = Math.max(
    sourceBegin.getTime(),
    targetBegin.getTime() - REPLAY_LEAD_PADDING_SECONDS * 1000
  );
  const beginTime = formatLocalDateTime(new Date(paddedBeginMs));
  const endTime = formatLocalDateTime(targetEnd);
  return {
    ...recording,
    BeginTime: beginTime,
    EndTime: endTime,
    beginTime,
    endTime,
    durationSec: Math.max(0, Math.round((targetEnd.getTime() - paddedBeginMs) / 1000)),
    analysisTargetWindow: {
      beginTime: formatLocalDateTime(targetBegin),
      endTime: formatLocalDateTime(targetEnd),
    },
  };
}

function trimAnalysisToTargetWindow(analysis = {}, recording = {}) {
  const sourceBegin = parseLocalDateTime(recording.BeginTime || recording.beginTime || "");
  const targetBegin = parseLocalDateTime(recording.analysisTargetWindow?.beginTime || "");
  const targetEnd = parseLocalDateTime(recording.analysisTargetWindow?.endTime || "");
  if (!sourceBegin || !targetBegin || !targetEnd) return analysis;
  const trimStartSec = Math.max(0, (targetBegin.getTime() - sourceBegin.getTime()) / 1000);
  const targetDurationSec = Math.max(0, (targetEnd.getTime() - targetBegin.getTime()) / 1000);
  const trimItems = (items) => (Array.isArray(items) ? items : [])
    .map((item) => {
      const offset = Number(item?.offsetSec ?? item?.second);
      if (!Number.isFinite(offset)) return null;
      const rebased = offset - trimStartSec;
      if (rebased < 0 || rebased >= targetDurationSec) return null;
      return { ...item, offsetSec: rebased, second: rebased };
    })
    .filter(Boolean);
  const frames = trimItems(analysis.frames);
  const markers = trimItems(analysis.markers);
  return {
    ...analysis,
    frames,
    markers,
    hasCat: frames.some((frame) => frame.hasCat === true),
    hasFeeding: markers.some((marker) => marker.hasFeeding === true || marker.markerType === "feeding"),
    analysisTargetWindow: {
      beginTime: formatLocalDateTime(targetBegin),
      endTime: formatLocalDateTime(targetEnd),
      trimStartSec,
      durationSec: targetDurationSec,
    },
  };
}

function buildStructuredFeedingClip(clip = {}, structuredKey = "") {
  const feedingStats = sanitizeFeedingStats(clip.feedingStats);
  const cleanStats = feedingStats
    ? {
        ...feedingStats,
        source: {
          durationSec: Number(feedingStats.source?.durationSec) || Number(clip.durationSec) || 0,
          orientation: String(feedingStats.source?.orientation || "none"),
          range: feedingStats.source?.range || {
            startTime: String(clip.beginTime || ""),
            endTime: String(clip.endTime || ""),
          },
        },
      }
    : null;
  const markers = (Array.isArray(clip.markers) ? clip.markers : [])
    .filter((marker) => marker && typeof marker === "object" && !Array.isArray(marker))
    .map((marker) => sanitizeAnalysisMarker(marker))
    .map((marker) => ({
      eventId: String(marker.eventId || ""),
      markerType: String(marker.markerType || ""),
      target: String(marker.target || ""),
      markerTsMs: Math.max(0, Number(marker.markerTsMs) || 0),
      beginTime: String(marker.beginTime || ""),
      endTime: String(marker.endTime || marker.beginTime || ""),
      offsetSec: Math.max(0, Number(marker.offsetSec) || 0),
      confidence: Math.max(0, Math.min(1, Number(marker.confidence) || 0)),
      playbackParams: sanitizePlaybackParams(marker.playbackParams, {
        startTime: clip.beginTime,
        endTime: clip.endTime,
      }),
    }));
  return {
    dataKind: "feeding_fact",
    id: String(structuredKey || clip.id || ""),
    recordingKey: String(structuredKey || clip.recordingKey || ""),
    beginTime: String(clip.beginTime || ""),
    endTime: String(clip.endTime || ""),
    durationSec: Math.max(0, Number(clip.durationSec) || 0),
    playbackParams: sanitizePlaybackParams(clip.playbackParams, {
      startTime: clip.beginTime,
      endTime: clip.endTime,
    }),
    catId: typeof clip.catId === "string" && clip.catId ? clip.catId : null,
    isEffective: clip.isEffective === true,
    hasCat: clip.hasCat === true,
    hasFeeding: clip.hasFeeding === true,
    analysisConfidence: Math.max(0, Math.min(1, Number(clip.analysisConfidence) || 0)),
    bowlRoi: clip.bowlRoi || null,
    markers,
    feedingStats: cleanStats,
    analysisUpdatedAt: Math.max(0, Number(clip.analysisUpdatedAt) || Date.now()),
  };
}

function splitRecordingForAnalysis(recording = {}, options = {}) {
  const maxSeconds = Math.max(60, Number(options.maxSeconds) || ANALYSIS_SEGMENT_SECONDS);
  const overlapSeconds = Math.max(
    0,
    Math.min(maxSeconds - 1, Number(options.overlapSeconds) || ANALYSIS_SEGMENT_OVERLAP_SECONDS)
  );
  const beginValue = recording.BeginTime || recording.beginTime || "";
  const endValue = recording.EndTime || recording.endTime || "";
  const begin = parseLocalDateTime(beginValue);
  const end = parseLocalDateTime(endValue);
  if (!begin || !end || end <= begin || (end - begin) / 1000 <= maxSeconds) return [recording];
  const segments = [];
  let cursorMs = begin.getTime();
  let index = 0;
  while (cursorMs < end.getTime()) {
    const segmentEndMs = Math.min(end.getTime(), cursorMs + maxSeconds * 1000);
    const segment = {
      ...recording,
      BeginTime: formatLocalDateTime(new Date(cursorMs)),
      EndTime: formatLocalDateTime(new Date(segmentEndMs)),
      beginTime: formatLocalDateTime(new Date(cursorMs)),
      endTime: formatLocalDateTime(new Date(segmentEndMs)),
      durationSec: Math.round((segmentEndMs - cursorMs) / 1000),
      analysisSegment: {
        index,
        sourceBeginTime: beginValue,
        sourceEndTime: endValue,
      },
    };
    segments.push(segment);
    if (segmentEndMs >= end.getTime()) break;
    cursorMs = segmentEndMs - overlapSeconds * 1000;
    index += 1;
  }
  return segments;
}

function expandRecordingsForAnalysis(recordings = []) {
  return (Array.isArray(recordings) ? recordings : []).flatMap((recording) =>
    splitRecordingForAnalysis(recording)
  );
}

function assertAnalysisSucceeded(analysis = {}) {
  if (analysis.error || analysis.analysisStatus === "failed") {
    throw new Error(`VISION_ANALYSIS_FAILED: ${analysis.error || "unknown"}`);
  }
}

function isRetryableAnalysisError(error) {
  const message = String(error && error.message ? error.message : error);
  return /This operation was aborted|AbortError|ETIMEDOUT|ECONNRESET|EAI_AGAIN|VISION_HTTP_5\d\d|HLS_TRANSCODE_NOT_READY|VISION_ANALYSIS_FAILED:\s*VIDEO_(?:OPEN|READ)_FAILED/i.test(message);
}

function isVisionSourceReadError(error) {
  const message = String(error && error.message ? error.message : error);
  return /VISION_ANALYSIS_FAILED:\s*VIDEO_(?:OPEN|READ)_FAILED/i.test(message);
}

function deviceUnavailableError(cause) {
  const error = new Error("DEVICE_UNAVAILABLE");
  error.code = "DEVICE_UNAVAILABLE";
  error.cause = cause;
  return error;
}

function buildHlsPlaybackAttempts(baseOptions = {}) {
  const requestedSpeed = Math.min(8, Math.max(1, Number(baseOptions.speed) || 8));
  const speeds = [requestedSpeed, 4, 2, 1]
    .filter((speed, index, values) => speed <= requestedSpeed && values.indexOf(speed) === index);
  return speeds.map((speed) => ({
    ...baseOptions,
    mediaType: "hls",
    protocol: "hls",
    speed,
  }));
}

function analysisPausedForUserPlaybackError() {
  const error = new Error("ANALYSIS_PAUSED_FOR_USER_PLAYBACK");
  error.code = "ANALYSIS_PAUSED_FOR_USER_PLAYBACK";
  return error;
}

async function getHlsPlaybackUrlWithSpeedFallback(
  device,
  record,
  baseOptions,
  logger = console,
  shouldAbort = null
) {
  const attempts = buildHlsPlaybackAttempts(baseOptions);
  let lastError = null;
  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    if (shouldAbort?.()) throw analysisPausedForUserPlaybackError();
    const options = attempts[attemptIndex];
    try {
      const sourceUrl = await device.getPlaybackUrl(record, { ...options, retryOccupied: false });
      const scheme = String(sourceUrl || "").split(":", 1)[0].toLowerCase();
      if (scheme !== "http" && scheme !== "https") {
        const mismatch = new Error("FEED_ANALYSIS_HLS_TRANSPORT_MISMATCH");
        mismatch.code = "FEED_ANALYSIS_HLS_TRANSPORT_MISMATCH";
        throw mismatch;
      }
      logger?.info?.("[feed-analysis] playback source acquired", {
        attempt: attemptIndex + 1,
        speed: Number(options.speed) || 1,
        streamType: Number(options.streamType) || 0,
        transport: `${options.mediaType}-${options.protocol}`,
        scheme,
      });
      return sourceUrl;
    } catch (error) {
      lastError = error;
      if (isPlaybackChannelOccupied(error) && typeof device.closeLivestream === "function") {
        try {
          if (shouldAbort?.()) throw analysisPausedForUserPlaybackError();
          await device.closeLivestream(Number(options.channel) || 0, Number(options.streamType) || 1);
          await settlePlaybackChannel(device);
          if (shouldAbort?.()) throw analysisPausedForUserPlaybackError();
          const sourceUrl = await device.getPlaybackUrl(record, {
            ...options,
            retryOccupied: false,
          });
          const scheme = String(sourceUrl || "").split(":", 1)[0].toLowerCase();
          if (scheme !== "http" && scheme !== "https") {
            throw new Error("FEED_ANALYSIS_HLS_TRANSPORT_MISMATCH");
          }
          logger?.info?.("[feed-analysis] stale playback channel recovered", {
            attempt: attemptIndex + 1,
            speed: Number(options.speed) || 1,
            streamType: Number(options.streamType) || 0,
          });
          return sourceUrl;
        } catch (retryError) {
          lastError = retryError;
        }
      }
      logger?.warn?.("[feed-analysis] hls playback source rejected", {
        attempt: attemptIndex + 1,
        speed: Number(options.speed) || 1,
        streamType: Number(options.streamType) || 0,
        error: lastError?.code || lastError?.message || String(lastError),
      });
      if (!isPlaybackSpeedFallbackError(lastError) || attemptIndex >= attempts.length - 1) {
        throw lastError;
      }
    }
  }
  throw lastError || new Error("FEED_ANALYSIS_HLS_PLAYBACK_URL_FAILED");
}

function fallbackSnapshotAnalysis(error) {
  return {
    hasCat: false,
    hasFeeding: false,
    analysisConfidence: 0,
    bowlRoi: null,
    markers: [],
    error: error && error.message ? error.message : String(error || ""),
  };
}

function firstFeedingStartMarker(analysis = {}) {
  return (analysis.markers || []).find((item) => item.markerType === "feeding_start") || null;
}

function clockText(value) {
  return typeof value === "string" && value.length >= 16 ? value.slice(11, 16) : "刚刚";
}

class FeedAnalysisCoordinator {
  constructor({
    enabled = true,
    store,
    deviceFactory,
    analyzer,
    nowProvider,
    pollIntervalMs = 60 * 1000,
    detectionTarget = "face",
    detectorBackend = "auto",
    yoloModel = "",
    globalConcurrency = 2,
    playbackSpeed = 8,
    playbackStreamType = 1,
    orientation = "clockwise-90",
    screeningSampleSeconds = 2,
    alarmCompensationLookbackMs = 15 * 60 * 1000,
    alarmCompensationIntervalMs = 15 * 60 * 1000,
    automationEnabled = true,
    retryDelayMs = 60 * 1000,
    maxRetries = 3,
    materialSyncMaxAttempts = 10,
    queueWarningAgeMs = 5 * 60 * 1000,
    queueWarningCooldownMs = 60 * 1000,
    snapshotFallbackConfidence = 0.35,
    feedingStartEnabled = true,
    feedingStartWindowMs = 30 * 1000,
    feedingStartMaxWindowMs = 45 * 1000,
    feedingStartPreRollMs = 15 * 1000,
    feedingStartMinWindowMs = 20 * 1000,
    feedingStartCandidateTtlMs = 2 * 60 * 1000,
    feedingStartRearmQuietMs = 10 * 60 * 1000,
    feedingStartExtensionMs = 10 * 1000,
    feedingStartConfirmationPolicy = DEFAULT_FEEDING_START_CONFIRMATION_POLICY,
    alarmAdapter,
    alarmCallbackBaseUrl = "",
    alarmCallbackToken = "",
    resolveAnalysisSourceUrl,
    notifier,
    deviceNotificationDispatcher,
    pushPlusBindingService,
    notificationOwnerOpenid = "",
    persistAnalyzedClip,
    persistentSettingsStore,
    persistentAnalysisStore,
    logger = console,
  } = {}) {
    this.enabled = enabled !== false;
    this.store =
      store ||
      new FeedAnalysisStore(path.join(__dirname, "../../data/feed-analysis-state.json"));
    this.deviceFactory =
      deviceFactory ||
      (async () => {
        throw new Error("deviceFactory is required");
      });
    this.analyzer = analyzer || new VisionWorkerAnalyzer();
    this.nowProvider = nowProvider || (() => new Date());
    this.pollIntervalMs = pollIntervalMs;
    this.automationEnabled = automationEnabled !== false;
    this.detectionTarget = detectionTarget;
    this.detectorBackend = detectorBackend;
    this.yoloModel = yoloModel;
    this.playbackSpeed = Math.min(8, Math.max(1, Number(playbackSpeed) || 8));
    this.playbackStreamType = Math.max(0, Number(playbackStreamType) || 0);
    this.orientation = ["none", "clockwise-90"].includes(
      String(orientation || "").trim().toLowerCase()
    )
      ? String(orientation).trim().toLowerCase()
      : "clockwise-90";
    this.screeningSampleSeconds = Math.min(
      10,
      Math.max(1, Number(screeningSampleSeconds) || 2)
    );
    this.alarmCompensationLookbackMs = Math.max(
      60 * 1000,
      Number(alarmCompensationLookbackMs) || 15 * 60 * 1000
    );
    this.alarmCompensationIntervalMs = Math.max(
      60 * 1000,
      Number(alarmCompensationIntervalMs) || 15 * 60 * 1000
    );
    this.resolveAnalysisSourceUrl =
      typeof resolveAnalysisSourceUrl === "function"
        ? resolveAnalysisSourceUrl
        : async ({ sourceUrl }) => sourceUrl;
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
    this.maxRetries = Math.max(0, Number(maxRetries) || 0);
    this.materialSyncMaxAttempts = Math.max(1, Number(materialSyncMaxAttempts) || 10);
    this.queueWarningAgeMs = Math.max(0, Number(queueWarningAgeMs) || 5 * 60 * 1000);
    this.queueWarningCooldownMs = Math.max(0, Number(queueWarningCooldownMs) || 60 * 1000);
    this.lastQueueWarningAt = 0;
    this.snapshotFallbackConfidence = Math.max(
      0,
      Number(snapshotFallbackConfidence) || 0.35
    );
    this.feedingStartEnabled = feedingStartEnabled !== false;
    this.feedingStartWindowMs = Math.max(20 * 1000, Number(feedingStartWindowMs) || 30 * 1000);
    this.feedingStartMaxWindowMs = Math.max(
      this.feedingStartWindowMs,
      Number(feedingStartMaxWindowMs) || 45 * 1000
    );
    this.feedingStartPreRollMs = Math.max(0, Number(feedingStartPreRollMs) || 15 * 1000);
    this.feedingStartMinWindowMs = Math.max(8 * 1000, Number(feedingStartMinWindowMs) || 20 * 1000);
    this.feedingStartCandidateTtlMs = Math.max(
      this.feedingStartMaxWindowMs,
      Number(feedingStartCandidateTtlMs) || 2 * 60 * 1000
    );
    this.feedingStartRearmQuietMs = Math.max(
      60 * 1000,
      Number(feedingStartRearmQuietMs) || 10 * 60 * 1000
    );
    this.feedingStartExtensionMs = Math.max(5 * 1000, Number(feedingStartExtensionMs) || 10 * 1000);
    this.feedingStartConfirmationPolicy = {
      ...DEFAULT_FEEDING_START_CONFIRMATION_POLICY,
      ...(feedingStartConfirmationPolicy && typeof feedingStartConfirmationPolicy === "object"
        ? feedingStartConfirmationPolicy
        : {}),
    };
    this.deviceProvider = null;
    this.alarmAdapter = alarmAdapter === false
      ? null
      : alarmAdapter || new AlarmScanAdapter();
    this.alarmCallbackBaseUrl = String(alarmCallbackBaseUrl || "").replace(/\/+$/, "");
    this.alarmCallbackToken = String(alarmCallbackToken || "").trim();
    this.motionAlarmSink = null;
    this.notifier = notifier || null;
    this.deviceNotificationDispatcher = deviceNotificationDispatcher || null;
    this.pushPlusBindingService = pushPlusBindingService || null;
    this.notificationOwnerOpenid = String(notificationOwnerOpenid || "").trim();
    this.persistAnalyzedClip = typeof persistAnalyzedClip === "function"
      ? persistAnalyzedClip
      : async () => {};
    this.logger = logger;
    this.persistentSettingsStore = persistentSettingsStore || null;
    this.persistentAnalysisStore = persistentAnalysisStore || null;
    this.deliveredNotificationIds = new Set();
    this.queue = new AnalysisQueue({
      globalConcurrency,
      processTask: (task) => this.processQueueTask(task),
      logger,
    });
    this.materialSyncQueue = new AnalysisQueue({
      globalConcurrency: 1,
      processTask: (task) => this.processMaterialSyncTask(task),
      logger,
    });
    this.pausedDevices = new Map();
    this.globalPauseUntil = 0;
    this.timer = null;
  }

  async initialize() {
    await this.persistentSettingsStore?.initialize?.();
    if (this.persistentAnalysisStore) {
      try { await this.persistentAnalysisStore.initialize?.(); }
      catch (error) { this.logger?.warn?.("[feed-analysis] durable recording store unavailable", { error: error.message }); }
    }
    const settings = this.persistentSettingsStore ? await this.persistentSettingsStore.loadAll() : [];
    for (const item of settings) {
      if (!item?.deviceSn) continue;
      this.store.updateSettings(item, item.deviceSn);
    }
    const bindings = typeof this.persistentSettingsStore?.loadBindings === "function"
      ? await this.persistentSettingsStore.loadBindings()
      : [];
    for (const binding of bindings) this.store.savePushPlusBinding?.(binding);
    let durableRecordings = [];
    if (this.persistentAnalysisStore) {
      try {
        durableRecordings = await this.persistentAnalysisStore.loadAll();
      } catch (error) {
        this.logger?.warn?.("[feed-analysis] durable recording restore failed", { error: error.message });
      }
    }
    const restoredRecordings = durableRecordings.map((item) => (
      item.status === "running" ? { ...item, status: "queued", updatedAt: Date.now() } : item
    ));
    this.store.restoreAnalysisRecords?.(restoredRecordings);
    for (let index = 0; index < restoredRecordings.length; index += 1) {
      const item = restoredRecordings[index];
      const durableItem = durableRecordings[index];
      if (item.status === "queued" && durableItem?.status === "running") {
        await this.persistentAnalysisStore.upsert(item);
      }
      if (item.status === "queued" && item.recording && typeof item.recording === "object") {
        this.enqueueRecording({
          deviceSn: item.deviceSn,
          date: item.date,
          recordingKey: item.recordingKey,
          recording: item.recording,
          reason: "recovery",
        });
      }
    }
    const durableDeviceSns = new Set(settings.map((item) => String(item?.deviceSn || "")).filter(Boolean));
    const devices = typeof this.deviceProvider?.listDevices === "function"
      ? await this.deviceProvider.listDevices()
      : [];
    let bootstrapped = 0;
    for (const device of devices) {
      const deviceSn = String(device?.sn || "").trim();
      if (!deviceSn || durableDeviceSns.has(deviceSn)) continue;
      await this.persistSettings({
        deviceSn,
        openid: String(device?.ownerOpenid || "").trim(),
        analysisEnabled: true,
        notifyEnabled: true,
      });
      bootstrapped += 1;
    }
    return { restored: settings.length, restoredBindings: bindings.length, restoredRecordings: restoredRecordings.length, bootstrapped };
  }

  setDeviceNotificationDispatcher(dispatcher) {
    this.deviceNotificationDispatcher = dispatcher || null;
  }

  async persistSettings(settings = {}) {
    const deviceSn = String(settings.deviceSn || "").trim();
    const stored = this.store.updateSettings(settings, deviceSn);
    if (this.persistentSettingsStore) await this.persistentSettingsStore.upsert(stored);
    return stored;
  }

  async persistLocalAnalysisRecord(deviceSn, recordingKey) {
    if (!this.persistentAnalysisStore || typeof this.store.getAnalysisRecord !== "function") return null;
    const record = this.store.getAnalysisRecord(deviceSn, recordingKey);
    return record ? this.persistentAnalysisStore.upsert(record) : null;
  }

  setDeviceProvider(deviceProvider) {
    this.deviceProvider = deviceProvider || null;
  }

  setMotionAlarmSink(sink) {
    this.motionAlarmSink = typeof sink === "function" ? sink : null;
  }

  hydrateMotionAlarmPictures(device, deviceSn, alarms = []) {
    if (!this.motionAlarmSink || typeof device?.getAlarmPicUrl !== "function") return;
    const candidates = (Array.isArray(alarms) ? alarms : [])
      .filter((alarm) => alarm && !alarm.snapshotUrl && !alarm.imageUrl && !alarm.picUrl)
      .slice(-12);
    if (candidates.length === 0) return;
    Promise.all(candidates.map(async (alarm) => {
      try {
        const snapshotUrl = await device.getAlarmPicUrl(alarm);
        return snapshotUrl ? { ...alarm, snapshotUrl } : null;
      } catch (error) {
        return null;
      }
    })).then((hydrated) => {
      const ready = hydrated.filter(Boolean);
      if (ready.length > 0) return this.motionAlarmSink(deviceSn, ready);
      return null;
    }).catch((error) => {
      this.logger?.warn?.("[feed-analysis] alarm picture hydration failed", {
        deviceSn,
        error: error?.message || String(error),
      });
    });
  }

  getConfiguredBowlRoi(deviceSn = "") {
    if (typeof this.store.getBowlRoi === "function") {
      return this.store.getBowlRoi(deviceSn);
    }
    const settings = this.store.getSettings(deviceSn);
    if (settings.deviceSn && deviceSn && settings.deviceSn !== deviceSn) return null;
    return settings.bowlRoi || null;
  }

  async bootstrapOfficialConfig(device, deviceSn = "") {
    const sn = String(deviceSn || device.sn || "");
    const settings = this.store.getSettings(sn);
    if (typeof device.getConfig !== "function") {
      if (settings.officialAlarmStatus !== "ready"
        || Number(settings.officialAlarmProfileVersion) !== OFFICIAL_ALARM_PROFILE_VERSION) {
        const officialAlarm = await this.bootstrapOfficialAlarm(device);
        return this.store.updateSettings({
          officialAlarmStatus: officialAlarm.status,
          officialAlarmConfigNames: officialAlarm.enabledNames,
          officialAlarmProfileVersion: OFFICIAL_ALARM_PROFILE_VERSION,
        }, sn);
      }
      return settings;
    }
    const checkedAt = Number(settings.motionDeliveryCheckedAt) || 0;
    if (settings.officialConfigStatus === "ready" && Date.now() - checkedAt < 6 * 60 * 60 * 1000) {
      if (settings.officialAlarmStatus !== "ready"
        || Number(settings.officialAlarmProfileVersion) !== OFFICIAL_ALARM_PROFILE_VERSION) {
        const officialAlarm = await this.bootstrapOfficialAlarm(device);
        return this.store.updateSettings({
          officialAlarmStatus: officialAlarm.status,
          officialAlarmConfigNames: officialAlarm.enabledNames,
          officialAlarmProfileVersion: OFFICIAL_ALARM_PROFILE_VERSION,
        }, sn);
      }
      return settings;
    }
    let motionConfig = await device.getConfig("Detect.MotionDetect");
    const recordConfig = settings.officialConfigStatus !== "ready"
      ? await device.getConfig("Record")
      : null;
    if (!motionAlarmDeliveryEnabled(motionConfig)) {
      await device.setConfig({
        Name: "Detect.MotionDetect",
        ...enableMotionDetectConfig(motionConfig),
      });
      motionConfig = await device.getConfig("Detect.MotionDetect");
    }
    const motionDeliveryEnabled = motionAlarmDeliveryEnabled(motionConfig);
    if (recordConfig) {
      await device.setConfig({
        Name: "Record",
        ...tuneRecordConfig(recordConfig),
      });
    }
    const officialAlarm = settings.officialAlarmStatus === "ready"
      && Number(settings.officialAlarmProfileVersion) === OFFICIAL_ALARM_PROFILE_VERSION
      ? { status: "ready", enabledNames: settings.officialAlarmConfigNames || [] }
      : await this.bootstrapOfficialAlarm(device);
    return this.store.updateSettings({
      officialConfigStatus: motionDeliveryEnabled ? "ready" : "motion-unverified",
      motionDeliveryEnabled,
      motionDeliveryStatus: motionDeliveryEnabled ? "ready" : "unverified",
      motionDeliveryError: motionDeliveryEnabled ? "" : "MOTION_CONFIG_READBACK_FAILED",
      motionDeliveryCheckedAt: Date.now(),
      officialAlarmStatus: officialAlarm.status,
      officialAlarmConfigNames: officialAlarm.enabledNames,
      officialAlarmProfileVersion: OFFICIAL_ALARM_PROFILE_VERSION,
    }, sn);
  }

  async bootstrapOfficialAlarm(device) {
    const result = { enabledNames: [], status: "ready" };
    if (typeof device.subscribeAlarmMessages === "function") {
      try {
        const callbackUrl = this.buildAlarmCallbackUrl(device.sn || "");
        await device.subscribeAlarmMessages({
          alarmTypes: ["MotionDetect"],
          ...(callbackUrl ? { callbackUrl } : {}),
        });
      } catch (error) {
        result.status = "subscribe-error";
      }
    }
    if (typeof device.getAbility !== "function") return result;

    let ability = null;
    try {
      ability = await device.getAbility("Intelligent");
    } catch (error) {
      return result;
    }

    const names = resolveLiveObjectAlarmConfigNames(ability).filter((name) => name !== "Detect.MotionDetect");
    for (const name of names) {
      try {
        const config = await device.getConfig(name);
        await device.setConfig(buildLiveObjectAlarmConfigPayload(name, config));
        result.enabledNames.push(name);
      } catch (error) {
        // Firmware variants expose different intelligent-alarm config names.
      }
    }
    return result;
  }

  buildAlarmCallbackUrl(deviceSn = "") {
    if (!this.alarmCallbackBaseUrl || !this.alarmCallbackToken || !deviceSn) return "";
    return `${this.alarmCallbackBaseUrl}/${encodeURIComponent(this.alarmCallbackToken)}/${encodeURIComponent(deviceSn)}`;
  }

  async ingestOfficialAlarmCallback({ deviceSn = "", rawAlarms = [] } = {}) {
    const sn = String(deviceSn || "").trim();
    if (!sn) return { ok: false, error: "DEVICE_SN_REQUIRED" };
    const alarms = selectNewLiveObjectAlarms(rawAlarms, { afterMs: 0 });
    if (alarms.length === 0) return { ok: true, alarms: [], queued: false };
    await this.motionAlarmSink?.(sn, alarms);
    let device = null;
    try { device = await this.deviceProvider?.getDevice?.(sn); }
    catch (error) { this.logger?.warn?.("[feed-analysis] alarm callback device unavailable", { deviceSn: sn }); }
    if (device) this.hydrateMotionAlarmPictures(device, sn, alarms);
    const queued = await this.registerFeedingStartAlarms({
      device,
      deviceSn: sn,
      alarms,
      now: this.nowProvider(),
    });
    const latestAlarmAt = Math.max(...alarms.map((alarm) => alarm.occurredAtMs));
    const settings = this.store.getSettings(sn);
    await this.persistSettings({
      ...settings,
      deviceSn: sn,
      lastOfficialAlarmAt: Math.max(Number(settings.lastOfficialAlarmAt) || 0, latestAlarmAt),
      lastOfficialAlarmScanAt: Date.now(),
      officialAlarmStatus: "ready",
      officialAlarmError: "",
    });
    return { ok: true, alarms, queued: queued?.queued === true };
  }

  async syncNow({ force = false, date = "", device: providedDevice = null, deviceSn: inputDeviceSn = "" } = {}) {
    if (!this.enabled) return { ok: true, skipped: true, disabled: true };
    const settings = this.store.getSettings(inputDeviceSn);
    if (!settings.analysisEnabled && !force) {
      return { ok: true, skipped: true };
    }
    const device = providedDevice || await this.deviceFactory(inputDeviceSn || settings.deviceSn || "");
    const deviceSn = inputDeviceSn || settings.deviceSn || device.sn || "";
    await this.bootstrapOfficialConfig(device, deviceSn);
    const now = this.nowProvider();
    const candidateBatch = await this.collectCandidateRecordings(device, now, { date, force });
    if (!force && candidateBatch.analysisWindow) {
      const windowResult = await this.processAlarmWindowTask({
        device,
        deviceSn,
        alarmWindow: candidateBatch.analysisWindow,
      });
      return {
        ok: windowResult.ok !== false,
        processed: Number(windowResult.analyzed) || 0,
        records: Number(windowResult.recordings) || 0,
        alarmDriven: true,
        alarms: (candidateBatch.alarms || []).length,
        snapshots: 0,
        ...(windowResult.error ? { error: windowResult.error } : {}),
      };
    }
    const records = expandRecordingsForAnalysis(candidateBatch.records || []);
    const snapshots = candidateBatch.snapshots || [];
    let processed = 0;

    // Snapshot and replay analysis are historical/statistical work. They must
    // never emit a realtime feeding notification.

    for (const record of records) {
      const key = recordingKey(record);
      if (this.store.hasProcessed(key, deviceSn)) continue;
      const { analysis, clipDate, clip } = await this.analyzeRecording({
        device,
        recording: record,
        recordingKey: key,
        deviceSn,
      });
      await this.persistAnalyzedClip({
        deviceSn,
        date: clipDate,
        clip,
        recording: record,
      });
      if (this.persistentAnalysisStore) {
        await this.persistentAnalysisStore.upsert({
          deviceSn, date: clipDate, recordingKey: key, status: "ready",
          recording: record, clip, failureCount: 0, lastError: "",
          materialSyncStatus: "ready", materialSyncAttempts: 0,
          materialSyncError: "", updatedAt: Date.now(),
        });
      }
      this.store.upsertRecording({
        deviceSn,
        recordingKey: key,
        date: clipDate,
        clip,
      });
      processed += 1;
    }

    return {
      ok: true,
      processed,
      records: records.length,
      alarmDriven: candidateBatch.alarmDriven,
      alarms: (candidateBatch.alarms || []).length,
      snapshots: snapshots.length,
    };
  }

  async collectCandidateRecordings(device, now, options = {}) {
    const officialBatch = await this.collectOfficialAlarmCandidates(device, now, options);
    if (officialBatch.available) {
      return officialBatch;
    }
    return {
      records: await this.queryRecentRecordings(device, now, options),
      alarms: officialBatch.alarms || [],
      snapshots: [],
      alarmDriven: false,
    };
  }

  async queryRecentRecordings(device, now, { date = "" } = {}) {
    const range = dayRange(date) || (() => {
      const begin = new Date(now.getTime() - 60 * 60 * 1000);
      return {
        beginTime: formatLocalDateTime(begin),
        endTime: formatLocalDateTime(now),
      };
    })();
    return device.queryRecordings({
      beginTime: range.beginTime,
      endTime: range.endTime,
    });
  }

  enqueueDeviceDate({ force = false, date = "", device = null, deviceSn = "", priority = 0, reason = "scan" } = {}) {
    if (!this.enabled) return { ok: true, queued: false, skipped: true, disabled: true };
    const settings = this.store.getSettings(deviceSn || (device && device.sn) || "");
    if (!settings.analysisEnabled && !force) {
      return { ok: true, queued: false, skipped: true };
    }
    const scanDate = date || formatLocalDateTime(this.nowProvider()).slice(0, 10);
    const resolvedDeviceSn = deviceSn || (device && device.sn) || settings.deviceSn || "";
    return this.queue.enqueueDeviceDate({
      force,
      date: scanDate,
      device,
      deviceSn: resolvedDeviceSn,
      priority,
      reason,
    });
  }

  enqueueRecording({ force = false, date = "", device = null, deviceSn = "", recording = null, recordingKey: key = "", alarmWindow = null, retryCount = 0, priority = 0, reason = "recording" } = {}) {
    if (!this.enabled) return { ok: true, queued: false, skipped: true, disabled: true };
    const settings = this.store.getSettings(deviceSn || (device && device.sn) || "");
    if (!settings.analysisEnabled && !force) {
      return { ok: true, queued: false, skipped: true };
    }
    const resolvedKey = key || (recording ? recordingKey(recording) : "");
    const resolvedDate = date || (recording ? formatDateKey(recording.BeginTime || recording.beginTime) : "");
    const resolvedDeviceSn = deviceSn || (device && device.sn) || settings.deviceSn || "";
    if (!resolvedKey) return { ok: false, queued: false, error: "RECORDING_KEY_REQUIRED" };
    return this.queue.enqueueRecording({
      force,
      date: resolvedDate,
      device,
      deviceSn: resolvedDeviceSn,
      recording,
      recordingKey: resolvedKey,
      ...(alarmWindow ? { alarmWindow } : {}),
      retryCount: Math.max(0, Number(retryCount) || 0),
      priority,
      reason,
    });
  }

  enqueueAlarmWindow({ device = null, deviceSn = "", window = null, retryCount = 0, priority = 20 } = {}) {
    if (!window || !Number(window.endMs)) {
      return { ok: false, queued: false, error: "ALARM_WINDOW_REQUIRED" };
    }
    const resolvedDeviceSn = String(deviceSn || device?.sn || "");
    return this.queue.enqueueRecording({
      device,
      deviceSn: resolvedDeviceSn,
      date: String(window.endTime || "").slice(0, 10),
      recordingKey: `alarm-window:${Math.trunc(Number(window.endMs))}`,
      alarmWindow: window,
      retryCount: Math.max(0, Number(retryCount) || 0),
      priority,
      reason: "alarm-window",
    });
  }

  enqueueFeedingStartCandidate({ device = null, deviceSn = "", priority = 100 } = {}) {
    if (!this.feedingStartEnabled) {
      return { ok: true, queued: false, skipped: true, disabled: true };
    }
    const resolvedDeviceSn = String(deviceSn || device?.sn || "");
    return this.queue.enqueueRecording({
      device,
      deviceSn: resolvedDeviceSn,
      recordingKey: FEEDING_START_TASK_KEY,
      feedingStartCandidate: true,
      origin: "realtime_alarm",
      priority,
      reason: "feeding-start-candidate",
    });
  }

  async registerFeedingStartAlarms({ device = null, deviceSn = "", alarms = [], now = null } = {}) {
    const resolvedDeviceSn = String(deviceSn || device?.sn || "");
    const triggerAlarms = (Array.isArray(alarms) ? alarms : [])
      .filter((alarm) => isFeedingTriggerAlarm(alarm));
    const alarmTimes = triggerAlarms
      .map((alarm) => Number(alarm?.occurredAtMs) || 0)
      .filter((value) => value > 0 && Number.isFinite(value));
    if (!this.feedingStartEnabled || !resolvedDeviceSn || alarmTimes.length === 0) {
      return { ok: true, queued: false, skipped: true };
    }
    const nowValue = now instanceof Date ? now : this.nowProvider();
    const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.now();
    const earliestAlarmAtMs = Math.min(...alarmTimes);
    const latestAlarmAtMs = Math.max(...alarmTimes);
    const settings = this.store.getSettings(resolvedDeviceSn);

    if (settings.feedingStartState === "active") {
      const stored = await this.persistSettings({
        ...settings,
        deviceSn: resolvedDeviceSn,
        feedingStartLastAlarmAtMs: Math.max(
          Number(settings.feedingStartLastAlarmAtMs) || 0,
          latestAlarmAtMs
        ),
      });
      return { ok: true, queued: false, suppressed: true, settings: stored };
    }

    const continuing = settings.feedingStartState === "candidate";
    const candidateFromMs = continuing && Number(settings.feedingStartCandidateFromMs) > 0
      ? Math.min(
          Number(settings.feedingStartCandidateFromMs),
          Math.max(0, earliestAlarmAtMs - this.feedingStartPreRollMs)
        )
      : Math.max(0, earliestAlarmAtMs - this.feedingStartPreRollMs);
    const stored = await this.persistSettings({
      ...settings,
      deviceSn: resolvedDeviceSn,
      feedingStartState: "candidate",
      feedingStartCandidateFromMs: candidateFromMs,
      feedingStartCandidateThroughMs: Math.max(
        Number(settings.feedingStartCandidateThroughMs) || 0,
        nowMs
      ),
      feedingStartLastAnalyzedThroughMs: continuing
        ? Number(settings.feedingStartLastAnalyzedThroughMs) || 0
        : 0,
      feedingStartLastAlarmAtMs: Math.max(
        Number(settings.feedingStartLastAlarmAtMs) || 0,
        latestAlarmAtMs
      ),
      feedingStartConfirmedAtMs: 0,
      feedingStartEventAtMs: 0,
    });
    const queued = this.enqueueFeedingStartCandidate({
      device,
      deviceSn: resolvedDeviceSn,
    });
    return { ...queued, settings: stored };
  }

  async advanceFeedingStartState({ device = null, deviceSn = "", now = null } = {}) {
    const resolvedDeviceSn = String(deviceSn || device?.sn || "");
    if (!this.feedingStartEnabled || !resolvedDeviceSn) {
      return { ok: true, skipped: true };
    }
    const nowValue = now instanceof Date ? now : this.nowProvider();
    const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.now();
    const settings = this.store.getSettings(resolvedDeviceSn);
    const lastAlarmAtMs = Number(settings.feedingStartLastAlarmAtMs) || 0;

    if (
      settings.feedingStartState === "active" &&
      lastAlarmAtMs > 0 &&
      nowMs - lastAlarmAtMs >= this.feedingStartRearmQuietMs
    ) {
      const stored = await this.persistSettings({
        ...settings,
        deviceSn: resolvedDeviceSn,
        feedingStartState: "idle",
        feedingStartCandidateFromMs: 0,
        feedingStartCandidateThroughMs: 0,
        feedingStartLastAnalyzedThroughMs: 0,
        feedingStartConfirmedAtMs: 0,
        feedingStartEventAtMs: 0,
      });
      return { ok: true, rearmed: true, settings: stored };
    }

    if (settings.feedingStartState !== "candidate") {
      return { ok: true, skipped: true, settings };
    }
    if (lastAlarmAtMs <= 0 || nowMs - lastAlarmAtMs > this.feedingStartCandidateTtlMs) {
      const stored = await this.persistSettings({
        ...settings,
        deviceSn: resolvedDeviceSn,
        feedingStartState: "idle",
        feedingStartCandidateFromMs: 0,
        feedingStartCandidateThroughMs: 0,
        feedingStartLastAnalyzedThroughMs: 0,
      });
      return { ok: true, expired: true, settings: stored };
    }

    const lastAnalyzedThroughMs = Number(settings.feedingStartLastAnalyzedThroughMs) || 0;
    if (nowMs - lastAnalyzedThroughMs < this.feedingStartExtensionMs) {
      return { ok: true, skipped: true, settings };
    }
    const stored = await this.persistSettings({
      ...settings,
      deviceSn: resolvedDeviceSn,
      feedingStartCandidateThroughMs: Math.max(
        Number(settings.feedingStartCandidateThroughMs) || 0,
        nowMs
      ),
    });
    const queued = this.enqueueFeedingStartCandidate({ device, deviceSn: resolvedDeviceSn });
    return { ...queued, extended: true, settings: stored };
  }

  async processFeedingStartCandidateTask(task = {}) {
    const deviceSn = String(task.deviceSn || "");
    const settings = this.store.getSettings(deviceSn);
    if (!this.feedingStartEnabled || settings.feedingStartState !== "candidate") {
      return { ok: true, skipped: true, reason: "FEEDING_START_NOT_CANDIDATE" };
    }
    const throughMs = Number(settings.feedingStartCandidateThroughMs) || 0;
    if (Number(settings.feedingStartLastAnalyzedThroughMs) >= throughMs) {
      return { ok: true, skipped: true, reason: "FEEDING_START_RANGE_ALREADY_ANALYZED" };
    }
    const rawFromMs = Number(settings.feedingStartCandidateFromMs) || 0;
    const hasPriorAnalysis = Number(settings.feedingStartLastAnalyzedThroughMs) > 0;
    const analysisWindowMs = hasPriorAnalysis
      ? this.feedingStartMaxWindowMs
      : this.feedingStartWindowMs;
    const fromMs = Math.max(rawFromMs, throughMs - analysisWindowMs);
    if (throughMs <= 0 || throughMs - fromMs < this.feedingStartMinWindowMs) {
      return { ok: true, skipped: true, reason: "FEEDING_START_WINDOW_NOT_READY" };
    }

    const availability = await this.getOnlineTaskDevice(task);
    if (!availability.online) {
      return { ok: true, skipped: true, reason: "DEVICE_OFFLINE" };
    }
    const device = await this.getLoggedInTaskDevice(task, availability.device);
    const window = {
      startMs: fromMs,
      endMs: throughMs,
      beginTime: formatLocalDateTime(new Date(fromMs)),
      endTime: formatLocalDateTime(new Date(throughMs)),
    };
    const recordings = await device.queryRecordings({
      beginTime: formatLocalDateTime(new Date(fromMs - REPLAY_LEAD_PADDING_SECONDS * 1000)),
      endTime: window.endTime,
    });
    const candidates = (Array.isArray(recordings) ? recordings : [])
      .map((recording) => {
        const clipped = clipRecordingToWindow(recording, window);
        return clipped ? padRecordingForStableReplay(clipped, recording) : null;
      })
      .filter(Boolean)
      .sort((left, right) => {
        const leftEnd = parseLocalDateTime(left.analysisTargetWindow?.endTime || left.EndTime);
        const rightEnd = parseLocalDateTime(right.analysisTargetWindow?.endTime || right.EndTime);
        return (rightEnd?.getTime() || 0) - (leftEnd?.getTime() || 0);
      });
    if (candidates.length === 0) {
      return { ok: true, skipped: true, reason: "FEEDING_START_REPLAY_NOT_READY" };
    }

    let confirmation = null;
    let latestEvaluation = null;
    let confirmedTargetBeginMs = 0;
    let analyzedCount = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      const recording = candidates[index];
      const target = recording.analysisTargetWindow || {};
      const key = `feeding-start-check:${target.beginTime || recording.BeginTime}__${target.endTime || recording.EndTime}`;
      const result = await this.analyzeRecording({
        device,
        recording,
        recordingKey: key,
        deviceSn,
        signal: task.signal,
      });
      analyzedCount += 1;
      const targetBegin = parseLocalDateTime(target.beginTime || recording.BeginTime);
      const targetEnd = parseLocalDateTime(target.endTime || recording.EndTime);
      if (!targetBegin || !targetEnd || throughMs - targetEnd.getTime() > 5 * 1000) continue;
      const evaluated = evaluateFeedingStartConfirmation(
        result.analysis?.feedingStats,
        this.feedingStartConfirmationPolicy
      );
      latestEvaluation = evaluated;
      if (!evaluated.confirmed) continue;
      confirmation = evaluated;
      confirmedTargetBeginMs = targetBegin.getTime();
      break;
    }

    if (!confirmation) {
      const latest = this.store.getSettings(deviceSn);
      await this.persistSettings({
        ...latest,
        deviceSn,
        feedingStartLastAnalyzedThroughMs: Math.max(
          Number(latest.feedingStartLastAnalyzedThroughMs) || 0,
          throughMs
        ),
      });
      this.logger?.info?.("[feed-analysis] fast feeding start inconclusive", {
        deviceSn,
        fromMs,
        throughMs,
        analyzed: analyzedCount,
        reason: latestEvaluation?.reason || "NO_RECENT_REPLAY_EVIDENCE",
      });
      return {
        ok: true,
        confirmed: false,
        analyzed: analyzedCount,
        reason: latestEvaluation?.reason || "NO_RECENT_REPLAY_EVIDENCE",
      };
    }

    const eventAtMs = confirmedTargetBeginMs + Math.round(confirmation.startOffsetSec * 1000);
    const confirmedAtMs = Date.now();
    const latest = this.store.getSettings(deviceSn);
    await this.persistSettings({
      ...latest,
      deviceSn,
      feedingStartState: "active",
      feedingStartCandidateFromMs: 0,
      feedingStartCandidateThroughMs: 0,
      feedingStartLastAnalyzedThroughMs: throughMs,
      feedingStartConfirmedAtMs: confirmedAtMs,
      feedingStartEventAtMs: eventAtMs,
    });
    const startTime = formatLocalDateTime(new Date(eventAtMs));
    const notification = {
      eventId: `feeding-start:${deviceSn}:${eventAtMs}`,
      markerType: "feeding_start",
      deliveryOrigin: "realtime_alarm",
      title: "猫咪开始进食",
      message: `${clockText(startTime)} 猫咪开始进食`,
      startTime,
      endTime: startTime,
    };
    const delivery = await this.deliverFeedingNotification(notification, deviceSn);
    this.logger?.info?.("[feed-analysis] fast feeding start confirmed", {
      deviceSn,
      eventAtMs,
      confirmedAtMs,
      actualEatingSeconds: confirmation.evidence.actualEatingSeconds,
      spanSeconds: confirmation.evidence.spanSeconds,
      confidence: confirmation.evidence.confidence,
    });
    return { ok: true, confirmed: true, notification, delivery };
  }

  async processQueueTask(task) {
    if (!this.enabled) return { ok: true, skipped: true, disabled: true };
    if (this.isGloballyPaused()) {
      this.scheduleRecordingRetry(task, { consumeRetry: false });
      return { ok: false, deferred: true, error: "ANALYSIS_PAUSED_FOR_USER_PLAYBACK" };
    }
    if (this.isDevicePaused(task.deviceSn)) {
      this.scheduleRecordingRetry(task, { consumeRetry: false });
      return { ok: false, deferred: true, error: "ANALYSIS_PAUSED_FOR_USER_PLAYBACK" };
    }
    try {
      if (task.feedingStartCandidate) return await this.processFeedingStartCandidateTask(task);
      if (task.alarmWindow) return await this.processAlarmWindowTask(task);
      if (task.recordingKey) return await this.processRecordingTask(task);
      return await this.processScanTask(task);
    } catch (error) {
      if (error?.code === "ANALYSIS_PREEMPTED") {
        this.scheduleRecordingRetry(task, { consumeRetry: false });
        return { ok: false, deferred: true, preempted: true, error: "ANALYSIS_PREEMPTED" };
      }
      if (error?.code !== "DEVICE_UNAVAILABLE") throw error;
      if (!task.recordingKey) return { ok: true, skipped: true, reason: "DEVICE_UNAVAILABLE" };
      this.scheduleRecordingRetry(task, { consumeRetry: false });
      return { ok: false, deferred: true, error: "DEVICE_UNAVAILABLE" };
    }
  }

  pauseDevice(deviceSn, durationMs = 120 * 1000) {
    const sn = String(deviceSn || "");
    if (!sn) return { ok: false, paused: false };
    const until = Date.now() + Math.max(0, Number(durationMs) || 0);
    const currentUntil = Number(this.pausedDevices.get(sn)) || 0;
    this.pausedDevices.set(sn, Math.max(currentUntil, until));
    return { ok: true, paused: true, deviceSn: sn, until: this.pausedDevices.get(sn) };
  }

  isDevicePaused(deviceSn) {
    const sn = String(deviceSn || "");
    const until = Number(this.pausedDevices.get(sn)) || 0;
    if (until <= 0) return false;
    if (until > Date.now()) return true;
    this.pausedDevices.delete(sn);
    return false;
  }

  async getTaskDevice(task) {
    if (task.device) return task.device;
    if (this.deviceProvider && typeof this.deviceProvider.getDevice === "function") {
      try {
        return await this.deviceProvider.getDevice(task.deviceSn);
      } catch (error) {
        throw deviceUnavailableError(error);
      }
    }
    return this.deviceFactory(task.deviceSn);
  }

  async refreshTaskDevice(task, device = null) {
    if (!this.deviceProvider || typeof this.deviceProvider.refreshDevice !== "function") {
      throw deviceUnavailableError(new Error("DEVICE_REFRESH_UNAVAILABLE"));
    }
    try {
      const refreshed = await this.deviceProvider.refreshDevice(task.deviceSn || device?.sn || "");
      if (!refreshed) throw new Error("DEVICE_REFRESH_EMPTY");
      return refreshed;
    } catch (error) {
      if (error?.code === "DEVICE_UNAVAILABLE") throw error;
      throw deviceUnavailableError(error);
    }
  }

  async getLoggedInTaskDevice(task, device = null) {
    const current = device || await this.getTaskDevice(task);
    if (typeof current.login !== "function") return current;
    try {
      await current.login();
      return current;
    } catch (error) {
      const refreshed = await this.refreshTaskDevice(task, current);
      if (typeof refreshed.login !== "function") throw deviceUnavailableError(error);
      try {
        await refreshed.login();
      } catch (retryError) {
        throw deviceUnavailableError(retryError);
      }
      return refreshed;
    }
  }

  async getOnlineTaskDevice(task, device = null) {
    let current = device || await this.getTaskDevice(task);
    if (typeof current.status !== "function") return { device: current, online: true };
    let status;
    try {
      status = await current.status();
    } catch (error) {
      current = await this.refreshTaskDevice(task, current);
      if (typeof current.status !== "function") throw deviceUnavailableError(error);
      try {
        status = await current.status();
      } catch (retryError) {
        throw deviceUnavailableError(retryError);
      }
    }
    return {
      device: current,
      online: String(status?.status || "").toLowerCase() === "online",
    };
  }

  async getDeviceSnsForScan() {
    if (this.deviceProvider && typeof this.deviceProvider.listDeviceSns === "function") {
      const sns = await this.deviceProvider.listDeviceSns();
      return Array.isArray(sns) ? sns.filter(Boolean) : [];
    }
    const settings = this.store.getSettings();
    return settings.deviceSn ? [settings.deviceSn] : [];
  }

  async enqueueDueScans(date = "", { waitForDiscovery = false } = {}) {
    if (!this.enabled) {
      return { ok: true, devices: 0, queued: 0, skipped: true, disabled: true };
    }
    const scanDate = date || formatLocalDateTime(this.nowProvider()).slice(0, 10);
    const sns = await this.getDeviceSnsForScan();
    const jobs = sns.map((deviceSn) => this.enqueueDeviceDate({ date: scanDate, deviceSn }));
    let discoveries = [];
    if (waitForDiscovery) {
      discoveries = await Promise.all(jobs.map((job) => job.completion));
      const failed = discoveries.find((outcome) => !outcome?.ok);
      if (failed) throw new Error(failed.error || "FEED_ANALYSIS_SCAN_FAILED");
    }
    this.reportQueueCapacityIfNeeded();
    return {
      ok: true,
      devices: sns.length,
      queued: jobs.filter((job) => job.queued).length,
      jobs,
      discoveries,
    };
  }

  getQueueStatus(deviceSn = "") {
    if (!this.queue || typeof this.queue.getStatus !== "function") return null;
    return this.queue.getStatus({ deviceSn: String(deviceSn || "") });
  }

  reportQueueCapacityIfNeeded() {
    const status = this.getQueueStatus();
    if (!status || Number(status.pending) <= 0) return status;
    if (Number(status.oldestPendingMs) < this.queueWarningAgeMs) return status;
    const now = this.nowProvider();
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    if (nowMs - this.lastQueueWarningAt < this.queueWarningCooldownMs) return status;
    this.lastQueueWarningAt = nowMs;
    this.logger?.warn?.("[feed-analysis] sustained queue backlog", {
      pending: Number(status.pending) || 0,
      running: Number(status.running) || 0,
      globalConcurrency: Number(status.globalConcurrency) || 0,
      oldestPendingMs: Number(status.oldestPendingMs) || 0,
      longestRunningMs: Number(status.longestRunningMs) || 0,
      byKind: status.byKind || {},
    });
    return status;
  }

  async processScanTask(task) {
    let device = await this.getTaskDevice(task);
    const availability = await this.getOnlineTaskDevice(task, device);
    if (!availability.online) return { ok: true, skipped: true, reason: "DEVICE_OFFLINE" };
    device = availability.device;
    let loginPromise = null;
    const ensureLoggedIn = async () => {
      if (!loginPromise) loginPromise = this.getLoggedInTaskDevice(task, device);
      device = await loginPromise;
      return true;
    };
    if (this.store.getSettings(task.deviceSn).officialConfigStatus !== "ready") {
      await ensureLoggedIn();
    }
    await this.bootstrapOfficialConfig(device, task.deviceSn || device.sn || "");
    const fallbackRange = dayRange(task.date) || (() => {
      const now = this.nowProvider();
      const begin = new Date(now.getTime() - 60 * 60 * 1000);
      return {
        beginTime: formatLocalDateTime(begin),
        endTime: formatLocalDateTime(now),
      };
    })();
    const deviceSn = task.deviceSn || device.sn || "";
    const officialBatch = await this.collectOfficialAlarmCandidates(device, this.nowProvider(), {
      date: task.date,
      force: task.force,
    });
    let records = officialBatch.records || [];
    let recordCount = records.length;

    // Snapshot results are retained as evidence only. Realtime notifications
    // are exclusively confirmed by processFeedingStartCandidateTask.

    if (!task.force && officialBatch.analysisWindow) {
      const result = this.enqueueAlarmWindow({
        device,
        deviceSn,
        window: officialBatch.analysisWindow,
      });
      return {
        ok: result.ok !== false,
        queued: result.queued ? 1 : 0,
        records: 0,
        alarms: (officialBatch.alarms || []).length,
        snapshots: 0,
        alarmDriven: true,
      };
    }

    if (!task.force && officialBatch.available) {
      return {
        ok: true,
        queued: 0,
        records: 0,
        alarms: 0,
        snapshots: 0,
        alarmDriven: false,
      };
    }

    try {
      await ensureLoggedIn();
      const alarmWindows = !task.force && this.alarmAdapter
        ? await this.alarmAdapter.fetchWindows(device, { date: task.date })
        : [];
      const queryRanges = [...alarmWindows, fallbackRange];
      const recordsByKey = new Map(records.map((record) => [recordingKey(record), record]));
      for (const queryRange of queryRanges) {
        const batch = await device.queryRecordings({
          beginTime: queryRange.beginTime,
          endTime: queryRange.endTime,
        });
        recordCount += batch.length;
        for (const record of batch) {
          recordsByKey.set(recordingKey(record), record);
        }
      }
      records = expandRecordingsForAnalysis(Array.from(recordsByKey.values()));
    } catch (error) {
      if (!officialBatch.available || !(officialBatch.snapshots || []).length) throw error;
    }

    let queued = 0;
    const seenRecordings = new Set();
    for (const record of records) {
      const key = recordingKey(record);
      if (seenRecordings.has(key)) continue;
      seenRecordings.add(key);
      const date = formatDateKey(record.BeginTime || record.beginTime || task.date);
      if (!task.force && this.store.hasProcessed(key, deviceSn)) continue;
      if (typeof this.store.markRecordingQueued === "function") {
        const queued = this.store.markRecordingQueued({
          deviceSn,
          date,
          recordingKey: key,
          recording: record,
          force: Boolean(task.force),
        });
        if (queued === false) continue;
        await this.persistLocalAnalysisRecord(deviceSn, key);
      }
      const result = this.enqueueRecording({
        force: task.force,
        date,
        device,
        deviceSn,
        recording: record,
        recordingKey: key,
      });
      if (result.queued) queued += 1;
    }
    return {
      ok: true,
      queued,
      records: recordCount,
      alarms: (officialBatch.alarms || []).length,
      snapshots: (officialBatch.snapshots || []).length,
      alarmDriven: officialBatch.available && !!officialBatch.alarmDriven,
    };
  }

  pauseAll(durationMs = 30 * 1000) {
    const until = Date.now() + Math.max(0, Number(durationMs) || 0);
    this.globalPauseUntil = Math.max(Number(this.globalPauseUntil) || 0, until);
    return { ok: true, paused: true, until: this.globalPauseUntil };
  }

  isGloballyPaused() {
    const until = Number(this.globalPauseUntil) || 0;
    if (until <= 0) return false;
    if (until > Date.now()) return true;
    this.globalPauseUntil = 0;
    return false;
  }

  async processAlarmWindowTask(task) {
    const availability = await this.getOnlineTaskDevice(task);
    if (!availability.online) {
      this.scheduleRecordingRetry(task, { consumeRetry: false });
      return { ok: false, deferred: true, error: "DEVICE_OFFLINE" };
    }
    const device = await this.getLoggedInTaskDevice(task, availability.device);
    const deviceSn = String(task.deviceSn || device.sn || "");
    if (this.isDevicePaused(deviceSn)) {
      this.scheduleRecordingRetry(task, { consumeRetry: false });
      return { ok: false, deferred: true, error: "ANALYSIS_PAUSED_FOR_USER_PLAYBACK" };
    }

    const settings = this.store.getSettings(deviceSn);
    const taskEndMs = Math.max(0, Number(task.alarmWindow?.endMs) || 0);
    const taskStartMs = Math.max(0, Number(task.alarmWindow?.startMs) || 0);
    const pendingStarts = [settings.feedingPendingFromMs, taskStartMs]
      .map(Number)
      .filter((value) => value > 0 && Number.isFinite(value));
    const window = buildRollingAlarmAnalysisWindow({
      analyzedThroughMs: settings.feedingAnalyzedThroughMs,
      pendingFromMs: pendingStarts.length > 0 ? Math.min(...pendingStarts) : 0,
      pendingThroughMs: Math.max(Number(settings.feedingPendingThroughMs) || 0, taskEndMs),
    });
    if (!window) return { ok: true, skipped: true, reason: "ALARM_WINDOW_ALREADY_ANALYZED" };

    const startedAt = Date.now();
    this.logger?.info?.("[feed-analysis] alarm window started", {
      deviceSn,
      beginTime: window.beginTime,
      endTime: window.endTime,
      durationSec: Math.round((window.endMs - window.startMs) / 1000),
      retryCount: Math.max(0, Number(task?.retryCount) || 0),
    });
    try {
      const queryBeginTime = formatLocalDateTime(
        new Date(window.startMs - REPLAY_LEAD_PADDING_SECONDS * 1000)
      );
      const recordings = await device.queryRecordings({
        beginTime: queryBeginTime,
        endTime: window.endTime,
      });
      const clippedRecordings = (Array.isArray(recordings) ? recordings : [])
        .map((recording) => {
          const clipped = clipRecordingToWindow(recording, window);
          return clipped ? padRecordingForStableReplay(clipped, recording) : null;
        })
        .filter(Boolean);
      const uniqueRecordings = Array.from(new Map(
        clippedRecordings.map((recording) => {
          const target = recording.analysisTargetWindow || {};
          return [`${target.beginTime || recording.BeginTime}__${target.endTime || recording.EndTime}`, recording];
        })
      ).values());
      if (uniqueRecordings.length === 0) {
        this.logger?.info?.("[feed-analysis] alarm replay not ready", {
          deviceSn,
          beginTime: window.beginTime,
          endTime: window.endTime,
          elapsedMs: Date.now() - startedAt,
        });
        this.scheduleRecordingRetry(task);
        return { ok: false, deferred: true, retry: true, error: "ALARM_REPLAY_NOT_READY" };
      }
      let analyzed = 0;
      for (const recording of uniqueRecordings) {
        const targetWindow = recording.analysisTargetWindow || {};
        const targetBeginTime = String(targetWindow.beginTime || recording.BeginTime || recording.beginTime || "");
        const targetEndTime = String(targetWindow.endTime || recording.EndTime || recording.endTime || "");
        const key = `feeding-window:${targetBeginTime}__${targetEndTime}`;
        const date = formatDateKey(targetBeginTime);
        if (this.store.hasProcessed(key, deviceSn)) continue;
        const candidateRecording = shiftRecordingStart(recording, REPLAY_LEAD_TRIM_SECONDS) || recording;
        const analyzedRecording = await this.analyzeRecording({
          device,
          recording: candidateRecording,
          recordingKey: key,
          deviceSn,
          signal: task.signal,
        });
        const { clipDate, clip } = analyzedRecording;
        const structuredClip = buildStructuredFeedingClip(clip, key);
        if (this.persistentAnalysisStore) {
          await this.persistentAnalysisStore.upsert({
            deviceSn,
            date: date || clipDate,
            recordingKey: key,
            status: "ready",
            recording: candidateRecording,
            clip: structuredClip,
            failureCount: 0,
            lastError: "",
            materialSyncStatus: "pending",
            materialSyncAttempts: 0,
            materialSyncError: "",
            updatedAt: Date.now(),
          });
        }
        this.store.upsertRecording({
          deviceSn,
          recordingKey: key,
          date: date || clipDate,
          clip: structuredClip,
        });
        this.enqueueMaterialSync({
          deviceSn,
          date: date || clipDate,
          recordingKey: key,
          clip: structuredClip,
          recording: candidateRecording,
        });
        analyzed += 1;
      }

      const latestSettings = this.store.getSettings(deviceSn);
      const latestPendingThroughMs = Math.max(
        Number(latestSettings.feedingPendingThroughMs) || 0,
        taskEndMs
      );
      const hasUncoveredPending = latestPendingThroughMs > window.endMs;
      await this.persistSettings({
        ...latestSettings,
        deviceSn,
        feedingAnalyzedThroughMs: window.endMs,
        feedingPendingFromMs: hasUncoveredPending
          ? Math.max(window.endMs - ALARM_ANALYSIS_OVERLAP_MS, 0)
          : 0,
        feedingPendingThroughMs: hasUncoveredPending ? latestPendingThroughMs : 0,
      });
      this.logger?.info?.("[feed-analysis] alarm window completed", {
        deviceSn,
        analyzed,
        recordings: uniqueRecordings.length,
        elapsedMs: Date.now() - startedAt,
        analyzedThroughMs: window.endMs,
        pendingThroughMs: hasUncoveredPending ? latestPendingThroughMs : 0,
      });
      if (hasUncoveredPending) {
        const followUp = buildRollingAlarmAnalysisWindow({
          analyzedThroughMs: window.endMs,
          pendingFromMs: window.endMs - ALARM_ANALYSIS_OVERLAP_MS,
          pendingThroughMs: latestPendingThroughMs,
        });
        if (followUp) this.enqueueAlarmWindow({ device, deviceSn, window: followUp });
      }
      return { ok: true, analyzed, recordings: uniqueRecordings.length, window };
    } catch (error) {
      this.logger?.warn?.("[feed-analysis] alarm window failed", {
        deviceSn,
        elapsedMs: Date.now() - startedAt,
        retryCount: Math.max(0, Number(task?.retryCount) || 0),
        error: error.message || String(error),
      });
      if (isPlaybackChannelOccupied(error) || isRetryableAnalysisError(error)) {
        if (await this.abandonStaleAlarmWindow(task, deviceSn, window)) {
          return {
            ok: false,
            retry: false,
            abandoned: true,
            error: error.message || String(error),
          };
        }
        this.scheduleRecordingRetry(task);
        return { ok: false, retry: true, error: error.message || String(error) };
      }
      return { ok: false, error: error.message || String(error) };
    }
  }

  async processRecordingTask(task) {
    const availability = await this.getOnlineTaskDevice(task);
    if (!availability.online) {
      this.scheduleRecordingRetry(task, { consumeRetry: false });
      return { ok: false, deferred: true, error: "DEVICE_OFFLINE" };
    }
    const device = await this.getLoggedInTaskDevice(task, availability.device);
    const deviceSn = task.deviceSn || device.sn || "";
    if (this.isDevicePaused(deviceSn)) {
      this.scheduleRecordingRetry(task, { consumeRetry: false });
      return { ok: false, deferred: true, error: "ANALYSIS_PAUSED_FOR_USER_PLAYBACK" };
    }
    const record = task.recording;
    const key = task.recordingKey || (record ? recordingKey(record) : "");
    if (!record || !key) return { ok: false, error: "RECORDING_REQUIRED" };
    if (!task.force && this.store.hasProcessed(key, deviceSn)) {
      return { ok: true, skipped: true };
    }
    try {
      if (typeof this.store.markRecordingRunning === "function") {
        this.store.markRecordingRunning({ deviceSn, date: task.date, recordingKey: key });
        await this.persistLocalAnalysisRecord(deviceSn, key);
      }
      const { analysis, clipDate, clip } = await this.analyzeRecording({
        device,
        recording: record,
        recordingKey: key,
        deviceSn,
        signal: task.signal,
      });
      if (this.persistentAnalysisStore) {
        await this.persistentAnalysisStore.upsert({
          deviceSn,
          date: task.date || clipDate,
          recordingKey: key,
          status: "ready",
          recording: record,
          clip,
          failureCount: 0,
          lastError: "",
          materialSyncStatus: "pending",
          materialSyncAttempts: 0,
          materialSyncError: "",
          updatedAt: Date.now(),
        });
      }
      this.store.upsertRecording({
        deviceSn,
        recordingKey: key,
        date: task.date || clipDate,
        clip,
      });
      this.enqueueMaterialSync({
        deviceSn,
        date: clipDate,
        recordingKey: key,
        clip,
        recording: record,
      });
      return { ok: true };
    } catch (error) {
      if (typeof this.store.markRecordingFailed === "function") {
        this.store.markRecordingFailed({ deviceSn, date: task.date, recordingKey: key, error });
        try { await this.persistLocalAnalysisRecord(deviceSn, key); }
        catch (persistError) { this.logger?.warn?.("[feed-analysis] failed status persistence failed", { error: persistError.message }); }
      }
      if (isPlaybackChannelOccupied(error)) {
        this.scheduleRecordingRetry(task);
        return { ok: false, retry: true, error: error.message };
      }
      if (isRetryableAnalysisError(error)) {
        this.scheduleRecordingRetry(task);
        return { ok: false, retry: true, error: error.message };
      }
      return { ok: false, error: error.message };
    }
  }

  enqueueMaterialSync(task = {}) {
    if (!task.recordingKey || !task.clip) return { ok: false, queued: false };
    return this.materialSyncQueue.enqueueRecording({
      ...task,
      reason: "material-sync",
    });
  }

  recoverMaterialSync() {
    const records = typeof this.store.listPendingMaterialSync === "function"
      ? this.store.listPendingMaterialSync(this.materialSyncMaxAttempts)
      : [];
    let queued = 0;
    for (const record of records) {
      const result = this.enqueueMaterialSync(record);
      if (result.queued) queued += 1;
    }
    return { ok: true, queued, records: records.length };
  }

  async processMaterialSyncTask(task = {}) {
    const deviceSn = String(task.deviceSn || "");
    const recordingKey = String(task.recordingKey || "");
    if (!deviceSn || !recordingKey || !task.clip) {
      return { ok: false, error: "MATERIAL_SYNC_RECORDING_REQUIRED" };
    }
    try {
      this.store.markMaterialSyncRunning?.({ deviceSn, recordingKey });
      await this.persistLocalAnalysisRecord(deviceSn, recordingKey);
      await this.persistAnalyzedClip({
        deviceSn,
        date: task.date || formatDateKey(task.recording?.BeginTime || task.recording?.beginTime),
        clip: task.clip,
        recording: task.recording || {},
      });
      this.store.markMaterialSyncReady?.({ deviceSn, recordingKey });
      await this.persistLocalAnalysisRecord(deviceSn, recordingKey);
      return { ok: true };
    } catch (error) {
      this.store.markMaterialSyncFailed?.({ deviceSn, recordingKey, error });
      try { await this.persistLocalAnalysisRecord(deviceSn, recordingKey); }
      catch (persistError) { this.logger?.warn?.("[feed-analysis] material status persistence failed", { error: persistError.message }); }
      return { ok: false, error: error.message || String(error) };
    }
  }

  async analyzeRecording({ device, recording, recordingKey: key, deviceSn, signal = null }) {
    const analysisStartedAt = Date.now();
    let sourceAcquiredAt = 0;
    let visionCompletedAt = 0;
    const durationSec = recordingDurationSec(recording);
    const targetWindow = recording.analysisTargetWindow || null;
    const targetBeginTime = String(targetWindow?.beginTime || recording.BeginTime || recording.beginTime || "");
    const targetEndTime = String(targetWindow?.endTime || recording.EndTime || recording.endTime || "");
    const targetDurationSec = targetWindow
      ? recordingDurationSec({ BeginTime: targetBeginTime, EndTime: targetEndTime })
      : durationSec;
    const playbackOptions = {
      channel: 0,
      streamType: this.playbackStreamType,
      speed: this.playbackSpeed,
      startTime: recording.BeginTime || recording.beginTime || "",
      endTime: recording.EndTime || recording.endTime || "",
      fileName: recording.FileName || recording.fileName || "",
      mediaType: "hls",
      protocol: "hls",
    };
    let playbackAcquired = false;
    let analysisSource = null;
    const isPausedForUserPlayback = () => (
      this.isGloballyPaused() || this.isDevicePaused(deviceSn)
    );
    const assertAnalysisMayContinue = () => {
      if (signal?.aborted) {
        const error = new Error("ANALYSIS_PREEMPTED");
        error.code = "ANALYSIS_PREEMPTED";
        throw error;
      }
      if (isPausedForUserPlayback()) throw analysisPausedForUserPlaybackError();
    };
    const releaseCurrentSource = async () => {
      if (typeof analysisSource?.release === "function") {
        try {
          await analysisSource.release();
        } catch (error) {
          this.logger?.warn?.("[feed-analysis] hls manifest release failed", {
            deviceSn,
            error: error.message || String(error),
          });
        }
      }
      analysisSource = null;
      if (playbackAcquired && typeof device.closeLivestream === "function") {
        try {
          await device.closeLivestream(0, this.playbackStreamType);
        } catch (error) {
          this.logger?.warn?.("[feed-analysis] playback channel release failed", {
            deviceSn,
            error: error.message || String(error),
          });
        }
      }
      playbackAcquired = false;
    };
    const acquireSourceUrl = async ({
      sourceRecording = recording,
      sourcePlaybackOptions = playbackOptions,
      sourceDurationSec = durationSec,
      sourceRecordingKey = key,
    } = {}) => {
      assertAnalysisMayContinue();
      const rawSourceUrl = await getHlsPlaybackUrlWithSpeedFallback(
        device,
        sourceRecording,
        sourcePlaybackOptions,
        this.logger,
        isPausedForUserPlayback
      );
      playbackAcquired = true;
      const resolvedSource = await this.resolveAnalysisSourceUrl({
        sourceUrl: rawSourceUrl,
        recording: sourceRecording,
        recordingKey: sourceRecordingKey,
        beginTime: sourcePlaybackOptions.startTime,
        endTime: sourcePlaybackOptions.endTime,
        durationSec: sourceDurationSec,
        deviceSn,
      });
      analysisSource = resolvedSource && typeof resolvedSource === "object"
        ? resolvedSource
        : { sourceUrl: resolvedSource };
      const sourceUrl = String(analysisSource.sourceUrl || "");
      if (!sourceUrl) throw new Error("FEED_ANALYSIS_HLS_SOURCE_EMPTY");
      return sourceUrl;
    };
    try {
      const bowlRoi = this.getConfiguredBowlRoi(deviceSn);
      const requestedSpeed = Math.min(8, Math.max(1, Number(this.playbackSpeed) || 8));
      const analysisSpeeds = [requestedSpeed, 4, 2, 1]
        .filter((speed, index, values) => speed <= requestedSpeed && values.indexOf(speed) === index);
      let analysis = null;
      let lastAnalysisError = null;
      for (let attemptIndex = 0; attemptIndex < analysisSpeeds.length; attemptIndex += 1) {
        assertAnalysisMayContinue();
        if (attemptIndex > 0) await releaseCurrentSource();
        assertAnalysisMayContinue();
        const attemptSpeed = analysisSpeeds[attemptIndex];
        const sourceUrl = await acquireSourceUrl({
          sourcePlaybackOptions: { ...playbackOptions, speed: attemptSpeed },
        });
        const acquiredAt = Date.now();
        const analyzerPayload = {
          sourceUrl,
          recording,
          recordingKey: key,
          beginTime: recording.BeginTime || recording.beginTime || "",
          durationSec,
          bowlRoi,
          autoBowlDetection: false,
          fixedBottomBowlRegion: !bowlRoi,
          detectionTarget: this.detectionTarget,
          detectorBackend: this.detectorBackend,
          yoloModel: this.yoloModel,
          orientation: this.orientation,
        };
        try {
          const candidate = await this.analyzer.analyzeRecording({
            ...analyzerPayload,
            signal,
            adaptiveFeeding: this.detectionTarget === "cat",
            sampleSeconds: this.detectionTarget === "cat" ? this.screeningSampleSeconds : 0.5,
          });
          assertAnalysisSucceeded(candidate);
          analysis = candidate;
          sourceAcquiredAt = acquiredAt;
          break;
        } catch (error) {
          lastAnalysisError = error;
          assertAnalysisMayContinue();
          if (!isVisionSourceReadError(error) || attemptIndex >= analysisSpeeds.length - 1) throw error;
          this.logger?.warn?.("[feed-analysis] hls source unreadable; retrying slower playback", {
            deviceSn,
            recordingKey: key,
            speed: attemptSpeed,
            nextSpeed: analysisSpeeds[attemptIndex + 1],
          });
        }
      }
      if (!analysis) throw lastAnalysisError || new Error("VISION_ANALYSIS_FAILED: VIDEO_READ_FAILED");
      visionCompletedAt = Date.now();
      analysis = trimAnalysisToTargetWindow(analysis, recording);
      const feedingStats = buildFeedingStats({
        source: {
          mediaId: key,
          name: playbackOptions.fileName,
          durationSec: targetDurationSec,
          orientation: this.orientation,
          range: {
            startTime: targetBeginTime,
            endTime: targetEndTime,
          },
        },
        frames: analysis.frames,
        analyzedDurationSec: targetDurationSec,
        algorithmVersion: ALGORITHM_VERSION,
      });
      const enrichedAnalysis = {
        ...analysis,
        feedingStats,
        screening: this.detectionTarget === "cat"
          ? {
              hasCat: !!analysis.hasCat,
              framesSampled: Math.max(0, Number(analysis.framesSampled) || 0),
              durationMs: Math.max(0, Number(analysis.durationMs) || 0),
              sampleSeconds: this.screeningSampleSeconds,
              candidateRanges: buildCandidateRanges(
                analysis.frames,
                targetDurationSec,
                { sampleSeconds: this.screeningSampleSeconds }
              ),
              error: String(analysis.error || ""),
              sameSession: true,
            }
          : null,
      };
      const resultRecording = targetWindow
        ? {
            ...recording,
            BeginTime: targetBeginTime,
            EndTime: targetEndTime,
            beginTime: targetBeginTime,
            endTime: targetEndTime,
            durationSec: targetDurationSec,
          }
        : recording;
      const clip = buildClipFromRecording(
        resultRecording,
        enrichedAnalysis,
        deviceSn || recording.deviceSn || ""
      );
      const clipDate = formatDateKey(targetBeginTime);
      this.logger?.info?.("[feed-analysis] recording analysis completed", {
        deviceSn,
        recordingKey: key,
        targetDurationSec,
        playbackSpeed: this.playbackSpeed,
        streamType: this.playbackStreamType,
        sampleSeconds: this.detectionTarget === "cat" ? this.screeningSampleSeconds : 0.5,
        sourceAcquireMs: Math.max(0, sourceAcquiredAt - analysisStartedAt),
        visionMs: Math.max(0, visionCompletedAt - sourceAcquiredAt),
        totalMs: Math.max(0, Date.now() - analysisStartedAt),
        framesSampled: Math.max(0, Number(analysis.framesSampled) || 0),
        hasCat: !!analysis.hasCat,
        hasFeeding: !!analysis.hasFeeding,
      });
      return { analysis: enrichedAnalysis, clipDate, clip };
    } finally {
      await releaseCurrentSource();
    }
  }

  async resolveAlarmSnapshotUrl(device, alarm) {
    if (typeof device.getAlarmPicUrl === "function") {
      try {
        const url = await device.getAlarmPicUrl(alarm);
        if (url) return url;
      } catch (error) {
        // Snapshot lookup can fail on firmware variants; direct alarm URLs still work.
      }
    }
    return alarm.snapshotUrl || "";
  }

  async analyzeAlarmSnapshot(alarm, snapshotUrl, deviceSn = "") {
    if (!this.analyzer || typeof this.analyzer.analyzeSnapshot !== "function") {
      return {
        alarm,
        snapshotUrl,
        analysis: fallbackSnapshotAnalysis(new Error("snapshot analyzer unavailable")),
      };
    }
    try {
      return {
        alarm,
        snapshotUrl,
        analysis: await this.analyzer.analyzeSnapshot({
          snapshotUrl,
          alarm,
          bowlRoi: this.getConfiguredBowlRoi(deviceSn),
          detectionTarget: this.detectionTarget,
          detectorBackend: this.detectorBackend,
          yoloModel: this.yoloModel,
        }),
      };
    } catch (error) {
      return {
        alarm,
        snapshotUrl,
        analysis: fallbackSnapshotAnalysis(error),
      };
    }
  }

  enqueueSnapshotNotification(alarm, snapshotUrl, analysis = {}) {
    if (!analysis.hasFeeding || typeof this.store.enqueueFeedingNotification !== "function") {
      return null;
    }
    const marker = firstFeedingStartMarker(analysis) || {};
    const startTime = marker.beginTime || alarm.occurredAt || "";
    const eventId = `${alarm.id}__feeding_start`;
    return this.store.enqueueFeedingNotification({
      eventId,
      markerType: "feeding_start",
      date: formatDateKey(startTime || alarm.occurredAt || new Date()),
      clipId: "",
      title: "猫咪来吃饭了",
      message: `${clockText(startTime)} 猫咪来吃饭了`,
      startTime,
      endTime: marker.endTime || startTime,
      snapshotUrl,
      alarmId: alarm.id,
    });
  }

  getNotificationStatus() {
    if (!this.notifier || typeof this.notifier.getStatus !== "function") {
      return {
        provider: "pushplus",
        configured: false,
        status: "not_configured",
      };
    }
    return this.notifier.getStatus();
  }

  canDeliverNotificationTo(openid = "") {
    const targetOpenid = String(openid || "").trim();
    if (!targetOpenid) return false;
    const binding = this.store && typeof this.store.getPushPlusBinding === "function"
      ? this.store.getPushPlusBinding(targetOpenid)
      : null;
    return !!(binding && binding.friendToken) || targetOpenid === this.notificationOwnerOpenid;
  }

  async deliverFeedingNotification(notification, deviceSn = "") {
    if (!notification || !notification.eventId) return { ok: false, skipped: true };
    if (notification.deliveryOrigin !== "realtime_alarm") {
      return { ok: false, skipped: true, reason: "NOT_REALTIME_ALARM_CONFIRMATION" };
    }
    if (this.deviceNotificationDispatcher && typeof this.deviceNotificationDispatcher.dispatchFeedingEvent === "function") {
      try {
        return await this.deviceNotificationDispatcher.dispatchFeedingEvent({
          deviceSn,
          eventType: notification.markerType || "feeding_start",
          occurredAt: notification.startTime || notification.endTime,
          sourceEventId: notification.eventId,
        });
      } catch (error) {
        this.logger?.warn?.("[feed-analysis] WeChat notification delivery failed", {
          code: error.code || error.message,
        });
        return { ok: false, error: error.code || error.message };
      }
    }
    return { ok: false, skipped: true, reason: "WECHAT_NOTIFICATIONS_NOT_CONFIGURED" };
  }

  async deliverWechatClipEvents(deviceSn, clip, { origin = "historical" } = {}) {
    if (origin !== "realtime_alarm") return [];
    if (!this.deviceNotificationDispatcher ||
      typeof this.deviceNotificationDispatcher.dispatchFeedingClip !== "function") {
      return [];
    }
    try {
      return await this.deviceNotificationDispatcher.dispatchFeedingClip({ deviceSn, clip });
    } catch (error) {
      this.logger?.warn?.("[feed-analysis] WeChat clip delivery failed", {
        code: error.code || error.message,
      });
      return [];
    }
  }

  async sendTestNotification(openid = "", deviceSn = "") {
    if (!this.notifier || typeof this.notifier.sendFeedingNotification !== "function") {
      return { ok: false, error: "PUSHPLUS_NOT_CONFIGURED" };
    }
    if (typeof this.notifier.isConfigured === "function" && !this.notifier.isConfigured()) {
      return { ok: false, error: "PUSHPLUS_NOT_CONFIGURED" };
    }
    const settings = this.store.getSettings(deviceSn);
    const bindingOpenid = String(openid || settings.openid || "");
    const binding = this.store && typeof this.store.getPushPlusBinding === "function"
      ? this.store.getPushPlusBinding(bindingOpenid)
      : null;
    const ownerFallback = bindingOpenid === this.notificationOwnerOpenid;
    if ((!binding || !binding.friendToken) && !ownerFallback) {
      return { ok: false, error: "PUSHPLUS_FRIEND_NOT_BOUND" };
    }
    return this.notifier.sendFeedingNotification({
      eventId: `pushplus-test-${Date.now()}`,
      title: "\u732b\u54aa\u5403\u996d\u63d0\u9192\u6d4b\u8bd5",
      message: "\u6d4b\u8bd5\u6210\u529f\uff0c\u4e0b\u6b21\u732b\u54aa\u6765\u5403\u996d\u65f6\u4f1a\u901a\u8fc7\u5fae\u4fe1\u63d0\u9192\u4f60",
      deviceSn: settings.deviceSn || "",
      startTime: formatLocalDateTime(this.nowProvider()),
      ...(binding && binding.friendToken ? { friendToken: binding.friendToken } : {}),
    });
  }

  async getPushPlusBindingStatus(openid) {
    if (!this.pushPlusBindingService) return { configured: false, bound: false };
    return this.pushPlusBindingService.getBindingStatus(openid);
  }

  async handlePushPlusCallback(payload) {
    if (!this.pushPlusBindingService) return { ok: false, error: "PUSHPLUS_OPEN_API_NOT_CONFIGURED" };
    const code = String(payload?.qrCode || "").trim();
    const challenge = code ? this.store.getPushPlusBindingChallengeByCode?.(code, Date.now()) : null;
    const result = this.pushPlusBindingService.handleCallback(payload);
    if (result?.ok && challenge?.openid && this.persistentSettingsStore?.upsertBinding) {
      const binding = this.store.getPushPlusBinding(challenge.openid);
      if (binding) await this.persistentSettingsStore.upsertBinding(binding);
    }
    return result;
  }

  getPushPlusQrSourceUrl(type, code = "") {
    if (!this.pushPlusBindingService) return "";
    return type === "service"
      ? this.pushPlusBindingService.getServiceQrSourceUrl()
      : this.pushPlusBindingService.getFriendQrSourceUrl(code);
  }

  async collectOfficialAlarmRecordings(device, now, options = {}) {
    return this.collectOfficialAlarmCandidates(device, now, options);
  }

  async collectDeviceLogAlarms(device, now, { force = false } = {}) {
    if (force || typeof device.opdev !== "function") {
      return { available: false, alarms: [], nextPosition: 0, error: "" };
    }
    const deviceSn = String(device.sn || "");
    const settings = this.store.getSettings(deviceSn);
    const cursor = Number(settings.lastDeviceLogPosition) || 0;
    try {
      let anchor = now;
      try {
        anchor = (await readDeviceClock(device)).date;
      } catch (error) {
        // OPLogQuery still works on firmware variants that omit OPTimeQuery.
      }
      const begin = new Date(anchor.getTime() - 60 * 60 * 1000);
      const end = new Date(anchor.getTime() + 5 * 1000);
      const data = await device.opdev({
        Name: "OPLogQuery",
        OPLogQuery: {
          Type: "LogAll",
          LogPosition: 0,
          BeginTime: formatDeviceTime(begin),
          EndTime: formatDeviceTime(end),
        },
      });
      const entries = extractDeviceLogEntries(data);
      const maxPosition = entries.reduce((max, entry) => Math.max(
        max,
        Number(entry.Position ?? entry.position ?? entry.LogPosition ?? entry.logPosition) || 0
      ), 0);
      const effectiveCursor = entries.length > 0 && maxPosition < cursor ? 0 : cursor;
      return {
        available: true,
        alarms: selectNewDeviceLogAlarms(data, { afterPosition: effectiveCursor }),
        nextPosition: Math.max(effectiveCursor, maxPosition),
        error: "",
      };
    } catch (error) {
      return {
        available: false,
        alarms: [],
        nextPosition: cursor,
        error: error.message,
      };
    }
  }

  async collectOfficialAlarmCandidates(device, now, { date = "", force = false } = {}) {
    if (typeof device.queryAlarmMessages !== "function" && (force || typeof device.opdev !== "function")) {
      return { available: false, alarms: [], records: [], snapshots: [], alarmDriven: false };
    }

    let settings = this.store.getSettings(device.sn || "");
    const cursorMs = force ? 0 : Number(settings.lastOfficialAlarmAt) || 0;
    const range = dayRange(date);
    const rangeBegin = range ? parseLocalDateTime(range.beginTime) : null;
    const rangeEnd = range ? parseLocalDateTime(range.endTime) : null;
    const begin = cursorMs ? new Date(cursorMs + 1) : (rangeBegin || new Date(now.getTime() - 60 * 60 * 1000));
    const end = rangeEnd || now;
    try {
      let rawAlarms = [];
      let cloudAvailable = false;
      let cloudError = null;
      if (typeof device.queryAlarmMessages === "function") {
        try {
          rawAlarms = await device.queryAlarmMessages({
            beginTime: formatDeviceTime(begin),
            endTime: formatDeviceTime(end),
            page: 1,
            limit: 50,
          });
          cloudAvailable = true;
        } catch (error) {
          cloudError = error;
        }
      }
      const localBatch = await this.collectDeviceLogAlarms(device, now, { force });
      if (!cloudAvailable && !localBatch.available) {
        throw cloudError || new Error(localBatch.error || "DEVICE_ALARM_SOURCE_UNAVAILABLE");
      }
      const cloudAlarms = selectNewLiveObjectAlarms(rawAlarms, { afterMs: cursorMs });
      const alarms = mergeAlarmCandidates(cloudAlarms, localBatch.alarms);
      const alarmSourcePatch = buildAlarmSourceHealthPatch(alarms, {
        cloudAvailable,
        deviceLogAvailable: localBatch.available,
        checkedAt: now.getTime(),
        previous: settings,
      });
      const deviceLogPatch = localBatch.available ? {
        lastDeviceLogPosition: localBatch.nextPosition,
        lastDeviceLogScanAt: now.getTime(),
        deviceLogStatus: "ready",
        deviceLogError: "",
      } : {
        lastDeviceLogScanAt: now.getTime(),
        deviceLogStatus: "error",
        deviceLogError: localBatch.error || "",
      };
      if (alarms.length > 0) {
        const deviceSn = device.sn || settings.deviceSn || "";
        await this.motionAlarmSink?.(deviceSn, alarms);
        if (!force) this.hydrateMotionAlarmPictures(device, deviceSn, alarms);
      }
      if (alarms.length === 0) {
        if (!force) {
          const feedingStartState = await this.advanceFeedingStartState({
            device,
            deviceSn: device.sn || settings.deviceSn || "",
            now,
          });
          settings = feedingStartState.settings || this.store.getSettings(device.sn || "");
        }
        let analysisWindow = !force
          ? buildRollingAlarmAnalysisWindow({
              analyzedThroughMs: settings.feedingAnalyzedThroughMs,
              pendingFromMs: settings.feedingPendingFromMs,
              pendingThroughMs: settings.feedingPendingThroughMs,
            })
          : null;
        const nowMs = now.getTime();
        const lastCompensationAt = Number(settings.lastAlarmCompensationAt) || 0;
        const isCurrentDate = !date || String(date).slice(0, 10) === formatLocalDateTime(now).slice(0, 10);
        const compensationDue =
          !force &&
          isCurrentDate &&
          !analysisWindow &&
          nowMs - lastCompensationAt >= this.alarmCompensationIntervalMs;
        if (compensationDue) {
          const startMs = Math.max(
            nowMs - this.alarmCompensationLookbackMs,
            lastCompensationAt > 0 ? lastCompensationAt - ALARM_ANALYSIS_OVERLAP_MS : 0
          );
          analysisWindow = {
            startMs,
            endMs: nowMs,
            requestedThroughMs: nowMs,
            beginTime: formatLocalDateTime(new Date(startMs)),
            endTime: formatLocalDateTime(now),
            source: "replay-compensation",
          };
          settings = {
            ...settings,
            lastAlarmCompensationAt: nowMs,
          };
          this.logger?.info?.("[feed-analysis] no official alarm; replay compensation queued", {
            deviceSn: device.sn || settings.deviceSn || "",
            beginTime: analysisWindow.beginTime,
            endTime: analysisWindow.endTime,
          });
        }
        await this.persistSettings({
          ...settings,
          deviceSn: device.sn || settings.deviceSn || "",
          lastOfficialAlarmScanAt: now.getTime(),
          officialAlarmStatus: "ready",
          officialAlarmError: "",
          ...alarmSourcePatch,
          ...deviceLogPatch,
        });
        return {
          available: true,
          alarms,
          records: [],
          snapshots: [],
          analysisWindow,
          alarmDriven: !!analysisWindow,
        };
      }

      if (!force) {
        const feedingStartCandidate = await this.registerFeedingStartAlarms({
          device,
          deviceSn: device.sn || settings.deviceSn || "",
          alarms,
          now,
        });
        settings = feedingStartCandidate.settings || this.store.getSettings(device.sn || "");
        const alarmWindow = buildRollingAlarmAnalysisWindow({
          alarms,
          analyzedThroughMs: settings.feedingAnalyzedThroughMs,
          pendingFromMs: settings.feedingPendingFromMs,
          pendingThroughMs: settings.feedingPendingThroughMs,
        });
        const latestAlarmAt = Math.max(...alarms.map((alarm) => alarm.occurredAtMs));
        await this.persistSettings({
          ...settings,
          deviceSn: device.sn || settings.deviceSn || "",
          lastOfficialAlarmAt: latestAlarmAt,
          lastOfficialAlarmScanAt: now.getTime(),
          officialAlarmStatus: "ready",
          officialAlarmError: "",
          ...alarmSourcePatch,
          feedingPendingFromMs: alarmWindow?.startMs || 0,
          feedingPendingThroughMs: alarmWindow?.requestedThroughMs || alarmWindow?.endMs || 0,
          ...deviceLogPatch,
        });
        return {
          available: true,
          alarms,
          records: [],
          snapshots: [],
          analysisWindow: alarmWindow,
          alarmDriven: !!alarmWindow,
        };
      }

      const recordsByKey = new Map();
      const snapshots = [];
      for (const alarm of alarms) {
        const snapshotUrl = await this.resolveAlarmSnapshotUrl(device, alarm);
        if (snapshotUrl) {
          const snapshot = await this.analyzeAlarmSnapshot(alarm, snapshotUrl, device.sn || "");
          snapshots.push(snapshot);
          const analysis = snapshot.analysis || {};
          const confidence = Number(analysis.analysisConfidence) || 0;
          const needsRecordingFallback =
            !analysis.hasFeeding &&
            (!!analysis.error || confidence < this.snapshotFallbackConfidence);
          if (!needsRecordingFallback) continue;
        }
        const window = alarmTimeWindow(alarm);
        const records = await device.queryRecordings({
          ...window,
          event: "*",
        });
        for (const record of records) {
          recordsByKey.set(recordingKey(record), record);
        }
      }
      this.store.updateSettings({
        lastOfficialAlarmAt: Math.max(...alarms.map((alarm) => alarm.occurredAtMs)),
        lastOfficialAlarmScanAt: now.getTime(),
        officialAlarmStatus: "ready",
        officialAlarmError: "",
        ...alarmSourcePatch,
        ...deviceLogPatch,
      }, device.sn || "");
      return {
        available: true,
        alarms,
        records: Array.from(recordsByKey.values()),
        snapshots,
        alarmDriven: true,
      };
    } catch (error) {
      this.store.updateSettings({
        lastOfficialAlarmScanAt: now.getTime(),
        officialAlarmStatus: "error",
        officialAlarmError: error.message,
      }, device.sn || "");
      return { available: false, alarms: [], records: [], snapshots: [], alarmDriven: false };
    }
  }

  scheduleRecordingRetry(task, { consumeRetry = true } = {}) {
    const retryCount = Number(task.retryCount) || 0;
    if (this.retryDelayMs <= 0 || (consumeRetry && retryCount >= this.maxRetries)) return;
    const enqueueRetry = () => {
      const nextRetryCount = consumeRetry ? retryCount + 1 : retryCount;
      if (task.alarmWindow) {
        this.enqueueAlarmWindow({
          device: task.device,
          deviceSn: task.deviceSn,
          window: task.alarmWindow,
          retryCount: nextRetryCount,
          priority: task.priority,
        });
        return;
      }
      if (!task.recordingKey) {
        this.enqueueDeviceDate({
          force: task.force,
          date: task.date,
          device: task.device,
          deviceSn: task.deviceSn,
          priority: task.priority,
          reason: task.reason,
        });
        return;
      }
      this.enqueueRecording({ ...task, retryCount: nextRetryCount });
    };
    const scheduleAfterDelay = () => {
      const timer = setTimeout(enqueueRetry, this.retryDelayMs);
      if (typeof timer.unref === "function") timer.unref();
    };
    const activeCompletion = task?.jobKey
      ? this.queue.getCompletion?.(task.jobKey)
      : null;
    if (activeCompletion) {
      Promise.resolve(activeCompletion).finally(scheduleAfterDelay);
      return;
    }
    scheduleAfterDelay();
  }

  async abandonStaleAlarmWindow(task, deviceSn, window) {
    const retryCount = Math.max(0, Number(task?.retryCount) || 0);
    const endMs = Math.max(0, Number(window?.endMs) || 0);
    const now = this.nowProvider();
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    if (!endMs || nowMs - endMs < STALE_ALARM_WINDOW_MAX_AGE_MS) {
      return false;
    }
    const latestSettings = this.store.getSettings(deviceSn);
    const latestPendingThroughMs = Math.max(
      Number(latestSettings.feedingPendingThroughMs) || 0,
      Number(task?.alarmWindow?.endMs) || 0
    );
    const hasUncoveredPending = latestPendingThroughMs > endMs;
    await this.persistSettings({
      ...latestSettings,
      deviceSn,
      feedingAnalyzedThroughMs: Math.max(
        Number(latestSettings.feedingAnalyzedThroughMs) || 0,
        endMs
      ),
      feedingPendingFromMs: hasUncoveredPending
        ? Math.max(endMs - ALARM_ANALYSIS_OVERLAP_MS, 0)
        : 0,
      feedingPendingThroughMs: hasUncoveredPending ? latestPendingThroughMs : 0,
    });
    this.logger?.warn?.("[feed-analysis] abandoned stale alarm window after replay failure", {
      deviceSn,
      endTime: window.endTime,
      retryCount,
    });
    return true;
  }

  start() {
    if (!this.enabled || this.timer) return;
    if (!this.automationEnabled) return;
    this.store.recoverInterruptedRecordings?.();
    this.recoverMaterialSync();
    this.enqueueDueScans().catch(() => {});
    this.timer = setInterval(() => {
      this.recoverMaterialSync();
      this.enqueueDueScans().catch(() => {});
    }, this.pollIntervalMs);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

function createDefaultCoordinator({ config, resolveAnalysisSourceUrl } = {}) {
  const store = new FeedAnalysisStore(config.analysis.stateFile);
  let persistentSettingsStore = null;
  let persistentAnalysisStore = null;
  if (config.cloudHosting) {
    const cloudbase = require("@cloudbase/node-sdk");
    const app = cloudbase.init({
      env: config.cloudbaseEnvId,
      secretId: config.cloudbaseCredentials.secretId,
      secretKey: config.cloudbaseCredentials.secretKey,
    });
    persistentSettingsStore = new CloudFeedAnalysisSettingsStore({
      database: app.database(),
      collectionName: config.analysis.settingsCollection,
      bindingCollectionName: config.analysis.pushPlusBindingsCollection,
    });
    persistentAnalysisStore = new CloudFeedAnalysisRecordingStore({
      database: app.database(),
      collectionName: config.analysis.recordingsCollection,
    });
  }
  const openApi = new PushPlusOpenApi(config.pushPlus);
  const pushPlusBindingService = new PushPlusBindingService({
    store,
    persistentSettingsStore,
    persistentAnalysisStore,
    openApi,
    serviceQrUrl: config.pushPlus.serviceQrUrl,
  });
  return new FeedAnalysisCoordinator({
    enabled: config.analysis.enabled,
    store,
    deviceFactory: async () => {
      const device = new JFDevice({
        endpoint: config.endpoint,
        auth: config.auth,
        sn: config.device.sn,
        username: config.device.username,
        password: config.device.password,
      });
      const cachedToken = cache.get("token");
      if (cachedToken) {
        device.deviceToken = cachedToken;
      }
      if (!device.deviceToken) {
        await device.bind();
        const token = await device.getToken();
        cache.set("token", token, cache.TTL_TOKEN);
      }
      await device.login();
      return device;
    },
    analyzer: config.analysis.visionBaseUrl
      ? new VisionHttpAnalyzer({
          baseUrl: config.analysis.visionBaseUrl,
          detectionTarget: config.analysis.target,
          detectorBackend: config.analysis.detectorBackend,
          yoloModel: config.analysis.yoloModel,
          timeoutMs: config.analysis.visionTimeoutMs,
          token: config.analysis.visionToken,
          startupRetryMs: config.analysis.visionStartupRetryMs,
          retryIntervalMs: config.analysis.visionRetryIntervalMs,
        })
      : new VisionWorkerAnalyzer({
          pythonPath: config.analysis.pythonPath,
          workerScript: config.analysis.workerScript,
          minConfidence: config.analysis.minConfidence,
          timeoutMs: config.analysis.visionTimeoutMs,
        }),
    notifier: new PushPlusNotifier(config.pushPlus),
    pushPlusBindingService,
    persistentSettingsStore,
    notificationOwnerOpenid: config.pushPlus.ownerOpenid,
    pollIntervalMs: config.analysis.pollIntervalMs,
    detectionTarget: config.analysis.target,
    detectorBackend: config.analysis.detectorBackend,
    yoloModel: config.analysis.yoloModel,
    resolveAnalysisSourceUrl,
    globalConcurrency: config.analysis.globalConcurrency,
    playbackSpeed: config.analysis.playbackSpeed,
    playbackStreamType: config.analysis.playbackStreamType,
    orientation: config.analysis.orientation,
    screeningSampleSeconds: config.analysis.screeningSampleSeconds,
    alarmCompensationLookbackMs: config.analysis.alarmCompensationLookbackMs,
    alarmCompensationIntervalMs: config.analysis.alarmCompensationIntervalMs,
    feedingStartEnabled: config.analysis.feedingStart.enabled,
    feedingStartWindowMs: config.analysis.feedingStart.windowMs,
    feedingStartMaxWindowMs: config.analysis.feedingStart.maxWindowMs,
    feedingStartPreRollMs: config.analysis.feedingStart.preRollMs,
    feedingStartMinWindowMs: config.analysis.feedingStart.minWindowMs,
    feedingStartCandidateTtlMs: config.analysis.feedingStart.candidateTtlMs,
    feedingStartRearmQuietMs: config.analysis.feedingStart.rearmQuietMs,
    feedingStartExtensionMs: config.analysis.feedingStart.extensionMs,
    feedingStartConfirmationPolicy: config.analysis.feedingStart.confirmationPolicy,
    automationEnabled: config.analysis.automationEnabled,
    retryDelayMs: config.analysis.retryDelayMs,
    maxRetries: config.analysis.maxRetries,
    materialSyncMaxAttempts: config.analysis.materialSyncMaxAttempts,
    snapshotFallbackConfidence: config.analysis.minConfidence,
    alarmAdapter: new AlarmScanAdapter({
      paddingSeconds: config.analysis.alarmWindowPaddingSeconds,
      timeoutMs: config.analysis.alarmTimeoutMs,
    }),
    alarmCallbackBaseUrl: config.vendorAlarms?.callbackBaseUrl,
    alarmCallbackToken: config.vendorAlarms?.callbackToken,
  });
}

module.exports = {
  FeedAnalysisCoordinator,
  buildCandidateRanges,
  buildRollingAlarmAnalysisWindow,
  buildStructuredFeedingClip,
  createDefaultCoordinator,
  expandRecordingsForAnalysis,
  splitRecordingForAnalysis,
};
