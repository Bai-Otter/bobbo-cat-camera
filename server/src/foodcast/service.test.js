const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BgmLibrary } = require("./bgmLibrary");
const { FoodcastService, normalizeRequest } = require("./service");
const { FoodcastStore } = require("./store");

function feedingDiary() {
  return {
    deviceSn: "SN-1",
    date: "2026-07-16",
    clips: [
      {
        id: "clip-a",
        beginTime: "2026-07-16 08:00:00",
        endTime: "2026-07-16 08:00:30",
        analysisConfidence: 0.9,
        playbackParams: { fileName: "clip-a.mp4" },
        markers: [
          { markerType: "feeding_start", beginTime: "2026-07-16 08:00:05" },
          { markerType: "feeding_end", beginTime: "2026-07-16 08:00:20" },
        ],
      },
    ],
    meals: [],
  };
}

function timelineDiary(candidateCount = 12) {
  return {
    deviceSn: "SN-1",
    date: "2026-07-16",
    clips: Array.from({ length: candidateCount }, (_, index) => {
      const minute = String(index).padStart(2, "0");
      return {
        id: `timeline-${index}`,
        beginTime: `2026-07-16 08:${minute}:00`,
        endTime: `2026-07-16 08:${minute}:10`,
        analysisConfidence: 0.9,
        playbackParams: { fileName: `timeline-${index}.mp4` },
        markers: [
          { markerType: "feeding_start", beginTime: `2026-07-16 08:${minute}:00` },
          { markerType: "feeding_end", beginTime: `2026-07-16 08:${minute}:10` },
        ],
        cuteTimeline: [{
          offsetSec: 5,
          cuteScore: 0.99 - index / 1000,
          modelConfidence: 0.9,
          cuteReasons: ["head_up"],
          hasCat: true,
        }],
      };
    }),
    meals: [],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-service-"));
  const store = new FoodcastStore(path.join(dir, "foodcasts.sqlite"));
  let sequence = 0;
  const service = new FoodcastService({
    store,
    outputDir: path.join(dir, "outputs"),
    retentionMs: 10_000,
    maxStorageBytes: 10_000,
    maxRetries: 2,
    retryDelayMs: 0,
    idFactory: () => `job-${++sequence}`,
    tokenFactory: () => `token-${sequence}`,
    now: () => 1000,
    getDiary: () => feedingDiary(),
    bgmLibrary: {
      pick: () => ({ id: "cute-1", title: "Cute One", artist: "Artist", filePath: path.join(dir, "cute.mp3") }),
      get: (id) => ({ id, title: "Selected", artist: "Artist", filePath: path.join(dir, `${id}.mp3`) }),
    },
    renderer: {
      render: async ({ outputPath, segments }) => {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "video");
        return { durationSec: segments.reduce((sum, item) => sum + item.durationSec, 0), outputSize: 5 };
      },
    },
    resolveSource: async () => "https://camera.test/replay.m3u8",
    ...overrides,
  });
  return { dir, store, service };
}

test("FoodcastService creates and completes an asynchronous render job", async () => {
  const { service } = makeService();

  const created = await service.createFoodcast({ deviceSn: "SN-1", date: "2026-07-16", scope: "day" });
  await service.waitForIdle();
  const ready = service.getJob(created.id);

  assert.equal(created.status, "queued");
  assert.equal(ready.status, "ready");
  assert.equal(ready.progress, 100);
  assert.equal(ready.bgm.id, "cute-1");
  assert.equal(ready.segments.length, 1);
  assert.equal(fs.existsSync(ready.outputPath), true);
});

