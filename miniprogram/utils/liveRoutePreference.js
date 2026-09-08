const ROUTE_HEALTH_TTL_MS = 30 * 60 * 1000
const STORAGE_PREFIX = 'liveHealthyRoute:v1:'
const memoryCache = new Map()

function cleanSn(value) {
	return String(value || '').trim()
}

function normalizeRoute(value) {
	return value === 'backend' ? 'backend' : value === 'sdk' ? 'sdk' : ''
}

function getApi(uniApi) {
	return uniApi || (typeof uni !== 'undefined' ? uni : null)
}

function readHealthyRoute(sn, uniApi, now = Date.now()) {
	const key = cleanSn(sn)
	if (!key) return ''
	let entry = memoryCache.get(key) || null
	const api = getApi(uniApi)
	if (!entry && api && typeof api.getStorageSync === 'function') {
		const raw = api.getStorageSync(STORAGE_PREFIX + key)
		try { entry = typeof raw === 'string' ? JSON.parse(raw) : raw }
		catch (error) { entry = null }
	}
	const route = normalizeRoute(entry && entry.route)
	if (!route || Number(now) - Number(entry && entry.confirmedAt) > ROUTE_HEALTH_TTL_MS) return ''
	memoryCache.set(key, { route, confirmedAt: Number(entry.confirmedAt) })
	return route
}

function markHealthyRoute(sn, route, uniApi, confirmedAt = Date.now()) {
	const key = cleanSn(sn)
	const safeRoute = normalizeRoute(route)
	if (!key || !safeRoute) return null
	const entry = { route: safeRoute, confirmedAt: Number(confirmedAt) || Date.now() }
	memoryCache.set(key, entry)
	const api = getApi(uniApi)
	if (api && typeof api.setStorageSync === 'function') {
		api.setStorageSync(STORAGE_PREFIX + key, JSON.stringify(entry))
	}
	return Object.assign({}, entry)
}

function buildRouteOrder(sn, uniApi, now = Date.now()) {
	const preferred = readHealthyRoute(sn, uniApi, now)
	return preferred ? [preferred, preferred === 'sdk' ? 'backend' : 'sdk'] : ['sdk', 'backend']
}

function clearHealthyRoute(sn, uniApi) {
	const key = cleanSn(sn)
	if (key) memoryCache.delete(key)
	else memoryCache.clear()
	const api = getApi(uniApi)
	if (key && api && typeof api.removeStorageSync === 'function') api.removeStorageSync(STORAGE_PREFIX + key)
}

module.exports = {
	ROUTE_HEALTH_TTL_MS,
	buildRouteOrder,
	clearHealthyRoute,
	markHealthyRoute,
	readHealthyRoute
}
