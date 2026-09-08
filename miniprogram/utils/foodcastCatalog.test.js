const test = require('node:test')
const assert = require('node:assert/strict')

const {
	dedupeMaterials,
	loadFoodcastCatalogForDevices
} = require('./foodcastCatalog.js')

test('foodcast catalog merges historical meals from every accessible device', async () => {
	const devices = [
		{ sn: 'SN-TEST', nickname: '测试' },
		{ sn: 'SN-FEEDER', nickname: '猫饭摄像头' }
	]
	const result = await loadFoodcastCatalogForDevices({
		devices,
		date: '2026-09-01',
		fetchDaily: async ({ deviceSn }) => deviceSn === 'SN-FEEDER'
			? { daily: { id: 'daily-1', kind: 'daily', createdAt: 200 } }
			: { daily: null },
		fetchMaterials: async ({ deviceSn }) => deviceSn === 'SN-FEEDER'
			? { materials: [{ id: 'meal-1', kind: 'meal', mealStartMs: 100 }] }
			: { materials: [] }
	})

	assert.equal(result.daily.id, 'daily-1')
	assert.equal(result.daily.sourceDeviceSn, 'SN-FEEDER')
	assert.deepEqual(result.materials.map((item) => item.id), ['meal-1'])
	assert.equal(result.materials[0].sourceDeviceName, '猫饭摄像头')
})

test('foodcast catalog keeps other devices visible when one device request fails', async () => {
	const result = await loadFoodcastCatalogForDevices({
		devices: [{ sn: 'BROKEN' }, { sn: 'READY' }],
		date: '2026-09-01',
		fetchDaily: async ({ deviceSn }) => {
			if (deviceSn === 'BROKEN') throw new Error('DEVICE_UNAVAILABLE')
			return { daily: { id: 'daily-ready', kind: 'daily', createdAt: 300 } }
		},
		fetchMaterials: async ({ deviceSn }) => ({
			materials: deviceSn === 'READY' ? [{ id: 'meal-ready', kind: 'meal', createdAt: 250 }] : []
		})
	})

	assert.equal(result.daily.id, 'daily-ready')
	assert.deepEqual(result.materials.map((item) => item.id), ['meal-ready'])
	assert.deepEqual(result.failedDeviceSns, ['BROKEN'])
})

test('foodcast catalog chooses the newest daily highlight and de-duplicates meals', async () => {
	const result = await loadFoodcastCatalogForDevices({
		devices: [{ sn: 'A' }, { sn: 'B' }],
		date: '2026-09-01',
		fetchDaily: async ({ deviceSn }) => ({
			daily: { id: `daily-${deviceSn}`, kind: 'daily', createdAt: deviceSn === 'B' ? 500 : 100 }
		}),
		fetchMaterials: async ({ deviceSn }) => ({
			materials: [
				{ id: 'same-id', kind: 'meal', mealStartMs: deviceSn === 'A' ? 300 : 200 },
				{ id: 'same-id', kind: 'meal', mealStartMs: deviceSn === 'A' ? 300 : 200 }
			]
		})
	})

	assert.equal(result.daily.id, 'daily-B')
	assert.deepEqual(result.materials.map((item) => `${item.sourceDeviceSn}:${item.id}`), ['B:same-id', 'A:same-id'])
})

test('foodcast catalog surfaces a total request failure', async () => {
	await assert.rejects(() => loadFoodcastCatalogForDevices({
		devices: [{ sn: 'A' }],
		date: '2026-09-01',
		fetchDaily: async () => { throw new Error('NETWORK_DOWN') },
		fetchMaterials: async () => ({ materials: [] })
	}), /NETWORK_DOWN/)
})

test('foodcast material de-duplication remains stable for an empty list', () => {
	assert.deepEqual(dedupeMaterials([]), [])
})