test("FoodcastService natural mode renders the chronological feeding interval", async () => {
  let renderedSegments = [];
  const diary = feedingDiary();
  diary.clips[0].markers.splice(1, 0, {
    markerType: "cute_front",
    beginTime: "2026-07-16 08:00:07",
    confidence: 0.94,
  });
  const renderer = {
    render: async ({ outputPath, segments }) => {
      renderedSegments = segments;
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "video");
      return { durationSec: 7, outputSize: 5 };
    },
  };
  const { service } = makeService({ getDiary: () => diary, renderer });

  await service.createFoodcast({ deviceSn: "SN-1", date: "2026-07-16", scope: "day" });
  await service.waitForIdle();

  assert.equal(renderedSegments.length, 1);
  assert.equal(renderedSegments[0].startTime, "2026-07-16 08:00:05");
  assert.equal(renderedSegments[0].endTime, "2026-07-16 08:00:12");
  assert.deepEqual(renderedSegments[0].markerTypes, ["cute_front"]);
});

test("FoodcastService natural mode keeps chronological feeding intervals within sixty seconds", async () => {
  let renderedSegments = [];
  const clips = [0, 1, 2].map((index) => {
    const hour = String(8 + index).padStart(2, "0");
    return {
      id: `clip-${index}`,
      beginTime: `2026-07-16 ${hour}:00:00`,
      endTime: `2026-07-16 ${hour}:01:00`,
      analysisConfidence: 0.7 + index / 10,
      playbackParams: { fileName: `clip-${index}.mp4` },
      markers: [
        { markerType: "feeding_start", beginTime: `2026-07-16 ${hour}:00:05` },
        { markerType: "feeding_end", beginTime: `2026-07-16 ${hour}:00:25` },
      ],
    };
  });
  const renderer = {
    render: async ({ outputPath, segments }) => {
      renderedSegments = segments;
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "video");
      return { durationSec: 20, outputSize: 5 };
    },
  };
  const { service } = makeService({ getDiary: () => ({ clips, meals: [] }), renderer });

  await service.createFoodcast({ deviceSn: "SN-1", date: "2026-07-16", scope: "day" });
  await service.waitForIdle();

  assert.equal(renderedSegments.length, 1);
  assert.equal(renderedSegments.reduce((sum, item) => sum + item.durationSec, 0), 20);
  assert.deepEqual(renderedSegments.map((item) => item.markerTypes), [[]]);
});

