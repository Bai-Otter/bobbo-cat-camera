const ALGORITHM_VERSION = "feeding-stats-v3.2";
const STATES = Object.freeze([
  "no_cat",
  "cat_away_from_bowl",
  "near_bowl_not_eating",
  "eating",
  "uncertain",
]);
const MIN_VERIFIED_EATING_SECONDS = 3;
const MIN_FEEDING_EVENT_SPAN_SECONDS = 7;
const MAX_SUPPORTED_ANCHOR_GAP_SECONDS = 30;
const SAME_MEAL_GAP_SECONDS = 10 * 60;
const MAX_FACE_OBSERVATION_GAP_SECONDS = 2;
const MAX_TRANSIENT_EATING_INTERRUPTION_SECONDS = 1;
const MAX_FEEDING_VISIT_GAP_SECONDS = 24;
const MAX_CLOSEUP_NO_CAT_RUN_SECONDS = 12;
const MIN_FEEDING_VISIT_SUPPORT_RATIO = 0.4;
const FEEDING_VISIT_ANCHOR_WINDOW_SECONDS = 30;
const MIN_FEEDING_VISIT_ANCHOR_SECONDS = 3;
const TRANSIENT_EATING_INTERRUPTION_STATES = new Set([
  "no_cat",
  "cat_away_from_bowl",
  "near_bowl_not_eating",
]);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function boundedScore(value) {
  return clamp(finiteNumber(value), 0, 1);
}

function round4(value) {
  return Math.round(finiteNumber(value) * 10000) / 10000;
}

function normalizeDuration(source, analyzedDurationSec, frames) {
  const explicit = finiteNumber(analyzedDurationSec, -1);
  if (explicit >= 0) return Math.max(0, Math.ceil(explicit));
  const sourceDuration = finiteNumber(source && source.durationSec, -1);
  if (sourceDuration >= 0) return Math.max(0, Math.ceil(sourceDuration));
  const maximumOffset = (Array.isArray(frames) ? frames : []).reduce((maximum, frame) => {
    if (!frame || typeof frame !== "object") return maximum;
    const offset = finiteNumber(frame.offsetSec, finiteNumber(frame.second, -1));
    return Math.max(maximum, offset);
  }, -1);
  return maximumOffset < 0 ? 0 : Math.floor(maximumOffset) + 1;
}

function faceAtBowl(frame) {
  const evidence = frame && frame.behaviorEvidence;
  return !!(evidence && typeof evidence === "object" && evidence.faceAtBowl === true);
}

function stateForFrames(frames) {
  if (frames.some(faceAtBowl)) return "eating";
  if (frames.some((frame) => frame.nearBowl === true)) return "near_bowl_not_eating";
  if (frames.some((frame) => {
    const evidence = frame && frame.behaviorEvidence;
    return frame?.hasCat === true || frame?.hasTarget === true ||
      !!(evidence && typeof evidence === "object" && evidence.faceObserved === true);
  })) {
    return "cat_away_from_bowl";
  }
  return "no_cat";
}

function confidenceForFrames(frames, state) {
  const relevantFrames = state === "eating" ? frames.filter(faceAtBowl) : frames;
  const values = relevantFrames.map((frame) => {
    if (state === "eating") {
      const evidence = frame.behaviorEvidence;
      if (evidence && typeof evidence === "object") {
        return Math.max(
          boundedScore(evidence.confidence),
          boundedScore(frame.confidence)
        );
      }
    }
    return boundedScore(frame.confidence);
  });
  return round4(Math.max(0, ...values));
}

function bridgeShortFaceObservationGaps(perSecond) {
  const bridged = perSecond.map((item) => ({ ...item }));
  let index = 0;
  while (index < bridged.length) {
    if (bridged[index].state !== "near_bowl_not_eating") {
      index += 1;
      continue;
    }
    const start = index;
    while (index < bridged.length && bridged[index].state === "near_bowl_not_eating") {
      index += 1;
    }
    const end = index;
    const gapSeconds = end - start;
    const boundedByEating = start > 0 && end < bridged.length &&
      bridged[start - 1].state === "eating" && bridged[end].state === "eating";
    if (boundedByEating && gapSeconds <= MAX_FACE_OBSERVATION_GAP_SECONDS) {
      for (let second = start; second < end; second += 1) {
        bridged[second].state = "eating";
        bridged[second].faceObservationBridged = true;
      }
    }
  }
  return bridged;
}

