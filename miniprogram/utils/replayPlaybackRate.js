const REPLAY_PLAYBACK_RATES = Object.freeze([0.5, 1, 1.5, 2]);

function normalizeReplayPlaybackRate(value) {
  const numeric = Number(value);
  return REPLAY_PLAYBACK_RATES.includes(numeric) ? numeric : 1;
}

function formatReplayPlaybackRate(value) {
  return `${normalizeReplayPlaybackRate(value)}x`;
}

module.exports = {
  REPLAY_PLAYBACK_RATES,
  normalizeReplayPlaybackRate,
  formatReplayPlaybackRate,
};
