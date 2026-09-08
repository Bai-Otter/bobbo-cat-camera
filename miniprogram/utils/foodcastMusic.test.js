const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RANDOM_BGM_ID,
  buildMusicOptions,
  createMusicPreviewController,
} = require("./foodcastMusic.js");

function createAudioHarness() {
  const contexts = [];
  const timeline = [];

  function createAudioContext() {
    const index = contexts.length;
    const handlers = {};
    const context = {
      src: "",
      volume: 1,
      calls: [],
      onPlay(handler) {
        handlers.play = handler;
      },
      onPause(handler) {
        handlers.pause = handler;
      },
      onEnded(handler) {
        handlers.ended = handler;
      },
      onError(handler) {
        handlers.error = handler;
      },
      play() {
        this.calls.push("play");
        timeline.push(`${index}:play`);
      },
      pause() {
        this.calls.push("pause");
        timeline.push(`${index}:pause`);
      },
      seek(position) {
        this.calls.push(["seek", position]);
        timeline.push(`${index}:seek:${position}`);
      },
      stop() {
        this.calls.push("stop");
        timeline.push(`${index}:stop`);
      },
      destroy() {
        this.calls.push("destroy");
        timeline.push(`${index}:destroy`);
      },
      emit(name, value) {
        handlers[name](value);
      },
    };
    contexts.push(context);
    timeline.push(`${index}:create`);
    return context;
  }

  return { contexts, createAudioContext, timeline };
}

