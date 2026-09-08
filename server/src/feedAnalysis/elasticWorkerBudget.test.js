const test = require("node:test");
const assert = require("node:assert/strict");

const { accrueLedger, canStartWorker, normalizeLedger } = require("./elasticWorkerBudget");

test("budget ledger rotates monthly and accrues only active time", () => {
  const september = Date.parse("2026-09-03T00:00:00Z");
  assert.deepEqual(normalizeLedger({ month: "2026-08", billedSeconds: 999 }, september), {
    month: "2026-09",
    billedSeconds: 0,
    runningSinceMs: 0,
  });
  assert.equal(accrueLedger({ month: "2026-09", billedSeconds: 60, runningSinceMs: september }, september + 60_000).billedSeconds, 120);
});

test("budget guard reserves fixed cost and refuses a run above 100 CNY", () => {
  const timestamp = Date.parse("2026-09-03T00:00:00Z");
  const common = {
    hourlyCny: 0.07866,
    fixedReserveCny: 20,
    monthlyLimitCny: 100,
    minimumRunSeconds: 3600,
    timestamp,
  };
  assert.equal(canStartWorker({ ...common, ledger: { month: "2026-09", billedSeconds: 0 } }).allowed, true);
  assert.equal(canStartWorker({
    ...common,
    ledger: { month: "2026-09", billedSeconds: (80 / 0.07866) * 3600 },
  }).allowed, false);
});
