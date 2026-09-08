const test = require('node:test')
const assert = require('node:assert/strict')

const {
	clearDeviceStatusCache,
	fetchAccessibleDeviceStatuses,
	isFreshKnownStatus,
	markDevicePlaybackOnline,
	mergeAccessibleDeviceStatuses,
	normalizeStatusResponse
} = require('./accessibleDeviceStatus.js')

test('backend device status keeps unknown distinct from offline and preserves a known result', () => {
	assert.equal(normalizeStatusResponse('SN1', { status: { status: 'online' } }, 100).state, 'online')
	assert.equal(normalizeStatusResponse('SN2', { status: { status: 'offLine' } }, 100).state, 'offline')
	assert.equal(normalizeStatusResponse('SN3', {}, 100).state, 'unknown')

	const [known] = mergeAccessibleDeviceStatuses([{ sn: 'SN3', _online: true, _statusState: 'online', statusCheckedAt: 50 }], [{ sn: 'SN3', state: 'unknown', checkedAt: 100 }], 100)
	assert.equal(known._online, true)
	assert.equal(known._statusState, 'online')
	assert.equal(known.statusCheckedAt, 50)
})

test('status request errors become abnormal only when there is no known result', async () => {
	clearDeviceStatusCache()
	const [failed] = await fetchAccessibleDeviceStatuses([{ sn: 'SN-ERROR' }], async () => {
		throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' })
	})
	assert.equal(failed.state, 'error')
	const [fresh] = mergeAccessibleDeviceStatuses([{ sn: 'SN-ERROR', _statusState: 'unknown' }], [failed])
	assert.equal(fresh._statusState, 'error')
	const [preserved] = mergeAccessibleDeviceStatuses([{ sn: 'SN-ERROR', _statusState: 'offline', statusCheckedAt: 20 }], [failed])
	assert.equal(preserved._statusState, 'offline')
	assert.equal(preserved.statusErrorCode, 'TIMEOUT')
})

test('accessible status requests are shared by owned and member devices and deduplicated', async () => {
	clearDeviceStatusCache()
	const calls = []
	const callBackend = async (path) => {
		calls.push(path)
		return { status: { status: path.includes('SHARED') ? 'online' : 'offLine' } }
	}
	const devices = [{ sn: 'OWNER', role: 'owner' }, { sn: 'SHARED', role: 'member' }]
	const [first, second] = await Promise.all([
		fetchAccessibleDeviceStatuses(devices, callBackend, { now: 1000 }),
		fetchAccessibleDeviceStatuses(devices, callBackend, { now: 1000 })
	])
	assert.equal(first.length, 2)
	assert.equal(second.length, 2)
	assert.equal(calls.length, 2)
	assert.equal(first.find((item) => item.sn === 'SHARED').state, 'online')
})

test('real media progress confirms an online state', () => {
	const online = markDevicePlaybackOnline({ sn: 'SN1', _statusState: 'unknown' }, 5000)
	assert.equal(online._online, true)
	assert.equal(online._statusState, 'online')
	assert.equal(online.status.source, 'playback')
	assert.equal(isFreshKnownStatus(online, 5500), true)
})
