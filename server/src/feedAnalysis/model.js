const MEAL_WINDOW_SECONDS = 20 * 60;
const MEAL_RETURN_GAP_MS = 10 * 60 * 1000;
const FEEDING_STATES = new Set(["chewing", "licking", "not_eating", "uncertain"]);
const DIARY_ALGORITHM_VERSION = "feeding-diary-v2";
const FEEDING_STATS_ALGORITHM_VERSION = "feeding-stats-v3.2";
const FEEDING_STATS_STATES = new Set([
  "no_cat",
  "cat_away_from_bowl",
  "near_bowl_not_eating",
  "eating",
  "uncertain",
]);
const ACTIVITY_CONFIG_VERSION = "chewmeter-baseline-v1";
const {
  formatDeviceDateKey,
  formatDeviceDateTime,
  parseDeviceDateTime,
} = require("./deviceTime");

function finiteNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  } catch (error) {
    return 0;
  }
}

function boundedScore(value) {
  return Math.max(0, Math.min(1, finiteNumber(value)));
}

function normalizeCuteReasons(value) {
  const candidates = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return [...new Set(candidates.filter((reason) => typeof reason === "string"))];
}

function stringScalar(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function optionalStringScalar(value) {
  return typeof value === "string" ? value : undefined;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function sanitizeAnalysisMarker(marker = {}, options = {}) {
  const beginTime = stringScalar(marker.beginTime);
  const endTimeFallback = options.endTimeFallbackToBegin ? beginTime : "";
  const recordingKey = stringScalar(marker.recordingKey);
  const target = stringScalar(marker.target);
  const sanitized = {
    eventId: optionalStringScalar(marker.eventId),
    recordingKey: recordingKey || stringScalar(options.recordingKey),
    markerType: stringScalar(marker.markerType),
    target: target || stringScalar(options.target),
    markerTsMs: finiteNumber(marker.markerTsMs),
    offsetSec: finiteNumber(marker.offsetSec),
    offsetMs: finiteNumber(marker.offsetMs),
    beginTime,
    endTime: stringScalar(marker.endTime) || endTimeFallback,
    confidence: boundedScore(marker.confidence),
    modelConfidence: boundedScore(marker.modelConfidence),
    cuteScore: boundedScore(marker.cuteScore),
    cuteReasons: normalizeCuteReasons(marker.cuteReasons),
    markerLabel: optionalStringScalar(marker.markerLabel),
  };
  if (Object.prototype.hasOwnProperty.call(marker, "faceRelation")) {
    sanitized.faceRelation = typeof marker.faceRelation === "string" ? marker.faceRelation : "unknown";
  }
  return sanitized;
}

function sanitizeCuteTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  return timeline
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const base = {
      offsetSec: finiteNumber(item.offsetSec),
      cuteScore: boundedScore(item.cuteScore),
      modelConfidence: boundedScore(item.modelConfidence),
      cuteReasons: normalizeCuteReasons(item.cuteReasons),
      hasCat: typeof item.hasCat === "boolean" ? item.hasCat : false,
      };
      if (!Object.prototype.hasOwnProperty.call(item, "faceRelation")) return base;
      return {
        ...base,
        faceRelation: typeof item.faceRelation === "string" ? item.faceRelation : "unknown",
        relationConfidence: boundedScore(item.relationConfidence),
        strictEligible: item.strictEligible === true,
        looseEligible: item.looseEligible === true,
        sizeScore: boundedScore(item.sizeScore),
        cameraScore: boundedScore(item.cameraScore),
        pitchScore: boundedScore(item.pitchScore),
        visibilityScore: boundedScore(item.visibilityScore),
      };
    });
}

function normalizeFeedingState(value) {
  const state = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FEEDING_STATES.has(state) ? state : "uncertain";
}

function sanitizeFeedingStateTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  return timeline
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      state: normalizeFeedingState(item.state),
      startSec: Math.max(0, finiteNumber(item.startSec ?? item.offsetSec)),
      endSec: Math.max(0, finiteNumber(item.endSec ?? item.offsetEndSec)),
      confidence: boundedScore(item.confidence),
    }))
    .filter((item) => item.endSec > item.startSec)
    .sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);
}

function sanitizeFeedingActivity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sampleSeconds = Math.max(0, finiteNumber(value.sampleSeconds));
  const chewsPerMinute = Math.max(0, finiteNumber(value.chewsPerMinute ?? value.bpm));
  const regularity = boundedScore(value.regularity);
  if (sampleSeconds <= 0 || chewsPerMinute <= 0) return null;
  return {
    sampleSeconds,
    chewsPerMinute,
    regularity,
    stroke: Math.max(0, finiteNumber(value.stroke ?? value.strokeRel)),
    algorithmVersion: stringScalar(value.algorithmVersion, "chewmeter-prototype"),
  };
}

