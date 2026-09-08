const crypto = require('node:crypto')

function recordingDocumentId(deviceSn, recordingKey) {
	return crypto.createHash('sha256').update(`${String(deviceSn)}\0${String(recordingKey)}`).digest('hex')
}

function cleanError(value) {
	return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, 1000)
}

function normalize(record = {}) {
	const source = !record.deviceSn && record.data && typeof record.data === 'object' && !Array.isArray(record.data)
		? record.data
		: record
	const value = JSON.parse(JSON.stringify(source || {}))
	delete value._id
	value.deviceSn = String(value.deviceSn || '').trim()
	value.recordingKey = String(value.recordingKey || '').trim()
	value.date = String(value.date || '').slice(0, 10)
	value.status = ['queued', 'running', 'ready', 'failed'].includes(value.status) ? value.status : 'queued'
	value.failureCount = Math.max(0, Number(value.failureCount) || 0)
	value.lastError = cleanError(value.lastError)
	value.materialSyncStatus = String(value.materialSyncStatus || 'pending')
	value.materialSyncAttempts = Math.max(0, Number(value.materialSyncAttempts) || 0)
	value.materialSyncError = cleanError(value.materialSyncError)
	value.updatedAt = Number(value.updatedAt) || Date.now()
	if (!value.deviceSn || !value.recordingKey) throw new Error('RECORDING_ID_REQUIRED')
	return value
}

class CloudFeedAnalysisRecordingStore {
	constructor({ database, collectionName = 'feed_analysis_recordings' } = {}) {
		if (!database) throw new Error('CLOUDBASE_DATABASE_REQUIRED')
		this.database = database
		this.collectionName = collectionName
		this.collection = database.collection(collectionName)
	}

	async initialize() {
		try { await this.database.createCollection(this.collectionName) }
		catch (error) { if (error?.code !== 'DATABASE_COLLECTION_ALREADY_EXIST') throw error }
	}

	async upsert(record) {
		const data = normalize(record)
		await this.collection.doc(recordingDocumentId(data.deviceSn, data.recordingKey)).set(data)
		return data
	}

	async loadAll() {
		const records = []
		for (let offset = 0; ; offset += 100) {
			const result = await this.collection.skip(offset).limit(100).get()
			const batch = Array.isArray(result?.data) ? result.data : []
			for (const item of batch) records.push(normalize(item))
			if (batch.length < 100) return records
		}
	}
}

module.exports = { CloudFeedAnalysisRecordingStore, recordingDocumentId }
