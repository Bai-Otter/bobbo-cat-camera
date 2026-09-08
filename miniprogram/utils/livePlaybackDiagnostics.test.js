const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createLivePlaybackDiagnostics,
  extractLivePlaybackErrorCode
} = require('./livePlaybackDiagnostics')

test('live playback diagnostics stay dormant until the server enables the device', () => {
  const diagnostics = createLivePlaybackDiagnostics({ enabled: false, now: () => 1000, random: () => 0.5 })
  assert.equal(diagnostics.event('session_started', { source: 'app' }), null)
  diagnostics.setEnabled(true)
  const event = diagnostics.event('session_started', {
    source: 'app',
    token: 'must-not-survive',
    url: 'https://secret.example/live.m3u8'
  })
  assert.deepEqual(Object.keys(event), ['sessionId', 'event', 'source', 'errorCode'])
  assert.equal(JSON.stringify(event).includes('secret'), false)
});

test('diagnostics deduplicate stages per source and reset for a new playback attempt', () => {
  let clock = 1000
  const diagnostics = createLivePlaybackDiagnostics({ enabled: true, now: () => clock, random: () => 0.2 })
  assert.ok(diagnostics.event('stream_url_failed', { source: 'sdk', errorCode: '4101' }))
  assert.equal(diagnostics.event('stream_url_failed', { source: 'sdk', errorCode: '4101' }), null)
  assert.ok(diagnostics.event('stream_url_failed', { source: 'backend', errorCode: '502' }))
  const oldSession = diagnostics.sessionId
  clock += 1
  diagnostics.reset()
  assert.notEqual(diagnostics.sessionId, oldSession)
  assert.ok(diagnostics.event('stream_url_failed', { source: 'sdk', errorCode: '4101' }))
});

test('media playback is confirmed only after measured time progression', () => {
  const diagnostics = createLivePlaybackDiagnostics({ enabled: true, now: () => 1000, random: () => 0.3 })
  assert.equal(diagnostics.progress(0.2), null)
  assert.equal(diagnostics.progress(0.8), null)
  const confirmed = diagnostics.progress(1.21)
  assert.equal(confirmed.event, 'media_progress_confirmed')
  assert.equal(confirmed.source, 'player')
  assert.equal(diagnostics.progress(2.5), null)
});

test('SDK diagnostic error extraction prefers real Ret and vendor errors over success wrappers', () => {
  assert.equal(extractLivePlaybackErrorCode({ result: { code: 2000, data: { Ret: 4101 } } }), '4101')
  assert.equal(extractLivePlaybackErrorCode({ error: { code: 'SHARED_DEVICE_TOKEN_UNAVAILABLE' } }), 'SHARED_DEVICE_TOKEN_UNAVAILABLE')
  assert.equal(extractLivePlaybackErrorCode({ error: { message: 'device login failed code=4101' } }), '4101')
  assert.equal(extractLivePlaybackErrorCode({ result: { code: 2000, data: { Ret: 100 } } }), 'UNKNOWN')
});
