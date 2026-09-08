const DEFAULT_STALL_THRESHOLD_MS = 3000;
const MEDIA_ADVANCE_EPSILON_SECONDS = 0.01;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function createPlaybackHealthTracker(options = {}) {
  const stallThresholdMs = Math.max(
    250,
    finiteNumber(options.stallThresholdMs, DEFAULT_STALL_THRESHOLD_MS)
  );
  const state = {
    startedAt: 0,
    lastEventAt: 0,
    lastAdvanceAt: 0,
    lastMediaTimeSec: 0,
    stallStartedAt: 0,
    completedStallMs: 0,
    longestStallMs: 0,
    waitingEvents: 0,
  };

  function start({ nowMs = Date.now(), mediaTimeSec = 0 } = {}) {
    const now = finiteNumber(nowMs, Date.now());
    state.startedAt = now;
    state.lastEventAt = now;
    state.lastAdvanceAt = now;
    state.lastMediaTimeSec = Math.max(0, finiteNumber(mediaTimeSec, 0));
    state.stallStartedAt = 0;
    state.completedStallMs = 0;
    state.longestStallMs = 0;
    state.waitingEvents = 0;
    return snapshot(now);
  }

  function activateStall(nowMs) {
    if (!state.lastAdvanceAt || state.stallStartedAt) return;
    if (nowMs - state.lastAdvanceAt >= stallThresholdMs) {
      state.stallStartedAt = state.lastAdvanceAt;
    }
  }

  function onProgress({ nowMs = Date.now(), mediaTimeSec } = {}) {
    const now = finiteNumber(nowMs, Date.now());
    const mediaTime = Number(mediaTimeSec);
    state.lastEventAt = now;
    if (!Number.isFinite(mediaTime)) {
      return { advanced: false, recovered: false, ...snapshot(now) };
    }
    const advanced = mediaTime > state.lastMediaTimeSec + MEDIA_ADVANCE_EPSILON_SECONDS;
    if (!advanced) {
      activateStall(now);
      return { advanced: false, recovered: false, ...snapshot(now) };
    }

    activateStall(now);
    let stallDurationMs = 0;
    if (state.stallStartedAt) {
      stallDurationMs = Math.max(0, now - state.stallStartedAt);
      state.completedStallMs += stallDurationMs;
      state.longestStallMs = Math.max(state.longestStallMs, stallDurationMs);
      state.stallStartedAt = 0;
    }
    state.lastAdvanceAt = now;
    state.lastMediaTimeSec = mediaTime;
    return {
      advanced: true,
      recovered: stallDurationMs >= stallThresholdMs,
      stallDurationMs,
      ...snapshot(now),
    };
  }

  function onWaiting(nowMs = Date.now()) {
    const now = finiteNumber(nowMs, Date.now());
    state.waitingEvents += 1;
    state.lastEventAt = now;
    activateStall(now);
    return snapshot(now);
  }

  function snapshot(nowMs = Date.now()) {
    const now = finiteNumber(nowMs, Date.now());
    activateStall(now);
    const activeStallMs = state.stallStartedAt
      ? Math.max(0, now - state.stallStartedAt)
      : 0;
    return {
      startedAt: state.startedAt,
      mediaTimeSec: state.lastMediaTimeSec,
      lastAdvanceAgoMs: state.lastAdvanceAt ? Math.max(0, now - state.lastAdvanceAt) : 0,
      stalled: activeStallMs >= stallThresholdMs,
      activeStallMs,
      totalStallMs: state.completedStallMs + activeStallMs,
      longestStallMs: Math.max(state.longestStallMs, activeStallMs),
      waitingEvents: state.waitingEvents,
    };
  }

  return { start, onProgress, onWaiting, snapshot };
}

module.exports = {
  DEFAULT_STALL_THRESHOLD_MS,
  createPlaybackHealthTracker,
};
