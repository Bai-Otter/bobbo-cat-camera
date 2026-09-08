const CUTE_VIDEO_FILTER_ID = "cute-v1";
const CUTE_DEBUG_VIDEO_FILTER_ID = "cute-debug-max";

const CUTE_VIDEO_FILTER_PRESET = Object.freeze({
  brightness: 0,
  exposure: 0,
  brilliance: 23,
  shadows: 0,
  highlights: 0,
  blackPoint: 0,
  saturation: 0,
  vibrance: 9,
  vividness: 0,
  hue: 0,
  temperature: 0,
  tint: 0,
  contrast: 0,
  definition: 0,
  sharpness: 0,
});

const CUTE_DEBUG_VIDEO_FILTER_PRESET = Object.freeze({
  brightness: 100,
  exposure: 100,
  brilliance: 100,
  shadows: 100,
  highlights: 100,
  blackPoint: 100,
  saturation: 100,
  vibrance: 100,
  vividness: 100,
  hue: 100,
  temperature: 100,
  tint: 100,
  contrast: 100,
  definition: 100,
  sharpness: 100,
});

function rounded(value) {
  return Number(value.toFixed(3));
}

function brilliancePoint(input, value) {
  const midWeight = 1 - Math.abs(input - 0.5) / 0.5;
  return rounded(input + (Number(value) * 0.75 * midWeight) / 255);
}

function isDebugMaxPreset(preset) {
  return preset === CUTE_DEBUG_VIDEO_FILTER_PRESET;
}

function buildDebugMaxFfmpegVideoFilter() {
  return [
    "eq=brightness=0.35:contrast=2:saturation=3:gamma=1.5",
    "curves=all='0/0 0.1/0 0.25/0.45 0.5/0.8 0.75/0.96 1/1'",
    "vibrance=intensity=1.5",
    "hue=h=180",
    "colorbalance=rs=0.5:gs=-0.5:bs=-0.5:rm=0.3:gm=-0.3:bm=-0.3",
    "unsharp=7:7:5:7:7:5",
  ].join(",");
}

function buildFfmpegVideoFilter(preset = {}) {
  if (isDebugMaxPreset(preset)) return buildDebugMaxFfmpegVideoFilter();
  const filters = [];
  if (Number(preset.brilliance)) {
    const points = [0, 0.25, 0.5, 0.75, 1]
      .map((input) => `${input}/${brilliancePoint(input, preset.brilliance)}`)
      .join(" ");
    filters.push(`curves=all='${points}'`);
  }
  if (Number(preset.vibrance)) {
    filters.push(`vibrance=intensity=${rounded(Number(preset.vibrance) / 100)}`);
  }
  return filters.join(",");
}

function resolveVideoFilter(id) {
  if (id === CUTE_VIDEO_FILTER_ID) {
    return buildFfmpegVideoFilter(CUTE_VIDEO_FILTER_PRESET);
  }
  if (id === CUTE_DEBUG_VIDEO_FILTER_ID) {
    return buildFfmpegVideoFilter(CUTE_DEBUG_VIDEO_FILTER_PRESET);
  }
  return "";
}

module.exports = {
  CUTE_VIDEO_FILTER_ID,
  CUTE_VIDEO_FILTER_PRESET,
  CUTE_DEBUG_VIDEO_FILTER_ID,
  CUTE_DEBUG_VIDEO_FILTER_PRESET,
  buildFfmpegVideoFilter,
  resolveVideoFilter,
};
