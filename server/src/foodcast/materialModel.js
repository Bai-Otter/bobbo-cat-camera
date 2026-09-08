const crypto = require("node:crypto");
const {
  formatDeviceDateKey,
  parseDeviceDateTime,
} = require("../feedAnalysis/deviceTime");

function validationError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function toTimestampMs(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const localDate = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? parseDeviceDateTime(text)
    : new Date(text);
  const timestamp = localDate && localDate.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function markerTimestampMs(marker) {
  return toTimestampMs(marker?.beginTime) ?? toTimestampMs(marker?.markerTsMs);
}

function formatDate(ms) {
  return formatDeviceDateKey(ms);
}

function intervalIdentity(interval) {
  return {
    id: interval.id ?? interval.intervalKey ?? "",
    startMs: interval.startMs,
    endMs: interval.endMs,
    source: interval.source ?? {
      clipId: interval.clipId,
      recordingKey: interval.recordingKey,
      playbackParams: interval.playbackParams,
    },
  };
}

function compareIntervals(left, right) {
  const boundsOrder = left.startMs - right.startMs || left.endMs - right.endMs;
  if (boundsOrder) return boundsOrder;
  const leftIdentity = stableJson(intervalIdentity(left));
  const rightIdentity = stableJson(intervalIdentity(right));
  return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
}

function validInterval(interval) {
  return interval
    && Number.isFinite(interval.startMs)
    && Number.isFinite(interval.endMs)
    && interval.endMs > interval.startMs;
}

function groupFeedingIntervals(intervals, { gapMs = 600_000 } = {}) {
  const threshold = Number(gapMs);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw validationError("MEAL_GAP_INVALID");
  }
  const ordered = (Array.isArray(intervals) ? intervals : [])
    .filter(validInterval)
    .slice()
    .sort(compareIntervals);
  const meals = [];
  for (const interval of ordered) {
    const current = meals[meals.length - 1];
    if (!current || interval.startMs - current.endMs >= threshold) {
      meals.push({
        startMs: interval.startMs,
        endMs: interval.endMs,
        date: formatDate(interval.startMs),
        intervalIds: [interval.id],
        intervals: [interval],
      });
      continue;
    }
    current.endMs = Math.max(current.endMs, interval.endMs);
    current.intervalIds.push(interval.id);
    current.intervals.push(interval);
  }
  return meals.map((meal) => ({
    ...meal,
    version: sha256(meal.intervals.map(intervalIdentity)),
  }));
}

function buildMealId(deviceSn, startMs) {
  return `meal-${sha256({ deviceSn: String(deviceSn || ""), startMs }).slice(0, 24)}`;
}

function buildInterval(clip, startMarker, startMs, endMs) {
  if (!validInterval({ startMs, endMs })) return null;
  const playbackParams = {
    ...(clip.playbackParams && typeof clip.playbackParams === "object" ? clip.playbackParams : {}),
    ...(startMarker.playbackParams && typeof startMarker.playbackParams === "object"
      ? startMarker.playbackParams
      : {}),
  };
  const source = {
    clipId: String(clip.id || ""),
    recordingKey: String(startMarker.recordingKey || clip.recordingKey || ""),
    playbackParams,
    clip: {
      id: String(clip.id || ""),
      beginTime: String(clip.beginTime || ""),
      endTime: String(clip.endTime || ""),
      fileName: String(clip.fileName || playbackParams.fileName || ""),
      playbackParams,
      analysisConfidence: Number(clip.analysisConfidence) || 0,
      markers: Array.isArray(clip.markers) ? clip.markers : [],
      cuteTimeline: Array.isArray(clip.cuteTimeline) ? clip.cuteTimeline : [],
    },
  };
  const eventId = String(startMarker.eventId || "").trim();
  const id = eventId || `interval-${sha256({ source, startMs, endMs }).slice(0, 24)}`;
  return { id, startMs, endMs, source };
}

function extractFeedingIntervals(clip = {}) {
  const clipStartMs = toTimestampMs(clip.beginTime);
  const clipEndMs = toTimestampMs(clip.endTime);
  if (clipStartMs === null || clipEndMs === null || clipEndMs <= clipStartMs) return [];
  const markers = (Array.isArray(clip.markers) ? clip.markers : [])
    .map((marker, index) => ({ marker, index, timestampMs: markerTimestampMs(marker) }))
    .filter((item) => item.timestampMs !== null)
    .sort((left, right) => left.timestampMs - right.timestampMs || left.index - right.index);
  const intervals = [];
  let pendingStart = null;
  for (const item of markers) {
    if (item.marker?.markerType === "feeding_start") {
      pendingStart = item;
      continue;
    }
    if (item.marker?.markerType !== "feeding_end" || !pendingStart) continue;
    const startMs = Math.max(clipStartMs, pendingStart.timestampMs);
    const endMs = Math.min(clipEndMs, item.timestampMs);
    const interval = buildInterval(clip, pendingStart.marker, startMs, endMs);
    if (interval) intervals.push(interval);
    pendingStart = null;
  }
  if (pendingStart) {
    const startMs = Math.max(clipStartMs, pendingStart.timestampMs);
    const interval = buildInterval(clip, pendingStart.marker, startMs, clipEndMs);
    if (interval) intervals.push(interval);
  }
  return intervals;
}

