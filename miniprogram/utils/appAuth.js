const USER_PROFILE_KEY = 'userProfile'
const APP_SESSION_KEY = 'catBackendSession'
const BACKEND_BASE_URL_KEY = 'catBackendBaseUrl'
const {
	BACKEND_RUNTIME,
	LEGACY_BACKEND_BASE_URLS,
	getBackendBaseUrl: getConfiguredBackendBaseUrl,
	isCloudHosting
} = require('../config/backend.js')
const DEFAULT_BACKEND_BASE_URL = getConfiguredBackendBaseUrl(BACKEND_RUNTIME)

function getUni(uniApi) {
	return uniApi || (typeof uni !== 'undefined' ? uni : null)
}

function readJsonStorage(key, fallback, uniApi) {
	const api = getUni(uniApi)
	if (!api) return fallback
	const raw = api.getStorageSync(key)
	if (!raw) return fallback
	if (typeof raw !== 'string') return raw
	try {
		return JSON.parse(raw)
	} catch (err) {
		return fallback
	}
}

function writeJsonStorage(key, value, uniApi) {
	const api = getUni(uniApi)
	if (!api) return
	api.setStorageSync(key, JSON.stringify(value || {}))
}

function normalizeBaseUrl(value, fallback = DEFAULT_BACKEND_BASE_URL) {
	const base = String(value || fallback).trim() || fallback
	return base.replace(/\/+$/, '')
}

function isLoopbackBaseUrl(value) {
	return /^https?:\/\/(127(?:\.\d{1,3}){3}|localhost)(?::|\/|$)/i.test(String(value || ''))
}

function isLegacyBackendBaseUrl(value) {
	const normalized = normalizeBaseUrl(value, '')
	return LEGACY_BACKEND_BASE_URLS.some((item) => normalizeBaseUrl(item, '') === normalized)
}

function maskToken(token) {
	const value = String(token || '')
	if (!value) return ''
	if (value.length <= 8) return value
	return value.slice(0, 4) + '...' + value.slice(-4)
}

function readUserProfile(uniApi) {
	return readJsonStorage(USER_PROFILE_KEY, {}, uniApi) || {}
}

function writeUserProfile(profile, uniApi) {
	writeJsonStorage(USER_PROFILE_KEY, profile || {}, uniApi)
	return profile || {}
}

function readSession(uniApi) {
	return readJsonStorage(APP_SESSION_KEY, {}, uniApi) || {}
}

function saveAppSession(payload, uniApi) {
	const api = getUni(uniApi)
	const sessionToken = String(payload && payload.sessionToken || '')
	const user = payload && payload.user ? payload.user : {}
	const current = readUserProfile(api)
	const profile = Object.assign({}, current, {
		loggedIn: !!sessionToken,
		wechatLoggedIn: !!(user.openid || user.id),
		cloudOk: isCloudHosting(BACKEND_RUNTIME),
		authMode: 'wechat',
		openid: user.openid || user.id || current.openid || '',
		nickname: user.nickname || current.nickname || '',
		avatar: user.avatar || current.avatar || '',
		backendLoginAt: Date.now()
	})
	writeJsonStorage(USER_PROFILE_KEY, profile, api)
	writeJsonStorage(APP_SESSION_KEY, {
		sessionToken,
		userId: user.id || user.openid || '',
		openid: user.openid || user.id || '',
		loginAt: Date.now()
	}, api)
	return profile
}

function clearAppSession(uniApi) {
	const api = getUni(uniApi)
	const profile = Object.assign({}, readUserProfile(api), { loggedIn: false })
	if (api) api.removeStorageSync(APP_SESSION_KEY)
	writeJsonStorage(USER_PROFILE_KEY, profile, api)
	return profile
}

function setBackendBaseUrl(value, uniApi) {
	const api = getUni(uniApi)
	const baseUrl = normalizeBaseUrl(value)
	if (api) api.setStorageSync(BACKEND_BASE_URL_KEY, baseUrl)
	return baseUrl
}

function resolveBackendBaseUrl(storedValue, runtime = BACKEND_RUNTIME) {
	const configuredBaseUrl = getConfiguredBackendBaseUrl(runtime)
	if (isCloudHosting(runtime)) return configuredBaseUrl
	const storedBaseUrl = storedValue ? normalizeBaseUrl(storedValue, configuredBaseUrl) : ''
	if (
		storedBaseUrl &&
		!isLoopbackBaseUrl(configuredBaseUrl) &&
		(isLoopbackBaseUrl(storedBaseUrl) || isLegacyBackendBaseUrl(storedBaseUrl))
	) {
		return configuredBaseUrl
	}
	return storedBaseUrl || configuredBaseUrl
}

function getBackendBaseUrl(uniApi, runtime = BACKEND_RUNTIME) {
	const api = getUni(uniApi)
	const stored = api ? api.getStorageSync(BACKEND_BASE_URL_KEY) : ''
	const baseUrl = resolveBackendBaseUrl(stored, runtime)
	if (api && stored && stored !== baseUrl) api.setStorageSync(BACKEND_BASE_URL_KEY, baseUrl)
	return baseUrl
}

function readAppAuthState(uniApi) {
	const session = readSession(uniApi)
	const sessionToken = String(session.sessionToken || '')
	const profile = readUserProfile(uniApi)
	return {
		hasSession: !!sessionToken,
		sessionToken,
		sessionPreview: maskToken(sessionToken),
		userId: session.userId || session.openid || profile.openid || '',
		openid: session.openid || profile.openid || '',
		profile,
		backendBaseUrl: getBackendBaseUrl(uniApi)
	}
}

function ensureAppSession(options = {}, uniApi) {
	const authState = readAppAuthState(uniApi)
	if (authState.hasSession) return authState
	const api = getUni(uniApi)
	if (options.toast !== false && api && typeof api.showToast === 'function') {
		api.showToast({ title: options.message || '请先登录', icon: 'none' })
	}
	if (options.redirect !== false && api && typeof api.reLaunch === 'function') {
		api.reLaunch({ url: '/pages/login/index' })
	}
	return null
}

module.exports = {
	APP_SESSION_KEY,
	BACKEND_BASE_URL_KEY,
	DEFAULT_BACKEND_BASE_URL,
	USER_PROFILE_KEY,
	clearAppSession,
	ensureAppSession,
	getBackendBaseUrl,
	readAppAuthState,
	readUserProfile,
	resolveBackendBaseUrl,
	saveAppSession,
	setBackendBaseUrl,
	writeUserProfile
}