function bridgeShortEatingInterruptions(perSecond) {
  const bridged = perSecond.map((item) => ({ ...item }));
  let index = 0;
  while (index < bridged.length) {
    const item = bridged[index];
    if (!item.observed || !TRANSIENT_EATING_INTERRUPTION_STATES.has(item.state)) {
      index += 1;
      continue;
    }
    const start = index;
    while (
      index < bridged.length &&
      bridged[index].observed &&
      TRANSIENT_EATING_INTERRUPTION_STATES.has(bridged[index].state)
    ) {
      index += 1;
    }
    const end = index;
    const gapSeconds = end - start;
    const boundedByEating = start > 0 && end < bridged.length &&
      bridged[start - 1].state === "eating" && bridged[end].state === "eating";
    if (!boundedByEating || gapSeconds > MAX_TRANSIENT_EATING_INTERRUPTION_SECONDS) {
      continue;
    }
    const inferredConfidence = round4(Math.min(
      bridged[start - 1].confidence,
      bridged[end].confidence
    ));
    for (let second = start; second < end; second += 1) {
      bridged[second].smoothedFromState = bridged[second].state;
      bridged[second].state = "eating";
      bridged[second].confidence = inferredConfidence;
      bridged[second].feedingSupport = true;
      bridged[second].eatingInterruptionBridged = true;
    }
  }
  return bridged;
}

function longestStateRun(items, state) {
  let longest = 0;
  let current = 0;
  for (const item of items) {
    if (item.state === state) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function countVerifiedEatingAnchors(items, start, end) {
  let count = 0;
  for (let index = Math.max(0, start); index < Math.min(items.length, end); index += 1) {
    if (items[index].verifiedEatingAnchor) count += 1;
  }
  return count;
}

function bridgeSupportedFeedingVisitGaps(perSecond) {
  const bridged = perSecond.map((item) => ({ ...item }));
  let index = 0;
  while (index < bridged.length) {
    if (bridged[index].state === "eating") {
      index += 1;
      continue;
    }
    const start = index;
    while (index < bridged.length && bridged[index].state !== "eating") {
      index += 1;
    }
    const end = index;
    const gap = bridged.slice(start, end);
    const gapSeconds = gap.length;
    const boundedByEating = start > 0 && end < bridged.length &&
      bridged[start - 1].state === "eating" && bridged[end].state === "eating";
    if (!boundedByEating || gapSeconds > MAX_FEEDING_VISIT_GAP_SECONDS) continue;
    if (!gap.every((item) => item.observed)) continue;

    const visitSupportSeconds = gap.filter((item) => item.bowlVisitSupport).length;
    const visitSupportRatio = gapSeconds ? visitSupportSeconds / gapSeconds : 0;
    const noCatRunSeconds = longestStateRun(gap, "no_cat");
    const leftAnchorSeconds = countVerifiedEatingAnchors(
      perSecond,
      start - FEEDING_VISIT_ANCHOR_WINDOW_SECONDS,
      start
    );
    const rightAnchorSeconds = countVerifiedEatingAnchors(
      perSecond,
      end,
      end + FEEDING_VISIT_ANCHOR_WINDOW_SECONDS
    );
    if (
      visitSupportRatio < MIN_FEEDING_VISIT_SUPPORT_RATIO ||
      noCatRunSeconds > MAX_CLOSEUP_NO_CAT_RUN_SECONDS ||
      leftAnchorSeconds < MIN_FEEDING_VISIT_ANCHOR_SECONDS ||
      rightAnchorSeconds < MIN_FEEDING_VISIT_ANCHOR_SECONDS
    ) {
      continue;
    }

    const inferredConfidence = round4(Math.min(
      bridged[start - 1].confidence,
      bridged[end].confidence
    ) * 0.75);
    for (let second = start; second < end; second += 1) {
      bridged[second].smoothedFromState = bridged[second].state;
      bridged[second].state = "eating";
      bridged[second].confidence = inferredConfidence;
      bridged[second].feedingSupport = true;
      bridged[second].eatingInterruptionBridged = true;
      bridged[second].feedingVisitBridged = true;
      bridged[second].visitSupportRatio = round4(visitSupportRatio);
      bridged[second].closeupNoCatRunSeconds = noCatRunSeconds;
      bridged[second].leftAnchorSeconds = leftAnchorSeconds;
      bridged[second].rightAnchorSeconds = rightAnchorSeconds;
    }
  }
  return bridged;
}

function buildPerSecondTimeline(frames, durationSec) {
  const grouped = new Map();
  for (const frame of Array.isArray(frames) ? frames : []) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) continue;
    const offset = finiteNumber(frame.offsetSec, finiteNumber(frame.second, -1));
    const second = Math.floor(offset);
    if (second < 0 || second >= durationSec) continue;
    if (!grouped.has(second)) grouped.set(second, []);
    grouped.get(second).push(frame);
  }

  return Array.from({ length: durationSec }, (_, second) => {
    const samples = grouped.get(second) || [];
    if (samples.length === 0) {
      return {
        second,
        state: "uncertain",
        confidence: 0,
        observed: false,
        feedingSupport: false,
        bowlVisitSupport: false,
        verifiedEatingAnchor: false,
        sampleCount: 0,
      };
    }
    const state = stateForFrames(samples);
    return {
      second,
      state,
      confidence: confidenceForFrames(samples, state),
      observed: true,
      feedingSupport: samples.some((frame) => {
        const evidence = frame.behaviorEvidence;
        return frame.eatingVerified === true ||
          frame.nearBowl === true ||
          !!(evidence && typeof evidence === "object" && evidence.faceAtBowl === true);
      }),
      bowlVisitSupport: samples.some((frame) => frame.nearBowl === true),
      verifiedEatingAnchor: state === "eating",
      sampleCount: samples.length,
    };
  });
}

