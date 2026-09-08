const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { captureLiveSnapshot } = require("./liveSnapshot");

test("captureLiveSnapshot extracts one scaled jpeg frame from the live URL", async () => {
  const calls = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", jpeg);
      child.emit("close", 0);
    });
    return child;
  };

  const result = await captureLiveSnapshot({
    sourceUrl: "https://device.example/live.flv",
    ffmpegPath: "ffmpeg-test",
    spawn,
  });

  assert.deepEqual(result, jpeg);
  assert.equal(calls[0].command, "ffmpeg-test");
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.match(calls[0].args.join(" "), /-i https:\/\/device\.example\/live\.flv/);
  assert.match(calls[0].args.join(" "), /-frames:v 1/);
  assert.match(calls[0].args.join(" "), /scale='min\(480,iw\)':-2/);
  assert.match(calls[0].args.join(" "), /-q:v 8/);
  assert.equal(calls[0].args.at(-1), "pipe:1");
});

test("captureLiveSnapshot rejects empty ffmpeg output", async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };

  await assert.rejects(
    captureLiveSnapshot({ sourceUrl: "https://device.example/live.flv", ffmpegPath: "ffmpeg", spawn }),
    /LIVE_SNAPSHOT_EMPTY/
  );
});

test("captureLiveSnapshot uses TCP for vendor RTSP replay sources", async () => {
  let receivedArgs = [];
  const spawn = (command, args) => {
    receivedArgs = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      child.emit("close", 0);
    });
    return child;
  };
  await captureLiveSnapshot({ sourceUrl: "rtsp://device.example/replay", ffmpegPath: "ffmpeg", spawn });
  assert.match(receivedArgs.join(" "), /-rtsp_transport tcp -i rtsp:\/\/device\.example\/replay/);
});

test("captureLiveSnapshot aborts ffmpeg when interactive playback preempts thumbnail work", async () => {
  const controller = new AbortController();
  let killedWith = "";
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => { killedWith = signal; };
    return child;
  };
  const pending = captureLiveSnapshot({
    sourceUrl: "rtsp://device.example/replay",
    ffmpegPath: "ffmpeg",
    spawn,
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(pending, /LIVE_SNAPSHOT_ABORTED/);
  assert.equal(killedWith, "SIGKILL");
});
