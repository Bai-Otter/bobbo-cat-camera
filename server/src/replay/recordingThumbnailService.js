const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function cleanPart(value) {
  return String(value || '').trim()
}

function buildRecordingKey(deviceSn, record = {}) {
  const raw = [
    cleanPart(deviceSn),
    cleanPart(record.beginTime || record.BeginTime),
    cleanPart(record.endTime || record.EndTime),
    cleanPart(record.fileName || record.FileName),
  ].join('|')
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

function safeFailureCode(error) {
  const message = String(error && error.message || error || '')
  const stableMessageCode = message.match(/\b(?:LIVE_SNAPSHOT|THUMBNAIL)_[A-Z0-9_]+\b/)
  const inferred = stableMessageCode?.[0]
    || (/\b401\b|unauthorized/i.test(message) ? 'SOURCE_UNAUTHORIZED' : '')
    || (/\b403\b|forbidden/i.test(message) ? 'SOURCE_FORBIDDEN' : '')
    || (/\b404\b|not found/i.test(message) ? 'SOURCE_NOT_FOUND' : '')
    || (/timed?\s*out|timeout/i.test(message) ? 'SOURCE_TIMEOUT' : '')
    || (/invalid data/i.test(message) ? 'SOURCE_INVALID_DATA' : '')
    || (/connection refused/i.test(message) ? 'SOURCE_CONNECTION_REFUSED' : '')
  const raw = String(error && error.code || inferred || error && error.name || 'THUMBNAIL_CAPTURE_FAILED')
  return raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'THUMBNAIL_CAPTURE_FAILED'
}

function safeSourceKind(value) {
  try {
    const parsed = new URL(String(value || ''))
    const extension = path.extname(parsed.pathname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10)
    return `${parsed.protocol.replace(':', '')}${extension || ''}`
  } catch (error) {
    return 'unknown'
  }
}

class RecordingThumbnailService {
  constructor({
    outputDir,
    capture,
    sourceForRecord,
    timeoutMs = 20_000,
    maxAttempts = 2,
    retryDelayMs = 1_500,
    failedCooldownMs = 30_000,
    logger = console,
  } = {}) {
    this.outputDir = outputDir
    this.capture = capture
    this.sourceForRecord = sourceForRecord
    this.timeoutMs = timeoutMs
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 1)
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0)
    this.failedCooldownMs = Math.max(1_000, Number(failedCooldownMs) || 30_000)
    this.logger = logger
    this.queue = []
    this.pending = new Map()
    this.failedUntil = new Map()
    this.pausedDevices = new Map()
    this.runningTask = null
    this.running = false
    fs.mkdirSync(this.outputDir, { recursive: true })
  }

  filePath(key) {
    return path.join(this.outputDir, `${key}.jpg`)
  }

  state(deviceSn, record, baseUrl = '') {
    const recordingKey = buildRecordingKey(deviceSn, record)
    if (fs.existsSync(this.filePath(recordingKey))) {
      return {
        recordingKey,
        thumbnailState: 'ready',
        thumbnailUrl: `${String(baseUrl || '').replace(/\/$/, '')}/media/replay-thumbnails/${recordingKey}.jpg`,
      }
    }
    if (Number(this.failedUntil.get(recordingKey)) > Date.now()) {
      return { recordingKey, thumbnailState: 'error', thumbnailUrl: '' }
    }
    return {
      recordingKey,
      thumbnailState: this.pending.has(recordingKey) ? 'pending' : 'missing',
      thumbnailUrl: '',
    }
  }

  enqueue(deviceSn, record) {
    const recordingKey = buildRecordingKey(deviceSn, record)
    if (this.isDevicePaused(deviceSn)) {
      return Promise.resolve({ ok: false, recordingKey, deferred: true, error: 'THUMBNAIL_PAUSED' })
    }
    if (fs.existsSync(this.filePath(recordingKey))) return Promise.resolve(this.state(deviceSn, record))
    if (Number(this.failedUntil.get(recordingKey)) > Date.now()) {
      return Promise.resolve({ ok: false, recordingKey, error: 'THUMBNAIL_RETRY_COOLDOWN' })
    }
    if (this.pending.has(recordingKey)) return this.pending.get(recordingKey)
    let resolveTask
    const promise = new Promise((resolve) => { resolveTask = resolve })
    this.pending.set(recordingKey, promise)
    this.queue.push({ deviceSn, record, recordingKey, resolveTask })
    this.drain()
    return promise
  }

  pauseDevice(deviceSn, durationMs = 120_000) {
    const sn = cleanPart(deviceSn)
    if (!sn) return { ok: false, paused: false }
    const until = Date.now() + Math.max(0, Number(durationMs) || 0)
    this.pausedDevices.set(sn, Math.max(Number(this.pausedDevices.get(sn)) || 0, until))
    const retained = []
    for (const task of this.queue) {
      if (cleanPart(task.deviceSn) !== sn) {
        retained.push(task)
        continue
      }
      this.pending.delete(task.recordingKey)
      task.resolveTask({ ok: false, recordingKey: task.recordingKey, deferred: true, error: 'THUMBNAIL_PAUSED' })
    }
    this.queue = retained
    if (cleanPart(this.runningTask?.deviceSn) === sn) this.runningTask.controller.abort()
    return { ok: true, paused: true, deviceSn: sn, until: this.pausedDevices.get(sn) }
  }

  isDevicePaused(deviceSn) {
    const sn = cleanPart(deviceSn)
    const until = Number(this.pausedDevices.get(sn)) || 0
    if (until > Date.now()) return true
    if (until) this.pausedDevices.delete(sn)
    return false
  }

  async drain() {
    if (this.running) return
    this.running = true
    while (this.queue.length > 0) {
      const task = this.queue.shift()
      if (this.isDevicePaused(task.deviceSn)) {
        this.pending.delete(task.recordingKey)
        task.resolveTask({ ok: false, recordingKey: task.recordingKey, deferred: true, error: 'THUMBNAIL_PAUSED' })
        continue
      }
      task.controller = new AbortController()
      this.runningTask = task
      let outcome
      let sourceKinds = []
      try {
        let lastError
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
          try {
            const resolvedSources = await this.sourceForRecord(task.deviceSn, task.record, {
              signal: task.controller.signal,
            })
            const sourceUrls = (Array.isArray(resolvedSources) ? resolvedSources : [resolvedSources]).filter(Boolean)
            sourceKinds = Array.from(new Set(sourceUrls.map(safeSourceKind)))
            if (sourceUrls.length === 0) throw new Error('THUMBNAIL_SOURCE_UNAVAILABLE')
            for (const sourceUrl of sourceUrls) {
              try {
                const jpeg = await this.capture({
                  sourceUrl,
                  timeoutMs: this.timeoutMs,
                  signal: task.controller.signal,
                })
                fs.writeFileSync(this.filePath(task.recordingKey), jpeg)
                lastError = null
                break
              } catch (error) {
                lastError = error
              }
            }
            if (!lastError) break
          } catch (error) {
            lastError = error
          }
          if (lastError && attempt < this.maxAttempts && this.retryDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
          }
        }
        if (lastError) throw lastError
        this.failedUntil.delete(task.recordingKey)
        outcome = { ok: true, recordingKey: task.recordingKey }
      } catch (error) {
        const errorCode = safeFailureCode(error)
        this.failedUntil.set(task.recordingKey, Date.now() + this.failedCooldownMs)
        this.logger?.warn?.('[replay-thumbnail] capture failed', {
          deviceHash: crypto.createHash('sha256').update(cleanPart(task.deviceSn)).digest('hex').slice(0, 12),
          recordingKey: task.recordingKey,
          errorCode,
          sourceKinds,
        })
        outcome = { ok: false, recordingKey: task.recordingKey, error: errorCode }
      } finally {
        if (this.runningTask === task) this.runningTask = null
        this.pending.delete(task.recordingKey)
        task.resolveTask(outcome)
      }
    }
    this.running = false
  }
}

module.exports = { RecordingThumbnailService, buildRecordingKey }
