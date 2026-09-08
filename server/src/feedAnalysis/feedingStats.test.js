const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ALGORITHM_VERSION,
  buildAnnotationSummary,
  buildFeedingStats,
  evaluateAnnotations,
  normalizeAnnotations,
} = require("./feedingStats");

function framesForSecond(second, overrides = {}) {
  return [0, 0.5].map((fraction, index) => ({
    sampleIndex: second * 2 + index,
    offsetSec: second + fraction,
    second,
    hasCat: false,
    hasTarget: false,
    nearBowl: false,
    eatingVerified: false,
    confidence: 0.2,
    ...overrides,
  }));
}

test("buildFeedingStats emits mutually exclusive second states and leaves gaps uncertain", () => {
  const frames = [
    ...framesForSecond(0),
    ...framesForSecond(1, { hasCat: true, hasTarget: true, confidence: 0.8 }),
    ...framesForSecond(2, { hasCat: true, nearBowl: true, confidence: 0.85 }),
    ...framesForSecond(3, {
      hasCat: true,
      nearBowl: true,
      eatingVerified: true,
      confidence: 0.9,
      behaviorEvidence: { confidence: 0.76, faceObserved: true, faceAtBowl: true },
    }),
  ];

  const result = buildFeedingStats({
    source: { mediaId: "states", durationSec: 6 },
    frames,
    analyzedDurationSec: 6,
  });

  assert.equal(result.version, ALGORITHM_VERSION);
  assert.deepEqual(
    result.timeline.map(({ state, startSec, endSec }) => ({ state, startSec, endSec })),
    [
      { state: "no_cat", startSec: 0, endSec: 1 },
      { state: "cat_away_from_bowl", startSec: 1, endSec: 2 },
      { state: "near_bowl_not_eating", startSec: 2, endSec: 3 },
      { state: "eating", startSec: 3, endSec: 4 },
      { state: "uncertain", startSec: 4, endSec: 6 },
    ]
  );
  assert.equal(result.summary.actualEatingSeconds, 1);
  assert.equal(result.summary.bowlPresenceSeconds, 2);
  assert.equal(result.summary.analyzedSeconds, 6);
  assert.equal(result.summary.observedSeconds, 4);
  assert.equal(result.summary.coverage, 0.6667);
});

test("buildFeedingStats counts every face-at-bowl second", () => {
  const frames = [];
  for (let second = 0; second < 8; second += 1) {
    frames.push(
      ...framesForSecond(second, {
        hasCat: true,
        nearBowl: true,
        eatingVerified: second === 0 || second === 3 || second === 6,
        confidence: 0.9,
        behaviorEvidence: { confidence: 0.4, faceObserved: true, faceAtBowl: true },
      })
    );
  }

  const result = buildFeedingStats({
    source: { mediaId: "sparse-chewing", durationSec: 8 },
    frames,
  });

  assert.equal(result.summary.mealCount, 1);
  assert.equal(result.summary.actualEatingSeconds, 8);
  assert.equal(result.summary.bowlPresenceSeconds, 8);
  assert.equal(result.meals[0].startSec, 0);
  assert.equal(result.meals[0].endSec, 8);
  assert.equal(result.meals[0].spanSeconds, 8);
  assert.equal(result.meals[0].actualEatingSeconds, 8);
});

test("buildFeedingStats bridges at most two face-missing seconds while the cat stays at the bowl", () => {
  const frames = [];
  for (let second = 0; second < 9; second += 1) {
    const faceAtBowl = ![2, 3, 6, 7, 8].includes(second);
    frames.push(...framesForSecond(second, {
      hasCat: true,
      nearBowl: true,
      confidence: 0.88,
      behaviorEvidence: { faceObserved: true, faceAtBowl },
    }));
  }

  const result = buildFeedingStats({
    source: { mediaId: "face-gap", durationSec: 9 },
    frames,
  });

  assert.equal(result.summary.actualEatingSeconds, 6);
  assert.deepEqual(
    result.timeline.map(({ state, startSec, endSec }) => ({ state, startSec, endSec })),
    [
      { state: "eating", startSec: 0, endSec: 6 },
      { state: "near_bowl_not_eating", startSec: 6, endSec: 9 },
    ]
  );
  assert.equal(result.diagnostics.thresholds.maxFaceObservationGapSeconds, 2);
});