function compressTimeline(perSecond) {
  const timeline = [];
  for (const item of perSecond) {
    const previous = timeline[timeline.length - 1];
    if (previous && previous.state === item.state && previous.endSec === item.second) {
      previous.endSec = item.second + 1;
      previous.durationSec += 1;
      previous.observedSeconds += item.observed ? 1 : 0;
      previous.sampleCount += item.sampleCount;
      previous.confidence = round4(
        (previous.confidenceTotal + item.confidence) / previous.durationSec
      );
      previous.confidenceTotal += item.confidence;
      continue;
    }
    timeline.push({
      state: item.state,
      startSec: item.second,
      endSec: item.second + 1,
      durationSec: 1,
      confidence: item.confidence,
      confidenceTotal: item.confidence,
      observedSeconds: item.observed ? 1 : 0,
      sampleCount: item.sampleCount,
    });
  }
  return timeline.map(({ confidenceTotal, ...item }) => item);
}

function allSupported(perSecond, startSec, endSec) {
  for (let second = startSec; second < endSec; second += 1) {
    if (!perSecond[second] || !perSecond[second].feedingSupport) return false;
  }
  return true;
}

function countState(perSecond, startSec, endSec, states) {
  const wanted = new Set(states);
  let count = 0;
  for (let second = startSec; second < endSec; second += 1) {
    if (perSecond[second] && wanted.has(perSecond[second].state)) count += 1;
  }
  return count;
}

function buildFeedingEvents(perSecond) {
  const anchors = perSecond
    .filter((item) => item.state === "eating")
    .map((item) => item.second);
  if (anchors.length === 0) return { events: [], rejected: [] };

  const groups = [];
  let group = [anchors[0]];
  for (const anchor of anchors.slice(1)) {
    const previous = group[group.length - 1];
    const gap = anchor - previous;
    if (
      gap <= MAX_SUPPORTED_ANCHOR_GAP_SECONDS &&
      allSupported(perSecond, previous + 1, anchor)
    ) {
      group.push(anchor);
    } else {
      groups.push(group);
      group = [anchor];
    }
  }
  groups.push(group);

  const accepted = [];
  const rejected = [];
  groups.forEach((verifiedSeconds, index) => {
    const startSec = verifiedSeconds[0];
    const lastVerifiedSec = verifiedSeconds[verifiedSeconds.length - 1];
    const tailLimit = Math.min(
      perSecond.length,
      lastVerifiedSec + MAX_SUPPORTED_ANCHOR_GAP_SECONDS + 1
    );
    let endSec = lastVerifiedSec + 1;
    while (endSec < tailLimit && perSecond[endSec] && perSecond[endSec].feedingSupport) {
      endSec += 1;
    }
    const spanSeconds = Math.max(0, endSec - startSec);
    const actualEatingSeconds = verifiedSeconds.length;
    const bowlPresenceSeconds = countState(
      perSecond,
      startSec,
      endSec,
      ["eating", "near_bowl_not_eating"]
    );
    const confidences = verifiedSeconds.map((second) => perSecond[second].confidence);
    const event = {
      id: `feeding-event-${index + 1}`,
      startSec,
      endSec,
      spanSeconds,
      actualEatingSeconds,
      bowlPresenceSeconds,
      verifiedSeconds: [...verifiedSeconds],
      confidence: round4(
        confidences.length
          ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
          : 0
      ),
    };
    if (actualEatingSeconds < MIN_VERIFIED_EATING_SECONDS) {
      rejected.push({ ...event, reason: "INSUFFICIENT_VERIFIED_SECONDS" });
    } else if (spanSeconds < MIN_FEEDING_EVENT_SPAN_SECONDS) {
      rejected.push({ ...event, reason: "FEEDING_SPAN_TOO_SHORT" });
    } else {
      accepted.push(event);
    }
  });
  return { events: accepted, rejected };
}

