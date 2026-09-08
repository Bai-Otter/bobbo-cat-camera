function normalizeTimestamp(value) {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

function selectRetainedArtifacts(items, options = {}) {
  const keep = Math.max(0, Number.parseInt(options.keep, 10) || 0)
  const protectedIds = new Set((options.protectedIds || []).map(String))
  const unique = new Map()

  for (const item of items || []) {
    if (!item || item.id === undefined || item.id === null) continue
    const id = String(item.id)
    const candidate = { ...item, id }
    const existing = unique.get(id)
    if (!existing || normalizeTimestamp(candidate.createdAt) > normalizeTimestamp(existing.createdAt)) {
      unique.set(id, candidate)
    }
  }

  const sorted = [...unique.values()].sort((left, right) => {
    const byTime = normalizeTimestamp(right.createdAt) - normalizeTimestamp(left.createdAt)
    return byTime || left.id.localeCompare(right.id)
  })
  const retainedIds = new Set()

  for (const item of sorted) {
    if (protectedIds.has(item.id)) retainedIds.add(item.id)
  }
  for (const item of sorted) {
    if (retainedIds.size >= keep) break
    retainedIds.add(item.id)
  }

  return {
    keep: sorted.filter((item) => retainedIds.has(item.id)),
    remove: sorted.filter((item) => !retainedIds.has(item.id)),
  }
}

module.exports = { selectRetainedArtifacts }
