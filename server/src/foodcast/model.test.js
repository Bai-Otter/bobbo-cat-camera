const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");

const { parseLocalTime, selectFoodcastSegments } = require("./model");

function clip({ id = "clip-a", beginTime, endTime, confidence = 0.7, markers = [], cuteTimeline }) {
  const result = {
    id,
    beginTime,
    endTime,
    analysisConfidence: confidence,
    playbackParams: { startTime: beginTime, endTime, fileName: `${id}.mp4` },
    markers,
  };
  if (cuteTimeline !== undefined) result.cuteTimeline = cuteTimeline;
  return result;
}

function marker(markerType, beginTime, confidence = 0.8, extra = {}) {
  return { markerType, beginTime, confidence, ...extra };
}

function feedingClip({
  id = "clip-a",
  beginTime = "2026-07-16 08:00:00",
  endTime = "2026-07-16 08:01:00",
  feedingStart = "2026-07-16 08:00:05",
  feedingEnd = "2026-07-16 08:00:30",
  confidence = 0.7,
  cute = [],
  cuteTimeline,
} = {}) {
  return clip({
    id,
    beginTime,
    endTime,
    confidence,
    markers: [
      marker("feeding_start", feedingStart, confidence),
      ...cute,
      marker("feeding_end", feedingEnd, confidence),
    ],
    cuteTimeline,
  });
}

function timelinePoint(offsetSec, cuteScore, modelConfidence = 0.9, extra = {}) {
  return {
    offsetSec,
    cuteScore,
    modelConfidence,
    cuteReasons: ["head_up"],
    hasCat: true,
    ...extra,
  };
}

test("timeline quick cut separates strict and loose camera-relation profiles", () => {
  const timeline = [
    timelinePoint(5, 0.9, 0.9, {
      faceRelation: "toward_camera",
      strictEligible: true,
      looseEligible: true,
    }),
    timelinePoint(15, 0.9, 0.9, {
      faceRelation: "profile_right",
      strictEligible: true,
      looseEligible: true,
    }),
    timelinePoint(25, 0.8, 0.9, {
      faceRelation: "unknown",
      strictEligible: false,
      looseEligible: true,
    }),
    timelinePoint(35, 0.9, 0.9, {
      faceRelation: "looking_away",
      strictEligible: false,
      looseEligible: false,
    }),
  ];
  const diary = {
    clips: [feedingClip({
      beginTime: "2026-07-16 08:00:00",
      endTime: "2026-07-16 08:00:45",
      feedingStart: "2026-07-16 08:00:00",
      feedingEnd: "2026-07-16 08:00:45",
      cuteTimeline: timeline,
    })],
    meals: [],
  };
  const strict = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 60, selectionProfile: "strict" });
  const loose = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 60, selectionProfile: "loose" });
  assert.ok(strict.length > 0);
  assert.ok(loose.length > 0);
  assert.ok(strict.every((item) => !item.faceRelations.includes("unknown")));
  assert.ok(loose.some((item) => item.faceRelations.includes("unknown")));
  assert.ok(strict.some((item) => item.faceRelations.includes("profile_right")));
  assert.ok(loose.every((item) => !item.faceRelations.includes("looking_away")));
});

function timelineDiary(scores) {
  return {
    clips: scores.map((cuteScore, index) => {
      const minute = String(index).padStart(2, "0");
      return feedingClip({
        id: `timeline-${index}`,
        beginTime: `2026-07-16 08:${minute}:00`,
        endTime: `2026-07-16 08:${minute}:10`,
        feedingStart: `2026-07-16 08:${minute}:00`,
        feedingEnd: `2026-07-16 08:${minute}:10`,
        cuteTimeline: [timelinePoint(5, cuteScore)],
      });
    }),
    meals: [],
  };
}

function timelineRecording(id, hour, cuteScore) {
  const hourText = String(hour).padStart(2, "0");
  return feedingClip({
    id,
    beginTime: `2026-07-16 ${hourText}:00:00`,
    endTime: `2026-07-16 ${hourText}:00:30`,
    feedingStart: `2026-07-16 ${hourText}:00:00`,
    feedingEnd: `2026-07-16 ${hourText}:00:30`,
    cuteTimeline: [timelinePoint(10, cuteScore)],
  });
}

test("centers a ten-second cute window inside a feeding interval", () => {
  const diary = {
    clips: [feedingClip({ cute: [marker("cute_front", "2026-07-16 08:00:15", 0.92)] })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary });

  assert.equal(result.length, 1);
  assert.equal(result[0].startTime, "2026-07-16 08:00:10");
  assert.equal(result[0].endTime, "2026-07-16 08:00:20");
  assert.equal(result[0].durationSec, 10);
  assert.equal(result[0].confidence, 0.92);
  assert.deepEqual(result[0].markerTypes, ["cute_front"]);
});

