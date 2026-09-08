const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  FoodcastRenderer,
  buildBackgroundArgs,
  buildConcatArgs,
  buildMixArgs,
  buildSegmentArgs,
  classifyFfmpegError,
  runFfmpegCommand,
} = require("./renderer");

test("buildBackgroundArgs extracts one blurred source frame without geometry transforms", () => {
  const args = buildBackgroundArgs({
    sourceUrl: "rtsp://camera.test/replay.sdp",
    outputPath: "background.png",
  });
  const text = args.join(" ");

  assert.match(text, /-rtsp_transport tcp -timeout 15000000/);
  assert.match(text, /-frames:v 1/);
  assert.match(text, /boxblur=20:2,setsar=1/);
  assert.doesNotMatch(text, /transpose|crop|scale=/);
  assert.match(text, /-y background\.png/);
});

test("buildSegmentArgs overlays a complete foreground on one shared static background", () => {
  const args = buildSegmentArgs({
    sourceUrl: "https://camera.test/replay.m3u8",
    backgroundPath: "shared-background.png",
    durationSec: 12,
    outputPath: "segment-0.mp4",
    includeSourceAudio: true,
  });
  const text = args.join(" ");
  const filterIndex = args.indexOf("-filter_complex");

  assert.notEqual(filterIndex, -1, "expected a layered portrait filter");
  const filter = args[filterIndex + 1];
  assert.match(text, /-t 12/);
  assert.match(text, /-i shared-background\.png/);
  assert.doesNotMatch(filter, /split=2/);
  assert.match(filter, /\[1:v\]setsar=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=12\[background\]/);
  assert.match(filter, /\[0:v\]setpts=PTS-STARTPTS,setsar=1,format=rgba,fade=t=in:st=0:d=0\.2:alpha=1,fade=t=out:st=11\.8:d=0\.2:alpha=1\[foreground\]/);
  assert.doesNotMatch(filter, /transpose|crop|scale=/);
  assert.match(filter, /\[background\]\[foreground\]overlay=\(W-w\)\/2:\(H-h\)\/2/);
  assert.doesNotMatch(filter, /\[background\]\[foreground\][^;]*fade=/);
  assert.doesNotMatch(filter, /\[foregroundSource\][^;]*crop=/);
  assert.match(text, /-map \[video\] -map 0:a\?/);
  assert.match(text, /-c:v libx264/);
  assert.match(text, /-crf 23 -maxrate 6M -bufsize 12M/);
  assert.match(text, /-pix_fmt yuv420p/);
  assert.match(text, /-c:a aac -b:a 128k/);
});

test("buildSegmentArgs seeks a full local test video to the selected source offset", () => {
  const args = buildSegmentArgs({
    sourceUrl: "D:/test/input.mp4",
    sourceOffsetSec: 8.5,
    backgroundPath: "shared-background.png",
    durationSec: 4,
    outputPath: "segment-0.mp4",
  });

  assert.match(args.join(" "), /-threads 1 -filter_threads 1 -filter_complex_threads 1/);
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4), [
    "-ss", "8.5", "-i", "D:/test/input.mp4",
  ]);
});

test("buildSegmentArgs can add a silent audio track when the source has none", () => {
  const args = buildSegmentArgs({
    sourceUrl: "https://camera.test/no-audio.m3u8",
    backgroundPath: "shared-background.png",
    durationSec: 8,
    outputPath: "segment-0.mp4",
    includeSourceAudio: false,
  });
  const text = args.join(" ");

  assert.match(text, /-f lavfi -t 8 -i anullsrc=channel_layout=stereo:sample_rate=48000/);
  assert.match(text, /-map \[video\] -map 2:a:0/);
  assert.match(text, /-shortest/);
});

test("buildSegmentArgs center-crops the source to a square frame only when selected", () => {
  const args = buildSegmentArgs({
    sourceUrl: "https://camera.test/replay.m3u8",
    backgroundPath: "shared-background.png",
    durationSec: 3,
    outputPath: "segment-0.mp4",
    frameMode: "center_crop",
  });
  const filter = args[args.indexOf("-filter_complex") + 1];

  assert.match(filter, /\[1:v\]crop=trunc\(min\(iw\\,ih\)\/2\)\*2:trunc\(min\(iw\\,ih\)\/2\)\*2:\(iw-ow\)\/2:\(ih-oh\)\/2/);
  assert.match(filter, /\[0:v\]setpts=PTS-STARTPTS,crop=trunc\(min\(iw\\,ih\)\/2\)\*2:trunc\(min\(iw\\,ih\)\/2\)\*2:\(iw-ow\)\/2:\(ih-oh\)\/2/);
  assert.doesNotMatch(filter, /transpose|scale=/);
});