function sanitizeFeedingStats(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== FEEDING_STATS_ALGORITHM_VERSION) return null;
  const summary = value.summary && typeof value.summary === "object" && !Array.isArray(value.summary)
    ? value.summary
    : {};
  const sanitizeRange = (item, index, prefix) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const startSec = Math.max(0, finiteNumber(item.startSec));
    const endSec = Math.max(startSec, finiteNumber(item.endSec));
    if (endSec <= startSec) return null;
    return {
      id: stringScalar(item.id, `${prefix}-${index + 1}`),
      startSec,
      endSec,
      spanSeconds: Math.max(0, finiteNumber(item.spanSeconds) || endSec - startSec),
      actualEatingSeconds: Math.max(0, finiteNumber(item.actualEatingSeconds)),
      bowlPresenceSeconds: Math.max(0, finiteNumber(item.bowlPresenceSeconds)),
      confidence: boundedScore(item.confidence),
      eventCount: Math.max(0, Math.round(finiteNumber(item.eventCount))),
      eventIds: Array.isArray(item.eventIds) ? item.eventIds.map((id) => stringScalar(id)).filter(Boolean) : [],
      verifiedSeconds: Array.isArray(item.verifiedSeconds)
        ? item.verifiedSeconds.map((second) => Math.max(0, Math.floor(finiteNumber(second))))
        : [],
    };
  };
  const timeline = (Array.isArray(value.timeline) ? value.timeline : [])
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const state = stringScalar(item.state).trim().toLowerCase();
      const startSec = Math.max(0, finiteNumber(item.startSec));
      const endSec = Math.max(startSec, finiteNumber(item.endSec));
      if (!FEEDING_STATS_STATES.has(state) || endSec <= startSec) return null;
      return {
        state,
        startSec,
        endSec,
        durationSec: Math.max(0, finiteNumber(item.durationSec) || endSec - startSec),
        confidence: boundedScore(item.confidence),
        observedSeconds: Math.max(0, finiteNumber(item.observedSeconds)),
        sampleCount: Math.max(0, Math.round(finiteNumber(item.sampleCount))),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);
  const source = value.source && typeof value.source === "object" && !Array.isArray(value.source)
    ? value.source
    : {};
  return {
    version: FEEDING_STATS_ALGORITHM_VERSION,
    source: {
      mediaId: stringScalar(source.mediaId),
      name: stringScalar(source.name),
      durationSec: Math.max(0, finiteNumber(source.durationSec)),
      orientation: ["none", "clockwise-90"].includes(
        stringScalar(source.orientation).trim().toLowerCase()
      )
        ? stringScalar(source.orientation).trim().toLowerCase()
        : "none",
      range: source.range && typeof source.range === "object" && !Array.isArray(source.range)
        ? {
            startTime: stringScalar(source.range.startTime),
            endTime: stringScalar(source.range.endTime),
          }
        : null,
    },
    summary: {
      mealCount: Math.max(0, Math.round(finiteNumber(summary.mealCount))),
      actualEatingSeconds: Math.max(0, finiteNumber(summary.actualEatingSeconds)),
      bowlPresenceSeconds: Math.max(0, finiteNumber(summary.bowlPresenceSeconds)),
      analyzedSeconds: Math.max(0, finiteNumber(summary.analyzedSeconds)),
      observedSeconds: Math.max(0, finiteNumber(summary.observedSeconds)),
      coverage: boundedScore(summary.coverage),
      confidence: boundedScore(summary.confidence),
    },
    meals: (Array.isArray(value.meals) ? value.meals : [])
      .map((item, index) => sanitizeRange(item, index, "meal"))
      .filter(Boolean),
    events: (Array.isArray(value.events) ? value.events : [])
      .map((item, index) => sanitizeRange(item, index, "feeding-event"))
      .filter(Boolean),
    timeline,
  };
}

function parseTime(value) {
  return parseDeviceDateTime(value);
}

function formatDateKey(date = new Date()) {
  return formatDeviceDateKey(parseTime(date) || new Date());
}

function formatTimeStamp(ms) {
  return formatDeviceDateTime(ms);
}

function recordingKey(record) {
  const beginTime = record.BeginTime || record.beginTime || "";
  const fileName = record.FileName || record.fileName || "";
  return `${beginTime}__${fileName}`;
}

function secondsBetween(begin, end) {
  const beginDate = parseTime(begin);
  const endDate = parseTime(end);
  if (!beginDate || !endDate) return 0;
  return Math.max(0, Math.round((endDate - beginDate) / 1000));
}