test("FoodcastService returns an active matching job instead of queueing a duplicate", async () => {
  let finishRender;
  const renderer = {
    render: () => new Promise((resolve) => {
      finishRender = () => resolve({ durationSec: 10, outputSize: 5 });
    }),
  };
  const { service } = makeService({ renderer });

  const first = await service.createFoodcast({ deviceSn: "SN-1", date: "2026-07-16", scope: "day" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await service.createFoodcast({ deviceSn: "SN-1", date: "2026-07-16", scope: "day" });

  assert.equal(second.id, first.id);
  finishRender();
  await service.waitForIdle();
});

test("FoodcastService retries two transient render failures before succeeding", async () => {
  let attempts = 0;
  const renderer = {
    render: async ({ outputPath }) => {
      attempts += 1;
      if (attempts < 3) throw new Error("camera busy");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "video");
      return { durationSec: 10, outputSize: 5 };
    },
  };
  const { service } = makeService({ renderer });

  const created = await service.createFoodcast({ deviceSn: "SN-1", date: "2026-07-16", scope: "day" });
  await service.waitForIdle();

  assert.equal(attempts, 3);
  assert.equal(service.getJob(created.id).status, "ready");
  assert.equal(service.getJob(created.id).attempts, 3);
});

test("FoodcastService does not retry an unavailable recording", async () => {
  let attempts = 0;
  const renderer = {
    render: async () => {
      attempts += 1;
      throw Object.assign(new Error("No video recording"), {
        code: "RECORDING_UNAVAILABLE",
      });
    },
  };
  const { service } = makeService({ renderer });

  const created = await service.createFoodcast({ deviceSn: "SN-1", date: "2026-07-16", scope: "day" });
  await service.waitForIdle();
  const failed = service.getJob(created.id);

  assert.equal(attempts, 1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "RECORDING_UNAVAILABLE");
});

test("FoodcastService rejects empty feeding selections and an empty BGM library", async () => {
  const noFeeding = makeService({ getDiary: () => ({ clips: [], meals: [] }) }).service;
  await assert.rejects(
    noFeeding.createFoodcast({ deviceSn: "SN-1", date: "2026-07-16", scope: "day" }),
    { code: "NO_FEEDING_SEGMENTS" }
  );

  const noBgm = makeService({ bgmLibrary: { pick: () => { throw new Error("BGM_LIBRARY_EMPTY"); } } }).service;
  await assert.rejects(
    noBgm.createFoodcast({ deviceSn: "SN-1", date: "2026-07-16", scope: "day" }),
    { code: "BGM_LIBRARY_EMPTY" }
  );
});

test("FoodcastService uses mutually exclusive random and explicit BGM lookups", async () => {
  const calls = [];
  const rendered = [];
  const randomTrack = { id: "bgm-02", title: "Random", filePath: "D:/music/random.mp3" };
  const selectedTrack = { id: "bgm-01", title: "Selected", filePath: "D:/music/selected.mp3" };
  const { service } = makeService({
    bgmLibrary: {
      pick(options) {
        calls.push(["pick", options]);
        return randomTrack;
      },
      get(id) {
        calls.push(["get", id]);
        return id === selectedTrack.id ? selectedTrack : null;
      },
    },
    renderer: {
      render: async ({ bgm }) => {
        rendered.push(bgm);
        return { durationSec: 15, outputSize: 5 };
      },
    },
  });

  const randomJob = await service.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", bgmId: "random",
  });
  const selectedJob = await service.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", bgmId: "bgm-01",
  });
  await service.waitForIdle();

  assert.deepEqual(calls, [
    ["pick", { previousId: "" }],
    ["get", "bgm-01"],
  ]);
  assert.equal(randomJob.bgmSelection, "random");
  assert.equal(selectedJob.bgmSelection, "bgm-01");
  assert.equal(service.getJob(selectedJob.id).bgm.id, "bgm-01");
  assert.equal(service.getPublicJob(selectedJob.id).bgmSelection, "bgm-01");
  assert.equal(service.getLatest({
    deviceSn: "SN-1", date: "2026-07-16", bgmId: "bgm-01",
  }).id, selectedJob.id);
  assert.ok(rendered.some((bgm) => bgm.id === "bgm-01"));
});

test("FoodcastService renders a safe custom manifest BGM selected by ID", async () => {
  const bgmDir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-custom-bgm-"));
  fs.writeFileSync(path.join(bgmDir, "cute.mp3"), "music");
  fs.writeFileSync(path.join(bgmDir, "library.json"), JSON.stringify({
    tracks: [{ id: "cute-1", title: "Cute One", artist: "Artist", file: "cute.mp3" }],
  }));
  const rendered = [];
  const { service } = makeService({
    bgmLibrary: new BgmLibrary({ dir: bgmDir }),
    renderer: {
      render: async ({ bgm }) => {
        rendered.push(bgm);
        return { durationSec: 15, outputSize: 5 };
      },
    },
  });

  assert.equal(normalizeRequest({
    deviceSn: "SN-1", date: "2026-07-16", bgmId: "cute-1",
  }).bgmSelection, "cute-1");

  const job = await service.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", bgmId: "cute-1",
  });
  await service.waitForIdle();

  assert.equal(job.bgmSelection, "cute-1");
  assert.deepEqual(rendered.map((bgm) => bgm.id), ["cute-1"]);
});

test("FoodcastService rejects missing explicit BGM before creating or enqueueing a job", async () => {
  let createCalls = 0;
  let enqueueCalls = 0;
  let pickCalls = 0;
  const requestedIds = [];
  const { service, store } = makeService({
    bgmLibrary: {
      pick() {
        pickCalls += 1;
        return { id: "bgm-fallback" };
      },
      get(id) {
        requestedIds.push(id);
        return null;
      },
    },
  });
  const createJob = store.createJob.bind(store);
  store.createJob = (input) => {
    createCalls += 1;
    return createJob(input);
  };
  service.enqueue = () => {
    enqueueCalls += 1;
  };

  await assert.rejects(
    service.createFoodcast({
      deviceSn: "SN-1", date: "2026-07-16", bgmId: "cute-missing",
    }),
    { code: "BGM_NOT_FOUND" }
  );

  assert.deepEqual(requestedIds, ["cute-missing"]);
  assert.equal(pickCalls, 0);
  assert.equal(createCalls, 0);
  assert.equal(enqueueCalls, 0);
});