function buildOutputMapping(intervals) {
  const ordered = (Array.isArray(intervals) ? intervals : [])
    .filter(validInterval)
    .slice()
    .sort(compareIntervals);
  let outputStartSec = 0;
  return ordered.map((interval) => {
    const durationSec = (interval.endMs - interval.startMs) / 1000;
    const item = {
      intervalId: interval.id,
      sourceStartMs: interval.startMs,
      sourceEndMs: interval.endMs,
      outputStartSec,
      outputEndSec: outputStartSec + durationSec,
    };
    outputStartSec = item.outputEndSec;
    return item;
  });
}

function mapSourceRangeToMeal(mapping, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw validationError("SOURCE_RANGE_INVALID");
  }
  const entries = Array.isArray(mapping) ? mapping : [];
  for (const item of entries) {
    if (!Number.isFinite(item?.sourceStartMs)
      || !Number.isFinite(item?.sourceEndMs)
      || item.sourceEndMs <= item.sourceStartMs
      || !Number.isFinite(item?.outputStartSec)
      || !Number.isFinite(item?.outputEndSec)
      || item.outputEndSec <= item.outputStartSec) {
      throw validationError("SOURCE_MAPPING_INVALID");
    }
  }
  const containing = entries.filter((item) => (
    item.sourceStartMs <= startMs && endMs <= item.sourceEndMs
  ));
  if (containing.length === 1) {
    const item = containing[0];
    return {
      startSec: item.outputStartSec + (startMs - item.sourceStartMs) / 1000,
      endSec: item.outputStartSec + (endMs - item.sourceStartMs) / 1000,
    };
  }
  const overlaps = entries.some((item) => startMs < item.sourceEndMs && endMs > item.sourceStartMs);
  if (!overlaps) return null;
  throw validationError("SOURCE_RANGE_NOT_CONTAINED");
}

function materialFromLookup(materials, id) {
  if (materials instanceof Map) return materials.get(id);
  if (materials && typeof materials === "object" && Object.prototype.hasOwnProperty.call(materials, id)) {
    return materials[id];
  }
  return undefined;
}

function validateCustomComposition(input = {}) {
  const segments = Array.isArray(input.segments) ? input.segments : [];
  if (segments.length < 1 || segments.length > 10) {
    throw validationError("CUSTOM_SEGMENT_COUNT_INVALID");
  }
  const normalizedSegments = [];
  const selectedIds = new Set();
  let totalDurationSec = 0;
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  for (const segment of segments) {
    const materialId = String(segment?.materialId || "").trim();
    if (selectedIds.has(materialId)) throw validationError("CUSTOM_MATERIAL_DUPLICATE");
    selectedIds.add(materialId);
    const selectedMaterial = materialFromLookup(input.materials, materialId);
    if (!materialId || !selectedMaterial) throw validationError("CUSTOM_MATERIAL_NOT_FOUND");
    if (String(selectedMaterial.ownerOpenid || "") !== String(input.ownerOpenid || "")) {
      throw validationError("CUSTOM_MATERIAL_OWNER_MISMATCH");
    }
    if (String(selectedMaterial.deviceSn || "") !== String(input.deviceSn || "")) {
      throw validationError("CUSTOM_MATERIAL_DEVICE_MISMATCH");
    }
    const rawExpiry = selectedMaterial.expiresAtMs ?? selectedMaterial.expiresAt;
    const expiresAtMs = rawExpiry === undefined || rawExpiry === null || rawExpiry === ""
      ? null
      : toTimestampMs(rawExpiry);
    if (rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== ""
      && (expiresAtMs === null || expiresAtMs <= nowMs)) {
      throw validationError("CUSTOM_MATERIAL_EXPIRED");
    }
    const trimStartSec = Number(segment.trimStartSec);
    const trimEndSec = Number(segment.trimEndSec);
    const materialDurationSec = Number(selectedMaterial.durationSec);
    if (!Number.isFinite(trimStartSec)
      || !Number.isFinite(trimEndSec)
      || !Number.isFinite(materialDurationSec)
      || trimStartSec < 0
      || trimEndSec <= trimStartSec
      || trimEndSec > materialDurationSec) {
      throw validationError("CUSTOM_TRIM_INVALID");
    }
    totalDurationSec += trimEndSec - trimStartSec;
    normalizedSegments.push({ materialId, trimStartSec, trimEndSec });
  }
  if (totalDurationSec > 60) throw validationError("CUSTOM_DURATION_EXCEEDED");
  if (input.frameMode !== "source" && input.frameMode !== "center_crop") {
    throw validationError("CUSTOM_FRAME_MODE_INVALID");
  }
  const bgmId = String(input.bgmId || "").trim();
  if (!bgmId || bgmId.toLowerCase() === "random" || bgmId.toLowerCase() === "none") {
    throw validationError("CUSTOM_BGM_REQUIRED");
  }
  const bgmVolume = Number(input.bgmVolume);
  if (!Number.isFinite(bgmVolume) || bgmVolume < 0.2 || bgmVolume > 1) {
    throw validationError("CUSTOM_BGM_VOLUME_INVALID");
  }
  return {
    ownerOpenid: String(input.ownerOpenid || ""),
    deviceSn: String(input.deviceSn || ""),
    frameMode: input.frameMode,
    bgmId,
    bgmVolume,
    segments: normalizedSegments,
    totalDurationSec,
  };
}

module.exports = {
  buildMealId,
  buildOutputMapping,
  extractFeedingIntervals,
  groupFeedingIntervals,
  mapSourceRangeToMeal,
  validateCustomComposition,
};
