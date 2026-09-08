const test = require('node:test')
const assert = require('node:assert/strict')

const { CloudFeedAnalysisRecordingStore, recordingDocumentId } = require('./cloudRecordingStore')

function fakeDatabase() {
	const rows = new Map()
	return {
		rows,
		async createCollection() {},
		collection() {
			return {
				doc(id) {
					return { async set(document) { rows.set(id, { _id: id, ...document }) } }
				},
				skip(offset) {
					return { limit(size) { return { async get() { return { data: [...rows.values()].slice(offset, offset + size) } } } } }
				},
			}
		},
	}
}

test('uses a deterministic document id and idempotently upserts recording analysis', async () => {
	const database = fakeDatabase()
	const store = new CloudFeedAnalysisRecordingStore({ database })
	const input = { deviceSn: 'CAM-A', recordingKey: 'record-1', date: '2026-07-28', status: 'ready', clip: { id: 'clip-1', markers: [] } }

	await store.upsert(input)
	await store.upsert({ ...input, failureCount: 2, lastError: 'secret token must not leak\nsecond line' })

	assert.equal(database.rows.size, 1)
	assert.ok(database.rows.has(recordingDocumentId('CAM-A', 'record-1')))
	assert.equal(database.rows.get(recordingDocumentId('CAM-A', 'record-1')).data, undefined)
	const [restored] = await store.loadAll()
	assert.equal(restored.status, 'ready')
	assert.equal(restored.failureCount, 2)
	assert.equal(restored.lastError.includes('\n'), false)
})

test('restores legacy recording analysis nested under data', async () => {
	const database = fakeDatabase()
	const id = recordingDocumentId('CAM-LEGACY', 'record-legacy')
	database.rows.set(id, {
		_id: id,
		data: {
			deviceSn: 'CAM-LEGACY', recordingKey: 'record-legacy', date: '2026-07-29',
			status: 'ready', clip: { id: 'clip-legacy', markers: [{ markerType: 'cat_enter' }] },
		},
	})
	const store = new CloudFeedAnalysisRecordingStore({ database })

	const [restored] = await store.loadAll()

	assert.equal(restored.deviceSn, 'CAM-LEGACY')
	assert.equal(restored.status, 'ready')
	assert.equal(restored.clip.markers[0].markerType, 'cat_enter')
})
