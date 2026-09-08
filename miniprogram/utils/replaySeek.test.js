const test = require('node:test')
const assert = require('node:assert/strict')

const { targetSecFromTrack } = require('./replaySeek.js')

test('replay seek uses the measured track rectangle', () => {
  assert.equal(targetSecFromTrack({ clientX: 160, left: 40, width: 240, durationSec: 3600 }), 1800)
  assert.equal(targetSecFromTrack({ clientX: 0, left: 40, width: 240, durationSec: 3600 }), 0)
  assert.equal(targetSecFromTrack({ clientX: 400, left: 40, width: 240, durationSec: 3600 }), 3600)
})