for (const [label, interruptedFrames] of [
  ["no-cat", {}],
  ["cat-away", { hasCat: true, hasTarget: true, confidence: 0.82 }],
]) {
  test(`buildFeedingStats smooths one observed ${label} second inside continuous eating`, () => {
    const eating = (second, confidence) => framesForSecond(second, {
      hasCat: true,
      nearBowl: true,
      confidence,
      behaviorEvidence: { confidence, faceObserved: true, faceAtBowl: true },
    });
    const result = buildFeedingStats({
      source: { mediaId: `single-${label}-glitch`, durationSec: 3 },
      frames: [
        ...eating(0, 0.84),
        ...framesForSecond(1, interruptedFrames),
        ...eating(2, 0.91),
      ],
    });

    assert.deepEqual(
      result.timeline.map(({ state, startSec, endSec }) => ({ state, startSec, endSec })),
      [{ state: "eating", startSec: 0, endSec: 3 }]
    );
    assert.equal(result.summary.actualEatingSeconds, 3);
    assert.deepEqual(result.diagnostics.temporalSmoothing.bridgedSeconds, [1]);
    assert.equal(result.diagnostics.temporalSmoothing.originalStates[label === "no-cat" ? "no_cat" : "cat_away_from_bowl"], 1);
  });
}

test("buildFeedingStats preserves a two-second no-cat interruption", () => {
  const eatingFrames = (second) => framesForSecond(second, {
    hasCat: true,
    nearBowl: true,
    confidence: 0.9,
    behaviorEvidence: { confidence: 0.9, faceObserved: true, faceAtBowl: true },
  });
  const result = buildFeedingStats({
    source: { mediaId: "two-second-no-cat", durationSec: 4 },
    frames: [
      ...eatingFrames(0),
      ...framesForSecond(1),
      ...framesForSecond(2),
      ...eatingFrames(3),
    ],
  });

  assert.deepEqual(
    result.timeline.map(({ state, startSec, endSec }) => ({ state, startSec, endSec })),
    [
      { state: "eating", startSec: 0, endSec: 1 },
      { state: "no_cat", startSec: 1, endSec: 3 },
      { state: "eating", startSec: 3, endSec: 4 },
    ]
  );
  assert.deepEqual(result.diagnostics.temporalSmoothing.bridgedSeconds, []);
});

test("buildFeedingStats does not infer eating across an unobserved second", () => {
  const eatingFrames = (second) => framesForSecond(second, {
    hasCat: true,
    nearBowl: true,
    confidence: 0.9,
    behaviorEvidence: { confidence: 0.9, faceObserved: true, faceAtBowl: true },
  });
  const result = buildFeedingStats({
    source: { mediaId: "missing-sample", durationSec: 3 },
    frames: [...eatingFrames(0), ...eatingFrames(2)],
  });

  assert.deepEqual(
    result.timeline.map(({ state, startSec, endSec }) => ({ state, startSec, endSec })),
    [
      { state: "eating", startSec: 0, endSec: 1 },
      { state: "uncertain", startSec: 1, endSec: 2 },
      { state: "eating", startSec: 2, endSec: 3 },
    ]
  );
  assert.deepEqual(result.diagnostics.temporalSmoothing.bridgedSeconds, []);
});

test("buildFeedingStats keeps a bowl-supported close-up detector dropout inside one feeding visit", () => {
  const eatingFrames = (second) => framesForSecond(second, {
    hasCat: true,
    nearBowl: true,
    confidence: 0.9,
    behaviorEvidence: { confidence: 0.9, faceObserved: true, faceAtBowl: true },
  });
  const frames = [];
  for (let second = 0; second <= 2; second += 1) {
    frames.push(...eatingFrames(second));
  }
  for (let second = 3; second <= 14; second += 1) {
    frames.push(...framesForSecond(second));
  }
  for (let second = 15; second <= 23; second += 1) {
    frames.push(...framesForSecond(second, {
      hasCat: true,
      nearBowl: true,
      confidence: 0.7,
      behaviorEvidence: { faceObserved: true, faceAtBowl: false },
    }));
  }
  for (let second = 24; second <= 26; second += 1) {
    frames.push(...eatingFrames(second));
  }

  const result = buildFeedingStats({
    source: { mediaId: "closeup-visit-dropout", durationSec: 27 },
    frames,
  });

  assert.deepEqual(
    result.timeline.map(({ state, startSec, endSec }) => ({ state, startSec, endSec })),
    [{ state: "eating", startSec: 0, endSec: 27 }]
  );
  assert.equal(result.summary.actualEatingSeconds, 27);
  assert.deepEqual(
    result.diagnostics.temporalSmoothing.visitBridgedSeconds,
    Array.from({ length: 21 }, (_, index) => index + 3)
  );
  assert.equal(result.diagnostics.thresholds.maxFeedingVisitGapSeconds, 24);
  assert.equal(result.diagnostics.thresholds.maxCloseupNoCatRunSeconds, 12);
  assert.equal(result.diagnostics.thresholds.minFeedingVisitSupportRatio, 0.4);
  assert.equal(result.diagnostics.thresholds.feedingVisitAnchorWindowSeconds, 30);
  assert.equal(result.diagnostics.thresholds.minFeedingVisitAnchorSeconds, 3);
});