test("FoodcastService creates isolated quick-cut jobs and reports missing cute highlights", async () => {
  const cuteDiary = feedingDiary();
  cuteDiary.clips[0].markers.splice(1, 0, {
    markerType: "cute_profile_left",
    beginTime: "2026-07-16 08:00:10",
    confidence: 0.95,
  });
  const { service, store } = makeService({ getDiary: () => cuteDiary });

  const natural = await service.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", scope: "day", mode: "natural",
  });
  const quick = await service.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", scope: "day", mode: "quick_cut", frameMode: "center_crop",
  });

  assert.notEqual(natural.id, quick.id);
  assert.equal(store.getJob(natural.id).targetDurationSec, 60);
  assert.equal(store.getJob(quick.id).mode, "quick_cut");
  assert.equal(store.getJob(quick.id).frameMode, "center_crop");
  assert.equal(store.getJob(quick.id).targetDurationSec, 60);
  assert.equal(service.getPublicJob(quick.id).mode, "quick_cut");
  assert.equal(service.getPublicJob(quick.id).frameMode, "center_crop");
  assert.equal(service.getPublicJob(quick.id).targetDurationSec, 60);

  const noHighlights = makeService().service;
  await assert.rejects(
    noHighlights.createFoodcast({
      deviceSn: "SN-1", date: "2026-07-16", scope: "day", mode: "quick_cut",
    }),
    { code: "NO_CUTE_HIGHLIGHTS" }
  );
});

test("normalizeRequest fixes target duration from the editing mode", () => {
  assert.equal(normalizeRequest({ deviceSn: "SN-1", date: "2026-07-16", mode: "quick_cut" }).targetDurationSec, 60);
  assert.equal(normalizeRequest({ deviceSn: "SN-1", date: "2026-07-16", mode: "natural" }).targetDurationSec, 60);
});

test("normalizeRequest ignores caller durations that conflict with the mode preset", () => {
  const base = { deviceSn: "SN-1", date: "2026-07-16" };
  for (const targetDurationSec of [undefined, null, "", 20, 60, 120, 180, 420, 999, "invalid"]) {
    assert.equal(normalizeRequest({ ...base, mode: "quick_cut", targetDurationSec }).targetDurationSec, 60);
    assert.equal(normalizeRequest({ ...base, mode: "natural", targetDurationSec }).targetDurationSec, 60);
  }
});

test("normalizeRequest defaults empty music selections to random and accepts safe manifest IDs", () => {
  const base = { deviceSn: "SN-1", date: "2026-07-16" };

  for (const bgmId of [undefined, null, ""]) {
    assert.equal(normalizeRequest({ ...base, bgmId }).bgmSelection, "random");
  }
  for (const bgmId of [
    "random",
    "a",
    "cute-1",
    "BGM.Cat_Track-9",
    `a${"b".repeat(79)}`,
  ]) {
    assert.equal(normalizeRequest({ ...base, bgmId }).bgmSelection, bgmId);
  }
});

test("normalizeRequest rejects unsafe music selections", () => {
  const base = { deviceSn: "SN-1", date: "2026-07-16" };
  const invalidBgmIds = [
    " ",
    " bgm-01",
    "bgm-01 ",
    "bgm-cat track",
    "bgm-cat\ttrack",
    "../bgm-01",
    "bgm/01",
    "bgm\\01",
    "%2e%2e%2fbgm-01",
    "bgm%2F01",
    ".bgm-01",
    `a${"b".repeat(80)}`,
    {},
    [],
    1,
  ];

  for (const bgmId of invalidBgmIds) {
    assert.throws(
      () => normalizeRequest({ ...base, bgmId }),
      { code: "INVALID_FOODCAST_REQUEST" }
    );
  }
});

