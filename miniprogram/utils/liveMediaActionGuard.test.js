const test = require("node:test");
const assert = require("node:assert/strict");

const { createMediaActionGuard } = require("./liveMediaActionGuard.js");

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback) {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runAll() {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

test("media action guard replaces and clears scoped timeouts", () => {
  const events = [];
  const timers = fakeTimers();
  const guard = createMediaActionGuard({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onTimeout: (event) => events.push(event),
  });

  guard.arm("record", "starting", 15000);
  guard.arm("record", "stopping", 10000);
  timers.runAll();
  assert.deepEqual(events, [{ scope: "record", phase: "stopping" }]);

  guard.arm("talk", "starting", 15000);
  guard.clear("talk");
  timers.runAll();
  assert.equal(events.length, 1);
});

test("media action guard clears every pending scope", () => {
  const events = [];
  const timers = fakeTimers();
  const guard = createMediaActionGuard({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onTimeout: (event) => events.push(event),
  });

  guard.arm("record", "starting", 15000);
  guard.arm("talk", "stopping", 10000);
  guard.clearAll();
  timers.runAll();

  assert.deepEqual(events, []);
});