test("clips the cute window to feeding boundaries instead of padding outside", () => {
  const diary = {
    clips: [feedingClip({ cute: [marker("cute_closeup", "2026-07-16 08:00:07", 0.84)] })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary });

  assert.equal(result[0].startTime, "2026-07-16 08:00:05");
  assert.equal(result[0].endTime, "2026-07-16 08:00:12");
  assert.equal(result[0].durationSec, 7);
});

test("ignores cute markers outside feeding intervals", () => {
  const diary = {
    clips: [feedingClip({ cute: [marker("cute_front", "2026-07-16 08:00:40", 0.99)] })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary });

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].markerTypes, []);
  assert.equal(result[0].startTime, "2026-07-16 08:00:05");
  assert.equal(result[0].endTime, "2026-07-16 08:00:25");
});

test("discards a cute candidate shorter than two seconds", () => {
  const diary = {
    clips: [feedingClip({
      feedingStart: "2026-07-16 08:00:05",
      feedingEnd: "2026-07-16 08:00:06",
      cute: [marker("cute_front", "2026-07-16 08:00:05", 0.95)],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary });

  assert.deepEqual(result, []);
});

test("merges nearby cute windows only within the same feeding interval", () => {
  const diary = {
    clips: [clip({
      id: "clip-a",
      beginTime: "2026-07-16 08:00:00",
      endTime: "2026-07-16 08:01:00",
      markers: [
        marker("feeding_start", "2026-07-16 08:00:05"),
        marker("cute_closeup", "2026-07-16 08:00:12", 0.82),
        marker("cute_front", "2026-07-16 08:00:18", 0.91),
        marker("feeding_end", "2026-07-16 08:00:24"),
        marker("feeding_start", "2026-07-16 08:00:25"),
        marker("cute_front", "2026-07-16 08:00:26", 0.87),
        marker("feeding_end", "2026-07-16 08:00:35"),
      ],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary });

  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((item) => [item.startTime, item.endTime]),
    [
      ["2026-07-16 08:00:07", "2026-07-16 08:00:23"],
      ["2026-07-16 08:00:25", "2026-07-16 08:00:31"],
    ]
  );
  assert.deepEqual(result[0].markerTypes, ["cute_closeup", "cute_front"]);
});

test("does not pad a valid cute result with ordinary feeding footage", () => {
  const diary = {
    clips: [
      feedingClip({
        id: "cute",
        cute: [marker("cute_closeup", "2026-07-16 08:00:15", 0.8)],
      }),
      feedingClip({
        id: "ordinary",
        beginTime: "2026-07-16 09:00:00",
        endTime: "2026-07-16 09:01:00",
        feedingStart: "2026-07-16 09:00:05",
        feedingEnd: "2026-07-16 09:00:50",
        confidence: 0.99,
      }),
    ],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary });

  assert.deepEqual(result.map((item) => item.clipId), ["cute"]);
  assert.equal(result[0].durationSec, 10);
});

test("limits cute selection to six segments and sixty seconds then restores chronology", () => {
  const clips = Array.from({ length: 7 }, (_, index) => {
    const hour = String(8 + index).padStart(2, "0");
    return feedingClip({
      id: `clip-${index}`,
      beginTime: `2026-07-16 ${hour}:00:00`,
      endTime: `2026-07-16 ${hour}:01:00`,
      feedingStart: `2026-07-16 ${hour}:00:05`,
      feedingEnd: `2026-07-16 ${hour}:00:30`,
      cute: [marker(index % 2 ? "cute_front" : "cute_closeup", `2026-07-16 ${hour}:00:15`, 0.7 + index / 100)],
    });
  });

  const result = selectFoodcastSegments({ diary: { clips, meals: [] } });

  assert.equal(result.length, 6);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 60);
  assert.deepEqual(result.map((item) => item.clipId), ["clip-1", "clip-2", "clip-3", "clip-4", "clip-5", "clip-6"]);
});

test("intersects meal candidates with the exact meal time range", () => {
  const diary = {
    clips: [feedingClip({
      id: "dinner",
      beginTime: "2026-07-16 18:00:00",
      endTime: "2026-07-16 18:01:00",
      feedingStart: "2026-07-16 18:00:05",
      feedingEnd: "2026-07-16 18:00:30",
      cute: [marker("cute_front", "2026-07-16 18:00:16", 0.9)],
    })],
    meals: [{
      id: "meal-dinner",
      startTime: "2026-07-16 18:00:13",
      endTime: "2026-07-16 18:00:19",
      clipIds: ["dinner"],
    }],
  };

  const result = selectFoodcastSegments({ diary, scope: "meal", mealId: "meal-dinner" });

  assert.equal(result[0].startTime, "2026-07-16 18:00:13");
  assert.equal(result[0].endTime, "2026-07-16 18:00:19");
});

test("fallback chooses no more than two high-confidence intervals and twenty seconds", () => {
  const clips = [
    feedingClip({ id: "low", confidence: 0.4 }),
    feedingClip({
      id: "best",
      beginTime: "2026-07-16 09:00:00",
      endTime: "2026-07-16 09:01:00",
      feedingStart: "2026-07-16 09:00:05",
      feedingEnd: "2026-07-16 09:00:13",
      confidence: 0.95,
    }),
    feedingClip({
      id: "good",
      beginTime: "2026-07-16 10:00:00",
      endTime: "2026-07-16 10:01:00",
      feedingStart: "2026-07-16 10:00:05",
      feedingEnd: "2026-07-16 10:00:25",
      confidence: 0.85,
    }),
  ];

  const result = selectFoodcastSegments({ diary: { clips, meals: [] } });

  assert.deepEqual(result.map((item) => item.clipId), ["best", "good"]);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 20);
  assert.deepEqual(result.map((item) => item.markerTypes), [[], []]);
});

