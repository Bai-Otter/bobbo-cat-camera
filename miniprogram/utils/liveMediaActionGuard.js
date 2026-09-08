function createMediaActionGuard(options = {}) {
  const schedule = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  const onTimeout = typeof options.onTimeout === "function" ? options.onTimeout : () => {};
  const timers = new Map();

  function clear(scope) {
    const key = String(scope || "");
    if (!timers.has(key)) return;
    cancel(timers.get(key));
    timers.delete(key);
  }

  function arm(scope, phase, timeoutMs) {
    const key = String(scope || "");
    clear(key);
    const timer = schedule(() => {
      if (timers.get(key) !== timer) return;
      timers.delete(key);
      onTimeout({ scope: key, phase: String(phase || "") });
    }, Math.max(1, Number(timeoutMs) || 1));
    timers.set(key, timer);
  }

  function clearAll() {
    [...timers.keys()].forEach(clear);
  }

  return { arm, clear, clearAll };
}

module.exports = { createMediaActionGuard };
