const DEFAULT_FEEDING_START_CONFIRMATION_POLICY = Object.freeze({
  minActualEatingSeconds: 6,
  minSpanSeconds: 8,
  minConfidence: 0.6,
  maxEvidenceAgeSeconds: 5,
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function analyzedSecondsOf(feedingStats = {}) {
  return Math.max(
    0,
    finiteNumber(
      feedingStats?.summary?.analyzedSeconds,
      finiteNumber(feedingStats?.source?.durationSec, 0)
    )
  );
}

function evaluateFeedingStartConfirmation(feedingStats = {}, policy = {}) {
  const thresholds = {
    ...DEFAULT_FEEDING_START_CONFIRMATION_POLICY,
    ...(policy && typeof policy === "object" ? policy : {}),
  };
  const meals = (Array.isArray(feedingStats?.meals) ? feedingStats.meals : [])
    .filter((meal) => meal && typeof meal === "object")
    .sort((left, right) => finiteNumber(right.endSec) - finiteNumber(left.endSec));
  if (meals.length === 0) {
    return { confirmed: false, reason: "NO_MEAL", thresholds };
  }

  const meal = meals[0];
  const actualEatingSeconds = Math.max(0, finiteNumber(meal.actualEatingSeconds));
  const spanSeconds = Math.max(0, finiteNumber(
    meal.spanSeconds,
    finiteNumber(meal.endSec) - finiteNumber(meal.startSec)
  ));
  const confidence = Math.max(0, finiteNumber(meal.confidence));
  const evidenceAgeSeconds = Math.max(
    0,
    analyzedSecondsOf(feedingStats) - finiteNumber(meal.endSec)
  );
  const evidence = {
    actualEatingSeconds,
    spanSeconds,
    confidence,
    evidenceAgeSeconds,
  };

  if (actualEatingSeconds < finiteNumber(thresholds.minActualEatingSeconds, 6)) {
    return { confirmed: false, reason: "INSUFFICIENT_EATING_SECONDS", meal, evidence, thresholds };
  }
  if (spanSeconds < finiteNumber(thresholds.minSpanSeconds, 8)) {
    return { confirmed: false, reason: "FEEDING_SPAN_TOO_SHORT", meal, evidence, thresholds };
  }
  if (confidence < finiteNumber(thresholds.minConfidence, 0.6)) {
    return { confirmed: false, reason: "LOW_CONFIDENCE", meal, evidence, thresholds };
  }
  if (evidenceAgeSeconds > finiteNumber(thresholds.maxEvidenceAgeSeconds, 5)) {
    return { confirmed: false, reason: "EATING_NOT_RECENT", meal, evidence, thresholds };
  }

  return {
    confirmed: true,
    reason: "CONFIRMED",
    meal,
    evidence,
    thresholds,
    startOffsetSec: Math.max(0, finiteNumber(meal.startSec)),
  };
}

module.exports = {
  DEFAULT_FEEDING_START_CONFIRMATION_POLICY,
  evaluateFeedingStartConfirmation,
};

