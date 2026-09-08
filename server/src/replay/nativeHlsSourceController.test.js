const test = require("node:test");
const assert = require("node:assert/strict");

const { createNativeHlsSourceController } = require("./nativeHlsSourceController");

test("native HLS source controller maps lifecycle operations to device playback", async () => {
  const calls = [];
  const nativeClient = {
    async startPlayback(options) {
      calls.push(["start", options]);
    },
    async pausePlayback() {
      calls.push(["pause"]);
    },
    async seekTo(options) {
      calls.push(["seek", options]);
    },
    async resumePlayback() {
      calls.push(["resume"]);
    },
    async stopPlayback(options) {
      calls.push(["stop", options]);
    },
  };
  const controller = createNativeHlsSourceController({
    nativeClient,
    channel: 0,
    stream: "Main",
    beginTime: "2026-07-08 02:14:42",
    fileName: "/idea0/clip.h264",
    targetSec: 5,
  });
  const write = () => {};
  const onError = () => {};
  const onClose = () => {};

  await controller.start({ write, onError, onClose });
  await controller.pause();
  await controller.seek(24);
  await controller.resume();
  await controller.stop();

  assert.equal(calls[0][0], "start");
  assert.equal(calls[0][1].targetSec, 5);
  assert.equal(calls[0][1].onData, write);
  assert.equal(calls[0][1].onError, onError);
  assert.equal(calls[0][1].onClose, onClose);
  assert.deepEqual(calls[2], [
    "seek",
    {
      channel: 0,
      stream: "Main",
      beginTime: "2026-07-08 02:14:42",
      targetSec: 24,
    },
  ]);
  assert.deepEqual(calls[4], [
    "stop",
    {
      channel: 0,
      stream: "Main",
      beginTime: "2026-07-08 02:14:42",
    },
  ]);
});