function groupEventsIntoMeals(events, perSecond) {
  const meals = [];
  for (const event of events) {
    const previous = meals[meals.length - 1];
    if (previous && event.startSec - previous.endSec < SAME_MEAL_GAP_SECONDS) {
      previous.endSec = Math.max(previous.endSec, event.endSec);
      previous.spanSeconds = previous.endSec - previous.startSec;
      previous.actualEatingSeconds += event.actualEatingSeconds;
      previous.eventCount += 1;
      previous.eventIds.push(event.id);
      previous.confidenceValues.push(event.confidence);
      previous.confidence = round4(
        previous.confidenceValues.reduce((sum, value) => sum + value, 0) /
          previous.confidenceValues.length
      );
      previous.bowlPresenceSeconds = countState(
        perSecond,
        previous.startSec,
        previous.endSec,
        ["eating", "near_bowl_not_eating"]
      );
      continue;
    }
    meals.push({
      id: `meal-${meals.length + 1}`,
      startSec: event.startSec,
      endSec: event.endSec,
      spanSeconds: event.spanSeconds,
      actualEatingSeconds: event.actualEatingSeconds,
      bowlPresenceSeconds: event.bowlPresenceSeconds,
      eventCount: 1,
      eventIds: [event.id],
      confidence: event.confidence,
      confidenceValues: [event.confidence],
    });
  }
  return meals.map(({ confidenceValues, ...meal }) => meal);
}

