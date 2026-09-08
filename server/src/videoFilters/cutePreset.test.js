const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CUTE_VIDEO_FILTER_ID,
  CUTE_VIDEO_FILTER_PRESET,
  CUTE_DEBUG_VIDEO_FILTER_ID,
  CUTE_DEBUG_VIDEO_FILTER_PRESET,
  buildFfmpegVideoFilter,
  resolveVideoFilter,
} = require("./cutePreset");

test("cute preset keeps the confirmed fallback Apple-style values", () => {
  assert.equal(CUTE_VIDEO_FILTER_ID, "cute-v1");
  assert.equal(CUTE_VIDEO_FILTER_PRESET.brilliance, 23);
  assert.equal(CUTE_VIDEO_FILTER_PRESET.vibrance, 9);
  assert.equal(CUTE_VIDEO_FILTER_PRESET.brightness, 0);
  assert.equal(CUTE_VIDEO_FILTER_PRESET.saturation, 0);
});

test("debug preset maxes every Apple-style adjustment", () => {
  assert.equal(CUTE_DEBUG_VIDEO_FILTER_ID, "cute-debug-max");
  assert.equal(Object.keys(CUTE_DEBUG_VIDEO_FILTER_PRESET).length, 15);
  assert.ok(Object.values(CUTE_DEBUG_VIDEO_FILTER_PRESET).every((value) => value === 100));
});

test("cute preset builds a midtone curve and natural saturation filter", () => {
  assert.equal(
    buildFfmpegVideoFilter(CUTE_VIDEO_FILTER_PRESET),
    "curves=all='0/0 0.25/0.284 0.5/0.568 0.75/0.784 1/1',vibrance=intensity=0.09"
  );
});

test("debug preset builds every visible adjustment stage", () => {
  const graph = buildFfmpegVideoFilter(CUTE_DEBUG_VIDEO_FILTER_PRESET);

  assert.match(graph, /eq=brightness=0\.35:contrast=2:saturation=3:gamma=1\.5/);
  assert.match(graph, /curves=all=/);
  assert.match(graph, /vibrance=intensity=1\.5/);
  assert.match(graph, /hue=h=180/);
  assert.match(graph, /colorbalance=/);
  assert.match(graph, /unsharp=7:7:5:7:7:5/);
});

test("resolver accepts both trusted presets and rejects arbitrary graphs", () => {
  assert.match(resolveVideoFilter("cute-v1"), /^curves=/);
  assert.match(resolveVideoFilter("cute-debug-max"), /^eq=/);
  assert.equal(resolveVideoFilter("eq=brightness=1"), "");
  assert.equal(resolveVideoFilter(""), "");
});
