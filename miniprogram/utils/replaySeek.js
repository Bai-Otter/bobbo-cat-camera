function targetSecFromTrack({ clientX = 0, left = 0, width = 0, durationSec = 0 } = {}) {
  const safeWidth = Math.max(1, Number(width) || 0)
  const relative = Math.max(0, Math.min(safeWidth, (Number(clientX) || 0) - (Number(left) || 0)))
  return relative / safeWidth * Math.max(0, Number(durationSec) || 0)
}

module.exports = { targetSecFromTrack }