test("buildSegmentArgs uses hard cuts without video or source-audio fades", () => {
  const args = buildSegmentArgs({
    sourceUrl: "https://camera.test/replay.m3u8",
    backgroundPath: "shared-background.png",
    durationSec: 3,
    outputPath: "segment-0.mp4",
    includeSourceAudio: true,
    transition: "hard_cut",
  });
  const text = args.join(" ");

  assert.doesNotMatch(text, /fade=t=/);
  assert.doesNotMatch(text, /afade=t=/);
  assert.match(text, /\[0:v\]setpts=PTS-STARTPTS,setsar=1,format=rgba\[foreground\]/);
  assert.doesNotMatch(text, /transpose|crop|scale=/);
  assert.match(text, /-af aresample=48000/);
});

test("buildSegmentArgs forces RTSP over TCP with a bounded socket timeout", () => {
  const args = buildSegmentArgs({
    sourceUrl: "rtsp://camera.test/replay.sdp",
    backgroundPath: "shared-background.png",
    durationSec: 8,
    outputPath: "segment-0.mp4",
  });

  const rtspIndex = args.indexOf("-rtsp_transport");
  assert.deepEqual(args.slice(rtspIndex, rtspIndex + 6), [
    "-rtsp_transport", "tcp",
    "-timeout", "15000000",
    "-i", "rtsp://camera.test/replay.sdp",
  ]);
});

test("classifyFfmpegError maps an unavailable cloud recording", () => {
  const error = classifyFfmpegError(
    "method OPTIONS failed: -516102 (No video recording)",
    1
  );

  assert.equal(error.code, "RECORDING_UNAVAILABLE");
});

test("runFfmpegCommand terminates a process that exceeds its deadline", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    runFfmpegCommand(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 300)"],
      { timeoutMs: 50 }
    ),
    { code: "RECORDING_UNAVAILABLE" }
  );

  assert.ok(Date.now() - startedAt < 1000);
});

test("runFfmpegCommand terminates background rendering when feeding work preempts it", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);

  await assert.rejects(
    runFfmpegCommand(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 300)"],
      { signal: controller.signal }
    ),
    { code: "FOODCAST_PREEMPTED" }
  );
});

test("buildConcatArgs joins normalized clips without re-encoding", () => {
  const args = buildConcatArgs({ listPath: "segments.txt", outputPath: "joined.mp4" });

  assert.deepEqual(args.slice(-4), ["-c", "copy", "-y", "joined.mp4"]);
  assert.match(args.join(" "), /-f concat -safe 0 -i segments\.txt/);
});

test("buildMixArgs loops BGM, keeps quiet source audio, and writes fast-start MP4", () => {
  const args = buildMixArgs({
    videoPath: "joined.mp4",
    bgmPath: "cute.mp3",
    durationSec: 60,
    outputPath: "foodcast.mp4",
  });
  const text = args.join(" ");

  assert.match(text, /-stream_loop -1 -i cute\.mp3/);
  assert.match(text, /\[0:a\]volume=0\.15/);
  assert.match(text, /\[1:a\]volume=0\.85/);
  assert.match(text, /afade=t=out:st=58\.5:d=1\.5/);
  assert.match(text, /amix=inputs=2:duration=first/);
  assert.match(text, /-c:v copy/);
  assert.match(text, /-movflags \+faststart/);
});

test("buildMixArgs bgm_only maps no camera audio and applies requested volume", () => {
  const args = buildMixArgs({
    videoPath: "joined.mp4",
    bgmPath: "song.m4a",
    durationSec: 60,
    outputPath: "out.mp4",
    audioMode: "bgm_only",
    bgmVolume: 0.42,
  });
  const text = args.join(" ");

  assert.match(text, /\[1:a\]volume=0\.42/);
  assert.doesNotMatch(text, /\[0:a\]/);
  assert.doesNotMatch(text, /amix=/);
});

test("FoodcastRenderer source mode skips BGM and retains concatenated source audio", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-renderer-source-"));
  const outputPath = path.join(rootDir, "output.mp4");
  const calls = [];
  const renderer = new FoodcastRenderer({
    rootDir,
    runFfmpeg: async (args) => {
      calls.push(args);
      const target = args[args.length - 1];
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "rendered");
    },
    hasAudio: async () => true,
  });

  const result = await renderer.render({
    jobId: "job-source",
    audioMode: "source",
    segments: [{ id: "i1", startMs: 10_000, endMs: 15_000, durationSec: 5 }],
    bgm: null,
    outputPath,
    resolveSource: async () => "https://camera.test/source.m3u8",
  });

  assert.equal(result.audioMode, "source");
  assert.equal(calls.some((args) => args.includes("-stream_loop")), false);
  assert.equal(fs.readFileSync(outputPath, "utf8"), "rendered");
  assert.deepEqual(result.outputMapping, [{
    intervalId: "i1",
    sourceStartMs: 10_000,
    sourceEndMs: 15_000,
    outputStartSec: 0,
    outputEndSec: 5,
  }]);
});

