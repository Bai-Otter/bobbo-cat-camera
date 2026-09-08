function numberText(value) {
  return String(Math.round(Number(value) * 1000) / 1000);
}

function appendSourceInput(args, sourceUrl, sourceOffsetSec = 0) {
  if (/^rtsp:/i.test(String(sourceUrl || ""))) {
    args.push("-rtsp_transport", "tcp", "-timeout", "15000000");
  }
  if (Number(sourceOffsetSec) > 0) {
    args.push("-ss", numberText(sourceOffsetSec));
  }
  args.push("-i", sourceUrl);
}

function buildBackgroundArgs({ sourceUrl, sourceOffsetSec = 0, outputPath, frameMode = "source" }) {
  const args = ["-hide_banner", "-loglevel", "error", "-threads", "1", "-filter_threads", "1"];
  appendSourceInput(args, sourceUrl, sourceOffsetSec);
  const frameFilter = frameMode === "center_crop"
    ? "crop=trunc(min(iw\\,ih)/2)*2:trunc(min(iw\\,ih)/2)*2:(iw-ow)/2:(ih-oh)/2,"
    : "";
  args.push(
    "-frames:v", "1",
    "-vf", `${frameFilter}boxblur=20:2,setsar=1`,
    "-an",
    "-y", outputPath
  );
  return args;
}

function buildSegmentArgs({
  sourceUrl,
  sourceOffsetSec = 0,
  backgroundPath,
  durationSec,
  outputPath,
  includeSourceAudio = true,
  transition = "fade",
  frameMode = "source",
}) {
  const duration = Math.max(0.2, Number(durationSec) || 0.2);
  const fadeOutStart = Math.max(0, duration - 0.2);
  const frameFilter = frameMode === "center_crop"
    ? "crop=trunc(min(iw\\,ih)/2)*2:trunc(min(iw\\,ih)/2)*2:(iw-ow)/2:(ih-oh)/2,"
    : "";
  const foregroundFilter = transition === "hard_cut"
    ? `[0:v]setpts=PTS-STARTPTS,${frameFilter}setsar=1,format=rgba[foreground]`
    : `[0:v]setpts=PTS-STARTPTS,${frameFilter}setsar=1,format=rgba,fade=t=in:st=0:d=0.2:alpha=1,fade=t=out:st=${numberText(fadeOutStart)}:d=0.2:alpha=1[foreground]`;
  const videoFilter = [
    `[1:v]${frameFilter}setsar=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${numberText(duration)}[background]`,
    foregroundFilter,
    "[background][foreground]overlay=(W-w)/2:(H-h)/2,fps=25,setsar=1,format=yuv420p[video]",
  ].join(";");
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1",
  ];
  appendSourceInput(args, sourceUrl, sourceOffsetSec);
  args.push("-i", backgroundPath);
  if (!includeSourceAudio) {
    args.push(
      "-f", "lavfi", "-t", numberText(duration),
      "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"
    );
  }
  args.push(
    "-t", numberText(duration),
    "-filter_complex", videoFilter,
    "-map", "[video]",
    "-map", includeSourceAudio ? "0:a?" : "2:a:0"
  );
  if (includeSourceAudio) {
    const audioFilter = transition === "hard_cut"
      ? "aresample=48000"
      : `aresample=48000,afade=t=in:st=0:d=0.2,afade=t=out:st=${numberText(fadeOutStart)}:d=0.2`;
    args.push("-af", audioFilter);
  } else {
    args.push("-shortest");
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-maxrate", "6M",
    "-bufsize", "12M",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart",
    "-y", outputPath
  );
  return args;
}

function buildConcatArgs({ listPath, outputPath }) {
  return [
    "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-y", outputPath,
  ];
}

function buildCoverArgs({ sourcePath, outputPath }) {
  return [
    "-hide_banner", "-loglevel", "error",
    "-ss", "0.2", "-i", sourcePath,
    "-frames:v", "1",
    "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
    "-q:v", "3",
    "-y", outputPath,
  ];
}

