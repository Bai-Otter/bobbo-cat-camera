const test = require("node:test");
const assert = require("node:assert/strict");

const { readDeviceClock, syncDeviceClock } = require("./deviceTimeSync");

test("readDeviceClock uses the official opdev time query", async () => {
  const calls = [];
  const result = await readDeviceClock({
    async opdev(payload) {
      calls.push(payload);
      return { Ret: 100, SessionID: "x", OPTimeQuery: "2026-09-01 10:00:01" };
    },
  });

  assert.deepEqual(calls, [{ Name: "OPTimeQuery" }]);
  assert.equal(result.deviceTime, "2026-09-01 10:00:01");
});

test("syncDeviceClock writes with opdev and verifies the readback", async () => {
  const calls = [];
  const now = new Date("2026-09-01T02:00:00.000Z");
  const result = await syncDeviceClock({
    async opdev(payload) {
      calls.push(payload);
      if (payload.Name === "OPTimeSetting") return { Ret: 100 };
      return { Ret: 100, Data: { OPTimeQuery: "2026-09-01 10:00:01" } };
    },
  }, now, { maxDriftMs: 2_000 });

  assert.deepEqual(calls, [
    { Name: "OPTimeSetting", OPTimeSetting: "2026-09-01 10:00:00" },
    { Name: "OPTimeQuery" },
  ]);
  assert.equal(result.synced, true);
  assert.equal(result.deviceTime, "2026-09-01 10:00:01");
  assert.equal(result.driftMs, 1_000);
});

test("syncDeviceClock reports a failed verification instead of a false success", async () => {
  const now = new Date("2026-09-01T02:00:00.000Z");
  const result = await syncDeviceClock({
    async opdev(payload) {
      return payload.Name === "OPTimeQuery"
        ? { Ret: 100, OPTimeQuery: "2026-08-31 15:00:00" }
        : { Ret: 100 };
    },
  }, now);

  assert.equal(result.synced, false);
  assert.ok(result.driftMs > 60 * 60 * 1000);
});
