const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { FoodcastRenderer } = require("./renderer");

let ffmpegPath = "";
try {
  ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
} catch (error) {
  ffmpegPath = "";
}

function ffmpeg(args) {
  const result = spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function samplePixel(filePath, x, y, second = 0.5) {
  const result = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(second), "-i", filePath,
    "-vf", `format=rgb24,crop=1:1:${x}:${y}`,
    "-frames:v", "1", "-f", "rawvideo", "pipe:1",
  ]);
  assert.equal(result.status, 0, String(result.stderr || ""));
  return Array.from(result.stdout.subarray(0, 3));
}

function assertDominant(pixel, channel, label) {
  const otherChannels = [0, 1, 2].filter((item) => item !== channel);
  assert.ok(
    pixel[channel] > pixel[otherChannels[0]] + 40 &&
      pixel[channel] > pixel[otherChannels[1]] + 40,
    `${label} pixel was ${pixel.join(",")}`
  );
}

test("FoodcastRenderer preserves landscape orientation and concatenates multiple segments", {
  skip: !ffmpegPath,
  timeout: 60_000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-integration-"));
  const inputPath = path.join(dir, "landscape-no-audio.mp4");
  const bgmPath = path.join(dir, "cute.wav");
  const outputPath = path.join(dir, "foodcast.mp4");
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=black:s=320x180:d=1",
    "-vf", [
      "drawbox=x=0:y=0:w=160:h=90:color=red:t=fill",
      "drawbox=x=160:y=0:w=160:h=90:color=green:t=fill",
      "drawbox=x=0:y=90:w=160:h=90:color=blue:t=fill",
      "drawbox=x=160:y=90:w=160:h=90:color=yellow:t=fill",
    ].join(","),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", inputPath,
  ]);
  ffmpeg([
    "-f", "lavfi", "-i", "sine=frequency=660:duration=3",
    "-c:a", "pcm_s16le", "-y", bgmPath,
  ]);
  const renderer = new FoodcastRenderer({ rootDir: path.join(dir, "temp"), ffmpegPath });

  const result = await renderer.render({
    jobId: "integration-job",
    segments: [
      { clipId: "clip-a", durationSec: 1, playbackParams: {} },
      { clipId: "clip-b", durationSec: 1, playbackParams: {} },
    ],
    bgm: { filePath: bgmPath },
    outputPath,
    resolveSource: async () => inputPath,
  });

  const probe = spawnSync(ffmpegPath, ["-hide_banner", "-i", outputPath, "-f", "null", "-"], {
    encoding: "utf8",
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stderr, /Video: h264/);
  assert.match(probe.stderr, /320x180/);
  assert.match(probe.stderr, /Audio: aac/);
  const durationMatch = probe.stderr.match(/Duration:\s+(\d+):(\d+):([\d.]+)/);
  assert.ok(durationMatch, probe.stderr);
  const probedDuration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  assert.ok(probedDuration >= 1.8 && probedDuration <= 2.2, `duration was ${probedDuration}`);
  assert.equal(result.durationSec, 2);
  assert.ok(result.outputSize > 0);

  const topLeft = samplePixel(outputPath, 40, 40);
  const topRight = samplePixel(outputPath, 280, 40);
  const bottomLeft = samplePixel(outputPath, 40, 140);
  const bottomRight = samplePixel(outputPath, 280, 140);
  assertDominant(topLeft, 0, "top-left red");
  assertDominant(topRight, 1, "top-right green");
  assertDominant(bottomLeft, 2, "bottom-left blue");
  assert.ok(bottomRight[0] > bottomRight[2] + 40 && bottomRight[1] > bottomRight[2] + 40, `bottom-right yellow pixel was ${bottomRight.join(",")}`);
});