function rejectionReasons(frames) {
  const reasons = {};
  for (const frame of Array.isArray(frames) ? frames : []) {
    if (!frame || typeof frame !== "object" || frame.eatingVerified === true) continue;
    const evidence = frame.behaviorEvidence;
    if (!evidence || typeof evidence !== "object") continue;
    const reason = typeof evidence.reason === "string" ? evidence.reason : "";
    if (!reason) continue;
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return reasons;
}

function buildFeedingStats({
  source = {},
  frames = [],
  analyzedDurationSec,
  algorithmVersion = ALGORITHM_VERSION,
} = {}) {
  const durationSec = normalizeDuration(source, analyzedDurationSec, frames);
  const perSecond = bridgeSupportedFeedingVisitGaps(
    bridgeShortEatingInterruptions(
      bridgeShortFaceObservationGaps(
        buildPerSecondTimeline(frames, durationSec)
      )
    )
  );
  const timeline = compressTimeline(perSecond);
  const { events, rejected } = buildFeedingEvents(perSecond);
  const meals = groupEventsIntoMeals(events, perSecond);
  const observedSeconds = perSecond.filter((item) => item.observed).length;
  const actualEatingSeconds = countState(perSecond, 0, durationSec, ["eating"]);
  const bowlPresenceSeconds = countState(
    perSecond,
    0,
    durationSec,
    ["eating", "near_bowl_not_eating"]
  );
  const eatingConfidence = perSecond
    .filter((item) => item.state === "eating")
    .map((item) => item.confidence);
  const stateSeconds = Object.fromEntries(STATES.map((state) => [state, 0]));
  for (const item of perSecond) stateSeconds[item.state] += 1;
  const smoothedItems = perSecond.filter((item) => item.eatingInterruptionBridged);
  const visitSmoothedItems = smoothedItems.filter((item) => item.feedingVisitBridged);
  const transientSmoothedItems = smoothedItems.filter((item) => !item.feedingVisitBridged);
  const smoothedOriginalStates = Object.fromEntries(
    [...TRANSIENT_EATING_INTERRUPTION_STATES].map((state) => [state, 0])
  );
  for (const item of smoothedItems) {
    smoothedOriginalStates[item.smoothedFromState] += 1;
  }

  return {
    version: algorithmVersion,
    source: {
      mediaId: String(source.mediaId || ""),
      name: String(source.name || ""),
      path: String(source.path || ""),
      sha256: String(source.sha256 || ""),
      durationSec,
      orientation: String(source.orientation || "none"),
      range: source.range || null,
    },
    summary: {
      mealCount: meals.length,
      actualEatingSeconds,
      bowlPresenceSeconds,
      analyzedSeconds: durationSec,
      observedSeconds,
      coverage: durationSec ? round4(observedSeconds / durationSec) : 0,
      confidence: eatingConfidence.length
        ? round4(eatingConfidence.reduce((sum, value) => sum + value, 0) / eatingConfidence.length)
        : 0,
    },
    meals,
    events,
    timeline,
    diagnostics: {
      classificationMode: "face-at-bowl-contact-with-visit-hysteresis",
      stateSeconds,
      uncertainSeconds: stateSeconds.uncertain,
      sampleCount: Array.isArray(frames) ? frames.length : 0,
      behaviorRejectionReasons: rejectionReasons(frames),
      rejectedFeedingCandidates: rejected,
      temporalSmoothing: {
        bridgedSeconds: smoothedItems.map((item) => item.second),
        transientBridgedSeconds: transientSmoothedItems.map((item) => item.second),
        visitBridgedSeconds: visitSmoothedItems.map((item) => item.second),
        originalStates: smoothedOriginalStates,
      },
      thresholds: {
        minVerifiedEatingSeconds: MIN_VERIFIED_EATING_SECONDS,
        minFeedingEventSpanSeconds: MIN_FEEDING_EVENT_SPAN_SECONDS,
        maxSupportedAnchorGapSeconds: MAX_SUPPORTED_ANCHOR_GAP_SECONDS,
        maxFaceObservationGapSeconds: MAX_FACE_OBSERVATION_GAP_SECONDS,
        maxTransientEatingInterruptionSeconds: MAX_TRANSIENT_EATING_INTERRUPTION_SECONDS,
        maxFeedingVisitGapSeconds: MAX_FEEDING_VISIT_GAP_SECONDS,
        maxCloseupNoCatRunSeconds: MAX_CLOSEUP_NO_CAT_RUN_SECONDS,
        minFeedingVisitSupportRatio: MIN_FEEDING_VISIT_SUPPORT_RATIO,
        feedingVisitAnchorWindowSeconds: FEEDING_VISIT_ANCHOR_WINDOW_SECONDS,
        minFeedingVisitAnchorSeconds: MIN_FEEDING_VISIT_ANCHOR_SECONDS,
        sameMealGapSeconds: SAME_MEAL_GAP_SECONDS,
      },
    },
  };
}

function normalizeRanges(ranges, durationSec, options = {}) {
  const normalized = (Array.isArray(ranges) ? ranges : [])
    .map((range, index) => {
      if (!range || typeof range !== "object" || Array.isArray(range)) return null;
      const startSec = clamp(finiteNumber(range.startSec), 0, durationSec);
      const endSec = clamp(finiteNumber(range.endSec), 0, durationSec);
      if (endSec <= startSec) return null;
      return {
        ...(options.keepId ? { id: String(range.id || `${options.idPrefix || "range"}-${index + 1}`) } : {}),
        startSec: round4(startSec),
        endSec: round4(endSec),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);

  const merged = [];
  for (const range of normalized) {
    const previous = merged[merged.length - 1];
    if (previous && range.startSec <= previous.endSec) {
      previous.endSec = Math.max(previous.endSec, range.endSec);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function normalizeAnnotations(annotations = {}, durationSec = 0) {
  const duration = Math.max(0, finiteNumber(durationSec));
  return {
    version: "feeding-annotations-v1",
    mediaId: String(annotations.mediaId || ""),
    reviewedRanges: normalizeRanges(annotations.reviewedRanges, duration),
    eatingIntervals: normalizeRanges(annotations.eatingIntervals, duration, {
      keepId: true,
      idPrefix: "eating",
    }),
    updatedAt: String(annotations.updatedAt || ""),
  };
}

function intervalOverlapsSecond(interval, second) {
  return interval.startSec < second + 1 && interval.endSec > second;
}

function secondIsCovered(ranges, second) {
  return ranges.some((range) => intervalOverlapsSecond(range, second));
}

function buildAnnotationSummary(annotations = {}, durationSec = 0) {
  const duration = Math.max(0, Math.ceil(finiteNumber(durationSec)));
  const normalized = normalizeAnnotations(annotations, duration);
  const reviewedSeconds = [];
  const eatingSeconds = [];
  for (let second = 0; second < duration; second += 1) {
    const reviewed = secondIsCovered(normalized.reviewedRanges, second);
    if (!reviewed) continue;
    reviewedSeconds.push(second);
    if (secondIsCovered(normalized.eatingIntervals, second)) eatingSeconds.push(second);
  }

  const manualEvents = normalized.eatingIntervals
    .map((interval, index) => ({
      id: interval.id || `manual-event-${index + 1}`,
      startSec: interval.startSec,
      endSec: interval.endSec,
      spanSeconds: round4(interval.endSec - interval.startSec),
    }));
  const meals = [];
  for (const event of manualEvents) {
    const previous = meals[meals.length - 1];
    if (previous && event.startSec - previous.endSec < SAME_MEAL_GAP_SECONDS) {
      previous.endSec = Math.max(previous.endSec, event.endSec);
      previous.spanSeconds = round4(previous.endSec - previous.startSec);
      previous.eventCount += 1;
    } else {
      meals.push({
        id: `manual-meal-${meals.length + 1}`,
        startSec: event.startSec,
        endSec: event.endSec,
        spanSeconds: event.spanSeconds,
        eventCount: 1,
      });
    }
  }

  return {
    mealCount: meals.length,
    actualEatingSeconds: eatingSeconds.length,
    reviewedSeconds: reviewedSeconds.length,
    reviewedCoverage: duration ? round4(reviewedSeconds.length / duration) : 0,
    meals,
  };
}

function timelineStateAt(timeline, second) {
  const item = (Array.isArray(timeline) ? timeline : []).find(
    (entry) => entry && entry.startSec <= second && entry.endSec > second
  );
  return item ? item.state : "uncertain";
}

function evaluateAnnotations(result = {}, annotations = {}) {
  const duration = Math.max(
    0,
    Math.ceil(finiteNumber(result.summary && result.summary.analyzedSeconds))
  );
  const normalized = normalizeAnnotations(annotations, duration);
  let reviewedSeconds = 0;
  let truePositiveSeconds = 0;
  let falsePositiveSeconds = 0;
  let falseNegativeSeconds = 0;
  for (let second = 0; second < duration; second += 1) {
    if (!secondIsCovered(normalized.reviewedRanges, second)) continue;
    reviewedSeconds += 1;
    const expected = secondIsCovered(normalized.eatingIntervals, second);
    const predicted = timelineStateAt(result.timeline, second) === "eating";
    if (expected && predicted) truePositiveSeconds += 1;
    else if (!expected && predicted) falsePositiveSeconds += 1;
    else if (expected && !predicted) falseNegativeSeconds += 1;
  }
  const predictedEatingSeconds = truePositiveSeconds + falsePositiveSeconds;
  const annotatedEatingSeconds = truePositiveSeconds + falseNegativeSeconds;
  const precisionDenominator = predictedEatingSeconds;
  const recallDenominator = annotatedEatingSeconds;
  return {
    reviewedSeconds,
    unreviewedSeconds: Math.max(0, duration - reviewedSeconds),
    reviewedCoverage: duration ? round4(reviewedSeconds / duration) : 0,
    truePositiveSeconds,
    falsePositiveSeconds,
    falseNegativeSeconds,
    precision: precisionDenominator ? round4(truePositiveSeconds / precisionDenominator) : 0,
    recall: recallDenominator ? round4(truePositiveSeconds / recallDenominator) : 0,
    predictedEatingSeconds,
    annotatedEatingSeconds,
    durationErrorSeconds: Math.abs(predictedEatingSeconds - annotatedEatingSeconds),
  };
}

module.exports = {
  ALGORITHM_VERSION,
  STATES,
  buildAnnotationSummary,
  buildFeedingStats,
  evaluateAnnotations,
  normalizeAnnotations,
};


