const LIVE_PLAYBACK_EVENTS = new Set([
  'session_started',
  'shared_access_granted',
  'shared_access_failed',
  'device_login_succeeded',
  'device_login_failed',
  'stream_url_succeeded',
  'stream_url_failed',
  'video_play',
  'media_progress_confirmed',
  'video_error',
  'playback_failed',
  'session_ended'
])

const LIVE_PLAYBACK_SOURCES = new Set(['app', 'sdk', 'backend', 'player'])

function cleanCode(value) {
  const text = String(value === undefined || value === null ? '' : value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '')
  return text.slice(0, 80)
}

function nestedValue(input, path) {
  let current = input
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function extractLivePlaybackErrorCode(input) {
  const values = [
    nestedValue(input, ['error', 'code']),
    nestedValue(input, ['result', 'Ret']),
    nestedValue(input, ['result', 'data', 'Ret']),
    nestedValue(input, ['result', 'data', 'data', 'Ret']),
    nestedValue(input, ['result', 'code']),
    nestedValue(input, ['result', 'data', 'code']),
    nestedValue(input, ['error', 'errCode']),
    nestedValue(input, ['error', 'message']),
    nestedValue(input, ['error', 'errMsg'])
  ]
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    const text = String(value)
    if (text === '100' || text === '2000') continue
    const named = text.match(/\b(?:DEVICE|DEV|AUTH|SESSION|LIVE|SDK|SHARED)_[A-Z0-9_]+\b/i)
    if (named) return cleanCode(named[0])
    const numeric = text.match(/(?:(?:code|ret|errcode)[=:"' ]+)?(-?\d{3,8})/i)
    if (numeric) return cleanCode(numeric[1])
    const cleaned = cleanCode(text)
    if (cleaned) return cleaned
  }
  return 'UNKNOWN'
}

function createSessionId(now, random) {
  const timestamp = Math.max(0, Number(now()) || Date.now()).toString(36)
  const entropy = Math.floor(Math.max(0, Math.min(0.999999999, Number(random()) || 0)) * 1e12)
    .toString(36)
    .padStart(8, '0')
  return `live_${timestamp}_${entropy}`.slice(0, 80)
}

function createLivePlaybackDiagnostics(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const random = typeof options.random === 'function' ? options.random : Math.random
  let enabled = !!options.enabled
  let sessionId = createSessionId(now, random)
  let progressBaseline = null
  let progressConfirmed = false
  let reported = new Set()

  function reset(resetOptions = {}) {
    enabled = resetOptions.enabled === undefined ? enabled : !!resetOptions.enabled
    sessionId = createSessionId(now, random)
    progressBaseline = null
    progressConfirmed = false
    reported = new Set()
    return sessionId
  }

  function setEnabled(value) {
    enabled = !!value
  }

  function event(eventName, details = {}) {
    if (!enabled || !LIVE_PLAYBACK_EVENTS.has(eventName)) return null
    const source = String(details.source || 'app').trim().toLowerCase()
    if (!LIVE_PLAYBACK_SOURCES.has(source)) return null
    const key = `${eventName}:${source}`
    if (reported.has(key)) return null
    reported.add(key)
    return {
      sessionId,
      event: eventName,
      source,
      errorCode: details.errorCode ? cleanCode(details.errorCode) : ''
    }
  }

  function progress(mediaTimeSec) {
    if (!enabled || progressConfirmed) return null
    const value = Number(mediaTimeSec)
    if (!Number.isFinite(value) || value < 0) return null
    if (progressBaseline === null || value < progressBaseline) {
      progressBaseline = value
      return null
    }
    if (value - progressBaseline < 1) return null
    progressConfirmed = true
    return event('media_progress_confirmed', { source: 'player' })
  }

  return {
    event,
    progress,
    reset,
    setEnabled,
    get enabled() { return enabled },
    get sessionId() { return sessionId }
  }
}

module.exports = {
  createLivePlaybackDiagnostics,
  extractLivePlaybackErrorCode
}