function averageConfidence(frames) {
  const values = frames
    .map((frame) => Number(frame.confidence) || 0)
    .filter((value) => value > 0);
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

function pickBowlRoi(frames) {
  const withRoi = frames.filter((frame) => frame && frame.bowlRoi);
  if (withRoi.length === 0) return null;
  const total = withRoi.reduce(
    (acc, frame) => {
      acc.x += frame.bowlRoi.x || 0;
      acc.y += frame.bowlRoi.y || 0;
      acc.width += frame.bowlRoi.width || 0;
      acc.height += frame.bowlRoi.height || 0;
      return acc;
    },
    { x: 0, y: 0, width: 0, height: 0 }
  );
  return {
    x: Math.round(total.x / withRoi.length),
    y: Math.round(total.y / withRoi.length),
    width: Math.round(total.width / withRoi.length),
    height: Math.round(total.height / withRoi.length),
  };
}

function marker(markerType, markerTsMs, recordingKeyValue, extras = {}) {
  return {
    eventId: `${recordingKeyValue}__${markerType}__${markerTsMs}`,
    markerType,
    markerTsMs,
    ...extras,
  };
}

function summarizeVisionFrames({ beginTime, endTime, frames = [] } = {}) {
  const beginDate = parseTime(beginTime);
  const beginMs = beginDate ? beginDate.getTime() : 0;
  const normalized = frames
    .map((frame) => ({
      ...frame,
      second: Number(frame.second) || 0,
      hasCat: !!frame.hasCat,
      nearBowl: !!frame.nearBowl,
      confidence: Number(frame.confidence) || 0,
    }))
    .sort((a, b) => a.second - b.second);
  const key = recordingKey({ BeginTime: beginTime, FileName: "" });
  const markers = [];
  let hasCat = false;
  let hasFeeding = false;
  let catEntered = false;
  let feeding = false;
  let catPositiveStart = null;
  let catNegativeStart = null;
  let bowlPositiveStart = null;
  let bowlNegativeStart = null;

  for (const frame of normalized) {
    if (frame.hasCat) {
      hasCat = true;
      catNegativeStart = null;
      if (catPositiveStart === null) catPositiveStart = frame.second;
      if (!catEntered && frame.second - catPositiveStart >= 1) {
        catEntered = true;
        markers.push(marker("cat_enter", beginMs + catPositiveStart * 1000, key));
      }
    } else {
      catPositiveStart = null;
      if (catEntered) {
        if (catNegativeStart === null) catNegativeStart = frame.second;
        if (frame.second - catNegativeStart >= 4) {
          catEntered = false;
          markers.push(marker("cat_leave", beginMs + catNegativeStart * 1000, key));
        }
      }
    }

    if (frame.nearBowl) {
      bowlNegativeStart = null;
      if (bowlPositiveStart === null) bowlPositiveStart = frame.second;
      if (!feeding && frame.second - bowlPositiveStart >= 7) {
        feeding = true;
        hasFeeding = true;
        markers.push(marker("feeding_start", beginMs + bowlPositiveStart * 1000, key));
      }
    } else {
      bowlPositiveStart = null;
      if (feeding) {
        if (bowlNegativeStart === null) bowlNegativeStart = frame.second;
        if (frame.second - bowlNegativeStart >= 9) {
          feeding = false;
          markers.push(marker("feeding_end", beginMs + bowlNegativeStart * 1000, key));
        }
      }
    }
  }

  if (feeding) {
    const fallbackSecond = normalized.length > 0 ? normalized[normalized.length - 1].second : 0;
    markers.push(marker("feeding_end", beginMs + fallbackSecond * 1000, key));
  }

  return {
    hasCat,
    hasFeeding,
    analysisConfidence: averageConfidence(normalized.filter((frame) => frame.hasCat || frame.nearBowl)),
    bowlRoi: pickBowlRoi(normalized),
    markers: markers
      .sort((a, b) => a.markerTsMs - b.markerTsMs)
      .map((item) => ({
        ...item,
        beginTime: formatTimeStamp(item.markerTsMs),
        endTime: endTime || formatTimeStamp(item.markerTsMs),
      })),
  };
}

function titleForClip(beginTime, hasFeeding) {
  const date = parseTime(beginTime);
  const hour = date ? Number(formatDeviceDateTime(date).slice(11, 13)) : 0;
  if (hasFeeding) return "猫咪进食片段";
  if (hour < 10) return "早间猫咪片段";
  if (hour < 15) return "午间猫咪片段";
  if (hour < 20) return "晚间猫咪片段";
  return "夜间猫咪片段";
}

function formatClock(value) {
  const date = parseTime(value);
  if (!date) return "--:--";
  return formatDeviceDateTime(date).slice(11, 16);
}

function stableClipId(deviceSn, beginTime, fileName) {
  const raw = `${deviceSn || "device"}_${beginTime || "time"}_${fileName || "file"}`;
  return `clip_${raw.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function feedingMarkersFromStats(feedingStats, beginTime, itemKey) {
  const clipStartMs = parseTime(beginTime)?.getTime();
  if (!feedingStats || !Number.isFinite(clipStartMs)) return [];
  return feedingStats.meals.flatMap((meal) => {
    const startMs = clipStartMs + meal.startSec * 1000;
    const endMs = clipStartMs + meal.endSec * 1000;
    const startTime = formatTimeStamp(startMs);
    const endTime = formatTimeStamp(endMs);
    const common = {
      recordingKey: itemKey,
      target: "cat",
      confidence: meal.confidence,
      endTime,
    };
    return [
      marker("feeding_start", startMs, itemKey, {
        ...common,
        offsetSec: meal.startSec,
        offsetMs: meal.startSec * 1000,
        beginTime: startTime,
      }),
      marker("feeding_end", endMs, itemKey, {
        ...common,
        offsetSec: meal.endSec,
        offsetMs: meal.endSec * 1000,
        beginTime: endTime,
      }),
    ];
  });
}

function buildClipFromRecording(record = {}, analysis = {}, deviceSn) {
  analysis = analysis || {};
  const beginTime = record.BeginTime || record.beginTime || "";
  const endTime = record.EndTime || record.endTime || "";
  const fileName = record.FileName || record.fileName || "";
  const durationSec = secondsBetween(beginTime, endTime);
  const itemKey = recordingKey(record);
  const feedingStats = sanitizeFeedingStats(analysis.feedingStats);
  const hasFeeding = feedingStats
    ? feedingStats.summary.mealCount > 0
    : !!analysis.hasFeeding;
  const analysisMarkers = (Array.isArray(analysis.markers) ? analysis.markers : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => !feedingStats || !["feeding_start", "feeding_end"].includes(item.markerType));
  const canonicalMarkers = feedingStats
    ? analysisMarkers.concat(feedingMarkersFromStats(feedingStats, beginTime, itemKey))
    : analysisMarkers;
  const markers = canonicalMarkers
    .map((item) => {
      const marker = sanitizeAnalysisMarker(item);
      return {
        ...marker,
        recordingKey: itemKey,
        playbackParams: {
          startTime: marker.beginTime,
          endTime,
          fileName,
        },
      };
    })
    .sort((left, right) => left.markerTsMs - right.markerTsMs);

  return {
    id: stableClipId(deviceSn, beginTime, fileName),
    recordingKey: itemKey,
    beginTime,
    endTime,
    durationSec,
    fileName,
    title: titleForClip(beginTime, hasFeeding),
    time: formatClock(beginTime),
    cover: record.cover || "/static/images/clip-1.svg",
    isEffective: !!analysis.hasCat,
    hasCat: !!analysis.hasCat,
    hasFeeding,
    analysisConfidence: Number(analysis.analysisConfidence) || 0,
    bowlRoi: analysis.bowlRoi || null,
    markers,
    feedingStateTimeline: sanitizeFeedingStateTimeline(analysis.feedingStateTimeline),
    feedingActivity: sanitizeFeedingActivity(analysis.feedingActivity),
    feedingStats,
    analysisUpdatedAt: Date.now(),
    cuteTimeline: sanitizeCuteTimeline(analysis.cuteTimeline),
    playbackParams: {
      startTime: beginTime,
      endTime,
      fileName,
    },
  };
}

function markerTimestamp(marker) {
  const parsed = parseTime(marker && marker.beginTime);
  if (parsed) return parsed.getTime();
  const value = finiteNumber(marker && marker.markerTsMs);
  return value > 0 ? value : null;
}

function feedingIntervalsForClip(clip) {
  const clipStart = parseTime(clip.beginTime)?.getTime();
  const clipEnd = parseTime(clip.endTime)?.getTime();
  if (!Number.isFinite(clipStart) || !Number.isFinite(clipEnd) || clipEnd <= clipStart) return [];
  const markers = (Array.isArray(clip.markers) ? clip.markers : [])
    .map((item, index) => ({ item, index, timestamp: markerTimestamp(item) }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index);
  const intervals = [];
  let pending = null;
  for (const entry of markers) {
    if (entry.item.markerType === "feeding_start") {
      pending = entry;
      continue;
    }
    if (entry.item.markerType !== "feeding_end" || !pending) continue;
    const startMs = Math.max(clipStart, pending.timestamp);
    const endMs = Math.min(clipEnd, entry.timestamp);
    if (endMs > startMs) intervals.push(buildFeedingInterval(clip, pending.item, startMs, endMs, clipStart));
    pending = null;
  }
  if (pending) {
    const startMs = Math.max(clipStart, pending.timestamp);
    if (clipEnd > startMs) intervals.push(buildFeedingInterval(clip, pending.item, startMs, clipEnd, clipStart));
  }
  return intervals;
}

function buildFeedingInterval(clip, startMarker, startMs, endMs, clipStartMs) {
  const fallbackId = [
    "meal",
    clip.id || clip.recordingKey || clip.beginTime,
    startMarker.beginTime || formatTimeStamp(startMs),
  ]
    .join("_")
    .replace(/[^a-zA-Z0-9_-]+/g, "_");
  const labelled = sanitizeFeedingStateTimeline(clip.feedingStateTimeline)
    .map((item) => ({
      ...item,
      startMs: clipStartMs + item.startSec * 1000,
      endMs: clipStartMs + item.endSec * 1000,
    }))
    .filter((item) => item.endMs > startMs && item.startMs < endMs);
  return {
    id: startMarker.eventId || fallbackId,
    clipId: clip.id,
    startMs,
    endMs,
    states: labelled,
    activity: sanitizeFeedingActivity(clip.feedingActivity),
  };
}

function stateDurationsForInterval(interval) {
  const totals = { chewing: 0, licking: 0, not_eating: 0, uncertain: 0 };
  let cursor = interval.startMs;
  const timeline = [];
  for (const item of interval.states) {
    const startMs = Math.max(interval.startMs, item.startMs, cursor);
    const endMs = Math.min(interval.endMs, item.endMs);
    if (startMs > cursor) {
      totals.uncertain += (startMs - cursor) / 1000;
      timeline.push({ state: "uncertain", startTime: formatTimeStamp(cursor), endTime: formatTimeStamp(startMs) });
    }
    if (endMs <= startMs) continue;
    totals[item.state] += (endMs - startMs) / 1000;
    timeline.push({
      state: item.state,
      startTime: formatTimeStamp(startMs),
      endTime: formatTimeStamp(endMs),
      confidence: item.confidence,
    });
    cursor = endMs;
  }
  if (cursor < interval.endMs) {
    totals.uncertain += (interval.endMs - cursor) / 1000;
    timeline.push({ state: "uncertain", startTime: formatTimeStamp(cursor), endTime: formatTimeStamp(interval.endMs) });
  }
  return { totals, timeline };
}

function groupMealIntervals(intervals) {
  const ordered = intervals.slice().sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const groups = [];
  for (const interval of ordered) {
    const current = groups[groups.length - 1];
    if (!current || interval.startMs - current.endMs >= MEAL_RETURN_GAP_MS) {
      groups.push({ startMs: interval.startMs, endMs: interval.endMs, intervals: [interval] });
      continue;
    }
    current.endMs = Math.max(current.endMs, interval.endMs);
    current.intervals.push(interval);
  }
  return groups;
}

function markersToMeals(clips) {
  const intervals = clips.flatMap(feedingIntervalsForClip);
  return groupMealIntervals(intervals).map((group) => {
    const durations = { chewing: 0, licking: 0, not_eating: 0, uncertain: 0 };
    const timeline = [];
    const activities = [];
    for (const interval of group.intervals) {
      const stateResult = stateDurationsForInterval(interval);
      for (const state of FEEDING_STATES) durations[state] += stateResult.totals[state];
      timeline.push(...stateResult.timeline);
      if (interval.activity) activities.push(interval.activity);
    }
    const bowlPresenceSeconds = group.intervals.reduce((sum, interval) => sum + (interval.endMs - interval.startMs) / 1000, 0);
    const actualEatingSeconds = durations.chewing + durations.licking;
    const startTime = formatTimeStamp(group.startMs);
    const endTime = formatTimeStamp(group.endMs);
    return {
      id: group.intervals[0].id,
      time: formatClock(startTime),
      name: "猫咪进食",
      actionText: "查看",
      startTime,
      endTime,
      spanSeconds: (group.endMs - group.startMs) / 1000,
      bowlPresenceSeconds,
      actualEatingSeconds,
      chewingSeconds: durations.chewing,
      lickingSeconds: durations.licking,
      notEatingSeconds: durations.not_eating,
      uncertainSeconds: durations.uncertain,
      timeline,
      clipIds: [...new Set(group.intervals.map((interval) => interval.clipId).filter(Boolean))],
      minutes: actualEatingSeconds / 60,
      activitySamples: activities,
      notificationSentAt: null,
    };
  });
}

function weightedAverage(samples, field) {
  const valid = samples.filter((item) => Number(item[field]) > 0 && Number(item.sampleSeconds) > 0);
  const weight = valid.reduce((sum, item) => sum + Number(item.sampleSeconds), 0);
  if (weight <= 0) return 0;
  return valid.reduce((sum, item) => sum + Number(item[field]) * Number(item.sampleSeconds), 0) / weight;
}

function dailyActivityMetric(meals) {
  const samples = meals.flatMap((meal) => meal.activitySamples || []);
  if (samples.length === 0) return null;
  return {
    sampleSeconds: samples.reduce((sum, item) => sum + Number(item.sampleSeconds || 0), 0),
    chewsPerMinute: weightedAverage(samples, "chewsPerMinute"),
    regularity: weightedAverage(samples, "regularity"),
  };
}

function median(values) {
  const ordered = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (ordered.length === 0) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function buildActivitySummary(currentMetric, activityHistory = []) {
  const history = activityHistory.filter((item) => item && Number(item.chewsPerMinute) > 0).slice(-14);
  const validDayCount = history.length + (currentMetric ? 1 : 0);
  if (!currentMetric || validDayCount < 7) {
    return {
      state: "baseline_building",
      label: "基线建立中",
      score: null,
      validDayCount,
      requiredValidDays: 7,
      baselineWindowDays: 14,
      algorithmVersion: "chewmeter-prototype",
      configVersion: ACTIVITY_CONFIG_VERSION,
    };
  }
  const baselineRate = median(history.map((item) => Number(item.chewsPerMinute)));
  const rateTerm = Math.max(0, Math.min(1, (currentMetric.chewsPerMinute / baselineRate - 0.6) / 0.4));
  const regularityTerm = Math.max(0, Math.min(1, currentMetric.regularity));
  const score = Math.round((rateTerm * 0.75 + regularityTerm * 0.25) * 100);
  return {
    state: score < 60 ? "below_baseline" : score > 90 ? "above_baseline" : "stable",
    label: score < 60 ? "低于基线" : score > 90 ? "高于基线" : "状态稳定",
    score,
    validDayCount,
    requiredValidDays: 7,
    baselineWindowDays: 14,
    baseline: { chewsPerMinute: baselineRate },
    current: currentMetric,
    weights: { rate: 0.75, regularity: 0.25, stroke: 0 },
    algorithmVersion: "chewmeter-prototype",
    configVersion: ACTIVITY_CONFIG_VERSION,
  };
}

function v32StatePriority(state) {
  if (state === "eating") return 3;
  if (state === "near_bowl_not_eating") return 2;
  if (state === "cat_away_from_bowl" || state === "no_cat") return 1;
  return 0;
}

function aggregateV32Stats(clips) {
  const v32ByKey = new Map();
  for (const clip of clips) {
    if (!sanitizeFeedingStats(clip && clip.feedingStats)) continue;
    const key = stringScalar(clip.recordingKey) || stringScalar(clip.id) ||
      `${stringScalar(clip.beginTime)}:${stringScalar(clip.endTime)}`;
    const previous = v32ByKey.get(key);
    if (!previous || finiteNumber(clip.analysisUpdatedAt) >= finiteNumber(previous.analysisUpdatedAt)) {
      v32ByKey.set(key, clip);
    }
  }
  const v32Clips = [...v32ByKey.values()];
  if (v32Clips.length === 0) return null;
  const stateByAbsoluteSecond = new Map();
  const intervals = [];
  const intervalKeys = new Set();
  let analyzedSeconds = 0;
  let observedSeconds = 0;
  let confidenceWeighted = 0;

  for (const clip of v32Clips) {
    const stats = sanitizeFeedingStats(clip.feedingStats);
    const clipStartMs = parseTime(clip.beginTime)?.getTime();
    if (!Number.isFinite(clipStartMs)) continue;
    analyzedSeconds += stats.summary.analyzedSeconds;
    observedSeconds += stats.summary.observedSeconds;
    confidenceWeighted += stats.summary.confidence * stats.summary.actualEatingSeconds;
    for (const item of stats.timeline) {
      for (let second = Math.floor(item.startSec); second < Math.ceil(item.endSec); second += 1) {
        const absoluteSecond = Math.floor((clipStartMs + second * 1000) / 1000);
        const previous = stateByAbsoluteSecond.get(absoluteSecond);
        if (!previous || v32StatePriority(item.state) > v32StatePriority(previous.state)) {
          stateByAbsoluteSecond.set(absoluteSecond, { state: item.state, confidence: item.confidence });
        }
      }
    }
    for (const event of stats.events) {
      const startMs = clipStartMs + event.startSec * 1000;
      const endMs = clipStartMs + event.endSec * 1000;
      const key = `${Math.round(startMs)}:${Math.round(endMs)}`;
      if (endMs <= startMs || intervalKeys.has(key)) continue;
      intervalKeys.add(key);
      intervals.push({
        id: `${clip.id || clip.recordingKey || "clip"}_${event.id}`,
        clipId: clip.id,
        startMs,
        endMs,
        actualEatingSeconds: event.actualEatingSeconds,
        bowlPresenceSeconds: event.bowlPresenceSeconds,
        confidence: event.confidence,
      });
    }
  }

  const countStateInRange = (startMs, endMs, wanted) => {
    let count = 0;
    const states = new Set(wanted);
    const startSecond = Math.floor(startMs / 1000);
    const endSecond = Math.ceil(endMs / 1000);
    for (let second = startSecond; second < endSecond; second += 1) {
      if (states.has(stateByAbsoluteSecond.get(second)?.state)) count += 1;
    }
    return count;
  };
  const meals = groupMealIntervals(intervals).map((group) => {
    const actualFromTimeline = countStateInRange(group.startMs, group.endMs, ["eating"]);
    const bowlFromTimeline = countStateInRange(
      group.startMs,
      group.endMs,
      ["eating", "near_bowl_not_eating"]
    );
    const actualEatingSeconds = actualFromTimeline || group.intervals.reduce(
      (sum, interval) => sum + interval.actualEatingSeconds,
      0
    );
    const bowlPresenceSeconds = bowlFromTimeline || group.intervals.reduce(
      (sum, interval) => sum + interval.bowlPresenceSeconds,
      0
    );
    const startTime = formatTimeStamp(group.startMs);
    const endTime = formatTimeStamp(group.endMs);
    return {
      id: group.intervals[0].id,
      time: formatClock(startTime),
      name: "猫咪进食",
      actionText: "查看",
      startTime,
      endTime,
      spanSeconds: (group.endMs - group.startMs) / 1000,
      bowlPresenceSeconds,
      actualEatingSeconds,
      chewingSeconds: 0,
      lickingSeconds: 0,
      notEatingSeconds: Math.max(0, bowlPresenceSeconds - actualEatingSeconds),
      uncertainSeconds: 0,
      timeline: [],
      clipIds: [...new Set(group.intervals.map((interval) => interval.clipId).filter(Boolean))],
      minutes: actualEatingSeconds / 60,
      confidence: group.intervals.reduce((sum, interval) => sum + interval.confidence, 0) /
        Math.max(1, group.intervals.length),
      notificationSentAt: null,
    };
  });
  const actualEatingSeconds = [...stateByAbsoluteSecond.values()]
    .filter((item) => item.state === "eating").length;
  const bowlPresenceSeconds = [...stateByAbsoluteSecond.values()]
    .filter((item) => item.state === "eating" || item.state === "near_bowl_not_eating").length;
  return {
    clips: v32Clips,
    meals,
    actualEatingSeconds,
    bowlPresenceSeconds,
    analyzedSeconds,
    observedSeconds,
    coverage: analyzedSeconds ? Math.min(1, observedSeconds / analyzedSeconds) : 0,
    confidence: actualEatingSeconds ? confidenceWeighted / actualEatingSeconds : 0,
  };
}

function buildDiaryFromClips({ deviceSn = "", date = formatDateKey(), clips = [], activityHistory = [] } = {}) {
  const orderedClips = clips
    .filter((clip) => clip && typeof clip === "object")
    .sort((a, b) => (parseTime(a.beginTime)?.getTime() || 0) - (parseTime(b.beginTime)?.getTime() || 0));
  const effectiveClips = orderedClips
    .filter((clip) => clip && clip.hasCat)
  const v32 = aggregateV32Stats(orderedClips);
  const meals = v32 ? v32.meals : markersToMeals(effectiveClips);
  const currentActivity = dailyActivityMetric(meals);
  const activity = buildActivitySummary(currentActivity, activityHistory);
  const featured = effectiveClips.reduce((best, clip) => {
    if (!best) return clip;
    if (clip.hasFeeding && !best.hasFeeding) return clip;
    if (clip.durationSec > best.durationSec) return clip;
    return best;
  }, null);

  const actualEatingSeconds = v32
    ? v32.actualEatingSeconds
    : meals.reduce((sum, meal) => sum + meal.actualEatingSeconds, 0);
  const bowlPresenceSeconds = v32
    ? v32.bowlPresenceSeconds
    : meals.reduce((sum, meal) => sum + meal.bowlPresenceSeconds, 0);
  const analysisUpdatedAt = orderedClips.reduce(
    (latest, clip) => Math.max(latest, Math.max(0, finiteNumber(clip.analysisUpdatedAt))),
    0
  );
  const latestMeal = meals.length > 0 ? meals[meals.length - 1] : null;
  return {
    deviceSn,
    date,
    eatCount: meals.length,
    mealCount: meals.length,
    actualEatingSeconds,
    bowlPresenceSeconds,
    chewingSeconds: meals.reduce((sum, meal) => sum + meal.chewingSeconds, 0),
    lickingSeconds: meals.reduce((sum, meal) => sum + meal.lickingSeconds, 0),
    notEatingSeconds: meals.reduce((sum, meal) => sum + meal.notEatingSeconds, 0),
    uncertainSeconds: meals.reduce((sum, meal) => sum + meal.uncertainSeconds, 0),
    eatMinutes: actualEatingSeconds / 60,
    clipCount: effectiveClips.length,
    analyzedClipCount: v32 ? v32.clips.length : 0,
    clips: effectiveClips,
    meals: meals.map(({ activitySamples, ...meal }) => meal),
    latestMeal,
    activity,
    activityMetric: currentActivity,
    algorithmVersion: v32 ? FEEDING_STATS_ALGORITHM_VERSION : DIARY_ALGORITHM_VERSION,
    analysisState: !v32 ? "pending" : v32.coverage < 0.5 ? "partial" : "ready",
    analysisUpdatedAt,
    analyzedSeconds: v32 ? v32.analyzedSeconds : 0,
    observedSeconds: v32 ? v32.observedSeconds : 0,
    coverage: v32 ? v32.coverage : 0,
    confidence: v32 ? v32.confidence : 0,
    configVersion: ACTIVITY_CONFIG_VERSION,
    featuredClipId: featured ? featured.id : "",
    updatedAt: analysisUpdatedAt,
  };
}

function buildReplayMarkersFromClips(clips = []) {
  return (Array.isArray(clips) ? clips : []).flatMap((clip) => {
    if (!clip || typeof clip !== "object") return [];
    const markers = (Array.isArray(clip.markers) ? clip.markers : [])
      .filter((marker) => marker && typeof marker === "object" && !Array.isArray(marker));
    if (clip.hasCat !== true) return markers;

    const feedingStats = sanitizeFeedingStats(clip.feedingStats);
    const statsStart = parseTime(feedingStats?.source?.range?.startTime || clip.beginTime);
    const catTimeline = (feedingStats?.timeline || [])
      .filter((item) => item.state !== "no_cat" && item.endSec > item.startSec)
      .sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);
    if (statsStart && catTimeline.length > 0) {
      const ranges = [];
      for (const item of catTimeline) {
        const current = ranges[ranges.length - 1];
        if (current && item.startSec <= current.endSec + 2) {
          current.endSec = Math.max(current.endSec, item.endSec);
          current.confidence = Math.max(current.confidence, boundedScore(item.confidence));
        } else {
          ranges.push({
            startSec: item.startSec,
            endSec: item.endSec,
            confidence: boundedScore(item.confidence),
          });
        }
      }
      const recordingKey = stringScalar(clip.recordingKey || clip.id);
      const nonCatMarkers = markers.filter(
        (marker) => !/^(cat|face)_/.test(String(marker.markerType || ""))
      );
      return nonCatMarkers.concat(ranges.map((range, index) => {
        const startMs = statsStart.getTime() + range.startSec * 1000;
        const endMs = statsStart.getTime() + range.endSec * 1000;
        return {
          eventId: `${recordingKey || statsStart.getTime()}__cat_presence_${index + 1}`,
          recordingKey,
          markerType: "cat_enter",
          target: "cat",
          markerTsMs: startMs,
          offsetSec: range.startSec,
          offsetMs: range.startSec * 1000,
          beginTime: formatTimeStamp(startMs),
          endTime: formatTimeStamp(endMs),
          confidence: range.confidence || boundedScore(clip.analysisConfidence || clip.confidence),
          markerLabel: "有猫出现",
        };
      }));
    }

    const hasCatRange = markers.some((marker) => {
      if (!/^(cat|face)_(enter|start)$/.test(String(marker.markerType || ""))) return false;
      const start = parseTime(marker.beginTime) || (finiteNumber(marker.markerTsMs) > 0 ? new Date(finiteNumber(marker.markerTsMs)) : null);
      const end = parseTime(marker.endTime);
      return Boolean(start && end && end.getTime() > start.getTime());
    });
    if (hasCatRange) return markers;

    const begin = parseTime(clip.beginTime);
    const end = parseTime(clip.endTime);
    if (!begin || !end || end.getTime() <= begin.getTime()) return markers;
    const recordingKey = stringScalar(clip.recordingKey || clip.id);
    return markers.concat({
      eventId: `${recordingKey || begin.getTime()}__cat_presence`,
      recordingKey,
      markerType: "cat_enter",
      target: "cat",
      markerTsMs: begin.getTime(),
      offsetSec: 0,
      offsetMs: 0,
      beginTime: stringScalar(clip.beginTime),
      endTime: stringScalar(clip.endTime),
      confidence: boundedScore(clip.analysisConfidence || clip.confidence),
      markerLabel: "有猫出现",
    });
  });
}

module.exports = {
  buildClipFromRecording,
  buildDiaryFromClips,
  buildReplayMarkersFromClips,
  formatDateKey,
  parseTime,
  recordingKey,
  sanitizeAnalysisMarker,
  sanitizeFeedingActivity,
  sanitizeFeedingStats,
  sanitizeFeedingStateTimeline,
  summarizeVisionFrames,
};
