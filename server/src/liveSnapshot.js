const { spawn: defaultSpawn } = require("node:child_process");

function captureLiveSnapshot({
  sourceUrl,
  ffmpegPath,
  spawn = defaultSpawn,
  timeoutMs = 12_000,
  maxBytes = 2 * 1024 * 1024,
  signal,
} = {}) {
  if (!sourceUrl) return Promise.reject(new Error("LIVE_SNAPSHOT_SOURCE_REQUIRED"));
  if (!ffmpegPath) return Promise.reject(new Error("FFMPEG_NOT_CONFIGURED"));

  const inputArgs = /^rtsp:\/\//i.test(String(sourceUrl || ''))
    ? ["-rtsp_transport", "tcp", "-i", sourceUrl]
    : ["-i", sourceUrl];
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    ...inputArgs,
    "-frames:v", "1",
    "-vf", "scale='min(480,iw)':-2",
    "-q:v", "8",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let byteLength = 0;
    let stderr = "";
    let settled = false;
    const abort = () => {
      child.kill("SIGKILL");
      finish(new Error("LIVE_SNAPSHOT_ABORTED"));
    };
    const finish = (error, buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
      if (error) reject(error);
      else resolve(buffer);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("LIVE_SNAPSHOT_TIMEOUT"));
    }, timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener?.("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        child.kill("SIGKILL");
        finish(new Error("LIVE_SNAPSHOT_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      const buffer = Buffer.concat(chunks);
      if (code !== 0) return finish(new Error(stderr.trim() || `LIVE_SNAPSHOT_FFMPEG_${code}`));
      if (!buffer.length) return finish(new Error("LIVE_SNAPSHOT_EMPTY"));
      finish(null, buffer);
    });
  });
}

module.exports = { captureLiveSnapshot };
