function buildRecordingKey(record) {
  const beginTime = record.BeginTime || record.beginTime || "";
  const fileName = record.FileName || record.fileName || "";
  return `${beginTime}__${fileName}`;
}

function markerTypeOf(input) {
  if (input && typeof input === "object") return input.markerType || "";
  return String(input || "");
}

function markerTargetOf(input) {
  if (input && typeof input === "object") {
    const target = String(input.target || "").toLowerCase();
    if (target === "face" || String(input.markerType || "").startsWith("face_")) return "face";
    if (target === "cat" || String(input.markerType || "").startsWith("cat_")) return "cat";
  }
  const type = markerTypeOf(input);
  if (type.startsWith("face_")) return "face";
  return "cat";
}

function markerLabel(input) {
  const type = markerTypeOf(input);
  const target = markerTargetOf(input);
  const targetName = target === "face" ? "\u4eba\u8138" : "\u732b\u54aa";
  const map = {
    cat_enter: "\u732b\u54aa\u51fa\u73b0",
    cat_leave: "\u732b\u54aa\u79bb\u5f00",
    face_enter: "\u4eba\u8138\u51fa\u73b0",
    face_leave: "\u4eba\u8138\u79bb\u5f00",
    feeding_start: "\u5f00\u59cb\u8fdb\u98df",
    feeding_end: "\u7ed3\u675f\u8fdb\u98df",
    cute_extreme_closeup: "\u732b\u54aa\u5927\u7a81\u8138",
    cute_head_up: "\u732b\u54aa\u62ac\u5934",
  };
  if (map[type]) return map[type];
  if (/_enter$/.test(type)) return `${targetName}\u51fa\u73b0`;
  if (/_leave$/.test(type)) return `${targetName}\u79bb\u5f00`;
  return "\u4e8b\u4ef6\u6807\u8bb0";
}

function markerOffsetSec(marker = {}) {
  if (Number.isFinite(Number(marker.offsetSec))) return Math.max(0, Number(marker.offsetSec));
  if (Number.isFinite(Number(marker.offsetMs))) return Math.max(0, Number(marker.offsetMs) / 1000);
  return 0;
}

function markerPercent(marker = {}, durationSec = 0) {
  const duration = Math.max(1, Number(durationSec) || 0);
  const percent = markerOffsetSec(marker) / duration * 100;
  return Math.round(Math.max(0, Math.min(100, percent)) * 1000) / 1000;
}

function isTargetEnter(marker = {}) {
  return /_(enter)$/.test(marker.markerType || "");
}

function isTargetLeave(marker = {}) {
  return /_(leave)$/.test(marker.markerType || "");
}

function markerRangeTarget(marker = {}) {
  return /^feeding_/.test(marker.markerType || "") ? "feeding" : markerTargetOf(marker);
}

function isRangeStart(marker = {}) {
  return /_(enter|start)$/.test(marker.markerType || "");
}

function isRangeEnd(marker = {}) {
  return /_(leave|end)$/.test(marker.markerType || "");
}

function buildReplayMarkerRanges(markers = [], durationSec = 0) {
  const pending = {};
  const ranges = [];
  const sorted = markers
    .filter((marker) => marker && /^(?:(cat|face)_(enter|leave)|feeding_(start|end))$/.test(marker.markerType || ""))
    .slice()
    .sort((a, b) => markerOffsetSec(a) - markerOffsetSec(b));

  for (const marker of sorted) {
    const target = markerRangeTarget(marker);
    if (isRangeStart(marker)) {
      if (!pending[target]) pending[target] = [];
      pending[target].push(marker);
      continue;
    }
    if (isRangeEnd(marker) && pending[target] && pending[target].length > 0) {
      const startMarker = pending[target].shift();
      const startSec = markerOffsetSec(startMarker);
      const endSec = Math.max(startSec, markerOffsetSec(marker));
      ranges.push({
        target,
        startSec,
        endSec,
        leftPercent: markerPercent(startMarker, durationSec),
        widthPercent: Math.max(0, markerPercent(marker, durationSec) - markerPercent(startMarker, durationSec)),
      });
    }
  }

  Object.keys(pending).forEach((target) => {
    for (const startMarker of pending[target]) {
      const startSec = markerOffsetSec(startMarker);
      const duration = Math.max(startSec, Number(durationSec) || 0);
      ranges.push({
        target,
        startSec,
        endSec: duration,
        leftPercent: markerPercent(startMarker, durationSec),
        widthPercent: Math.max(0, markerPercent({ offsetSec: duration }, durationSec) - markerPercent(startMarker, durationSec)),
      });
    }
  });

  return ranges.sort((a, b) => a.startSec - b.startSec);
}

