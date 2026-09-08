function monthKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normalizeLedger(input = {}, timestamp = Date.now()) {
  const currentMonth = monthKey(timestamp);
  if (input.month !== currentMonth) {
    return { month: currentMonth, billedSeconds: 0, runningSinceMs: 0 };
  }
  return {
    month: currentMonth,
    billedSeconds: Math.max(0, Number(input.billedSeconds) || 0),
    runningSinceMs: Math.max(0, Number(input.runningSinceMs) || 0),
  };
}

function accrueLedger(input = {}, timestamp = Date.now()) {
  const ledger = normalizeLedger(input, timestamp);
  if (!ledger.runningSinceMs) return ledger;
  return {
    ...ledger,
    billedSeconds: ledger.billedSeconds + Math.max(0, (timestamp - ledger.runningSinceMs) / 1000),
    runningSinceMs: timestamp,
  };
}

function estimatedMonthlySpend(input = {}) {
  const hourlyCny = Math.max(0, Number(input.hourlyCny) || 0);
  const fixedReserveCny = Math.max(0, Number(input.fixedReserveCny) || 0);
  const ledger = accrueLedger(input.ledger || {}, input.timestamp || Date.now());
  return fixedReserveCny + (ledger.billedSeconds / 3600) * hourlyCny;
}

function canStartWorker(input = {}) {
  const monthlyLimitCny = Math.max(0, Number(input.monthlyLimitCny) || 0);
  const minimumRunSeconds = Math.max(0, Number(input.minimumRunSeconds) || 3600);
  const current = estimatedMonthlySpend(input);
  const nextRun = minimumRunSeconds / 3600 * Math.max(0, Number(input.hourlyCny) || 0);
  return {
    allowed: monthlyLimitCny > 0 && current + nextRun <= monthlyLimitCny,
    estimatedCny: current,
    projectedCny: current + nextRun,
    remainingCny: Math.max(0, monthlyLimitCny - current),
  };
}

module.exports = {
  accrueLedger,
  canStartWorker,
  estimatedMonthlySpend,
  monthKey,
  normalizeLedger,
};
