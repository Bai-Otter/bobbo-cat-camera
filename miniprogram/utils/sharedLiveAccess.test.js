const test = require('node:test')
const assert = require('node:assert/strict')

const {
	SHARED_ACCESS_TTL_MS,
	ensureSharedLiveAccess,
	invalidateSharedLiveAccess,
	readCachedSharedAccess,
	retainAccessibleSharedDevices
} = require('./sharedLiveAccess.js')

test('shared live access is granted once and reused across reconnects', async () => {
	invalidateSharedLiveAccess()
	let calls = 0
	let now = 1000
	const options = {
		device: { sn: 'SHARED-1', role: 'member' },
		now: () => now,
		callBackend: async () => {
			calls += 1
			return { deviceToken: 'token-1' }
		}
	}
	const first = await ensureSharedLiveAccess(options)
	now += 5000
	const second = await ensureSharedLiveAccess(options)
	assert.equal(first.deviceToken, 'token-1')
	assert.equal(second.deviceToken, 'token-1')
	assert.equal(calls, 1)
	assert.equal(first.expiresAt, 1000 + SHARED_ACCESS_TTL_MS)
})

test('expired and revoked access is fetched again or removed', async () => {
	invalidateSharedLiveAccess()
	let now = 1000
	let calls = 0
	const options = {
		device: { sn: 'SHARED-1', role: 'member' },
		now: () => now,
		callBackend: async () => ({ deviceToken: 'token-' + (++calls) })
	}
	await ensureSharedLiveAccess(options)
	now += SHARED_ACCESS_TTL_MS + 1
	assert.equal((await ensureSharedLiveAccess(options)).deviceToken, 'token-2')
	retainAccessibleSharedDevices([])
	assert.equal(readCachedSharedAccess('SHARED-1', now), null)
})

test('concurrent shared access checks share one backend request', async () => {
	invalidateSharedLiveAccess()
	let resolveRequest
	let calls = 0
	const callBackend = () => {
		calls += 1
		return new Promise((resolve) => { resolveRequest = resolve })
	}
	const options = { device: { sn: 'SHARED-2', role: 'member' }, callBackend }
	const first = ensureSharedLiveAccess(options)
	const second = ensureSharedLiveAccess(options)
	await Promise.resolve()
	resolveRequest({ deviceToken: 'same-token' })
	assert.equal((await first).deviceToken, 'same-token')
	assert.equal((await second).deviceToken, 'same-token')
	assert.equal(calls, 1)
})
