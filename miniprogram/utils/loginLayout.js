const COMPACT_MAX_HEIGHT = 760;
const REGULAR_MAX_HEIGHT = 860;

function getSafeViewportHeight(systemInfo = {}) {
  const safeArea = systemInfo.safeArea || {};
  const top = Number(safeArea.top);
  const bottom = Number(safeArea.bottom);

  if (Number.isFinite(top) && Number.isFinite(bottom) && bottom > top) {
    return bottom - top;
  }

  return Number(systemInfo.windowHeight) || 0;
}

function resolveLoginLayoutTier(viewportHeight) {
  const height = Number(viewportHeight) || 0;

  if (height <= COMPACT_MAX_HEIGHT) {
    return "compact";
  }

  if (height <= REGULAR_MAX_HEIGHT) {
    return "regular";
  }

  return "roomy";
}

module.exports = {
  COMPACT_MAX_HEIGHT,
  REGULAR_MAX_HEIGHT,
  getSafeViewportHeight,
  resolveLoginLayoutTier,
};
