const test = require("node:test");
const assert = require("node:assert/strict");

const { resetUnbindAndRemoveDevice } = require("./factoryResetFlow.js");

test("factory reset flow resets, unbinds, then removes the owned device", async () => {
  const calls = [];

  await resetUnbindAndRemoveDevice({
    resetDevice: async () => calls.push("reset"),
    unbindDevice: async () => calls.push("unbind"),
    removeDevice: async () => calls.push("remove"),
  });

  assert.deepEqual(calls, ["reset", "unbind", "remove"]);
});

test("factory reset flow keeps the device record when unbinding fails", async () => {
  const calls = [];

  await assert.rejects(
    resetUnbindAndRemoveDevice({
      resetDevice: async () => calls.push("reset"),
      unbindDevice: async () => {
        calls.push("unbind");
        throw new Error("UNBIND_FAILED");
      },
      removeDevice: async () => calls.push("remove"),
    }),
    /UNBIND_FAILED/
  );

  assert.deepEqual(calls, ["reset", "unbind"]);
});

test("factory reset flow does not unbind when the reset command fails", async () => {
  const calls = [];

  await assert.rejects(
    resetUnbindAndRemoveDevice({
      resetDevice: async () => {
        calls.push("reset");
        throw new Error("RESET_FAILED");
      },
      unbindDevice: async () => calls.push("unbind"),
      removeDevice: async () => calls.push("remove"),
    }),
    /RESET_FAILED/
  );

  assert.deepEqual(calls, ["reset"]);
});
