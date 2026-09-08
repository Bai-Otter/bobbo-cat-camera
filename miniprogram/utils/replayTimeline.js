const { buildReplayMarkerRanges } = require('./feedAnalysis.js')

function parseLocal(value) {
  const parsed = new Date(String(value || '').replace(' ', 'T'))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function roundedPercent(value) {
  return Math.round(Math.max(0, Math.min(100, Number(value) || 0)) * 1000) / 1000
}

function timeMs(value) {
  if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value)
  const parsed = parseLocal(value)
  return parsed ? parsed.getTime() : 0
}

function markerTimeMs(marker = {}) {
  return timeMs(marker.beginTime) || timeMs(marker.markerTsMs)
}

function markerEndTimeMs(marker = {}) {
  return timeMs(marker.endTime) || markerTimeMs(marker)
}

function recordBounds(record = {}) {
  const startMs = timeMs(record.beginTime || record.BeginTime)
  let endMs = timeMs(record.endTime || record.EndTime)
  if (!endMs && startMs) endMs = startMs + Math.max(0, Number(record.durationSec || record.duration) || 0) * 1000
  return { startMs, endMs }
}

function markerRangeKind(marker = {}) {
  const type = String(marker.markerType || '')
  if (/^feeding_/.test(type)) return 'feeding'
  if (/^(cat|face)_/.test(type)) return 'cat'
  return ''
}

function buildAbsoluteMarkerRanges(markers = []) {
  const pending = { cat: 0, feeding: 0 }
  const ranges = []
  const sorted = (Array.isArray(markers) ? markers : [])
    .filter((marker) => markerRangeKind(marker) && markerTimeMs(marker))
    .slice()
    .sort((left, right) => markerTimeMs(left) - markerTimeMs(right))

  for (const marker of sorted) {
    const target = markerRangeKind(marker)
    const type = String(marker.markerType || '')
    const startMs = markerTimeMs(marker)
    const endMs = markerEndTimeMs(marker)
    if (/_(enter|start)$/.test(type)) {
      if (endMs > startMs) {
        ranges.push({ target, startMs, endMs })
        pending[target] = 0
      } else {
        // Duplicate analyses can leave an unmatched enter in the same day.
        // Keep only the newest open edge so a later leave never creates an
        // artificial multi-hour cat-presence band.
        pending[target] = startMs
      }
      continue
    }
    if (/_(leave|end)$/.test(type) && pending[target]) {
      const pendingStart = pending[target]
      pending[target] = 0
      if (startMs > pendingStart) ranges.push({ target, startMs: pendingStart, endMs: startMs })
    }
  }
  return ranges
}

function buildAbsoluteMealRanges(meals = []) {
  return (Array.isArray(meals) ? meals : []).map((meal) => {
    const startMs = timeMs(meal && (meal.startTime || meal.beginTime || meal.startMs))
    const endMs = timeMs(meal && (meal.endTime || meal.finishTime || meal.endMs))
    if (!startMs || !endMs || endMs <= startMs) return null
    return { target: 'feeding', startMs, endMs }
  }).filter(Boolean)
}

function buildDayTimelineGeometry(records = [], markers = [], meals = []) {
  const bounds = (Array.isArray(records) ? records : []).map(recordBounds).filter((item) => item.startMs && item.endMs > item.startMs)
  if (!bounds.length) return { startMs: 0, endMs: 0, segments: [] }
  const startMs = Math.min(...bounds.map((item) => item.startMs))
  const endMs = Math.max(...bounds.map((item) => item.endMs))
  const spanMs = Math.max(1, endMs - startMs)
  const mealRanges = buildAbsoluteMealRanges(meals)
  const markerRanges = buildAbsoluteMarkerRanges(markers)
    .filter((range) => range.target !== 'feeding' || mealRanges.length === 0)
  const segments = markerRanges.concat(mealRanges).map((range) => {
    const clippedStart = Math.max(startMs, Math.min(endMs, range.startMs))
    const clippedEnd = Math.max(clippedStart, Math.min(endMs, range.endMs))
    return {
      target: range.target,
      startMs: clippedStart,
      endMs: clippedEnd,
      topPercent: roundedPercent((endMs - clippedEnd) / spanMs * 100),
      heightPercent: roundedPercent((clippedEnd - clippedStart) / spanMs * 100),
    }
  }).filter((segment) => segment.heightPercent > 0)
    .sort((left, right) => {
      if (left.target !== right.target) return left.target === 'cat' ? -1 : 1
      return left.topPercent - right.topPercent
    })
  return { startMs, endMs, segments }
}

function buildRecordingTimelineSegments(markers = [], durationSec = 0) {
  const duration = Math.max(0, Number(durationSec) || 0)
  const ranges = duration > 0 ? buildReplayMarkerRanges(markers, duration) : []
  const segments = ranges
    .map((range) => ({
      target: range.target === 'feeding' ? 'feeding' : 'cat',
      topPercent: roundedPercent(range.leftPercent),
      heightPercent: roundedPercent(range.widthPercent),
    }))
    .filter((range) => range.heightPercent > 0)
    .sort((a, b) => {
      if (a.target !== b.target) return a.target === 'cat' ? -1 : 1
      return a.topPercent - b.topPercent
    })

  if (segments.length > 0) return segments
  const tone = markerTone(markers)
  if (tone === 'recording') return []
  return [{ target: tone, topPercent: 0, heightPercent: 100 }]
}

function markerTone(markers = []) {
  if (markers.some((marker) => /^feeding_/.test(String(marker && marker.markerType || '')))) return 'feeding'
  if (markers.some((marker) => /^(cat|face)_/.test(String(marker && marker.markerType || '')))) return 'cat'
  return 'recording'
}

function buildDayReplayTimeline(records = [], date = '') {
  return (Array.isArray(records) ? records : []).map((record, index) => {
    const begin = parseLocal(record.beginTime || record.BeginTime)
    if (!begin) return null
    const minutes = begin.getHours() * 60 + begin.getMinutes() + begin.getSeconds() / 60
    return {
      key: record.recordingKey || `${date}-${index}-${minutes}`,
      record,
      tone: markerTone(Array.isArray(record.markers) ? record.markers : []),
      topPercent: minutes / (24 * 60) * 100,
      timeLabel: String(begin.getHours()).padStart(2, '0') + ':' + String(begin.getMinutes()).padStart(2, '0')
    }
  }).filter(Boolean)
}

module.exports = {
  buildAbsoluteMarkerRanges,
  buildAbsoluteMealRanges,
  buildDayReplayTimeline,
  buildDayTimelineGeometry,
  buildRecordingTimelineSegments,
  markerTone,
}