test("FoodcastService coalesces caller durations into the quick-cut mode preset", async () => {
  const { service } = makeService({ getDiary: () => timelineDiary() });

  const short = await service.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", mode: "quick_cut", targetDurationSec: 20,
  });
  const standard = await service.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", mode: "quick_cut", targetDurationSec: 60,
  });

  assert.equal(short.id, standard.id);
  assert.equal(short.targetDurationSec, 60);
  assert.equal(standard.targetDurationSec, 60);
  assert.equal(service.getLatest({
    deviceSn: "SN-1", date: "2026-07-16", mode: "quick_cut", targetDurationSec: 20,
  }).id, short.id);
  assert.equal(service.getLatest({
    deviceSn: "SN-1", date: "2026-07-16", mode: "quick_cut", targetDurationSec: 60,
  }).id, short.id);
  assert.equal(service.getPublicJob(short.id).targetDurationSec, 60);
  await service.waitForIdle();
});

test("FoodcastService coalesces concurrent requests with the same generation key", async () => {
  const pendingDiary = deferred();
  let diaryCalls = 0;
  let renderCalls = 0;
  const { service } = makeService({
    getDiary: () => {
      diaryCalls += 1;
      return pendingDiary.promise;
    },
    renderer: {
      render: async () => {
        renderCalls += 1;
        return { durationSec: 20, outputSize: 5 };
      },
    },
    bgmLibrary: {
      pick: () => { throw new Error("random lookup should not run"); },
      get: (id) => ({ id, title: "Selected", filePath: `D:/music/${id}.mp3` }),
    },
  });
  const request = {
    deviceSn: "SN-1", date: "2026-07-16", mode: "quick_cut", targetDurationSec: 20,
    bgmId: "bgm-01",
  };

  const firstPromise = service.createFoodcast(request);
  const secondPromise = service.createFoodcast(request);
  pendingDiary.resolve(timelineDiary(4));
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  await service.waitForIdle();

  assert.equal(diaryCalls, 1);
  assert.equal(first.id, second.id);
  assert.equal(renderCalls, 1);
});

test("FoodcastService keeps concurrent random and explicit BGM selections independent", async () => {
  const pendingDiary = deferred();
  let diaryCalls = 0;
  const lookupCalls = [];
  const { service } = makeService({
    getDiary: () => {
      diaryCalls += 1;
      return pendingDiary.promise;
    },
    bgmLibrary: {
      pick(options) {
        lookupCalls.push(["pick", options]);
        return { id: "bgm-02", title: "Random", filePath: "D:/music/random.mp3" };
      },
      get(id) {
        lookupCalls.push(["get", id]);
        return { id, title: "Selected", filePath: `D:/music/${id}.mp3` };
      },
    },
  });
  const base = { deviceSn: "SN-1", date: "2026-07-16" };

  const randomPromise = service.createFoodcast({ ...base, bgmId: "random" });
  const selectedPromise = service.createFoodcast({ ...base, bgmId: "bgm-01" });
  pendingDiary.resolve(feedingDiary());
  const [randomJob, selectedJob] = await Promise.all([randomPromise, selectedPromise]);
  await service.waitForIdle();

  assert.equal(diaryCalls, 2);
  assert.notEqual(randomJob.id, selectedJob.id);
  assert.equal(randomJob.bgmSelection, "random");
  assert.equal(selectedJob.bgmSelection, "bgm-01");
  assert.deepEqual(lookupCalls, [
    ["pick", { previousId: "" }],
    ["get", "bgm-01"],
  ]);
});

