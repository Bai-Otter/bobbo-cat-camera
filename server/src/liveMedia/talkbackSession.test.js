const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const { TalkbackSession } = require("./talkbackSession");

function fakeChild({ closeOnTerm = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdin.on("data", () => {});
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    if (closeOnTerm && signal === "SIGTERM") queueMicrotask(() => child.emit("close", 0, signal));
    return true;
  };
  return child;
}

test("talkback session resolves one owned RTMP URL and streams AAC through FFmpeg stdin", async () => {
  const child = fakeChild({ closeOnTerm: true });
  const calls = [];
  const session = new TalkbackSession({
    ffmpegPath: "ffmpeg-test",
    resolveTalkbackUrl: async () => {
      calls.push("resolve");
      return "rtmp://talk.test/live";
    },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
    stopTimeoutMs: 20,
    maxBytes: 16,
  });

  await session.start();
  assert.equal(calls.filter((entry) => entry === "resolve").length, 1);
  assert.deepEqual(calls[1], {
    command: "ffmpeg-test",
    args: [
      "-hide_banner", "-loglevel", "warning",
      "-f", "aac", "-i", "pipe:0",
      "-vn", "-c:a", "copy", "-f", "flv", "rtmp://talk.test/live",
    ],
    options: { stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
  });
  assert.equal(session.writeAudio(Buffer.from([1, 2, 3, 4])), 4);
  assert.equal(session.bytesWritten, 4);

  await session.stop();
  await session.stop();
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.kills, ["SIGTERM"]);
});

test("talkback session rejects frames outside active state and enforces cumulative bytes", async () => {
  const child = fakeChild({ closeOnTerm: true });
  const session = new TalkbackSession({
    ffmpegPath: "ffmpeg-test",
    resolveTalkbackUrl: async () => "rtmp://talk.test/live",
    spawn: () => child,
    maxBytes: 5,
  });

  assert.throws(() => session.writeAudio(Buffer.from([1])), { code: "TALKBACK_NOT_ACTIVE" });
  await session.start();
  session.writeAudio(Buffer.alloc(4));
  assert.throws(() => session.writeAudio(Buffer.alloc(2)), { code: "TALKBACK_AUDIO_LIMIT" });
  await session.stop();
});

test("talkback session escalates a stuck FFmpeg process to SIGKILL", async () => {
  const child = fakeChild();
  const session = new TalkbackSession({
    ffmpegPath: "ffmpeg-test",
    resolveTalkbackUrl: async () => "rtmp://talk.test/live",
    spawn: () => child,
    stopTimeoutMs: 5,
  });

  await session.start();
  await session.stop();

  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("talkback session reports stable startup and active-process failures", async () => {
  const startFailure = new TalkbackSession({
    ffmpegPath: "ffmpeg-test",
    resolveTalkbackUrl: async () => { throw new Error("secret upstream url failed"); },
    spawn: () => assert.fail("spawn must not run"),
  });
  await assert.rejects(startFailure.start(), { code: "TALKBACK_START_FAILED" });

  const child = fakeChild();
  const activeFailure = new TalkbackSession({
    ffmpegPath: "ffmpeg-test",
    resolveTalkbackUrl: async () => "rtmp://talk.test/private-token",
    spawn: () => child,
  });
  const failure = new Promise((resolve) => activeFailure.once("failed", resolve));
  await activeFailure.start();
  child.stderr.write("Invalid data found when processing input");
  child.emit("close", 1, null);

  assert.equal((await failure).code, "TALKBACK_FORMAT_REJECTED");
});
