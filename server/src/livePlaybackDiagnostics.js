const { safeErrorCode } = require("./accountSyncAudit");

const LIVE_PLAYBACK_EVENTS = new Set([
  "session_started",
  "shared_access_granted",
  "shared_access_failed",
  "device_login_succeeded",
  "device_login_failed",
  "stream_url_succeeded",
  "stream_url_failed",
  "video_play",
  "media_progress_confirmed",
  "video_error",
  "playback_failed",
  "session_ended",
]);

const LIVE_PLAYBACK_SOURCES = new Set(["app", "sdk", "backend", "player"]);

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanSessionId(value) {
  const text = cleanText(value, 80);
  return /^[A-Za-z0-9_-]{8,80}$/.test(text) ? text : "";
}

function cleanErrorCode(value) {
  const text = cleanText(value, 80).toUpperCase().replace(/[^A-Z0-9_-]/g, "_");
  return text.replace(/^_+|_+$/g, "").slice(0, 80);
}

function normalizeLivePlaybackEvent(payload = {}) {
  const sessionId = cleanSessionId(payload.sessionId);
  if (!sessionId) {
    const error = new Error("LIVE_PLAYBACK_SESSION_INVALID");
    error.code = error.message;
    throw error;
  }
  const event = cleanText(payload.event, 80);
  if (!LIVE_PLAYBACK_EVENTS.has(event)) {
    const error = new Error("LIVE_PLAYBACK_EVENT_INVALID");
    error.code = error.message;
    throw error;
  }
  const source = cleanText(payload.source, 20).toLowerCase();
  if (!LIVE_PLAYBACK_SOURCES.has(source)) {
    const error = new Error("LIVE_PLAYBACK_SOURCE_INVALID");
    error.code = error.message;
    throw error;
  }
  return {
    sessionId,
    event,
    source,
    errorCode: cleanErrorCode(payload.errorCode),
  };
}

function isLivePlaybackDiagnosticDevice(sn, configuredSn) {
  const target = cleanText(configuredSn, 128);
  return !!target && cleanText(sn, 128) === target;
}

function normalizeProbeStatus(status) {
  if (!status || typeof status !== "object") return { status: "unknown" };
  const value = cleanText(status.status || status.Status || "unknown", 40).toLowerCase();
  return {
    status: value || "unknown",
    authStatus: Number(status.authStatus ?? status.AuthStatus) || 0,
    channelCount: Array.isArray(status.channel)
      ? status.channel.length
      : Array.isArray(status.Channel)
        ? status.Channel.length
        : 0,
  };
}

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 5000));
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponsePrefix(response, maxBytes = 4096) {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    try {
      const first = await reader.read();
      return first && first.value ? first.value.slice(0, maxBytes) : new Uint8Array();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  return buffer.slice(0, maxBytes);
}

function firstHlsSegment(playlist) {
  return String(playlist || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#")) || "";
}

async function verifyHlsMedia(url, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== "function") throw new Error("LIVE_PROBE_FETCH_UNAVAILABLE");
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 5000);
  const attempts = Math.max(1, Number(options.attempts) || 4);
  const pollDelayMs = Math.max(0, Number(options.pollDelayMs) || 1000);
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(fetchImpl, url, {}, timeoutMs);
      if (!response.ok) throw new Error(`LIVE_PROBE_PLAYLIST_HTTP_${response.status}`);
      const playlist = await response.text();
      if (!String(playlist).includes("#EXTM3U")) throw new Error("LIVE_PROBE_PLAYLIST_INVALID");
      const segment = firstHlsSegment(playlist);
      if (!segment) throw new Error("LIVE_PROBE_SEGMENT_NOT_READY");
      const segmentUrl = new URL(segment, url).toString();
      const segmentResponse = await fetchWithTimeout(fetchImpl, segmentUrl, {
        headers: { Range: "bytes=0-4095" },
      }, timeoutMs);
      if (!segmentResponse.ok) throw new Error(`LIVE_PROBE_SEGMENT_HTTP_${segmentResponse.status}`);
      const prefix = await readResponsePrefix(segmentResponse);
      if (!prefix.byteLength) throw new Error("LIVE_PROBE_SEGMENT_EMPTY");
      return { playlistReady: true, segmentReady: true, segmentBytesRead: prefix.byteLength };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts && pollDelayMs > 0) await delay(pollDelayMs);
    }
  }
  throw lastError || new Error("LIVE_PROBE_MEDIA_UNAVAILABLE");
}

async function probeLiveDevice(options = {}) {
  const device = options.device;
  if (!device) throw new Error("LIVE_PROBE_DEVICE_REQUIRED");
  const result = {
    ok: false,
    sn: cleanText(options.sn || device.sn, 128),
    probeAt: new Date().toISOString(),
    tokenReady: false,
    status: { status: "unknown" },
    loginReady: false,
    streamReady: false,
    mediaReady: false,
    streamClosed: false,
    errorCode: "",
  };
  let streamOpened = false;
  try {
    await device.ensureDeviceToken();
    result.tokenReady = true;
    result.status = normalizeProbeStatus(await device.status());
    await device.login();
    result.loginReady = true;
    const streamUrl = await device.getLivestreamUrl(
      options.protocol || "hls-ts",
      options.channel ?? "0",
      options.stream ?? "1"
    );
    result.streamReady = !!streamUrl;
    streamOpened = !!streamUrl;
    const media = await verifyHlsMedia(streamUrl, options);
    result.mediaReady = !!(media.playlistReady && media.segmentReady);
    result.mediaBytesRead = Number(media.segmentBytesRead) || 0;
    result.ok = result.mediaReady;
  } catch (error) {
    result.errorCode = safeErrorCode(error);
  } finally {
    if (streamOpened && typeof device.closeLivestream === "function") {
      try {
        await device.closeLivestream(options.channel ?? "0", options.stream ?? "1");
        result.streamClosed = true;
      } catch (error) {
        result.closeErrorCode = safeErrorCode(error);
      }
    }
  }
  return result;
}

module.exports = {
  LIVE_PLAYBACK_EVENTS,
  isLivePlaybackDiagnosticDevice,
  normalizeLivePlaybackEvent,
  normalizeProbeStatus,
  probeLiveDevice,
  verifyHlsMedia,
};