function createPreview(harness, overrides = {}) {
  const playingChanges = [];
  const errors = [];
  const preview = createMusicPreviewController({
    createAudioContext: harness.createAudioContext,
    onPlayingChange: (id) => playingChanges.push(id),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return { errors, playingChanges, preview };
}

const firstTrack = {
  id: "bgm-01",
  title: "Morning Tuna",
  artist: "Foodcast",
  previewUrl: "https://backend.test/music/bgm-01/preview",
};

const secondTrack = {
  id: "bgm-02",
  title: "Dinner Bell",
  artist: "Foodcast",
  previewUrl: "https://backend.test/music/bgm-02/preview",
};

test("buildMusicOptions always puts the random option first", () => {
  assert.equal(RANDOM_BGM_ID, "random");
  assert.deepEqual(buildMusicOptions([]), [
    { id: "random", title: "随机音乐", artist: "", previewUrl: "" },
  ]);
  assert.deepEqual(
    buildMusicOptions([firstTrack]).map((option) => option.id),
    ["random", "bgm-01"]
  );
});

test("buildMusicOptions filters invalid tracks and copies only safe page fields", () => {
  const source = {
    ...firstTrack,
    filePath: "D:/private/bgm-01.mp3",
    internalToken: "secret",
  };

  const options = buildMusicOptions([
    null,
    {},
    { previewUrl: "https://backend.test/no-id" },
    { id: "no-preview", title: "Missing preview" },
    source,
  ]);

  assert.deepEqual(options, [
    { id: "random", title: "随机音乐", artist: "", previewUrl: "" },
    {
      id: "bgm-01",
      title: "Morning Tuna",
      artist: "Foodcast",
      previewUrl: "https://backend.test/music/bgm-01/preview",
    },
  ]);
  assert.notEqual(options[1], source);
});

test("toggle creates one context and starts the selected track from the beginning", () => {
  const harness = createAudioHarness();
  const { playingChanges, preview } = createPreview(harness);

  preview.toggle(firstTrack);

  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.contexts[0].src, firstTrack.previewUrl);
  assert.deepEqual(harness.contexts[0].calls, ["play"]);
  assert.equal(preview.getPlayingId(), firstTrack.id);
  assert.deepEqual(playingChanges, [firstTrack.id]);
});

test("toggle rebuilds the context to replay a paused track from zero", () => {
  const harness = createAudioHarness();
  const { playingChanges, preview } = createPreview(harness);

  preview.toggle(firstTrack);
  preview.toggle(firstTrack);
  assert.equal(preview.getPlayingId(), "");
  assert.deepEqual(harness.contexts[0].calls, ["play", "pause"]);

  preview.toggle(firstTrack);

  assert.equal(preview.getPlayingId(), firstTrack.id);
  assert.equal(harness.contexts.length, 2);
  assert.deepEqual(harness.contexts[0].calls, ["play", "pause", "stop", "destroy"]);
  assert.equal(harness.contexts[1].src, firstTrack.previewUrl);
  assert.deepEqual(harness.contexts[1].calls, ["play"]);
  assert.deepEqual(harness.timeline, [
    "0:create",
    "0:play",
    "0:pause",
    "0:stop",
    "0:destroy",
    "1:create",
    "1:play",
  ]);
  assert.deepEqual(playingChanges, [firstTrack.id, "", firstTrack.id]);
});

test("late events from a paused context cannot override its replacement", () => {
  const harness = createAudioHarness();
  const { errors, playingChanges, preview } = createPreview(harness);

  preview.toggle(firstTrack);
  preview.toggle(firstTrack);
  preview.toggle(firstTrack);
  harness.contexts[0].emit("pause");
  harness.contexts[0].emit("play");
  harness.contexts[0].emit("error", new Error("late"));

  assert.equal(preview.getPlayingId(), firstTrack.id);
  assert.deepEqual(playingChanges, [firstTrack.id, "", firstTrack.id]);
  assert.deepEqual(errors, []);
});

test("switching tracks stops and destroys the old context before playing the new one", () => {
  const harness = createAudioHarness();
  const { preview } = createPreview(harness);

  preview.toggle(firstTrack);
  preview.toggle(secondTrack);

  assert.equal(harness.contexts.length, 2);
  assert.deepEqual(harness.contexts[0].calls, ["play", "stop", "destroy"]);
  assert.equal(harness.contexts[1].src, secondTrack.previewUrl);
  assert.deepEqual(harness.timeline, [
    "0:create",
    "0:play",
    "0:stop",
    "0:destroy",
    "1:create",
    "1:play",
  ]);
  assert.equal(preview.getPlayingId(), secondTrack.id);
});

test("audio play, pause, and ended events keep playingId predictable", () => {
  const harness = createAudioHarness();
  const { playingChanges, preview } = createPreview(harness);

  preview.toggle(firstTrack);
  harness.contexts[0].emit("pause");
  assert.equal(preview.getPlayingId(), "");

  harness.contexts[0].emit("play");
  assert.equal(preview.getPlayingId(), firstTrack.id);

  harness.contexts[0].emit("ended");
  assert.equal(preview.getPlayingId(), "");
  assert.deepEqual(playingChanges, [firstTrack.id, "", firstTrack.id, ""]);
});

test("audio errors clear playingId and notify the caller", () => {
  const harness = createAudioHarness();
  const { errors, playingChanges, preview } = createPreview(harness);
  const error = { errMsg: "preview unavailable" };

  preview.toggle(firstTrack);
  harness.contexts[0].emit("error", error);

  assert.equal(preview.getPlayingId(), "");
  assert.deepEqual(playingChanges, [firstTrack.id, ""]);
  assert.deepEqual(errors, [error]);
});

test("late events from an old context cannot clear the new track", () => {
  const harness = createAudioHarness();
  const { errors, preview } = createPreview(harness);

  preview.toggle(firstTrack);
  preview.toggle(secondTrack);
  harness.contexts[0].emit("pause");
  harness.contexts[0].emit("ended");
  harness.contexts[0].emit("error", new Error("late"));

  assert.equal(preview.getPlayingId(), secondTrack.id);
  assert.deepEqual(errors, []);
});

test("selectRandom stops and destroys the current preview", () => {
  const harness = createAudioHarness();
  const { playingChanges, preview } = createPreview(harness);

  preview.toggle(firstTrack);
  preview.selectRandom();

  assert.equal(preview.getPlayingId(), "");
  assert.deepEqual(harness.contexts[0].calls, ["play", "stop", "destroy"]);
  assert.deepEqual(playingChanges, [firstTrack.id, ""]);
});

test("preview volume updates the active context and stop destroys it", () => {
  const harness = createAudioHarness();
  const { preview } = createPreview(harness);
  preview.toggle(firstTrack);
  assert.equal(preview.setVolume(0.4), 0.4);
  assert.equal(harness.contexts[0].volume, 0.4);
  preview.stop();
  assert.deepEqual(harness.contexts[0].calls, ["play", "stop", "destroy"]);
});

test("stop and repeated destroy calls are safe and release only the owned context", () => {
  const harness = createAudioHarness();
  const { preview } = createPreview(harness);

  preview.toggle(firstTrack);
  preview.stop();
  preview.stop();
  preview.destroy();
  preview.destroy();

  assert.equal(preview.getPlayingId(), "");
  assert.deepEqual(harness.contexts[0].calls, ["play", "stop", "destroy"]);
  assert.equal(harness.contexts.length, 1);
});
