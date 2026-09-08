const { readAppAuthState } = require('./appAuth.js')

// v2 invalidates dashboards written before device ownership became
// server-authoritative and before user avatars were persisted remotely.
const CACHE_VERSION = 2
const DEFAULT_TTL_MS = 30 * 60 * 1000
const DATA_PREFIX = `pageData:v${CACHE_VERSION}:`
const TAG_PREFIX = `pageDataTags:v${CACHE_VERSION}:`
const inFlight = new Map()

function getApi(uniApi) {
	return uniApi || (typeof uni !== 'undefined' ? uni : null)
}

function safePart(value) {
	return encodeURIComponent(String(value || '').trim()).slice(0, 240)
}

function getScope(uniApi) {
	const auth = readAppAuthState(uniApi)
	const account = String(auth.userId || auth.openid || '').trim()
	if (!account) return ''
	return `${safePart(account)}:${safePart(auth.backendBaseUrl || '')}`
}

function dataKey(scope, key) {
	return `${DATA_PREFIX}${scope}:${safePart(key)}`
}

function tagKey(scope) {
	return `${TAG_PREFIX}${scope}`
}

function readStored(api, key, fallback) {
	if (!api || typeof api.getStorageSync !== 'function') return fallback
	const raw = api.getStorageSync(key)
	if (!raw) return fallback
	if (typeof raw !== 'string') return raw
	try { return JSON.parse(raw) } catch (error) { return fallback }
}

function writeStored(api, key, value) {
	if (!api || typeof api.setStorageSync !== 'function') return
	api.setStorageSync(key, JSON.stringify(value))
}

function normalizeTags(tags) {
	return Array.from(new Set((Array.isArray(tags) ? tags : [tags]).map((tag) => String(tag || '').trim()).filter(Boolean)))
}

function readTagVersions(api, scope) {
	const value = readStored(api, tagKey(scope), {})
	return value && typeof value === 'object' ? value : {}
}

function snapshotTagVersions(api, scope, tags) {
	const versions = readTagVersions(api, scope)
	return normalizeTags(tags).reduce((result, tag) => {
		result[tag] = Number(versions[tag]) || 0
		return result
	}, {})
}

function readPageData(key, options = {}) {
	const api = getApi(options.uniApi)
	const scope = getScope(api)
	if (!api || !scope || !key) return null
	const envelope = readStored(api, dataKey(scope, key), null)
	if (!envelope || envelope.version !== CACHE_VERSION || !Number.isFinite(Number(envelope.savedAt))) return null
	const nowMs = Number(options.nowMs) || Date.now()
	const ttlMs = Number(options.ttlMs) >= 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS
	if (nowMs - Number(envelope.savedAt) > ttlMs) return null
	const currentTags = readTagVersions(api, scope)
	const savedTags = envelope.tagVersions || {}
	for (const tag of normalizeTags(options.tags)) {
		if ((Number(currentTags[tag]) || 0) !== (Number(savedTags[tag]) || 0)) return null
	}
	return envelope.data
}

function writePageData(key, data, options = {}) {
	const api = getApi(options.uniApi)
	const scope = getScope(api)
	if (!api || !scope || !key) return data
	writeStored(api, dataKey(scope, key), {
		version: CACHE_VERSION,
		savedAt: Number(options.nowMs) || Date.now(),
		tagVersions: snapshotTagVersions(api, scope, options.tags),
		data,
	})
	return data
}

function invalidatePageDataTags(tags, uniApi) {
	const api = getApi(uniApi)
	const scope = getScope(api)
	const normalized = normalizeTags(tags)
	if (!api || !scope || normalized.length === 0) return
	const versions = readTagVersions(api, scope)
	for (const tag of normalized) versions[tag] = (Number(versions[tag]) || 0) + 1
	writeStored(api, tagKey(scope), versions)
}

async function fetchPageData(key, options = {}) {
	const api = getApi(options.uniApi)
	const scope = getScope(api)
	if (!options.force) {
		const cached = readPageData(key, options)
		if (cached !== null) return { data: cached, source: 'cache' }
	}
	if (typeof options.fetcher !== 'function') throw new Error('PAGE_DATA_FETCHER_REQUIRED')
	const flightKey = `${scope}:${key}`
	if (inFlight.has(flightKey)) return inFlight.get(flightKey)
	const request = Promise.resolve()
		.then(options.fetcher)
		.then((data) => ({ data: writePageData(key, data, options), source: 'network' }))
		.finally(() => inFlight.delete(flightKey))
	inFlight.set(flightKey, request)
	return request
}

function mutationTags(path, method) {
	const route = String(path || '').split('?')[0]
	const verb = String(method || 'GET').toUpperCase()
	if (verb === 'GET') return []
	if (/^\/api\/cats(?:\/|$)/.test(route)) return ['cats', 'today', 'profile']
	if (/^\/api\/profile(?:\/|$)/.test(route)) return ['profile']
	if (/^\/api\/foodcasts(?:\/|$)/.test(route)) return ['foodcasts', 'clips', 'profile', 'today']
	if (/^\/api\/feed-analysis\/(?:settings|config|sync)(?:\/|$)/.test(route)) return ['today', 'profile']
	if (
		/^\/api\/devices(?:$|\/[^/]+\/(?:nickname|primary-cat)$)/.test(route) ||
		/^\/api\/devices\/[^/]+$/.test(route) ||
		/^\/api\/share(?:\/|$)/.test(route)
	) return ['devices', 'cats', 'today', 'profile', 'live', 'clips']
	return []
}

function invalidatePageDataForMutation(path, method, uniApi) {
	invalidatePageDataTags(mutationTags(path, method), uniApi)
}

module.exports = {
	DEFAULT_TTL_MS,
	fetchPageData,
	invalidatePageDataForMutation,
	invalidatePageDataTags,
	mutationTags,
	readPageData,
	writePageData,
}
