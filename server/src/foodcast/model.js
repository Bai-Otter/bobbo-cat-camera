function parseLocalTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value).replace(/-/g, "/"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatLocalTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const milliseconds = date.getMilliseconds();
  const suffix = milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${suffix}`;
}

function toMs(value) {
  const date = parseLocalTime(value);
  return date ? date.getTime() : 0;
}

function markerMs(item) {
  return toMs(item?.beginTime) || Number(item?.markerTsMs) || 0;
}

function pairFeedingIntervals(clip) {
  const clipStartMs = toMs(clip.beginTime);
  const clipEndMs = toMs(clip.endTime);
  if (!clipStartMs || clipEndMs <= clipStartMs) return [];
  const markers = Array.isArray(clip.markers)
    ? clip.markers.slice().sort((a, b) => markerMs(a) - markerMs(b))
    : [];
  const intervals = [];
  let startMarker = null;
  for (const item of markers) {
    if (item.markerType === "feeding_start") {
      startMarker = item;
      continue;
    }
    if (item.markerType !== "feeding_end" || !startMarker) continue;
    const startMs = Math.max(clipStartMs, markerMs(startMarker));
    const endMs = Math.min(clipEndMs, markerMs(item) || clipEndMs);
    if (endMs > startMs) {
      intervals.push({
        clip,
        intervalKey: `${clip.id || clipStartMs}:${intervals.length}`,
        startMs,
        endMs,
        confidence: Math.max(
          Number(clip.analysisConfidence) || 0,
          Number(startMarker.confidence) || 0,
          Number(item.confidence) || 0
        ),
      });
    }
    startMarker = null;
  }
  if (startMarker) {
    const startMs = Math.max(clipStartMs, markerMs(startMarker));
    if (clipEndMs > startMs) {
      intervals.push({
        clip,
        intervalKey: `${clip.id || clipStartMs}:${intervals.length}`,
        startMs,
        endMs: clipEndMs,
        confidence: Math.max(
          Number(clip.analysisConfidence) || 0,
          Number(startMarker.confidence) || 0
        ),
      });
    }
  }
  return intervals;
}

function boundInterval(interval, mealStartMs, mealEndMs) {
  const startMs = mealStartMs ? Math.max(interval.startMs, mealStartMs) : interval.startMs;
  const endMs = mealEndMs ? Math.min(interval.endMs, mealEndMs) : interval.endMs;
  return endMs > startMs ? { ...interval, startMs, endMs } : null;
}

function buildCuteCandidates(clips, {
  beforeSec,
  afterSec,
  markerTypes,
  minSegmentSec,
  minMarkerConfidence = 0,
  minModelConfidence = 0,
  minCuteScore = 0,
  mealStartMs,
  mealEndMs,
}) {
  const beforeMs = Math.max(0, Number(beforeSec) || 0) * 1000;
  const afterMs = Math.max(0, Number(afterSec) || 0) * 1000;
  const eligibleTypes = new Set(markerTypes);
  const minimumMs = Math.max(0, Number(minSegmentSec) || 0) * 1000;
  const minimumMarkerConfidence = Math.max(0, Number(minMarkerConfidence) || 0);
  const minimumModelConfidence = Math.max(0, Number(minModelConfidence) || 0);
  const minimumCuteScore = Math.max(0, Number(minCuteScore) || 0);
  const candidates = [];
  for (const clip of clips) {
    const cuteMarkers = (Array.isArray(clip.markers) ? clip.markers : [])
      .map((item) => {
        const legacyConfidence = Number(item.confidence) || 0;
        const modelConfidence = Number.isFinite(Number(item.modelConfidence))
          ? Number(item.modelConfidence)
          : legacyConfidence;
        const cuteScore = Number.isFinite(Number(item.cuteScore))
          ? Number(item.cuteScore)
          : legacyConfidence;
        return { ...item, modelConfidence, cuteScore };
      })
      .filter((item) => (
        eligibleTypes.has(item.markerType)
        && (Number(item.confidence) || 0) >= minimumMarkerConfidence
        && item.modelConfidence >= minimumModelConfidence
        && item.cuteScore >= minimumCuteScore
      ));
    for (const rawInterval of pairFeedingIntervals(clip)) {
      const interval = boundInterval(rawInterval, mealStartMs, mealEndMs);
      if (!interval) continue;
      for (const item of cuteMarkers) {
        const atMs = markerMs(item);
        if (!atMs || atMs < interval.startMs || atMs > interval.endMs) continue;
        const startMs = Math.max(interval.startMs, atMs - beforeMs);
        const endMs = Math.min(interval.endMs, atMs + afterMs);
        if (endMs - startMs < minimumMs) continue;
        candidates.push({
          clip,
          intervalKey: interval.intervalKey,
          startMs,
          endMs,
          confidence: Math.max(Number(item.confidence) || 0, interval.confidence),
          markerTypes: [item.markerType],
          modelConfidence: item.modelConfidence,
          cuteScore: item.cuteScore,
          cuteReasons: Array.isArray(item.cuteReasons) ? item.cuteReasons.slice() : [],
        });
      }
    }
  }
  return candidates;
}

const QUICK_CUT_TARGETS = new Set([20, 30, 60, 120, 180]);
const QUICK_CUT_MIN_SEGMENT_SEC = 4;
const QUICK_CUT_MAX_GAP_SEC = 1;
const NATURAL_MAX_SEGMENTS = 24;
const NATURAL_MAX_GAP_SEC = 1;
const QUICK_CUT_MARKER_TYPES = [
  "cute_closeup",
  "cute_front",
  "cute_extreme_closeup",
  "cute_head_up",
  "cute_profile_left",
  "cute_profile_right",
];

function normalizeQuickCutTarget(value) {
  const target = Number(value);
  return QUICK_CUT_TARGETS.has(target) ? target : 60;
}

function timelineMarkerTypes(reasons) {
  const mapping = {
    closeup: "cute_closeup",
    extreme_closeup: "cute_extreme_closeup",
    front: "cute_front",
    head_up: "cute_head_up",
    profile_left: "cute_profile_left",
    profile_right: "cute_profile_right",
  };
  return sortMarkerTypes((reasons || []).map((reason) => mapping[reason]).filter(Boolean));
}

function compareTimelineSamples(a, b) {
  return (Number(b.relationRank) || 0) - (Number(a.relationRank) || 0)
    || b.cuteScore - a.cuteScore
    || b.modelConfidence - a.modelConfidence
    || a.sourceMs - b.sourceMs;
}

function timelineRelationMarkerType(relation) {
  return {
    toward_camera: "cute_toward_camera",
    profile_left: "cute_profile_left",
    profile_right: "cute_profile_right",
    looking_away: "cute_looking_away",
    head_down: "cute_head_down",
  }[relation] || "";
}

function relationRank(relation) {
  return relation === "toward_camera" ? 2 : relation === "profile_left" || relation === "profile_right" ? 1 : 0;
}

function relationCuteMinimum(relation) {
  if (relation === "profile_left" || relation === "profile_right") return 0.55;
  if (relation === "unknown") return 0.65;
  return 0.75;
}

function lowerBoundTimeline(samples, sourceMs) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].sourceMs < sourceMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundTimeline(samples, sourceMs) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].sourceMs <= sourceMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function findTimelinePeakWindow(intervalSamples, initialIndex, interval) {
  const initialSample = intervalSamples[initialIndex];
  const searchStartIndex = lowerBoundTimeline(intervalSamples, initialSample.sourceMs - 2000);
  const searchEndIndex = upperBoundTimeline(intervalSamples, initialSample.sourceMs + 3000);
  let peak = initialSample;
  for (let index = searchStartIndex; index < searchEndIndex; index += 1) {
    if (compareTimelineSamples(intervalSamples[index], peak) < 0) peak = intervalSamples[index];
  }
  const startMs = Math.max(interval.startMs, peak.sourceMs - 2000);
  const endMs = Math.min(interval.endMs, peak.sourceMs + 3000);
  const qualifyingStartIndex = lowerBoundTimeline(intervalSamples, startMs);
  const qualifyingEndIndex = upperBoundTimeline(intervalSamples, endMs);
  const qualifyingSamples = intervalSamples.slice(qualifyingStartIndex, qualifyingEndIndex);
  let finalPeak = peak;
  for (const sample of qualifyingSamples) {
    if (compareTimelineSamples(sample, finalPeak) < 0) finalPeak = sample;
  }
  return { peak: finalPeak, startMs, endMs, qualifyingSamples };
}

function buildTimelineCandidates(clips, { mealStartMs, mealEndMs, selectionProfile = "strict" }) {
  const minimumMs = QUICK_CUT_MIN_SEGMENT_SEC * 1000;
  const candidates = [];
  for (const clip of clips) {
    if (!Array.isArray(clip.cuteTimeline)) continue;
    const clipStartMs = toMs(clip.beginTime);
    if (!clipStartMs) continue;
    const timeline = clip.cuteTimeline
      .map((item) => ({
        sourceMs: clipStartMs + Number(item?.offsetSec) * 1000,
        cuteScore: Number(item?.cuteScore),
        modelConfidence: Number(item?.modelConfidence),
        cuteReasons: Array.isArray(item?.cuteReasons)
          ? item.cuteReasons.filter((reason) => typeof reason === "string")
          : [],
        hasCat: item?.hasCat === true,
        faceRelation: typeof item?.faceRelation === "string" ? item.faceRelation : "",
        strictEligible: item?.strictEligible === true,
        looseEligible: item?.looseEligible === true,
      }))
      .filter((item) => (
        Number.isFinite(item.sourceMs)
        && item.hasCat
        && item.modelConfidence >= 0.65
        && item.cuteScore >= relationCuteMinimum(item.faceRelation)
        && (
          item.faceRelation
            ? (selectionProfile === "loose" ? item.looseEligible : item.strictEligible)
            : true
        )
      ))
      .sort((a, b) => a.sourceMs - b.sourceMs);

    for (const rawInterval of pairFeedingIntervals(clip)) {
      const interval = boundInterval(rawInterval, mealStartMs, mealEndMs);
      if (!interval) continue;
      const intervalStartIndex = lowerBoundTimeline(timeline, interval.startMs);
      const intervalEndIndex = upperBoundTimeline(timeline, interval.endMs);
      const intervalSamples = timeline.slice(intervalStartIndex, intervalEndIndex);
      const seenPeakTimes = new Set();
      for (let index = 0; index < intervalSamples.length; index += 1) {
        const peakWindow = findTimelinePeakWindow(intervalSamples, index, interval);
        if (!peakWindow) continue;
        const { peak, startMs, endMs, qualifyingSamples } = peakWindow;
        if (endMs - startMs < minimumMs) continue;
        if (seenPeakTimes.has(peak.sourceMs)) continue;
        seenPeakTimes.add(peak.sourceMs);
        const cuteReasons = Array.from(new Set(qualifyingSamples.flatMap((item) => item.cuteReasons)));
        candidates.push({
          clip,
          intervalKey: interval.intervalKey,
          startMs,
          endMs,
          confidence: Math.max(peak.modelConfidence, interval.confidence),
          markerTypes: Array.from(new Set([
            ...timelineMarkerTypes(cuteReasons),
            timelineRelationMarkerType(peak.faceRelation),
          ].filter(Boolean))),
          modelConfidence: peak.modelConfidence,
          cuteScore: peak.cuteScore,
          cuteReasons,
          faceRelations: Array.from(new Set(qualifyingSamples.map((item) => item.faceRelation).filter(Boolean))),
          faceRelation: peak.faceRelation,
          relationRank: relationRank(peak.faceRelation),
          qualifyingSampleCount: qualifyingSamples.length,
          sourceMs: peak.sourceMs,
        });
      }
    }
  }
  return candidates;
}

function buildLegacyQuickCutCandidates(clips, { mealStartMs, mealEndMs }) {
  return buildCuteCandidates(clips, {
    beforeSec: 2,
    afterSec: 3,
    markerTypes: QUICK_CUT_MARKER_TYPES,
    minSegmentSec: QUICK_CUT_MIN_SEGMENT_SEC,
    minModelConfidence: 0.65,
    minCuteScore: 0.8,
    mealStartMs,
    mealEndMs,
  }).map((candidate) => ({
    ...candidate,
    qualifyingSampleCount: 1,
    sourceMs: candidate.startMs + 2000,
  }));
}

function compareTimelineCandidates(a, b) {
  return b.cuteScore - a.cuteScore
    || b.modelConfidence - a.modelConfidence
    || (Number(b.qualifyingSampleCount) || 0) - (Number(a.qualifyingSampleCount) || 0)
    || (Number(a.sourceMs) || a.startMs) - (Number(b.sourceMs) || b.startMs)
    || a.startMs - b.startMs;
}

function rejectOverlappingTimelineCandidates(candidates) {
  const retained = [];
  for (const candidate of candidates.slice().sort(compareTimelineCandidates)) {
    const overlaps = retained.some((item) => (
      candidate.startMs < item.endMs
      && candidate.endMs > item.startMs
    ));
    if (!overlaps) retained.push(candidate);
  }
  return retained;
}

function totalCandidateDurationMs(candidates) {
  return candidates.reduce((total, item) => total + item.endMs - item.startMs, 0);
}

function mergeTimelineSelection(candidates) {
  return mergeCuteCandidates(candidates, { maxGapSec: QUICK_CUT_MAX_GAP_SEC });
}

function selectTimelineCandidates(candidates, targetDurationSec) {
  const targetMs = normalizeQuickCutTarget(targetDurationSec) * 1000;
  const minimumMs = QUICK_CUT_MIN_SEGMENT_SEC * 1000;
  const selected = [];
  for (const candidate of rejectOverlappingTimelineCandidates(candidates)) {
    const currentDurationMs = totalCandidateDurationMs(mergeTimelineSelection(selected));
    const remainingMs = targetMs - currentDurationMs;
    if (remainingMs < minimumMs) break;

    const withFullCandidate = mergeTimelineSelection([...selected, candidate]);
    const fullDurationMs = totalCandidateDurationMs(withFullCandidate);
    if (fullDurationMs <= targetMs) {
      selected.push(candidate);
      continue;
    }

    const overflowMs = fullDurationMs - targetMs;
    const trimmedDurationMs = candidate.endMs - candidate.startMs - overflowMs;
    if (trimmedDurationMs < minimumMs) continue;
    selected.push({ ...candidate, endMs: candidate.startMs + trimmedDurationMs });
  }
  return mergeTimelineSelection(selected);
}

function noCuteMaterialError() {
  const error = new Error("NO_CUTE_MATERIAL");
  error.code = "NO_CUTE_MATERIAL";
  return error;
}

function hasCuteTimeline(clip) {
  return Array.isArray(clip?.cuteTimeline) && clip.cuteTimeline.length > 0;
}

function sortMarkerTypes(values) {
  const order = {
    cute_closeup: 0,
    cute_front: 1,
    cute_extreme_closeup: 2,
    cute_head_up: 3,
    cute_profile_left: 4,
    cute_profile_right: 5,
  };
  return Array.from(new Set(values)).sort((a, b) => (order[a] ?? 99) - (order[b] ?? 99));
}

function mergeCuteCandidates(candidates, { maxGapSec }) {
  const maxGapMs = Math.max(0, Number(maxGapSec) || 0) * 1000;
  const sorted = candidates.slice().sort((a, b) =>
    String(a.intervalKey).localeCompare(String(b.intervalKey)) || a.startMs - b.startMs
  );
  const merged = [];
  for (const candidate of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && previous.intervalKey === candidate.intervalKey
      && candidate.startMs <= previous.endMs + maxGapMs
    ) {
      previous.endMs = Math.max(previous.endMs, candidate.endMs);
      previous.confidence = Math.max(previous.confidence, candidate.confidence);
      previous.modelConfidence = Math.max(previous.modelConfidence, candidate.modelConfidence);
      previous.cuteScore = Math.max(previous.cuteScore, candidate.cuteScore);
      previous.cuteReasons = Array.from(new Set([
        ...(previous.cuteReasons || []),
        ...(candidate.cuteReasons || []),
      ]));
      previous.markerTypes = sortMarkerTypes([...previous.markerTypes, ...candidate.markerTypes]);
      continue;
    }
    merged.push({ ...candidate, markerTypes: sortMarkerTypes(candidate.markerTypes) });
  }
  return merged;
}

function rankAndLimit(candidates, {
  maxSegments,
  maxDurationSec,
  minSegmentSec,
  prioritizeDiversity = false,
}) {
  const segmentLimit = Math.max(0, Number(maxSegments) || 0);
  let remainingMs = Math.max(0, Number(maxDurationSec) || 0) * 1000;
  const minimumMs = Math.max(0, Number(minSegmentSec) || 0) * 1000;
  const pool = candidates.slice();
  const selected = [];
  const seenTypes = new Set();
  while (pool.length && selected.length < segmentLimit && remainingMs >= minimumMs) {
    pool.sort((a, b) => {
      const noveltyA = a.markerTypes.filter((item) => !seenTypes.has(item)).length;
      const noveltyB = b.markerTypes.filter((item) => !seenTypes.has(item)).length;
      if (prioritizeDiversity && noveltyB !== noveltyA) return noveltyB - noveltyA;
      return b.confidence - a.confidence || noveltyB - noveltyA || a.startMs - b.startMs;
    });
    const candidate = pool.shift();
    const availableMs = candidate.endMs - candidate.startMs;
    const durationMs = Math.min(availableMs, remainingMs);
    if (durationMs < minimumMs) continue;
    selected.push({ ...candidate, endMs: candidate.startMs + durationMs });
    candidate.markerTypes.forEach((item) => seenTypes.add(item));
    remainingMs -= durationMs;
  }
  return selected;
}

function buildFallbackCandidates(clips, { mealStartMs, mealEndMs, minSegmentSec }) {
  const minimumMs = Math.max(0, Number(minSegmentSec) || 0) * 1000;
  return clips
    .flatMap((clip) => pairFeedingIntervals(clip))
    .map((interval) => boundInterval(interval, mealStartMs, mealEndMs))
    .filter((interval) => interval && interval.endMs - interval.startMs >= minimumMs)
    .map((interval) => ({ ...interval, markerTypes: [] }));
}

function selectFallback(candidates, { maxSegments, maxDurationSec, minSegmentSec }) {
  const segmentLimit = Math.max(0, Number(maxSegments) || 0);
  let remainingMs = Math.max(0, Number(maxDurationSec) || 0) * 1000;
  const minimumMs = Math.max(0, Number(minSegmentSec) || 0) * 1000;
  const ranked = candidates.slice().sort((a, b) => b.confidence - a.confidence || a.startMs - b.startMs);
  const selected = [];
  for (const candidate of ranked) {
    if (selected.length >= segmentLimit || remainingMs < minimumMs) break;
    const durationMs = Math.min(candidate.endMs - candidate.startMs, remainingMs);
    if (durationMs < minimumMs) continue;
    selected.push({ ...candidate, endMs: candidate.startMs + durationMs });
    remainingMs -= durationMs;
  }
  return selected;
}

function selectChronologicalFeedingSegments(candidates, targetDurationSec) {
  let remainingMs = Math.max(0, Number(targetDurationSec) || 0) * 1000;
  const selected = [];
  let coveredUntilMs = 0;
  for (const original of candidates.slice().sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    if (remainingMs <= 0) break;
    const candidate = { ...original, startMs: Math.max(original.startMs, coveredUntilMs) };
    if (candidate.endMs <= candidate.startMs) continue;

    const previous = selected[selected.length - 1];
    const sameSource = previous && previous.clip === candidate.clip;
    const canMerge = sameSource && candidate.startMs <= previous.endMs + NATURAL_MAX_GAP_SEC * 1000;
    if (canMerge) {
      const extensionMs = Math.min(candidate.endMs - previous.endMs, remainingMs);
      if (extensionMs <= 0) continue;
      previous.endMs += extensionMs;
      coveredUntilMs = Math.max(coveredUntilMs, previous.endMs);
      remainingMs -= extensionMs;
      continue;
    }

    if (selected.length >= NATURAL_MAX_SEGMENTS) break;
    const durationMs = Math.min(candidate.endMs - candidate.startMs, remainingMs);
    if (durationMs <= 0) continue;
    selected.push({ ...candidate, endMs: candidate.startMs + durationMs });
    coveredUntilMs = Math.max(coveredUntilMs, candidate.startMs + durationMs);
    remainingMs -= durationMs;
  }
  return selected;
}

function toPublicSegment(candidate) {
  const startTime = formatLocalTime(candidate.startMs);
  const endTime = formatLocalTime(candidate.endMs);
  return {
    clipId: candidate.clip.id || "",
    startTime,
    endTime,
    durationSec: (candidate.endMs - candidate.startMs) / 1000,
    confidence: candidate.confidence,
    modelConfidence: candidate.modelConfidence,
    cuteScore: candidate.cuteScore,
    cuteReasons: candidate.cuteReasons || [],
    faceRelation: candidate.faceRelation || "",
    faceRelations: candidate.faceRelations || [],
    markerTypes: candidate.markerTypes || [],
    playbackParams: {
      startTime,
      endTime,
      fileName: candidate.clip.fileName || candidate.clip.playbackParams?.fileName || "",
    },
  };
}

function selectFoodcastSegments({
  diary = {},
  scope = "day",
  mealId = "",
  mode = "natural",
  highlightRadiusSec = 5,
  minSegmentSec = 2,
  mergeGapSec = 1,
  maxSegments = 6,
  maxDurationSec = 60,
  fallbackMaxSegments = 2,
  fallbackMaxDurationSec = 20,
  targetDurationSec = 60,
  selectionProfile = "strict",
} = {}) {
  let clips = Array.isArray(diary.clips) ? diary.clips : [];
  let meal = null;
  if (scope === "meal") {
    meal = (Array.isArray(diary.meals) ? diary.meals : []).find((item) => item.id === mealId) || null;
    if (!meal) return [];
    const clipIds = new Set(Array.isArray(meal.clipIds) ? meal.clipIds : []);
    clips = clips.filter((item) => clipIds.has(item.id));
  }
  const mealStartMs = meal ? toMs(meal.startTime) : 0;
  const mealEndMs = meal ? toMs(meal.endTime) : 0;
  if (mode === "quick_cut") {
    const hasTimeline = clips.some(hasCuteTimeline);
    if (hasTimeline) {
      const targetSec = normalizeQuickCutTarget(targetDurationSec);
      const legacyClips = clips.filter((clip) => !hasCuteTimeline(clip));
      const selected = selectTimelineCandidates(
        [
          ...buildTimelineCandidates(clips, { mealStartMs, mealEndMs, selectionProfile }),
          ...buildLegacyQuickCutCandidates(legacyClips, { mealStartMs, mealEndMs }),
        ],
        targetSec
      );
      if (selected.length === 0) throw noCuteMaterialError();
      return selected
        .sort((a, b) => a.startMs - b.startMs)
        .map(toPublicSegment);
    }
    const candidates = mergeCuteCandidates(
      buildCuteCandidates(clips, {
        beforeSec: 2,
        afterSec: 3,
        markerTypes: QUICK_CUT_MARKER_TYPES,
        minSegmentSec: 4,
        minModelConfidence: 0.65,
        minCuteScore: 0.8,
        mealStartMs,
        mealEndMs,
      }),
      { maxGapSec: 1 }
    );
    const selected = rankAndLimit(candidates, {
      maxSegments: candidates.length,
      maxDurationSec: normalizeQuickCutTarget(targetDurationSec),
      minSegmentSec: QUICK_CUT_MIN_SEGMENT_SEC,
      prioritizeDiversity: true,
    });
    return selected
      .sort((a, b) => a.startMs - b.startMs)
      .map(toPublicSegment);
  }
  if (Number(targetDurationSec) === 420) {
    return selectChronologicalFeedingSegments(
      buildFallbackCandidates(clips, { mealStartMs, mealEndMs, minSegmentSec }),
      targetDurationSec
    ).map(toPublicSegment);
  }
  const cuteCandidates = mergeCuteCandidates(
    buildCuteCandidates(clips, {
      beforeSec: highlightRadiusSec,
      afterSec: highlightRadiusSec,
      markerTypes: ["cute_closeup", "cute_front"],
      minSegmentSec,
      mealStartMs,
      mealEndMs,
    }),
    { maxGapSec: mergeGapSec }
  );
  const selected = cuteCandidates.length
    ? rankAndLimit(cuteCandidates, { maxSegments, maxDurationSec, minSegmentSec })
    : selectFallback(
      buildFallbackCandidates(clips, { mealStartMs, mealEndMs, minSegmentSec }),
      { maxSegments: fallbackMaxSegments, maxDurationSec: fallbackMaxDurationSec, minSegmentSec }
    );
  return selected
    .sort((a, b) => a.startMs - b.startMs)
    .map(toPublicSegment);
}

module.exports = {
  formatLocalTime,
  parseLocalTime,
  selectFoodcastSegments,
};