test("buildFeedingStats does not hide a continuous no-cat run longer than the close-up allowance", () => {
  const eatingFrames = (second) => framesForSecond(second, {
    hasCat: true,
    nearBowl: true,
    confidence: 0.9,
    behaviorEvidence: { confidence: 0.9, faceObserved: true, faceAtBowl: true },
  });
  const frames = [];
  for (let second = 0; second <= 2; second += 1) {
    frames.push(...eatingFrames(second));
  }
  for (let second = 3; second <= 15; second += 1) {
    frames.push(...framesForSecond(second));
  }
  for (let second = 16; second <= 24; second += 1) {
    frames.push(...framesForSecond(second, {
      hasCat: true,
      nearBowl: true,
      confidence: 0.7,
      behaviorEvidence: { faceObserved: true, faceAtBowl: false },
    }));
  }
  for (let second = 25; second <= 27; second += 1) {
    frames.push(...eatingFrames(second));
  }

  const result = buildFeedingStats({
    source: { mediaId: "real-departure", durationSec: 28 },
    frames,
  });

  assert.deepEqual(result.diagnostics.temporalSmoothing.visitBridgedSeconds, []);
  assert.equal(result.summary.actualEatingSeconds, 6);
  assert.ok(result.timeline.some((item) => item.state === "no_cat" && item.durationSec === 13));
});

test("buildFeedingStats keeps an unbounded distant or near-bowl tail out of eating time", () => {
  const frames = framesForSecond(0, {
    hasCat: true,
    nearBowl: true,
    confidence: 0.9,
    behaviorEvidence: { confidence: 0.9, faceObserved: true, faceAtBowl: true },
  });
  for (let second = 1; second < 10; second += 1) {
    frames.push(...framesForSecond(second, {
      hasCat: true,
      nearBowl: true,
      confidence: 0.8,
      behaviorEvidence: { faceObserved: true, faceAtBowl: false },
    }));
  }

  const result = buildFeedingStats({
    source: { mediaId: "unbounded-standing-cat", durationSec: 10 },
    frames,
  });

  assert.deepEqual(result.diagnostics.temporalSmoothing.visitBridgedSeconds, []);
  assert.equal(result.summary.actualEatingSeconds, 1);
  assert.deepEqual(
    result.timeline.map(({ state, startSec, endSec }) => ({ state, startSec, endSec })),
    [
      { state: "eating", startSec: 0, endSec: 1 },
      { state: "near_bowl_not_eating", startSec: 1, endSec: 10 },
    ]
  );
});

test("buildFeedingStats does not count strict motion verification without an observed face", () => {
  const frames = framesForSecond(0, {
    hasCat: true,
    nearBowl: true,
    eatingVerified: true,
    confidence: 0.9,
    behaviorEvidence: { confidence: 0.9, faceObserved: false, faceAtBowl: false },
  });

  const result = buildFeedingStats({
    source: { mediaId: "strict-without-face", durationSec: 1 },
    frames,
  });

  assert.equal(result.summary.actualEatingSeconds, 0);
  assert.equal(result.timeline[0].state, "near_bowl_not_eating");
});

test("buildFeedingStats does not count a visible face that is away from the bowl", () => {
  const frames = framesForSecond(0, {
    hasCat: true,
    nearBowl: true,
    confidence: 0.9,
    behaviorEvidence: {
      confidence: 0,
      faceObserved: true,
      faceAtBowl: false,
      reason: "FACE_MOUTH_AWAY_FROM_BOWL",
    },
  });

  const result = buildFeedingStats({
    source: { mediaId: "visible-face-away", durationSec: 1 },
    frames,
  });

  assert.equal(result.summary.actualEatingSeconds, 0);
  assert.equal(result.timeline[0].state, "near_bowl_not_eating");
});

