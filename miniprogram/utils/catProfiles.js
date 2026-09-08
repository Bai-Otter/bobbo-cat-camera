const CAT_PROFILES_KEY = 'bobbo_cat_profiles'
const CAT_PROFILES_IMPORTED_KEY = 'bobbo_cat_profiles_imported_v2'
const DEFAULT_CAT_AVATAR = '/static/images/cool-cat-avatar.svg'
const DEMO_CAT_PROFILES = [
	{ id: 'demo-guagua', name: '瓜瓜', age: '3 岁', breed: '英短', sex: '母', health: '', status: '识别稳定', statusTone: 'stable', avatar: DEFAULT_CAT_AVATAR, demo: true },
	{ id: 'demo-xiaobu', name: '小布', age: '1 岁', breed: '橘猫', sex: '公', health: '', status: '待补充猫脸', statusTone: 'pending', avatar: DEFAULT_CAT_AVATAR, demo: true }
]

function cloneProfiles(profiles) {
	return profiles.map((profile) => Object.assign({}, profile))
}

function catProfileKey(profile = {}) {
	const id = String(profile.id || '').trim()
	if (!id) return ''
	const shared = profile.source === 'shared' || profile.readOnly === true
	const catRef = String(profile.catRef || '').trim()
	return shared ? `shared:${catRef || id}` : `owned:${id}`
}

function createCatEditorTarget(profile) {
	if (!profile || typeof profile !== 'object') return null
	const snapshot = Object.assign({}, profile)
	const id = String(snapshot.id || '').trim()
	const key = catProfileKey(snapshot)
	if (!id || !key) return null
	return {
		id,
		key,
		readOnly: snapshot.source === 'shared' || snapshot.readOnly === true,
		profile: snapshot
	}
}

function findCatProfileByKey(profiles, profileKey) {
	const key = String(profileKey || '').trim()
	if (!key || !Array.isArray(profiles)) return null
	return profiles.find((profile) => catProfileKey(profile) === key) || null
}

function hasStoredValue(value) {
	return value !== '' && value !== null && typeof value !== 'undefined'
}

function readCatProfiles(storage) {
	let stored
	try {
		stored = storage.getStorageSync(CAT_PROFILES_KEY)
		if (hasStoredValue(stored)) {
			const profiles = typeof stored === 'string' ? JSON.parse(stored) : stored
			if (Array.isArray(profiles)) return cloneProfiles(profiles)
		}
	} catch (error) {
		stored = undefined
	}

	const profiles = cloneProfiles(DEMO_CAT_PROFILES)
	if (storage && typeof storage.setStorageSync === 'function') {
		storage.setStorageSync(CAT_PROFILES_KEY, profiles)
	}
	return profiles
}

function resolveActiveCat(profiles, storedCatId) {
	const list = Array.isArray(profiles) ? profiles : []
	return list.find((profile) => (profile.catRef || profile.id) === storedCatId)
		|| list.find((profile) => profile.id === storedCatId)
		|| list[0] || null
}

function writeCatProfiles(profiles, storage) {
	const next = cloneProfiles(Array.isArray(profiles) ? profiles : [])
	if (storage && typeof storage.setStorageSync === 'function') storage.setStorageSync(CAT_PROFILES_KEY, next)
	return next
}

function importMarkerKey(accountId) {
	const account = encodeURIComponent(String(accountId || '').trim().slice(0, 128))
	return `${CAT_PROFILES_IMPORTED_KEY}:${account || 'default'}`
}

async function refreshCatProfiles(options = {}) {
	const storage = options.storage
	const callBackend = options.callBackend
	if (typeof callBackend !== 'function') throw new Error('CAT_PROFILES_BACKEND_REQUIRED')
	const cached = readCatProfiles(storage)
	try {
		let payload = await callBackend('/api/cats')
		let cats = Array.isArray(payload.cats) ? payload.cats : []
		const markerKey = importMarkerKey(options.accountId)
		const imported = storage && storage.getStorageSync(markerKey)
		const localCandidates = cached.filter((cat) => !cat.demo && !cat.readOnly && cat.name)
		const serverOwnIds = new Set(cats
			.filter((cat) => cat.source !== 'shared' && !cat.readOnly)
			.map((cat) => cat.id))
		const importCandidates = localCandidates.filter((cat) => !serverOwnIds.has(cat.id))
		if (!imported && importCandidates.length) {
			const prepared = typeof options.prepareImport === 'function'
				? await options.prepareImport(importCandidates)
				: importCandidates
			payload = await callBackend('/api/cats/import', { method: 'POST', data: { cats: prepared } })
			cats = Array.isArray(payload.cats) ? payload.cats : []
		}
		if (storage && typeof storage.setStorageSync === 'function') storage.setStorageSync(markerKey, '1')
		return { cats: writeCatProfiles(cats, storage), refreshed: true, error: null }
	} catch (error) {
		return { cats: cached, refreshed: false, error }
	}
}

module.exports = {
	CAT_PROFILES_KEY,
	CAT_PROFILES_IMPORTED_KEY,
	DEFAULT_CAT_AVATAR,
	DEMO_CAT_PROFILES,
	catProfileKey,
	createCatEditorTarget,
	findCatProfileByKey,
	readCatProfiles,
	refreshCatProfiles,
	resolveActiveCat,
	writeCatProfiles
}