function buildMixArgs({
  videoPath,
  bgmPath,
  durationSec,
  outputPath,
  audioMode = "mix",
  bgmVolume = 0.85,
}) {
  const duration = Math.max(0.2, Number(durationSec) || 0.2);
  const fadeOutStart = Math.max(0, duration - 1.5);
  const volume = Math.max(0, Math.min(1, Number(bgmVolume) || 0.85));
  const filter = audioMode === "bgm_only"
    ? `[1:a]volume=${numberText(volume)},afade=t=out:st=${numberText(fadeOutStart)}:d=1.5[aout]`
    : `[0:a]volume=0.15[original];[1:a]volume=${numberText(volume)},afade=t=out:st=${numberText(fadeOutStart)}:d=1.5[bgm];[original][bgm]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
  return [
    "-hide_banner", "-loglevel", "error",
    "-i", videoPath,
    "-stream_loop", "-1", "-i", bgmPath,
    "-t", numberText(duration),
    "-filter_complex",
    filter,
    "-map", "0:v:0", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    "-y", outputPath,
  ];
}

function buildOutputMapping(segments) {
  let outputStartSec = 0;
  return segments.map((segment) => {
    const durationSec = Number(segment.durationSec) || 0;
    const sourceStartMs = Number(segment.sourceStartMs ?? segment.startMs);
    const sourceEndMs = Number(segment.sourceEndMs ?? segment.endMs);
    const item = {
      intervalId: segment.intervalId ?? segment.id ?? segment.clipId,
      sourceStartMs: Number.isFinite(sourceStartMs) ? sourceStartMs : null,
      sourceEndMs: Number.isFinite(sourceEndMs)
        ? sourceEndMs
        : (Number.isFinite(sourceStartMs) ? sourceStartMs + durationSec * 1000 : null),
      outputStartSec,
      outputEndSec: outputStartSec + durationSec,
    };
    outputStartSec = item.outputEndSec;
    return item;
  });
}

function runFfmpegCommand(ffmpegPath, args, { timeoutMs = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("FOODCAST_PREEMPTED");
      error.code = "FOODCAST_PREEMPTED";
      reject(error);
      return;
    }
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs)
      : null;
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        const error = new Error("FOODCAST_PREEMPTED");
        error.code = "FOODCAST_PREEMPTED";
        reject(error);
        return;
      }
      if (timedOut) {
        const error = new Error(`FFMPEG_INPUT_TIMEOUT_${timeoutMs}`);
        error.code = "RECORDING_UNAVAILABLE";
        reject(error);
        return;
      }
      if (code === 0) return resolve();
      reject(classifyFfmpegError(stderr, code));
    });
  });
}

function classifyFfmpegError(stderr, exitCode) {
  const message = String(stderr || "").trim() || `FFMPEG_EXIT_${exitCode}`;
  const error = new Error(message);
  error.code = /-516102|No video recording/i.test(message)
    ? "RECORDING_UNAVAILABLE"
    : "TRANSCODE_FAILED";
  return error;
}

function probeAudioStream(ffmpegPath, filePath) {
  return runFfmpegCommand(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-i", filePath,
    "-map", "0:a:0", "-frames:a", "1",
    "-f", "null", "-",
  ]).then(() => true, () => false);
}

class FoodcastRenderer {
  constructor({ rootDir, ffmpegPath = "", runFfmpeg, hasAudio } = {}) {
    this.rootDir = rootDir;
    this.ffmpegPath = ffmpegPath;
    this.runFfmpeg = runFfmpeg || ((args, options) => runFfmpegCommand(this.ffmpegPath, args, options));
    this.hasAudio = hasAudio || ((filePath) => probeAudioStream(this.ffmpegPath, filePath));
  }

  async render({
    jobId,
    mode = "natural",
    frameMode = "source",
    audioMode = "mix",
    bgmVolume = 0.85,
    segments,
    outputMapping,
    bgm,
    outputPath,
    resolveSource,
    signal,
    onProgress = () => {},
  }) {
    const tempDir = path.join(this.rootDir, jobId);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const normalizedPaths = [];
    const durationSec = segments.reduce((sum, segment) => sum + (Number(segment.durationSec) || 0), 0);
    try {
      const firstSourceUrl = await resolveSource(segments[0]);
      if (!firstSourceUrl) {
        const error = new Error("RECORDING_UNAVAILABLE");
        error.code = "RECORDING_UNAVAILABLE";
        throw error;
      }
      const backgroundPath = path.join(tempDir, "background.png");
      const firstSourceTimeout = {
        timeoutMs: Math.max(60_000, Number(segments[0].durationSec) * 4_000 + 30_000),
      };
      await this.runFfmpeg(buildBackgroundArgs({
        sourceUrl: firstSourceUrl,
        sourceOffsetSec: segments[0].sourceOffsetSec,
        frameMode,
        outputPath: backgroundPath,
      }), { ...firstSourceTimeout, signal });
      onProgress(15);

      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const sourceUrl = index === 0 ? firstSourceUrl : await resolveSource(segment);
        if (!sourceUrl) {
          const error = new Error("RECORDING_UNAVAILABLE");
          error.code = "RECORDING_UNAVAILABLE";
          throw error;
        }
        const normalizedPath = path.join(tempDir, `segment-${index}.mp4`);
        const sourceTimeout = {
          timeoutMs: Math.max(60_000, Number(segment.durationSec) * 4_000 + 30_000),
        };
        let needsSilentAudio = false;
        try {
          await this.runFfmpeg(buildSegmentArgs({
            sourceUrl,
            sourceOffsetSec: segment.sourceOffsetSec,
            backgroundPath,
            durationSec: segment.durationSec,
            outputPath: normalizedPath,
            includeSourceAudio: true,
            transition: mode === "quick_cut" ? "hard_cut" : "fade",
            frameMode,
          }), { ...sourceTimeout, signal });
        } catch (error) {
          if (error && error.code === "RECORDING_UNAVAILABLE") throw error;
          needsSilentAudio = true;
        }
        if (!needsSilentAudio) {
          needsSilentAudio = !(await this.hasAudio(normalizedPath));
        }
        if (needsSilentAudio) {
          await this.runFfmpeg(buildSegmentArgs({
            sourceUrl,
            sourceOffsetSec: segment.sourceOffsetSec,
            backgroundPath,
            durationSec: segment.durationSec,
            outputPath: normalizedPath,
            includeSourceAudio: false,
            transition: mode === "quick_cut" ? "hard_cut" : "fade",
            frameMode,
          }), { ...sourceTimeout, signal });
        }
        normalizedPaths.push(normalizedPath);
        onProgress(20 + Math.round(((index + 1) / segments.length) * 55));
      }

      const listPath = path.join(tempDir, "segments.txt");
      const listText = normalizedPaths
        .map((filePath) => `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
        .join("\n");
      fs.writeFileSync(listPath, `${listText}\n`, "utf8");
      const joinedPath = path.join(tempDir, "joined.mp4");
      await this.runFfmpeg(buildConcatArgs({ listPath, outputPath: joinedPath }), { signal });
      onProgress(85);

      if (audioMode === "source") {
        fs.copyFileSync(joinedPath, outputPath);
      } else {
        if (!bgm?.filePath) {
          const error = new Error("BGM_REQUIRED");
          error.code = "BGM_REQUIRED";
          throw error;
        }
        await this.runFfmpeg(buildMixArgs({
          videoPath: joinedPath,
          bgmPath: bgm.filePath,
          durationSec,
          outputPath,
          audioMode,
          bgmVolume,
        }), { signal });
      }
      onProgress(95);
      return {
        durationSec,
        outputSize: fs.statSync(outputPath).size,
        audioMode,
        outputMapping: outputMapping || buildOutputMapping(segments),
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async captureCover(sourcePath, outputPath) {
    await this.runFfmpeg(buildCoverArgs({ sourcePath, outputPath }), { timeoutMs: 30_000 });
    return outputPath;
  }
}

module.exports = {
  FoodcastRenderer,
  buildBackgroundArgs,
  buildConcatArgs,
  buildCoverArgs,
  buildMixArgs,
  buildOutputMapping,
  buildSegmentArgs,
  classifyFfmpegError,
  probeAudioStream,
  runFfmpegCommand,
};
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
