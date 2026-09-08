const test = require('node:test')
const assert = require('node:assert/strict')
const {
  fetchPageData,
  invalidatePageDataTags,
  mutationTags,
  readPageData,
  writePageData,
} = require('./pageDataCache.js')

function storage(openid = 'user-a', backendBaseUrl = 'https://tunnel-a.test') {
  const values = new Map([
    ['catBackendSession', JSON.stringify({ sessionToken: 'session', openid, userId: openid })],
    ['userProfile', JSON.stringify({ openid })],
    ['catBackendBaseUrl', backendBaseUrl],
  ])
  return {
    getStorageSync: (key) => values.get(key) || '',
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
  }
}

test('page data cache is account scoped, expires, and is invalidated by tag versions', () => {
  const first = storage('user-a')
  const second = storage('user-b')
  writePageData('today:2026-08-24', { count: 2 }, { uniApi: first, tags: ['today'], nowMs: 1_000 })
  assert.deepEqual(readPageData('today:2026-08-24', { uniApi: first, tags: ['today'], nowMs: 2_000 }), { count: 2 })
  assert.equal(readPageData('today:2026-08-24', { uniApi: second, tags: ['today'], nowMs: 2_000 }), null)
  assert.equal(readPageData('today:2026-08-24', { uniApi: first, tags: ['today'], nowMs: 2_000_000, ttlMs: 100 }), null)
  invalidatePageDataTags(['today'], first)
  assert.equal(readPageData('today:2026-08-24', { uniApi: first, tags: ['today'], nowMs: 2_000 }), null)
})

test('concurrent page refreshes are deduplicated', async () => {
  const api = storage()
  let calls = 0
  const fetcher = async () => { calls += 1; return { calls } }
  const [first, second] = await Promise.all([
    fetchPageData('clips', { uniApi: api, tags: ['clips'], fetcher }),
    fetchPageData('clips', { uniApi: api, tags: ['clips'], fetcher }),
  ])
  assert.equal(calls, 1)
  assert.deepEqual(first, second)
})

test('only data-changing backend routes invalidate dashboard tags', () => {
  assert.deepEqual(mutationTags('/api/devices/SN/live-priority', 'POST'), [])
  assert.deepEqual(mutationTags('/api/devices/SN/nickname', 'PUT'), ['devices', 'cats', 'today', 'profile', 'live', 'clips'])
  assert.deepEqual(mutationTags('/api/cats/cat-1', 'DELETE'), ['cats', 'today', 'profile'])
})