test("quick cut uses five-second windows for every cute marker type", () => {
  const diary = {
    clips: [feedingClip({
      feedingStart: "2026-07-16 08:00:05",
      feedingEnd: "2026-07-16 08:01:00",
      cute: [
        marker("cute_closeup", "2026-07-16 08:00:08", 0.91),
        marker("cute_front", "2026-07-16 08:00:17", 0.92),
        marker("cute_extreme_closeup", "2026-07-16 08:00:26", 0.93),
        marker("cute_profile_left", "2026-07-16 08:00:35", 0.93),
        marker("cute_profile_right", "2026-07-16 08:00:44", 0.94),
        marker("cute_head_up", "2026-07-16 08:00:53", 0.95),
      ],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut" });

  assert.equal(result.length, 6);
  assert.deepEqual(
    result.map((item) => [item.startTime, item.endTime, item.markerTypes[0]]),
    [
      ["2026-07-16 08:00:06", "2026-07-16 08:00:11", "cute_closeup"],
      ["2026-07-16 08:00:15", "2026-07-16 08:00:20", "cute_front"],
      ["2026-07-16 08:00:24", "2026-07-16 08:00:29", "cute_extreme_closeup"],
      ["2026-07-16 08:00:33", "2026-07-16 08:00:38", "cute_profile_left"],
      ["2026-07-16 08:00:42", "2026-07-16 08:00:47", "cute_profile_right"],
      ["2026-07-16 08:00:51", "2026-07-16 08:00:56", "cute_head_up"],
    ]
  );
});

test("quick cut clips windows to feeding bounds and joins nearby windows", () => {
  const diary = {
    clips: [feedingClip({
      feedingStart: "2026-07-16 08:00:05",
      feedingEnd: "2026-07-16 08:00:12",
      cute: [
        marker("cute_front", "2026-07-16 08:00:06", 0.9),
        marker("cute_closeup", "2026-07-16 08:00:09", 0.89),
        marker("cute_profile_left", "2026-07-16 08:00:11", 0.88),
      ],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut" });

  assert.deepEqual(
    result.map((item) => [item.startTime, item.endTime]),
    [
      ["2026-07-16 08:00:05", "2026-07-16 08:00:12"],
    ]
  );
  assert.equal(result[0].durationSec, 7);
});

test("quick cut joins overlapping and nearby source windows into one continuous segment", () => {
  const diary = {
    clips: [feedingClip({
      feedingStart: "2026-07-16 08:00:05",
      feedingEnd: "2026-07-16 08:00:35",
      cute: [
        marker("cute_front", "2026-07-16 08:00:10", 0.99),
        marker("cute_closeup", "2026-07-16 08:00:13", 0.98),
        marker("cute_profile_left", "2026-07-16 08:00:19", 0.97),
        marker("cute_profile_right", "2026-07-16 08:00:25", 0.96),
      ],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut" });

  assert.equal(result.length, 1);
  assert.equal(result[0].startTime, "2026-07-16 08:00:08");
  assert.equal(result[0].endTime, "2026-07-16 08:00:28");
  assert.deepEqual(result[0].markerTypes, [
    "cute_closeup",
    "cute_front",
    "cute_profile_left",
    "cute_profile_right",
  ]);
});

test("quick cut keeps windows separate when their gap exceeds one second", () => {
  const diary = {
    clips: [feedingClip({
      feedingStart: "2026-07-16 08:00:05",
      feedingEnd: "2026-07-16 08:00:35",
      cute: [
        marker("cute_front", "2026-07-16 08:00:10", 0.99),
        marker("cute_profile_left", "2026-07-16 08:00:17", 0.97),
      ],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut" });

  assert.deepEqual(
    result.map((item) => [item.startTime, item.endTime]),
    [
      ["2026-07-16 08:00:08", "2026-07-16 08:00:13"],
      ["2026-07-16 08:00:15", "2026-07-16 08:00:20"],
    ]
  );
});

test("quick cut returns no ordinary feeding fallback", () => {
  const diary = { clips: [feedingClip()], meals: [] };

  assert.deepEqual(selectFoodcastSegments({ diary, mode: "quick_cut" }), []);
});

test("quick cut combines marker labels that describe the same moment", () => {
  const diary = {
    clips: [feedingClip({
      cute: [
        marker("cute_closeup", "2026-07-16 08:00:10", 0.91),
        marker("cute_front", "2026-07-16 08:00:10", 0.93),
      ],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut" });

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].markerTypes, ["cute_closeup", "cute_front"]);
  assert.equal(result[0].confidence, 0.93);
});

test("quick cut keeps every eligible legacy marker without a thirty-second cap", () => {
  const times = [
    "08:00:07", "08:00:16", "08:00:25", "08:00:34", "08:00:43", "08:00:52",
    "08:01:01", "08:01:10",
  ];
  const cute = times.map((time, index) => marker(
    index % 2 ? "cute_front" : "cute_profile_right",
    `2026-07-16 ${time}`,
    0.85 + index / 100
  ));
  cute.push(marker("cute_profile_left", "2026-07-16 08:01:19", 0.84));
  const diary = {
    clips: [feedingClip({
      endTime: "2026-07-16 08:02:00",
      feedingEnd: "2026-07-16 08:01:25",
      cute,
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut" });

  assert.equal(result.length, 9);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 45);
  assert.ok(result.some((item) => item.markerTypes.includes("cute_profile_left")));
});

test("quick cut thresholds marker confidence instead of promoting it from clip confidence", () => {
  const cute = [
    marker("cute_closeup", "2026-07-16 08:00:10", 0.85),
    marker("cute_profile_left", "2026-07-16 08:00:20", 0.64),
  ];
  const diary = {
    clips: [feedingClip({
      confidence: 0.99,
      cute,
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut" });

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].markerTypes, ["cute_closeup"]);
});

test("quick cut uses model confidence and cute score as separate gates", () => {
  const diary = {
    clips: [feedingClip({
      feedingEnd: "2026-07-16 08:00:50",
      cute: [
        marker("cute_extreme_closeup", "2026-07-16 08:00:10", 0.4, {
          modelConfidence: 0.8,
          cuteScore: 0.94,
          cuteReasons: ["extreme_closeup"],
        }),
        marker("cute_front", "2026-07-16 08:00:20", 0.99, {
          modelConfidence: 0.64,
          cuteScore: 1.0,
          cuteReasons: ["front"],
        }),
        marker("cute_head_up", "2026-07-16 08:00:30", 0.4, {
          modelConfidence: 0.65,
          cuteScore: 0.8,
          cuteReasons: ["head_up"],
        }),
        marker("cute_profile_left", "2026-07-16 08:00:40", 0.4, {
          modelConfidence: 0.9,
          cuteScore: 0.79,
          cuteReasons: ["profile_left"],
        }),
      ],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut" });

  assert.deepEqual(result.map((item) => item.markerTypes), [
    ["cute_extreme_closeup"],
    ["cute_head_up"],
  ]);
  assert.equal(result[0].modelConfidence, 0.8);
  assert.equal(result[0].cuteScore, 0.94);
  assert.deepEqual(result[0].cuteReasons, ["extreme_closeup"]);
});

for (const targetDurationSec of [20, 30, 60, 120, 180]) {
  test(`timeline quick cut selects ${targetDurationSec} seconds of qualified material`, () => {
    const candidateCount = targetDurationSec / 5;
    const diary = timelineDiary(Array.from({ length: candidateCount }, (_, index) => 0.99 - index / 1000));

    const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec });

    assert.equal(result.length, candidateCount);
    assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), targetDurationSec);
  });
}

test("timeline quick cut returns qualified material shorter than the 180 second mode budget", () => {
  const diary = timelineDiary([0.95, 0.9]);

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 180 });

  assert.equal(result.length, 2);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 10);
});

test("timeline quick cut chooses high scores first then restores source chronology", () => {
  const diary = timelineDiary([0.76, 0.9, 0.95, 0.85, 0.92]);

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.deepEqual(result.map((item) => item.clipId), [
    "timeline-1",
    "timeline-2",
    "timeline-3",
    "timeline-4",
  ]);
  assert.deepEqual(result.map((item) => item.cuteScore), [0.9, 0.95, 0.85, 0.92]);
});

test("timeline quick cut resolves equal scores by reliability, sample count, then source time", () => {
  const diary = {
    clips: [feedingClip({
      endTime: "2026-07-16 08:02:00",
      feedingStart: "2026-07-16 08:00:00",
      feedingEnd: "2026-07-16 08:02:00",
      cuteTimeline: [
        timelinePoint(10, 0.99, 0.7),
        timelinePoint(14, 0.99, 0.95),
        timelinePoint(30, 0.98, 0.9),
        timelinePoint(34, 0.98, 0.9),
        timelinePoint(36.5, 0.8, 0.9),
        timelinePoint(50, 0.97, 0.9),
        timelinePoint(54, 0.97, 0.9),
        timelinePoint(70, 0.8, 0.9),
      ],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.deepEqual(result.map((item) => item.startTime), [
    "2026-07-16 08:00:12",
    "2026-07-16 08:00:32",
    "2026-07-16 08:00:48",
    "2026-07-16 08:01:08",
  ]);
});

test("timeline quick cut keeps only the higher-scored overlapping candidate", () => {
  const diary = timelineDiary([0.9, 0.89, 0.88]);
  diary.clips.unshift(feedingClip({
    id: "overlap",
    feedingStart: "2026-07-16 07:00:00",
    feedingEnd: "2026-07-16 07:00:30",
    beginTime: "2026-07-16 07:00:00",
    endTime: "2026-07-16 07:00:30",
    cuteTimeline: [timelinePoint(10, 0.99), timelinePoint(12, 0.95)],
  }));

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.equal(result[0].clipId, "overlap");
  assert.equal(result[0].startTime, "2026-07-16 07:00:08");
  assert.equal(result[0].endTime, "2026-07-16 07:00:13");
});

test("timeline quick cut counts an overlapping absolute window from two recordings only once", () => {
  const diary = {
    clips: [
      timelineRecording("overlap-high", 7, 0.99),
      timelineRecording("overlap-low", 7, 0.98),
      timelineRecording("unique-1", 8, 0.9),
      timelineRecording("unique-2", 9, 0.89),
      timelineRecording("unique-3", 10, 0.88),
    ],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.deepEqual(result.map((item) => item.clipId), [
    "overlap-high",
    "unique-1",
    "unique-2",
    "unique-3",
  ]);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 20);
});

test("cross-recording overlap is counted once when qualified material is short", () => {
  const diary = {
    clips: [
      timelineRecording("overlap-high", 7, 0.99),
      timelineRecording("overlap-low", 7, 0.98),
      timelineRecording("unique-1", 8, 0.9),
      timelineRecording("unique-2", 9, 0.89),
    ],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.deepEqual(result.map((item) => item.clipId), ["overlap-high", "unique-1", "unique-2"]);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 15);
});

test("timeline quick cut keeps non-overlapping windows from different recordings", () => {
  const diary = {
    clips: [
      timelineRecording("recording-1", 7, 0.99),
      timelineRecording("recording-2", 8, 0.98),
      timelineRecording("recording-3", 9, 0.97),
      timelineRecording("recording-4", 10, 0.96),
    ],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.deepEqual(result.map((item) => item.clipId), [
    "recording-1",
    "recording-2",
    "recording-3",
    "recording-4",
  ]);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 20);
});

test("timeline quick cut anchors a candidate to the peak instead of an earlier lower sample", () => {
  const diary = timelineDiary([0.9, 0.89, 0.88]);
  diary.clips.unshift(feedingClip({
    id: "peak-anchor",
    feedingStart: "2026-07-16 07:00:00",
    feedingEnd: "2026-07-16 07:00:30",
    beginTime: "2026-07-16 07:00:00",
    endTime: "2026-07-16 07:00:30",
    cuteTimeline: [timelinePoint(10, 0.75), timelinePoint(12, 0.99)],
  }));

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.equal(result[0].clipId, "peak-anchor");
  assert.equal(result[0].startTime, "2026-07-16 07:00:10");
  assert.equal(result[0].endTime, "2026-07-16 07:00:15");
  assert.equal(result[0].cuteScore, 0.99);
});

test("timeline quick cut attributes a valid feeding-end window to its actual highest peak", () => {
  const diary = timelineDiary([0.905, 0.904, 0.903, 0.902]);
  diary.clips.unshift(feedingClip({
    id: "feeding-end-peak",
    beginTime: "2026-07-16 07:00:00",
    endTime: "2026-07-16 07:00:20",
    feedingStart: "2026-07-16 07:00:00",
    feedingEnd: "2026-07-16 07:00:20",
    cuteTimeline: [
      timelinePoint(12.5, 0.75),
      timelinePoint(15.5, 0.9),
      timelinePoint(18.5, 0.99),
    ],
  }));

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.deepEqual(result.map((item) => item.clipId), [
    "feeding-end-peak",
    "timeline-0",
    "timeline-1",
    "timeline-2",
  ]);
  assert.equal(result[0].startTime, "2026-07-16 07:00:13.500");
  assert.equal(result[0].endTime, "2026-07-16 07:00:18.500");
  assert.equal(result[0].cuteScore, 0.99);
});

test("timeline quick cut splits a continuous two-fps cute region into multiple candidates", () => {
  const diary = {
    clips: [feedingClip({
      beginTime: "2026-07-16 08:00:00",
      endTime: "2026-07-16 08:00:30",
      feedingStart: "2026-07-16 08:00:00",
      feedingEnd: "2026-07-16 08:00:30",
      cuteTimeline: Array.from(
        { length: 41 },
        (_, index) => timelinePoint(5 + index * 0.5, 0.9, 0.9)
      ),
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });
  const totalDurationSec = result.reduce((sum, item) => sum + item.durationSec, 0);

  assert.ok(totalDurationSec >= 16);
  assert.ok(totalDurationSec <= 20);
  assert.ok(result.every((item) => item.durationSec >= 4));
});

test("timeline quick cut bridges at most one second and leaves wider gaps separate", () => {
  const diary = {
    clips: [feedingClip({
      feedingStart: "2026-07-16 08:00:00",
      feedingEnd: "2026-07-16 08:00:40",
      cuteTimeline: [
        timelinePoint(10, 0.99),
        timelinePoint(16, 0.98),
        timelinePoint(23, 0.97),
        timelinePoint(31, 0.96),
      ],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.deepEqual(result.map((item) => [item.startTime, item.endTime]), [
    ["2026-07-16 08:00:08", "2026-07-16 08:00:19"],
    ["2026-07-16 08:00:21", "2026-07-16 08:00:26"],
    ["2026-07-16 08:00:29", "2026-07-16 08:00:33"],
  ]);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 20);
});

test("timeline quick cut clips to feeding bounds, accepts four seconds, and rejects shorter fragments", () => {
  const diary = timelineDiary([0.95, 0.94, 0.93]);
  diary.clips.unshift(feedingClip({
    id: "bounded",
    beginTime: "2026-07-16 07:00:00",
    endTime: "2026-07-16 07:00:20",
    feedingStart: "2026-07-16 07:00:05",
    feedingEnd: "2026-07-16 07:00:20",
    cuteTimeline: [timelinePoint(6, 0.99), timelinePoint(19, 0.98)],
  }));

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.deepEqual([result[0].startTime, result[0].endTime, result[0].durationSec], [
    "2026-07-16 07:00:05",
    "2026-07-16 07:00:09",
    4,
  ]);
  assert.ok(result.every((item) => item.endTime !== "2026-07-16 07:00:20"));
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 19);
});

test("timeline quick cut preserves half-second playback boundaries", () => {
  const diary = timelineDiary([0.95, 0.94, 0.93]);
  diary.clips.unshift(feedingClip({
    id: "half-second-boundary",
    beginTime: "2026-07-16 07:00:00",
    endTime: "2026-07-16 07:00:20",
    feedingStart: "2026-07-16 07:00:05.500",
    feedingEnd: "2026-07-16 07:00:20",
    cuteTimeline: [timelinePoint(7, 0.99)],
  }));

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });
  const segment = result[0];

  assert.equal(segment.startTime, "2026-07-16 07:00:05.500");
  assert.equal(segment.endTime, "2026-07-16 07:00:10");
  assert.equal(segment.durationSec, 4.5);
  assert.equal(segment.playbackParams.startTime, segment.startTime);
  assert.equal(segment.playbackParams.endTime, segment.endTime);
  assert.equal((parseLocalTime(segment.endTime) - parseLocalTime(segment.startTime)) / 1000, 4.5);
});

test("timeline quick cut gates score, confidence, cat presence, and feeding membership", () => {
  const diary = timelineDiary([0.9, 0.89, 0.88]);
  diary.clips.unshift(feedingClip({
    id: "gates",
    beginTime: "2026-07-16 07:00:00",
    endTime: "2026-07-16 07:01:20",
    feedingStart: "2026-07-16 07:00:10",
    feedingEnd: "2026-07-16 07:01:10",
    cuteTimeline: [
      timelinePoint(20, 0.75, 0.65),
      timelinePoint(35, 0.749, 0.99),
      timelinePoint(50, 0.99, 0.649),
      timelinePoint(65, 0.99, 0.99, { hasCat: false }),
      timelinePoint(5, 0.99, 0.99),
    ],
  }));

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.equal(result.filter((item) => item.clipId === "gates").length, 1);
  assert.equal(result[0].cuteScore, 0.75);
  assert.equal(result[0].modelConfidence, 0.65);
});

test("timeline quick cut trims the last ranked candidate without creating a sub-four-second fragment", () => {
  const diary = {
    clips: [feedingClip({
      feedingStart: "2026-07-16 08:00:00",
      feedingEnd: "2026-07-16 08:00:50",
      cuteTimeline: [
        timelinePoint(10, 0.99),
        timelinePoint(16, 0.98),
        timelinePoint(25, 0.97),
        timelinePoint(35, 0.96),
      ],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.deepEqual(result.map((item) => item.durationSec), [11, 5, 4]);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 20);
});

test("timeline quick cut stops when the remainder is shorter than four seconds", () => {
  const diary = {
    clips: [feedingClip({
      feedingStart: "2026-07-16 08:00:00",
      feedingEnd: "2026-07-16 08:00:50",
      cuteTimeline: [
        timelinePoint(10, 0.99),
        timelinePoint(16, 0.98),
        timelinePoint(22, 0.97),
        timelinePoint(35, 0.96),
      ],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.equal(result.length, 1);
  assert.equal(result[0].durationSec, 17);
});

test("timeline quick cut returns short qualified material without low-score padding", () => {
  const diary = timelineDiary([0.99, 0.9, 0.8, 0.749, 0.7, 0.6]);

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 30 });

  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 15);
  assert.deepEqual(result.map((item) => item.cuteScore), [0.99, 0.9, 0.8]);
});

test("legacy marker-only quick cut retains its compatibility selection with a target", () => {
  const diary = {
    clips: [feedingClip({
      cute: [marker("cute_front", "2026-07-16 08:00:15", 0.9)],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 120 });

  assert.equal(result.length, 1);
  assert.equal(result[0].durationSec, 5);
});

test("legacy marker-only quick cut caps qualified material at 180 seconds", () => {
  const clips = Array.from({ length: 50 }, (_, index) => {
    const totalSeconds = index * 10;
    const minute = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const second = String(totalSeconds % 60).padStart(2, "0");
    return feedingClip({
      id: `legacy-${index}`,
      beginTime: `2026-07-16 08:${minute}:${second}`,
      endTime: `2026-07-16 08:${minute}:${String((totalSeconds % 60) + 6).padStart(2, "0")}`,
      feedingStart: `2026-07-16 08:${minute}:${second}`,
      feedingEnd: `2026-07-16 08:${minute}:${String((totalSeconds % 60) + 6).padStart(2, "0")}`,
      cute: [marker("cute_front", `2026-07-16 08:${minute}:${String((totalSeconds % 60) + 3).padStart(2, "0")}`, 0.9)],
    });
  });

  const result = selectFoodcastSegments({ diary: { clips, meals: [] }, mode: "quick_cut", targetDurationSec: 180 });

  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 180);
});

test("timeline quick cut includes marker fallback candidates from mixed legacy clips", () => {
  const diary = timelineDiary([0.9, 0.89, 0.88]);
  diary.clips.push(feedingClip({
    id: "legacy",
    beginTime: "2026-07-16 09:00:00",
    endTime: "2026-07-16 09:00:30",
    feedingStart: "2026-07-16 09:00:00",
    feedingEnd: "2026-07-16 09:00:30",
    cute: [marker("cute_head_up", "2026-07-16 09:00:10", 0.95)],
  }));

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 20 });

  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 20);
  assert.ok(result.some((item) => item.clipId === "legacy"));
});

test("quick cut treats an empty normalized timeline as legacy marker-only data", () => {
  const diary = {
    clips: [feedingClip({
      cuteTimeline: [],
      cute: [marker("cute_head_up", "2026-07-16 08:00:10", 0.95)],
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 120 });

  assert.equal(result.length, 1);
  assert.equal(result[0].durationSec, 5);
  assert.deepEqual(result[0].markerTypes, ["cute_head_up"]);
});

test("timeline quick cut scales near-linearly for an hour of two-fps samples", () => {
  function measure(sampleCount, endTime) {
    const diary = {
      clips: [feedingClip({
        beginTime: "2026-07-16 08:00:00",
        endTime,
        feedingStart: "2026-07-16 08:00:00",
        feedingEnd: endTime,
        cuteTimeline: Array.from(
          { length: sampleCount },
          (_, index) => timelinePoint(index * 0.5, 0.9, 0.9)
        ),
      })],
      meals: [],
    };
    const startedAt = performance.now();
    const result = selectFoodcastSegments({ diary, mode: "quick_cut", targetDurationSec: 120 });
    assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 120);
    return performance.now() - startedAt;
  }

  measure(300, "2026-07-16 08:02:30");
  const shortElapsedMs = measure(900, "2026-07-16 08:07:30");
  const hourElapsedMs = measure(7200, "2026-07-16 09:00:00");

  assert.ok(
    hourElapsedMs < shortElapsedMs * 16 + 100,
    `expected near-linear scaling, short=${shortElapsedMs.toFixed(1)}ms hour=${hourElapsedMs.toFixed(1)}ms`
  );
});

test("natural mode keeps feeding intervals chronological and caps at 420 seconds", () => {
  const diary = {
    clips: [
      feedingClip({
        id: "later",
        beginTime: "2026-07-16 08:05:00",
        endTime: "2026-07-16 08:10:00",
        feedingStart: "2026-07-16 08:05:00",
        feedingEnd: "2026-07-16 08:10:00",
      }),
      feedingClip({
        id: "earlier",
        beginTime: "2026-07-16 08:00:00",
        endTime: "2026-07-16 08:05:00",
        feedingStart: "2026-07-16 08:00:00",
        feedingEnd: "2026-07-16 08:05:00",
      }),
    ],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "natural", targetDurationSec: 420 });

  assert.deepEqual(result.map((item) => item.clipId), ["earlier", "later"]);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 420);
  assert.equal(result[1].durationSec, 120);
});

test("natural mode returns all real feeding time when it is shorter than 420 seconds", () => {
  const diary = {
    clips: [feedingClip({
      beginTime: "2026-07-16 08:00:00",
      endTime: "2026-07-16 08:02:00",
      feedingStart: "2026-07-16 08:00:00",
      feedingEnd: "2026-07-16 08:02:00",
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "natural", targetDurationSec: 420 });

  assert.equal(result.length, 1);
  assert.equal(result[0].durationSec, 120);
});

test("natural mode does not count overlapping recordings twice", () => {
  const diary = {
    clips: ["overlap-a", "overlap-b"].map((id) => feedingClip({
      id,
      beginTime: "2026-07-16 08:00:00",
      endTime: "2026-07-16 08:05:00",
      feedingStart: "2026-07-16 08:00:00",
      feedingEnd: "2026-07-16 08:05:00",
    })),
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "natural", targetDurationSec: 420 });

  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 300);
  assert.equal(result.length, 1);
});

test("natural mode limits pathological fragmentation to 24 render segments", () => {
  const markers = [];
  for (let index = 0; index < 210; index += 1) {
    const start = new Date(2026, 6, 16, 8, 0, index * 4);
    const end = new Date(start.getTime() + 2000);
    const format = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")} ${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}:${String(value.getSeconds()).padStart(2, "0")}`;
    markers.push(marker("feeding_start", format(start)), marker("feeding_end", format(end)));
  }
  const diary = {
    clips: [clip({
      id: "fragmented",
      beginTime: "2026-07-16 08:00:00",
      endTime: "2026-07-16 08:14:00",
      markers,
    })],
    meals: [],
  };

  const result = selectFoodcastSegments({ diary, mode: "natural", targetDurationSec: 420 });

  assert.equal(result.length, 24);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 48);
});

test("natural mode still merges into the final slot after reaching 24 render segments", () => {
  const formatAt = (totalSeconds) => {
    const value = new Date(2026, 6, 16, 8, 0, totalSeconds);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")} ${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}:${String(value.getSeconds()).padStart(2, "0")}`;
  };
  const clips = Array.from({ length: 23 }, (_, index) => feedingClip({
    id: `fragment-${index}`,
    beginTime: formatAt(index * 10),
    endTime: formatAt(index * 10 + 2),
    feedingStart: formatAt(index * 10),
    feedingEnd: formatAt(index * 10 + 2),
  }));
  clips.push(clip({
    id: "final-source",
    beginTime: formatAt(600),
    endTime: formatAt(621),
    markers: [
      marker("feeding_start", formatAt(600)),
      marker("feeding_end", formatAt(610)),
      marker("feeding_start", formatAt(611)),
      marker("feeding_end", formatAt(621)),
    ],
  }));

  const result = selectFoodcastSegments({ diary: { clips, meals: [] }, mode: "natural", targetDurationSec: 420 });

  assert.equal(result.length, 24);
  assert.equal(result.reduce((sum, item) => sum + item.durationSec, 0), 67);
  assert.equal(result[23].durationSec, 21);
});
