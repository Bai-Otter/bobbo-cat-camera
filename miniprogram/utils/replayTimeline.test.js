const test = require('node:test')
const assert = require('node:assert/strict')

const { buildDayReplayTimeline, buildDayTimelineGeometry, buildRecordingTimelineSegments } = require('./replayTimeline.js')

test('vertical replay timeline colors recordings with cat and feeding markers', () => {
  const records = [{
    recordingKey: '2026-08-31 10:00:00__a.mp4',
    beginTime: '2026-08-31 10:00:00',
    endTime: '2026-08-31 11:00:00',
    markers: [
      { markerType: 'cat_enter', offsetSec: 60 },
      { markerType: 'feeding_start', offsetSec: 120 },
    ]
  }]
  const points = buildDayReplayTimeline(records, '2026-08-31')
  assert.equal(points.length, 1)
  assert.equal(points[0].tone, 'feeding')
  assert.equal(points[0].topPercent, 10 / 24 * 100)
});

test('recording timeline turns paired markers into continuous vertical color bands', () => {
  const segments = buildRecordingTimelineSegments([
    { markerType: 'cat_enter', offsetSec: 600 },
    { markerType: 'feeding_start', offsetSec: 1200 },
    { markerType: 'feeding_end', offsetSec: 1800 },
    { markerType: 'cat_leave', offsetSec: 2400 },
  ], 3600)

  assert.deepEqual(segments, [
    { target: 'cat', topPercent: 16.667, heightPercent: 50 },
    { target: 'feeding', topPercent: 33.333, heightPercent: 16.667 },
  ])
})

test('recording timeline colors the full band when only a positive marker is available', () => {
  assert.deepEqual(
    buildRecordingTimelineSegments([{ markerType: 'feeding_start', offsetSec: 0 }], 0),
    [{ target: 'feeding', topPercent: 0, heightPercent: 100 }]
  )
})

test('day timeline maps marker windows by absolute time even without recording keys', () => {
  const geometry = buildDayTimelineGeometry([
    { beginTime: '2026-08-22 10:00:00', endTime: '2026-08-22 11:00:00' },
    { beginTime: '2026-08-22 11:00:00', endTime: '2026-08-22 12:00:00' },
  ], [
    { markerType: 'cat_enter', beginTime: '2026-08-22 10:04:00' },
    { markerType: 'cat_leave', beginTime: '2026-08-22 10:06:00' },
    { markerType: 'feeding_start', beginTime: '2026-08-22 10:04:46', endTime: '2026-08-22 10:05:51' },
    { markerType: 'feeding_end', beginTime: '2026-08-22 10:05:51' },
  ])

  assert.deepEqual(geometry.segments.map((segment) => segment.target), ['cat', 'feeding'])
  assert.equal(geometry.segments[0].topPercent, 95)
  assert.equal(geometry.segments[0].heightPercent, 1.667)
  assert.equal(geometry.segments[1].topPercent, 95.125)
  assert.equal(geometry.segments[1].heightPercent, 0.903)
})

test('day timeline uses canonical diary meals as complete feeding intervals', () => {
  const geometry = buildDayTimelineGeometry([
    { beginTime: '2026-08-22 10:00:00', endTime: '2026-08-22 11:00:00' },
  ], [
    { markerType: 'cat_enter', beginTime: '2026-08-22 10:04:00' },
    { markerType: 'cat_leave', beginTime: '2026-08-22 10:06:00' },
    { markerType: 'feeding_start', beginTime: '2026-08-22 10:04:46' },
  ], [
    { startTime: '2026-08-22 10:04:46', endTime: '2026-08-22 10:05:51' },
  ])

  assert.deepEqual(geometry.segments.map((segment) => segment.target), ['cat', 'feeding'])
  assert.equal(geometry.segments[1].startMs, new Date('2026-08-22T10:04:46').getTime())
  assert.equal(geometry.segments[1].endMs, new Date('2026-08-22T10:05:51').getTime())
  assert.equal(geometry.segments[1].heightPercent, 1.806)
})

test('day timeline ignores an isolated feeding start when no complete meal exists', () => {
  const geometry = buildDayTimelineGeometry([
    { beginTime: '2026-08-22 10:00:00', endTime: '2026-08-22 11:00:00' },
  ], [
    { markerType: 'feeding_start', beginTime: '2026-08-22 10:04:46' },
  ])

  assert.deepEqual(geometry.segments, [])
})

test('duplicate unmatched cat enters do not create a cross-hour green interval', () => {
  const ranges = buildDayTimelineGeometry([
    { beginTime: '2026-08-22 08:00:00', endTime: '2026-08-22 11:00:00' },
  ], [
    { markerType: 'cat_enter', beginTime: '2026-08-22 08:00:12' },
    { markerType: 'cat_enter', beginTime: '2026-08-22 10:04:46' },
    { markerType: 'cat_leave', beginTime: '2026-08-22 10:06:18' },
  ]).segments

  assert.equal(ranges.length, 1)
  assert.equal(ranges[0].startMs, new Date('2026-08-22T10:04:46').getTime())
  assert.equal(ranges[0].endMs, new Date('2026-08-22T10:06:18').getTime())
})