test("FoodcastService coalesces concurrent caller durations into one quick-cut job", async () => {
  const pendingDiary = deferred();
  let diaryCalls = 0;
  let renderCalls = 0;
  const { service } = makeService({
    getDiary: () => {
      diaryCalls += 1;
      return pendingDiary.promise;
    },
    renderer: {
      render: async ({ segments }) => {
        renderCalls += 1;
        return {
          durationSec: segments.reduce((sum, segment) => sum + segment.durationSec, 0),
          outputSize: 5,
        };
      },
    },
  });

  const shortPromise = service.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", mode: "quick_cut", targetDurationSec: 20,
  });
  const standardPromise = service.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", mode: "quick_cut", targetDurationSec: 60,
  });
  pendingDiary.resolve(timelineDiary());
  const [short, standard] = await Promise.all([shortPromise, standardPromise]);
  await service.waitForIdle();

  assert.equal(diaryCalls, 1);
  assert.equal(short.id, standard.id);
  assert.equal(short.targetDurationSec, 60);
  assert.equal(standard.targetDurationSec, 60);
  assert.equal(renderCalls, 1);
});

test("FoodcastService releases a generation key after concurrent creation fails", async () => {
  const failingDiary = deferred();
  let shouldFail = true;
  let diaryCalls = 0;
  const { service } = makeService({
    getDiary: () => {
      diaryCalls += 1;
      return shouldFail ? failingDiary.promise : timelineDiary(4);
    },
  });
  const request = {
    deviceSn: "SN-1", date: "2026-07-16", mode: "quick_cut", targetDurationSec: 20,
    bgmId: "bgm-01",
  };

  const firstPromise = service.createFoodcast(request);
  const secondPromise = service.createFoodcast(request);
  failingDiary.reject(new Error("diary unavailable"));
  await Promise.all([
    assert.rejects(firstPromise, /diary unavailable/),
    assert.rejects(secondPromise, /diary unavailable/),
  ]);

  shouldFail = false;
  const recovered = await service.createFoodcast(request);
  await service.waitForIdle();

  assert.equal(diaryCalls, 2);
  assert.equal(recovered.targetDurationSec, 60);
  assert.equal(recovered.bgmSelection, "bgm-01");
});

test("FoodcastService ignores caller duration for the natural mode preset", async () => {
  const longDiary = {
    clips: [
      {
        id: "natural-a",
        beginTime: "2026-07-16 08:00:00",
        endTime: "2026-07-16 08:05:00",
        playbackParams: { fileName: "natural-a.mp4" },
        markers: [
          { markerType: "feeding_start", beginTime: "2026-07-16 08:00:00" },
          { markerType: "feeding_end", beginTime: "2026-07-16 08:05:00" },
        ],
      },
      {
        id: "natural-b",
        beginTime: "2026-07-16 08:05:00",
        endTime: "2026-07-16 08:10:00",
        playbackParams: { fileName: "natural-b.mp4" },
        markers: [
          { markerType: "feeding_start", beginTime: "2026-07-16 08:05:00" },
          { markerType: "feeding_end", beginTime: "2026-07-16 08:10:00" },
        ],
      },
    ],
    meals: [],
  };
  const defaultService = makeService({ getDiary: () => longDiary }).service;
  const targetedService = makeService({ getDiary: () => longDiary }).service;

  const defaultJob = await defaultService.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", mode: "natural",
  });
  const targetedJob = await targetedService.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", mode: "natural", targetDurationSec: 20,
  });

  assert.deepEqual(targetedJob.segments, defaultJob.segments);
  assert.deepEqual(defaultJob.segments.map((item) => item.clipId), ["natural-a"]);
  assert.equal(defaultJob.segments.reduce((sum, item) => sum + item.durationSec, 0), 20);
  assert.equal(defaultJob.segments[0].durationSec, 20);
  assert.equal(defaultJob.targetDurationSec, 60);
  assert.equal(targetedJob.targetDurationSec, 60);
  await Promise.all([defaultService.waitForIdle(), targetedService.waitForIdle()]);
});

test("FoodcastService preserves NO_CUTE_MATERIAL from duration-aware selection", async () => {
  const diary = timelineDiary(1);
  diary.clips[0].cuteTimeline[0].cuteScore = 0.1;
  const { service } = makeService({ getDiary: () => diary });

  await assert.rejects(
    service.createFoodcast({
      deviceSn: "SN-1", date: "2026-07-16", mode: "quick_cut", targetDurationSec: 20,
    }),
    { code: "NO_CUTE_MATERIAL" }
  );
});