test("buildFeedingStats rejects short or weak feeding candidates", () => {
  const frames = [];
  for (let second = 0; second < 12; second += 1) {
    frames.push(
      ...framesForSecond(second, {
        hasCat: second < 6,
        nearBowl: second < 6,
        eatingVerified: second === 0 || second === 5,
        confidence: 0.85,
        behaviorEvidence: {
          faceObserved: second === 0 || second === 5,
          faceAtBowl: second === 0 || second === 5,
        },
      })
    );
  }

  const result = buildFeedingStats({
    source: { mediaId: "too-few-anchors", durationSec: 12 },
    frames,
  });

  assert.equal(result.summary.actualEatingSeconds, 2);
  assert.equal(result.summary.mealCount, 0);
  assert.equal(result.diagnostics.rejectedFeedingCandidates.length, 1);
  assert.equal(result.diagnostics.rejectedFeedingCandidates[0].reason, "INSUFFICIENT_VERIFIED_SECONDS");
});

test("buildFeedingStats groups accepted feeding events less than ten minutes apart", () => {
  const frames = [];
  const first = new Set([0, 3, 6]);
  const second = new Set([500, 503, 506]);
  const third = new Set([1200, 1203, 1206]);
  const anchors = new Set([...first, ...second, ...third]);
  const supported = (value) =>
    (value >= 0 && value <= 7) ||
    (value >= 500 && value <= 507) ||
    (value >= 1200 && value <= 1207);
  for (let value = 0; value < 1208; value += 1) {
    if (!supported(value) && !anchors.has(value)) continue;
    frames.push(
      ...framesForSecond(value, {
        hasCat: true,
        nearBowl: true,
        eatingVerified: anchors.has(value),
        confidence: 0.9,
        behaviorEvidence: {
          faceObserved: anchors.has(value),
          faceAtBowl: anchors.has(value),
        },
      })
    );
  }

  const result = buildFeedingStats({
    source: { mediaId: "meal-grouping", durationSec: 1208 },
    frames,
  });

  assert.equal(result.events.length, 3);
  assert.equal(result.summary.mealCount, 2);
  assert.equal(result.meals[0].eventCount, 2);
  assert.equal(result.meals[0].actualEatingSeconds, 14);
  assert.equal(result.meals[1].eventCount, 1);
});

test("normalizeAnnotations clamps, merges, and keeps unreviewed time out of evaluation", () => {
  const normalized = normalizeAnnotations(
    {
      mediaId: "annotated",
      reviewedRanges: [
        { startSec: -2, endSec: 5 },
        { startSec: 4, endSec: 10 },
      ],
      eatingIntervals: [
        { id: "a", startSec: 1, endSec: 3 },
        { id: "b", startSec: 8, endSec: 12 },
      ],
    },
    10
  );

  assert.deepEqual(normalized.reviewedRanges, [{ startSec: 0, endSec: 10 }]);
  assert.deepEqual(normalized.eatingIntervals, [
    { id: "a", startSec: 1, endSec: 3 },
    { id: "b", startSec: 8, endSec: 10 },
  ]);

  const summary = buildAnnotationSummary(normalized, 10);
  assert.equal(summary.actualEatingSeconds, 4);
  assert.equal(summary.reviewedSeconds, 10);
  assert.equal(summary.reviewedCoverage, 1);
  assert.equal(summary.mealCount, 1);
});

test("evaluateAnnotations reports per-second precision and duration error only in reviewed ranges", () => {
  const frames = [];
  const faceSeconds = new Set([1, 2, 3, 7]);
  for (let second = 0; second < 20; second += 1) {
    frames.push(
      ...framesForSecond(second, {
        hasCat: true,
        nearBowl: true,
        eatingVerified: faceSeconds.has(second),
        confidence: 0.9,
        behaviorEvidence: {
          faceObserved: faceSeconds.has(second),
          faceAtBowl: faceSeconds.has(second),
        },
      })
    );
  }
  const result = buildFeedingStats({
    source: { mediaId: "evaluation", durationSec: 20 },
    frames,
  });
  const evaluation = evaluateAnnotations(
    result,
    {
      mediaId: "evaluation",
      reviewedRanges: [{ startSec: 0, endSec: 10 }],
      eatingIntervals: [{ id: "truth", startSec: 2, endSec: 5 }],
    }
  );

  assert.equal(evaluation.reviewedSeconds, 10);
  assert.equal(evaluation.truePositiveSeconds, 2);
  assert.equal(evaluation.falsePositiveSeconds, 2);
  assert.equal(evaluation.falseNegativeSeconds, 1);
  assert.equal(evaluation.precision, 0.5);
  assert.equal(evaluation.recall, 0.6667);
  assert.equal(evaluation.durationErrorSeconds, 1);
  assert.equal(evaluation.unreviewedSeconds, 10);
});