const MARKER_CHIP_ORDER = {
  cat_enter: 10,
  cat_leave: 20,
  feeding_start: 30,
  feeding_end: 40,
  face_enter: 50,
  face_leave: 60,
  cute_extreme_closeup: 65,
  cute_head_up: 70,
};

function buildReplayMarkerChips(markers = []) {
  const byType = {};
  markers.forEach((marker, index) => {
    const markerType = marker && marker.markerType ? marker.markerType : `unknown_${index}`;
    if (byType[markerType]) return;
    byType[markerType] = {
      ...marker,
      markerType,
      markerLabel: marker.markerLabel || markerLabel(marker),
      chipOrder: MARKER_CHIP_ORDER[markerType] || 1000 + index,
    };
  });
  return Object.values(byType)
    .sort((a, b) => (a.chipOrder || 0) - (b.chipOrder || 0))
    .map(({ chipOrder, ...marker }) => marker);
}

function analysisDisplay(status) {
  if (status === "queued" || status === "running") {
    return { analysisLabel: "\u5206\u6790\u4e2d", analysisTone: "running" };
  }
  if (status === "ready") {
    return { analysisLabel: "\u5df2\u5206\u6790", analysisTone: "ready" };
  }
  if (status === "failed") {
    return { analysisLabel: "\u5206\u6790\u5931\u8d25", analysisTone: "failed" };
  }
  return { analysisLabel: "", analysisTone: "" };
}

const CAT_RECORDING_MARKERS = new Set([
  "cat_enter",
  "cat_leave",
  "feeding_start",
  "feeding_end",
]);

function hasCatRecordingMarker(markers = []) {
  return markers.some((marker) => CAT_RECORDING_MARKERS.has(markerTypeOf(marker)));
}

function attachReplayMarkers(records = [], markers = [], analysisStatuses = []) {
  const byKey = markers.reduce((acc, marker) => {
    const key = marker.recordingKey || buildRecordingKey(marker);
    if (!acc[key]) acc[key] = [];
    acc[key].push({
      ...marker,
      markerLabel: markerLabel(marker),
    });
    return acc;
  }, {});
  const statusByKey = analysisStatuses.reduce((acc, item) => {
    if (item && item.recordingKey) acc[item.recordingKey] = item.status || "";
    return acc;
  }, {});

  return records.map((record) => {
    const key = buildRecordingKey(record);
    const recordMarkers = (byKey[key] || []).sort((a, b) => (markerOffsetSec(a) || a.markerTsMs || 0) - (markerOffsetSec(b) || b.markerTsMs || 0));
    const analysisStatus = statusByKey[key] || "";
    const hasCat = hasCatRecordingMarker(recordMarkers);
    if (analysisStatus === "ready" && !hasCat) return null;
    return {
      ...record,
      recordingKey: key,
      analysisStatus,
      ...analysisDisplay(analysisStatus),
      markers: recordMarkers,
      markerChips: buildReplayMarkerChips(recordMarkers),
      ...(analysisStatus === "ready" && hasCat ? { analysisLabel: "\u6709\u732b\u54aa" } : {}),
    };
  }).filter(Boolean);
}

module.exports = {
  attachReplayMarkers,
  buildReplayMarkerChips,
  buildRecordingKey,
  buildReplayMarkerRanges,
  markerLabel,
  markerOffsetSec,
  markerPercent,
  markerTargetOf,
};
