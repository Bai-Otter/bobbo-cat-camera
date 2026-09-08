const SHARED_ACCESS_TTL_MS = 15 * 60 * 1000

const accessCache = new Map()
const inFlight = new Map()

function cleanSn(value) {
	return String(value || '').trim()
}

function readCachedSharedAccess(sn, now = Date.now()) {
	const key = cleanSn(sn)
	const entry = accessCache.get(key)
	if (!entry || Number(now) >= entry.expiresAt) {
		if (entry) accessCache.delete(key)
		return null
	}
	return Object.assign({}, entry)
}

async function ensureSharedLiveAccess(options = {}) {
	const device = options.device || {}
	const sn = cleanSn(device.sn)
	if (!sn) throw Object.assign(new Error('DEVICE_SN_REQUIRED'), { code: 'DEVICE_SN_REQUIRED' })
	const directToken = String(device.token || device.deviceToken || '').trim()
	if (device.role !== 'member' && directToken) {
		return { deviceToken: directToken, expiresAt: Number.MAX_SAFE_INTEGER, source: 'device' }
	}
	const now = typeof options.now === 'function' ? Number(options.now()) : Date.now()
	const cached = readCachedSharedAccess(sn, now)
	if (cached) return cached
	if (inFlight.has(sn)) return inFlight.get(sn)
	if (typeof options.callBackend !== 'function') throw new Error('SHARED_ACCESS_BACKEND_REQUIRED')
	const request = Promise.resolve()
		.then(() => options.callBackend('/api/devices/' + encodeURIComponent(sn) + '/direct-live-access', { method: 'POST' }))
		.then((payload) => {
			const deviceToken = String(payload && payload.deviceToken || '').trim()
			if (!deviceToken) throw Object.assign(new Error('SHARED_DEVICE_TOKEN_UNAVAILABLE'), { code: 'SHARED_DEVICE_TOKEN_UNAVAILABLE' })
			const grantedAt = typeof options.now === 'function' ? Number(options.now()) : Date.now()
			const serverExpiry = Number(payload && payload.accessExpiresAt)
			const expiresAt = Math.min(
				grantedAt + SHARED_ACCESS_TTL_MS,
				serverExpiry > grantedAt ? serverExpiry : Number.MAX_SAFE_INTEGER
			)
			const entry = { deviceToken, expiresAt, source: 'backend' }
			accessCache.set(sn, entry)
			return Object.assign({}, entry)
		})
		.finally(() => inFlight.delete(sn))
	inFlight.set(sn, request)
	return request
}

function invalidateSharedLiveAccess(sn) {
	if (sn) accessCache.delete(cleanSn(sn))
	else accessCache.clear()
}

function retainAccessibleSharedDevices(devices = []) {
	const accessible = new Set((Array.isArray(devices) ? devices : []).filter((item) => item && item.role === 'member').map((item) => cleanSn(item.sn)))
	for (const sn of accessCache.keys()) if (!accessible.has(sn)) accessCache.delete(sn)
}

module.exports = {
	SHARED_ACCESS_TTL_MS,
	ensureSharedLiveAccess,
	invalidateSharedLiveAccess,
	readCachedSharedAccess,
	retainAccessibleSharedDevices
}
