const STATUS_CACHE_TTL_MS = 10000
const STATUS_STALE_MS = 60000

const statusCache = new Map()
const inFlight = new Map()

function cleanSn(value) {
	return String(value || '').trim()
}

function normalizeState(value) {
	const state = String(value || '').trim().toLowerCase()
	if (state === 'online') return 'online'
	if (state === 'offline' || state === 'off_line') return 'offline'
	if (state === 'error' || state === 'abnormal') return 'error'
	return 'unknown'
}

function normalizeStatusResponse(sn, payload = {}, checkedAt = Date.now()) {
	const raw = payload && payload.status && typeof payload.status === 'object'
		? payload.status
		: payload && payload.device && payload.device.status && typeof payload.device.status === 'object'
			? payload.device.status
			: payload || {}
	const state = normalizeState(raw.status || raw.Status)
	return {
		sn: cleanSn(sn),
		state,
		status: state === 'offline' ? 'offLine' : state,
		statusDesc: state === 'online' ? '在线' : state === 'offline' ? '离线' : state === 'error' ? '状态异常' : '状态未知',
		checkedAt: Number(checkedAt) || Date.now(),
		source: 'backend'
	}
}

function unknownStatus(sn, checkedAt = Date.now()) {
	return normalizeStatusResponse(sn, {}, checkedAt)
}

function errorStatus(sn, error, checkedAt = Date.now()) {
	return {
		sn: cleanSn(sn),
		state: 'error',
		status: 'error',
		statusDesc: '状态异常',
		checkedAt: Number(checkedAt) || Date.now(),
		errorCode: String(error && (error.code || error.message) || 'DEVICE_STATUS_REQUEST_FAILED'),
		source: 'backend'
	}
}

function getFreshCachedStatus(sn, now = Date.now()) {
	const key = cleanSn(sn)
	const cached = statusCache.get(key)
	if (!cached || Number(now) - cached.cachedAt > STATUS_CACHE_TTL_MS) return null
	return Object.assign({}, cached.value)
}

async function fetchOneStatus(sn, callBackend, now = Date.now()) {
	const key = cleanSn(sn)
	if (!key) return unknownStatus('', now)
	const cached = getFreshCachedStatus(key, now)
	if (cached) return cached
	if (inFlight.has(key)) return inFlight.get(key)
	const request = Promise.resolve()
		.then(() => callBackend('/api/devices/' + encodeURIComponent(key) + '/status'))
		.then((payload) => normalizeStatusResponse(key, payload, Date.now()))
		.catch((error) => errorStatus(key, error, Date.now()))
		.then((value) => {
			statusCache.set(key, { value, cachedAt: Date.now() })
			return Object.assign({}, value)
		})
		.finally(() => inFlight.delete(key))
	inFlight.set(key, request)
	return request
}

async function fetchAccessibleDeviceStatuses(devices = [], callBackend, options = {}) {
	if (typeof callBackend !== 'function') throw new Error('DEVICE_STATUS_BACKEND_REQUIRED')
	const now = Number(options.now) || Date.now()
	const sns = [...new Set((Array.isArray(devices) ? devices : []).map((item) => cleanSn(item && item.sn)).filter(Boolean))]
	return Promise.all(sns.map((sn) => fetchOneStatus(sn, callBackend, now)))
}

function mergeAccessibleDeviceStatuses(devices = [], statuses = [], now = Date.now()) {
	const bySn = new Map((Array.isArray(statuses) ? statuses : []).map((row) => [cleanSn(row && row.sn), row]))
	return (Array.isArray(devices) ? devices : []).map((device) => {
		const row = bySn.get(cleanSn(device && device.sn))
		if (!row) return Object.assign({}, device)
		const nextState = normalizeState(row.state || row.status)
		const previousState = normalizeState(device && (device._statusState || (device.status && device.status.status)))
		const preservePrevious = ['unknown', 'error'].includes(nextState) && ['online', 'offline'].includes(previousState)
		const state = preservePrevious ? previousState : nextState
		const checkedAt = Number(row.checkedAt) || Number(now) || Date.now()
		return Object.assign({}, device, {
			status: {
				status: state === 'offline' ? 'offLine' : state,
				statusDesc: state === 'online' ? '在线' : state === 'offline' ? '离线' : state === 'error' ? '状态异常' : '状态未知',
				checkedAt: preservePrevious
					? Number(device.statusCheckedAt || (device.status && device.status.checkedAt)) || checkedAt
					: checkedAt,
				source: preservePrevious ? (device.status && device.status.source) || 'cache' : row.source || 'backend'
			},
			_online: state === 'online',
			_statusState: state,
			statusCheckedAt: preservePrevious
				? Number(device.statusCheckedAt || (device.status && device.status.checkedAt)) || checkedAt
				: checkedAt,
			statusErrorAt: nextState === 'error' ? checkedAt : Number(device.statusErrorAt) || 0,
			statusErrorCode: nextState === 'error' ? String(row.errorCode || 'DEVICE_STATUS_REQUEST_FAILED') : ''
		})
	})
}

function markDevicePlaybackOnline(device = {}, checkedAt = Date.now()) {
	return mergeAccessibleDeviceStatuses([device], [{
		sn: device.sn,
		state: 'online',
		checkedAt,
		source: 'playback'
	}], checkedAt)[0] || Object.assign({}, device)
}

function isFreshKnownStatus(device = {}, now = Date.now()) {
	return ['online', 'offline'].includes(normalizeState(device._statusState || (device.status && device.status.status)))
		&& Number(now) - Number(device.statusCheckedAt || (device.status && device.status.checkedAt) || 0) <= STATUS_STALE_MS
}

function clearDeviceStatusCache(sn) {
	if (sn) statusCache.delete(cleanSn(sn))
	else statusCache.clear()
}

module.exports = {
	STATUS_CACHE_TTL_MS,
	STATUS_STALE_MS,
	clearDeviceStatusCache,
	fetchAccessibleDeviceStatuses,
	isFreshKnownStatus,
	markDevicePlaybackOnline,
	mergeAccessibleDeviceStatuses,
	normalizeStatusResponse
}
