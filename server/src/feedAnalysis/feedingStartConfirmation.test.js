const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateFeedingStartConfirmation } = require("./feedingStartConfirmation");

function stats(meals, analyzedSeconds = 30) {
  return {
    version: "feeding-stats-v3.2",
    source: { durationSec: analyzedSeconds },
    summary: { analyzedSeconds, mealCount: meals.length },
    meals,
  };
}

test("confirms sustained recent eating", () => {
  const result = evaluateFeedingStartConfirmation(stats([{
    id: "meal-1",
    startSec: 17,
    endSec: 29,
    spanSeconds: 12,
    actualEatingSeconds: 8,
    confidence: 0.84,
  }]));

  assert.equal(result.confirmed, true);
  assert.equal(result.meal.id, "meal-1");
  assert.equal(result.startOffsetSec, 17);
});

test("rejects eating evidence that ended too far from the current window", () => {
  const result = evaluateFeedingStartConfirmation(stats([{
    id: "meal-stale",
    startSec: 1,
    endSec: 12,
    spanSeconds: 11,
    actualEatingSeconds: 8,
    confidence: 0.9,
  }]));

  assert.equal(result.confirmed, false);
  assert.equal(result.reason, "EATING_NOT_RECENT");
});

test("rejects insufficient verified eating seconds", () => {
  const result = evaluateFeedingStartConfirmation(stats([{
    id: "meal-short",
    startSec: 20,
    endSec: 29,
    spanSeconds: 9,
    actualEatingSeconds: 5,
    confidence: 0.9,
  }]));

  assert.equal(result.confirmed, false);
  assert.equal(result.reason, "INSUFFICIENT_EATING_SECONDS");
});

test("rejects a low-confidence meal", () => {
  const result = evaluateFeedingStartConfirmation(stats([{
    id: "meal-uncertain",
    startSec: 19,
    endSec: 29,
    spanSeconds: 10,
    actualEatingSeconds: 8,
    confidence: 0.59,
  }]));

  assert.equal(result.confirmed, false);
  assert.equal(result.reason, "LOW_CONFIDENCE");
});

test("selects the latest qualifying meal", () => {
  const result = evaluateFeedingStartConfirmation(stats([
    {
      id: "meal-old",
      startSec: 2,
      endSec: 12,
      spanSeconds: 10,
      actualEatingSeconds: 8,
      confidence: 0.9,
    },
    {
      id: "meal-latest",
      startSec: 18,
      endSec: 29,
      spanSeconds: 11,
      actualEatingSeconds: 7,
      confidence: 0.75,
    },
  ]));

  assert.equal(result.confirmed, true);
  assert.equal(result.meal.id, "meal-latest");
});