test("FoodcastRenderer retries a missing source audio stream with silence and cleans temp files", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-renderer-"));
  const outputPath = path.join(rootDir, "output.mp4");
  const calls = [];
  let firstAudioAttempt = true;
  const runFfmpeg = async (args) => {
    calls.push(args);
    if (firstAudioAttempt && args.includes("0:a?")) {
      firstAudioAttempt = false;
      throw new Error("AUDIO_STREAM_MISSING");
    }
    const target = args[args.length - 1];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "rendered");
  };
  const progress = [];
  const renderer = new FoodcastRenderer({ rootDir, runFfmpeg, hasAudio: async () => true });

  const result = await renderer.render({
    jobId: "job-1",
    segments: [
      { clipId: "a", durationSec: 5, playbackParams: {} },
      { clipId: "b", durationSec: 7, playbackParams: {} },
    ],
    bgm: { filePath: path.join(rootDir, "cute.mp3") },
    outputPath,
    resolveSource: async (segment) => `https://camera.test/${segment.clipId}.m3u8`,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.durationSec, 12);
  assert.equal(result.outputSize, "rendered".length);
  assert.equal(calls.length, 6);
  assert.match(calls[0].join(" "), /-frames:v 1/);
  assert.match(calls[0].join(" "), /https:\/\/camera\.test\/a\.m3u8/);
  assert.match(calls[1].join(" "), /https:\/\/camera\.test\/a\.m3u8/);
  assert.match(calls[1].join(" "), /background\.png/);
  assert.match(calls[2].join(" "), /anullsrc/);
  assert.match(calls[3].join(" "), /https:\/\/camera\.test\/b\.m3u8/);
  assert.match(calls[3].join(" "), /background\.png/);
  assert.match(calls[4].join(" "), /-f concat/);
  assert.match(calls[5].join(" "), /cute\.mp3/);
  assert.equal(progress.at(-1), 95);
  assert.equal(fs.existsSync(path.join(rootDir, "job-1")), false);
});

test("FoodcastRenderer does not retry an unavailable recording as missing audio", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-renderer-"));
  let calls = 0;
  const unavailable = Object.assign(new Error("No video recording"), {
    code: "RECORDING_UNAVAILABLE",
  });
  const renderer = new FoodcastRenderer({
    rootDir,
    runFfmpeg: async () => {
      calls += 1;
      throw unavailable;
    },
  });

  await assert.rejects(
    renderer.render({
      jobId: "job-unavailable",
      segments: [{ clipId: "a", durationSec: 5 }],
      bgm: { filePath: path.join(rootDir, "cute.mp3") },
      outputPath: path.join(rootDir, "output.mp4"),
      resolveSource: async () => "rtsp://camera.test/replay.sdp",
    }),
    { code: "RECORDING_UNAVAILABLE" }
  );

  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(rootDir, "job-unavailable")), false);
});

test("FoodcastRenderer allows enough time for layered landscape encoding", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-renderer-"));
  const calls = [];
  const renderer = new FoodcastRenderer({
    rootDir,
    runFfmpeg: async (args, options) => {
      calls.push({ args, options });
      const target = args[args.length - 1];
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "rendered");
    },
    hasAudio: async () => true,
  });

  await renderer.render({
    jobId: "job-timeout-budget",
    segments: [{ clipId: "a", durationSec: 5 }],
    bgm: { filePath: path.join(rootDir, "cute.mp3") },
    outputPath: path.join(rootDir, "output.mp4"),
    resolveSource: async () => "rtsp://camera.test/replay.sdp",
  });

  assert.equal(calls[0].options.timeoutMs, 60_000);
});

test("FoodcastRenderer applies hard cuts to every quick-cut segment with one shared background", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "foodcast-renderer-"));
  const calls = [];
  const renderer = new FoodcastRenderer({
    rootDir,
    runFfmpeg: async (args) => {
      calls.push(args);
      const target = args[args.length - 1];
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "rendered");
    },
    hasAudio: async () => true,
  });

  await renderer.render({
    jobId: "job-quick-cut",
    mode: "quick_cut",
    segments: [
      { clipId: "a", durationSec: 3 },
      { clipId: "b", durationSec: 3 },
    ],
    bgm: { filePath: path.join(rootDir, "cute.mp3") },
    outputPath: path.join(rootDir, "output.mp4"),
    resolveSource: async (segment) => `https://camera.test/${segment.clipId}.m3u8`,
  });

  const backgroundCalls = calls.filter((args) => args.includes("-frames:v"));
  const segmentCalls = calls.filter((args) => args.includes("-filter_complex") && args.includes("-crf"));
  assert.equal(backgroundCalls.length, 1);
  assert.equal(segmentCalls.length, 2);
  for (const args of segmentCalls) {
    assert.doesNotMatch(args.join(" "), /fade=t=|afade=t=/);
    assert.match(args.join(" "), /background\.png/);
  }
});
