const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { RecordingThumbnailService, buildRecordingKey } = require('./recordingThumbnailService')

test('recording keys are stable and thumbnail work is globally serialized and deduplicated', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobbo-thumbs-'))
  let active = 0
  let maxActive = 0
  let captures = 0
  const service = new RecordingThumbnailService({
    outputDir,
    sourceForRecord: async (sn, record) => `${sn}/${record.beginTime}`,
    capture: async ({ sourceUrl }) => {
      captures += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return Buffer.from(sourceUrl)
    },
  })
  const record = { beginTime: '2026-08-24 12:00:00', endTime: '2026-08-24 12:01:00', fileName: 'a' }
  const key = buildRecordingKey('SN1', record)
  assert.equal(key, buildRecordingKey('SN1', { ...record }))
  await Promise.all([
    service.enqueue('SN1', record),
    service.enqueue('SN1', record),
    service.enqueue('SN1', { ...record, fileName: 'b' }),
  ])
  assert.equal(captures, 2)
  assert.equal(maxActive, 1)
  assert.equal(service.state('SN1', record, 'https://example.test').thumbnailState, 'ready')
  assert.match(service.state('SN1', record, 'https://example.test').thumbnailUrl, /\/media\/replay-thumbnails\//)
})

test('thumbnail capture retries once and logs only a sanitized failure code', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobbo-thumbs-retry-'))
  const warnings = []
  let attempts = 0
  const service = new RecordingThumbnailService({
    outputDir,
    retryDelayMs: 0,
    failedCooldownMs: 1_000,
    logger: { warn: (...args) => warnings.push(args) },
    sourceForRecord: async () => 'rtsp://secret-token@example.test/live',
    capture: async () => {
      attempts += 1
      if (attempts < 2) {
        const error = new Error('rtsp://secret-token@example.test/live failed')
        error.code = 'SOURCE_UNAVAILABLE'
        throw error
      }
      return Buffer.from('jpeg')
    },
  })
  const record = { beginTime: '2026-08-24 12:00:00', endTime: '2026-08-24 12:01:00' }
  const result = await service.enqueue('SN-SECRET', record)
  assert.equal(result.ok, true)
  assert.equal(attempts, 2)
  assert.equal(warnings.length, 0)
})

test('thumbnail terminal failures do not log source urls or raw device ids', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobbo-thumbs-log-'))
  const warnings = []
  const service = new RecordingThumbnailService({
    outputDir,
    maxAttempts: 1,
    logger: { warn: (...args) => warnings.push(args) },
    sourceForRecord: async () => 'https://example.test/play?token=secret',
    capture: async () => {
      const error = new Error('https://example.test/play?token=secret')
      error.code = 'CAPTURE_FAILED'
      throw error
    },
  })
  const record = { beginTime: '2026-08-24 12:00:00', endTime: '2026-08-24 12:01:00' }
  const result = await service.enqueue('SN-SECRET', record)
  const serialized = JSON.stringify(warnings)
  assert.equal(result.error, 'CAPTURE_FAILED')
  assert.doesNotMatch(serialized, /token=secret|SN-SECRET/)
})

test('thumbnail capture falls through source candidates without requeueing', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobbo-thumbs-candidates-'))
  const seen = []
  const service = new RecordingThumbnailService({
    outputDir,
    maxAttempts: 1,
    sourceForRecord: async () => ['rtsp://first', 'https://second'],
    capture: async ({ sourceUrl }) => {
      seen.push(sourceUrl)
      if (sourceUrl.includes('first')) throw Object.assign(new Error('unavailable'), { code: 'SOURCE_UNAVAILABLE' })
      return Buffer.from('jpeg')
    },
  })
  const result = await service.enqueue('SN1', { beginTime: 'a', endTime: 'b' })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, ['rtsp://first', 'https://second'])
})

test('interactive playback pauses queued thumbnails and aborts the running capture', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobbo-thumbs-priority-'))
  let runningSignal
  const service = new RecordingThumbnailService({
    outputDir,
    maxAttempts: 1,
    sourceForRecord: async () => 'rtsp://first',
    capture: ({ signal }) => new Promise((resolve, reject) => {
      runningSignal = signal
      signal.addEventListener('abort', () => reject(new Error('LIVE_SNAPSHOT_ABORTED')), { once: true })
    }),
  })
  const first = service.enqueue('SN1', { beginTime: 'a', endTime: 'b' })
  const second = service.enqueue('SN1', { beginTime: 'c', endTime: 'd' })
  await new Promise((resolve) => setImmediate(resolve))

  const pause = service.pauseDevice('SN1', 60_000)
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(pause.paused, true)
  assert.equal(runningSignal.aborted, true)
  assert.equal(firstResult.ok, false)
  assert.equal(secondResult.error, 'THUMBNAIL_PAUSED')
  assert.equal((await service.enqueue('SN1', { beginTime: 'e', endTime: 'f' })).error, 'THUMBNAIL_PAUSED')
})