test("FoodcastService does not claim fixed media dimensions", async () => {
  const { service } = makeService();
  const created = await service.createFoodcast({
    deviceSn: "SN-1", date: "2026-07-16", scope: "day",
  });
  await service.waitForIdle();

  const publicJob = service.getPublicJob(created.id);
  assert.equal(publicJob.media.width, undefined);
  assert.equal(publicJob.media.height, undefined);
});

test("FoodcastService exposes safe BGM metadata with encoded absolute preview URLs", () => {
  const { service } = makeService({
    bgmLibrary: {
      listPublic: () => [{
        id: "bgm 01/cat?mix",
        title: "One",
        artist: "Artist",
        licenseSource: "Licensed",
      }],
    },
  });

  const tracks = service.listBgmTracks("https://cat.test/");

  assert.deepEqual(tracks, [{
    id: "bgm 01/cat?mix",
    title: "One",
    artist: "Artist",
    licenseSource: "Licensed",
    previewUrl: "https://cat.test/api/foodcasts/bgm/bgm%2001%2Fcat%3Fmix/audio",
  }]);
  assert.equal(tracks[0].filePath, undefined);
});

test("FoodcastService resolves BGM previews only through library IDs", () => {
  const filePath = "D:/private/bgm/1.m4a";
  const requestedIds = [];
  const { service } = makeService({
    bgmLibrary: {
      get(id) {
        requestedIds.push(id);
        return id === "bgm-01" ? { id, filePath } : null;
      },
    },
  });

  assert.equal(service.resolveBgmPreview("bgm-01"), filePath);
  assert.throws(() => service.resolveBgmPreview("missing"), { code: "BGM_NOT_FOUND" });
  assert.deepEqual(requestedIds, ["bgm-01", "missing"]);
});

test("FoodcastService exposes safe job data and validates media access tokens", async () => {
  const { service } = makeService();
  const created = await service.createFoodcast({ deviceSn: "SN-1", date: "2026-07-16", scope: "day" });
  await service.waitForIdle();

  const publicJob = service.getPublicJob(created.id, "https://backend.test");

  assert.equal(publicJob.outputPath, undefined);
  assert.equal(publicJob.accessToken, undefined);
  assert.equal(publicJob.errorMessage, undefined);
  assert.equal(publicJob.media.width, undefined);
  assert.equal(publicJob.media.height, undefined);
  assert.match(publicJob.media.url, /\/api\/foodcasts\/job-1\/video\?token=token-1$/);
  assert.throws(() => service.resolveMedia(created.id, "wrong-token"), { code: "FOODCAST_FORBIDDEN" });
  assert.match(service.resolveMedia(created.id, "token-1"), /job-1\.mp4$/);
});

test("FoodcastService cleanup expires old files until the storage quota is met", () => {
  const { dir, store, service } = makeService({ maxStorageBytes: 10 });
  const outputDir = path.join(dir, "outputs");
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [id, createdAt] of [["old", 100], ["new", 200]]) {
    const outputPath = path.join(outputDir, `${id}.mp4`);
    fs.writeFileSync(outputPath, "1234567");
    store.createJob({
      id,
      deviceSn: "SN-1",
      date: "2026-07-16",
      scope: "day",
      mealId: "",
      accessToken: `token-${id}`,
      createdAt,
      expiresAt: 5000,
    });
    store.updateJob(id, { status: "ready", outputPath, outputSize: 7 });
  }

  const removed = service.cleanup();

  assert.deepEqual(removed.map((item) => path.basename(item)), ["old.mp4"]);
  assert.equal(store.getJob("old").status, "expired");
  assert.equal(store.getJob("new").status, "ready");
  assert.equal(fs.existsSync(path.join(outputDir, "old.mp4")), false);
});
