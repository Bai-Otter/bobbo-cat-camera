const test = require('node:test')
const assert = require('node:assert/strict')
const { selectRetainedArtifacts } = require('./ecs-retention-policy')

test('keeps only the three newest artifacts by default policy input', () => {
  const result = selectRetainedArtifacts([
    { id: 'a', createdAt: '2026-08-20T00:00:00Z' },
    { id: 'b', createdAt: '2026-08-21T00:00:00Z' },
    { id: 'c', createdAt: '2026-08-22T00:00:00Z' },
    { id: 'd', createdAt: '2026-08-23T00:00:00Z' },
  ], { keep: 3 })

  assert.deepEqual(result.keep.map((item) => item.id), ['d', 'c', 'b'])
  assert.deepEqual(result.remove.map((item) => item.id), ['a'])
})

test('protects the active image even when it is older than the rollback window', () => {
  const result = selectRetainedArtifacts([
    { id: 'active', createdAt: '2026-08-01T00:00:00Z' },
    { id: 'new-1', createdAt: '2026-08-24T00:00:00Z' },
    { id: 'new-2', createdAt: '2026-08-23T00:00:00Z' },
    { id: 'new-3', createdAt: '2026-08-22T00:00:00Z' },
  ], { keep: 3, protectedIds: ['active'] })

  assert.deepEqual(result.keep.map((item) => item.id), ['new-1', 'new-2', 'active'])
  assert.deepEqual(result.remove.map((item) => item.id), ['new-3'])
})

test('deduplicates image ids before applying retention', () => {
  const result = selectRetainedArtifacts([
    { id: 'same', createdAt: '2026-08-22T00:00:00Z' },
    { id: 'same', createdAt: '2026-08-23T00:00:00Z' },
    { id: 'other', createdAt: '2026-08-24T00:00:00Z' },
  ], { keep: 3 })

  assert.equal(result.keep.length, 2)
  assert.equal(result.remove.length, 0)
})
