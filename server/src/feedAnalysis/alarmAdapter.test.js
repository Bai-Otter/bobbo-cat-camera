const test = require("node:test");
const assert = require("node:assert/strict");

const { AlarmScanAdapter, buildAlarmScanWindows } = require("./alarmAdapter");

test("buildAlarmScanWindows converts alarm times into recording scan windows", () => {
  const windows = buildAlarmScanWindows(
    [
      { AlarmTime: "2026-07-14 10:00:30", Event: "Motion" },
      { time: "bad-date" },
    ],
    { paddingSeconds: 120 }
  );

  assert.deepEqual(windows, [
    {
      date: "2026-07-14",
      beginTime: "2026-07-14 09:58:30",
      endTime: "2026-07-14 10:02:30",
      alarm: { AlarmTime: "2026-07-14 10:00:30", Event: "Motion" },
    },
  ]);
});

test("AlarmScanAdapter returns alarm windows and swallows alarm API failures", async () => {
  const calls = [];
  const adapter = new AlarmScanAdapter({ paddingSeconds: 60 });
  const device = {
    async getDeviceAlarmList(query) {
      calls.push(query);
      return [{ alarmTime: "2026-07-14 12:00:00" }];
    },
  };

  const windows = await adapter.fetchWindows(device, { date: "2026-07-14" });
  const failed = await adapter.fetchWindows(
    {
      async getDeviceAlarmList() {
        throw new Error("alarm api unavailable");
      },
    },
    { date: "2026-07-14" }
  );

  assert.deepEqual(calls[0], {
    beginTime: "2026-07-14 00:00:00",
    endTime: "2026-07-14 23:59:59",
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].beginTime, "2026-07-14 11:59:00");
  assert.deepEqual(failed, []);
});

test("AlarmScanAdapter times out slow alarm APIs so scans can fall back to polling", async () => {
  const adapter = new AlarmScanAdapter({ paddingSeconds: 60, timeoutMs: 5 });
  const startedAt = Date.now();
  const windows = await adapter.fetchWindows(
    {
      async getDeviceAlarmList() {
        return new Promise(() => {});
      },
    },
    { date: "2026-07-14" }
  );

  assert.deepEqual(windows, []);
  assert.ok(Date.now() - startedAt < 100);
});

test("AlarmScanAdapter keeps its timeout referenced until a slow alarm API is released", async () => {
  const originalSetTimeout = global.setTimeout;
  let unrefCalls = 0;
  global.setTimeout = (callback, timeoutMs) => {
    const timer = originalSetTimeout(callback, timeoutMs);
    timer.unref = () => {
      unrefCalls += 1;
      return timer;
    };
    return timer;
  };

  try {
    const adapter = new AlarmScanAdapter({ timeoutMs: 5 });
    const windows = await adapter.fetchWindows(
      { getDeviceAlarmList: () => new Promise(() => {}) },
      { date: "2026-07-14" }
    );

    assert.deepEqual(windows, []);
    assert.equal(unrefCalls, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
